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

test('signin', async ({ page }) => {
  await page.goto('http://localhost:3000/');
  const description = page.locator('span#blankPageDescription');
  await expect(description).toHaveText('This page intentionally left blank.');

  const signInOrSignOutButtonTitle = page.locator(
    'button#signInOrSignOutButton',
  );
  await expect(signInOrSignOutButtonTitle).toHaveText('Sign-In');

  await page.goto('http://localhost:3000/');
  await page.click('[data-playwright=signInOrSignOutButton]');
  await page.waitForLoadState('networkidle');

  await page.click('span:has-text("Logg inn med e-post")');
  await page.waitForLoadState('networkidle');

  await page.fill('#Email', process.env.ONETIME_TEST_USER_EMAIL);
  await page.fill('#Password', process.env.ONETIME_TEST_USER_PASSWORD);
  await page.click('button#LoginFormActionButton');
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: 'tests/output/signin.png' });
});
