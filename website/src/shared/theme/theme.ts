export type LogicalTheme = 'light' | 'dark';

export const DEFAULT_LIGHT_THEME = 'emerald';
export const DEFAULT_DARK_THEME = 'dim';

export const THEME_STORAGE_KEY = 'themeMode';

export const CUSTOM_LIGHT_THEME_NAME = 'custom-light';
export const CUSTOM_DARK_THEME_NAME = 'custom-dark';

export function getInitialLogicalTheme(): LogicalTheme {
  try {
    const stored = localStorage.getItem(
      THEME_STORAGE_KEY,
    ) as LogicalTheme | null;
    if (stored === 'light' || stored === 'dark') {
      return stored;
    }
  } catch {
    // ignore and fall back to media query
  }
  const prefersDark =
    typeof window !== 'undefined' &&
    window.matchMedia &&
    window.matchMedia('(prefers-color-scheme: dark)').matches;
  return prefersDark ? 'dark' : 'light';
}
