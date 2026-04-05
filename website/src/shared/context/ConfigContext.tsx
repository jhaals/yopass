import React, { useEffect } from 'react';
import { useAsync } from 'react-use';
import { ConfigContext } from '@shared/hooks/useConfig';
import { backendDomain } from '@shared/lib/api';

export interface Config {
  DISABLE_UPLOAD: boolean;
  READ_ONLY: boolean;
  DISABLE_FEATURES: boolean;
  PREFETCH_SECRET: boolean;
  NO_LANGUAGE_SWITCHER: boolean;
  FORCE_ONETIME_SECRETS: boolean;
  MAX_FILE_SIZE?: string;
  DEFAULT_EXPIRY?: number;
  PRIVACY_NOTICE_URL?: string;
  IMPRINT_URL?: string;
  THEME_LIGHT: string;
  THEME_DARK: string;
  THEME_CUSTOM_LIGHT?: Record<string, string>;
  THEME_CUSTOM_DARK?: Record<string, string>;
  APP_NAME?: string;
  LOGO_URL?: string;
  OIDC_ENABLED: boolean;
  REQUIRE_AUTH: boolean;
}

const defaultConfig: Config = {
  DISABLE_UPLOAD: false,
  READ_ONLY: false,
  DISABLE_FEATURES: true,
  PREFETCH_SECRET: true,
  NO_LANGUAGE_SWITCHER: false,
  FORCE_ONETIME_SECRETS: false,
  THEME_LIGHT: 'emerald',
  THEME_DARK: 'dim',
  OIDC_ENABLED: false,
  REQUIRE_AUTH: false,
};

type GlobalWithCache = typeof globalThis & {
  __yopassConfigCache?: Config | null;
  __yopassConfigPromise?: Promise<Config> | null;
};

const g = globalThis as GlobalWithCache;
let configCache: Config | null = g.__yopassConfigCache || null;
let configPromise: Promise<Config> | null = g.__yopassConfigPromise || null;

async function loadConfig(): Promise<Config> {
  if (configCache) return configCache;
  if (configPromise) return configPromise;
  configPromise = (async () => {
    try {
      const response = await fetch(`${backendDomain}/config`);
      if (!response.ok) {
        throw new Error(`Failed to fetch config: ${response.statusText}`);
      }
      const data = await response.json();
      if (typeof data !== 'object' || data === null) {
        throw new Error('Invalid config response format');
      }
      const parsed: Config = {
        DISABLE_UPLOAD:
          typeof data.DISABLE_UPLOAD === 'boolean'
            ? data.DISABLE_UPLOAD
            : defaultConfig.DISABLE_UPLOAD,
        READ_ONLY:
          typeof data.READ_ONLY === 'boolean'
            ? data.READ_ONLY
            : defaultConfig.READ_ONLY,
        DISABLE_FEATURES:
          typeof data.DISABLE_FEATURES === 'boolean'
            ? data.DISABLE_FEATURES
            : defaultConfig.DISABLE_FEATURES,
        PREFETCH_SECRET:
          typeof data.PREFETCH_SECRET === 'boolean'
            ? data.PREFETCH_SECRET
            : defaultConfig.PREFETCH_SECRET,
        NO_LANGUAGE_SWITCHER:
          typeof data.NO_LANGUAGE_SWITCHER === 'boolean'
            ? data.NO_LANGUAGE_SWITCHER
            : defaultConfig.NO_LANGUAGE_SWITCHER,
        FORCE_ONETIME_SECRETS:
          typeof data.FORCE_ONETIME_SECRETS === 'boolean'
            ? data.FORCE_ONETIME_SECRETS
            : defaultConfig.FORCE_ONETIME_SECRETS,
        MAX_FILE_SIZE: data.MAX_FILE_SIZE,
        DEFAULT_EXPIRY: data.DEFAULT_EXPIRY,
        PRIVACY_NOTICE_URL: data.PRIVACY_NOTICE_URL,
        IMPRINT_URL: data.IMPRINT_URL,
        THEME_LIGHT:
          typeof data.THEME_LIGHT === 'string' && data.THEME_LIGHT
            ? data.THEME_LIGHT
            : defaultConfig.THEME_LIGHT,
        THEME_DARK:
          typeof data.THEME_DARK === 'string' && data.THEME_DARK
            ? data.THEME_DARK
            : defaultConfig.THEME_DARK,
        THEME_CUSTOM_LIGHT:
          data.THEME_CUSTOM_LIGHT &&
          typeof data.THEME_CUSTOM_LIGHT === 'object' &&
          !Array.isArray(data.THEME_CUSTOM_LIGHT)
            ? (data.THEME_CUSTOM_LIGHT as Record<string, string>)
            : undefined,
        THEME_CUSTOM_DARK:
          data.THEME_CUSTOM_DARK &&
          typeof data.THEME_CUSTOM_DARK === 'object' &&
          !Array.isArray(data.THEME_CUSTOM_DARK)
            ? (data.THEME_CUSTOM_DARK as Record<string, string>)
            : undefined,
        APP_NAME:
          typeof data.APP_NAME === 'string' && data.APP_NAME
            ? data.APP_NAME
            : undefined,
        LOGO_URL:
          typeof data.LOGO_URL === 'string' && data.LOGO_URL
            ? data.LOGO_URL
            : undefined,
        OIDC_ENABLED:
          typeof data.OIDC_ENABLED === 'boolean' ? data.OIDC_ENABLED : false,
        REQUIRE_AUTH:
          typeof data.REQUIRE_AUTH === 'boolean' ? data.REQUIRE_AUTH : false,
      };
      configCache = parsed;
      g.__yopassConfigCache = parsed;
      return parsed;
    } catch (err) {
      console.error('Error loading config using default config:', err);
      configCache = defaultConfig;
      g.__yopassConfigCache = defaultConfig;
      return defaultConfig;
    } finally {
      g.__yopassConfigPromise = null;
      configPromise = null;
    }
  })();
  g.__yopassConfigPromise = configPromise;
  return configPromise;
}

export function ConfigProvider({ children }: { children: React.ReactNode }) {
  const { value: config, loading } = useAsync(loadConfig, []);

  useEffect(() => {
    if (config?.LOGO_URL) {
      const favicon =
        document.querySelector<HTMLLinkElement>('link[rel="icon"]');
      if (favicon) favicon.href = config.LOGO_URL;
    }
  }, [config?.LOGO_URL]);

  if (loading) return null;
  return (
    <ConfigContext.Provider value={config || defaultConfig}>
      {children}
    </ConfigContext.Provider>
  );
}
