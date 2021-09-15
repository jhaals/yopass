import { test, expect } from '@playwright/test';

test('example', async ({ page }) => {
  await page.goto('https://playwright.dev/');
  const title = page.locator('.navbar__inner .navbar__title');
  await expect(title).toHaveText('Playwright');
  await page.screenshot({ path: 'tests/output/example.png' });
});
