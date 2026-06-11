import { test, expect, Page } from '@playwright/test';
import { MockAPI } from './helpers/mock-api';

interface StoredRequest {
  public_key: string;
  label: string;
  state: 'pending' | 'fulfilled';
  secret?: string;
  expires_at: number;
  token: string;
}

// Stateful mock of the /request backend. All cryptography (key generation,
// encryption, decryption) still runs for real in the browser.
async function mockRequestAPI(page: Page, store: Map<string, StoredRequest>) {
  let counter = 0;
  const headers = { 'content-type': 'application/json' };

  await page.route('**/request', async route => {
    const body = JSON.parse(route.request().postData() || '{}');
    counter += 1;
    const id = `e2eRequestId00000000${counter}`.slice(-22);
    const token = `e2e-token-${counter}`;
    const expires_at = Math.floor(Date.now() / 1000) + body.expiration;
    store.set(id, {
      public_key: body.public_key,
      label: body.label || '',
      state: 'pending',
      expires_at,
      token,
    });
    await route.fulfill({
      status: 200,
      headers,
      json: { id, token, expires_at },
    });
  });

  await page.route('**/request/**', async route => {
    const url = new URL(route.request().url());
    const parts = url.pathname.split('/').filter(Boolean);
    const id = parts[1];
    const sub = parts[2];
    const method = route.request().method();
    const request = store.get(id);

    if (!request) {
      await route.fulfill({
        status: 404,
        headers,
        json: { message: 'Secret request not found' },
      });
      return;
    }

    const token = route.request().headers()['x-yopass-request-token'];

    if (!sub && method === 'GET') {
      await route.fulfill({
        status: 200,
        headers,
        json: {
          public_key: request.public_key,
          label: request.label,
          state: request.state,
          expires_at: request.expires_at,
        },
      });
      return;
    }

    if (!sub && method === 'DELETE') {
      if (token !== request.token) {
        await route.fulfill({
          status: 401,
          headers,
          json: { message: 'Invalid request token' },
        });
        return;
      }
      store.delete(id);
      await route.fulfill({ status: 204, headers, body: '' });
      return;
    }

    if (sub === 'secret' && method === 'POST') {
      const body = JSON.parse(route.request().postData() || '{}');
      request.state = 'fulfilled';
      request.secret = body.message;
      await route.fulfill({
        status: 200,
        headers,
        json: { message: 'secret provided' },
      });
      return;
    }

    if (sub === 'secret' && method === 'GET') {
      if (token !== request.token) {
        await route.fulfill({
          status: 401,
          headers,
          json: { message: 'Invalid request token' },
        });
        return;
      }
      const secret = request.secret;
      store.delete(id);
      await route.fulfill({ status: 200, headers, json: { message: secret } });
      return;
    }

    if (sub === 'key' && method === 'PUT') {
      if (token !== request.token) {
        await route.fulfill({
          status: 401,
          headers,
          json: { message: 'Invalid request token' },
        });
        return;
      }
      const body = JSON.parse(route.request().postData() || '{}');
      request.public_key = body.public_key;
      await route.fulfill({
        status: 200,
        headers,
        json: { message: 'public key updated' },
      });
      return;
    }

    await route.fulfill({
      status: 404,
      headers,
      json: { message: 'not found' },
    });
  });
}

