import { useTranslation } from 'react-i18next';

export default function ErrorPage() {
  const { t } = useTranslation();
  return (
    <div className="max-w-2xl mx-auto">
      <div className="flex items-center mb-6">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={1.5}
          stroke="currentColor"
          className="h-8 w-8 text-error mr-3"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"
          />
        </svg>
        <h2 className="text-3xl font-bold text-error">{t('error.title')}</h2>
      </div>

      <p className="mb-8 text-lg text-base-content/70">{t('error.subtitle')}</p>

      <div className="space-y-6">
        <div className="p-6 bg-base-100 border border-base-300 rounded-lg shadow-sm">
          <div className="flex items-center mb-3">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
              className="h-6 w-6 text-warning mr-3"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"
              />
            </svg>
            <span className="font-semibold text-lg text-base-content">
              {t('error.titleOpened')}
            </span>
          </div>
          <p className="text-base-content/80 leading-relaxed">
            {t('error.subtitleOpenedBefore')}
            <br />
            {t('error.subtitleOpenedCompromised')}
          </p>
        </div>

        <div className="p-6 bg-base-100 border border-base-300 rounded-lg shadow-sm">
          <div className="flex items-center mb-3">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
              className="h-6 w-6 text-warning mr-3"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244"
              />
            </svg>
            <span className="font-semibold text-lg text-base-content">
              {t('error.titleBrokenLink')}
            </span>
          </div>
          <p className="text-base-content/80 leading-relaxed">
            {t('error.subtitleBrokenLink')}
          </p>
        </div>

        <div className="p-6 bg-base-100 border border-base-300 rounded-lg shadow-sm">
          <div className="flex items-center mb-3">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
              className="h-6 w-6 text-warning mr-3"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"
              />
            </svg>
            <span className="font-semibold text-lg text-base-content">
              {t('error.titleExpired')}
            </span>
          </div>
          <p className="text-base-content/80 leading-relaxed">
            {t('error.subtitleExpired')}
          </p>
        </div>
      </div>
    </div>
  );
}
