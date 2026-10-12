import { useTranslation } from 'react-i18next';
import { backendDomain } from '@shared/lib/api';
import { ArrowRightIcon, PadlockIcon } from '@shared/components/icons';
import {
  IconTile,
  ScreenHeading,
  primaryButtonClass,
} from '@shared/components/ui';

// Shown when a secret requires authentication and the visitor has no
// session: a lock tile, explanation and a sign-in link.
export default function AuthRequiredNotice() {
  const { t } = useTranslation();
  return (
    <div className="flex animate-lv-enter flex-col gap-6">
      <IconTile>
        <PadlockIcon className="size-[22px]" />
      </IconTile>
      <ScreenHeading title={t('display.authRequiredTitle')}>
        {t('display.authRequiredDescription')}
      </ScreenHeading>
      <div className="flex">
        <a href={`${backendDomain}/auth/login`} className={primaryButtonClass}>
          {t('display.buttonSignInToView')}
          <ArrowRightIcon className="size-4 text-(--lv-arrow)" />
        </a>
      </div>
    </div>
  );
}
