import { test, expect } from '@playwright/test';
import { readMessage, decrypt, enums } from 'openpgp';
import { MockAPI } from './helpers/mock-api';
import { testSecrets, mockResponses } from './helpers/test-data';

// Extracts the S2K (key derivation) type from the symmetric-key encrypted
// session key packet of an armored PGP message.
async function messageS2KType(armoredMessage: string): Promise<string> {
  const message = await readMessage({ armoredMessage });
  const skesk = message.packets.filterByTag(
    enums.packet.symEncryptedSessionKey,
  )[0] as unknown as { s2k: { type: string } };
  return skesk.s2k.type;
}

async function createSecretAndCapturePayload(
  page: import('@playwright/test').Page,
  mockAPI: MockAPI,
): Promise<{ message: string; oneClickLink: string }> {
  await mockAPI.mockCreateSecret(mockResponses.secretCreated);
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await page.fill(
    'textarea[placeholder="Enter your secret..."]',
    testSecrets.simple.message,
  );
  await page.click('button[type="submit"]');
  await expect(
    page.locator('h2:has-text("Secret stored securely")'),
  ).toBeVisible();

  const lastRequest = mockAPI.getLastRequest('/secret');
  expect(lastRequest).toBeDefined();
  const payload = lastRequest?.payload as { message: string };

  const oneClickLink = await page
    .locator('code', { hasText: '/#/s/' })
    .first()
    .innerText();

  return { message: payload.message, oneClickLink };
}

test.describe('Argon2 key derivation', () => {
  let mockAPI: MockAPI;

  test.beforeEach(async ({ page }) => {
    mockAPI = new MockAPI(page);
  });

  test.afterEach(async () => {
    await mockAPI.clearAllMocks();
  });

  test('encrypts with argon2 when the server enables ARGON2', async ({
    page,
  }) => {
    await mockAPI.mockConfigEndpoint({ ARGON2: true });
    const { message, oneClickLink } = await createSecretAndCapturePayload(
      page,
      mockAPI,
    );

    expect(await messageS2KType(message)).toBe('argon2');

    // The ciphertext must decrypt with the key from the generated link.
    const key = oneClickLink.split('/').pop() as string;
    const decrypted = await decrypt({
      message: await readMessage({ armoredMessage: message }),
      passwords: key,
    });
    expect(decrypted.data).toBe(testSecrets.simple.message);
  });

  test('uses the default key derivation when ARGON2 is not enabled', async ({
    page,
  }) => {
    await mockAPI.mockConfigEndpoint();
    const { message } = await createSecretAndCapturePayload(page, mockAPI);

    expect(await messageS2KType(message)).toBe('iterated');
  });
});
