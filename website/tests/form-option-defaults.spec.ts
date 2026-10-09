import { test, expect } from '@playwright/test';
import { MockAPI } from './helpers/mock-api';

for (const form of ['text', 'file'] as const) {
  for (const scenario of [
    'unchanged',
    'configured',
    'overridden',
    'forced',
    'unavailable',
  ] as const) {
    test(`${form} form checkbox defaults: ${scenario}`, async ({ page }) => {
      const api = new MockAPI(page);
      const configured = scenario !== 'unchanged';
      const forced = scenario === 'forced';
      const available = scenario !== 'unavailable';
      await api.mockConfigEndpoint({
        READ_RECEIPTS: available,
        ...(configured
          ? {
              DEFAULT_ONETIME_SECRETS: false,
              DEFAULT_READ_RECEIPT: true,
            }
          : {}),
        FORCE_ONETIME_SECRETS: forced,
      });
      const wantsReceipt = available && configured && scenario !== 'overridden';
      const receiptResponse = wantsReceipt
        ? { receipt_token: 'default-receipt-token' }
        : {};
      await api.mockCreateSecret({
        message: 'default-options-secret',
        ...receiptResponse,
      });
      await api.mockUploadFile({
        message: 'default-options-file',
        ...receiptResponse,
      });
      for (const id of ['default-options-secret', 'default-options-file']) {
        await api.mockSecretReceipt(id, () => ({
          status: 200,
          json: { state: 'pending' },
        }));
      }
      await page.goto(form === 'text' ? '/' : '/#/upload');

      const oneTime = page.getByRole('checkbox', { name: 'One-time download' });
      const receipt = page.getByRole('checkbox', { name: /Read receipt/ });
      if (forced) {
        await expect(oneTime).toHaveCount(0);
      } else {
        await expect(oneTime).toBeChecked({ checked: !configured });
      }
      if (available) {
        await expect(receipt).toBeChecked({ checked: configured });
      } else {
        await expect(receipt).toHaveCount(0);
      }
      if (scenario === 'overridden') {
        // Defaults are starting values; the sender can choose the opposite.
        await oneTime.check();
        await receipt.uncheck();
      }
      if (form === 'text') {
        await page.locator('#secret').fill('Test checkbox defaults');
      } else {
        await page.locator('input[type="file"]').setInputFiles({
          name: 'defaults.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('Test checkbox defaults'),
        });
      }
      await page.locator('button[type="submit"]').click();
      await expect(
        page.getByRole('heading', { name: 'Secret stored securely' }),
      ).toBeVisible();
      const request = api.getLastRequest(
        form === 'text' ? '/create/secret' : '/create/file',
      );
      expect(request?.payload).toMatchObject({
        [form === 'text' ? 'one_time' : 'oneTime']:
          forced || !configured || scenario === 'overridden',
        receipt: available && configured && scenario !== 'overridden',
      });
    });
  }
}
