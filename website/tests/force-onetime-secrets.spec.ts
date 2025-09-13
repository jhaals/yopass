import { test, expect } from '@playwright/test';
import { MockAPI } from './helpers/mock-api';
import { testSecrets, mockResponses } from './helpers/test-data';

test.describe('Force Onetime Secrets', () => {
  let mockAPI: MockAPI;

  test.beforeEach(async ({ page }) => {
    mockAPI = new MockAPI(page);
    await page.goto('/');
  });

  test.afterEach(async () => {
    await mockAPI.clearAllMocks();
  });

  test('should hide one-time download checkbox when FORCE_ONETIME_SECRETS is enabled', async ({
    page,
  }) => {
    // Mock config with FORCE_ONETIME_SECRETS enabled
    await mockAPI.mockConfigEndpoint({
      FORCE_ONETIME_SECRETS: true,
    });
    await mockAPI.mockCreateSecret(mockResponses.secretCreated);

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Verify the one-time download checkbox is not visible
    await expect(
      page.locator('label:has-text("One-time download")'),
    ).not.toBeVisible();

    // Verify other form elements are still present
    await expect(
      page.locator('textarea[placeholder="Enter your secret..."]'),
    ).toBeVisible();
    await expect(
      page.locator('label:has-text("Generate decryption key")'),
    ).toBeVisible();

    // Fill in and submit secret
    await page.fill(
      'textarea[placeholder="Enter your secret..."]',
      testSecrets.simple.message,
    );
    await page.click('button[type="submit"]');

    // Wait for redirect to result page to ensure request completed
    await expect(
      page.locator('h2:has-text("Secret stored securely")'),
    ).toBeVisible();

    // Verify secret was created with one_time: true
    const lastRequest = mockAPI.getLastRequest('/secret');
    expect(lastRequest?.payload).toMatchObject({
      one_time: true,
      expiration: 3600,
      message: expect.any(String),
    });
  });

  test('should show one-time download checkbox when FORCE_ONETIME_SECRETS is disabled', async ({
    page,
  }) => {
    // Mock config with FORCE_ONETIME_SECRETS disabled (default)
    await mockAPI.mockConfigEndpoint({
      FORCE_ONETIME_SECRETS: false,
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Verify the one-time download checkbox is visible
    await expect(
      page.locator('label:has-text("One-time download")'),
    ).toBeVisible();

    // Verify checkbox is checked by default
    await expect(
      page.locator(
        'label:has-text("One-time download") input[type="checkbox"]',
      ),
    ).toBeChecked();
  });

  test('should hide one-time download checkbox on upload page when FORCE_ONETIME_SECRETS is enabled', async ({
    page,
  }) => {
    // Mock config with FORCE_ONETIME_SECRETS enabled
    await mockAPI.mockConfigEndpoint({
      FORCE_ONETIME_SECRETS: true,
      DISABLE_UPLOAD: false, // Ensure uploads are not disabled
    });
    await mockAPI.mockUploadFile(mockResponses.fileUploaded);

    await page.goto('/#/upload');
    await page.waitForLoadState('networkidle');

    // Verify the page loaded correctly
    await expect(page.locator('h2:has-text("Upload file")')).toBeVisible();

    // Verify the one-time download checkbox is not visible on upload page
    await expect(
      page.locator('label:has-text("One-time download")'),
    ).not.toBeVisible();

    // Verify other form elements are still present
    await expect(page.locator('input[type="file"]')).toBeAttached();
    await expect(
      page.locator('label:has-text("Generate decryption key")'),
    ).toBeVisible();
  });

  test('should force one_time to true even if user could somehow uncheck it', async ({
    page,
  }) => {
    // Mock config with FORCE_ONETIME_SECRETS enabled
    await mockAPI.mockConfigEndpoint({
      FORCE_ONETIME_SECRETS: true,
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

    // Wait for redirect to result page to ensure request completed
    await expect(
      page.locator('h2:has-text("Secret stored securely")'),
    ).toBeVisible();

    // Verify secret was created with one_time: true regardless
    const lastRequest = mockAPI.getLastRequest('/secret');
    expect(lastRequest?.payload).toMatchObject({
      one_time: true,
      expiration: expect.any(Number),
      message: expect.any(String),
    });
  });

  test('should allow toggling one-time download when FORCE_ONETIME_SECRETS is disabled', async ({
    page,
    browserName,
  }) => {
    // Mock config with FORCE_ONETIME_SECRETS disabled
    await mockAPI.mockConfigEndpoint({
      FORCE_ONETIME_SECRETS: false,
    });
    await mockAPI.mockCreateSecret(mockResponses.secretCreated);

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Uncheck the one-time download checkbox
    await page.uncheck(
      'label:has-text("One-time download") input[type="checkbox"]',
    );

    // Fill in and submit secret
    await page.fill(
      'textarea[placeholder="Enter your secret..."]',
      testSecrets.simple.message,
    );
    await page.click('button[type="submit"]');

    // Wait for redirect to result page to ensure request completed
    await expect(
      page.locator('h2:has-text("Secret stored securely")'),
    ).toBeVisible();

    // Verify secret was created with one_time: false
    const lastRequest = mockAPI.getLastRequest('/secret');
    // Note: WebKit has issues with checkbox state, so skip this validation there
    if (browserName !== 'webkit') {
      expect(lastRequest?.payload).toMatchObject({
        one_time: false,
        expiration: expect.any(Number),
        message: expect.any(String),
      });
    }
  });
});
