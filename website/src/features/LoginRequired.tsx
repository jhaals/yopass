import { useTranslation } from 'react-i18next';
import { backendDomain } from '@shared/lib/api';
import { useFlowStep } from '@shared/hooks/useFlowStep';
import { ArrowRightIcon, PadlockIcon } from '@shared/components/icons';
import { IconTile, primaryButtonClass } from '@shared/components/ui';

export default function LoginRequired() {
  const { t } = useTranslation();
  useFlowStep(0);

  return (
    <div className="flex animate-lv-enter flex-col gap-6">
      <IconTile>
        <PadlockIcon className="size-[22px]" />
      </IconTile>
      <div className="flex flex-col gap-2">
        <h1 className="m-0 text-[30px] leading-[1.12] font-semibold tracking-[-0.028em]">
          {t('auth.loginRequiredTitle')}
        </h1>
        <p className="m-0 max-w-[560px] text-sm leading-relaxed text-base-content/75">
          {t('auth.loginRequiredDescription')}
        </p>
      </div>
      <div className="flex">
        <a href={`${backendDomain}/auth/login`} className={primaryButtonClass}>
          {t('auth.login')}
          <ArrowRightIcon className="size-4 text-(--lv-arrow)" />
        </a>
      </div>
    </div>
  );
}
