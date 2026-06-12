import { test, expect } from '@playwright/test';
import { MockAPI, MockReceiptResponse } from './helpers/mock-api';
import { testSecrets } from './helpers/test-data';

const SECRET_ID = 'read-receipt-secret-id';
const RECEIPT_TOKEN = 'receipt-token-abc123';

const RECEIPT_TOGGLE = 'label:has-text("Read receipt") input[type="checkbox"]';

test.describe('Read receipts', () => {
  let mockAPI: MockAPI;

  test.afterEach(async () => {
    await mockAPI.clearAllMocks();
  });

  async function setup(page, readReceipts: boolean) {
    mockAPI = new MockAPI(page);
    await mockAPI.mockConfigEndpoint({ READ_RECEIPTS: readReceipts });
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  }

  test('toggle is hidden without the licensed feature', async ({ page }) => {
    await setup(page, false);
    await expect(page.locator('h2:has-text("Encrypt message")')).toBeVisible();
    await expect(page.locator(RECEIPT_TOGGLE)).not.toBeVisible();
  });

  test('toggle is visible and unchecked by default when enabled', async ({
    page,
  }) => {
    await setup(page, true);
    await expect(page.locator(RECEIPT_TOGGLE)).toBeVisible();
    await expect(page.locator(RECEIPT_TOGGLE)).not.toBeChecked();
  });

  test('creating without the toggle does not request a receipt', async ({
    page,
  }) => {
    await setup(page, true);
    await mockAPI.mockCreateSecret({ message: SECRET_ID });

    await page.fill(
      'textarea[placeholder="Enter your secret..."]',
      testSecrets.simple.message,
    );
    await page.click('button[type="submit"]');

    await expect(
      page.locator('h2:has-text("Secret stored securely")'),
    ).toBeVisible();
    const lastRequest = mockAPI.getLastRequest('/secret');
    expect(lastRequest?.payload).toMatchObject({ receipt: false });

    // No receipt panel on the result page.
    await expect(page.locator('text=Read receipt')).not.toBeVisible();
  });

  test('shows a pending receipt that flips to viewed', async ({ page }) => {
    await setup(page, true);
    await mockAPI.mockCreateSecret({
      message: SECRET_ID,
      receipt_token: RECEIPT_TOKEN,
    });

    let receipt: MockReceiptResponse = {
      state: 'pending',
      one_time: true,
      created_at: Math.floor(Date.now() / 1000),
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    };
    await mockAPI.mockSecretReceipt(SECRET_ID, () => ({
      status: 200,
      json: receipt,
    }));

    await page.fill(
      'textarea[placeholder="Enter your secret..."]',
      testSecrets.simple.message,
    );
    await page.check(RECEIPT_TOGGLE);
    await page.click('button[type="submit"]');

    await expect(
      page.locator('h2:has-text("Secret stored securely")'),
    ).toBeVisible();

    // The payload requested a receipt.
    const createRequest = mockAPI.getLastRequest('/create/secret');
    expect(createRequest?.payload).toMatchObject({ receipt: true });

    // The receipt panel polls and shows the pending state.
    await expect(
      page.locator('[data-testid="receipt-status-pending"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="receipt-status-pending"]'),
    ).toContainText('Not opened yet');

    // The status request authenticates with the receipt token.
    const receiptRequest = mockAPI.getLastRequest('/receipt');
    expect(receiptRequest?.payload).toMatchObject({
      receiptToken: RECEIPT_TOKEN,
    });

    // Flip the backend state to viewed and refresh manually.
    receipt = {
      ...receipt,
      state: 'viewed',
      viewed_at: Math.floor(Date.now() / 1000),
    };
    await page.click('[data-testid="receipt-refresh"]');

    await expect(
      page.locator('[data-testid="receipt-status-viewed"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="receipt-status-viewed"]'),
    ).toContainText('Opened');

    // Once viewed, the refresh button disappears and polling stops.
    await expect(
      page.locator('[data-testid="receipt-refresh"]'),
    ).not.toBeVisible();
  });

  test('shows expired state when the receipt is gone', async ({ page }) => {
    await setup(page, true);
    await mockAPI.mockCreateSecret({
      message: SECRET_ID,
      receipt_token: RECEIPT_TOKEN,
    });
    await mockAPI.mockSecretReceipt(SECRET_ID, () => ({
      status: 404,
      json: { state: 'pending' },
    }));

    await page.fill(
      'textarea[placeholder="Enter your secret..."]',
      testSecrets.simple.message,
    );
    await page.check(RECEIPT_TOGGLE);
    await page.click('button[type="submit"]');

    await expect(
      page.locator('[data-testid="receipt-status-expired"]'),
    ).toBeVisible();
  });
});

