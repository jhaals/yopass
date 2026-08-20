import { useTranslation } from 'react-i18next';
import { EyeIcon } from '@shared/components/icons';

export default function ReadOnlyLanding() {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col items-center justify-center space-y-6 py-8">
      <div className="flex items-center justify-center w-16 h-16 rounded-full bg-primary/10">
        <EyeIcon className="h-8 w-8 text-primary" />
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
