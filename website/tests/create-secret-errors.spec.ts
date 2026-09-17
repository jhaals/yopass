import { expect, test } from '@playwright/test';
import { MockAPI } from './helpers/mock-api';

test.beforeEach(async ({ page }) => {
  await new MockAPI(page).mockConfigEndpoint();
  await page.goto('/');
  await page.locator('#secret').fill('keep this input after a failure');
});

test('malformed success responses preserve the form and allow retry', async ({
  page,
}) => {
  await page.route('**/create/secret', route =>
    route.fulfill({ status: 200, json: {} }),
  );
  await page.locator('button[type="submit"]').click();
  await expect(page.getByRole('alert')).toContainText(
    'unexpected response body',
  );
  await expect(page.locator('#secret')).toHaveValue(
    'keep this input after a failure',
  );
  await expect(page.locator('button[type="submit"]')).toBeEnabled();
});

test('encryption failures are shown without submitting to the server', async ({
  page,
}) => {
  let submissions = 0;
  await page.route('**/create/secret', async route => {
    submissions++;
    await route.fulfill({ status: 200, json: { message: 'unexpected' } });
  });
  await page.evaluate(() => {
    crypto.getRandomValues = () => {
      throw new Error('Random generator unavailable');
    };
  });
  await page.locator('button[type="submit"]').click();
  await expect(page.getByRole('alert')).toContainText(
    'Random generator unavailable',
  );
  await expect(page.locator('button[type="submit"]')).toBeEnabled();
  expect(submissions).toBe(0);
});

test('submit stays disabled while the server response is pending', async ({
  page,
}) => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => {
    release = resolve;
  });
  await page.route('**/create/secret', async route => {
    await pending;
    await route.fulfill({ status: 500, json: { message: 'Try again' } });
  });
  const request = page.waitForRequest('**/create/secret');
  await page.locator('button[type="submit"]').click();
  await request;
  try {
    await expect(page.locator('button[type="submit"]')).toBeDisabled();
  } finally {
    release();
  }
  await expect(page.getByRole('alert')).toContainText('Try again');
  await expect(page.locator('button[type="submit"]')).toBeEnabled();
});

test('a storage failure does not hide a successfully created secret', async ({
  page,
}) => {
  await new MockAPI(page).mockConfigEndpoint({ READ_RECEIPTS: true });
  await page.reload();
  await page.locator('#secret').fill('secret with receipt');
  await page.locator('input[type="checkbox"]').last().check();
  await page.route('**/create/secret', route =>
    route.fulfill({
      status: 200,
      json: {
        message: 'abcdefghijklmnopqrstuv',
        receipt_token: 'receipt-token',
      },
    }),
  );
  await page.route('**/receipt', route =>
    route.fulfill({ status: 200, json: { state: 'pending' } }),
  );
  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new Error('storage full');
    };
  });
  await page.locator('button[type="submit"]').click();
  await expect(
    page.getByRole('heading', { name: 'Secret stored securely' }),
  ).toBeVisible();
});