test.describe('Receipts page', () => {
  let mockAPI: MockAPI;

  test.afterEach(async () => {
    await mockAPI.clearAllMocks();
  });

  async function setup(page, readReceipts: boolean) {
    mockAPI = new MockAPI(page);
    await mockAPI.mockConfigEndpoint({ READ_RECEIPTS: readReceipts });
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  }

  // Creates a secret with a receipt through the UI so the receipt is
  // persisted in localStorage.
  async function createSecretWithReceipt(page) {
    await mockAPI.mockCreateSecret({
      message: SECRET_ID,
      receipt_token: RECEIPT_TOKEN,
    });
    await page.fill(
      'textarea[placeholder="Enter your secret..."]',
      testSecrets.simple.message,
    );
    await page.check(RECEIPT_TOGGLE);
    await page.click('button[type="submit"]');
    await expect(
      page.locator('h2:has-text("Secret stored securely")'),
    ).toBeVisible();
  }

  test('navbar link is hidden without the licensed feature', async ({
    page,
  }) => {
    await setup(page, false);
    await expect(page.locator('a[href="#/receipts"]')).not.toBeVisible();
  });

  test('shows an empty state without stored receipts', async ({ page }) => {
    await setup(page, true);
    await page.click('header a[href="#/receipts"]');
    await expect(page.locator('h2:has-text("Read receipts")')).toBeVisible();
    await expect(page.locator('text=No read receipts yet')).toBeVisible();
  });

  test('lists a created receipt and survives navigating away', async ({
    page,
  }) => {
    await setup(page, true);

    let receipt: MockReceiptResponse = {
      state: 'pending',
      one_time: true,
      created_at: Math.floor(Date.now() / 1000),
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    };
    await mockAPI.mockSecretReceipt(SECRET_ID, () => ({
      status: 200,
      json: receipt,
    }));

    await createSecretWithReceipt(page);

    // Navigate away from the result page, then to the Receipts page.
    await page.click('text=Create another secret');
    await page.click('header a[href="#/receipts"]');

    const item = page.locator('[data-testid="receipt-list-item"]');
    await expect(item).toHaveCount(1);
    await expect(item).toContainText(SECRET_ID);
    await expect(item.locator('.badge')).toContainText('Not opened');

    // The status request authenticates with the stored receipt token.
    const receiptRequest = mockAPI.getLastRequest('/receipt');
    expect(receiptRequest?.payload).toMatchObject({
      receiptToken: RECEIPT_TOKEN,
    });

    // Flip the backend state to viewed; a reload refetches the status.
    receipt = {
      ...receipt,
      state: 'viewed',
      viewed_at: Math.floor(Date.now() / 1000),
    };
    await page.reload();
    await page.waitForLoadState('networkidle');
    await expect(item.locator('.badge')).toContainText('Opened');
    await expect(item).toContainText('Opened');
  });

  test('keeps the viewed state after the receipt expires on the server', async ({
    page,
  }) => {
    await setup(page, true);

    // First visit observes viewed; afterwards the server returns 404.
    let receiptGone = false;
    await mockAPI.mockSecretReceipt(SECRET_ID, () =>
      receiptGone
        ? { status: 404, json: { state: 'pending' } }
        : {
            status: 200,
            json: {
              state: 'viewed',
              one_time: true,
              created_at: Math.floor(Date.now() / 1000),
              viewed_at: Math.floor(Date.now() / 1000),
              expires_at: Math.floor(Date.now() / 1000) + 3600,
            },
          },
    );

    await createSecretWithReceipt(page);
    // The result panel records the viewed state in localStorage.
    await expect(
      page.locator('[data-testid="receipt-status-viewed"]'),
    ).toBeVisible();

    receiptGone = true;
    await page.click('header a[href="#/receipts"]');
    const item = page.locator('[data-testid="receipt-list-item"]');
    await expect(item.locator('.badge')).toContainText('Opened');
  });

  test('shows ISO dates by default and can switch to locale format', async ({
    page,
  }) => {
    await setup(page, true);
    await mockAPI.mockSecretReceipt(SECRET_ID, () => ({
      status: 200,
      json: {
        state: 'pending',
        one_time: true,
        created_at: Math.floor(Date.now() / 1000),
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      },
    }));

    await createSecretWithReceipt(page);
    await page.click('header a[href="#/receipts"]');

    // ISO 8601 (YYYY-MM-DD HH:MM) is the default.
    const item = page.locator('[data-testid="receipt-list-item"]');
    const isoDate = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/;
    await expect(item).toContainText(isoDate);

    // Turning ISO off in the settings menu switches to the browser locale
    // format everywhere.
    await page.click('[data-testid="settings-menu-button"]');
    await page.uncheck('[data-testid="date-format-toggle"]');
    await expect(item).not.toContainText(isoDate);

    // The preference is persisted across reloads.
    await page.reload();
    await page.waitForLoadState('networkidle');
    await expect(item).not.toContainText(isoDate);

    // And it can be switched back.
    await page.click('[data-testid="settings-menu-button"]');
    await page.check('[data-testid="date-format-toggle"]');
    await expect(item).toContainText(isoDate);
  });

  test('file uploads support read receipts', async ({ page }) => {
    await setup(page, true);
    await mockAPI.mockUploadFile({
      message: SECRET_ID,
      receipt_token: RECEIPT_TOKEN,
    });
    await mockAPI.mockSecretReceipt(SECRET_ID, () => ({
      status: 200,
      json: {
        state: 'pending',
        one_time: true,
        created_at: Math.floor(Date.now() / 1000),
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      },
    }));

    await page.goto('/#/upload');
    await page.waitForLoadState('networkidle');
    await page.setInputFiles('input[type="file"]', {
      name: 'test.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('file secret'),
    });
    await page.check(RECEIPT_TOGGLE);
    await page.click('button[type="submit"]');

    await expect(
      page.locator('h2:has-text("Secret stored securely")'),
    ).toBeVisible();

    // The upload sent the receipt header.
    const uploadRequest = mockAPI.getLastRequest('/create/file');
    expect(uploadRequest?.payload).toMatchObject({ receipt: true });

    // The result page shows the live receipt panel.
    await expect(
      page.locator('[data-testid="receipt-status-pending"]'),
    ).toBeVisible();

    // The receipt is listed on the Receipts page with a file badge.
    await page.click('header a[href="#/receipts"]');
    const item = page.locator('[data-testid="receipt-list-item"]');
    await expect(item).toHaveCount(1);
    await expect(item).toContainText('File');
  });

  test('removes a receipt after confirmation', async ({ page }) => {
    await setup(page, true);
    await mockAPI.mockSecretReceipt(SECRET_ID, () => ({
      status: 200,
      json: {
        state: 'pending',
        one_time: true,
        created_at: Math.floor(Date.now() / 1000),
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      },
    }));

    await createSecretWithReceipt(page);
    await page.click('header a[href="#/receipts"]');

    await expect(page.locator('[data-testid="receipt-list-item"]')).toHaveCount(
      1,
    );
    await page.click(
      '[data-testid="receipt-list-item"] button:has-text("Remove")',
    );
    await page.click('.modal button:has-text("Remove")');

    await expect(page.locator('text=No read receipts yet')).toBeVisible();
  });
});
