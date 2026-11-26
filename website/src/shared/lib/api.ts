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
  // Email the signed-in creator on the first view. The server keeps a read
  // receipt for it, so a receipt token comes back either way.
  notify?: boolean;
  label?: string;
  // The one address that may open the secret, besides its signed-in creator.
  recipient?: string;
}

export interface ApiResult<T> {
  data: T | null;
  status: number;
  message?: string;
  // A stable code the server adds to some refusals, for translation.
  error?: string;
}

const translatedErrors: Record<string, string> = {
  recipient_unavailable: 'create.errorRecipientUnavailable',
  recipient_invalid: 'create.errorRecipientInvalid',
  recipient_cannot_sign_in: 'create.errorRecipientCannotSignIn',
  recipient_sign_in_again: 'create.errorRecipientSignInAgain',
  recipient_sign_in: 'create.errorRecipientSignIn',
  recipient_unconfirmed: 'create.errorRecipientUnconfirmed',
  notify_unavailable: 'create.errorNotifyUnavailable',
  notify_sign_in: 'create.errorNotifySignIn',
  notify_sign_in_again: 'create.errorNotifySignInAgain',
  notify_address_unusable: 'create.errorNotifyAddressUnusable',
  label_too_long: 'create.errorLabelTooLong',
  label_invalid: 'create.errorLabelInvalid',
};

// Whether a refusal said the secret is restricted to one recipient. Takes a
// result or a raw response body.
export function isRecipientRefusal(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const code = (value as Record<string, unknown>).error;
  return code === 'recipient_required' || code === 'not_recipient';
}

// The translation key for a refusal the interface knows, else undefined and
// the server's own message is shown.
export function errorKey(result: { error?: string }): string | undefined {
  return result.error ? translatedErrors[result.error] : undefined;
}

interface CreatedSecret {
  message: string;
  receipt_token?: string;
  // Confirms a requested recipient restriction.
  restricted?: boolean;
}

function isCreatedSecret(
  value: unknown,
  receiptRequested = false,
): value is CreatedSecret {
  if (typeof value !== 'object' || value === null) return false;
  const data = value as Record<string, unknown>;
  return (
    typeof data.message === 'string' &&
    data.message.trim().length > 0 &&
    ((data.receipt_token === undefined && !receiptRequested) ||
      (typeof data.receipt_token === 'string' &&
        data.receipt_token.trim().length > 0))
  );
}

// A restriction the server did not confirm, as from a server that ignores
// `recipient`, left the secret open. It is deleted again and counts as a
// failure, so its link is never shown.
async function confirmRestriction(
  result: ApiResult<CreatedSecret>,
  requested: boolean,
  isFile: boolean,
): Promise<ApiResult<CreatedSecret>> {
  if (!requested || !result.data || result.data.restricted === true) {
    return result;
  }
  try {
    await fetch(
      `${backendDomain}/${isFile ? 'file' : 'secret'}/${result.data.message}`,
      { method: 'DELETE', credentials: 'include' },
    );
  } catch {
    // Nothing more to do: the link is withheld either way.
  }
  return {
    data: null,
    status: result.status,
    error: 'recipient_unconfirmed',
    message: 'The server did not confirm the recipient restriction',
  };
}

export async function postSecret(body: SecretBody, oidcEnabled: boolean) {
  const result = await jsonFetch<CreatedSecret>(
    `${backendDomain}/create/secret`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      ...crossOriginCredentials(oidcEnabled),
    },
    (value): value is CreatedSecret =>
      isCreatedSecret(value, body.receipt || body.notify),
  );
  return confirmRestriction(result, !!body.recipient, false);
}

// IDs reach the calls below from links and imported files, already
// percent-decoded. The server only issues UUIDs and alphanumeric IDs; anything
// else ("?", "#", "../") could point the request at a different endpoint, e.g.
// turn a status check into a retrieval. Encoding alone does not prevent that,
// since the server's router decodes and cleans the path and then redirects.
export function isValidId(id: string) {
  return /^[a-zA-Z0-9-]+$/.test(id);
}

