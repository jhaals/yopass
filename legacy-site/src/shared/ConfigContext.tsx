import React, { createContext, useContext } from 'react';
import { useAsync } from 'react-use';
import { backendDomain } from '../utils/utils';

interface Config {
  DISABLE_UPLOAD: boolean;
}

const ConfigContext = createContext<Config | undefined>(undefined);

export const ConfigProvider = ({ children }: { children: React.ReactNode }) => {
  const defaultConfig = { DISABLE_UPLOAD: false };

  const { value: config, loading } = useAsync(async () => {
    try {
      const response = await fetch(`${backendDomain}/config`);
      if (!response.ok) {
        throw new Error(`Failed to fetch config: ${response.statusText}`);
      }
      const data = await response.json();
      if (typeof data !== 'object' || data === null) {
        throw new Error('Invalid config response format');
      }
      if (typeof data.DISABLE_UPLOAD !== 'boolean') {
        throw new Error('DISABLE_UPLOAD must be a boolean');
      }
      return { DISABLE_UPLOAD: data.DISABLE_UPLOAD };
    } catch (err) {
      console.error('Error loading config using default config:', err);
      return defaultConfig;
    }
  }, []);

  if (loading) return null;

  return (
    <ConfigContext.Provider value={config || defaultConfig}>
      {children}
    </ConfigContext.Provider>
  );
};

export const useConfig = () => {
  const context = useContext(ConfigContext);
  if (!context) {
    throw new Error('useConfig must be used within a ConfigProvider');
  }
  return context;
};
