import { useEffect, type ReactNode } from 'react';
import { useAsync } from 'react-use';
import { ConfigContext } from './configContext';
import { backendDomain } from '@shared/lib/api';
import { defaultConfig, parseConfig, type Config } from '@shared/lib/config';

// Share one bootstrap request across providers and React StrictMode mounts.
let configPromise: Promise<Config> | undefined;

function loadConfig(): Promise<Config> {
  configPromise ??= fetch(`${backendDomain}/config`)
    .then(async response => {
      if (!response.ok)
        throw new Error(`Failed to fetch config: ${response.status}`);
      return parseConfig(await response.json());
    })
    .catch(error => {
      console.error('Error loading config using default config:', error);
      return defaultConfig;
    });
  return configPromise;
}

export function ConfigProvider({ children }: { children: ReactNode }) {
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
    <ConfigContext.Provider value={config ?? defaultConfig}>
      {children}
    </ConfigContext.Provider>
  );
}
