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
}

type ApiResponse = {
  data: { message: string };
  status: number;
};

// Adapts a jsonFetch result to the legacy ApiResponse shape used by the create
// endpoints, where the body always carries a `message` (the new secret's id on
// success, or an error string on failure).
function toApiResponse(result: {
  data: { message: string } | null;
  status: number;
  message?: string;
}): ApiResponse {
  return {
    data: {
      message: result.data?.message ?? result.message ?? 'Unknown error',
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
    await jsonFetch<{ message: string }>(url, {
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
): Promise<{ data: T | null; status: number; message?: string }> {
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
      return {
        data: null,
        status: response.status,
        message:
          (body as { message?: string } | null)?.message ??
          `HTTP ${response.status}`,
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

export async function fulfillSecretRequest(id: string, message: string) {
  return jsonFetch<{ message: string }>(
    `${backendDomain}/request/${id}/secret`,
    {
      method: 'POST',
      body: JSON.stringify({ message }),
    },
  );
}

export async function fetchRequestSecret(id: string, token: string) {
  return jsonFetch<{ message: string }>(
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
  oidcEnabled: boolean;
}): Promise<ApiResponse> {
  return toApiResponse(
    await jsonFetch<{ message: string }>(`${backendDomain}/create/file`, {
      method: 'POST',
      body: params.body,
      ...crossOriginCredentials(params.oidcEnabled),
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Yopass-Expiration': String(params.expiration),
        'X-Yopass-OneTime': String(params.oneTime),
        'X-Yopass-RequireAuth': String(params.requireAuth ?? false),
      },
    }),
  );
}