test.describe('Secret Requests', () => {
  let mockAPI: MockAPI;
  let store: Map<string, StoredRequest>;

  test.beforeEach(async ({ page }) => {
    mockAPI = new MockAPI(page);
    store = new Map();
    await mockAPI.mockConfigEndpoint({ SECRET_REQUESTS: true });
    await mockRequestAPI(page, store);
  });

  test.afterEach(async () => {
    await mockAPI.clearAllMocks();
  });

  test('full flow: create request, provide secret, view decrypted secret', async ({
    page,
  }) => {
    // Requester creates a request (generates a real key pair in the browser)
    await page.goto('/#/request');
    await page.fill('#request-label', 'Staging DB password');
    await page.click('button:has-text("Create request link")');

    await expect(page.locator('h2:has-text("Request created")')).toBeVisible({
      timeout: 15000,
    });
    const link = await page.locator('code').textContent();
    expect(link).toContain('/#/r/');

    // Responder opens the link and submits a secret (encrypted in browser)
    await page.goto(link!);
    await expect(
      page.locator('h2:has-text("Someone requested a secret")'),
    ).toBeVisible();
    await expect(page.locator('text=Staging DB password')).toBeVisible();
    await page.fill('#provide-secret', 'hunter2-super-secret');
    await page.click('button:has-text("Encrypt and send")');
    await expect(page.locator('h2:has-text("Secret sent")')).toBeVisible({
      timeout: 15000,
    });

    // The ciphertext stored on the "server" must be PGP encrypted
    const stored = [...store.values()][0];
    expect(stored.state).toBe('fulfilled');
    expect(stored.secret).toContain('-----BEGIN PGP MESSAGE-----');
    expect(stored.secret).not.toContain('hunter2-super-secret');

    // Requester sees the fulfilled state and decrypts the secret locally
    await page.goto('/#/requests');
    await expect(page.locator('text=Secret provided')).toBeVisible();
    await page.click('button:has-text("View secret")');
    await expect(page.locator('h3:has-text("Secret received")')).toBeVisible({
      timeout: 15000,
    });
    await expect(page.locator('pre')).toHaveText('hunter2-super-secret');

    // The request was deleted from the server and is marked as collected
    expect(store.size).toBe(0);
    await page.click('button:has-text("Close")');
    await expect(page.locator('.badge:has-text("Collected")')).toBeVisible();
  });

  test('pending request can be revoked from the list', async ({ page }) => {
    await page.goto('/#/request');
    await page.click('button:has-text("Create request link")');
    await expect(page.locator('h2:has-text("Request created")')).toBeVisible({
      timeout: 15000,
    });

    await page.goto('/#/requests');
    await expect(page.locator('text=Awaiting secret')).toBeVisible();

    await page.click('button[aria-label="More actions"]');
    await page.click('button:has-text("Revoke")');
    await expect(
      page.locator('h3:has-text("Revoke this request?")'),
    ).toBeVisible();
    await page.click('button:has-text("Revoke request")');

    await expect(page.locator('.badge:has-text("Revoked")')).toBeVisible();
    expect(store.size).toBe(0);
  });

  test('opening a revoked or expired link shows an error', async ({ page }) => {
    await page.goto('/#/r/doesNotExist12345678ab/abcdef0123456789');
    await expect(
      page.locator('h2:has-text("Request not available")'),
    ).toBeVisible();
  });

  test('tampered public key fails the fingerprint verification', async ({
    page,
  }) => {
    await page.goto('/#/request');
    await page.click('button:has-text("Create request link")');
    await expect(page.locator('h2:has-text("Request created")')).toBeVisible({
      timeout: 15000,
    });
    const link = await page.locator('code').textContent();

    // Simulate a malicious server swapping the public key after creation:
    // point the stored request at a different (freshly generated) key by
    // changing the fingerprint segment of the link instead.
    const tamperedLink = link!.replace(/\/[0-9a-f]{16}$/, '/0123456789abcdef');
    await page.goto(tamperedLink);
    await expect(
      page.locator('h2:has-text("Key verification failed")'),
    ).toBeVisible();
  });

  test('requests navbar entry is hidden when feature is disabled', async ({
    page,
  }) => {
    await mockAPI.mockConfigEndpoint({ SECRET_REQUESTS: false });
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('a[href="#/requests"]')).not.toBeVisible();
  });

  test('navbar badge counts fulfilled requests and clears after collection', async ({
    page,
  }) => {
    // Create and fulfill a request
    await page.goto('/#/request');
    await page.click('button:has-text("Create request link")');
    await expect(page.locator('h2:has-text("Request created")')).toBeVisible({
      timeout: 15000,
    });
    const link = await page.locator('code').textContent();

    // No secret provided yet — no badge
    await page.goto('/');
    await expect(
      page.locator('[data-testid="requests-badge"]'),
    ).not.toBeVisible();

    await page.goto(link!);
    await page.fill('#provide-secret', 'badge-test-secret');
    await page.click('button:has-text("Encrypt and send")');
    await expect(page.locator('h2:has-text("Secret sent")')).toBeVisible({
      timeout: 15000,
    });

    // Badge shows one waiting secret
    await page.goto('/');
    await expect(page.locator('[data-testid="requests-badge"]')).toHaveText(
      '1',
    );

    // Collecting the secret clears the badge
    await page.goto('/#/requests');
    await page.click('button:has-text("View secret")');
    await expect(page.locator('h3:has-text("Secret received")')).toBeVisible({
      timeout: 15000,
    });
    await page.click('button:has-text("Close")');
    await expect(
      page.locator('[data-testid="requests-badge"]'),
    ).not.toBeVisible();
  });

  test('collected requests can be cleared from the list', async ({ page }) => {
    // Create, fulfill, and collect a request
    await page.goto('/#/request');
    await page.click('button:has-text("Create request link")');
    await expect(page.locator('h2:has-text("Request created")')).toBeVisible({
      timeout: 15000,
    });
    const link = await page.locator('code').textContent();
    await page.goto(link!);
    await page.fill('#provide-secret', 'clear-me');
    await page.click('button:has-text("Encrypt and send")');
    await expect(page.locator('h2:has-text("Secret sent")')).toBeVisible({
      timeout: 15000,
    });
    await page.goto('/#/requests');
    await page.click('button:has-text("View secret")');
    await expect(page.locator('h3:has-text("Secret received")')).toBeVisible({
      timeout: 15000,
    });
    await page.click('button:has-text("Close")');
    await expect(page.locator('.badge:has-text("Collected")')).toBeVisible();

    // Clear collected entries
    await page.click('button:has-text("Clear collected (1)")');
    await expect(
      page.locator('h3:has-text("Clear collected requests?")'),
    ).toBeVisible();
    await page.click('.modal button:has-text("Clear collected")');
    await expect(page.locator('text=No secret requests yet')).toBeVisible();
  });

  test('purge all revokes active requests and wipes the local store', async ({
    page,
  }) => {
    // Two pending requests (navigate away in between to remount the form)
    for (let i = 0; i < 2; i++) {
      await page.goto('/#/requests');
      await page.goto('/#/request');
      await page.click('button:has-text("Create request link")');
      await expect(page.locator('h2:has-text("Request created")')).toBeVisible({
        timeout: 15000,
      });
    }
    await page.goto('/#/requests');
    await expect(
      page.locator('.badge:has-text("Awaiting secret")'),
    ).toHaveCount(2);
    expect(store.size).toBe(2);

    await page.click('button:has-text("Purge all")');
    await expect(
      page.locator('h3:has-text("Purge all requests?")'),
    ).toBeVisible();
    await page.click('button:has-text("Purge everything")');

    // Server-side requests were revoked and the local list is empty
    await expect(page.locator('text=No secret requests yet')).toBeVisible();
    expect(store.size).toBe(0);

    // The old links no longer work
    await page.goto('/#/r/e2eRequestId000000001/abcdef0123456789');
    await expect(
      page.locator('h2:has-text("Request not available")'),
    ).toBeVisible();
  });
});
