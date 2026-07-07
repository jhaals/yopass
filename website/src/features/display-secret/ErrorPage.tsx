import { useTranslation } from 'react-i18next';
import {
  ClockIcon,
  EyeIcon,
  LinkIcon,
  WarningIcon,
} from '@shared/components/icons';

export default function ErrorPage() {
  const { t } = useTranslation();
  return (
    <div className="max-w-2xl mx-auto">
      <div className="flex items-center mb-6">
        <WarningIcon className="h-8 w-8 text-error mr-3" />
        <h2 className="text-3xl font-bold text-error">{t('error.title')}</h2>
      </div>

      <p className="mb-8 text-lg text-base-content/70">{t('error.subtitle')}</p>

      <div className="space-y-6">
        <div className="p-5 bg-base-100 border border-base-300 rounded-lg">
          <div className="flex items-center mb-3">
            <EyeIcon className="h-6 w-6 text-warning mr-3" />
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

        <div className="p-5 bg-base-100 border border-base-300 rounded-lg">
          <div className="flex items-center mb-3">
            <LinkIcon className="h-6 w-6 text-warning mr-3" />
            <span className="font-semibold text-lg text-base-content">
              {t('error.titleBrokenLink')}
            </span>
          </div>
          <p className="text-base-content/80 leading-relaxed">
            {t('error.subtitleBrokenLink')}
          </p>
        </div>

        <div className="p-5 bg-base-100 border border-base-300 rounded-lg">
          <div className="flex items-center mb-3">
            <ClockIcon className="h-6 w-6 text-warning mr-3" />
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
