export const backendDomain = process.env.YOPASS_BACKEND_URL
  ? `${process.env.YOPASS_BACKEND_URL}`
  : '';

// Only include credentials (cookies) when OIDC auth is enabled.
// Without auth the backend uses a wildcard CORS origin, which browsers
// reject when credentials mode is 'include'.
export function crossOriginCredentials(oidcEnabled: boolean): RequestInit {
  return oidcEnabled ? { credentials: 'include' } : {};
}

export interface SecretBody {
  message: string;
  expiration: number;
  one_time: boolean;
  require_auth?: boolean;
  receipt?: boolean;
}

export interface ApiResult<T> {
  data: T | null;
  status: number;
  message?: string;
}

interface CreatedSecret {
  message: string;
  receipt_token?: string;
}

function isCreatedSecret(value: unknown): value is CreatedSecret {
  if (typeof value !== 'object' || value === null) return false;
  const data = value as Record<string, unknown>;
  return (
    typeof data.message === 'string' &&
    data.message.length > 0 &&
    (data.receipt_token === undefined || typeof data.receipt_token === 'string')
  );
}

export async function postSecret(body: SecretBody, oidcEnabled: boolean) {
  return jsonFetch<CreatedSecret>(
    `${backendDomain}/create/secret`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      ...crossOriginCredentials(oidcEnabled),
    },
    isCreatedSecret,
  );
}

export interface SecretStatus {
  oneTime: boolean;
  requireAuth: boolean;
}

// Non-destructive status check used by the prefetch flow. isFile selects the
// /file namespace used by streaming uploads.
export async function getSecretStatus(
  id: string,
  isFile: boolean,
  oidcEnabled: boolean,
) {
  return jsonFetch<SecretStatus>(
    `${backendDomain}/${isFile ? 'file' : 'secret'}/${id}/status`,
    { method: 'GET', ...crossOriginCredentials(oidcEnabled) },
  );
}

// Fetches (and for one-time secrets, consumes) an encrypted text secret.
export async function getSecret(id: string, oidcEnabled: boolean) {
  return jsonFetch<{ message: string }>(`${backendDomain}/secret/${id}`, {
    method: 'GET',
    ...crossOriginCredentials(oidcEnabled),
  });
}

// --- Read receipts (business feature) ---

const receiptTokenHeader = 'X-Yopass-Receipt-Token';

export interface ReceiptStatus {
  state: 'pending' | 'viewed';
  one_time: boolean;
  created_at: number;
  viewed_at?: number;
  expires_at: number;
}

export async function getSecretReceipt(id: string, token: string) {
  return jsonFetch<ReceiptStatus>(`${backendDomain}/secret/${id}/receipt`, {
    method: 'GET',
    headers: { [receiptTokenHeader]: token },
  });
}

// --- Secret requests (business feature) ---

const requestTokenHeader = 'X-Yopass-Request-Token';

export interface CreateRequestBody {
  public_key: string;
  label?: string;
  expiration: number;
}

export interface CreateRequestResponse {
  id: string;
  token: string;
  expires_at: number;
}

export interface SecretRequestInfo {
  public_key: string;
  label: string;
  state: 'pending' | 'fulfilled';
  expires_at: number;
}

async function jsonFetch<T>(
  url: string,
  init: RequestInit,
  validate?: (value: unknown) => value is T,
): Promise<ApiResult<T>> {
  try {
    const response = await fetch(url, init);
    if (response.status === 204 && !validate) {
      return { data: null, status: response.status };
    }
    let body: T | null = null;
    let parseError = false;
    body = await response.json().catch(() => {
      parseError = true;
      return null;
    });
    if (!response.ok) {
      return {
        data: null,
        status: response.status,
        message: errorMessage(body) ?? `HTTP ${response.status}`,
      };
    }
    if (parseError || body == null || (validate && !validate(body))) {
      return {
        data: null,
        status: response.status,
        message: `HTTP ${response.status}: unexpected response body`,
      };
    }
    return { data: body, status: response.status };
  } catch (error) {
    return {
      data: null,
      status: 0,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function createSecretRequest(
  body: CreateRequestBody,
  oidcEnabled: boolean,
) {
  return jsonFetch<CreateRequestResponse>(`${backendDomain}/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ...crossOriginCredentials(oidcEnabled),
  });
}

export async function getSecretRequest(id: string) {
  return jsonFetch<SecretRequestInfo>(`${backendDomain}/request/${id}`, {
    method: 'GET',
  });
}

export type RequestSecretKind = 'text' | 'file';

export async function fulfillSecretRequest(
  id: string,
  message: string,
  kind: RequestSecretKind = 'text',
) {
  return jsonFetch<{ message: string }>(
    `${backendDomain}/request/${id}/secret`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, kind }),
    },
  );
}

// kind is absent in responses from servers predating file responses.
export async function fetchRequestSecret(id: string, token: string) {
  return jsonFetch<{ message: string; kind?: RequestSecretKind }>(
    `${backendDomain}/request/${id}/secret`,
    {
      method: 'GET',
      headers: { [requestTokenHeader]: token },
    },
  );
}

export async function revokeSecretRequest(id: string, token: string) {
  return jsonFetch<null>(`${backendDomain}/request/${id}`, {
    method: 'DELETE',
    headers: { [requestTokenHeader]: token },
  });
}

export async function rotateRequestKey(
  id: string,
  token: string,
  publicKey: string,
) {
  return jsonFetch<{ message: string }>(`${backendDomain}/request/${id}/key`, {
    method: 'PUT',
    body: JSON.stringify({ public_key: publicKey }),
    headers: {
      'Content-Type': 'application/json',
      [requestTokenHeader]: token,
    },
  });
}

export async function uploadStreamingFile(params: {
  body: Blob;
  expiration: number;
  oneTime: boolean;
  requireAuth?: boolean;
  receipt?: boolean;
  oidcEnabled: boolean;
}) {
  return jsonFetch<CreatedSecret>(
    `${backendDomain}/create/file`,
    {
      method: 'POST',
      body: params.body,
      ...crossOriginCredentials(params.oidcEnabled),
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Yopass-Expiration': String(params.expiration),
        'X-Yopass-OneTime': String(params.oneTime),
        'X-Yopass-RequireAuth': String(params.requireAuth ?? false),
        'X-Yopass-Receipt': String(params.receipt ?? false),
      },
    },
    isCreatedSecret,
  );
}

function errorMessage(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const message = (value as Record<string, unknown>).message;
  return typeof message === 'string' ? message : undefined;
}
