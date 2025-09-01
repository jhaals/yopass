import { useConfig } from "@shared/hooks/useConfig";
import { useTranslation } from 'react-i18next';

export default function FeaturesSection() {
  const { t } = useTranslation();
  const { DISABLE_FEATURES } = useConfig();
  if (DISABLE_FEATURES) return null;
  return (
    <div className="mt-8">
      <div className="mt-8 text-center mb-8">
        <h2 className="text-2xl font-bold mb-4">
          {t('features.title')}
        </h2>
        <p className="text-base text-base-content/80 max-w-3xl mx-auto">
          {t('features.subtitle')}
        </p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="card bg-base-100 shadow-md rounded-lg">
          <div className="card-body items-center text-center">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-8 w-8 text-primary mb-2"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
              />
            </svg>
            <h3 className="card-title text-lg">{t('features.featureEndToEndTitle')}</h3>
            <p>
              {t('features.featureEndToEndText')}
            </p>
          </div>
        </div>
        <div className="card bg-base-100 shadow-md rounded-lg">
          <div className="card-body items-center text-center">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-8 w-8 text-primary mb-2"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M1 7h22M8 7V5a2 2 0 012-2h4a2 2 0 012 2v2"
              />
            </svg>
            <h3 className="card-title text-lg">{t('features.featureSelfDestructionTitle')}</h3>
            <p>
              {t('features.featureSelfDestructionText')}
            </p>
          </div>
        </div>
        <div className="card bg-base-100 shadow-md rounded-lg">
          <div className="card-body items-center text-center">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-8 w-8 text-primary mb-2"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5m0 0l5-5m-5 5V4"
              />
            </svg>
            <h3 className="card-title text-lg">{t('features.featureOneTimeTitle')}</h3>
            <p>
              {t('features.featureOneTimeText')}
            </p>
          </div>
        </div>
        <div className="card bg-base-100 shadow-md rounded-lg">
          <div className="card-body items-center text-center">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-8 w-8 text-primary mb-2"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M7.217 10.907a2.25 2.25 0 1 0 0 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186 9.566-5.314m-9.566 7.5 9.566 5.314m0 0a2.25 2.25 0 1 0 3.935 2.186 2.25 2.25 0 0 0-3.935-2.186Zm0-12.814a2.25 2.25 0 1 0 3.933-2.185 2.25 2.25 0 0 0-3.933 2.185Z"
              />
            </svg>
            <h3 className="card-title text-lg">{t('features.featureSimpleSharingTitle')}</h3>
            <p>
              {t('features.featureSimpleSharingText')}
            </p>
          </div>
        </div>
        <div className="card bg-base-100 shadow-md rounded-lg">
          <div className="card-body items-center text-center">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-8 w-8 text-primary mb-2"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M17 20h5v-2a4 4 0 00-3-3.87M9 20H4v-2a4 4 0 013-3.87m9-6.13a4 4 0 11-8 0 4 4 0 018 0z"
              />
            </svg>
            <h3 className="card-title text-lg">{t('features.featureNoAccountsTitle')}</h3>
            <p>
              {t('features.featureNoAccountsText')}
            </p>
          </div>
        </div>
        <div className="card bg-base-100 shadow-md rounded-lg">
          <div className="card-body items-center text-center">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-8 w-8 text-primary mb-2"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M16 18l6-6-6-6M8 6l-6 6 6 6"
              />
            </svg>
            <h3 className="card-title text-lg">{t('features.featureOpenSourceTitle')}</h3>
            <p>
              {t('features.featureOpenSourceText')}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
