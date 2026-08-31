import { test, expect, Page } from '@playwright/test';
import { encrypt, createMessage } from 'openpgp';
import { MockAPI } from './helpers/mock-api';

// The code the mock backend "mails". Real delivery is out of scope for an E2E
// run; what matters here is that the ciphertext stays withheld until a code is
// accepted, and that a non-matching address gives nothing away.
const VALID_CODE = '123456';
const BOUND_EMAIL = 'alice@example.com';
const VERIFICATION_TOKEN = 'e2e-verification-token';
const SECRET_ID = 'test-bound-secret-1';
const DECRYPTION_KEY = 'correct-password';
const PLAINTEXT = 'the-bound-secret-value';

interface VerifyState {
  // Codes issued so far, backing the no-send-on-mismatch assertion.
  sends: string[];
  verified: boolean;
}

// Stateful mock of a recipient-bound secret, mirroring authorizeRecipient on
// the server: the ciphertext is released only against a verification token.
// Decryption still runs for real in the browser.
async function mockBoundSecret(page: Page, state: VerifyState) {
  const headers = { 'content-type': 'application/json' };

  const ciphertext = await encrypt({
    message: await createMessage({ text: PLAINTEXT }),
    passwords: DECRYPTION_KEY,
  });

  await page.route(`**/secret/${SECRET_ID}/verify`, async route => {
    const body = JSON.parse(route.request().postData() || '{}');

    if (!body.code) {
      // Requesting a code. The server answers 204 whether or not the address
      // matches; only a matching address actually triggers a send.
      if (body.email === BOUND_EMAIL) {
        state.sends.push(body.email);
      }
      await route.fulfill({ status: 204, headers });
      return;
    }

    if (body.email === BOUND_EMAIL && body.code === VALID_CODE) {
      state.verified = true;
      await route.fulfill({
        status: 200,
        headers,
        json: { token: VERIFICATION_TOKEN },
      });
      return;
    }
    await route.fulfill({
      status: 403,
      headers,
      json: { message: 'Invalid or expired verification code' },
    });
  });

  await page.route(`**/secret/${SECRET_ID}`, async route => {
    const token = route.request().headers()['x-yopass-verification-token'];
    if (token !== VERIFICATION_TOKEN) {
      await route.fulfill({
        status: 403,
        headers,
        json: {
          message: 'Recipient verification required',
          verification_required: true,
        },
      });
      return;
    }
    await route.fulfill({
      status: 200,
      headers,
      json: { message: ciphertext },
    });
  });
}

// Drives the two-step form up to the point where a code can be entered.
async function requestCode(page: Page, email: string) {
  await page.fill('#verification-email', email);
  await page.click('button:has-text("Send verification code")');
  await expect(page.locator('#verification-code')).toBeVisible({
    timeout: 15000,
  });
}

test.describe('Recipient Verification', () => {
  let mockAPI: MockAPI;
  let state: VerifyState;

  test.beforeEach(async ({ page }) => {
    mockAPI = new MockAPI(page);
    await mockAPI.mockConfigEndpoint({
      RECIPIENT_VERIFICATION: true,
      PREFETCH_SECRET: false,
    });
    state = { sends: [], verified: false };
    await mockBoundSecret(page, state);
  });

  test.afterEach(async () => {
    await mockAPI.clearAllMocks();
  });

  test('withholds the secret until a code is accepted', async ({ page }) => {
    await page.goto(`/#/s/${SECRET_ID}/${DECRYPTION_KEY}`);
    await page.waitForLoadState('networkidle');

    // The verification form stands in for the secret.
    await expect(
      page.locator('h2:has-text("Verify your email")'),
    ).toBeVisible();
    await expect(page.locator('body')).not.toContainText(PLAINTEXT);

    await requestCode(page, BOUND_EMAIL);
    await page.fill('#verification-code', VALID_CODE);
    await page.click('button:has-text("Verify and open")');

    // Decryption runs for real, so allow it time.
    await expect(page.locator(`text=${PLAINTEXT}`)).toBeVisible({
      timeout: 15000,
    });
    expect(state.verified).toBe(true);
  });

  test('rejects a wrong code without releasing the secret', async ({
    page,
  }) => {
    await page.goto(`/#/s/${SECRET_ID}/${DECRYPTION_KEY}`);
    await page.waitForLoadState('networkidle');

    await requestCode(page, BOUND_EMAIL);
    await page.fill('#verification-code', '000000');
    await page.click('button:has-text("Verify and open")');

    await expect(page.locator('[role="alert"]')).toBeVisible({
      timeout: 15000,
    });
    await expect(page.locator('body')).not.toContainText(PLAINTEXT);
    expect(state.verified).toBe(false);
  });

  test('gives nothing away for a non-matching address', async ({ page }) => {
    await page.goto(`/#/s/${SECRET_ID}/${DECRYPTION_KEY}`);
    await page.waitForLoadState('networkidle');

    // The UI advances exactly as it would for a bound recipient...
    await requestCode(page, 'mallory@example.com');
    // ...but no code was ever issued.
    expect(state.sends).toHaveLength(0);
  });

  test('never sends the decryption key to the server', async ({ page }) => {
    await page.goto(`/#/s/${SECRET_ID}/${DECRYPTION_KEY}`);
    await page.waitForLoadState('networkidle');

    await requestCode(page, BOUND_EMAIL);
    await page.fill('#verification-code', VALID_CODE);
    await page.click('button:has-text("Verify and open")');
    await expect(page.locator(`text=${PLAINTEXT}`)).toBeVisible({
      timeout: 15000,
    });

    // The key lives in the URL fragment, which browsers never transmit. Assert
    // it also never reached a request URL or body.
    for (const request of mockAPI.getAllRequests()) {
      expect(request.url).not.toContain(DECRYPTION_KEY);
      expect(JSON.stringify(request.payload ?? '')).not.toContain(
        DECRYPTION_KEY,
      );
    }
  });

  test('offers the recipients field when the feature is on', async ({
    page,
  }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('#recipients')).toBeVisible();
  });

  test('hides the recipients field when the feature is off', async ({
    page,
  }) => {
    await mockAPI.mockConfigEndpoint({ RECIPIENT_VERIFICATION: false });
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('#recipients')).toHaveCount(0);
  });
});
