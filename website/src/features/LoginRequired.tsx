import { useTranslation } from 'react-i18next';
import { backendDomain } from '@shared/lib/api';
import { LockIcon } from '@shared/components/icons';

export default function LoginRequired() {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col items-center justify-center space-y-6 py-8">
      <div className="flex items-center justify-center w-16 h-16 rounded-full bg-primary/10">
        <LockIcon className="h-8 w-8 text-primary" />
      </div>

      <div className="text-center space-y-4 max-w-2xl">
        <h1 className="text-3xl font-bold text-base-content">
          {t('auth.loginRequiredTitle')}
        </h1>
        <p className="text-lg text-base-content/70">
          {t('auth.loginRequiredDescription')}
        </p>
        <a href={`${backendDomain}/auth/login`} className="btn btn-primary">
          {t('auth.login')}
        </a>
      </div>
    </div>
  );
}
