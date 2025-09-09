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
        manualChunks: {
          // Separate large crypto library
          crypto: ['openpgp'],
          // Separate React ecosystem
          react: ['react', 'react-dom'],
          // Separate router
          router: ['react-router-dom'],
          // Separate i18n libraries
          i18n: [
            'i18next',
            'react-i18next',
            'i18next-browser-languagedetector',
          ],
          // Separate UI components
          ui: ['react-qr-code', 'react-hook-form', 'react-use'],
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
