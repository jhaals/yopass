import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Link } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fetchRequestSecret } from '@shared/lib/api';
import { decryptRequestSecret } from '@shared/lib/crypto';
import { updateStoredRequest } from '@shared/lib/requestStore';
import App from './App';

const config = vi.hoisted(() => ({
  SECRET_REQUESTS: true,
  SECRET_REQUESTS_DRAINING: false,
}));
vi.mock('@shared/hooks/useConfig', () => ({ useConfig: () => config }));
vi.mock('@shared/hooks/useAuth', () => ({
  useAuth: () => ({ isAuthenticated: true, loading: false }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@shared/components/FeaturesSection', () => ({ default: () => null }));
vi.mock('@shared/components/Navbar', () => ({
  default: () => (
    <>
      <Link to="/request">Navigate away</Link>
      <Link to="/r/existing/fp">Existing request link</Link>
    </>
  ),
}));
vi.mock('@features/request-secret/CreateRequest', () => ({
  default: () => <div>New request page</div>,
}));
vi.mock('@features/CreateSecret', () => ({ default: () => null }));
vi.mock('@features/StreamingUpload', () => ({ default: () => null }));
vi.mock('@features/display-secret/Prefetcher', () => ({ default: () => null }));
vi.mock('@features/request-secret/ProvideSecret', () => ({
  default: () => <div>Respond to existing request</div>,
}));
vi.mock('@shared/lib/api', async importOriginal => ({
  ...(await importOriginal<typeof import('@shared/lib/api')>()),
  fetchRequestSecret: vi.fn(),
}));
vi.mock('@shared/lib/crypto', () => ({
  decryptRequestSecret: vi.fn(),
  generateRequestKeyPair: vi.fn(),
}));
vi.mock('@shared/lib/requestStore', async importOriginal => ({
  ...(await importOriginal<typeof import('@shared/lib/requestStore')>()),
  updateStoredRequest: vi.fn(),
}));
vi.mock('@features/request-secret/useStoredRequests', () => ({
  useStoredRequests: () => ({
    requests: ['first', 'second'].map(id => ({
      id,
      label: id,
      privateKey: `private-${id}`,
      publicKey: `public-${id}`,
      fingerprint: 'a'.repeat(40),
      token: `token-${id}`,
      createdAt: 1700000000,
      expiresAt: 2000000000,
    })),
    statuses: { first: 'fulfilled', second: 'fulfilled' },
    refresh: async () => {},
  }),
}));

type FetchResult = Awaited<ReturnType<typeof fetchRequestSecret>>;
let resolveFetch: Record<string, (value: FetchResult) => void>;
let root: Root;
let container: HTMLDivElement;
let originalURL: string;

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  config.SECRET_REQUESTS = true;
  config.SECRET_REQUESTS_DRAINING = false;
  resolveFetch = {};
  vi.mocked(fetchRequestSecret).mockImplementation(
    id =>
      new Promise(resolve => {
        resolveFetch[id] = resolve;
      }),
  );
  vi.mocked(decryptRequestSecret).mockImplementation(async ciphertext => ({
    kind: 'text',
    text: `clear:${ciphertext}`,
  }));
  originalURL = window.location.href;
  window.history.replaceState({}, '', '/#/requests');
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<App />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  window.history.replaceState({}, '', originalURL);
  vi.unstubAllGlobals();
});

async function clickText(text: string, scope: ParentNode = container) {
  const button = Array.from(
    scope.querySelectorAll<HTMLButtonElement | HTMLAnchorElement>('button, a'),
  ).find(button => button.textContent === text);
  expect(button).toBeDefined();
  await act(async () => button!.click());
}

async function collect(index: number) {
  const buttons =
    container.querySelectorAll<HTMLButtonElement>('button.btn-success');
  await act(async () => buttons[index].click());
  await clickText('request.confirm.viewConfirm');
}

it('queues overlapping answers without replacing the open answer', async () => {
  await collect(0);
  await collect(1);
  const buttons =
    container.querySelectorAll<HTMLButtonElement>('button.btn-success');
  expect(Array.from(buttons).every(button => button.disabled)).toBe(true);
  await act(async () =>
    resolveFetch.first({
      data: { message: 'first-answer', kind: 'text' },
      status: 200,
    }),
  );
  expect(container.querySelector('pre')!.textContent).toBe(
    'clear:first-answer',
  );
  expect(
    container.querySelectorAll<HTMLButtonElement>('button.btn-success')[1]
      .disabled,
  ).toBe(true);
  await act(async () =>
    resolveFetch.second({
      data: { message: 'second-answer', kind: 'file' },
      status: 200,
    }),
  );
  expect(container.querySelector('pre')!.textContent).toBe(
    'clear:first-answer',
  );
  await clickText('request.buttonClose');
  expect(container.querySelector('pre')!.textContent).toBe(
    'clear:second-answer',
  );
  await clickText('request.buttonClose');
  expect(container.querySelector('[role=dialog]')).toBeNull();
  expect(updateStoredRequest).toHaveBeenCalledWith('first', {
    collected: true,
  });
  expect(updateStoredRequest).toHaveBeenCalledWith('second', {
    collected: true,
  });
  expect(
    vi.mocked(decryptRequestSecret).mock.calls.map(call => call[2]),
  ).toEqual(['text', 'file']);
});

it('shows an answer even if the request list unmounts while fetching', async () => {
  await collect(0);
  await clickText('Navigate away');
  expect(container.textContent).toContain('New request page');
  await act(async () =>
    resolveFetch.first({ data: { message: 'only-copy' }, status: 200 }),
  );
  expect(container.querySelector('pre')!.textContent).toBe('clear:only-copy');
  expect(container.textContent).toContain('New request page');
  await clickText('request.buttonClose');
  expect(container.querySelector('[role=dialog]')).toBeNull();
});

it('keeps existing-request pages available while new creation is disabled', async () => {
  config.SECRET_REQUESTS = false;
  config.SECRET_REQUESTS_DRAINING = true;
  await act(async () => root.render(<App />));
  expect(container.textContent).toContain('request.listTitle');
  expect(container.querySelector('main a[href="#/request"]')).toBeNull();
  await clickText('Existing request link');
  expect(container.textContent).toContain('Respond to existing request');
});
