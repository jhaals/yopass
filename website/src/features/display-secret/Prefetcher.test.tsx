import { act, StrictMode, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getSecret,
  getSecretStatus,
  requestRecipientCode,
  verifyRecipientCode,
} from '@shared/lib/api';
import { decryptMessage } from '@shared/lib/crypto';
import Prefetcher from './Prefetcher';

const config = vi.hoisted(() => ({
  PREFETCH_SECRET: true,
  OIDC_ENABLED: false,
  REQUIRE_AUTH_ALL: false,
  RECIPIENT_EMAIL_CODE: false,
}));
const auth = vi.hoisted(() => ({ isAuthenticated: true, loading: false }));

vi.mock('@shared/hooks/useConfig', () => ({ useConfig: () => config }));
vi.mock('@shared/hooks/useAuth', () => ({
  useAuth: () => auth,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@shared/lib/api', () => ({
  backendDomain: '',
  getSecret: vi.fn(),
  getSecretStatus: vi.fn(),
  isRecipientRefusal: (value: { error?: string } | null) =>
    value?.error === 'recipient_required' || value?.error === 'not_recipient',
  requestRecipientCode: vi.fn(),
  verifyRecipientCode: vi.fn(),
  signOut: vi.fn(),
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
  config.REQUIRE_AUTH_ALL = false;
  config.RECIPIENT_EMAIL_CODE = false;
  config.OIDC_ENABLED = false;
  auth.isAuthenticated = true;
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

it('asks signed-out viewers to log in when every operation requires auth', async () => {
  config.REQUIRE_AUTH_ALL = true;
  auth.isAuthenticated = false;
  await render('/s/first');
  expect(container.textContent).toContain('display.authRequiredTitle');
  expect(getSecret).not.toHaveBeenCalled();
  expect(getSecretStatus).not.toHaveBeenCalled();
});

it('says a restricted secret is for one recipient, and refuses anyone else', async () => {
  vi.mocked(getSecretStatus).mockResolvedValue({
    data: { oneTime: false, requireAuth: true, restricted: true },
    status: 200,
  });
  vi.mocked(getSecret).mockResolvedValue({
    data: null,
    status: 401,
    error: 'recipient_required',
  });
  auth.isAuthenticated = false;
  await render('/s/first/url-key');
  expect(container.textContent).toContain('display.restrictedTitle');
  // Codes are off unless the server offers them.
  expect(container.textContent).not.toContain('display.codeSendButton');

  root.unmount();
  root = createRoot(container);
  auth.isAuthenticated = true;
  vi.mocked(getSecret).mockResolvedValue({ data: null, status: 403 });
  await render('/s/first/url-key');
  expect(container.textContent).toContain('display.notRecipientDescription');
  expect(decryptMessage).not.toHaveBeenCalled();
});

async function typeInto(selector: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(selector)!;
  expect(input).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    input.form!.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
  });
}

it('lets a recipient without an account in with an emailed code', async () => {
  config.RECIPIENT_EMAIL_CODE = true;
  config.OIDC_ENABLED = true;
  auth.isAuthenticated = false;
  vi.mocked(getSecretStatus).mockResolvedValue({
    data: { oneTime: false, requireAuth: true, restricted: true },
    status: 200,
  });
  vi.mocked(getSecret)
    .mockResolvedValueOnce({ data: null, status: 401 })
    .mockResolvedValue({ data: { message: 'ciphertext' }, status: 200 });
  vi.mocked(requestRecipientCode).mockResolvedValue({
    data: { message: 'sent' },
    status: 202,
  });
  vi.mocked(verifyRecipientCode)
    .mockResolvedValueOnce({ data: null, status: 403, message: 'wrong' })
    .mockResolvedValue({ data: { message: 'ok' }, status: 200 });

  await render('/s/first/url-key');
  expect(container.textContent).toContain('display.restrictedTitle');
  await typeInto('#recipient-code-email', 'guest@outside.test');
  expect(requestRecipientCode).toHaveBeenCalledWith(
    'first',
    false,
    'guest@outside.test',
  );
  expect(container.textContent).toContain('display.codeSent');

  await typeInto('#recipient-code', '000000');
  expect(container.textContent).toContain('display.codeWrong');
  expect(decryptMessage).not.toHaveBeenCalled();

  await typeInto('#recipient-code', '123456');
  expect(verifyRecipientCode).toHaveBeenLastCalledWith(
    'first',
    false,
    'guest@outside.test',
    '123456',
  );
  expect(container.textContent).toContain('decrypted message');
});

it('offers a code from the refusal itself when no status check runs', async () => {
  config.PREFETCH_SECRET = false;
  config.RECIPIENT_EMAIL_CODE = true;
  config.OIDC_ENABLED = true;
  auth.isAuthenticated = false;
  vi.mocked(getSecret).mockResolvedValue({
    data: null,
    status: 401,
    error: 'recipient_required',
  });
  await render('/s/first/url-key');
  expect(getSecretStatus).not.toHaveBeenCalled();
  expect(container.querySelector('#recipient-code-email')).not.toBeNull();

  // A plain sign-in requirement offers no code.
  root.unmount();
  root = createRoot(container);
  vi.mocked(getSecret).mockResolvedValue({ data: null, status: 401 });
  await render('/s/second/url-key');
  expect(container.textContent).toContain('display.authRequiredTitle');
  expect(container.querySelector('#recipient-code-email')).toBeNull();
});

it('shows a restricted secret that a grant from an earlier code opens', async () => {
  // After a reload nothing in the page remembers the code, but the cookie does.
  vi.mocked(getSecretStatus).mockResolvedValue({
    data: { oneTime: false, requireAuth: true, restricted: true },
    status: 200,
  });
  auth.isAuthenticated = false;
  await render('/s/first/url-key');
  expect(container.textContent).toContain('decrypted message');
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

  it('retains a consumed secret when correcting the key in the URL', async () => {
    config.PREFETCH_SECRET = prefetch;
    vi.mocked(decryptMessage).mockImplementation(async (_secret, password) => {
      if (password === 'wrong-key') throw new Error('Wrong key');
      return { data: 'decrypted message' } as Awaited<
        ReturnType<typeof decryptMessage>
      >;
    });
    await render('/s/first/wrong-key');
    if (prefetch) await reveal();
    expect(container.textContent).toContain(
      'display.errorInvalidPasswordDetailed',
    );
    const statusCalls = vi.mocked(getSecretStatus).mock.calls.length;
    vi.mocked(getSecretStatus).mockResolvedValue({ data: null, status: 404 });
    vi.mocked(getSecret).mockResolvedValue({ data: null, status: 404 });
    await act(async () => navigate('/s/first/correct-key'));
    expect(getSecret).toHaveBeenCalledOnce();
    expect(getSecretStatus).toHaveBeenCalledTimes(statusCalls);
    expect(decryptMessage).toHaveBeenLastCalledWith(
      'ciphertext',
      'correct-key',
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
  const firstErrorButton = container.querySelector(
    'button.animate-decrypt-error',
  );
  expect(firstErrorButton).not.toBeNull();
  const attempts = vi.mocked(decryptMessage).mock.calls.length;
  await enterKey('wrong-key');
  await submitKey();
  expect(decryptMessage).toHaveBeenCalledTimes(attempts + 1);
  expect(container.querySelector('button.animate-decrypt-error')).not.toBe(
    firstErrorButton,
  );
  await enterKey('correct-key');
  const replayedAlerts: Element[] = [];
  const observer = new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof Element) {
          if (node.matches('[role="alert"]')) replayedAlerts.push(node);
          replayedAlerts.push(...node.querySelectorAll('[role="alert"]'));
        }
      }
    }
  });
  observer.observe(container, { childList: true, subtree: true });
  await submitKey();
  observer.disconnect();
  expect(replayedAlerts).toHaveLength(0);
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
