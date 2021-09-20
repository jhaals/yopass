import { test, expect } from '@playwright/test';

test.beforeAll(async () => {
  console.log('Blank: Before All');
});

test.afterAll(async () => {
  console.log('Blank: After All');
});

test.beforeEach(async ({ page }) => {
  console.log('Blank: Before Each');
});

test.afterEach(async ({ page }) => {
  console.log('Blank: After Each');
});

test('blank', async ({ page }) => {
  await page.goto('http://localhost:3000/');
  const description = page.locator('data-test-id=blankPageDescription');
  await expect(description).toHaveText('This page intentionally left blank.');
});
