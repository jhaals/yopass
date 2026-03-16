import React, { useEffect } from 'react';
import { useAsync } from 'react-use';
import { ConfigContext } from '@shared/hooks/useConfig';
import { backendDomain } from '@shared/lib/api';
import { hexToOklch } from '@shared/lib/hexToOklch';

export interface Config {
  DISABLE_UPLOAD: boolean;
  READ_ONLY: boolean;
  DISABLE_FEATURES: boolean;
  PREFETCH_SECRET: boolean;
  NO_LANGUAGE_SWITCHER: boolean;
  FORCE_ONETIME_SECRETS: boolean;
  DEFAULT_EXPIRY?: number;
  PRIVACY_NOTICE_URL?: string;
  IMPRINT_URL?: string;
  BRAND_TITLE?: string;
  BRAND_COLOR?: string;
  BRAND_LOGO?: string;
}

const defaultConfig: Config = {
  DISABLE_UPLOAD: false,
  READ_ONLY: false,
  DISABLE_FEATURES: true,
  PREFETCH_SECRET: true,
  NO_LANGUAGE_SWITCHER: false,
  FORCE_ONETIME_SECRETS: false,
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
        DEFAULT_EXPIRY: data.DEFAULT_EXPIRY,
        PRIVACY_NOTICE_URL: data.PRIVACY_NOTICE_URL,
        IMPRINT_URL: data.IMPRINT_URL,
        BRAND_TITLE: data.BRAND_TITLE,
        BRAND_COLOR: data.BRAND_COLOR,
        BRAND_LOGO: data.BRAND_LOGO,
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
    if (!config?.BRAND_COLOR) return;
    const oklch = hexToOklch(config.BRAND_COLOR);
    if (oklch) {
      document.documentElement.style.setProperty(
        '--color-primary',
        `oklch(${oklch})`,
      );
    }
  }, [config?.BRAND_COLOR]);

  if (loading) return null;
  return (
    <ConfigContext.Provider value={config || defaultConfig}>
      {children}
    </ConfigContext.Provider>
  );
}
