import { test, expect } from '@playwright/test';
import { MockAPI } from './helpers/mock-api';

const now = new Date('2026-10-05T10:00:00Z');
function pickerDate(seconds: number) {
  return new Date(now.getTime() + seconds * 1000).toISOString().slice(0, 16);
}
test.use({ timezoneId: 'UTC' });
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(now);
});

const customConfig = {
  ALLOW_CUSTOM_EXPIRATION: true,
  MIN_EXPIRATION: 60,
  MAX_EXPIRATION: 7776000,
  SECRET_REQUESTS: true,
};

for (const path of ['/', '/#/upload', '/#/request']) {
  test(`custom duration and validation on ${path}`, async ({
    page,
  }, testInfo) => {
    const api = new MockAPI(page);
    await api.mockConfigEndpoint(customConfig);
    await page.goto(path);
    await page.getByRole('radio', { name: 'Custom', exact: true }).check();
    // Filling the field programmatically does not dismiss Firefox's native popup.
    await page.keyboard.press('Escape');
    await page
      .getByLabel('Expiration date and time', { exact: true })
      .fill(pickerDate(91 * 86400));
    await expect(page.getByRole('alert')).toContainText(
      'between 1 minute and 90 days from now',
    );
    await expect(
      page.getByLabel('Expiration date and time', { exact: true }),
    ).toHaveAttribute('aria-invalid', 'true');
    await page
      .getByLabel('Expiration date and time', { exact: true })
      .fill(pickerDate(90 * 86400));
    await expect(
      page.getByLabel('Expiration date and time', { exact: true }),
    ).toHaveAttribute('aria-invalid', 'false');
    if (path === '/') {
      await page.screenshot({
        path: testInfo.outputPath('expiration-desktop.png'),
        fullPage: true,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(
        page.getByLabel('Expiration date and time', { exact: true }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: testInfo.outputPath('expiration-mobile.png'),
        fullPage: true,
      });
    }
    await page.getByRole('radio', { name: 'One Day', exact: true }).check();
    await expect(
      page.getByLabel('Expiration date and time', { exact: true }),
    ).not.toBeVisible();
  });
}

test('creates a text secret with 90-day expiration', async ({ page }) => {
  const api = new MockAPI(page);
  await api.mockConfigEndpoint(customConfig);
  await api.mockCreateSecret({
    message: '123e4567-e89b-42d3-a456-426614174000',
  });
  await page.goto('/');
  await page.getByRole('radio', { name: 'Custom', exact: true }).check();
  // Filling the field programmatically does not dismiss Firefox's native popup.
  await page.keyboard.press('Escape');
  await page
    .getByLabel('Expiration date and time', { exact: true })
    .fill(pickerDate(90 * 86400));
  await page.locator('textarea').fill('custom lifetime');
  await page.locator('button[type="submit"]').click();
  await expect(
    page.getByRole('heading', { name: 'Secret stored securely' }),
  ).toBeVisible();
  expect(api.getLastRequest('/secret')?.payload).toMatchObject({
    expiration: 7776000,
  });
});

test('uploads a file with a custom default', async ({ page }) => {
  const api = new MockAPI(page);
  await api.mockConfigEndpoint({ ...customConfig, DEFAULT_EXPIRY: 7776000 });
  await api.mockUploadFile({ message: '123e4567-e89b-42d3-a456-426614174000' });
  await page.goto('/#/upload');
  await expect(
    page.getByLabel('Expiration date and time', { exact: true }),
  ).toHaveValue(pickerDate(90 * 86400));
  await page.locator('input[type="file"]').setInputFiles({
    name: 'secret.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('secret'),
  });
  await page.locator('button[type="submit"]').click();
  await expect(
    page.getByRole('heading', { name: 'Secret stored securely' }),
  ).toBeVisible();
  expect(api.getLastRequest('/create/file')?.payload).toMatchObject({
    expiration: 7776000,
  });
});

test('creates a request with custom expiration', async ({ page }) => {
  const api = new MockAPI(page);
  await api.mockConfigEndpoint({ ...customConfig, DEFAULT_EXPIRY: 7776000 });
  let expiration: number | undefined;
  await page.route('**/request', async route => {
    expiration = route.request().postDataJSON().expiration;
    await route.fulfill({
      json: {
        id: '123e4567-e89b-42d3-a456-426614174000',
        token: 'request-token',
        expires_at: Math.floor(Date.now() / 1000) + 7776000,
      },
    });
  });
  await page.goto('/#/request');
  await expect(
    page.getByLabel('Expiration date and time', { exact: true }),
  ).toHaveValue(pickerDate(90 * 86400));
  await page.locator('button[type="submit"]').click();
  await expect(
    page.getByRole('heading', { name: 'Request created' }),
  ).toBeVisible();
  expect(expiration).toBe(7776000);
});

test('renders forced custom durations', async ({ page }) => {
  const api = new MockAPI(page);
  await api.mockConfigEndpoint({ ...customConfig, FORCE_EXPIRATION: 7776000 });
  await page.goto('/');
  await expect(page.getByText('Secret will expire in 90 days')).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Custom' })).not.toBeVisible();
});

test('hides custom expiration by default and filters presets outside bounds', async ({
  page,
}) => {
  const api = new MockAPI(page);
  await api.mockConfigEndpoint({});
  await page.goto('/');
  await expect(page.getByRole('radio', { name: 'Custom' })).not.toBeVisible();
  await api.mockConfigEndpoint({
    ...customConfig,
    MIN_EXPIRATION: 86400,
    DEFAULT_EXPIRY: 86400,
  });
  await page.reload();
  await expect(page.getByRole('radio', { name: 'One Hour' })).not.toBeVisible();
  await expect(page.getByRole('radio', { name: 'One Day' })).toBeChecked();
});

test('recalculates the remaining lifetime after time spent editing', async ({
  page,
}) => {
  const api = new MockAPI(page);
  await api.mockConfigEndpoint(customConfig);
  await api.mockCreateSecret({
    message: '123e4567-e89b-42d3-a456-426614174000',
  });
  await page.goto('/');
  await page.getByRole('radio', { name: 'Custom', exact: true }).check();
  // Filling the field programmatically does not dismiss Firefox's native popup.
  await page.keyboard.press('Escape');
  await page
    .getByLabel('Expiration date and time', { exact: true })
    .fill(pickerDate(86400));
  await page.clock.setFixedTime(new Date(now.getTime() + 600000));
  await page.locator('textarea').fill('selected deadline');
  await page.locator('button[type="submit"]').click();
  await expect(
    page.getByRole('heading', { name: 'Secret stored securely' }),
  ).toBeVisible();
  expect(api.getLastRequest('/secret')?.payload).toMatchObject({
    expiration: 85800,
  });
});

test('rejects past, empty, and too-soon dates', async ({ page }) => {
  const api = new MockAPI(page);
  await api.mockConfigEndpoint(customConfig);
  await api.mockCreateSecret({
    message: '123e4567-e89b-42d3-a456-426614174000',
  });
  await page.goto('/');
  await page.getByRole('radio', { name: 'Custom', exact: true }).check();
  // Filling the field programmatically does not dismiss Firefox's native popup.
  await page.keyboard.press('Escape');
  const picker = page.getByLabel('Expiration date and time', { exact: true });
  for (const value of [pickerDate(-3600), pickerDate(0), '']) {
    await picker.fill(value);
    await expect(picker).toHaveAttribute('aria-invalid', 'true');
    await page.locator('textarea').fill('invalid date');
    await page.locator('button[type="submit"]').click();
    expect(api.getLastRequest('/secret')).toBeUndefined();
  }
  await picker.fill(pickerDate(60));
  await expect(picker).toHaveAttribute('aria-invalid', 'false');
});

test('uses the browser local time zone', async ({ browser }) => {
  const context = await browser.newContext({ timezoneId: 'Europe/Stockholm' });
  try {
    const page = await context.newPage();
    await page.clock.setFixedTime(now);
    const api = new MockAPI(page);
    await api.mockConfigEndpoint(customConfig);
    await api.mockCreateSecret({
      message: '123e4567-e89b-42d3-a456-426614174000',
    });
    await page.goto('/');
    await page.getByRole('radio', { name: 'Custom', exact: true }).check();
    // Filling the field programmatically does not dismiss Firefox's native popup.
    await page.keyboard.press('Escape');
    await page
      .getByLabel('Expiration date and time', { exact: true })
      .fill('2026-10-06T12:00');
    await expect(
      page.getByText('Times are in your local time zone (Europe/Stockholm).'),
    ).toBeVisible();
    await page.locator('textarea').fill('local deadline');
    await page.locator('button[type="submit"]').click();
    await expect(
      page.getByRole('heading', { name: 'Secret stored securely' }),
    ).toBeVisible();
    expect(api.getLastRequest('/secret')?.payload).toMatchObject({
      expiration: 86400,
    });
  } finally {
    await context.close();
  }
});

test('opens the date picker immediately when Custom is clicked, including repeat clicks', async ({
  page,
}) => {
  const api = new MockAPI(page);
  await api.mockConfigEndpoint(customConfig);
  await page.addInitScript(() => {
    const prototype = HTMLInputElement.prototype;
    const original = prototype.showPicker;
    Object.defineProperty(prototype, 'showPicker', {
      configurable: true,
      value: function (this: HTMLInputElement) {
        this.dataset.pickerOpened = String(
          Number(this.dataset.pickerOpened ?? 0) + 1,
        );
        this.dataset.pickerActivated = String(
          navigator.userActivation.isActive,
        );
        original?.call(this);
      },
    });
  });
  await page.goto('/');
  const custom = page.getByRole('radio', { name: 'Custom', exact: true });
  const picker = page.getByLabel('Expiration date and time', { exact: true });
  await custom.click();
  await expect(picker).toBeFocused();
  await expect(picker).toHaveAttribute('data-picker-opened', '1');
  await expect(picker).toHaveAttribute('data-picker-activated', 'true');
  await page.keyboard.press('Escape');
  await custom.click();
  await expect(picker).toHaveAttribute('data-picker-opened', '2');
});

test('focuses the date field when the browser has no programmatic picker', async ({
  page,
}) => {
  const api = new MockAPI(page);
  await api.mockConfigEndpoint(customConfig);
  await page.addInitScript(() => {
    Object.defineProperty(HTMLInputElement.prototype, 'showPicker', {
      configurable: true,
      value: undefined,
    });
  });
  await page.goto('/');
  await page.getByRole('radio', { name: 'Custom', exact: true }).click();
  await expect(
    page.getByLabel('Expiration date and time', { exact: true }),
  ).toBeFocused();
});

test('keeps narrow expiration policies usable while editing', async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date(now.getTime() + 30000));
  const api = new MockAPI(page);
  await api.mockConfigEndpoint({
    ...customConfig,
    MAX_EXPIRATION: 61,
    DEFAULT_EXPIRY: 61,
  });
  await api.mockCreateSecret({
    message: '123e4567-e89b-42d3-a456-426614174000',
  });
  await page.goto('/');
  const duration = page.getByRole('combobox', { name: 'Custom', exact: true });
  await expect(duration).toHaveValue('61');
  await duration.selectOption('60');
  await page.clock.setFixedTime(new Date(now.getTime() + 30000 + 30000));
  await page.locator('textarea').fill('narrow expiration policy');
  await page.locator('button[type="submit"]').click();
  await expect(
    page.getByRole('heading', { name: 'Secret stored securely' }),
  ).toBeVisible();
  expect(api.getLastRequest('/secret')?.payload).toMatchObject({
    expiration: 60,
  });
});

