// User preference for how dates and timestamps are rendered in the UI.
// ISO 8601 (local time) is the default; the browser locale format is opt-in.

export type DateFormat = 'iso' | 'locale';

const STORAGE_KEY = 'yopass-date-format';

// Fired on window whenever the preference changes, so all components showing
// dates re-render with the new format.
export const DATE_FORMAT_CHANGED_EVENT = 'yopass-date-format-changed';

export function getDateFormat(): DateFormat {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'locale' ? 'locale' : 'iso';
  } catch {
    return 'iso';
  }
}

export function setDateFormat(format: DateFormat) {
  localStorage.setItem(STORAGE_KEY, format);
  window.dispatchEvent(new Event(DATE_FORMAT_CHANGED_EVENT));
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

// formatDateTime renders an epoch-seconds timestamp in the given format.
// ISO output uses the local timezone: "2026-06-12 13:37".
export function formatDateTime(
  epochSeconds: number,
  format: DateFormat,
): string {
  const d = new Date(epochSeconds * 1000);
  if (format === 'locale') {
    return d.toLocaleString();
  }
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}
