import { test, expect, devices } from '@playwright/test';
import { MockAPI } from './helpers/mock-api';

test.describe('Phone layout', () => {
  // Firefox cannot emulate a mobile device (isMobile/hasTouch).
  test.skip(({ browserName }) => browserName === 'firefox');
  const { defaultBrowserType: _browser, ...pixel } = devices['Pixel 7'];
  void _browser;
  test.use(pixel);

  test.beforeEach(async ({ page }) => {
    await new MockAPI(page).mockConfigEndpoint({ DISABLE_FEATURES: false });
  });

  test('shows the progress strip instead of the side panel', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(
      page.getByRole('navigation', { name: 'How it works' }),
    ).toBeVisible();
    await expect(page.locator('aside')).toBeHidden();
  });

  test('keeps the main action on screen and avoids input zoom', async ({
    page,
  }) => {
    await page.goto('/');
    const submit = page.locator('button[type="submit"]');
    await expect(submit).toBeInViewport();
    const box = await submit.boundingBox();
    const viewport = page.viewportSize()!;
    // Pinned to the bottom of the screen, spanning the column.
    expect(box!.y + box!.height).toBeGreaterThan(viewport.height - 100);
    expect(box!.width).toBeGreaterThan(viewport.width * 0.8);

    const fontSize = await page
      .locator('#secret')
      .evaluate(el => getComputedStyle(el).fontSize);
    expect(fontSize).toBe('16px');
  });
});

test.describe('Desktop layout', () => {
  test('pins the side panel and focuses the secret box', async ({ page }) => {
    await new MockAPI(page).mockConfigEndpoint();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await expect(page.locator('aside')).toBeVisible();
    await expect(
      page.getByRole('navigation', { name: 'How it works' }),
    ).toBeHidden();
    await expect(page.locator('#secret')).toBeFocused();
  });
});