test('keyboard selection of Custom submits the displayed deadline', async ({
  page,
}) => {
  const api = new MockAPI(page);
  await api.mockConfigEndpoint(customConfig);
  await api.mockCreateSecret({
    message: '123e4567-e89b-42d3-a456-426614174000',
  });
  await page.goto('/');
  await page.getByRole('radio', { name: 'One Day', exact: true }).check();
  await page.getByRole('radio', { name: 'One Week', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Escape');
  const picker = page.getByLabel('Expiration date and time', { exact: true });
  await expect(picker).toBeFocused();
  await expect(picker).toHaveValue(pickerDate(86400));
  await page.locator('textarea').fill('keyboard deadline');
  await page.locator('button[type="submit"]').click();
  await expect(
    page.getByRole('heading', { name: 'Secret stored securely' }),
  ).toBeVisible();
  expect(api.getLastRequest('/secret')?.payload).toMatchObject({
    expiration: 86400,
  });
});

for (const path of ['/', '/#/upload', '/#/request']) {
  test(`seeds the first custom deadline from the current preset and time on ${path}`, async ({
    page,
  }) => {
    const api = new MockAPI(page);
    await api.mockConfigEndpoint(customConfig);
    await page.goto(path);
    await page.getByRole('radio', { name: 'One Day', exact: true }).check();
    await page.clock.setFixedTime(new Date(now.getTime() + 2 * 3600000));
    await page.getByRole('radio', { name: 'Custom', exact: true }).click();
    await page.keyboard.press('Escape');
    const picker = page.getByLabel('Expiration date and time', { exact: true });
    await expect(picker).toHaveValue(pickerDate(86400 + 7200));
    await expect(picker).toHaveAttribute('aria-invalid', 'false');

    // Once a custom deadline is chosen, presets and elapsed time must not reset it.
    await picker.fill(pickerDate(3 * 86400));
    await page.getByRole('radio', { name: 'One Week', exact: true }).check();
    await page.clock.setFixedTime(new Date(now.getTime() + 3 * 3600000));
    await page.getByRole('radio', { name: 'Custom', exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(picker).toHaveValue(pickerDate(3 * 86400));
    await expect(picker).toHaveAttribute('aria-invalid', 'false');
  });
}
