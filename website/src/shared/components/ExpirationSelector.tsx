import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { flushSync } from 'react-dom';
import { useConfig } from '@shared/hooks/useConfig';
import {
  dateTimeExpiration,
  localDateTime,
  expirationPresets,
  validExpiration,
} from '@shared/lib/expiration';
import { useFormatDuration } from '@shared/hooks/useFormatDuration';

interface Props {
  value: string;
  onChange: (value: string) => void;
  legend?: string;
}

export function ExpirationSelector({ value, onChange, legend }: Props) {
  const config = useConfig();
  const { t } = useTranslation();
  const formatDuration = useFormatDuration();
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
  if (config.FORCE_EXPIRATION !== undefined) {
    return (
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3.5">
        <div className="flex-1 text-[13.5px] font-semibold">
          {legend || t('expiration.legend')}
        </div>
        <p className="m-0 text-[13px] font-medium text-base-content/75">
          {t('expiration.forced', {
            expiration: formatDuration(config.FORCE_EXPIRATION),
          })}
        </p>
      </div>
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
  const options = presets.length + (config.ALLOW_CUSTOM_EXPIRATION ? 1 : 0);
  const selected = custom ? options - 1 : presets.indexOf(Number(value));
  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3.5">
        <div className="min-w-[160px] flex-1">
          <div id={`${id}-legend`} className="text-[13.5px] font-semibold">
            {legend || t('expiration.legend')}
          </div>
          <div className="mt-0.5 text-[12.5px] text-base-content/60">
            {t('expiration.hint')}
          </div>
        </div>
        <div
          role="radiogroup"
          aria-labelledby={`${id}-legend`}
          className="relative grid min-w-[246px] rounded-[10px] bg-base-200 p-[3px] max-sm:w-full"
          style={{ gridTemplateColumns: `repeat(${options}, minmax(0, 1fr))` }}
        >
          {selected >= 0 && <SegmentThumb index={selected} count={options} />}
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
              className="lv-segment px-3"
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
              className="lv-segment px-3"
            />
          )}
        </div>
      </div>
      {config.ALLOW_CUSTOM_EXPIRATION && custom && narrowPolicy && (
        <div className="px-4 pb-4 animate-lv-drop">
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
            className="select h-11 w-full rounded-[10px]"
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
        <div className="px-4 pb-4 animate-lv-drop">
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
            className={`input h-11 w-full min-w-0 rounded-[10px] bg-base-200/60 font-mono text-[13px] font-medium tabular-nums transition-colors focus:outline-2 focus:outline-offset-2 ${
              invalid
                ? 'border-error focus:outline-error'
                : 'border-base-content/20 hover:border-base-content/40 focus:border-(--lv-focus) focus:outline-(--lv-focus)'
            }`}
          />
          <p
            id={`${id}-timezone`}
            className="mt-2 text-[12.5px] text-base-content/60"
          >
            {t('expiration.timezone', {
              timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            })}
          </p>
          <p
            id={`${id}-hint`}
            className={`mt-1 text-[12.5px] ${invalid ? 'text-error' : 'text-base-content/60'}`}
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
    </div>
  );
}

// The white thumb of the segmented control. It glides to the chosen option
// and stretches toward the direction of travel, more for longer jumps.
function SegmentThumb({ index, count }: { index: number; count: number }) {
  const thumbRef = useRef<HTMLSpanElement>(null);
  const previous = useRef(index);
  useEffect(() => {
    const from = previous.current;
    previous.current = index;
    const el = thumbRef.current;
    if (from === index || !el?.animate) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    el.style.transformOrigin = index > from ? 'left center' : 'right center';
    const stretch = Math.abs(index - from) > 1 ? 1.22 : 1.12;
    el.animate(
      [
        { transform: 'scaleX(1)' },
        { transform: `scaleX(${stretch})`, offset: 0.32 },
        { transform: 'scaleX(1)' },
      ],
      { duration: 700, easing: 'ease-in-out' },
    );
  }, [index]);
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute top-[3px] left-[3px] h-[calc(100%-6px)] transition-transform duration-700 ease-[cubic-bezier(.22,1,.36,1)] motion-reduce:transition-none"
      style={{
        width: `calc((100% - 6px) / ${count})`,
        transform: `translateX(${index * 100}%)`,
      }}
    >
      <span
        ref={thumbRef}
        className="block size-full rounded-[7px] bg-base-100 shadow-[0_1px_2px_rgb(11_13_18/.12),0_3px_10px_rgb(11_13_18/.06)]"
      />
    </span>
  );
}
