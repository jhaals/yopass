import React, { createContext, useContext } from 'react';
import { useAsync } from 'react-use';
import { backendDomain } from '../utils/utils';

interface Config {
  DISABLE_UPLOAD: boolean;
}

const ConfigContext = createContext<Config | undefined>(undefined);

export const ConfigProvider = ({ children }: { children: React.ReactNode }) => {
  const {
    value: config,
    loading,
    error,
  } = useAsync(async () => {
    const response = await fetch(`${backendDomain}/config`);
    const data = await response.json();
    return { DISABLE_UPLOAD: data.DISABLE_UPLOAD };
  }, []);

  if (loading) return null;
  if (error || !config) {
    console.error('Error loading config:', error);
    return null;
  }

  return (
    <ConfigContext.Provider value={{ DISABLE_UPLOAD: config.DISABLE_UPLOAD }}>
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
