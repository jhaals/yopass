import { test, expect, type Page } from '@playwright/test';
import { MockAPI } from './helpers/mock-api';

// The Message / File tabs switch between the text (#/) and file (#/upload)
// compose screens.
test.describe('Compose tabs', () => {
  let mockAPI: MockAPI;

  test.beforeEach(async ({ page }) => {
    mockAPI = new MockAPI(page);
    await mockAPI.mockConfigEndpoint();
  });

  test.afterEach(async () => {
    await mockAPI.clearAllMocks();
  });

  function messageTab(page: Page) {
    return page.getByRole('tab', { name: 'Message' });
  }
  function fileTab(page: Page) {
    return page.getByRole('tab', { name: 'File' });
  }

  test('selects the Message tab on the home page', async ({ page }) => {
    await page.goto('/');
    await expect(messageTab(page)).toHaveAttribute('aria-selected', 'true');
    await expect(fileTab(page)).toHaveAttribute('aria-selected', 'false');
    await expect(fileTab(page)).toHaveAttribute('href', '#/upload');
    await expect(page.locator('#secret')).toBeVisible();
  });

  test('selects the File tab on the upload page', async ({ page }) => {
    await page.goto('/#/upload');
    await expect(fileTab(page)).toHaveAttribute('aria-selected', 'true');
    await expect(messageTab(page)).toHaveAttribute('href', '#/');
    await expect(page.locator('text=Drop a file to encrypt')).toBeVisible();
  });

  test('switches between the compose screens', async ({ page }) => {
    await page.goto('/');
    await fileTab(page).click();
    await expect(page).toHaveURL(/#\/upload$/);
    await expect(page.locator('text=Drop a file to encrypt')).toBeVisible();

    await messageTab(page).click();
    await expect(page.locator('#secret')).toBeVisible();
    await expect(messageTab(page)).toHaveAttribute('aria-selected', 'true');
  });

  test('follows browser history', async ({ page }) => {
    await page.goto('/');
    await fileTab(page).click();
    await expect(fileTab(page)).toHaveAttribute('aria-selected', 'true');

    await page.goBack();
    await expect(messageTab(page)).toHaveAttribute('aria-selected', 'true');

    await page.goForward();
    await expect(fileTab(page)).toHaveAttribute('aria-selected', 'true');
  });

  test('hides the tabs when uploads are disabled', async ({ page }) => {
    await mockAPI.mockConfigEndpoint({ DISABLE_UPLOAD: true });
    await page.goto('/');
    await expect(page.locator('#secret')).toBeVisible();
    await expect(page.getByRole('tablist')).toHaveCount(0);
  });
});
