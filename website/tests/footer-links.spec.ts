import { test, expect } from '@playwright/test';

test.describe('Footer Links', () => {
  test('should not show privacy notice or imprint links when not configured', async ({
    page,
  }) => {
    // Mock config endpoint without privacy/imprint URLs
    await page.route('**/config', async route => {
      await route.fulfill({
        status: 200,
        json: {
          DISABLE_UPLOAD: false,
          PREFETCH_SECRET: true,
          DISABLE_FEATURES: false,
          NO_LANGUAGE_SWITCHER: false,
        },
      });
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Check that footer exists but privacy/imprint links are not present
    const footer = page.locator('footer');
    await expect(footer).toBeVisible();
    await expect(
      footer.locator('a:has-text("Privacy Notice")'),
    ).not.toBeVisible();
    await expect(footer.locator('a:has-text("Imprint")')).not.toBeVisible();
  });

  test('should show only privacy notice link when configured', async ({
    page,
  }) => {
    // Mock config endpoint with only privacy notice URL
    await page.route('**/config', async route => {
      await route.fulfill({
        status: 200,
        json: {
          DISABLE_UPLOAD: false,
          PREFETCH_SECRET: true,
          DISABLE_FEATURES: false,
          NO_LANGUAGE_SWITCHER: false,
          PRIVACY_NOTICE_URL: 'https://example.com/privacy',
        },
      });
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Check that privacy notice link is present
    const privacyLink = page.locator('a:has-text("Privacy Notice")');
    await expect(privacyLink).toBeVisible();
    await expect(privacyLink).toHaveAttribute(
      'href',
      'https://example.com/privacy',
    );
    await expect(privacyLink).toHaveAttribute('target', '_blank');
    await expect(privacyLink).toHaveAttribute('rel', 'noopener noreferrer');

    // Check that imprint link is not present
    await expect(page.locator('a:has-text("Imprint")')).not.toBeVisible();

    // Check that the text contains bullet separator and created by text
    const footerText = page.locator('footer div.flex.flex-wrap');
    await expect(footerText).toContainText(
      'Privacy Notice•Created by Johan Haals',
    );
  });

  test('should show only imprint link when configured', async ({ page }) => {
    // Mock config endpoint with only imprint URL
    await page.route('**/config', async route => {
      await route.fulfill({
        status: 200,
        json: {
          DISABLE_UPLOAD: false,
          PREFETCH_SECRET: true,
          DISABLE_FEATURES: false,
          NO_LANGUAGE_SWITCHER: false,
          IMPRINT_URL: 'https://example.com/imprint',
        },
      });
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Check that imprint link is present
    const imprintLink = page.locator('a:has-text("Imprint")');
    await expect(imprintLink).toBeVisible();
    await expect(imprintLink).toHaveAttribute(
      'href',
      'https://example.com/imprint',
    );
    await expect(imprintLink).toHaveAttribute('target', '_blank');
    await expect(imprintLink).toHaveAttribute('rel', 'noopener noreferrer');

    // Check that privacy notice link is not present
    await expect(
      page.locator('a:has-text("Privacy Notice")'),
    ).not.toBeVisible();

    // Check that the text contains bullet separator and created by text
    const footerText = page.locator('footer div.flex.flex-wrap');
    await expect(footerText).toContainText('Imprint•Created by Johan Haals');
  });

  test('should show both privacy notice and imprint links when both are configured', async ({
    page,
  }) => {
    // Mock config endpoint with both URLs
    await page.route('**/config', async route => {
      await route.fulfill({
        status: 200,
        json: {
          DISABLE_UPLOAD: false,
          PREFETCH_SECRET: true,
          DISABLE_FEATURES: false,
          NO_LANGUAGE_SWITCHER: false,
          PRIVACY_NOTICE_URL: 'https://example.com/privacy',
          IMPRINT_URL: 'https://example.com/imprint',
        },
      });
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Check that both links are present
    const privacyLink = page.locator('a:has-text("Privacy Notice")');
    const imprintLink = page.locator('a:has-text("Imprint")');

    await expect(privacyLink).toBeVisible();
    await expect(privacyLink).toHaveAttribute(
      'href',
      'https://example.com/privacy',
    );
    await expect(privacyLink).toHaveAttribute('target', '_blank');

    await expect(imprintLink).toBeVisible();
    await expect(imprintLink).toHaveAttribute(
      'href',
      'https://example.com/imprint',
    );
    await expect(imprintLink).toHaveAttribute('target', '_blank');

    // Check that both links are on the same line with bullet separators
    const footerText = page.locator('footer div.flex.flex-wrap');
    await expect(footerText).toContainText(
      'Privacy Notice•Imprint•Created by Johan Haals',
    );
  });

  test('should show footer links on all pages when configured', async ({
    page,
  }) => {
    // Mock config endpoint with both URLs
    await page.route('**/config', async route => {
      await route.fulfill({
        status: 200,
        json: {
          DISABLE_UPLOAD: false,
          PREFETCH_SECRET: true,
          DISABLE_FEATURES: false,
          NO_LANGUAGE_SWITCHER: false,
          PRIVACY_NOTICE_URL: 'https://example.com/privacy',
          IMPRINT_URL: 'https://example.com/imprint',
        },
      });
    });

    // Test on home page
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('a:has-text("Privacy Notice")')).toBeVisible();
    await expect(page.locator('a:has-text("Imprint")')).toBeVisible();

    // Test on upload page
    await page.goto('/#/upload');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('a:has-text("Privacy Notice")')).toBeVisible();
    await expect(page.locator('a:has-text("Imprint")')).toBeVisible();
  });

  test('should handle empty string URLs same as missing URLs', async ({
    page,
  }) => {
    // Mock config endpoint with empty string URLs
    await page.route('**/config', async route => {
      await route.fulfill({
        status: 200,
        json: {
          DISABLE_UPLOAD: false,
          PREFETCH_SECRET: true,
          DISABLE_FEATURES: false,
          NO_LANGUAGE_SWITCHER: false,
          PRIVACY_NOTICE_URL: '',
          IMPRINT_URL: '',
        },
      });
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Check that links are not shown when URLs are empty strings
    await expect(
      page.locator('a:has-text("Privacy Notice")'),
    ).not.toBeVisible();
    await expect(page.locator('a:has-text("Imprint")')).not.toBeVisible();
  });
});
