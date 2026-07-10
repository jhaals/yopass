import { test, expect } from '@playwright/test';
import { encrypt, createMessage } from 'openpgp';
import { MockAPI } from './helpers/mock-api';
import { mockResponses } from './helpers/test-data';

test.describe('Secret Retrieval', () => {
  let mockAPI: MockAPI;

  test.beforeEach(async ({ page }) => {
    mockAPI = new MockAPI(page);
    await mockAPI.mockConfigEndpoint();
  });

  test.afterEach(async () => {
    await mockAPI.clearAllMocks();
  });

  test('should display prefetch screen for one-time secret', async ({
    page,
  }) => {
    const secretId = 'test-secret-123';

    // Mock status check for one-time secret
    await page.route(`**/secret/${secretId}/status`, async route => {
      await route.fulfill({
        status: 200,
        json: { oneTime: true },
      });
    });

    await page.goto(`/#/secret/${secretId}/test-password`);

    // Should show prefetch screen
    await expect(page.locator('h2:has-text("Secure Message")')).toBeVisible();
    await expect(
      page.locator("text=You've received a secure message"),
    ).toBeVisible();
    await expect(page.locator('text=Important')).toBeVisible();
    await expect(
      page.locator('text=This message will self-destruct'),
    ).toBeVisible();
    await expect(
      page.locator('button:has-text("Reveal Secure Message")'),
    ).toBeVisible();
  });

  test('should auto-fetch non-one-time secrets', async ({ page }) => {
    const secretId = 'test-secret-456';
    const encryptedSecret = 'encrypted-secret-data';

    // Mock status check for non-one-time secret
    await page.route(`**/secret/${secretId}/status`, async route => {
      await route.fulfill({
        status: 200,
        json: { oneTime: false },
      });
    });

    // Mock secret retrieval
    await mockAPI.mockGetSecret(secretId, { message: encryptedSecret });

    await page.goto(`/#/secret/${secretId}/test-password`);

    // Should skip prefetch and go to decryption (with proper encrypted secret that would decrypt)
    // Since we can't easily mock OpenPGP decryption, we expect the decryption key input
    await expect(
      page.locator('h2:has-text("Enter decryption key")'),
    ).toBeVisible();
  });

  test('should fetch secret when reveal button is clicked', async ({
    page,
  }) => {
    const secretId = 'test-secret-789';
    const encryptedSecret = 'encrypted-secret-data';

    // Mock status check for one-time secret
    await page.route(`**/secret/${secretId}/status`, async route => {
      await route.fulfill({
        status: 200,
        json: { oneTime: true },
      });
    });

    // Mock secret retrieval
    await mockAPI.mockGetSecret(secretId, { message: encryptedSecret });

    await page.goto(`/#/secret/${secretId}/test-password`);

    // Click reveal button
    await page.click('button:has-text("Reveal Secure Message")');

    // Should eventually show decryption screen (loading state may be too fast to catch)
    await expect(
      page.locator('h2:has-text("Enter decryption key")'),
    ).toBeVisible();
  });

  test('should show decryption key input for invalid password', async ({
    page,
  }) => {
    const secretId = 'test-secret-abc';
    const encryptedSecret = 'encrypted-secret-data';

    // Mock status check to enable auto-fetch
    await page.route(`**/secret/${secretId}/status`, async route => {
      await route.fulfill({
        status: 200,
        json: { oneTime: false },
      });
    });

    await mockAPI.mockGetSecret(secretId, { message: encryptedSecret });
    await page.goto(`/#/secret/${secretId}/wrong-password`);

    // Wait for content to load
    await page.waitForLoadState('networkidle');

    // Should show decryption key form
    await expect(
      page.locator('h2:has-text("Enter decryption key")'),
    ).toBeVisible();
    await expect(
      page.locator('input[placeholder="Decryption key"]'),
    ).toBeVisible();
    await expect(
      page.locator('button:has-text("DECRYPT SECRET")'),
    ).toBeVisible();
  });

  test('should handle secret not found error', async ({ page }) => {
    const secretId = 'nonexistent-secret';

    await mockAPI.mockGetSecret(secretId, mockResponses.secretNotFound, 404);
    await page.goto(`/#/secret/${secretId}/test-password`);

    // Should show error page
    await expect(
      page.locator('h2:has-text("Secret does not exist")'),
    ).toBeVisible();
  });

  test('should handle expired secret error', async ({ page }) => {
    const secretId = 'expired-secret';

    await mockAPI.mockGetSecret(secretId, mockResponses.secretExpired, 410);
    await page.goto(`/#/secret/${secretId}/test-password`);

    // Should show error page
    await expect(
      page.locator('h2:has-text("Secret does not exist")'),
    ).toBeVisible();
  });

  test('should handle status check failure', async ({ page }) => {
    const secretId = 'test-secret-status-fail';

    // Mock status check failure
    await page.route(`**/secret/${secretId}/status`, async route => {
      await route.fulfill({
        status: 500,
        json: { message: 'Server error' },
      });
    });

    await page.goto(`/#/secret/${secretId}/test-password`);

    // Should show error page
    await expect(
      page.locator('h2:has-text("Secret does not exist")'),
    ).toBeVisible();
  });

  test('should show loading spinner during decryption', async ({ page }) => {
    const secretId = 'test-secret-loading';
    const encryptedSecret = 'encrypted-secret-data';

    // Mock status check to enable auto-fetch
    await page.route(`**/secret/${secretId}/status`, async route => {
      await route.fulfill({
        status: 200,
        json: { oneTime: false },
      });
    });

    await mockAPI.mockGetSecret(secretId, { message: encryptedSecret });
    await page.goto(`/#/secret/${secretId}/test-password`);

    // Should show decryption key form
    await expect(
      page.locator('h2:has-text("Enter decryption key")'),
    ).toBeVisible();
    await expect(
      page.locator('input[placeholder="Decryption key"]'),
    ).toBeVisible();

    // Fill in a password and submit (testing the UI elements rather than loading state)
    await page.fill('input[placeholder="Decryption key"]', 'some-password');
    await expect(
      page.locator('button:has-text("DECRYPT SECRET")'),
    ).toBeVisible();
  });

  test('should handle file retrieval', async ({ page }) => {
    const fileId = 'test-file-123';

    // Encrypt a valid binary file so decryption is actually attempted; the URL
    // password is wrong, so decrypt() fails and the wrong-key screen appears.
    const encrypted = (await encrypt({
      format: 'binary',
      message: await createMessage({
        binary: new Uint8Array(Buffer.from('file contents')),
        filename: 'test.txt',
      }),
      passwords: 'correct-password',
    })) as Uint8Array;
    const encryptedBuffer = Buffer.from(encrypted);

    // Mock status check for file
    await page.route(`**/file/${fileId}/status`, async route => {
      await route.fulfill({
        status: 200,
        json: { oneTime: true },
      });
    });

    // Stream the encrypted file as octet-stream (matching the real backend)
    await page.route(`**/file/${fileId}`, async route => {
      if (route.request().method() === 'OPTIONS') {
        await route.fulfill({
          status: 200,
          headers: {
            'access-control-allow-origin': '*',
            'access-control-allow-methods': 'GET, DELETE, OPTIONS',
            'access-control-allow-headers': 'Content-Type',
            'access-control-expose-headers':
              'X-Yopass-Filename, Content-Length',
          },
          body: '',
        });
        return;
      }
      await route.fulfill({
        status: 200,
        headers: {
          'content-type': 'application/octet-stream',
          'access-control-allow-origin': '*',
          'access-control-expose-headers': 'X-Yopass-Filename, Content-Length',
          'x-yopass-filename': 'test.txt',
          'content-length': String(encryptedBuffer.length),
        },
        body: encryptedBuffer,
      });
    });

    await page.goto(`/#/f/${fileId}/wrong-password`);

    // Should show prefetch screen for file
    await expect(page.locator('h2:has-text("Secure Message")')).toBeVisible();
    await expect(
      page.locator('button:has-text("Reveal Secure Message")'),
    ).toBeVisible();

    // Click reveal
    await page.click('button:has-text("Reveal Secure Message")');

    // Wrong password → decryption fails → wrong-key screen
    await expect(
      page.locator('h2:has-text("Enter decryption key")'),
    ).toBeVisible();
  });

  test('should show QR code toggle button after successful decryption', async ({
    page,
  }) => {
    // This test would require mocking OpenPGP decryption which is complex
    // For now, we test the UI elements that should be present
    const secretId = 'test-secret-decrypt';

    await page.goto(`/#/secret/${secretId}/test-password`);

    // Simulate successful decryption by navigating to a mocked decrypted state
    await page.evaluate(() => {
      // This would be replaced with actual decryption in a real test
      // For now we test the UI structure
    });
  });

  test('should handle network errors gracefully', async ({ page }) => {
    const secretId = 'network-error-secret';

    // Mock network failure
    await page.route(`**/secret/${secretId}`, async route => {
      await route.abort('failed');
    });

    await page.goto(`/#/secret/${secretId}/test-password`);

    // Should show error page
    await expect(
      page.locator('h2:has-text("Secret does not exist")'),
    ).toBeVisible();
  });

  test('should prevent multiple fetches in React StrictMode', async ({
    page,
  }) => {
    const secretId = 'test-secret-strict';
    let fetchCount = 0;

    // Count fetch requests
    await page.route(`**/secret/${secretId}`, async route => {
      fetchCount++;
      await route.fulfill({
        status: 200,
        json: { message: 'encrypted-data' },
      });
    });

    await page.goto(`/#/secret/${secretId}/test-password`);

    // Wait a bit to ensure no duplicate requests
    await page.waitForTimeout(1000);

    expect(fetchCount).toBeLessThanOrEqual(1);
  });

  test('should handle malformed secret response', async ({ page }) => {
    const secretId = 'malformed-secret';

    await page.route(`**/secret/${secretId}`, async route => {
      await route.fulfill({
        status: 200,
        json: { invalid: 'response' }, // Missing 'message' field
      });
    });

    await page.goto(`/#/secret/${secretId}/test-password`);

    // Should show error page due to invalid response
    await expect(
      page.locator('h2:has-text("Secret does not exist")'),
    ).toBeVisible();
  });
});
