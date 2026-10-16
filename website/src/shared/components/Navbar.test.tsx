import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defaultConfig, type Config } from '../lib/config';
import { ThemeProvider } from '../theme/ThemeProvider';
import Navbar from './Navbar';

const state = vi.hoisted(() => ({ config: {} as Config }));
vi.mock('../hooks/useConfig', () => ({ useConfig: () => state.config }));
vi.mock('../hooks/useAuth', () => ({
  useAuth: () => ({ isAuthenticated: false }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => (key === 'header.appName' ? 'Yopass' : key),
  }),
}));
vi.mock('./SettingsMenu', () => ({ default: () => null }));

let root: Root;
let container: HTMLDivElement;
let originalTitle: string;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.config = { ...defaultConfig };
  originalTitle = document.title;
  document.title = 'Yopass';
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.title = originalTitle;
  vi.unstubAllGlobals();
});

async function render() {
  await act(async () => {
    root.render(
      <MemoryRouter>
        <ThemeProvider>
          <Navbar />
        </ThemeProvider>
      </MemoryRouter>,
    );
  });
  return container.querySelector<HTMLAnchorElement>('a[href="/"]')!;
}

it.each([undefined, 'Acme Secrets'])(
  'hides the name with a custom logo and keeps the tab title (%s)',
  async appName => {
    state.config = {
      ...defaultConfig,
      LOGO_URL: '/custom.svg',
      APP_NAME: appName,
      HIDE_APP_NAME: true,
    };
    const brand = await render();
    expect(brand.textContent).toBe('');
    expect(brand.querySelector('span')).toBeNull();
    const image = brand.querySelector('img')!;
    expect(image.getAttribute('src')).toBe('/custom.svg');
    expect(image.alt).toBe(appName ?? 'Yopass');
    expect(image.className).not.toContain('mr-');
    expect(document.title).toBe(appName ?? 'Yopass');
  },
);

it('uses the default icon without its wordmark when the name is hidden', async () => {
  state.config.HIDE_APP_NAME = true;
  const brand = await render();
  expect(brand.textContent).toBe('');
  expect(brand.querySelector('img')!.getAttribute('src')).toBe('/yopass.svg');
  expect(brand.querySelector('img')!.alt).toBe('Yopass');
  expect(document.title).toBe('Yopass');
});

it.each([undefined, 'Acme Secrets'])(
  'shows the name beside a custom logo by default (%s)',
  async appName => {
    state.config.LOGO_URL = '/custom.svg';
    state.config.APP_NAME = appName;
    const brand = await render();
    expect(brand.textContent).toBe(appName ?? 'Yopass');
    expect(brand.querySelector('img')!.getAttribute('src')).toBe('/custom.svg');
  },
);

it('keeps the default wordmark when no branding options are set', async () => {
  localStorage.setItem('themeMode', 'light');
  const brand = await render();
  expect(brand.querySelector('img')!.getAttribute('src')).toBe(
    '/yopass-full.svg',
  );
});

it('keeps existing requests accessible while an expired license drains', async () => {
  state.config.SECRET_REQUESTS = false;
  state.config.SECRET_REQUESTS_DRAINING = true;
  await render();
  expect(container.querySelector('a[href="#/requests"]')).not.toBeNull();
});
