import { useTranslation } from 'react-i18next';
import {
  ClockIcon,
  EyeIcon,
  LinkIcon,
  WarningIcon,
} from '@shared/components/icons';

export default function ErrorPage() {
  const { t } = useTranslation();
  const reasons = [
    {
      Icon: EyeIcon,
      chip: 'bg-warning/10 text-warning',
      title: t('error.titleOpened'),
      text: [
        t('error.subtitleOpenedBefore'),
        t('error.subtitleOpenedCompromised'),
      ],
    },
    {
      Icon: LinkIcon,
      chip: 'bg-info/10 text-info',
      title: t('error.titleBrokenLink'),
      text: [t('error.subtitleBrokenLink')],
    },
    {
      Icon: ClockIcon,
      chip: 'bg-secondary/10 text-secondary',
      title: t('error.titleExpired'),
      text: [t('error.subtitleExpired')],
    },
  ];
  return (
    <div className="max-w-2xl mx-auto">
      <div className="flex items-start gap-4 mb-8 animate-result-enter">
        <span className="relative grid h-12 w-12 shrink-0 place-items-center">
          {/* one-shot ripple behind the icon; invisible when motion is reduced */}
          <span
            className="absolute inset-0 rounded-full bg-error/30 opacity-0 animate-status-ring"
            aria-hidden="true"
          />
          <span className="relative grid h-12 w-12 place-items-center rounded-full bg-error/10 text-error animate-result-icon">
            <WarningIcon className="h-6 w-6" />
          </span>
        </span>
        <div>
          <h2 className="text-3xl font-medium tracking-tight text-base-content">
            {t('error.title')}
          </h2>
          <p className="mt-2 text-base-content/70">{t('error.subtitle')}</p>
        </div>
      </div>

      <ul className="divide-y divide-base-300 border-t border-base-300">
        {reasons.map(({ Icon, chip, title, text }, i) => (
          <li
            key={i}
            className="flex items-start gap-4 py-5 animate-result-enter"
            style={{ animationDelay: `${150 + i * 120}ms` }}
          >
            <span
              className={`grid h-10 w-10 shrink-0 place-items-center rounded-field ${chip}`}
            >
              <Icon className="h-5 w-5" />
            </span>
            <div>
              <h3 className="font-semibold text-base-content">{title}</h3>
              {text.map((line, j) => (
                <p
                  key={j}
                  className="mt-1 text-sm text-base-content/70 leading-relaxed"
                >
                  {line}
                </p>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
