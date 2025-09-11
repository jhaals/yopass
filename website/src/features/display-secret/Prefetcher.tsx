import { backendDomain } from '@shared/lib/api';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import ErrorPage from './ErrorPage';
import { useEffect, useRef, useState } from 'react';
import { useConfig } from '@shared/hooks/useConfig';
import { useAsync } from 'react-use';
import Decryptor from './Decryptor';

export default function Prefetcher() {
  const { t } = useTranslation();
  const { format, key } = useParams();
  const { PREFETCH_SECRET } = useConfig();
  const [fetchSecret, setFetchSecret] = useState(
    PREFETCH_SECRET ? false : true,
  );

  const isFile = format === 'f';
  const url = `${backendDomain}/${isFile ? 'file' : 'secret'}/${key}`;
  const oneTime = useAsync(async () => {
    if (!(PREFETCH_SECRET && !fetchSecret)) {
      return undefined;
    }
    const statusUrl = `${url}/status`;
    const request = await fetch(statusUrl);
    if (request.status === 404) {
      throw new Error('Secret not found');
    }
    if (!request.ok) {
      throw new Error('Failed to check status');
    }
    const json = (await request.json()) as { oneTime: boolean };
    return json.oneTime;
  }, [PREFETCH_SECRET, fetchSecret, url]);

  // Auto-fetch for non one-time secrets
  useEffect(() => {
    if (PREFETCH_SECRET && !fetchSecret && oneTime.value === false) {
      setFetchSecret(true);
    }
  }, [PREFETCH_SECRET, fetchSecret, oneTime.value]);

  // secret fetcher (guarded against duplicate calls under React StrictMode)
  const hasFetchedRef = useRef(false);
  const [secretValue, setSecretValue] = useState<string | undefined>(undefined);
  const [secretLoading, setSecretLoading] = useState(false);
  const [secretError, setSecretError] = useState<Error | null>(null);

  useEffect(() => {
    if (!fetchSecret) {
      return;
    }
    if (hasFetchedRef.current) {
      return;
    }
    hasFetchedRef.current = true;
    setSecretLoading(true);
    setSecretError(null);
    (async () => {
      try {
        const request = await fetch(url);
        if (!request.ok) {
          throw new Error('Failed to fetch secret');
        }
        const json = await request.json();
        if (!json || typeof json.message !== 'string') {
          throw new Error('Invalid secret response');
        }
        setSecretValue(json.message as string);
      } catch (e) {
        setSecretError(e as Error);
      } finally {
        setSecretLoading(false);
      }
    })();
  }, [fetchSecret, url]);

  // Surface errors before showing the loading placeholder
  if (oneTime.error || secretError) {
    return <ErrorPage />;
  }
  const loadingPrefetch = PREFETCH_SECRET ? oneTime.loading : false;
  if (loadingPrefetch || secretLoading || (fetchSecret && !secretValue)) {
    return <div>{t('display.loading')}</div>;
  }

  if (!fetchSecret && PREFETCH_SECRET) {
    const isOneTime = oneTime.value === true;
    return (
      <>
        <div className="flex items-center mb-2">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth="1.5"
            stroke="currentColor"
            className="h-8 w-8 text-green-500 mr-2"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z"
            />
          </svg>
          <h2 className="text-3xl font-bold">
            {t('display.secureMessageTitle')}
          </h2>
        </div>
        <p className="mb-8 text-base-content/70 text-lg">
          {t('display.secureMessageSubtitle')}
        </p>
        {isOneTime && (
          <div className="alert alert-warning mb-8 shadow-sm">
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
            className="flex items-center gap-3 px-12 py-4 btn btn-primary h-16 text-lg font-semibold shadow-lg hover:shadow-xl transition-all duration-200 max-w-md w-full"
            onClick={() => setFetchSecret(true)}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
              className="h-7 w-7"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M2.25 12s3.75-6.75 9.75-6.75S21.75 12 21.75 12s-3.75 6.75-9.75 6.75S2.25 12 2.25 12Z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"
              />
            </svg>
            {t('display.buttonRevealMessage')}
          </button>
        </div>
      </>
    );
  }
  if (!secretValue) {
    return <ErrorPage />;
  }
  return <Decryptor secret={secretValue} />;
}
