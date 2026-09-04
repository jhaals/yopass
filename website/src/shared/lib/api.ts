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
  recipients?: string[];
}

type ApiResponse = {
  data: { message: string; receipt_token?: string };
  status: number;
};

// Adapts a jsonFetch result to the legacy ApiResponse shape used by the create
// endpoints, where the body always carries a `message` (the new secret's id on
// success, or an error string on failure).
function toApiResponse(result: {
  data: { message: string; receipt_token?: string } | null;
  status: number;
  message?: string;
}): ApiResponse {
  return {
    data: {
      message: result.data?.message ?? result.message ?? 'Unknown error',
      receipt_token: result.data?.receipt_token,
    },
    status: result.status,
  };
}

async function post(
  url: string,
  body: SecretBody,
  oidcEnabled: boolean,
): Promise<ApiResponse> {
  return toApiResponse(
    await jsonFetch<{ message: string; receipt_token?: string }>(url, {
      method: 'POST',
      body: JSON.stringify(body),
      ...crossOriginCredentials(oidcEnabled),
    }),
  );
}

export async function postSecret(
  body: SecretBody,
  oidcEnabled: boolean,
): Promise<ApiResponse> {
  return post(backendDomain + '/create/secret', body, oidcEnabled);
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
// A verification token is sent when the secret is bound to a recipient.
export async function getSecret(
  id: string,
  oidcEnabled: boolean,
  verificationToken?: string,
) {
  return jsonFetch<{ message: string }>(`${backendDomain}/secret/${id}`, {
    method: 'GET',
    ...verificationHeaders(verificationToken),
    ...crossOriginCredentials(oidcEnabled),
  });
}

// --- Recipient verification (business feature) ---

export const verificationTokenHeader = 'X-Yopass-Verification-Token';
export const recipientsHeader = 'X-Yopass-Recipients';

// verificationHeaders builds the RequestInit fragment carrying the retrieval
// token, or nothing when there is no token to send.
export function verificationHeaders(token?: string): RequestInit {
  return token ? { headers: { [verificationTokenHeader]: token } } : {};
}

// isVerificationRequired reports whether a failed retrieval was refused
// because the secret is bound to a recipient who has not verified yet.
// A 403 alone is not enough: authorizeSecretAccess uses the same status for a
// disallowed email domain.
export function isVerificationRequired(result: {
  status: number;
  verificationRequired?: boolean;
}): boolean {
  return result.status === 403 && result.verificationRequired === true;
}

// requestVerificationCode asks the server to mail a code to the given address.
// It always resolves the same way whether or not the address is one of the
// bound recipients — the server deliberately gives nothing away.
export async function requestVerificationCode(
  id: string,
  isFile: boolean,
  email: string,
) {
  return jsonFetch<null>(
    `${backendDomain}/${isFile ? 'file' : 'secret'}/${id}/verify`,
    { method: 'POST', body: JSON.stringify({ email }) },
  );
}

// redeemVerificationCode exchanges a delivered code for a short-lived
// retrieval token.
export async function redeemVerificationCode(
  id: string,
  isFile: boolean,
  email: string,
  code: string,
) {
  return jsonFetch<{ token: string }>(
    `${backendDomain}/${isFile ? 'file' : 'secret'}/${id}/verify`,
    { method: 'POST', body: JSON.stringify({ email, code }) },
  );
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
): Promise<{
  data: T | null;
  status: number;
  message?: string;
  verificationRequired?: boolean;
}> {
  try {
    const response = await fetch(url, init);
    if (response.status === 204) {
      return { data: null, status: response.status };
    }
    let body: T | null = null;
    let parseError = false;
    body = await response.json().catch(() => {
      parseError = true;
      return null;
    });
    if (!response.ok) {
      const verificationRequired =
        response.status === 403 &&
        (body as { verification_required?: boolean } | null)
          ?.verification_required === true;
      return {
        data: null,
        status: response.status,
        message:
          (body as { message?: string } | null)?.message ??
          `HTTP ${response.status}`,
        ...(verificationRequired ? { verificationRequired: true } : {}),
      };
    }
    if (parseError || body === null) {
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
    headers: { [requestTokenHeader]: token },
  });
}

export async function uploadStreamingFile(params: {
  body: Blob;
  expiration: number;
  oneTime: boolean;
  requireAuth?: boolean;
  receipt?: boolean;
  recipients?: string[];
  oidcEnabled: boolean;
}): Promise<ApiResponse> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/octet-stream',
    'X-Yopass-Expiration': String(params.expiration),
    'X-Yopass-OneTime': String(params.oneTime),
    'X-Yopass-RequireAuth': String(params.requireAuth ?? false),
    'X-Yopass-Receipt': String(params.receipt ?? false),
  };
  if (params.recipients?.length) {
    headers[recipientsHeader] = params.recipients.join(',');
  }
  return toApiResponse(
    await jsonFetch<{ message: string; receipt_token?: string }>(
      `${backendDomain}/create/file`,
      {
        method: 'POST',
        body: params.body,
        ...crossOriginCredentials(params.oidcEnabled),
        headers,
      },
    ),
  );
}
