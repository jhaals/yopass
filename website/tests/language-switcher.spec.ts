import { test, expect } from '@playwright/test';
import { MockAPI } from './helpers/mock-api';

test.describe('Language Switcher', () => {
  let mockAPI: MockAPI;

  test.beforeEach(async ({ page }) => {
    mockAPI = new MockAPI(page);
  });

  test.afterEach(async () => {
    await mockAPI.clearAllMocks();
  });

  test('should show language switcher when NO_LANGUAGE_SWITCHER is false', async ({
    page,
  }) => {
    // Mock config with NO_LANGUAGE_SWITCHER disabled (default)
    await mockAPI.mockConfigEndpoint({
      NO_LANGUAGE_SWITCHER: false,
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Language switcher should be visible - look for the button with aria-label="Change language"
    const languageSwitcher = page.locator(
      'button[aria-label="Change language"]',
    );
    await expect(languageSwitcher).toBeVisible();

    // Verify it contains the language icon (SVG) and text
    const languageIcon = languageSwitcher.locator('svg');
    await expect(languageIcon).toBeVisible();

    // The navbar should exist
    const navbar = page.locator('.navbar, nav, [role="navigation"]');
    await expect(navbar).toBeVisible();
  });

  test('should hide language switcher when NO_LANGUAGE_SWITCHER is true', async ({
    page,
  }) => {
    // Mock config with NO_LANGUAGE_SWITCHER enabled
    await mockAPI.mockConfigEndpoint({
      NO_LANGUAGE_SWITCHER: true,
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Language switcher should not be visible - look for the button with aria-label="Change language"
    const languageSwitcher = page.locator(
      'button[aria-label="Change language"]',
    );
    await expect(languageSwitcher).not.toBeVisible();

    // The navbar should still exist (only language switcher is hidden)
    const navbar = page.locator('.navbar, nav, [role="navigation"]');
    await expect(navbar).toBeVisible();
  });

  test('should handle config loading errors gracefully', async ({ page }) => {
    // Mock config endpoint to return error
    await page.route('**/config', async route => {
      await route.fulfill({
        status: 500,
        headers: {
          'content-type': 'application/json',
          'access-control-allow-origin': '*',
        },
        json: { message: 'Internal server error' },
      });
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // App should still load with default configuration (language switcher visible)
    const navbar = page.locator('.navbar, nav, [role="navigation"]');
    await expect(navbar).toBeVisible();

    // Page should not crash and should show some content
    const bodyText = await page.locator('body').textContent();
    expect(bodyText?.length).toBeGreaterThan(0);
  });

  test('should respect config changes dynamically', async ({ page }) => {
    // Start with language switcher disabled
    await mockAPI.mockConfigEndpoint({
      NO_LANGUAGE_SWITCHER: true,
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Verify language switcher is not visible initially
    const languageSwitcher = page.locator(
      'button[aria-label="Change language"]',
    );
    await expect(languageSwitcher).not.toBeVisible();

    // Change mock to enable language switcher
    await mockAPI.clearAllMocks();
    await mockAPI.mockConfigEndpoint({
      NO_LANGUAGE_SWITCHER: false,
    });

    // Reload page to pick up new config
    await page.reload();
    await page.waitForLoadState('networkidle');

    // Now the language switcher should be visible
    await expect(languageSwitcher).toBeVisible();
  });

  test('should maintain other navbar functionality when language switcher is hidden', async ({
    page,
  }) => {
    // Mock config with NO_LANGUAGE_SWITCHER enabled but uploads enabled
    await mockAPI.mockConfigEndpoint({
      NO_LANGUAGE_SWITCHER: true,
      DISABLE_UPLOAD: false,
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Language switcher should not be visible
    const languageSwitcher = page.locator(
      'button[aria-label="Change language"]',
    );
    await expect(languageSwitcher).not.toBeVisible();

    // Check that other navbar elements still work
    const navbar = page.locator('.navbar, nav, [role="navigation"]');
    await expect(navbar).toBeVisible();

    // Upload button should still be visible (if uploads are enabled)
    const uploadButton = page.locator(
      'a[href*="upload"], button:has-text("Upload")',
    );
    if ((await uploadButton.count()) > 0) {
      await expect(uploadButton).toBeVisible();
    }

    // Theme toggle should still be visible - look for the specific swap element
    const themeToggle = page.locator('.swap.swap-rotate');
    if ((await themeToggle.count()) > 0) {
      await expect(themeToggle).toBeVisible();
    }
  });

  test('should have aria-expanded=false when dropdown is closed', async ({
    page,
  }) => {
    await mockAPI.mockConfigEndpoint({ NO_LANGUAGE_SWITCHER: false });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const languageSwitcher = page.locator(
      'button[aria-label="Change language"]',
    );
    await expect(languageSwitcher).toHaveAttribute('aria-expanded', 'false');
  });

  test('should have aria-expanded=true and show menu when clicked', async ({
    page,
  }) => {
    await mockAPI.mockConfigEndpoint({ NO_LANGUAGE_SWITCHER: false });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const languageSwitcher = page.locator(
      'button[aria-label="Change language"]',
    );

    // Menu should not be visible before click
    await expect(page.locator('#language-menu')).not.toBeVisible();

    await languageSwitcher.click();

    // After click: aria-expanded should be true and menu visible
    await expect(languageSwitcher).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#language-menu')).toBeVisible();
  });

  test('should have aria-controls pointing to the language menu', async ({
    page,
  }) => {
    await mockAPI.mockConfigEndpoint({ NO_LANGUAGE_SWITCHER: false });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const languageSwitcher = page.locator(
      'button[aria-label="Change language"]',
    );
    await expect(languageSwitcher).toHaveAttribute(
      'aria-controls',
      'language-menu',
    );
  });

  test('should not open dropdown on keyboard focus alone', async ({ page }) => {
    await mockAPI.mockConfigEndpoint({ NO_LANGUAGE_SWITCHER: false });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const languageSwitcher = page.locator(
      'button[aria-label="Change language"]',
    );
    await languageSwitcher.focus();

    // Dropdown menu should remain hidden after focus (no click)
    await expect(page.locator('#language-menu')).not.toBeVisible();
    await expect(languageSwitcher).toHaveAttribute('aria-expanded', 'false');
  });

  test('should close dropdown when clicking outside', async ({ page }) => {
    await mockAPI.mockConfigEndpoint({ NO_LANGUAGE_SWITCHER: false });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const languageSwitcher = page.locator(
      'button[aria-label="Change language"]',
    );

    // Open the dropdown
    await languageSwitcher.click();
    await expect(page.locator('#language-menu')).toBeVisible();

    // Click outside the dropdown
    await page.locator('body').click({ position: { x: 10, y: 10 } });
    await expect(page.locator('#language-menu')).not.toBeVisible();
    await expect(languageSwitcher).toHaveAttribute('aria-expanded', 'false');
  });

  test('should close dropdown after selecting a language', async ({ page }) => {
    await mockAPI.mockConfigEndpoint({ NO_LANGUAGE_SWITCHER: false });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const languageSwitcher = page.locator(
      'button[aria-label="Change language"]',
    );

    // Open the dropdown
    await languageSwitcher.click();
    await expect(page.locator('#language-menu')).toBeVisible();

    // Select a language
    await page.locator('#language-menu button').first().click();

    // Dropdown should close
    await expect(page.locator('#language-menu')).not.toBeVisible();
    await expect(languageSwitcher).toHaveAttribute('aria-expanded', 'false');
  });
});
