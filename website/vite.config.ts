import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@app': '/src/app',
      '@features': '/src/features',
      '@shared': '/src/shared',
    },
  },
  server: {
    port: 3000,
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: (id) => {
        if (id.includes('node_modules/openpgp/')) return 'crypto';
        if (id.includes('node_modules/react-dom/') || id.includes('node_modules/react/')) return 'react';
        if (id.includes('node_modules/react-router-dom/')) return 'router';
        if (
          id.includes('node_modules/i18next/') ||
          id.includes('node_modules/react-i18next/') ||
          id.includes('node_modules/i18next-browser-languagedetector/')
        )
          return 'i18n';
        if (
          id.includes('node_modules/react-qr-code/') ||
          id.includes('node_modules/react-hook-form/') ||
          id.includes('node_modules/react-use/')
        )
          return 'ui';
      },
    },
    },
    chunkSizeWarningLimit: 600,
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
      YOPASS_BACKEND_URL: process.env.YOPASS_BACKEND_URL,
    },
  },
});
