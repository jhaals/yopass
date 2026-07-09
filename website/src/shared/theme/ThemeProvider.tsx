/* eslint-disable react-refresh/only-export-components */
import React, { createContext, useContext, useEffect, useState } from 'react';
import { useConfig } from '../hooks/useConfig';
import {
  type LogicalTheme,
  getInitialLogicalTheme,
  THEME_STORAGE_KEY,
} from './theme';

interface ThemeContextValue {
  mode: LogicalTheme;
  toggleTheme: () => void;
  setTheme: (mode: LogicalTheme) => void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}

// injectCustomThemeStyle layers a handful of custom `--color-*` overrides on top
// of an existing DaisyUI base theme. The overrides are scoped to the base
// theme's own `data-theme` selector so all of the base theme's other variables
// (background, text, etc.) keep applying — only the listed tokens change. A
// `:root` prefix raises specificity above DaisyUI's plain `[data-theme=…]` rule
// so the overrides win regardless of stylesheet source order.
//
// `baseTheme` comes from the untrusted `/config` response, so it is escaped with
// `CSS.escape` before being interpolated into the selector; the variable values
// are already sanitised by `asThemeVars` in ConfigContext.
function injectCustomThemeStyle(
  slot: 'light' | 'dark',
  baseTheme: string,
  vars: Record<string, string> | undefined,
) {
  const styleId = `yopass-theme-${slot}`;
  document.getElementById(styleId)?.remove();
  if (!vars) return;
  const css = Object.entries(vars)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join('\n');
  const style = document.createElement('style');
  style.id = styleId;
  style.textContent = `:root[data-theme="${CSS.escape(baseTheme)}"] {\n${css}\n}`;
  document.head.appendChild(style);
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const {
    THEME_LIGHT,
    THEME_DARK,
    THEME_CUSTOM_LIGHT,
    THEME_CUSTOM_DARK,
    APP_NAME,
  } = useConfig();
  const [mode, setMode] = useState<LogicalTheme>(getInitialLogicalTheme);

  useEffect(() => {
    injectCustomThemeStyle('light', THEME_LIGHT, THEME_CUSTOM_LIGHT);
    injectCustomThemeStyle('dark', THEME_DARK, THEME_CUSTOM_DARK);
  }, [THEME_LIGHT, THEME_DARK, THEME_CUSTOM_LIGHT, THEME_CUSTOM_DARK]);

  useEffect(() => {
    const daisyTheme = mode === 'dark' ? THEME_DARK : THEME_LIGHT;
    document.documentElement.setAttribute('data-theme', daisyTheme);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, mode);
    } catch {
      void 0;
    }
  }, [mode, THEME_LIGHT, THEME_DARK]);

  useEffect(() => {
    if (APP_NAME) document.title = APP_NAME;
  }, [APP_NAME]);

  function toggleTheme() {
    setMode(prev => (prev === 'dark' ? 'light' : 'dark'));
  }

  return (
    <ThemeContext.Provider value={{ mode, toggleTheme, setTheme: setMode }}>
      {children}
    </ThemeContext.Provider>
  );
}
