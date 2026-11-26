import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useConfig } from '@shared/hooks/useConfig';
import { useAuth } from '@shared/hooks/useAuth';
import AuthRequiredNotice from '@shared/components/AuthRequiredNotice';
import NotRecipientNotice from '@shared/components/NotRecipientNotice';
import { EyeIcon, InfoIcon, LockIcon } from '@shared/components/icons';
import ErrorPage from './ErrorPage';
import Decryptor from './Decryptor';
import StreamingDecryptor from './StreamingDecryptor';
import useSecretStatus from './useSecretStatus';
import useFetchSecret from './useFetchSecret';
import EnterDecryptionKey from './EnterDecryptionKey';

export default function Prefetcher() {
  const { format, key } = useParams();
  return <SecretPrefetcher key={`${format}/${key}`} />;
}

function SecretPrefetcher() {
  const { t } = useTranslation();
  const { format, key, password: paramsPassword } = useParams();
  const { PREFETCH_SECRET, REQUIRE_AUTH_ALL } = useConfig();
  const { isAuthenticated, loading: authLoading } = useAuth();
  const isFile = format === 'f';
  const [fetchRequested, setFetchRequested] = useState(!PREFETCH_SECRET);
  const [enteredPassword, setPassword] = useState('');
  // An emailed code opened this secret for a while: count as admitted.
  const [codeAttempt, setCodeAttempt] = useState(0);
  const codeVerified = codeAttempt > 0;
  const password = paramsPassword ?? enteredPassword;

  // Every read is gated, so a signed-out status check would only fail.
  const mustLogIn = REQUIRE_AUTH_ALL && !isAuthenticated && !codeVerified;
  const status = useSecretStatus(
    key ?? '',
    isFile,
    PREFETCH_SECRET && !fetchRequested && !mustLogIn,
  );

  // Auto-fetch for non one-time secrets
  const fetchSecret =
    fetchRequested || (PREFETCH_SECRET && status.value?.oneTime === false);

  // Only text secrets are fetched here — files are handled by
  // StreamingDecryptor
  // A short link must not consume a text secret until a key is submitted.
  const text = useFetchSecret(
    key ?? '',
    fetchSecret && !isFile && !!password,
    codeAttempt,
  );

  // For a restricted secret the read decides: a grant from an earlier code
  // may open it although nobody is signed in.
  const requiresAuth =
    mustLogIn ||
    (!isAuthenticated &&
      (text.requiresAuth ||
        (!codeVerified &&
          status.value?.requireAuth === true &&
          status.value?.restricted !== true)));
  // Unknown until the status is read, which `--require-auth-all` gates.
  const maybeRestricted = status.value
    ? status.value.restricted === true
    : mustLogIn || text.restricted;
  const code = maybeRestricted
    ? {
        secretKey: key ?? '',
        isFile,
        onVerified: () => setCodeAttempt(attempt => attempt + 1),
      }
    : undefined;

  // Wait for auth state to resolve before deciding whether to gate access
  if (authLoading) {
    return <div>{t('display.loading')}</div>;
  }

  // Surface errors before showing the loading placeholder
  if (status.error || text.error) {
    return <ErrorPage />;
  }

  if (requiresAuth) {
    return (
      <AuthRequiredNotice
        restricted={status.value?.restricted === true}
        code={code}
      />
    );
  }

  if (text.notRecipient) {
    return <NotRecipientNotice code={code} />;
  }

  const loadingPrefetch = PREFETCH_SECRET ? status.loading : false;
  if (
    loadingPrefetch ||
    (!isFile && (text.loading || (fetchSecret && !!password && !text.secret)))
  ) {
    return <div>{t('display.loading')}</div>;
  }

  if (!fetchSecret && PREFETCH_SECRET) {
    const isOneTime = status.value?.oneTime === true;
    return (
      <>
        <div className="flex items-center mb-2">
          <LockIcon className="h-8 w-8 text-success me-2" />
          <h2 className="text-3xl font-medium tracking-tight">
            {t('display.secureMessageTitle')}
          </h2>
        </div>
        <p className="mb-8 text-base-content/70 text-lg">
          {t('display.secureMessageSubtitle')}
        </p>
        {isOneTime && (
          <div className="alert alert-warning mb-8 shadow-sm">
            <InfoIcon className="w-6 h-6 shrink-0" />
            <div>
              <div className="font-semibold text-base mb-1">
                {t('display.importantTitle')}
              </div>
              <div className="text-sm opacity-90">
                {t('display.oneTimeWarning')}
                <br />
                {t('display.oneTimeWarningReady')}
              </div>
            </div>
          </div>
        )}
        <div className="flex justify-center mt-8">
          <button
            className="flex items-center gap-3 px-12 py-4 btn btn-primary h-12 text-base font-semibold transition-all duration-200 max-w-md w-full"
            onClick={() => setFetchRequested(true)}
          >
            <EyeIcon className="h-7 w-7" />
            {t('display.buttonRevealMessage')}
          </button>
        </div>
      </>
    );
  }

  // File downloads use streaming decryption. Key by the secret so navigating
  // between files remounts it, resetting per-secret state and revoking the
  // previous blob URL instead of leaking it into the next view.
  if (isFile && key) {
    return (
      <StreamingDecryptor
        key={key}
        secretKey={key}
        restricted={status.value?.restricted === true}
      />
    );
  }

  if (!password) {
    return <EnterDecryptionKey setPassword={setPassword} />;
  }

  if (!text.secret) {
    return <ErrorPage />;
  }
  // A URL key change resets decryption, but retains the downloaded ciphertext.
  return (
    <Decryptor key={password} secret={text.secret} initialPassword={password} />
  );
}
