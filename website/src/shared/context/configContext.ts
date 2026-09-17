import { createContext } from 'react';
import type { Config } from '@shared/lib/config';

export const ConfigContext = createContext<Config | undefined>(undefined);
