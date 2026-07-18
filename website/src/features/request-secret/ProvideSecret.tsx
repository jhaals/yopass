import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  fulfillSecretRequest,
  getSecretRequest,
  type RequestSecretKind,
  type SecretRequestInfo,
} from '@shared/lib/api';
import {
  encryptFileWithPublicKey,
  encryptWithPublicKey,
  publicKeyFingerprint,
} from '@shared/lib/crypto';
import { parseSize } from '@shared/lib/parseSize';
import { useConfig } from '@shared/hooks/useConfig';
import { shortFingerprint } from './requestLink';

type PageState =
  | 'loading'
  | 'ready'
  | 'submitted'
  | 'alreadyFulfilled'
  | 'notFound'
  | 'integrityError';

export default function ProvideSecret() {
  const { t } = useTranslation();
  const config = useConfig();
  const { key, fp } = useParams<{ key: string; fp?: string }>();
  const [pageState, setPageState] = useState<PageState>('loading');
  const [request, setRequest] = useState<SecretRequestInfo | null>(null);
  const [mode, setMode] = useState<RequestSecretKind>('text');
  const [secret, setSecret] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!key) {
        setPageState('notFound');
        return;
      }
      const { data } = await getSecretRequest(key);
      if (cancelled) return;
      if (!data) {
        setPageState('notFound');
        return;
      }
      if (data.state === 'fulfilled') {
        setPageState('alreadyFulfilled');
        return;
      }
      // The fingerprint in the link fragment never reaches the server, so a
      // mismatch means the public key was replaced behind the requester's back.
      if (fp) {
        try {
          const fingerprint = await publicKeyFingerprint(data.public_key);
          if (shortFingerprint(fingerprint) !== fp.toLowerCase()) {
            setPageState('integrityError');
            return;
          }
        } catch {
          setPageState('integrityError');
          return;
        }
      }
      setRequest(data);
      setPageState('ready');
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [key, fp]);

  // File responses have their own server-side limit; fall back to the regular
  // upload limit when talking to a server that predates it.
  const maxFileSize = config?.MAX_REQUEST_FILE_SIZE ?? config?.MAX_FILE_SIZE;

  function selectFile(f: File) {
    const maxBytes = parseSize(maxFileSize ?? '');
    if (maxBytes > 0 && f.size > maxBytes) {
      setError(t('upload.fileTooLarge', { maxSize: maxFileSize ?? '' }));
      setFile(null);
      return;
    }
    setError('');
    setFile(f);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!key || !request) return;
    if (mode === 'text' ? !secret : !file) return;
    setError('');
    setSubmitting(true);
    try {
      const encrypted =
        mode === 'file'
          ? await encryptFileWithPublicKey(file!, request.public_key)
          : await encryptWithPublicKey(secret, request.public_key);
      const { status, message } = await fulfillSecretRequest(
        key,
        encrypted,
        mode,
      );
      if (status === 200) {
        setSecret('');
        setFile(null);
        setPageState('submitted');
      } else if (status === 409) {
        setPageState('alreadyFulfilled');
      } else if (status === 404) {
        setPageState('notFound');
      } else {
        setError(message || t('request.errorSubmitFailed'));
      }
    } catch {
      setError(t('request.errorSubmitFailed'));
    } finally {
      setSubmitting(false);
    }
  }

  if (pageState === 'loading') {
    return (
      <div className="flex justify-center py-12">
        <span className="loading loading-spinner loading-lg text-primary" />
      </div>
    );
  }

  if (pageState === 'submitted') {
    return (
      <div className="text-center py-8">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={1.5}
          stroke="currentColor"
          className="h-14 w-14 mx-auto text-success mb-4"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"
          />
        </svg>
        <h2 className="text-2xl font-bold mb-2">
          {t('request.provideSuccessTitle')}
        </h2>
        <p className="text-base-content/70">
          {t('request.provideSuccessSubtitle')}
        </p>
      </div>
    );
  }

  if (pageState !== 'ready') {
    const messages: Record<string, { title: string; subtitle: string }> = {
      alreadyFulfilled: {
        title: t('request.provideFulfilledTitle'),
        subtitle: t('request.provideFulfilledSubtitle'),
      },
      notFound: {
        title: t('request.provideNotFoundTitle'),
        subtitle: t('request.provideNotFoundSubtitle'),
      },
      integrityError: {
        title: t('request.provideIntegrityTitle'),
        subtitle: t('request.provideIntegritySubtitle'),
      },
    };
    const msg = messages[pageState];
    return (
      <div className="text-center py-8">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={1.5}
          stroke="currentColor"
          className={`h-14 w-14 mx-auto mb-4 ${pageState === 'integrityError' ? 'text-error' : 'text-warning'}`}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"
          />
        </svg>
        <h2 className="text-2xl font-bold mb-2">{msg.title}</h2>
        <p className="text-base-content/70">{msg.subtitle}</p>
      </div>
    );
  }

  return (
    <>
      <h2 className="text-3xl font-bold mb-2">{t('request.provideTitle')}</h2>
      <p className="text-base text-base-content/70 mb-2">
        {t('request.provideSubtitle')}
      </p>
      {request?.label && (
        <div className="mb-4">
          <span className="badge badge-outline badge-lg font-medium">
            {request.label}
          </span>
        </div>
      )}
      <div className="alert alert-info shadow-sm mb-6">
        <svg
          className="w-6 h-6 stroke-current shrink-0"
          fill="none"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
            d="M13 16h-1v-4h-1m1-4h.01M12 20a8 8 0 100-16 8 8 0 000 16z"
          />
        </svg>
        <span className="text-sm">{t('request.provideEncryptionNotice')}</span>
      </div>
      <form onSubmit={onSubmit}>
        {error && (
          <div className="mb-4 text-red-600 text-sm font-medium">{error}</div>
        )}
        {!config?.DISABLE_UPLOAD && (
          <div role="tablist" className="tabs tabs-box mb-4 w-fit">
            <button
              type="button"
              role="tab"
              className={`tab ${mode === 'text' ? 'tab-active' : ''}`}
              onClick={() => {
                setMode('text');
                setError('');
              }}
            >
              {t('request.provideTabText')}
            </button>
            <button
              type="button"
              role="tab"
              className={`tab ${mode === 'file' ? 'tab-active' : ''}`}
              onClick={() => {
                setMode('file');
                setError('');
              }}
            >
              {t('request.provideTabFile')}
            </button>
          </div>
        )}
        {mode === 'text' ? (
          <div className="form-control">
            <label className="label" htmlFor="provide-secret">
              <span className="label-text">
                {t('request.provideInputLabel')}
              </span>
            </label>
            <textarea
              id="provide-secret"
              className="textarea textarea-bordered w-full min-h-[140px] text-base p-4 resize-y rounded-lg focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 bg-base-100"
              value={secret}
              onChange={e => setSecret(e.target.value)}
              placeholder={t('request.provideInputPlaceholder')}
              rows={4}
            />
          </div>
        ) : (
          <div
            className={`border-2 border-dashed rounded-xl p-8 text-center transition-colors ${
              dragActive
                ? 'border-primary bg-base-200'
                : 'border-base-300 bg-base-100'
            }`}
            onDragOver={e => {
              e.preventDefault();
              setDragActive(true);
            }}
            onDragLeave={e => {
              e.preventDefault();
              setDragActive(false);
            }}
            onDrop={e => {
              e.preventDefault();
              setDragActive(false);
              const f = e.dataTransfer.files?.[0];
              if (f) selectFile(f);
            }}
          >
            <input
              type="file"
              className="hidden"
              id="provide-file-input"
              onChange={e => {
                const f = e.target.files?.[0];
                if (f) selectFile(f);
              }}
            />
            <label
              htmlFor="provide-file-input"
              className="cursor-pointer block"
            >
              <div className="flex flex-col items-center">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={1.5}
                  stroke="currentColor"
                  className="w-14 h-14 text-base-content/60"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M9 8.25H7.5a2.25 2.25 0 0 0-2.25 2.25v9a2.25 2.25 0 0 0 2.25 2.25h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25H15m0-3-3-3m0 0-3 3m3-3V15"
                  />
                </svg>
                <div className="mt-2 font-semibold">
                  {file ? file.name : t('upload.dragDropText')}
                </div>
                {maxFileSize && (
                  <div className="text-sm text-base-content/60">
                    {t('upload.maxFileSize', { size: maxFileSize })}
                  </div>
                )}
              </div>
            </label>
          </div>
        )}
        <div className="form-control mt-8">
          <button
            className="btn btn-primary w-full h-12 text-base font-semibold rounded-lg transition-all duration-200"
            type="submit"
            disabled={submitting || (mode === 'text' ? !secret : !file)}
          >
            {submitting && <span className="loading loading-spinner" />}
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-6 w-6 mr-2"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
              />
            </svg>
            {t('request.provideButton')}
          </button>
        </div>
      </form>
    </>
  );
}
