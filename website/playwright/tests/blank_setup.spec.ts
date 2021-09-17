import { test, expect } from '@playwright/test';
import globalSetup from './browser/globalSetup';

test.beforeEach(async ({ page }) => {
  await globalSetup();
  await page.goto('http://localhost:3000/');
  await page.waitForLoadState('networkidle');
});

test('blank_setup', async ({ page }) => {
  const description = page.locator('span#blankPageDescription');
  await expect(description).toHaveText('This page intentionally left blank.');
});
