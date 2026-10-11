import { test, expect } from '@playwright/test';
import { MockAPI } from './helpers/mock-api';
import { mockResponses, testFiles } from './helpers/test-data';

for (const disabled of [false, true]) {
  for (const kind of ['text', 'file'] as const) {
    test(`${kind} result with DISABLE_ONE_CLICK_LINK=${disabled}`, async ({
      page,
    }) => {
      const api = new MockAPI(page);
      await api.mockConfigEndpoint({ DISABLE_ONE_CLICK_LINK: disabled });
      if (kind === 'text') {
        await api.mockCreateSecret(mockResponses.secretCreated);
        await page.goto('/');
        await page.locator('#secret').fill('A secret to share');
      } else {
        await api.mockUploadFile(mockResponses.fileUploaded);
        await page.goto('/#/upload');
        await page.setInputFiles('input[type="file"]', {
          name: testFiles.textFile.name,
          mimeType: testFiles.textFile.type,
          buffer: Buffer.from(testFiles.textFile.content),
        });
      }
      await page.locator('button[type="submit"]').click();
      await expect(
        page.getByRole('heading', { name: 'Secret stored securely' }),
      ).toBeVisible();

      const combinedLink = page.locator('button[title="Copy one-click link"]');
      if (disabled) {
        await expect(combinedLink).toHaveCount(0);
        await expect(
          page.getByText('One-click link', { exact: true }),
        ).toHaveCount(0);
        await expect(page.locator('code')).toHaveCount(2);
      } else {
        await expect(combinedLink).toBeVisible();
        await expect(page.locator('code')).toHaveCount(3);
      }
      await expect(
        page.locator('button[title="Copy short link"]'),
      ).toBeVisible();
      await expect(
        page.locator('button[title="Copy decryption key"]'),
      ).toBeVisible();
      const shortLink = page.locator('code').nth(disabled ? 0 : 1);
      const prefix = kind === 'text' ? 's' : 'f';
      const id =
        kind === 'text'
          ? mockResponses.secretCreated.message
          : mockResponses.fileUploaded.message;
      await expect(shortLink).toHaveText(
        `${new URL(page.url()).origin}/#/${prefix}/${id}`,
      );
      await expect(page.locator('code').last()).not.toBeEmpty();
    });
  }
}
