import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { requestRecipientCode, verifyRecipientCode } from '@shared/lib/api';

export interface RecipientCode {
  secretKey: string;
  isFile: boolean;
  // Called once the server accepted a code and set the grant cookie.
  onVerified: () => void;
}

// For a recipient who cannot sign in here: asks for a code by email, then
// trades it for access to this one secret. The server answers the same
// whether or not the address may open it, so the form does too.
export default function RecipientCodeForm({
  secretKey,
  isFile,
  onVerified,
}: RecipientCode) {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(event?: React.FormEvent) {
    event?.preventDefault();
    const address = email.trim();
    if (!address) return;
    setBusy(true);
    setError(null);
    const result = await requestRecipientCode(secretKey, isFile, address);
    setBusy(false);
    if (result.status === 202) {
      setSentTo(address);
      setCode('');
    } else {
      setError(t('display.codeFailed'));
    }
  }

  async function verify(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await verifyRecipientCode(
      secretKey,
      isFile,
      sentTo ?? '',
      code.trim(),
    );
    setBusy(false);
    if (result.status === 200) {
      onVerified();
    } else if (result.status === 403) {
      setError(t('display.codeWrong'));
    } else {
      setError(t('display.codeFailed'));
    }
  }

  return (
    <div className="w-full max-w-sm mt-8 text-start">
      <div className="divider text-base-content/60">{t('display.codeOr')}</div>
      {sentTo === null ? (
        <form onSubmit={send}>
          <label htmlFor="recipient-code-email" className="label">
            <span className="label-text">{t('display.codeEmailLabel')}</span>
          </label>
          <input
            id="recipient-code-email"
            type="email"
            autoComplete="email"
            required
            className="input input-bordered w-full"
            value={email}
            onChange={e => setEmail(e.target.value)}
          />
          <button
            type="submit"
            className="btn btn-outline w-full mt-4"
            disabled={busy}
          >
            {t('display.codeSendButton')}
          </button>
        </form>
      ) : (
        <form onSubmit={verify}>
          <p className="text-sm text-base-content/70 mb-4" role="status">
            {t('display.codeSent', { email: sentTo })}
          </p>
          <label htmlFor="recipient-code" className="label">
            <span className="label-text">{t('display.codeInputLabel')}</span>
          </label>
          <input
            id="recipient-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            required
            className="input input-bordered w-full tracking-widest"
            value={code}
            onChange={e => setCode(e.target.value.replace(/\D/g, ''))}
          />
          <button
            type="submit"
            className="btn btn-primary w-full mt-4"
            disabled={busy || code.length !== 6}
          >
            {t('display.codeVerifyButton')}
          </button>
          <button
            type="button"
            className="btn btn-link btn-sm w-full mt-2"
            disabled={busy}
            onClick={() => send()}
          >
            {t('display.codeResend')}
          </button>
        </form>
      )}
      {error && (
        <p className="text-sm text-error mt-3" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
