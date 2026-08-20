import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  REQUESTS_CHANGED_EVENT,
  type StoredRequest,
  clearAllStoredRequests,
  clearCollectedRequests,
  exportStoredRequest,
  importStoredRequest,
  listStoredRequests,
  markRequestsFulfilled,
  removeStoredRequest,
  saveStoredRequest,
  updateStoredRequest,
} from './requestStore';

const STORAGE_KEY = 'yopass-secret-requests';

function request(overrides: Partial<StoredRequest> = {}): StoredRequest {
  return {
    id: 'req-1',
    privateKey: 'private-key',
    publicKey: 'public-key',
    fingerprint: 'fingerprint',
    token: 'token',
    createdAt: 1000,
    expiresAt: 2000,
    ...overrides,
  };
}

function countChangeEvents(): { count: () => number } {
  const listener = vi.fn();
  window.addEventListener(REQUESTS_CHANGED_EVENT, listener);
  return { count: () => listener.mock.calls.length };
}

beforeEach(() => {
  localStorage.clear();
});

describe('listStoredRequests', () => {
  it('returns an empty list when nothing is stored', () => {
    expect(listStoredRequests()).toEqual([]);
  });

  it('returns an empty list for corrupted JSON', () => {
    localStorage.setItem(STORAGE_KEY, '{not json');
    expect(listStoredRequests()).toEqual([]);
  });

  it('returns an empty list when the stored value is not an array', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ id: 'req-1' }));
    expect(listStoredRequests()).toEqual([]);
  });

  it('filters out entries with missing required fields', () => {
    const valid = request();
    const missingToken = { ...request({ id: 'req-2' }), token: undefined };
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([valid, missingToken, null, 'text', 42]),
    );
    expect(listStoredRequests()).toEqual([valid]);
  });

  it('filters out entries with wrongly typed fields', () => {
    const wrongType = { ...request(), createdAt: '1000' };
    localStorage.setItem(STORAGE_KEY, JSON.stringify([wrongType]));
    expect(listStoredRequests()).toEqual([]);
  });
});

describe('saveStoredRequest', () => {
  it('prepends new requests and replaces entries with the same id', () => {
    saveStoredRequest(request({ id: 'a', label: 'first' }));
    saveStoredRequest(request({ id: 'b' }));
    saveStoredRequest(request({ id: 'a', label: 'updated' }));

    const stored = listStoredRequests();
    expect(stored.map(r => r.id)).toEqual(['a', 'b']);
    expect(stored[0].label).toBe('updated');
  });

  it('emits a change event', () => {
    const events = countChangeEvents();
    saveStoredRequest(request());
    expect(events.count()).toBe(1);
  });
});

describe('updateStoredRequest', () => {
  it('applies a partial patch to the matching request only', () => {
    saveStoredRequest(request({ id: 'a' }));
    saveStoredRequest(request({ id: 'b' }));

    updateStoredRequest('a', { revoked: true });

    const byId = new Map(listStoredRequests().map(r => [r.id, r]));
    expect(byId.get('a')?.revoked).toBe(true);
    expect(byId.get('b')?.revoked).toBeUndefined();
  });
});

describe('markRequestsFulfilled', () => {
  it('marks the given requests fulfilled in a single write', () => {
    saveStoredRequest(request({ id: 'a' }));
    saveStoredRequest(request({ id: 'b' }));
    saveStoredRequest(request({ id: 'c' }));

    const events = countChangeEvents();
    markRequestsFulfilled(['a', 'c']);

    expect(events.count()).toBe(1);
    const byId = new Map(listStoredRequests().map(r => [r.id, r]));
    expect(byId.get('a')?.fulfilled).toBe(true);
    expect(byId.get('b')?.fulfilled).toBeUndefined();
    expect(byId.get('c')?.fulfilled).toBe(true);
  });

  it('does not write or emit an event when nothing changed', () => {
    saveStoredRequest(request({ id: 'a', fulfilled: true }));

    const events = countChangeEvents();
    markRequestsFulfilled([]);
    markRequestsFulfilled(['a']);
    markRequestsFulfilled(['unknown']);

    expect(events.count()).toBe(0);
  });
});

describe('removeStoredRequest', () => {
  it('removes only the matching request', () => {
    saveStoredRequest(request({ id: 'a' }));
    saveStoredRequest(request({ id: 'b' }));

    removeStoredRequest('a');

    expect(listStoredRequests().map(r => r.id)).toEqual(['b']);
  });
});

describe('clearCollectedRequests', () => {
  it('removes collected requests and keeps the rest', () => {
    saveStoredRequest(request({ id: 'a', collected: true }));
    saveStoredRequest(request({ id: 'b' }));

    clearCollectedRequests();

    expect(listStoredRequests().map(r => r.id)).toEqual(['b']);
  });
});

describe('clearAllStoredRequests', () => {
  it('removes every stored request', () => {
    saveStoredRequest(request({ id: 'a' }));
    saveStoredRequest(request({ id: 'b' }));

    clearAllStoredRequests();

    expect(listStoredRequests()).toEqual([]);
  });
});

describe('export/import round-trip', () => {
  it('imports an exported request unchanged and saves it', () => {
    const original = request({
      id: 'roundtrip',
      label: 'my request',
      revoked: false,
      collected: false,
      fulfilled: true,
    });

    const imported = importStoredRequest(exportStoredRequest(original));

    expect(imported).toEqual(original);
    expect(listStoredRequests()).toEqual([original]);
  });

  it('exports a versioned document', () => {
    const parsed = JSON.parse(exportStoredRequest(request()));
    expect(parsed.yopassSecretRequest).toBe(1);
  });

  it('drops unknown fields on import', () => {
    const exported = JSON.stringify({
      yopassSecretRequest: 1,
      ...request(),
      extraField: 'should not survive',
    });

    const imported = importStoredRequest(exported);

    expect(imported).not.toHaveProperty('extraField');
    expect(listStoredRequests()[0]).not.toHaveProperty('extraField');
  });

  it('normalizes a non-boolean fulfilled field on import', () => {
    const exported = JSON.stringify({ ...request(), fulfilled: 'yes' });
    expect(importStoredRequest(exported).fulfilled).toBeUndefined();
  });

  it('rejects exports missing required fields', () => {
    const incomplete = { ...request() } as Record<string, unknown>;
    delete incomplete.privateKey;

    expect(() => importStoredRequest(JSON.stringify(incomplete))).toThrow(
      'invalid request export',
    );
    expect(listStoredRequests()).toEqual([]);
  });

  it('rejects invalid JSON', () => {
    expect(() => importStoredRequest('{not json')).toThrow();
  });
});
