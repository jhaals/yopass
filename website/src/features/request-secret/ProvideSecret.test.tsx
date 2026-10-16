import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSecretRequest, fulfillSecretRequest } from '@shared/lib/api';
import { publicKeyFingerprint, encryptWithPublicKey } from '@shared/lib/crypto';
import ProvideSecret from './ProvideSecret';

vi.mock('@shared/hooks/useConfig', () => ({ useConfig: () => ({}) }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@shared/lib/api', () => ({
  getSecretRequest: vi.fn(),
  fulfillSecretRequest: vi.fn(),
}));
vi.mock('@shared/lib/crypto', () => ({
  publicKeyFingerprint: vi.fn(),
  encryptWithPublicKey: vi.fn(),
  encryptFileWithPublicKey: vi.fn(),
}));

let root: Root;
let container: HTMLDivElement;
let navigate: ReturnType<typeof useNavigate>;
const firstFp = 'a'.repeat(16);
const nextFp = 'b'.repeat(16);
function info(publicKey: string) {
  return {
    data: {
      public_key: publicKey,
      key_version: 'version-at-page-load',
      label: 'request',
      state: 'pending' as const,
      expires_at: 2000000000,
    },
    status: 200,
  };
}

function Harness() {
  const routerNavigate = useNavigate();
  useEffect(() => {
    navigate = routerNavigate;
  }, [routerNavigate]);
  return (
    <Routes>
      <Route path="/r/:key/:fp" element={<ProvideSecret />} />
    </Routes>
  );
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  vi.mocked(getSecretRequest).mockResolvedValue(info('first-key'));
  vi.mocked(publicKeyFingerprint).mockImplementation(async key =>
    key === 'first-key' ? firstFp : nextFp,
  );
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[`/r/first/${firstFp}`]}>
        <Harness />
      </MemoryRouter>,
    );
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function chooseFileTab() {
  const tab = Array.from(container.querySelectorAll('button')).find(
    button => button.textContent === 'request.provideTabFile',
  )!;
  await act(async () => tab.click());
}

it('submits the loaded key version and rejects a stale form', async () => {
  vi.mocked(encryptWithPublicKey).mockResolvedValue('encrypted-answer');
  vi.mocked(fulfillSecretRequest).mockResolvedValue({
    data: null,
    status: 412,
  });
  const input = container.querySelector('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )!.set!.call(input, 'answer');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    container
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  expect(fulfillSecretRequest).toHaveBeenCalledWith(
    'first',
    'encrypted-answer',
    'text',
    'version-at-page-load',
  );
  expect(container.querySelector('form')).toBeNull();
  expect(container.textContent).toContain('request.provideIntegrityTitle');
  expect(container.textContent).not.toContain('request.provideSuccessTitle');
});

describe.each(['request ID', 'fingerprint'])('changing %s', changed => {
  it.each(['text', 'file'])('discards the previous %s draft', async mode => {
    if (mode === 'text') {
      const input = container.querySelector('textarea')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          'value',
        )!.set!.call(input, 'draft for the first request');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    } else {
      await chooseFileTab();
      const input =
        container.querySelector<HTMLInputElement>('input[type=file]')!;
      Object.defineProperty(input, 'files', {
        value: [new File(['draft'], 'first-request.txt')],
      });
      await act(async () =>
        input.dispatchEvent(new Event('change', { bubbles: true })),
      );
    }
    expect(
      container.querySelector<HTMLButtonElement>('button[type=submit]')!
        .disabled,
    ).toBe(false);
    let resolve!: (value: ReturnType<typeof info>) => void;
    vi.mocked(getSecretRequest).mockReturnValue(
      new Promise(done => {
        resolve = done;
      }),
    );
    await act(async () =>
      navigate(`/r/${changed === 'request ID' ? 'second' : 'first'}/${nextFp}`),
    );
    expect(container.querySelector('form')).toBeNull();
    expect(fulfillSecretRequest).not.toHaveBeenCalled();
    await act(async () => resolve(info('second-key')));
    expect(container.querySelector('textarea')!.value).toBe('');
    expect(
      container.querySelector<HTMLButtonElement>('button[type=submit]')!
        .disabled,
    ).toBe(true);
    await chooseFileTab();
    expect(container.textContent).not.toContain('first-request.txt');
    expect(
      container.querySelector<HTMLButtonElement>('button[type=submit]')!
        .disabled,
    ).toBe(true);
  });
});
