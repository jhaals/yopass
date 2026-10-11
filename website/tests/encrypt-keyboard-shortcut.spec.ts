import { test, expect } from '@playwright/test';
import { MockAPI } from './helpers/mock-api';
import { mockResponses } from './helpers/test-data';

test.beforeEach(async ({ page }) => {
  const api = new MockAPI(page);
  await api.mockConfigEndpoint();
  await page.goto('/');
});

for (const modifier of ['Control', 'Meta']) {
  test(`${modifier}+Enter encrypts using the selected options`, async ({
    page,
  }) => {
    const api = new MockAPI(page);
    await api.mockCreateSecret(mockResponses.secretCreated);
    await page.locator('#secret').fill('Keyboard shortcut secret');
    await page.locator('input[value="86400"]').check();
    await page.locator('#secret').press(`${modifier}+Enter`);
    await expect(
      page.getByRole('heading', { name: 'Secret stored securely' }),
    ).toBeVisible();
    const requests = api.getRequestsByUrl('/secret');
    expect(requests).toHaveLength(1);
    expect(requests[0].payload).toMatchObject({
      expiration: 86400,
      one_time: true,
      message: expect.any(String),
    });
    expect((requests[0].payload as { message: string }).message).not.toContain(
      'Keyboard shortcut secret',
    );
  });
}

test('Enter inserts a newline without submitting', async ({ page }) => {
  const api = new MockAPI(page);
  await api.mockCreateSecret(mockResponses.secretCreated);
  const secret = page.locator('#secret');
  await secret.fill('First line');
  await secret.press('End');
  await secret.press('Enter');
  await secret.press('x');
  await expect(secret).toHaveValue('First line\nx');
  expect(api.getRequestsByUrl('/secret')).toHaveLength(0);
});

test('shortcut does not submit an empty secret', async ({ page }) => {
  const api = new MockAPI(page);
  await api.mockCreateSecret(mockResponses.secretCreated);
  await page.locator('#secret').press('Control+Enter');
  await expect(page.locator('button[type="submit"]')).toBeEnabled();
  await expect(page.locator('#secret')).toHaveValue('');
  expect(api.getRequestsByUrl('/secret')).toHaveLength(0);
});

test('shortcut works from the custom password field', async ({ page }) => {
  const api = new MockAPI(page);
  await api.mockCreateSecret(mockResponses.secretCreated);
  await page.locator('#secret').fill('Secret with a custom password');
  await page.getByText('Generate decryption key', { exact: true }).click();
  await page.locator('#customPassword').fill('custom-key');
  await page.locator('#customPassword').press('Control+Enter');
  await expect(
    page.getByRole('heading', { name: 'Secret stored securely' }),
  ).toBeVisible();
  await expect(page.locator('code').last()).toHaveText('custom-key');
  expect(api.getRequestsByUrl('/secret')).toHaveLength(1);
});

for (const eventOptions of [{ repeat: true }, { isComposing: true }]) {
  test(`ignores shortcut events with ${JSON.stringify(eventOptions)}`, async ({
    page,
  }) => {
    const api = new MockAPI(page);
    await api.mockCreateSecret(mockResponses.secretCreated);
    await page.locator('#secret').fill('Do not submit');
    await page.locator('#secret').dispatchEvent('keydown', {
      key: 'Enter',
      ctrlKey: true,
      ...eventOptions,
    });
    await expect(page.locator('#secret')).toHaveValue('Do not submit');
    expect(api.getRequestsByUrl('/secret')).toHaveLength(0);
  });
}

test('shortcut does not create another secret while submission is pending', async ({
  page,
}) => {
  let requestCount = 0;
  let finishRequest!: () => void;
  const pending = new Promise<void>(resolve => {
    finishRequest = resolve;
  });
  await page.route('**/secret', async route => {
    requestCount++;
    await pending;
    await route.fulfill({ json: mockResponses.secretCreated });
  });
  await page.locator('#secret').fill('Only submit once');
  await page.locator('#secret').press('Control+Enter');
  await expect.poll(() => requestCount).toBe(1);
  await expect(page.locator('button[type="submit"]')).toBeDisabled();
  await page.locator('#secret').press('Control+Enter');
  await page.locator('#secret').press('Meta+Enter');
  await expect(page.locator('#secret')).toHaveValue('Only submit once');
  finishRequest();
  await expect(
    page.getByRole('heading', { name: 'Secret stored securely' }),
  ).toBeVisible();
  expect(requestCount).toBe(1);
});
