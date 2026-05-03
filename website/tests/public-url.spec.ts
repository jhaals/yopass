import { test, expect } from '@playwright/test';
import { MockAPI } from './helpers/mock-api';
import { testSecrets, mockResponses } from './helpers/test-data';

test.describe('Public URL', () => {
  let mockAPI: MockAPI;

  test.beforeEach(async ({ page }) => {
    mockAPI = new MockAPI(page);
  });

  test.afterEach(async () => {
    await mockAPI.clearAllMocks();
  });

  test('should use PUBLIC_URL as base for generated secret links', async ({
    page,
  }) => {
    const publicURL = 'https://secrets.example.com';

    await mockAPI.mockConfigEndpoint({ PUBLIC_URL: publicURL });
    await mockAPI.mockCreateSecret(mockResponses.secretCreated);

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await page.fill(
      'textarea[placeholder="Enter your secret..."]',
      testSecrets.simple.message,
    );
    await page.click('button[type="submit"]');

    await expect(
      page.locator('h2:has-text("Secret stored securely")'),
    ).toBeVisible();

    // The one-click link should use the public URL as its base
    const linkCode = page.locator('code').first();
    await expect(linkCode).toBeVisible();
    const url = await linkCode.textContent();
    const escapedURL = publicURL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect(url).toMatch(new RegExp(`^${escapedURL}/#/s/`));
  });

  test('should use PUBLIC_URL with trailing slash correctly (no double slash)', async ({
    page,
  }) => {
    const publicURL = 'https://secrets.example.com/';

    await mockAPI.mockConfigEndpoint({ PUBLIC_URL: publicURL });
    await mockAPI.mockCreateSecret(mockResponses.secretCreated);

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await page.fill(
      'textarea[placeholder="Enter your secret..."]',
      testSecrets.simple.message,
    );
    await page.click('button[type="submit"]');

    await expect(
      page.locator('h2:has-text("Secret stored securely")'),
    ).toBeVisible();

    // Trailing slash on PUBLIC_URL should not produce double slash in the URL
    const linkCode = page.locator('code').first();
    await expect(linkCode).toBeVisible();
    const url = await linkCode.textContent();
    expect(url).not.toContain('//#/');
    expect(url).toMatch(/^https:\/\/secrets\.example\.com\/#\/s\//);
  });

  test('should fall back to window.location.origin when PUBLIC_URL is not set', async ({
    page,
  }) => {
    await mockAPI.mockConfigEndpoint(); // No PUBLIC_URL
    await mockAPI.mockCreateSecret(mockResponses.secretCreated);

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await page.fill(
      'textarea[placeholder="Enter your secret..."]',
      testSecrets.simple.message,
    );
    await page.click('button[type="submit"]');

    await expect(
      page.locator('h2:has-text("Secret stored securely")'),
    ).toBeVisible();

    // Without PUBLIC_URL the link should use the current origin (localhost in tests)
    const linkCode = page.locator('code').first();
    await expect(linkCode).toBeVisible();
    const url = await linkCode.textContent();
    expect(url).toMatch(/^http:\/\/localhost/);
    expect(url).toContain('/#/s/');
  });
});
