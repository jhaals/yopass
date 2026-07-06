import { useTranslation } from 'react-i18next';
import { backendDomain } from '@shared/lib/api';

// Shown when a secret requires authentication and the visitor has no
// session: a lock icon, explanation and a sign-in link.
export default function AuthRequiredNotice() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center text-center py-16">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
        strokeWidth={1.5}
        stroke="currentColor"
        className="h-14 w-14 text-primary mb-4"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z"
        />
      </svg>
      <h2 className="text-3xl font-bold mb-3">
        {t('display.authRequiredTitle')}
      </h2>
      <p className="text-base-content/70 mb-8 max-w-sm">
        {t('display.authRequiredDescription')}
      </p>
      <a href={`${backendDomain}/auth/login`} className="btn btn-primary px-10">
        {t('display.buttonSignInToView')}
      </a>
    </div>
  );
}
