// Keep storage access and same-tab notifications consistent across local stores.
// Reads tolerate unavailable/corrupt storage. Writes deliberately propagate errors
// so callers never mistake an unsaved private key for a persisted request.
export function readStoredList<T>(
  key: string,
  validate: (value: unknown) => value is T,
): T[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter(validate) : [];
  } catch {
    return [];
  }
}

export function writeStoredList<T>(key: string, event: string, items: T[]) {
  localStorage.setItem(key, JSON.stringify(items));
  window.dispatchEvent(new Event(event));
}
