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

function useSteps() {
  const { t } = useTranslation();
  return [
    [t('aside.step1Title'), t('aside.step1Text')],
    [t('aside.step2Title'), t('aside.step2Text')],
    [t('aside.step3Title'), t('aside.step3Text')],
  ];
}

// Step badge: lit (ink) once reached, a check once passed.
function stepBadge(i: number, step: FlowStep) {
  return i < step ? '✓' : `0${i + 1}`;
}

// The lime side panel of the share flow (desktop). It stays pinned beside
// the page while the steps light up as the flow advances and the rail
// between them fills in.
export default function HowItWorks({ step }: { step: FlowStep }) {
  const { t } = useTranslation();
  const { DISABLE_FEATURES, READ_ONLY } = useConfig();
  const steps = useSteps();
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
    <aside className="relative isolate hidden flex-col gap-[22px] overflow-hidden bg-secondary px-10 pt-14 pb-8 text-secondary-content lg:sticky lg:top-16 lg:flex lg:h-[calc(100dvh-4rem)] lg:self-start">
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
                {stepBadge(i, step)}
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

// The phone version of the panel: a slim lime strip under the header that
// names only the current step, so the form stays above the fold.
export function FlowStrip({ step }: { step: FlowStep }) {
  const { t } = useTranslation();
  const steps = useSteps();
  return (
    <nav
      aria-label={t('aside.title')}
      className="bg-secondary text-secondary-content lg:hidden"
    >
      <ol className="m-0 flex list-none items-center gap-2 px-[max(1.25rem,env(safe-area-inset-left))] py-2.5 sm:px-10">
        {steps.map(([title], i) => {
          const current = i === Math.min(step, 2);
          return (
            <li
              key={title}
              className={`flex min-w-0 items-center gap-2 ${current ? 'shrink' : 'flex-none'} ${
                i < steps.length - 1 ? 'flex-1' : ''
              }`}
              aria-current={current ? 'step' : undefined}
            >
              <span
                className={`grid size-[22px] flex-none place-items-center rounded-md font-mono text-[11px] font-semibold transition-colors duration-300 ${
                  i <= step
                    ? 'bg-secondary-content text-secondary'
                    : 'shadow-[inset_0_0_0_1.5px_rgb(11_13_18/.4)]'
                }`}
              >
                {stepBadge(i, step)}
              </span>
              {current && (
                <span className="truncate text-[12.5px] font-semibold">
                  {title}
                </span>
              )}
              {i < steps.length - 1 && (
                <span
                  aria-hidden="true"
                  className="h-0.5 min-w-3 flex-1 overflow-hidden rounded-sm bg-secondary-content/15"
                >
                  <span
                    className={`block h-full origin-left bg-secondary-content transition-transform duration-500 ease-lv ${
                      i < step ? 'scale-x-100' : 'scale-x-0'
                    }`}
                  />
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
