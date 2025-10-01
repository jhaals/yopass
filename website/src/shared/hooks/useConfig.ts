import { createContext, useContext } from 'react';
import type { Config } from '@shared/context/ConfigContext';

export const ConfigContext = createContext<Config | undefined>(undefined);

export function useConfig(): Config {
  const context = useContext(ConfigContext);
  if (!context) {
    throw new Error('useConfig must be used within a ConfigProvider');
  }
  return context;
}
