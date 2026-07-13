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
  HIDE_ONECLICK_LINK: boolean;
  MAX_FILE_SIZE?: string;
  DEFAULT_EXPIRY?: number;
  FORCE_EXPIRATION?: number;
  PRIVACY_NOTICE_URL?: string;
  IMPRINT_URL?: string;
  THEME_LIGHT: string;
  THEME_DARK: string;
  THEME_CUSTOM_LIGHT?: Record<string, string>;
  THEME_CUSTOM_DARK?: Record<string, string>;
  APP_NAME?: string;
  LOGO_URL?: string;
  PUBLIC_URL?: string;
  OIDC_ENABLED: boolean;
  REQUIRE_AUTH: boolean;
  SECRET_REQUESTS: boolean;
  READ_RECEIPTS: boolean;
  ARGON2: boolean;
}

const defaultConfig: Config = {
  DISABLE_UPLOAD: false,
  READ_ONLY: false,
  DISABLE_FEATURES: true,
  PREFETCH_SECRET: true,
  NO_LANGUAGE_SWITCHER: false,
  FORCE_ONETIME_SECRETS: false,
  HIDE_ONECLICK_LINK: false,
  THEME_LIGHT: 'emerald',
  THEME_DARK: 'dim',
  OIDC_ENABLED: false,
  REQUIRE_AUTH: false,
  SECRET_REQUESTS: false,
  READ_RECEIPTS: false,
  ARGON2: false,
};

type GlobalWithCache = typeof globalThis & {
  __yopassConfigCache?: Config | null;
  __yopassConfigPromise?: Promise<Config> | null;
};

const g = globalThis as GlobalWithCache;
let configCache: Config | null = g.__yopassConfigCache || null;
let configPromise: Promise<Config> | null = g.__yopassConfigPromise || null;

// Type-coercion helpers for the untrusted /config response: each returns the
// value only when it has the expected shape, otherwise the fallback.
function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

// asThemeVars coerces an untrusted /config value into a map of CSS custom
// properties. Only string entries whose key is a `--`-prefixed custom property
// are kept, and neither key nor value may contain characters that could break
// out of the injected style rule, so a hostile /config cannot inject CSS.
function asThemeVars(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const unsafe = /[;{}<>]/;
  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (
      key.startsWith('--') &&
      !unsafe.test(key) &&
      typeof val === 'string' &&
      !unsafe.test(val)
    ) {
      result[key] = val;
    }
  }
  return Object.keys(result).length ? result : undefined;
}

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
        DISABLE_UPLOAD: asBool(
          data.DISABLE_UPLOAD,
          defaultConfig.DISABLE_UPLOAD,
        ),
        READ_ONLY: asBool(data.READ_ONLY, defaultConfig.READ_ONLY),
        DISABLE_FEATURES: asBool(
          data.DISABLE_FEATURES,
          defaultConfig.DISABLE_FEATURES,
        ),
        PREFETCH_SECRET: asBool(
          data.PREFETCH_SECRET,
          defaultConfig.PREFETCH_SECRET,
        ),
        NO_LANGUAGE_SWITCHER: asBool(
          data.NO_LANGUAGE_SWITCHER,
          defaultConfig.NO_LANGUAGE_SWITCHER,
        ),
        FORCE_ONETIME_SECRETS: asBool(
          data.FORCE_ONETIME_SECRETS,
          defaultConfig.FORCE_ONETIME_SECRETS,
        ),
        HIDE_ONECLICK_LINK: asBool(
          data.HIDE_ONECLICK_LINK,
          defaultConfig.HIDE_ONECLICK_LINK,
        ),
        MAX_FILE_SIZE: data.MAX_FILE_SIZE,
        DEFAULT_EXPIRY: data.DEFAULT_EXPIRY,
        FORCE_EXPIRATION:
          typeof data.FORCE_EXPIRATION === 'number'
            ? data.FORCE_EXPIRATION
            : undefined,
        PRIVACY_NOTICE_URL: data.PRIVACY_NOTICE_URL,
        IMPRINT_URL: data.IMPRINT_URL,
        THEME_LIGHT: asString(data.THEME_LIGHT) ?? defaultConfig.THEME_LIGHT,
        THEME_DARK: asString(data.THEME_DARK) ?? defaultConfig.THEME_DARK,
        THEME_CUSTOM_LIGHT: asThemeVars(data.THEME_CUSTOM_LIGHT),
        THEME_CUSTOM_DARK: asThemeVars(data.THEME_CUSTOM_DARK),
        APP_NAME: asString(data.APP_NAME),
        LOGO_URL: asString(data.LOGO_URL),
        PUBLIC_URL: asString(data.PUBLIC_URL),
        OIDC_ENABLED: asBool(data.OIDC_ENABLED, false),
        REQUIRE_AUTH: asBool(data.REQUIRE_AUTH, false),
        SECRET_REQUESTS: asBool(data.SECRET_REQUESTS, false),
        READ_RECEIPTS: asBool(data.READ_RECEIPTS, false),
        ARGON2: asBool(data.ARGON2, false),
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
