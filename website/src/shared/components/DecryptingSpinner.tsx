import { useTranslation } from 'react-i18next';
import { SpinnerIcon } from '@shared/components/icons';

// Full-width spinner shown while a secret or file is being decrypted.
// progress, when non-null, renders a percentage bar below the spinner.
export default function DecryptingSpinner({
  progress = null,
}: {
  progress?: number | null;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center justify-center py-16 text-base-content/70">
      <SpinnerIcon className="animate-spin h-8 w-8 text-primary" />
      <p className="mt-4 text-lg font-medium">
        {t('display.decryptingMessage')}
      </p>
      {progress !== null && (
        <div className="w-64 mt-4">
          <progress
            className="progress progress-primary w-full"
            value={progress}
            max="100"
          />
          <p className="text-sm text-center mt-1">{progress}%</p>
        </div>
      )}
    </div>
  );
}
