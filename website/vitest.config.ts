import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@app': '/src/app',
      '@features': '/src/features',
      '@shared': '/src/shared',
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
});
