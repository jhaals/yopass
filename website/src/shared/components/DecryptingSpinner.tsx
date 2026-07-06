import { useTranslation } from 'react-i18next';

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
      <svg
        className="animate-spin h-8 w-8 text-primary"
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <circle
          className="opacity-25"
          cx="12"
          cy="12"
          r="10"
          stroke="currentColor"
          strokeWidth="4"
        ></circle>
        <path
          className="opacity-75"
          fill="currentColor"
          d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
        ></path>
      </svg>
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
