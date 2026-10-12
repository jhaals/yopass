import { useTranslation } from 'react-i18next';
import { useFlowStep } from '@shared/hooks/useFlowStep';
import { PadlockIcon } from '@shared/components/icons';
import { IconTile } from '@shared/components/ui';

export default function ReadOnlyLanding() {
  const { t } = useTranslation();
  useFlowStep(2);

  return (
    <div className="flex animate-lv-enter flex-col gap-6">
      <IconTile>
        <PadlockIcon className="size-[22px]" />
      </IconTile>
      <div className="flex flex-col gap-2">
        <h1 className="m-0 text-[30px] leading-[1.12] font-semibold tracking-[-0.028em]">
          {t('readOnly.title')}
        </h1>
        <p className="m-0 max-w-[560px] text-sm leading-relaxed text-base-content/75">
          {t('readOnly.description')}
        </p>
      </div>
    </div>
  );
}
