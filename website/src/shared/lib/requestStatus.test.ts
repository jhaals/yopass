import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getSecretRequest } from './api';
import { countFulfilledRequests } from './requestStatus';
import {
  listStoredRequests,
  REQUESTS_CHANGED_EVENT,
  saveStoredRequest,
  type StoredRequest,
} from './requestStore';

vi.mock('./api', () => ({ getSecretRequest: vi.fn() }));

function request(
  id: string,
  patch: Partial<StoredRequest> = {},
): StoredRequest {
  return {
    id,
    token: 'token',
    publicKey: 'public',
    privateKey: 'private',
    fingerprint: 'fingerprint',
    createdAt: 0,
    expiresAt: 2000,
    ...patch,
  };
}

beforeEach(() => {
  localStorage.clear();
  vi.mocked(getSecretRequest).mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(1000 * 1000);
});

afterEach(() => vi.useRealTimers());

it('counts cached fulfillment without fetching expired, revoked or collected requests', async () => {
  saveStoredRequest(request('cached', { fulfilled: true }));
  saveStoredRequest(request('expired', { expiresAt: 1000 }));
  saveStoredRequest(request('revoked', { revoked: true }));
  saveStoredRequest(request('collected', { collected: true }));
  expect(await countFulfilledRequests()).toBe(1);
  expect(getSecretRequest).not.toHaveBeenCalled();
});

it('caches fresh fulfillments once and avoids fetching them on the next poll', async () => {
  saveStoredRequest(request('first'));
  saveStoredRequest(request('second'));
  vi.mocked(getSecretRequest).mockResolvedValue({
    status: 200,
    data: {
      public_key: 'public',
      label: '',
      state: 'fulfilled',
      expires_at: 2000,
    },
  });
  const changed = vi.fn();
  window.addEventListener(REQUESTS_CHANGED_EVENT, changed);
  try {
    expect(await countFulfilledRequests()).toBe(2);
    expect(changed).toHaveBeenCalledOnce();
    expect(getSecretRequest).toHaveBeenCalledTimes(2);
    expect(listStoredRequests().every(r => r.fulfilled)).toBe(true);
    expect(await countFulfilledRequests()).toBe(2);
    expect(getSecretRequest).toHaveBeenCalledTimes(2);
    expect(changed).toHaveBeenCalledOnce();
  } finally {
    window.removeEventListener(REQUESTS_CHANGED_EVENT, changed);
  }
});

it('retries failed lookups on the next poll without caching a terminal state', async () => {
  saveStoredRequest(request('pending'));
  vi.mocked(getSecretRequest).mockResolvedValue({ data: null, status: 503 });
  expect(await countFulfilledRequests()).toBe(0);
  expect(listStoredRequests()[0].fulfilled).toBeUndefined();
  expect(await countFulfilledRequests()).toBe(0);
  expect(getSecretRequest).toHaveBeenCalledTimes(2);
});
