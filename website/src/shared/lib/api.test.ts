import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  crossOriginCredentials,
  getSecret,
  getSecretStatus,
  postSecret,
  revokeSecretRequest,
} from './api';

// jsonFetch is module-private; its behavior is pinned through the exported
// wrappers (getSecret for JSON responses, revokeSecretRequest for 204s).

function fakeResponse(params: {
  status: number;
  body?: unknown;
  invalidJson?: boolean;
}) {
  return {
    ok: params.status >= 200 && params.status < 300,
    status: params.status,
    json: () =>
      params.invalidJson
        ? Promise.reject(new SyntaxError('Unexpected token'))
        : Promise.resolve(params.body),
  };
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe('jsonFetch (via getSecret)', () => {
  it('returns parsed data on success', async () => {
    fetchMock.mockResolvedValue(
      fakeResponse({ status: 200, body: { message: 'encrypted' } }),
    );

    const result = await getSecret('abc', false);

    expect(result).toEqual({
      data: { message: 'encrypted' },
      status: 200,
    });
    expect(fetchMock).toHaveBeenCalledWith('/secret/abc', {
      method: 'GET',
    });
  });

  it('extracts the error message from a non-OK JSON body', async () => {
    fetchMock.mockResolvedValue(
      fakeResponse({ status: 400, body: { message: 'Secret not found' } }),
    );

    const result = await getSecret('abc', false);

    expect(result).toEqual({
      data: null,
      status: 400,
      message: 'Secret not found',
    });
  });

  it('falls back to an HTTP status message when the error body is not JSON', async () => {
    fetchMock.mockResolvedValue(
      fakeResponse({ status: 502, invalidJson: true }),
    );

    const result = await getSecret('abc', false);

    expect(result).toEqual({
      data: null,
      status: 502,
      message: 'HTTP 502',
    });
  });

  it('reports an unexpected body when an OK response is not JSON', async () => {
    fetchMock.mockResolvedValue(
      fakeResponse({ status: 200, invalidJson: true }),
    );

    const result = await getSecret('abc', false);

    expect(result).toEqual({
      data: null,
      status: 200,
      message: 'HTTP 200: unexpected response body',
    });
  });

  it('returns status 0 with the error message on network failure', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    const result = await getSecret('abc', false);

    expect(result).toEqual({
      data: null,
      status: 0,
      message: 'Failed to fetch',
    });
  });

  it('returns data null for a 204 response (via revokeSecretRequest)', async () => {
    fetchMock.mockResolvedValue(fakeResponse({ status: 204 }));

    const result = await revokeSecretRequest('abc', 'token');

    expect(result).toEqual({ data: null, status: 204 });
  });
});

describe('crossOriginCredentials', () => {
  it('includes cookies only when OIDC is enabled', () => {
    expect(crossOriginCredentials(true)).toEqual({ credentials: 'include' });
    expect(crossOriginCredentials(false)).toEqual({});
  });

  it('is threaded through to fetch', async () => {
    fetchMock.mockResolvedValue(
      fakeResponse({
        status: 200,
        body: { oneTime: true, requireAuth: false },
      }),
    );

    await getSecretStatus('abc', true, true);

    expect(fetchMock).toHaveBeenCalledWith('/file/abc/status', {
      method: 'GET',
      credentials: 'include',
    });
  });
});

describe('postSecret', () => {
  it('adapts a successful response to the legacy ApiResponse shape', async () => {
    fetchMock.mockResolvedValue(
      fakeResponse({
        status: 200,
        body: { message: 'secret-id', receipt_token: 'receipt' },
      }),
    );

    const result = await postSecret(
      { message: 'x', expiration: 3600, one_time: true },
      false,
    );

    expect(result).toEqual({
      data: { message: 'secret-id', receipt_token: 'receipt' },
      status: 200,
    });
  });

  it('carries the error message into data.message on failure', async () => {
    fetchMock.mockResolvedValue(
      fakeResponse({ status: 400, body: { message: 'Invalid expiration' } }),
    );

    const result = await postSecret(
      { message: 'x', expiration: 1, one_time: true },
      false,
    );

    expect(result).toEqual({
      data: { message: 'Invalid expiration', receipt_token: undefined },
      status: 400,
    });
  });
});
