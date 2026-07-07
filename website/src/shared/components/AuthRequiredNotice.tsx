import { useTranslation } from 'react-i18next';
import { backendDomain } from '@shared/lib/api';
import { LockIcon } from '@shared/components/icons';

// Shown when a secret requires authentication and the visitor has no
// session: a lock icon, explanation and a sign-in link.
export default function AuthRequiredNotice() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center text-center py-16">
      <LockIcon className="h-14 w-14 text-primary mb-4" />
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
