import { act, StrictMode, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSecret } from '@shared/lib/api';
import useFetchSecret from './useFetchSecret';

vi.mock('@shared/lib/api', () => ({ getSecret: vi.fn() }));
vi.mock('@shared/hooks/useConfig', () => ({
  useConfig: () => ({ OIDC_ENABLED: true }),
}));

let root: Root;
let container: HTMLDivElement;
let state: ReturnType<typeof useFetchSecret>;

function Harness({ id, enabled }: { id: string; enabled: boolean }) {
  const result = useFetchSecret(id, enabled);
  useEffect(() => {
    state = result;
  }, [result]);
  return <span>{result.secret}</span>;
}

async function render(id: string, enabled = true) {
  await act(async () => {
    root.render(
      <StrictMode>
        <Harness id={id} enabled={enabled} />
      </StrictMode>,
    );
  });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  vi.mocked(getSecret).mockReset();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('one-time secret fetching', () => {
  it('waits for user action and consumes a secret only once under StrictMode', async () => {
    vi.mocked(getSecret).mockResolvedValue({
      data: { message: 'ciphertext' },
      status: 200,
    });
    await render('first', false);
    expect(getSecret).not.toHaveBeenCalled();
    await render('first');
    await render('first');
    expect(getSecret).toHaveBeenCalledExactlyOnceWith('first', true);
    expect(container.textContent).toBe('ciphertext');
    expect(state.loading).toBe(false);
  });

  it('does not overwrite a new secret with a late response for an old one', async () => {
    let resolveOld!: (value: Awaited<ReturnType<typeof getSecret>>) => void;
    vi.mocked(getSecret).mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveOld = resolve;
        }),
    );
    await render('old');
    expect(state.loading).toBe(true);
    vi.mocked(getSecret).mockResolvedValueOnce({
      data: { message: 'new ciphertext' },
      status: 200,
    });
    await render('new');
    await act(async () => {
      resolveOld({ data: { message: 'old ciphertext' }, status: 200 });
    });
    expect(container.textContent).toBe('new ciphertext');
    expect(state.error).toBeNull();
  });

  it('reports authentication without exposing a stale secret', async () => {
    vi.mocked(getSecret).mockResolvedValueOnce({
      data: { message: 'old ciphertext' },
      status: 200,
    });
    await render('old');
    vi.mocked(getSecret).mockResolvedValueOnce({ data: null, status: 401 });
    await render('protected');
    expect(state.requiresAuth).toBe(true);
    expect(state.secret).toBeUndefined();
    expect(state.loading).toBe(false);
    expect(state.error).toBeNull();
  });

  it('reports failed fetches without retrying a possibly consumed secret', async () => {
    vi.mocked(getSecret).mockResolvedValue({
      data: null,
      status: 0,
      message: 'network failure',
    });
    await render('first');
    await render('first');
    expect(state.error).toBeInstanceOf(Error);
    expect(state.loading).toBe(false);
    expect(getSecret).toHaveBeenCalledOnce();
  });
});
