import { useTranslation } from 'react-i18next';
import { signOut } from '@shared/lib/api';
import { useAuth } from '@shared/hooks/useAuth';
import { LockIcon } from '@shared/components/icons';
import { useConfig } from '@shared/hooks/useConfig';
import RecipientCodeForm, {
  type RecipientCode,
} from '@shared/components/RecipientCodeForm';

// Shown when a signed-in visitor is neither the recipient nor the creator of
// a restricted secret, with a way to sign in as someone else, or to use an
// emailed code when the server offers them.
export default function NotRecipientNotice({ code }: { code?: RecipientCode }) {
  const { t } = useTranslation();
  const { RECIPIENT_EMAIL_CODE } = useConfig();
  const { email } = useAuth();
  return (
    <div className="flex flex-col items-center text-center py-16">
      <LockIcon className="h-14 w-14 text-primary mb-4" />
      <h2 className="text-3xl font-medium tracking-tight mb-3">
        {t('display.restrictedTitle')}
      </h2>
      <p className="text-base-content/70 mb-8 max-w-sm">
        {email
          ? t('display.notRecipientDescription', { email })
          : t('display.notRecipientDescriptionNoEmail')}
      </p>
      <button type="button" onClick={signOut} className="btn btn-primary px-10">
        {t('auth.logout')}
      </button>
      {RECIPIENT_EMAIL_CODE && code && <RecipientCodeForm {...code} />}
    </div>
  );
}
