import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  crossOriginCredentials,
  createSecretRequest,
  getSecret,
  getSecretStatus,
  postSecret,
  revokeSecretRequest,
  uploadStreamingFile,
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
  it('returns a validated creation response', async () => {
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

  it('returns errors separately from response data', async () => {
    fetchMock.mockResolvedValue(
      fakeResponse({ status: 400, body: { message: 'Invalid expiration' } }),
    );

    const result = await postSecret(
      { message: 'x', expiration: 1, one_time: true },
      false,
    );

    expect(result).toEqual({
      data: null,
      status: 400,
      message: 'Invalid expiration',
    });
  });
});

describe('creation response validation', () => {
  it.each([
    null,
    {},
    { message: 123 },
    { message: '' },
    { message: 'id', receipt_token: [] },
  ])('rejects malformed HTTP 200 response: %j', async body => {
    fetchMock.mockResolvedValue(fakeResponse({ status: 200, body }));
    const result = await postSecret(
      { message: 'ciphertext', expiration: 3600, one_time: true },
      false,
    );
    expect(result.data).toBeNull();
    expect(result.message).toBe('HTTP 200: unexpected response body');
  });

  it('does not render non-string server errors', async () => {
    fetchMock.mockResolvedValue(
      fakeResponse({ status: 500, body: { message: { error: 'failure' } } }),
    );
    expect((await getSecret('id', false)).message).toBe('HTTP 500');
  });
});

it('reports an empty creation response as an error', async () => {
  fetchMock.mockResolvedValue(fakeResponse({ status: 204 }));
  const result = await postSecret(
    { message: 'ciphertext', expiration: 3600, one_time: true },
    false,
  );
  expect(result).toEqual({
    data: null,
    status: 204,
    message: 'HTTP 204: unexpected response body',
  });
});

describe('streaming upload contract', () => {
  it('sends ciphertext unchanged with policy headers and authenticated cookies', async () => {
    const body = new Blob([new Uint8Array([0xc3, 0, 255])]);
    fetchMock.mockResolvedValue(
      fakeResponse({
        status: 200,
        body: { message: 'file-id', receipt_token: 'receipt' },
      }),
    );
    const result = await uploadStreamingFile({
      body,
      expiration: 86400,
      oneTime: false,
      requireAuth: true,
      receipt: true,
      oidcEnabled: true,
    });
    expect(fetchMock).toHaveBeenCalledWith('/create/file', {
      method: 'POST',
      body,
      credentials: 'include',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Yopass-Expiration': '86400',
        'X-Yopass-OneTime': 'false',
        'X-Yopass-RequireAuth': 'true',
        'X-Yopass-Receipt': 'true',
      },
    });
    expect(result.data).toEqual({
      message: 'file-id',
      receipt_token: 'receipt',
    });
  });
  it('rejects malformed upload success without inventing a file identifier', async () => {
    fetchMock.mockResolvedValue(fakeResponse({ status: 200, body: {} }));
    const result = await uploadStreamingFile({
      body: new Blob(),
      expiration: 3600,
      oneTime: true,
      oidcEnabled: false,
    });
    expect(result.data).toBeNull();
    expect(result.message).toContain('unexpected response body');
    const init = fetchMock.mock.calls[0][1];
    expect(init).not.toHaveProperty('credentials');
    expect(init.headers['X-Yopass-RequireAuth']).toBe('false');
    expect(init.headers['X-Yopass-Receipt']).toBe('false');
  });
});

describe.each(['text', 'file'] as const)(
  '%s receipt response validation',
  kind => {
    it.each([
      { receipt: true, token: undefined, valid: false },
      { receipt: true, token: '', valid: false },
      { receipt: true, token: 'receipt-token', valid: true },
      { receipt: false, token: undefined, valid: true },
      { receipt: false, token: '', valid: false },
    ])(
      'validates $token with receipt=$receipt',
      async ({ receipt, token, valid }) => {
        fetchMock.mockResolvedValue(
          fakeResponse({
            status: 200,
            body: { message: 'id', receipt_token: token },
          }),
        );
        const result =
          kind === 'text'
            ? await postSecret(
                {
                  message: 'ciphertext',
                  expiration: 3600,
                  one_time: true,
                  receipt,
                },
                false,
              )
            : await uploadStreamingFile({
                body: new Blob(),
                expiration: 3600,
                oneTime: true,
                receipt,
                oidcEnabled: false,
              });
        if (valid) {
          expect(result.data?.message).toBe('id');
          expect(result.message).toBeUndefined();
        } else {
          expect(result.data).toBeNull();
          expect(result.message).toBe('HTTP 200: unexpected response body');
        }
      },
    );
  },
);

describe('request creation validation', () => {
  const request = { public_key: 'public-key', expiration: 3600 };
  it.each([
    {},
    null,
    { id: '', token: 'token', expires_at: 100 },
    { id: 'id', token: ' ', expires_at: 100 },
    { id: 'id', expires_at: 100 },
    { id: 'id', token: 'token' },
    { id: 'id', token: 'token', expires_at: '100' },
    { id: 'id', token: 'token', expires_at: -1 },
    { id: 'id', token: 'token', expires_at: 1.5 },
    { id: 'id', token: 'token', expires_at: Infinity },
  ])('rejects malformed success %j', async body => {
    fetchMock.mockResolvedValue(fakeResponse({ status: 200, body }));
    expect(await createSecretRequest(request, false)).toEqual({
      data: null,
      status: 200,
      message: 'HTTP 200: unexpected response body',
    });
  });
  it('accepts a complete response and sends JSON with credentials', async () => {
    const body = { id: 'id', token: 'token', expires_at: 2000000000 };
    fetchMock.mockResolvedValue(fakeResponse({ status: 200, body }));
    expect((await createSecretRequest(request, true)).data).toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith(
      '/request',
      expect.objectContaining({
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      }),
    );
  });
  it('rejects an empty success', async () => {
    fetchMock.mockResolvedValue(fakeResponse({ status: 204 }));
    expect((await createSecretRequest(request, false)).message).toBe(
      'HTTP 204: unexpected response body',
    );
  });
});

it.each(['', '  ', '\n\t'])(
  'falls back to HTTP status for blank error %j',
  async message => {
    fetchMock.mockResolvedValue(
      fakeResponse({ status: 400, body: { message } }),
    );
    expect(
      (
        await postSecret(
          { message: 'ciphertext', expiration: 3600, one_time: true },
          false,
        )
      ).message,
    ).toBe('HTTP 400');
  },
);
