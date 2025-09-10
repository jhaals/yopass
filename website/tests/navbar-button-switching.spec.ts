import { test, expect } from '@playwright/test';
import { MockAPI } from './helpers/mock-api';

test.describe('Navbar Button Switching', () => {
  let mockAPI: MockAPI;

  test.beforeEach(async ({ page }) => {
    mockAPI = new MockAPI(page);
    await mockAPI.mockConfigEndpoint();
  });

  test.afterEach(async () => {
    await mockAPI.clearAllMocks();
  });

  test('should show Upload button on home page', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Check that Upload button is visible
    const uploadButton = page.locator('a[href="#/upload"]');
    await expect(uploadButton).toBeVisible();
    await expect(uploadButton).toHaveText('Upload');

    // Check that Text button is not visible
    const textButton = page.locator('a[href="#/"]').filter({ hasText: 'Text' });
    await expect(textButton).not.toBeVisible();
  });

  test('should show Text button on upload page', async ({ page }) => {
    await page.goto('/#/upload');
    await page.waitForLoadState('networkidle');

    // Check that Text button is visible
    const textButton = page.locator('a[href="#/"]').filter({ hasText: 'Text' });
    await expect(textButton).toBeVisible();
    await expect(textButton).toHaveText('Text');

    // Check that Upload button is not visible
    const uploadButton = page.locator('a[href="#/upload"]');
    await expect(uploadButton).not.toBeVisible();
  });

  test('should switch from Upload button to Text button when navigating to upload page', async ({
    page,
  }) => {
    // Start on home page
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Verify Upload button is visible
    const uploadButton = page.locator('a[href="#/upload"]');
    await expect(uploadButton).toBeVisible();

    // Click Upload button to navigate to upload page
    await uploadButton.click();
    await page.waitForLoadState('networkidle');

    // Verify we're on upload page and Text button is now visible
    await expect(page.locator('h2:has-text("Upload file")')).toBeVisible();
    const textButton = page.locator('a[href="#/"]').filter({ hasText: 'Text' });
    await expect(textButton).toBeVisible();
    await expect(uploadButton).not.toBeVisible();
  });

  test('should switch from Text button to Upload button when navigating to home page', async ({
    page,
  }) => {
    // Start on upload page
    await page.goto('/#/upload');
    await page.waitForLoadState('networkidle');

    // Verify Text button is visible
    const textButton = page.locator('a[href="#/"]').filter({ hasText: 'Text' });
    await expect(textButton).toBeVisible();

    // Click Text button to navigate to home page
    await textButton.click();
    await page.waitForLoadState('networkidle');

    // Verify we're on home page and Upload button is now visible
    await expect(page.locator('h2:has-text("Encrypt message")')).toBeVisible();
    const uploadButton = page.locator('a[href="#/upload"]');
    await expect(uploadButton).toBeVisible();
    await expect(textButton).not.toBeVisible();
  });

  test('should use correct icons for each button', async ({ page }) => {
    // Test Upload button icon on home page
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const uploadButton = page.locator('a[href="#/upload"]');
    await expect(uploadButton).toBeVisible();

    // Check for upload icon (SVG with upload path)
    const uploadIcon = uploadButton.locator('svg path[d*="M3 16.5v2.25"]');
    await expect(uploadIcon).toBeVisible();

    // Navigate to upload page
    await page.goto('/#/upload');
    await page.waitForLoadState('networkidle');

    const textButton = page.locator('a[href="#/"]').filter({ hasText: 'Text' });
    await expect(textButton).toBeVisible();

    // Check for envelope/mail icon (SVG with mail path)
    const textIcon = textButton.locator('svg path[d*="M21.75 6.75v10.5"]');
    await expect(textIcon).toBeVisible();
  });

  test('should maintain button switching behavior with browser navigation', async ({
    page,
  }) => {
    // Start on home page
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('a[href="#/upload"]')).toBeVisible();

    // Navigate to upload page via URL
    await page.goto('/#/upload');
    await page.waitForLoadState('networkidle');
    await expect(
      page.locator('a[href="#/"]').filter({ hasText: 'Text' }),
    ).toBeVisible();

    // Go back using browser back button
    await page.goBack();
    await page.waitForLoadState('networkidle');
    await expect(page.locator('a[href="#/upload"]')).toBeVisible();

    // Go forward using browser forward button
    await page.goForward();
    await page.waitForLoadState('networkidle');
    await expect(
      page.locator('a[href="#/"]').filter({ hasText: 'Text' }),
    ).toBeVisible();
  });
});
