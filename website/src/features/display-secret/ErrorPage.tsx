import { useTranslation } from 'react-i18next';
import { useConfig } from '@shared/hooks/useConfig';
import { useFlowStep } from '@shared/hooks/useFlowStep';
import { ArrowRightIcon, HourglassIcon } from '@shared/components/icons';
import {
  IconTile,
  ScreenHeading,
  primaryButtonClass,
} from '@shared/components/ui';

// Shown when a secret link no longer resolves: opened already, expired, or
// mistyped. Lists the likely reasons and offers to create a new secret.
export default function ErrorPage() {
  const { t } = useTranslation();
  const { READ_ONLY } = useConfig();
  useFlowStep(3);
  const reasons = [
    [t('error.titleOpened'), t('error.subtitleOpenedBefore')],
    [t('error.titleExpired'), t('error.subtitleExpired')],
    [t('error.titleBrokenLink'), t('error.subtitleBrokenLink')],
  ];
  return (
    <div className="flex animate-lv-enter flex-col gap-6">
      <IconTile tone="quiet">
        <HourglassIcon className="size-[22px]" />
      </IconTile>
      <ScreenHeading title={t('error.title')}>
        {t('error.subtitle')}
      </ScreenHeading>
      <ol className="m-0 list-none divide-y divide-base-300 rounded-xl border border-base-300 p-0">
        {reasons.map(([title, text], i) => (
          <li key={title} className="flex gap-3 px-4 py-3.5 text-[13.5px]">
            <span className="font-mono text-base-content/50">0{i + 1}</span>
            <span>
              <span className="font-semibold">{title}</span>
              <span className="mt-0.5 block text-[12.5px] leading-relaxed text-base-content/65">
                {text}
              </span>
            </span>
          </li>
        ))}
      </ol>
      {!READ_ONLY && (
        <div className="flex">
          <a href="#/" className={primaryButtonClass}>
            {t('error.buttonCreate')}
            <ArrowRightIcon className="size-4 text-(--lv-arrow)" />
          </a>
        </div>
      )}
    </div>
  );
}
