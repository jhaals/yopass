import { test, expect } from '@playwright/test';
import { MockAPI } from './helpers/mock-api';
import { testSecrets } from './helpers/test-data';

test.describe('Read-Only Mode', () => {
  let mockAPI: MockAPI;

  test.beforeEach(async ({ page }) => {
    mockAPI = new MockAPI(page);
  });

  test.afterEach(async () => {
    await mockAPI.clearAllMocks();
  });

  test('should display read-only landing page when READ_ONLY is true', async ({
    page,
  }) => {
    await mockAPI.mockConfigEndpoint({ READ_ONLY: true });
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Check for read-only landing page elements
    await expect(
      page.locator('h1:has-text("Secret Retrieval")'),
    ).toBeVisible();
    await expect(
      page.locator('text=This instance is configured for secret retrieval only'),
    ).toBeVisible();

    // Check that eye icon is visible
    await expect(page.locator('svg').first()).toBeVisible();
  });

  test('should NOT display create form in read-only mode', async ({ page }) => {
    await mockAPI.mockConfigEndpoint({ READ_ONLY: true });
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Create form should not be visible
    await expect(
      page.locator('h2:has-text("Encrypt message")'),
    ).not.toBeVisible();
    await expect(
      page.locator('textarea[placeholder="Enter your secret..."]'),
    ).not.toBeVisible();
  });

  test('should hide navbar create/upload buttons in read-only mode', async ({
    page,
  }) => {
    await mockAPI.mockConfigEndpoint({ READ_ONLY: true });
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Upload button should not be visible
    await expect(page.locator('text=Upload').first()).not.toBeVisible();

    // Text button should not be visible
    await expect(
      page.locator('a[href="#/"]:has-text("Text")'),
    ).not.toBeVisible();
  });

  test('should hide features section in read-only mode', async ({ page }) => {
    await mockAPI.mockConfigEndpoint({
      READ_ONLY: true,
      DISABLE_FEATURES: false,
    });
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Features section should be hidden even if DISABLE_FEATURES is false
    await expect(
      page.locator('h2:has-text("Share secrets securely with ease")'),
    ).not.toBeVisible();
  });

  test('should allow secret retrieval in read-only mode', async ({ page }) => {
    await mockAPI.mockConfigEndpoint({ READ_ONLY: true });

    const secretId = '12345678-1234-1234-1234-123456789012';
    const encryptedMessage = testSecrets.validSecret;

    await mockAPI.mockGetSecret(secretId, {
      message: encryptedMessage,
      one_time: false,
    });

    // Navigate directly to secret URL
    await page.goto(`/#/s/${secretId}/testpassword`);
    await page.waitForLoadState('networkidle');

    // Verify that the page didn't redirect to read-only landing
    // (secret retrieval should work in read-only mode)
    await expect(
      page.locator('h1:has-text("Secret Retrieval")'),
    ).not.toBeVisible();
  });

  test('should NOT show upload route in read-only mode', async ({ page }) => {
    await mockAPI.mockConfigEndpoint({ READ_ONLY: true });
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Upload button in navbar should not be visible
    await expect(page.locator('a[href="#/upload"]')).not.toBeVisible();

    // Read-only landing should be visible on homepage
    await expect(
      page.locator('h1:has-text("Secret Retrieval")'),
    ).toBeVisible();
  });

  test('should display create form when READ_ONLY is false (normal mode)', async ({
    page,
  }) => {
    await mockAPI.mockConfigEndpoint({ READ_ONLY: false });
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Create form should be visible
    await expect(page.locator('h2:has-text("Encrypt message")')).toBeVisible();
    await expect(
      page.locator('textarea[placeholder="Enter your secret..."]'),
    ).toBeVisible();

    // Read-only landing should not be visible
    await expect(
      page.locator('h1:has-text("Secret Retrieval")'),
    ).not.toBeVisible();
  });

  test('should show navbar buttons in normal mode', async ({ page }) => {
    await mockAPI.mockConfigEndpoint({
      READ_ONLY: false,
      DISABLE_UPLOAD: false,
    });
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Upload button should be visible
    await expect(page.locator('a[href="#/upload"]')).toBeVisible();
  });

  test('should show features section in normal mode when DISABLE_FEATURES is false', async ({
    page,
  }) => {
    await mockAPI.mockConfigEndpoint({
      READ_ONLY: false,
      DISABLE_FEATURES: false,
    });
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Features section should be visible
    await expect(
      page.locator('h2:has-text("Share secrets securely with ease")'),
    ).toBeVisible();
  });
});
