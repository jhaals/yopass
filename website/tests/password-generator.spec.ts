import { test, expect, type Page } from '@playwright/test';
import { MockAPI } from './helpers/mock-api';

test.describe('Password generator', () => {
  test.beforeEach(async ({ page }) => {
    await new MockAPI(page).mockConfigEndpoint();
    await page.goto('/');
  });

  function generated(page: Page) {
    return page.getByRole('status', { name: 'Password generator' });
  }

  // Character sets are toggled through their visible chip (the label).
  function chip(page: Page, name: string) {
    return page.locator('label', {
      has: page.getByRole('checkbox', { name }),
    });
  }

  test('offers a strong password below the secret form', async ({ page }) => {
    await expect(generated(page)).toHaveText(/^[A-Za-z0-9]{16}$/);
    await expect(page.getByText('Very strong')).toBeVisible();
  });

  test('follows the chosen length and characters', async ({ page }) => {
    await page.getByRole('button', { name: 'Longer' }).click();
    await expect(generated(page)).toHaveText(/^[A-Za-z0-9]{17}$/);

    await chip(page, 'Uppercase letters').click();
    await chip(page, 'Lowercase letters').click();
    await expect(generated(page)).toHaveText(/^[0-9]{17}$/);
    // The last remaining set cannot be turned off.
    await expect(
      page.getByRole('checkbox', { name: 'Numbers' }),
    ).toBeDisabled();

    await chip(page, 'Symbols').click();
    await expect(generated(page)).toHaveText(/^[0-9!#$%&*+\-=?@^_~]{17}$/);
  });

  test('regenerates on demand and remembers the options', async ({ page }) => {
    const first = await generated(page).textContent();
    await page.getByRole('button', { name: 'Generate another' }).click();
    await expect(generated(page)).not.toHaveText(first!);

    await page.getByLabel(/^Length/).fill('24');
    await chip(page, 'Symbols').click();
    await page.reload();
    await expect(page.getByLabel(/^Length/)).toHaveValue('24');
    await expect(page.getByRole('checkbox', { name: 'Symbols' })).toBeChecked();
    await expect(generated(page)).toHaveText(/^.{24}$/);
  });

  test('copies the password', async ({ page }) => {
    await page.addInitScript(() => {
      const written: string[] = [];
      (window as unknown as { written: string[] }).written = written;
      Object.defineProperty(navigator, 'clipboard', {
        value: {
          writeText: async (text: string) => {
            written.push(text);
          },
        },
      });
    });
    await page.reload();
    const section = page.getByRole('region', { name: 'Password generator' });
    await section.getByRole('button', { name: 'Copy' }).click();
    await expect(
      section.getByRole('button', { name: 'Copied!' }),
    ).toBeVisible();
    const written = await page.evaluate(
      () => (window as unknown as { written: string[] }).written,
    );
    expect(written).toEqual([await generated(page).textContent()]);
  });
});
