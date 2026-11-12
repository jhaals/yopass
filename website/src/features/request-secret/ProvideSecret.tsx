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
import { safeFilename } from '@shared/lib/safeFilename';
import { CheckCircleIcon, WarningIcon } from '@shared/components/icons';

type PageState =
  | 'loading'
  | 'ready'
  | 'submitted'
  | 'alreadyFulfilled'
  | 'notFound'
  | 'integrityError';

// Full class names so Tailwind finds them; every colour is a theme token.
const TONES = {
  success: { chip: 'bg-success/10 text-success', ring: 'bg-success/30' },
  warning: { chip: 'bg-warning/10 text-warning', ring: 'bg-warning/30' },
  error: { chip: 'bg-error/10 text-error', ring: 'bg-error/30' },
};

export default function ProvideSecret() {
  const { key, fp } = useParams();
  return <ProvideSecretForm key={`${key}/${fp}`} />;
}

function ProvideSecretForm() {
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
      // The fingerprint in the link fragment never reaches the server, so a
      // mismatch means the public key was replaced behind the requester's back.
      // A missing fingerprint (truncated or hand-edited link) leaves nothing to
      // verify against, so refuse before asking the server for anything —
      // otherwise a broken link reports the request's state instead of the
      // reason it will never be usable.
      if (!fp) {
        setPageState('integrityError');
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
        request.key_version ?? '',
      );
      if (status === 200) {
        setSecret('');
        setFile(null);
        setPageState('submitted');
      } else if (status === 412) {
        setPageState('integrityError');
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

  if (pageState !== 'ready') {
    const messages: Record<
      Exclude<PageState, 'loading' | 'ready'>,
      {
        title: string;
        subtitle: string;
        tone: keyof typeof TONES;
        Icon: typeof WarningIcon;
      }
    > = {
      submitted: {
        title: t('request.provideSuccessTitle'),
        subtitle: t('request.provideSuccessSubtitle'),
        tone: 'success',
        Icon: CheckCircleIcon,
      },
      alreadyFulfilled: {
        title: t('request.provideFulfilledTitle'),
        subtitle: t('request.provideFulfilledSubtitle'),
        tone: 'warning',
        Icon: WarningIcon,
      },
      notFound: {
        title: t('request.provideNotFoundTitle'),
        subtitle: t('request.provideNotFoundSubtitle'),
        tone: 'warning',
        Icon: WarningIcon,
      },
      integrityError: {
        title: t('request.provideIntegrityTitle'),
        subtitle: t('request.provideIntegritySubtitle'),
        tone: 'error',
        Icon: WarningIcon,
      },
    };
    const msg = messages[pageState];
    const tone = TONES[msg.tone];
    return (
      <div className="text-center py-8">
        <span className="relative mx-auto mb-5 grid h-16 w-16 place-items-center">
          <span
            className={`absolute inset-0 rounded-full opacity-0 animate-status-ring ${tone.ring}`}
            aria-hidden="true"
          />
          <span
            className={`relative grid h-16 w-16 place-items-center rounded-full animate-result-icon ${tone.chip}`}
          >
            <msg.Icon className="h-8 w-8" />
          </span>
        </span>
        <h2
          className="text-2xl font-medium tracking-tight mb-2 animate-result-enter"
          style={{ animationDelay: '150ms' }}
        >
          {msg.title}
        </h2>
        <p
          className="text-base-content/70 max-w-md mx-auto animate-result-enter"
          style={{ animationDelay: '270ms' }}
        >
          {msg.subtitle}
        </p>
      </div>
    );
  }

  return (
    <>
      <h2 className="text-3xl font-medium tracking-tight mb-2">
        {t('request.provideTitle')}
      </h2>
      <p className="text-base text-base-content/70 mb-2">
        {t('request.provideSubtitle')}
      </p>
      {request?.label && (
        <div className="mb-4">
          <span dir="ltr" className="badge badge-outline badge-lg font-medium">
            {request.label}
          </span>
        </div>
      )}
      {request?.note && (
        <div className="mb-4 p-4 bg-base-200/50 border border-base-300 rounded-lg">
          <div className="text-sm font-semibold mb-1">
            {t('request.provideNoteTitle')}
          </div>
          <p dir="ltr" className="text-sm whitespace-pre-wrap break-words">
            {request.note}
          </p>
        </div>
      )}
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
              dir="ltr"
              className="content-input textarea textarea-bordered w-full min-h-[140px] text-base p-4 resize-y focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 bg-base-100"
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
                  {file ? (
                    <bdi dir="ltr">{safeFilename(file.name)}</bdi>
                  ) : (
                    t('upload.dragDropText')
                  )}
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
            className="btn btn-primary w-full h-12 text-base font-semibold transition-all duration-200"
            type="submit"
            disabled={submitting || (mode === 'text' ? !secret : !file)}
          >
            {submitting && <span className="loading loading-spinner" />}
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-6 w-6 me-2"
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
