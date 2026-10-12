import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useConfig } from '@shared/hooks/useConfig';
import type { FlowStep } from '@shared/hooks/useFlowStep';
import { FingerprintRidges } from './Brand';
import {
  ForkIcon,
  PadlockIcon,
  ShareIcon,
  TimerIcon,
  TrayDownloadIcon,
  UserXIcon,
} from './icons';

// The lime side panel of the share flow. The three steps light up as the
// flow advances and the rail between them fills in.
export default function HowItWorks({ step }: { step: FlowStep }) {
  const { t } = useTranslation();
  const { DISABLE_FEATURES, READ_ONLY } = useConfig();
  const steps = [
    [t('aside.step1Title'), t('aside.step1Text')],
    [t('aside.step2Title'), t('aside.step2Text')],
    [t('aside.step3Title'), t('aside.step3Text')],
  ];
  const features: [ReactNode, string][] = [
    [<PadlockIcon className="size-4" />, t('features.featureEndToEndTitle')],
    [
      <TimerIcon className="size-4" />,
      t('features.featureSelfDestructionTitle'),
    ],
    [
      <TrayDownloadIcon className="size-4" />,
      t('features.featureOneTimeTitle'),
    ],
    [<ShareIcon className="size-4" />, t('features.featureSimpleSharingTitle')],
    [<UserXIcon className="size-4" />, t('features.featureNoAccountsTitle')],
    [<ForkIcon className="size-4" />, t('features.featureOpenSourceTitle')],
  ];

  return (
    <aside className="relative isolate flex flex-col gap-[22px] overflow-hidden bg-secondary px-8 pt-10 pb-8 text-secondary-content lg:px-10 lg:pt-11">
      <FingerprintRidges className="absolute -right-[150px] -bottom-[140px] -z-10 size-[460px] text-secondary-content/[.13]" />
      <div className="font-mono text-[10.5px] tracking-[.12em] text-secondary-content/60 uppercase">
        {t('aside.title')}
      </div>
      <ol className="m-0 flex list-none flex-col p-0">
        {steps.map(([title, text], i) => {
          const lit = i <= step;
          return (
            <li
              key={title}
              className="relative grid grid-cols-[28px_minmax(0,1fr)] gap-3.5 pb-6 last:pb-0"
              aria-current={i === step ? 'step' : undefined}
            >
              {i < steps.length - 1 && (
                <span
                  aria-hidden="true"
                  className="absolute top-[30px] bottom-0.5 left-[13px] w-0.5 overflow-hidden rounded-sm bg-secondary-content/15"
                >
                  <span
                    className={`block h-full origin-top bg-secondary-content transition-transform duration-500 ease-lv ${
                      i < step ? 'scale-y-100' : 'scale-y-0'
                    }`}
                  />
                </span>
              )}
              <span
                className={`relative grid size-7 place-items-center rounded-lg font-mono text-xs font-semibold transition-[background-color,color,box-shadow] duration-300 ${
                  lit
                    ? 'bg-secondary-content text-secondary'
                    : 'text-secondary-content shadow-[inset_0_0_0_1.5px_rgb(11_13_18/.4)]'
                }`}
              >
                {i < step ? '✓' : `0${i + 1}`}
              </span>
              <div>
                <div className="text-sm leading-[1.35] font-semibold">
                  {title}
                </div>
                <div className="mt-[3px] text-[13px] leading-[1.55] text-secondary-content/75">
                  {text}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
      {!DISABLE_FEATURES && !READ_ONLY && (
        <>
          <div className="h-px bg-secondary-content/[.12]" />
          <ul className="m-0 grid list-none grid-cols-2 gap-x-[18px] gap-y-3.5 p-0">
            {features.map(([icon, label]) => (
              <li
                key={label}
                className="flex items-center gap-[9px] text-[13px] font-medium"
              >
                <span className="flex-none">{icon}</span>
                {label}
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="mt-auto pt-4 text-xs leading-[1.55] text-secondary-content/70">
        {t('aside.footer')}
      </div>
    </aside>
  );
}
