import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useConfig } from '@shared/hooks/useConfig';
import { useAuth } from '@shared/hooks/useAuth';
import AuthRequiredNotice from '@shared/components/AuthRequiredNotice';
import { useFlowStep } from '@shared/hooks/useFlowStep';
import { ArrowRightIcon, PadlockIcon } from '@shared/components/icons';
import {
  IconTile,
  ScreenHeading,
  primaryButtonClass,
} from '@shared/components/ui';
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
  const { PREFETCH_SECRET } = useConfig();
  const { isAuthenticated, loading: authLoading } = useAuth();
  const isFile = format === 'f';
  const [fetchRequested, setFetchRequested] = useState(!PREFETCH_SECRET);
  const [enteredPassword, setPassword] = useState('');
  const password = paramsPassword ?? enteredPassword;

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
  // A short link must not consume a text secret until a key is submitted.
  const text = useFetchSecret(key ?? '', fetchSecret && !isFile && !!password);

  useFlowStep(status.error || text.error ? 3 : 2);

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
    (!isFile && (text.loading || (fetchSecret && !!password && !text.secret)))
  ) {
    return <div>{t('display.loading')}</div>;
  }

  if (!fetchSecret && PREFETCH_SECRET) {
    const isOneTime = status.value?.oneTime === true;
    return (
      <div className="flex animate-lv-enter flex-col gap-6">
        <IconTile>
          <PadlockIcon className="size-[22px]" />
        </IconTile>
        <ScreenHeading
          title={
            isFile
              ? t('display.secureFileTitle')
              : t('display.secureMessageTitle')
          }
        >
          {isOneTime
            ? t('display.oneTimeWarning')
            : t('display.viewNoteMultiple')}
        </ScreenHeading>
        <div className="rounded-xl border border-base-300">
          <div className="flex justify-between gap-4 px-4 py-3 text-[13px]">
            <span className="text-base-content/60">{t('display.views')}</span>
            <span className="font-mono">
              {isOneTime ? t('display.viewsOnce') : t('display.viewsMultiple')}
            </span>
          </div>
        </div>
        <div className="flex">
          <button
            className={primaryButtonClass}
            onClick={() => setFetchRequested(true)}
          >
            {t('display.buttonRevealMessage')}
            <ArrowRightIcon className="size-4 text-(--lv-arrow)" />
          </button>
        </div>
      </div>
    );
  }

  // File downloads use streaming decryption. Key by the secret so navigating
  // between files remounts it, resetting per-secret state and revoking the
  // previous blob URL instead of leaking it into the next view.
  if (isFile && key) {
    return <StreamingDecryptor key={key} secretKey={key} />;
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
