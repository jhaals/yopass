import React, { createContext, useContext } from "react";
import { useAsync } from "react-use";
import { backendDomain } from "./utils";

interface Config {
  DISABLE_UPLOAD: boolean;
  DISABLE_FEATURES: boolean;
  PREFETCH_SECRET: boolean;
}

const ConfigContext = createContext<Config | undefined>(undefined);

export const ConfigProvider = ({ children }: { children: React.ReactNode }) => {
  const defaultConfig = {
    DISABLE_UPLOAD: false,
    DISABLE_FEATURES: true,
    PREFETCH_SECRET: true,
  };

  // Module-level cache to avoid duplicate network requests (e.g., React StrictMode)
  // Shared across renders so the same in-flight promise is reused.
  type GlobalWithCache = typeof globalThis & {
    __yopassConfigCache?: Config | null;
    __yopassConfigPromise?: Promise<Config> | null;
  };
  const g = globalThis as GlobalWithCache;
  let configCache: Config | null = g.__yopassConfigCache || null;
  let configPromise: Promise<Config> | null = g.__yopassConfigPromise || null;

  const loadConfig = async (): Promise<Config> => {
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
  };

  const { value: config, loading } = useAsync(loadConfig, []);

  if (loading) {
    return null;
  }

  return (
    <ConfigContext.Provider value={config || defaultConfig}>
      {children}
    </ConfigContext.Provider>
  );
};

export const useConfig = () => {
  const context = useContext(ConfigContext);
  if (!context) {
    throw new Error("useConfig must be used within a ConfigProvider");
  }
  return context;
};
