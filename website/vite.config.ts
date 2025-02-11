import 'dotenv/config';

import react from '@vitejs/plugin-react';
import { defineConfig, UserConfigExport } from 'vite';

export default defineConfig(() => {
  // Ensure PUBLIC_URL is not an empty string, otherwise vite base url is
  // relative to currently accessed path instead of '/'
  const PUBLIC_URL = process.env.PUBLIC_URL || undefined;
  const ROUTER_TYPE = process.env.ROUTER_TYPE === 'history' ? 'history' : 'hash';

  const config: UserConfigExport = {
    plugins: [react()],
    base: PUBLIC_URL,
    build: {
      outDir: './build',
      sourcemap: true,
    },
    define: {
      /*
       * Attention:
       * Only non-sensitive values should be included in this object.
       * These values WILL make it into public JS files as part of the process.env object.
       * DO NOT put anything sensitive here or spread any object like (...process.env) to expose all values at once.
       */
      'process.env': {
        CI: process.env.CI,
        NODE_ENV: process.env.NODE_ENV,
        PUBLIC_URL,
        ROUTER_TYPE,
        ROUTER_API: process.env.ROUTER_API === 'history' ,
        REACT_APP_BACKEND_URL: process.env.REACT_APP_BACKEND_URL,
        REACT_APP_FALLBACK_LANGUAGE: process.env.REACT_APP_FALLBACK_LANGUAGE,
        START_SERVER_AND_TEST_INSECURE:
          process.env.START_SERVER_AND_TEST_INSECURE,
      },
    },
    server: {
      port: 3000,
    },
  };

  return config;
});
