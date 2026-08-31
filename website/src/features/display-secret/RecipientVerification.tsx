import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  redeemVerificationCode,
  requestVerificationCode,
} from '@shared/lib/api';
import { InfoIcon, LockIcon } from '@shared/components/icons';

interface RecipientVerificationProps {
  secretKey: string;
  isFile: boolean;
  // Called with the retrieval token once the recipient passes verification.
  onVerified: (token: string) => void;
}

// RecipientVerification gates a bound secret behind a code mailed to the
// recipient. It never sees the decryption key, which stays in the URL
// fragment: only the ciphertext download is gated.
export default function RecipientVerification({
  secretKey,
  isFile,
  onVerified,
}: RecipientVerificationProps) {
  const { t } = useTranslation();
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submitEmail(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const result = await requestVerificationCode(secretKey, isFile, email);
    setBusy(false);
    // A non-matching address is answered exactly like a matching one, so the
    // UI advances either way. Only a transport or server error stops here.
    if (result.status !== 204) {
      setError(t('verification.sendFailed'));
      return;
    }
    setStep('code');
  }

  async function submitCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const result = await redeemVerificationCode(
      secretKey,
      isFile,
      email,
      code.trim(),
    );
    setBusy(false);
    if (result.status === 200 && result.data?.token) {
      onVerified(result.data.token);
      return;
    }
    // Only a 403 means the code itself was wrong. Reporting a network drop or
    // a server error as "invalid code" sends the recipient to request a fresh
    // one, spending a send they did not need to spend.
    setError(
      t(
        result.status === 403
          ? 'verification.invalidCode'
          : 'verification.verifyFailed',
      ),
    );
  }

  return (
    <>
      <div className="flex items-center mb-2">
        <LockIcon className="h-8 w-8 text-success mr-2" />
        <h2 className="text-3xl font-bold">{t('verification.title')}</h2>
      </div>
      <p className="mb-8 text-base-content/70 text-lg">
        {t('verification.subtitle')}
      </p>

      {step === 'email' ? (
        <form onSubmit={submitEmail}>
          <label className="label" htmlFor="verification-email">
            <span className="label-text font-medium">
              {t('verification.emailLabel')}
            </span>
          </label>
          <input
            id="verification-email"
            type="email"
            required
            autoComplete="email"
            autoFocus
            className="input input-bordered w-full rounded-lg focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            placeholder={t('verification.emailPlaceholder')}
            value={email}
            onChange={e => setEmail(e.target.value)}
          />
          {error && (
            <p className="mt-2 text-sm text-error" role="alert">
              {error}
            </p>
          )}
          <button
            type="submit"
            className="btn btn-primary w-full mt-6 h-12 text-base font-semibold rounded-lg"
            disabled={busy || email.trim() === ''}
          >
            {busy ? t('verification.sending') : t('verification.sendCode')}
          </button>
        </form>
      ) : (
        <form onSubmit={submitCode}>
          <div className="alert alert-info mb-6 shadow-sm">
            <InfoIcon className="w-6 h-6 shrink-0" />
            <div className="text-sm opacity-90">
              {t('verification.codeSent', { email })}
            </div>
          </div>
          <label className="label" htmlFor="verification-code">
            <span className="label-text font-medium">
              {t('verification.codeLabel')}
            </span>
          </label>
          <input
            id="verification-code"
            type="text"
            required
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            maxLength={6}
            className="input input-bordered w-full rounded-lg tracking-[0.5em] text-center text-xl focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            placeholder="000000"
            value={code}
            onChange={e => setCode(e.target.value.replace(/\D/g, ''))}
          />
          {error && (
            <p className="mt-2 text-sm text-error" role="alert">
              {error}
            </p>
          )}
          <button
            type="submit"
            className="btn btn-primary w-full mt-6 h-12 text-base font-semibold rounded-lg"
            disabled={busy || code.trim().length !== 6}
          >
            {busy ? t('verification.verifying') : t('verification.verify')}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm w-full mt-2"
            onClick={() => {
              setStep('email');
              setCode('');
              setError(null);
            }}
          >
            {t('verification.useDifferentEmail')}
          </button>
        </form>
      )}
    </>
  );
}
