import { backendDomain } from "./utils";

export interface Config {
  DISABLE_UPLOAD: boolean;
  DISABLE_FEATURES: boolean;
  PREFETCH_SECRET: boolean;
}

const defaultConfig: Config = {
  DISABLE_UPLOAD: false,
  DISABLE_FEATURES: true,
  PREFETCH_SECRET: true,
};

type GlobalWithCache = typeof globalThis & {
  __yopassConfigCache?: Config | null;
  __yopassConfigPromise?: Promise<Config> | null;
};

const g = globalThis as GlobalWithCache;
let configCache: Config | null = g.__yopassConfigCache || null;
let configPromise: Promise<Config> | null = g.__yopassConfigPromise || null;

export async function loadConfig(): Promise<Config> {
  if (configCache) {
    return configCache;
  }
  if (configPromise) {
    return configPromise;
  }
  configPromise = (async () => {
    try {
      const response = await fetch(`${backendDomain}/config`);
      if (!response.ok) {
        throw new Error(`Failed to fetch config: ${response.statusText}`);
      }
      const data = await response.json();
      if (typeof data !== "object" || data === null) {
        throw new Error("Invalid config response format");
      }
      if (typeof data.DISABLE_UPLOAD !== "boolean") {
        throw new Error("DISABLE_UPLOAD must be a boolean");
      }
      const parsed: Config = {
        DISABLE_UPLOAD: data.DISABLE_UPLOAD,
        DISABLE_FEATURES: data.DISABLE_FEATURES,
        PREFETCH_SECRET: data.PREFETCH_SECRET,
      };
      configCache = parsed;
      g.__yopassConfigCache = parsed;
      return parsed;
    } catch (err) {
      console.error("Error loading config using default config:", err);
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
