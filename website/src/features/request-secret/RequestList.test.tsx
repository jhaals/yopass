import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  fetchRequestSecret,
  getSecretRequest,
  revokeSecretRequest,
} from '@shared/lib/api';
import { decryptRequestSecret } from '@shared/lib/crypto';
import {
  listStoredRequests,
  saveStoredRequest,
  type StoredRequest,
} from '@shared/lib/requestStore';
import RequestList from './RequestList';

vi.mock('@shared/hooks/useConfig', () => ({ useConfig: () => ({}) }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@shared/lib/api', () => ({
  getSecretRequest: vi.fn(),
  fetchRequestSecret: vi.fn(),
  revokeSecretRequest: vi.fn(),
  rotateRequestKey: vi.fn(),
}));
vi.mock('@shared/lib/crypto', () => ({
  decryptRequestSecret: vi.fn(),
  generateRequestKeyPair: vi.fn(),
}));

let root: Root;
let container: HTMLDivElement;
const onReveal = vi.fn();

function request(id: string): StoredRequest {
  return {
    id,
    label: id,
    token: 'token',
    publicKey: 'public',
    privateKey: 'private',
    fingerprint: 'fingerprint',
    createdAt: 0,
    expiresAt: 2000000000,
  };
}

function info(state: 'pending' | 'fulfilled') {
  return {
    data: { public_key: 'public', label: '', state, expires_at: 2000000000 },
    status: 200,
  };
}

function card(id: string) {
  return Array.from(
    container.querySelectorAll<HTMLElement>('.space-y-4 > div'),
  ).find(element => element.textContent?.includes(id))!;
}

async function click(scope: HTMLElement, label: string) {
  const button = Array.from(scope.querySelectorAll('button')).find(
    element => element.textContent === label,
  )!;
  await act(async () => button.click());
}

// Saves the given requests, then renders the list with a localStorage that
// reads normally and refuses every further write, as a full one does.
async function renderWithFullStorage(...requests: StoredRequest[]) {
  requests.forEach(saveStoredRequest);
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('storage full', 'QuotaExceededError');
  });
  await act(async () => root.render(<RequestList onReveal={onReveal} />));
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  localStorage.clear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.mocked(getSecretRequest).mockImplementation(async id =>
    info(id === 'answered' ? 'fulfilled' : 'pending'),
  );
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('shows every status when a fulfilled flag cannot be cached', async () => {
  await renderWithFullStorage(request('open'), request('answered'));

  expect(card('answered').textContent).toContain('request.status.fulfilled');
  expect(card('answered').textContent).toContain('request.buttonViewSecret');
  expect(card('open').textContent).toContain('request.status.pending');
  expect(card('open').textContent).toContain('request.buttonCopyLink');
  expect(listStoredRequests().some(r => r.fulfilled)).toBe(false);
});

it('reveals a fetched secret when the collected flag cannot be stored', async () => {
  vi.mocked(fetchRequestSecret).mockResolvedValue({
    data: { message: 'ciphertext' },
    status: 200,
  });
  vi.mocked(decryptRequestSecret).mockResolvedValue({
    kind: 'text',
    text: 'the answer',
  });
  await renderWithFullStorage(request('answered'));

  await click(card('answered'), 'request.buttonViewSecret');
  await click(container, 'request.confirm.viewConfirm');

  expect(fetchRequestSecret).toHaveBeenCalledWith(
    'answered',
    'token',
    undefined,
  );
  expect(onReveal).toHaveBeenCalledWith({
    id: 'answered',
    secret: 'the answer',
  });
  expect(container.querySelector('[role=alert]')).toBeNull();
});

it('refreshes the list after a revocation that cannot be stored', async () => {
  vi.mocked(revokeSecretRequest).mockResolvedValue({ data: null, status: 204 });
  await renderWithFullStorage(request('open'));
  vi.mocked(getSecretRequest).mockResolvedValue({ data: null, status: 404 });

  await click(card('open'), 'request.buttonRevoke');
  await click(container, 'request.confirm.revokeConfirm');

  expect(revokeSecretRequest).toHaveBeenCalledWith('open', 'token', undefined);
  expect(card('open').textContent).toContain('request.status.revoked');
});
