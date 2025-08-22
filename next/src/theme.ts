export type LogicalTheme = "light" | "dark";

// Central mapping between logical modes and DaisyUI theme names
export const LIGHT_DAISY_THEME = "emerald"; // change here to switch light theme
export const DARK_DAISY_THEME = "dim"; // change here to switch dark theme

export const THEME_STORAGE_KEY = "themeMode"; // stores logical theme only

export function logicalToDaisyTheme(mode: LogicalTheme): string {
  return mode === "dark" ? DARK_DAISY_THEME : LIGHT_DAISY_THEME;
}

export function getInitialLogicalTheme(): LogicalTheme {
  try {
    const stored = localStorage.getItem(
      THEME_STORAGE_KEY
    ) as LogicalTheme | null;
    if (stored === "light" || stored === "dark") {
      return stored;
    }
  } catch {
    // ignore and fall back to media query
  }
  const prefersDark =
    typeof window !== "undefined" &&
    window.matchMedia &&
    window.matchMedia("(prefers-color-scheme: dark)").matches;
  return prefersDark ? "dark" : "light";
}
