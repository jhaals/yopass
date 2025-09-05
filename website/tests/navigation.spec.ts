import { test, expect } from '@playwright/test';
import { MockAPI } from './helpers/mock-api';

test.describe('Navigation', () => {
  let mockAPI: MockAPI;

  test.beforeEach(async ({ page }) => {
    mockAPI = new MockAPI(page);
    await mockAPI.mockConfigEndpoint();
  });

  test.afterEach(async () => {
    await mockAPI.clearAllMocks();
  });

  test('should navigate to home page by default', async ({ page }) => {
    await page.goto('/');

    // Wait for the app to load and React router to initialize
    await page.waitForLoadState('networkidle');

    // Should show the main features or create secret form
    await expect(page.locator('h2:has-text("Encrypt message")')).toBeVisible();
  });

  test('should navigate to upload page', async ({ page }) => {
    await page.goto('/#/upload');

    // Wait for the app to load
    await page.waitForLoadState('networkidle');

    await expect(page.locator('h2:has-text("Upload file")')).toBeVisible();
  });

  test('should handle navigation via navbar if present', async ({ page }) => {
    await page.goto('/');

    // Check if navbar exists and test navigation
    const navbar = page.locator('nav, .navbar, [role="navigation"]');
    if (await navbar.isVisible()) {
      // Test navigation links if they exist
      const uploadLink = page.locator(
        'a[href*="upload"], button:has-text("Upload")',
      );
      if (await uploadLink.isVisible()) {
        await uploadLink.click();
        await expect(page.locator('h2:has-text("Upload file")')).toBeVisible();
      }
    }
  });

  test('should handle direct URL navigation to secret view', async ({
    page,
  }) => {
    const secretId = 'test-secret-123';
    const password = 'test-password';

    // Mock status check
    await page.route(`**/secret/${secretId}/status`, async route => {
      await route.fulfill({
        status: 200,
        json: { oneTime: true },
      });
    });

    await page.goto(`/#/secret/${secretId}/${password}`);

    // Should show prefetch or decryption screen
    await expect(page.locator('h2:has-text("Secure Message")')).toBeVisible();
  });

  test('should handle direct URL navigation to file view', async ({ page }) => {
    const fileId = 'test-file-123';
    const password = 'test-password';

    // Mock status check
    await page.route(`**/file/${fileId}/status`, async route => {
      await route.fulfill({
        status: 200,
        json: { oneTime: true },
      });
    });

    await page.goto(`/#/f/${fileId}/${password}`);

    // Should show prefetch or decryption screen
    await expect(page.locator('h2:has-text("Secure Message")')).toBeVisible();
  });

  test('should handle invalid URLs gracefully', async ({ page }) => {
    await page.goto('/#/invalid-route');
    await page.waitForLoadState('networkidle');

    // Should not crash and should show some content
    // Could be error page or fallback to home
    const bodyText = await page.locator('body').textContent();
    expect(bodyText?.length).toBeGreaterThan(0);
  });

  test('should maintain URL state during navigation', async ({ page }) => {
    await page.goto('/#/');
    await page.waitForLoadState('networkidle');
    expect(page.url()).toContain('#/');

    await page.goto('/#/upload');
    await page.waitForLoadState('networkidle');
    expect(page.url()).toContain('#/upload');
  });

  test('should handle browser back/forward navigation', async ({ page }) => {
    // Start at home
    await page.goto('/#/');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('h2:has-text("Encrypt message")')).toBeVisible();

    // Navigate to upload
    await page.goto('/#/upload');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('h2:has-text("Upload file")')).toBeVisible();

    // Go back
    await page.goBack();
    await page.waitForLoadState('networkidle');
    await expect(page.locator('h2:has-text("Encrypt message")')).toBeVisible();

    // Go forward
    await page.goForward();
    await page.waitForLoadState('networkidle');
    await expect(page.locator('h2:has-text("Upload file")')).toBeVisible();
  });
});
