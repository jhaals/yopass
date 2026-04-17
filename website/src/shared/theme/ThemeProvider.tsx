/* eslint-disable react-refresh/only-export-components */
import React, { createContext, useContext, useEffect, useState } from 'react';
import { useConfig } from '../hooks/useConfig';
import {
  type LogicalTheme,
  getInitialLogicalTheme,
  THEME_STORAGE_KEY,
  CUSTOM_LIGHT_THEME_NAME,
  CUSTOM_DARK_THEME_NAME,
} from './theme';

interface ThemeContextValue {
  mode: LogicalTheme;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}

function injectCustomThemeStyle(
  name: string,
  vars: Record<string, string> | undefined,
) {
  const styleId = `yopass-theme-${name}`;
  document.getElementById(styleId)?.remove();
  if (!vars) return;
  const css = Object.entries(vars)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join('\n');
  const style = document.createElement('style');
  style.id = styleId;
  style.textContent = `[data-theme="${name}"] {\n${css}\n}`;
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

  const lightName = THEME_CUSTOM_LIGHT ? CUSTOM_LIGHT_THEME_NAME : THEME_LIGHT;
  const darkName = THEME_CUSTOM_DARK ? CUSTOM_DARK_THEME_NAME : THEME_DARK;

  useEffect(() => {
    injectCustomThemeStyle(CUSTOM_LIGHT_THEME_NAME, THEME_CUSTOM_LIGHT);
    injectCustomThemeStyle(CUSTOM_DARK_THEME_NAME, THEME_CUSTOM_DARK);
  }, [THEME_CUSTOM_LIGHT, THEME_CUSTOM_DARK]);

  useEffect(() => {
    const daisyTheme = mode === 'dark' ? darkName : lightName;
    document.documentElement.setAttribute('data-theme', daisyTheme);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, mode);
    } catch {
      void 0;
    }
  }, [mode, lightName, darkName]);

  useEffect(() => {
    if (APP_NAME) document.title = APP_NAME;
  }, [APP_NAME]);

  function toggleTheme() {
    setMode(prev => (prev === 'dark' ? 'light' : 'dark'));
  }

  return (
    <ThemeContext.Provider value={{ mode, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}
