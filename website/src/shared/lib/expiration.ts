import type { Config } from './config';

export const expirationPresets = [3600, 86400, 604800];

// Custom selections retain an absolute deadline while forms are being edited.
// The API still receives only a relative lifetime in whole seconds.
export function expirationSeconds(value: string, now = Date.now()): number {
  if (/^at:\d+$/.test(value)) {
    const timestamp = Number(value.slice(3));
    if (
      !Number.isSafeInteger(timestamp) ||
      !Number.isFinite(new Date(timestamp).getTime())
    )
      return 0;
    return Math.floor(timestamp / 1000) - Math.floor(now / 1000);
  }
  return /^\d+$/.test(value) ? Number(value) : 0;
}

export function localDateTime(timestamp: number): string {
  const date = new Date(timestamp);
  function pad(number: number) {
    return String(number).padStart(2, '0');
  }
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function dateTimeExpiration(
  value: string,
  config?: Config,
  now = Date.now(),
): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return '';
  const timestamp = new Date(value).getTime();
  // Reject impossible dates and local times skipped by daylight saving changes.
  if (!Number.isFinite(timestamp) || localDateTime(timestamp) !== value)
    return '';
  if (config) {
    const minimum = (Math.floor(now / 1000) + config.MIN_EXPIRATION) * 1000;
    const maximum = (Math.floor(now / 1000) + config.MAX_EXPIRATION) * 1000;
    // A minute-only selection represents that minute. If its start falls
    // below the minimum, use the earliest permitted second within that minute.
    const deadline = Math.max(timestamp, minimum);
    if (deadline <= maximum && deadline < timestamp + 60000)
      return `at:${deadline}`;
  }
  return `at:${timestamp}`;
}

export function initialExpiration(config: Config, now = Date.now()): string {
  const seconds = config.FORCE_EXPIRATION ?? config.DEFAULT_EXPIRY ?? 3600;
  if (
    config.ALLOW_CUSTOM_EXPIRATION &&
    config.FORCE_EXPIRATION === undefined &&
    !expirationPresets.includes(seconds)
  ) {
    // A window narrower than one minute cannot offer a stable minute-only
    // deadline. Use a relative duration selector for these policies.
    if (config.MAX_EXPIRATION - config.MIN_EXPIRATION < 60)
      return String(seconds);
    const minimum =
      Math.ceil((now + config.MIN_EXPIRATION * 1000) / 60000) * 60000;
    const maximum =
      Math.floor((now + config.MAX_EXPIRATION * 1000) / 60000) * 60000;
    const deadline = Math.floor((now + seconds * 1000) / 60000) * 60000;
    return `at:${Math.min(maximum, Math.max(minimum, deadline))}`;
  }
  return String(seconds);
}

export function validExpiration(
  value: string,
  config: Config,
  now = Date.now(),
): boolean {
  if (
    value.startsWith('at:') &&
    (!config.ALLOW_CUSTOM_EXPIRATION || config.FORCE_EXPIRATION !== undefined)
  )
    return false;
  const seconds = expirationSeconds(value, now);
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 2147483647)
    return false;
  if (
    config.FORCE_EXPIRATION !== undefined &&
    seconds !== config.FORCE_EXPIRATION
  )
    return false;
  return config.ALLOW_CUSTOM_EXPIRATION
    ? seconds >= config.MIN_EXPIRATION && seconds <= config.MAX_EXPIRATION
    : expirationPresets.includes(seconds);
}

// Validation and conversion must use the same clock snapshot, including at
// the minimum lifetime where a second boundary could otherwise change the TTL.
export function expirationForSubmission(
  value: string,
  config: Config,
  now = Date.now(),
): number | undefined {
  return validExpiration(value, config, now)
    ? expirationSeconds(value, now)
    : undefined;
}

export function durationParts(seconds: number): {
  amount: string;
  unit: number;
} {
  for (const unit of [86400, 3600, 60, 1]) {
    if (seconds % unit === 0) return { amount: String(seconds / unit), unit };
  }
  return { amount: '', unit: 60 };
}
