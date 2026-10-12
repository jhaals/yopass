import { useTranslation } from 'react-i18next';
import { durationParts, expirationPresets } from '@shared/lib/expiration';

// Returns a formatter for secret lifetimes: preset durations use their
// option label ("1 hour"), anything else a localized unit ("90 minutes").
export function useFormatDuration() {
  const { t, i18n } = useTranslation();
  const labels = [
    t('expiration.optionOneHourLabel'),
    t('expiration.optionOneDayLabel'),
    t('expiration.optionOneWeekLabel'),
  ];
  return function formatDuration(seconds: number) {
    const preset = expirationPresets.indexOf(seconds);
    if (preset >= 0) return labels[preset].toLowerCase();
    const parts = durationParts(seconds);
    return new Intl.NumberFormat(i18n.language, {
      style: 'unit',
      unit: (
        { 1: 'second', 60: 'minute', 3600: 'hour', 86400: 'day' } as Record<
          number,
          string
        >
      )[parts.unit],
      unitDisplay: 'long',
    }).format(Number(parts.amount));
  };
}
