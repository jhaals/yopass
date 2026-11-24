import { test, expect, type Page } from '@playwright/test';
import { MockAPI } from './helpers/mock-api';
import { testSecrets } from './helpers/test-data';

const NOTIFY_TOGGLE =
  'label:has-text("Email me when the secret is opened") input[type="checkbox"]';

test.describe('Email notifications', () => {
  let mockAPI: MockAPI;

  test.afterEach(async () => {
    await mockAPI.clearAllMocks();
  });

  async function setup(
    page: Page,
    signedIn: boolean,
    emailNotifications = true,
  ) {
    mockAPI = new MockAPI(page);
    await mockAPI.mockConfigEndpoint({
      READ_RECEIPTS: true,
      OIDC_ENABLED: true,
      EMAIL_NOTIFICATIONS: emailNotifications,
    });
    await page.route('**/auth/me', route =>
      route.fulfill({ status: signedIn ? 200 : 401, json: {} }),
    );
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('h2:has-text("Encrypt message")')).toBeVisible();
  }

  test('the option is only offered to a signed-in user on a mail-enabled server', async ({
    page,
  }) => {
    await setup(page, false);
    await expect(page.locator(NOTIFY_TOGGLE)).not.toBeVisible();
    await setup(page, true, false);
    await expect(page.locator(NOTIFY_TOGGLE)).not.toBeVisible();
  });

  test('opting in sends the label and keeps the receipt that comes back', async ({
    page,
  }) => {
    await setup(page, true);
    await mockAPI.mockCreateSecret({
      message: 'notify-secret-id',
      receipt_token: 'receipt-token-abc123',
    });
    await expect(page.locator('#emailLabel')).not.toBeVisible();
    await page.check(NOTIFY_TOGGLE);
    await page.fill('#emailLabel', ' Prod DB password ');
    await page.fill(
      'textarea[placeholder="Enter your secret..."]',
      testSecrets.simple.message,
    );
    // The navbar's logout button is a submit button too once signed in.
    await page.click('form:has(#secret) button[type="submit"]');

    await expect(
      page.locator('h2:has-text("Secret stored securely")'),
    ).toBeVisible();
    expect(mockAPI.getLastRequest('/secret')?.payload).toMatchObject({
      notify: true,
      label: 'Prod DB password',
    });
  });

  test('a secret request can ask for a mail when it is answered', async ({
    page,
  }) => {
    mockAPI = new MockAPI(page);
    await mockAPI.mockConfigEndpoint({
      SECRET_REQUESTS: true,
      OIDC_ENABLED: true,
      EMAIL_NOTIFICATIONS: true,
    });
    await page.route('**/auth/me', route =>
      route.fulfill({ status: 200, json: {} }),
    );
    let payload: Record<string, unknown> = {};
    await page.route('**/request', async route => {
      payload = route.request().postDataJSON();
      await route.fulfill({
        json: {
          id: 'e2eRequestId0000000001',
          token: 'e2e-token',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        },
      });
    });
    await page.goto('/#/request');
    await page.check(
      'label:has-text("Email me when the secret is provided") input[type="checkbox"]',
    );
    await page.click('button:has-text("Create request link")');
    await expect(page.locator('h2:has-text("Request created")')).toBeVisible({
      timeout: 15000,
    });
    expect(payload.notify).toBe(true);
  });
});
