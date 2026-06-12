import { useSyncExternalStore } from 'react';
import {
  DATE_FORMAT_CHANGED_EVENT,
  getDateFormat,
  setDateFormat,
  type DateFormat,
} from '@shared/lib/dateFormat';

function subscribe(onChange: () => void) {
  window.addEventListener(DATE_FORMAT_CHANGED_EVENT, onChange);
  // Also react to changes made in another tab.
  window.addEventListener('storage', onChange);
  return () => {
    window.removeEventListener(DATE_FORMAT_CHANGED_EVENT, onChange);
    window.removeEventListener('storage', onChange);
  };
}

// useDateFormat returns the current date format preference and a setter.
// Components re-render whenever the preference changes anywhere in the app.
export function useDateFormat(): [DateFormat, (format: DateFormat) => void] {
  const format = useSyncExternalStore(subscribe, getDateFormat);
  return [format, setDateFormat];
}
