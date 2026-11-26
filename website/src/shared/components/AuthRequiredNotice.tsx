import { useTranslation } from 'react-i18next';
import { backendDomain } from '@shared/lib/api';
import { rememberLoginReturn } from '@shared/lib/loginReturn';
import { LockIcon } from '@shared/components/icons';
import { useConfig } from '@shared/hooks/useConfig';
import RecipientCodeForm, {
  type RecipientCode,
} from '@shared/components/RecipientCodeForm';

// Shown when a secret requires authentication and the visitor has no
// session: a lock icon, explanation and a sign-in link. `restricted` says the
// secret is for one named recipient, without revealing who. `code` offers a
// recipient who cannot sign in an emailed code instead, when the server does.
export default function AuthRequiredNotice({
  restricted = false,
  code,
}: {
  restricted?: boolean;
  code?: RecipientCode;
}) {
  const { t } = useTranslation();
  const { RECIPIENT_EMAIL_CODE } = useConfig();
  return (
    <div className="flex flex-col items-center text-center py-16">
      <LockIcon className="h-14 w-14 text-primary mb-4" />
      <h2 className="text-3xl font-medium tracking-tight mb-3">
        {restricted
          ? t('display.restrictedTitle')
          : t('display.authRequiredTitle')}
      </h2>
      <p className="text-base-content/70 mb-8 max-w-sm">
        {restricted
          ? t('display.restrictedDescription')
          : t('display.authRequiredDescription')}
      </p>
      <a
        href={`${backendDomain}/auth/login`}
        onClick={rememberLoginReturn}
        className="btn btn-primary px-10"
      >
        {t('display.buttonSignInToView')}
      </a>
      {RECIPIENT_EMAIL_CODE && code && <RecipientCodeForm {...code} />}
    </div>
  );
}
