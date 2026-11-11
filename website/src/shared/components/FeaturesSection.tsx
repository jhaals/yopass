import { useConfig } from '@shared/hooks/useConfig';
import { useTranslation } from 'react-i18next';
import { useResponderPage } from '@shared/hooks/useResponderPage';

// [translation key part, icon colour, icon path]
const FEATURES = [
  [
    'EndToEnd',
    'text-primary',
    'M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z',
  ],
  [
    'SelfDestruction',
    'text-error',
    'M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M1 7h22M8 7V5a2 2 0 012-2h4a2 2 0 012 2v2',
  ],
  [
    'OneTime',
    'text-success',
    'M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5m0 0l5-5m-5 5V4',
  ],
  [
    'SimpleSharing',
    'text-info',
    'M7.217 10.907a2.25 2.25 0 1 0 0 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186 9.566-5.314m-9.566 7.5 9.566 5.314m0 0a2.25 2.25 0 1 0 3.935 2.186 2.25 2.25 0 0 0-3.935-2.186Zm0-12.814a2.25 2.25 0 1 0 3.933-2.185 2.25 2.25 0 0 0-3.933 2.185Z',
  ],
  [
    'NoAccounts',
    'text-warning',
    'M17 20h5v-2a4 4 0 00-3-3.87M9 20H4v-2a4 4 0 013-3.87m9-6.13a4 4 0 11-8 0 4 4 0 018 0z',
  ],
  ['OpenSource', 'text-secondary', 'M16 18l6-6-6-6M8 6l-6 6 6 6'],
] as const;

export default function FeaturesSection() {
  const { t } = useTranslation();
  const { DISABLE_FEATURES, READ_ONLY } = useConfig();
  const responderPage = useResponderPage();
  if (DISABLE_FEATURES || READ_ONLY || responderPage) return null;
  return (
    <section className="mt-20 mb-8">
      <div className="mb-10 max-w-2xl">
        <h2 className="text-2xl sm:text-3xl font-medium tracking-tight mb-3 text-base-content">
          {t('features.title')}
        </h2>
        <p className="text-base text-base-content/70 leading-relaxed">
          {t('features.subtitle')}
        </p>
      </div>
      <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-px overflow-hidden rounded-box border border-base-300 bg-base-300">
        {FEATURES.map(([key, color, icon]) => (
          <li key={key} className="bg-base-100 p-6 flex flex-col gap-3">
            <div className="flex items-start gap-3">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className={`h-6 w-6 shrink-0 ${color}`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.5}
                aria-hidden="true"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d={icon} />
              </svg>
              <h3 className="text-base font-semibold text-base-content">
                {t(`features.feature${key}Title`)}
              </h3>
            </div>
            <p className="text-sm text-base-content/70 leading-relaxed">
              {t(`features.feature${key}Text`)}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