// What the server answers for an ID it cannot have issued.
const invalidId: ApiResult<never> = {
  data: null,
  status: 404,
  message: 'HTTP 404',
};

export interface SecretStatus {
  oneTime: boolean;
  requireAuth: boolean;
  // Only a named recipient may open it. The address is never sent.
  restricted?: boolean;
}

// Non-destructive status check used by the prefetch flow. isFile selects the
// /file namespace used by streaming uploads.
export async function getSecretStatus(
  id: string,
  isFile: boolean,
  oidcEnabled: boolean,
) {
  if (!isValidId(id)) return invalidId;
  return jsonFetch<SecretStatus>(
    `${backendDomain}/${isFile ? 'file' : 'secret'}/${id}/status`,
    { method: 'GET', ...crossOriginCredentials(oidcEnabled) },
  );
}

// Fetches (and for one-time secrets, consumes) an encrypted text secret.
export async function getSecret(id: string, oidcEnabled: boolean) {
  if (!isValidId(id)) return invalidId;
  return jsonFetch<{ message: string }>(`${backendDomain}/secret/${id}`, {
    method: 'GET',
    ...crossOriginCredentials(oidcEnabled),
  });
}

function postCode(
  id: string,
  isFile: boolean,
  route: string,
  body: Record<string, string>,
) {
  if (!isValidId(id)) return Promise.resolve(invalidId);
  return jsonFetch<{ message: string }>(
    `${backendDomain}/${isFile ? 'file' : 'secret'}/${id}/${route}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'include',
    },
  );
}

// Asks the server to email a one-time code to `email`. The answer is the same
// whether or not a code went out, so only the status is worth reading.
export function requestRecipientCode(
  id: string,
  isFile: boolean,
  email: string,
) {
  return postCode(id, isFile, 'code', { email });
}

// Trades a code for a cookie that opens this one secret for a while. The
// address it was sent to must come along.
export function verifyRecipientCode(
  id: string,
  isFile: boolean,
  email: string,
  code: string,
) {
  return postCode(id, isFile, 'code/verify', { email, code });
}

// Ends the session, then reloads on the home page. A form POST is a
// navigation, sent with `Origin: null` under Referrer-Policy no-referrer,
// which a server with --frontend-url refuses.
export async function signOut() {
  try {
    // The server's 303 is meant for navigations; following it cross-origin
    // only ends in a CORS error.
    await fetch(`${backendDomain}/auth/logout`, {
      method: 'POST',
      credentials: 'include',
      redirect: 'manual',
    });
  } catch {
    // The reload below shows whether the session is gone.
  }
  window.location.href = '/';
}

// --- Read receipts (business feature) ---

const receiptTokenHeader = 'X-Yopass-Receipt-Token';

export interface ReceiptStatus {
  state: 'pending' | 'viewed';
  one_time: boolean;
  created_at: number;
  viewed_at?: number;
  expires_at: number;
  // Who first opened a secret restricted to a recipient.
  viewer_email?: string;
}

// oidcEnabled sends the session cookie cross-origin, which --require-auth-all needs.
export async function getSecretReceipt(
  id: string,
  token: string,
  oidcEnabled = false,
) {
  if (!isValidId(id)) return invalidId;
  return jsonFetch<ReceiptStatus>(`${backendDomain}/secret/${id}/receipt`, {
    method: 'GET',
    headers: { [receiptTokenHeader]: token },
    ...crossOriginCredentials(oidcEnabled),
  });
}

// --- Secret requests (business feature) ---

const requestTokenHeader = 'X-Yopass-Request-Token';

export interface CreateRequestBody {
  public_key: string;
  label?: string;
  note?: string;
  expiration: number;
  // Email the signed-in creator when the request is fulfilled.
  notify?: boolean;
}

export interface CreateRequestResponse {
  id: string;
  token: string;
  expires_at: number;
}

export interface SecretRequestInfo {
  public_key: string;
  key_version?: string;
  label: string;
  note?: string;
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
        error: errorCode(body),
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

function isCreateRequestResponse(
  value: unknown,
): value is CreateRequestResponse {
  if (typeof value !== 'object' || value === null) return false;
  const data = value as Record<string, unknown>;
  return (
    typeof data.id === 'string' &&
    data.id.trim().length > 0 &&
    typeof data.token === 'string' &&
    data.token.trim().length > 0 &&
    typeof data.expires_at === 'number' &&
    Number.isSafeInteger(data.expires_at) &&
    data.expires_at > 0
  );
}

export async function createSecretRequest(
  body: CreateRequestBody,
  oidcEnabled: boolean,
) {
  return jsonFetch<CreateRequestResponse>(
    `${backendDomain}/request`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      ...crossOriginCredentials(oidcEnabled),
    },
    isCreateRequestResponse,
  );
}

export async function getSecretRequest(id: string) {
  if (!isValidId(id)) return invalidId;
  return jsonFetch<SecretRequestInfo>(`${backendDomain}/request/${id}`, {
    method: 'GET',
  });
}

export type RequestSecretKind = 'text' | 'file';

export async function fulfillSecretRequest(
  id: string,
  message: string,
  kind: RequestSecretKind = 'text',
  keyVersion = '',
) {
  if (!isValidId(id)) return invalidId;
  return jsonFetch<{ message: string }>(
    `${backendDomain}/request/${id}/secret`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, kind, key_version: keyVersion }),
    },
  );
}

// kind is absent in responses from servers predating file responses.
export async function fetchRequestSecret(
  id: string,
  token: string,
  oidcEnabled = false,
) {
  if (!isValidId(id)) return invalidId;
  return jsonFetch<{ message: string; kind?: RequestSecretKind }>(
    `${backendDomain}/request/${id}/secret`,
    {
      method: 'GET',
      headers: { [requestTokenHeader]: token },
      ...crossOriginCredentials(oidcEnabled),
    },
  );
}

export async function revokeSecretRequest(
  id: string,
  token: string,
  oidcEnabled = false,
) {
  if (!isValidId(id)) return invalidId;
  return jsonFetch<null>(`${backendDomain}/request/${id}`, {
    method: 'DELETE',
    headers: { [requestTokenHeader]: token },
    ...crossOriginCredentials(oidcEnabled),
  });
}

export async function rotateRequestKey(
  id: string,
  token: string,
  publicKey: string,
  oidcEnabled = false,
) {
  if (!isValidId(id)) return invalidId;
  return jsonFetch<{ message: string }>(`${backendDomain}/request/${id}/key`, {
    method: 'PUT',
    body: JSON.stringify({ public_key: publicKey }),
    headers: {
      'Content-Type': 'application/json',
      [requestTokenHeader]: token,
    },
    ...crossOriginCredentials(oidcEnabled),
  });
}

export async function uploadStreamingFile(params: {
  body: Blob;
  expiration: number;
  oneTime: boolean;
  requireAuth?: boolean;
  receipt?: boolean;
  notify?: boolean;
  label?: string;
  recipient?: string;
  oidcEnabled: boolean;
}) {
  const result = await jsonFetch<CreatedSecret>(
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
        ...(params.notify && {
          'X-Yopass-Notify': 'true',
          // Header values are ASCII only, so the label travels percent-encoded.
          'X-Yopass-Label': encodeURIComponent(params.label ?? ''),
        }),
        ...(params.recipient && {
          'X-Yopass-Recipient': encodeURIComponent(params.recipient),
        }),
      },
    },
    (value): value is CreatedSecret =>
      isCreatedSecret(value, params.receipt || params.notify),
  );
  return confirmRestriction(result, !!params.recipient, true);
}

function errorCode(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const code = (value as Record<string, unknown>).error;
  return typeof code === 'string' ? code : undefined;
}

function errorMessage(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const message = (value as Record<string, unknown>).message;
  return typeof message === 'string' && message.trim().length > 0
    ? message
    : undefined;
}
