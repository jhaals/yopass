import 'dotenv/config';

import react from '@vitejs/plugin-react';
import { defineConfig, UserConfigExport } from 'vite';

export default defineConfig(() => {
  const PUBLIC_URL = process.env.PUBLIC_URL || '';

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
        REACT_APP_BACKEND_URL: process.env.REACT_APP_BACKEND_URL,
        REACT_APP_FALLBACK_LANGUAGE: process.env.REACT_APP_FALLBACK_LANGUAGE,
        START_SERVER_AND_TEST_INSECURE:
          process.env.START_SERVER_AND_TEST_INSECURE,
        YOPASS_DISABLE_FEATURES_CARDS:
          process.env.YOPASS_DISABLE_FEATURES_CARDS,
        YOPASS_DISABLE_ONE_CLICK_LINK:
          process.env.YOPASS_DISABLE_ONE_CLICK_LINK,
      },
    },
    server: {
      port: 3000,
    },
  };

  return config;
});
