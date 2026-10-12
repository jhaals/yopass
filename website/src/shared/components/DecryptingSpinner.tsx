import { useTranslation } from 'react-i18next';
import { SpinnerIcon } from '@shared/components/icons';

// Spinner shown while a secret or file is being decrypted. progress, when
// non-null, renders a percentage bar below it.
export default function DecryptingSpinner({
  progress = null,
}: {
  progress?: number | null;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-start gap-4 py-10 text-base-content/70">
      <SpinnerIcon className="size-7 animate-spin text-base-content" />
      <p className="m-0 text-[15px] font-medium">
        {t('display.decryptingMessage')}
      </p>
      {progress !== null && (
        <div className="w-64">
          <div className="h-1.5 overflow-hidden rounded-full bg-base-200">
            <div
              role="progressbar"
              aria-valuenow={progress}
              aria-valuemin={0}
              aria-valuemax={100}
              className="h-full rounded-full bg-secondary transition-[width] duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className="mt-1.5 font-mono text-xs">{progress}%</p>
        </div>
      )}
    </div>
  );
}
