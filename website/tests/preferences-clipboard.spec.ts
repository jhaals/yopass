import { test, expect } from '@playwright/test';
import { MockAPI } from './helpers/mock-api';

test.describe('Remembered options', () => {
  test('restores the last chosen options after a reload', async ({ page }) => {
    const api = new MockAPI(page);
    await api.mockConfigEndpoint();
    await page.goto('/');

    await page.getByRole('radio', { name: '1 week', exact: true }).check();
    await page.getByRole('switch', { name: /One-time download/ }).uncheck();
    await page
      .getByRole('switch', { name: /Generate decryption key/ })
      .uncheck();
    await page.locator('#customPassword').fill('never-stored');

    await page.reload();
    await expect(
      page.getByRole('radio', { name: '1 week', exact: true }),
    ).toBeChecked();
    await expect(
      page.getByRole('switch', { name: /One-time download/ }),
    ).not.toBeChecked();
    await expect(
      page.getByRole('switch', { name: /Generate decryption key/ }),
    ).not.toBeChecked();
    await expect(page.locator('#customPassword')).toHaveValue('');

    // The file form starts from the same remembered options.
    await page.getByRole('tab', { name: 'File' }).click();
    await expect(
      page.getByRole('radio', { name: '1 week', exact: true }),
    ).toBeChecked();
  });

  test('server policy overrides remembered options', async ({ page }) => {
    const api = new MockAPI(page);
    await api.mockConfigEndpoint();
    await page.goto('/');
    await page.getByRole('switch', { name: /One-time download/ }).uncheck();

    await api.mockConfigEndpoint({ FORCE_ONETIME_SECRETS: true });
    await api.mockCreateSecret({ message: 'forced-secret' });
    await page.reload();
    await expect(
      page.getByRole('switch', { name: /One-time download/ }),
    ).toHaveCount(0);
    await page.locator('#secret').fill('policy wins');
    await page.locator('button[type="submit"]').click();
    await expect(page.getByText('Your link is ready')).toBeVisible();
    expect(api.getLastRequest('/create/secret')?.payload).toMatchObject({
      one_time: true,
    });
  });
});

test.describe('Clipboard', () => {
  test('copies the new link automatically', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const api = new MockAPI(page);
    await api.mockConfigEndpoint();
    await api.mockCreateSecret({ message: 'auto-copied-secret' });
    await page.goto('/');
    await page.locator('#secret').fill('copy me');
    await page.locator('button[type="submit"]').click();

    await expect(page.getByRole('status')).toHaveText('Link copied');
    const link = await page.locator('code').first().textContent();
    expect(link).toContain('/#/s/auto-copied-secret/');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      link,
    );
  });

  test('copies without the Clipboard API (plain HTTP)', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', { value: undefined });
      const copied: string[] = [];
      (window as unknown as { copied: string[] }).copied = copied;
      document.execCommand = (command: string) => {
        const selected = document.activeElement as HTMLTextAreaElement | null;
        if (command === 'copy' && selected?.value) copied.push(selected.value);
        return command === 'copy';
      };
    });
    const api = new MockAPI(page);
    await api.mockConfigEndpoint();
    await api.mockCreateSecret({ message: 'fallback-secret' });
    await page.goto('/');
    await page.locator('#secret').fill('copy me too');
    await page.locator('button[type="submit"]').click();
    await expect(page.getByRole('status')).toHaveText('Link copied');

    await page.locator('button[title="Copy short link"]').click();
    await expect(page.locator('button[title="Copy short link"]')).toHaveText(
      'Copied!',
    );
    const copied = await page.evaluate(
      () => (window as unknown as { copied: string[] }).copied,
    );
    expect(copied.at(-1)).toMatch(/\/#\/s\/fallback-secret$/);
  });
});
