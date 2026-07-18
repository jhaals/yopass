import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { QRCodeSVG } from 'qrcode.react';
import { useConfig } from '@shared/hooks/useConfig';
import { useCopy } from '@shared/hooks/useCopy';
import { generateRequestKeyPair } from '@shared/lib/crypto';
import { createSecretRequest } from '@shared/lib/api';
import { saveStoredRequest } from '@shared/lib/requestStore';
import { requestLink, shortFingerprint } from './requestLink';

interface CreatedRequest {
  id: string;
  fingerprint: string;
  expiresAt: number;
}

export default function CreateRequest() {
  const { t } = useTranslation();
  const config = useConfig();
  const [label, setLabel] = useState('');
  const [expiration, setExpiration] = useState(
    String(config?.DEFAULT_EXPIRY ?? 3600),
  );
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<CreatedRequest | null>(null);
  const { copy, isCopied } = useCopy();
  const [showQr, setShowQr] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const keyPair = await generateRequestKeyPair();
      const { data, message } = await createSecretRequest(
        {
          public_key: keyPair.publicKey,
          label: label.trim() || undefined,
          expiration: parseInt(expiration),
        },
        config.OIDC_ENABLED,
      );
      if (!data) {
        setError(message || t('request.errorCreateFailed'));
        return;
      }
      saveStoredRequest({
        id: data.id,
        label: label.trim() || undefined,
        privateKey: keyPair.privateKey,
        publicKey: keyPair.publicKey,
        fingerprint: keyPair.fingerprint,
        token: data.token,
        createdAt: Math.floor(Date.now() / 1000),
        expiresAt: data.expires_at,
      });
      setCreated({
        id: data.id,
        fingerprint: keyPair.fingerprint,
        expiresAt: data.expires_at,
      });
    } catch {
      setError(t('request.errorCreateFailed'));
    } finally {
      setSubmitting(false);
    }
  }

  if (created) {
    const link = requestLink(
      config.PUBLIC_URL,
      created.id,
      shortFingerprint(created.fingerprint),
    );
    return (
      <>
        <div className="flex items-center gap-3 mb-2">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={1.5}
            stroke="currentColor"
            className="h-7 w-7 text-success"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"
            />
          </svg>
          <h2 className="text-2xl font-bold">{t('request.resultTitle')}</h2>
        </div>
        <p className="mb-6 text-base">{t('request.resultSubtitle')}</p>
        <div className="mb-4 p-5 bg-base-200/50 border border-base-300 rounded-lg">
          <div className="font-semibold text-base mb-1 text-base-content">
            {t('request.resultLinkLabel')}
          </div>
          <div className="text-sm text-base-content/70 mb-4">
            {t('request.resultLinkDescription')}
          </div>
          <div className="flex items-start gap-3">
            <button
              className={`btn btn-sm font-medium transition-all duration-200 shrink-0 mt-1 ${isCopied() ? 'btn-success' : 'btn-primary'}`}
              onClick={() => copy(link)}
            >
              {isCopied() ? t('common.copied') : t('common.copy')}
            </button>
            <div className="flex-1 bg-base-100 border border-base-300 rounded-md px-4 py-3 min-h-[2.5rem] min-w-0">
              <code className="text-sm text-base-content/80 font-mono break-words leading-relaxed">
                {link}
              </code>
            </div>
          </div>
          <button
            className="btn btn-ghost btn-sm mt-3"
            onClick={() => setShowQr(!showQr)}
          >
            {showQr ? t('secret.hideQrCode') : t('secret.showQrCode')}
          </button>
          {showQr && (
            <div className="flex justify-center mt-3 p-4 bg-white rounded-lg w-fit mx-auto">
              <QRCodeSVG value={link} size={180} />
            </div>
          )}
        </div>
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
          <span className="text-sm">{t('request.resultKeyNotice')}</span>
        </div>
        <div className="flex justify-center gap-3">
          <a href="#/requests" className="btn btn-primary px-8 font-medium">
            {t('request.buttonGoToList')}
          </a>
          <button
            className="btn btn-ghost px-8 font-medium"
            onClick={() => {
              setCreated(null);
              setLabel('');
            }}
          >
            {t('request.buttonCreateAnother')}
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <h2 className="text-3xl font-bold mb-2">{t('request.createTitle')}</h2>
      <p className="text-base text-base-content/70 mb-6">
        {t('request.createSubtitle')}
      </p>
      <form onSubmit={onSubmit}>
        {error && (
          <div className="mb-4 text-red-600 text-sm font-medium">{error}</div>
        )}
        <div className="form-control">
          <label className="label" htmlFor="request-label">
            <span className="label-text">{t('request.inputLabelLabel')}</span>
          </label>
          <input
            id="request-label"
            type="text"
            maxLength={100}
            className="input input-bordered w-full text-base rounded-lg focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 bg-base-100"
            value={label}
            onChange={e => setLabel(e.target.value)}
            placeholder={t('request.inputLabelPlaceholder')}
          />
          <p className="text-xs text-base-content/60 mt-2">
            {t('request.inputLabelHint')}
          </p>
        </div>
        <fieldset className="mt-6">
          <legend className="label-text font-medium mb-2">
            {t('expiration.legend')}
          </legend>
          <div className="flex flex-wrap gap-4">
            {[
              { value: '3600', label: t('expiration.optionOneHourLabel') },
              { value: '86400', label: t('expiration.optionOneDayLabel') },
              { value: '604800', label: t('expiration.optionOneWeekLabel') },
            ].map(option => (
              <label
                key={option.value}
                className="flex items-center gap-2 cursor-pointer"
              >
                <input
                  type="radio"
                  name="expiration"
                  className="radio radio-primary radio-sm"
                  value={option.value}
                  checked={expiration === option.value}
                  onChange={() => setExpiration(option.value)}
                />
                <span className="label-text">{option.label}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="form-control mt-8">
          <button
            className="btn btn-primary w-full h-12 text-base font-semibold rounded-lg transition-all duration-200"
            type="submit"
            disabled={submitting}
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
                d="M21.75 9v.906a2.25 2.25 0 0 1-1.183 1.981l-6.478 3.488M2.25 9v.906a2.25 2.25 0 0 0 1.183 1.981l6.478 3.488m8.839 2.51-4.66-2.51m0 0-1.023-.55a2.25 2.25 0 0 0-2.134 0l-1.022.55m0 0-4.661 2.51m16.5 1.615a2.25 2.25 0 0 1-2.25 2.25h-15a2.25 2.25 0 0 1-2.25-2.25V6.75A2.25 2.25 0 0 1 4.5 4.5h15a2.25 2.25 0 0 1 2.25 2.25v10.5Z"
              />
            </svg>
            {t('request.buttonCreate')}
          </button>
        </div>
      </form>
    </>
  );
}
