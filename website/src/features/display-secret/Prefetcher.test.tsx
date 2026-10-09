import { act, StrictMode, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSecret, getSecretStatus } from '@shared/lib/api';
import { decryptMessage } from '@shared/lib/crypto';
import Prefetcher from './Prefetcher';

const config = vi.hoisted(() => ({
  PREFETCH_SECRET: true,
  OIDC_ENABLED: false,
}));

vi.mock('@shared/hooks/useConfig', () => ({ useConfig: () => config }));
vi.mock('@shared/hooks/useAuth', () => ({
  useAuth: () => ({ isAuthenticated: true, loading: false }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@shared/lib/api', () => ({
  getSecret: vi.fn(),
  getSecretStatus: vi.fn(),
}));
vi.mock('@shared/lib/crypto', () => ({ decryptMessage: vi.fn() }));
vi.mock('./StreamingDecryptor', () => ({
  default: () => <div>File decryptor</div>,
}));

let root: Root;
let container: HTMLDivElement;
let navigate: ReturnType<typeof useNavigate>;

function Harness() {
  const routerNavigate = useNavigate();
  useEffect(() => {
    navigate = routerNavigate;
  }, [routerNavigate]);
  return (
    <Routes>
      <Route path="/:format/:key/:password?" element={<Prefetcher />} />
    </Routes>
  );
}

async function render(path = '/s/first') {
  await act(async () => {
    root.render(
      <StrictMode>
        <MemoryRouter initialEntries={[path]}>
          <Harness />
        </MemoryRouter>
      </StrictMode>,
    );
  });
}

async function reveal() {
  const button = Array.from(container.querySelectorAll('button')).find(
    button => button.textContent === 'display.buttonRevealMessage',
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
}

async function enterKey(value: string) {
  const input = container.querySelector('input')!;
  expect(input).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function submitKey() {
  await act(async () => {
    container
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  config.PREFETCH_SECRET = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  vi.mocked(getSecret)
    .mockReset()
    .mockResolvedValue({
      data: { message: 'ciphertext' },
      status: 200,
    });
  vi.mocked(getSecretStatus)
    .mockReset()
    .mockResolvedValue({
      data: { oneTime: true, requireAuth: false },
      status: 200,
    });
  vi.mocked(decryptMessage)
    .mockReset()
    .mockResolvedValue({ data: 'decrypted message' } as Awaited<
      ReturnType<typeof decryptMessage>
    >);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe.each([true, false])('prefetch enabled: %s', prefetch => {
  it.each([true, false])(
    'waits for key submission before fetching a short link (one-time: %s)',
    async oneTime => {
      config.PREFETCH_SECRET = prefetch;
      vi.mocked(getSecretStatus).mockResolvedValue({
        data: { oneTime, requireAuth: false },
        status: 200,
      });
      await render();
      expect(getSecret).not.toHaveBeenCalled();
      if (prefetch && oneTime) {
        await reveal();
        expect(getSecret).not.toHaveBeenCalled();
      }
      await submitKey();
      expect(getSecret).not.toHaveBeenCalled();
      await enterKey('separate-key');
      expect(getSecret).not.toHaveBeenCalled();
      await submitKey();
      expect(getSecret).toHaveBeenCalledExactlyOnceWith('first', false);
      expect(decryptMessage).toHaveBeenCalledWith(
        'ciphertext',
        'separate-key',
        'utf8',
      );
      expect(container.textContent).toContain('decrypted message');
    },
  );

  it('preserves retrieval of full links', async () => {
    config.PREFETCH_SECRET = prefetch;
    await render('/s/first/url-key');
    if (prefetch) {
      expect(getSecret).not.toHaveBeenCalled();
      await reveal();
    }
    expect(getSecret).toHaveBeenCalledExactlyOnceWith('first', false);
    expect(decryptMessage).toHaveBeenCalledWith(
      'ciphertext',
      'url-key',
      'utf8',
    );
    expect(container.textContent).toContain('decrypted message');
  });
});

it('retries decryption locally without retrieving the secret again', async () => {
  vi.mocked(decryptMessage).mockImplementation(async (_secret, password) => {
    if (password === 'wrong-key') throw new Error('Wrong key');
    return { data: 'decrypted message' } as Awaited<
      ReturnType<typeof decryptMessage>
    >;
  });
  await render();
  await reveal();
  await enterKey('wrong-key');
  await submitKey();
  expect(container.textContent).toContain(
    'display.errorInvalidPasswordDetailed',
  );
  await enterKey('correct-key');
  await submitKey();
  expect(getSecret).toHaveBeenCalledOnce();
  expect(decryptMessage).toHaveBeenLastCalledWith(
    'ciphertext',
    'correct-key',
    'utf8',
  );
  expect(container.textContent).toContain('decrypted message');
});

it('does not reuse a submitted key or reveal action for another short link', async () => {
  await render();
  await reveal();
  await enterKey('first-key');
  await submitKey();
  await act(async () => navigate('/s/second'));
  expect(getSecret).toHaveBeenCalledOnce();
  await reveal();
  expect(getSecret).toHaveBeenCalledOnce();
  expect(container.querySelector('input')!.value).toBe('');
  await enterKey('second-key');
  await submitKey();
  expect(getSecret).toHaveBeenCalledTimes(2);
  expect(getSecret).toHaveBeenLastCalledWith('second', false);
  expect(decryptMessage).toHaveBeenLastCalledWith(
    'ciphertext',
    'second-key',
    'utf8',
  );
});
