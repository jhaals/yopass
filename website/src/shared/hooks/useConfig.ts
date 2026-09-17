import { useContext } from 'react';
import { ConfigContext } from '@shared/context/configContext';
import type { Config } from '@shared/lib/config';

export function useConfig(): Config {
  const context = useContext(ConfigContext);
  if (!context) {
    throw new Error('useConfig must be used within a ConfigProvider');
  }
  return context;
}
