import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useConfig } from '@shared/hooks/useConfig';
import { useAuth } from '@shared/hooks/useAuth';
import AuthRequiredNotice from '@shared/components/AuthRequiredNotice';
import { EyeIcon, InfoIcon, LockIcon } from '@shared/components/icons';
import ErrorPage from './ErrorPage';
import Decryptor from './Decryptor';
import StreamingDecryptor from './StreamingDecryptor';
import useSecretStatus from './useSecretStatus';
import useFetchSecret from './useFetchSecret';

export default function Prefetcher() {
  const { t } = useTranslation();
  const { format, key } = useParams();
  const { PREFETCH_SECRET } = useConfig();
  const { isAuthenticated, loading: authLoading } = useAuth();
  const isFile = format === 'f';
  const [fetchRequested, setFetchRequested] = useState(!PREFETCH_SECRET);

  const status = useSecretStatus(
    key ?? '',
    isFile,
    PREFETCH_SECRET && !fetchRequested,
  );

  // Auto-fetch for non one-time secrets
  const fetchSecret =
    fetchRequested || (PREFETCH_SECRET && status.value?.oneTime === false);

  // Only text secrets are fetched here — files are handled by
  // StreamingDecryptor
  const text = useFetchSecret(key ?? '', fetchSecret && !isFile);

  const requiresAuth =
    !isAuthenticated &&
    (text.requiresAuth || status.value?.requireAuth === true);

  // Wait for auth state to resolve before deciding whether to gate access
  if (authLoading) {
    return <div>{t('display.loading')}</div>;
  }

  // Surface errors before showing the loading placeholder
  if (status.error || text.error) {
    return <ErrorPage />;
  }

  if (requiresAuth) {
    return <AuthRequiredNotice />;
  }

  const loadingPrefetch = PREFETCH_SECRET ? status.loading : false;
  if (
    loadingPrefetch ||
    (!isFile && (text.loading || (fetchSecret && !text.secret)))
  ) {
    return <div>{t('display.loading')}</div>;
  }

  if (!fetchSecret && PREFETCH_SECRET) {
    const isOneTime = status.value?.oneTime === true;
    return (
      <>
        <div className="flex items-center mb-2">
          <LockIcon className="h-8 w-8 text-success mr-2" />
          <h2 className="text-3xl font-bold">
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
            className="flex items-center gap-3 px-12 py-4 btn btn-primary h-12 text-base font-semibold rounded-lg transition-all duration-200 max-w-md w-full"
            onClick={() => setFetchRequested(true)}
          >
            <EyeIcon className="h-7 w-7" />
            {t('display.buttonRevealMessage')}
          </button>
        </div>
      </>
    );
  }

  // File downloads use streaming decryption
  if (isFile && key) {
    return <StreamingDecryptor secretKey={key} />;
  }

  if (!text.secret) {
    return <ErrorPage />;
  }
  return <Decryptor secret={text.secret} />;
}
