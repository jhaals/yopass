import { test, expect } from '@playwright/test';
import { MockAPI } from './helpers/mock-api';
import { testSecrets, mockResponses } from './helpers/test-data';

test.describe('Force Expiration', () => {
  let mockAPI: MockAPI;

  test.beforeEach(async ({ page }) => {
    mockAPI = new MockAPI(page);
    await page.goto('/');
  });

  test.afterEach(async () => {
    await mockAPI.clearAllMocks();
  });

  test('should hide expiration radio buttons when FORCE_EXPIRATION is set', async ({
    page,
  }) => {
    await mockAPI.mockConfigEndpoint({
      FORCE_EXPIRATION: 3600,
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Verify radio buttons are not visible
    await expect(
      page.locator('input[type="radio"][aria-label="One Hour"]'),
    ).not.toBeVisible();
    await expect(
      page.locator('input[type="radio"][aria-label="One Day"]'),
    ).not.toBeVisible();
    await expect(
      page.locator('input[type="radio"][aria-label="One Week"]'),
    ).not.toBeVisible();

    // Verify the forced expiration message is shown
    await expect(page.locator('text=Secret will expire in')).toBeVisible();
  });

  test('should show expiration radio buttons when FORCE_EXPIRATION is not set', async ({
    page,
  }) => {
    await mockAPI.mockConfigEndpoint({});

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Verify radio buttons are visible
    await expect(
      page.locator('input[type="radio"][aria-label="One Hour"]'),
    ).toBeVisible();
    await expect(
      page.locator('input[type="radio"][aria-label="One Day"]'),
    ).toBeVisible();
    await expect(
      page.locator('input[type="radio"][aria-label="One Week"]'),
    ).toBeVisible();
  });

  test('should submit with forced expiration value', async ({ page }) => {
    await mockAPI.mockConfigEndpoint({
      FORCE_EXPIRATION: 86400,
    });
    await mockAPI.mockCreateSecret(mockResponses.secretCreated);

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Fill in and submit secret
    await page.fill(
      'textarea[placeholder="Enter your secret..."]',
      testSecrets.simple.message,
    );
    await page.click('button[type="submit"]');

    // Wait for redirect to result page
    await expect(
      page.locator('h2:has-text("Secret stored securely")'),
    ).toBeVisible();

    // Verify secret was created with the forced expiration value
    const lastRequest = mockAPI.getLastRequest('/secret');
    expect(lastRequest?.payload).toMatchObject({
      expiration: 86400,
      message: expect.any(String),
    });
  });

  test('should hide expiration radio buttons on upload page when FORCE_EXPIRATION is set', async ({
    page,
  }) => {
    await mockAPI.mockConfigEndpoint({
      FORCE_EXPIRATION: 604800,
      DISABLE_UPLOAD: false,
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.goto('/#/upload');
    await page.waitForLoadState('networkidle');

    // Verify the page loaded
    await expect(page.locator('h2:has-text("Upload file")')).toBeVisible();

    // Verify radio buttons are not visible
    await expect(
      page.locator('input[type="radio"][aria-label="One Hour"]'),
    ).not.toBeVisible();
    await expect(
      page.locator('input[type="radio"][aria-label="One Day"]'),
    ).not.toBeVisible();
    await expect(
      page.locator('input[type="radio"][aria-label="One Week"]'),
    ).not.toBeVisible();

    // Verify the forced expiration message is shown
    await expect(page.locator('text=Secret will expire in')).toBeVisible();
  });
});
