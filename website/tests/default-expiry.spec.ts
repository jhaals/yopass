import { test, expect } from '@playwright/test';
import { MockAPI } from './helpers/mock-api';

test.describe('Default Expiry', () => {
  let mockAPI: MockAPI;

  test.beforeEach(async ({ page }) => {
    mockAPI = new MockAPI(page);
  });

  test.afterEach(async () => {
    if (mockAPI) await mockAPI.clearAllMocks();
  });

  test('secret page: should pre-select 1 hour when DEFAULT_EXPIRY is 3600', async ({
    page,
  }) => {
    await mockAPI.mockConfigEndpoint({ DEFAULT_EXPIRY: 3600 });
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await expect(page.locator('input[value="3600"]')).toBeChecked();
    await expect(page.locator('input[value="86400"]')).not.toBeChecked();
    await expect(page.locator('input[value="604800"]')).not.toBeChecked();
  });

  test('secret page: should pre-select 1 day when DEFAULT_EXPIRY is 86400', async ({
    page,
  }) => {
    await mockAPI.mockConfigEndpoint({ DEFAULT_EXPIRY: 86400 });
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await expect(page.locator('input[value="86400"]')).toBeChecked();
    await expect(page.locator('input[value="3600"]')).not.toBeChecked();
    await expect(page.locator('input[value="604800"]')).not.toBeChecked();
  });

  test('secret page: should pre-select 1 week when DEFAULT_EXPIRY is 604800', async ({
    page,
  }) => {
    await mockAPI.mockConfigEndpoint({ DEFAULT_EXPIRY: 604800 });
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await expect(page.locator('input[value="604800"]')).toBeChecked();
    await expect(page.locator('input[value="3600"]')).not.toBeChecked();
    await expect(page.locator('input[value="86400"]')).not.toBeChecked();
  });

  test('upload page: should pre-select 1 hour when DEFAULT_EXPIRY is 3600', async ({
    page,
  }) => {
    await mockAPI.mockConfigEndpoint({ DEFAULT_EXPIRY: 3600 });
    await page.goto('/#/upload');
    await page.waitForLoadState('networkidle');

    await expect(page.locator('input[value="3600"]')).toBeChecked();
    await expect(page.locator('input[value="86400"]')).not.toBeChecked();
    await expect(page.locator('input[value="604800"]')).not.toBeChecked();
  });

  test('upload page: should pre-select 1 day when DEFAULT_EXPIRY is 86400', async ({
    page,
  }) => {
    await mockAPI.mockConfigEndpoint({ DEFAULT_EXPIRY: 86400 });
    await page.goto('/#/upload');
    await page.waitForLoadState('networkidle');

    await expect(page.locator('input[value="86400"]')).toBeChecked();
    await expect(page.locator('input[value="3600"]')).not.toBeChecked();
    await expect(page.locator('input[value="604800"]')).not.toBeChecked();
  });

  test('upload page: should pre-select 1 week when DEFAULT_EXPIRY is 604800', async ({
    page,
  }) => {
    await mockAPI.mockConfigEndpoint({ DEFAULT_EXPIRY: 604800 });
    await page.goto('/#/upload');
    await page.waitForLoadState('networkidle');

    await expect(page.locator('input[value="604800"]')).toBeChecked();
    await expect(page.locator('input[value="3600"]')).not.toBeChecked();
    await expect(page.locator('input[value="86400"]')).not.toBeChecked();
  });
});
