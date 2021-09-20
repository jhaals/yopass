import { PlaywrightTestConfig } from '@playwright/test';

const config: PlaywrightTestConfig = {
  outputDir: 'tests/output',
  name: 'playwright',
  repeatEach: 1,
  retries: 1,
  testDir: 'tests',
  // testIgnore: '',
  // testMatch: '',
  timeout: 30000, // thirty seconds
  webServer: {
    env: {
      REACT_APP_BACKEND_URL: 'http://localhost:1337',
    },
    command: 'yarn start',
    port: 3000,
    timeout: 120 * 1000,
    reuseExistingServer: true,
    // reuseExistingServer: !process.env.CI,
  },
  // Disable Parallelism
  // https://playwright.dev/docs/test-parallel/#disable-parallelism
  workers: process.env.CI ? 2 : undefined,
  use: {
    headless: true,
    ignoreHTTPSErrors: false,
    screenshot: 'on', // 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'on-first-retry',
    viewport: { width: 1280, height: 720 },
  },
  globalSetup: require.resolve('./tests/browser/globalSetup'),
  globalTeardown: require.resolve('./tests/browser/globalTeardown'),
  // Limit Failures to Save Resources
  // https://playwright.dev/docs/test-parallel/#limit-failures-and-fail-fast
  maxFailures: process.env.CI ? 10 : undefined,
};

export default config;
