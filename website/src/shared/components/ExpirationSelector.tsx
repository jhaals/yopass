import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { flushSync } from 'react-dom';
import { useConfig } from '@shared/hooks/useConfig';
import {
  dateTimeExpiration,
  localDateTime,
  durationParts,
  expirationPresets,
  validExpiration,
} from '@shared/lib/expiration';

interface Props {
  value: string;
  onChange: (value: string) => void;
  legend?: string;
}

export function ExpirationSelector({ value, onChange, legend }: Props) {
  const config = useConfig();
  const { t, i18n } = useTranslation();
  const id = useId();
  const pickerRef = useRef<HTMLInputElement>(null);
  const hasCustomDeadline = useRef(value.startsWith('at:'));
  const [now, setNow] = useState(Date.now);
  const [custom, setCustom] = useState(
    value.startsWith('at:') || !expirationPresets.includes(Number(value)),
  );
  const [dateTime, setDateTime] = useState(() =>
    localDateTime(
      value.startsWith('at:')
        ? Number(value.slice(3))
        : (Math.floor(Date.now() / 1000) + Number(value)) * 1000,
    ),
  );
  useEffect(() => {
    if (!custom || !config.ALLOW_CUSTOM_EXPIRATION) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [custom, config.ALLOW_CUSTOM_EXPIRATION]);
  const labels = [
    t('expiration.optionOneHourLabel'),
    t('expiration.optionOneDayLabel'),
    t('expiration.optionOneWeekLabel'),
  ];
  function formatDuration(seconds: number) {
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
  }
  if (config.FORCE_EXPIRATION !== undefined) {
    return (
      <p className="mt-6 text-sm font-medium">
        {t('expiration.forced', {
          expiration: formatDuration(config.FORCE_EXPIRATION),
        })}
      </p>
    );
  }
  const presets = expirationPresets.filter(
    seconds =>
      !config.ALLOW_CUSTOM_EXPIRATION ||
      (seconds >= config.MIN_EXPIRATION && seconds <= config.MAX_EXPIRATION),
  );
  const invalid = !validExpiration(value, config, now);
  const bounds = t('expiration.bounds', {
    min: formatDuration(config.MIN_EXPIRATION),
    max: formatDuration(config.MAX_EXPIRATION),
  });
  function update(nextDateTime: string) {
    hasCustomDeadline.current = true;
    setDateTime(nextDateTime);
    onChange(dateTimeExpiration(nextDateTime, config));
  }
  const narrowPolicy = config.MAX_EXPIRATION - config.MIN_EXPIRATION < 60;
  function selectCustom() {
    if (narrowPolicy) {
      setCustom(true);
      return;
    }
    // Relative presets start counting at submission. Seed the first custom
    // deadline from the current preset and time, then retain explicit choices.
    const nextDateTime = hasCustomDeadline.current
      ? dateTime
      : localDateTime((Math.floor(Date.now() / 1000) + Number(value)) * 1000);
    // Mount the input synchronously so showPicker runs within the user's click.
    flushSync(() => {
      setCustom(true);
      setNow(Date.now());
      update(nextDateTime);
    });
    const picker = pickerRef.current;
    picker?.focus();
    try {
      picker?.showPicker?.();
    } catch {
      // Browsers without picker support (or embedded restrictions) retain focus
      // so the date and time can still be entered directly.
    }
  }
  return (
    <fieldset className="form-control mt-6">
      <legend className="label-text font-semibold text-base">
        {legend || t('expiration.legend')}
      </legend>
      <div className="grid grid-cols-2 gap-2 mt-2 sm:grid-flow-col sm:auto-cols-fr sm:grid-cols-none">
        {presets.map(seconds => (
          <input
            key={seconds}
            type="radio"
            name={id}
            value={seconds}
            checked={!custom && Number(value) === seconds}
            onChange={() => {
              setCustom(false);
              onChange(String(seconds));
            }}
            aria-label={labels[expirationPresets.indexOf(seconds)]}
            className="btn min-h-11 h-auto py-2 px-3 text-sm checked:bg-primary checked:text-primary-content checked:border-primary"
          />
        ))}
        {config.ALLOW_CUSTOM_EXPIRATION && (
          <input
            type="radio"
            name={id}
            checked={custom}
            onClick={() => {
              if (custom) selectCustom();
            }}
            onChange={selectCustom}
            aria-label={t('expiration.custom')}
            className="btn min-h-11 h-auto py-2 px-3 text-sm checked:bg-primary checked:text-primary-content checked:border-primary"
          />
        )}
      </div>
      {config.ALLOW_CUSTOM_EXPIRATION && custom && narrowPolicy && (
        <div className="mt-3">
          <label
            htmlFor={`${id}-duration`}
            className="mb-2 block text-sm font-medium"
          >
            {t('expiration.custom')}
          </label>
          <select
            id={`${id}-duration`}
            value={value}
            onChange={e => onChange(e.target.value)}
            className="select w-full h-12 rounded-lg"
          >
            {Array.from(
              { length: config.MAX_EXPIRATION - config.MIN_EXPIRATION + 1 },
              (_, index) => config.MIN_EXPIRATION + index,
            ).map(seconds => (
              <option key={seconds} value={String(seconds)}>
                {formatDuration(seconds)}
              </option>
            ))}
          </select>
        </div>
      )}
      {config.ALLOW_CUSTOM_EXPIRATION && custom && !narrowPolicy && (
        <div className="mt-3">
          <label
            htmlFor={`${id}-datetime`}
            className="mb-2 block text-sm font-medium"
          >
            {t('expiration.dateTime')}
          </label>
          <input
            ref={pickerRef}
            id={`${id}-datetime`}
            type="datetime-local"
            step="60"
            required
            min={localDateTime(
              Math.floor((now + config.MIN_EXPIRATION * 1000) / 60000) * 60000,
            )}
            max={localDateTime(
              Math.floor((now + config.MAX_EXPIRATION * 1000) / 60000) * 60000,
            )}
            value={dateTime}
            onChange={e => update(e.target.value)}
            aria-invalid={invalid}
            aria-describedby={`${id}-hint ${id}-timezone`}
            className={`input w-full min-w-0 h-12 rounded-lg bg-base-200/40 text-base font-medium tabular-nums transition-colors focus:outline-2 focus:outline-offset-2 ${
              invalid
                ? 'border-error focus:outline-error'
                : 'border-base-content/25 hover:border-base-content/50 focus:border-primary focus:outline-primary'
            }`}
          />
          <p
            id={`${id}-timezone`}
            className="mt-2 text-sm text-base-content/75"
          >
            {t('expiration.timezone', {
              timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            })}
          </p>
          <p
            id={`${id}-hint`}
            className={`mt-2 text-sm ${invalid ? 'text-error' : 'text-base-content/75'}`}
            role={invalid ? 'alert' : undefined}
          >
            {invalid
              ? t('expiration.invalid', {
                  min: formatDuration(config.MIN_EXPIRATION),
                  max: formatDuration(config.MAX_EXPIRATION),
                })
              : bounds}
          </p>
        </div>
      )}
    </fieldset>
  );
}
