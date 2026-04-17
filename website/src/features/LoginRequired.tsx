import { useTranslation } from 'react-i18next';
import { backendDomain } from '@shared/lib/api';

export default function LoginRequired() {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col items-center justify-center space-y-6 py-8">
      <div className="flex items-center justify-center w-16 h-16 rounded-full bg-primary/10">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className="h-8 w-8 text-primary"
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
