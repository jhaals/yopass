import { test, expect } from '@playwright/test';
import { encrypt, createMessage } from 'openpgp';
import { MockAPI } from './helpers/mock-api';

/**
 * Encrypt plaintext with a symmetric password using OpenPGP armored format,
 * matching what Decryptor.tsx expects (armoredMessage + utf8 format).
 */
async function encryptText(
  plaintext: string,
  password: string,
): Promise<string> {
  const encrypted = await encrypt({
    message: await createMessage({ text: plaintext }),
    passwords: password,
    format: 'armored',
  });
  return encrypted as string;
}

test.describe('QR Code', () => {
  let mockAPI: MockAPI;

  test.beforeEach(async ({ page }) => {
    mockAPI = new MockAPI(page);
    // Disable prefetch so the secret is fetched immediately without a status check
    await mockAPI.mockConfigEndpoint({ PREFETCH_SECRET: false });
  });

  test.afterEach(async () => {
    await mockAPI.clearAllMocks();
  });

  test('renders QR code SVG after decryption and clicking Show QR Code', async ({
    page,
  }) => {
    const secretId = 'qr-test-001';
    const password = 'qr-password-001';
    const plaintext = 'Hello, QR Code!';

    const encryptedMessage = await encryptText(plaintext, password);
    await mockAPI.mockGetSecret(secretId, { message: encryptedMessage });

    // Capture React / JavaScript errors to ensure no crash occurs
    const pageErrors: string[] = [];
    page.on('pageerror', err => pageErrors.push(err.message));

    await page.goto(`/#/s/${secretId}/${password}`);

    // Wait for the decrypted message heading
    await expect(page.locator('h2:has-text("Decrypted Message")')).toBeVisible({
      timeout: 15000,
    });

    // Decrypted text should be visible
    await expect(page.locator(`text=${plaintext}`)).toBeVisible();

    // "Show QR Code" button should be present
    const showQRButton = page.locator('button[aria-label="Show QR Code"]');
    await expect(showQRButton).toBeVisible();

    // Click to show QR code
    await showQRButton.click();

    // The button label should now read "Hide QR Code"
    await expect(
      page.locator('button[aria-label="Hide QR Code"]'),
    ).toBeVisible();

    // An SVG with role="img" (rendered by QRCodeSVG) should be visible
    const qrSvg = page.locator('svg[role="img"]');
    await expect(qrSvg).toBeVisible();

    // The SVG must contain actual QR path data
    const pathCount = await qrSvg.locator('path').count();
    expect(pathCount).toBeGreaterThan(0);

    // No JavaScript errors should have occurred (guards against React error #130)
    expect(pageErrors).toHaveLength(0);
  });

  test('hides QR code when Hide QR Code button is clicked', async ({
    page,
  }) => {
    const secretId = 'qr-test-002';
    const password = 'qr-password-002';
    const plaintext = 'Toggle QR code visibility';

    const encryptedMessage = await encryptText(plaintext, password);
    await mockAPI.mockGetSecret(secretId, { message: encryptedMessage });

    await page.goto(`/#/s/${secretId}/${password}`);
    await expect(page.locator('h2:has-text("Decrypted Message")')).toBeVisible({
      timeout: 15000,
    });

    // Show the QR code
    await page.click('button[aria-label="Show QR Code"]');
    await expect(page.locator('svg[role="img"]')).toBeVisible();

    // Hide the QR code
    await page.click('button[aria-label="Hide QR Code"]');
    await expect(page.locator('svg[role="img"]')).not.toBeVisible();

    // Button label reverts to "Show QR Code"
    await expect(
      page.locator('button[aria-label="Show QR Code"]'),
    ).toBeVisible();
  });

  test('does not show QR code button for secrets longer than 500 characters', async ({
    page,
  }) => {
    const secretId = 'qr-test-003';
    const password = 'qr-password-003';
    // 501 characters — exceeds the tooLongForQRCode threshold
    const longPlaintext = 'A'.repeat(501);

    const encryptedMessage = await encryptText(longPlaintext, password);
    await mockAPI.mockGetSecret(secretId, { message: encryptedMessage });

    await page.goto(`/#/s/${secretId}/${password}`);
    await expect(page.locator('h2:has-text("Decrypted Message")')).toBeVisible({
      timeout: 15000,
    });

    // QR code button must NOT appear for long secrets
    await expect(
      page.locator('button[aria-label="Show QR Code"]'),
    ).not.toBeVisible();
  });
});
