import { useTranslation } from 'react-i18next';

export default function ReadOnlyLanding() {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col items-center justify-center space-y-6 py-8">
      <div className="flex items-center justify-center w-24 h-24 rounded-full bg-primary/10">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className="h-12 w-12 text-primary"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
          />
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
          />
        </svg>
      </div>

      <div className="text-center space-y-4 max-w-2xl">
        <h1 className="text-3xl font-bold text-base-content">
          {t('readOnly.title')}
        </h1>
        <p className="text-lg text-base-content/70">
          {t('readOnly.description')}
        </p>
      </div>
    </div>
  );
}
