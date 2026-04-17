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

async function post(
  url: string,
  body: SecretBody,
  oidcEnabled: boolean,
): Promise<ApiResponse> {
  try {
    const request = await fetch(url, {
      body: JSON.stringify(body),
      method: 'POST',
      ...crossOriginCredentials(oidcEnabled),
    });
    return { data: await request.json(), status: request.status };
  } catch (error) {
    return {
      data: { message: error instanceof Error ? error.message : String(error) },
      status: 500,
    };
  }
}

export async function postSecret(
  body: SecretBody,
  oidcEnabled: boolean,
): Promise<ApiResponse> {
  return post(backendDomain + '/create/secret', body, oidcEnabled);
}

export async function uploadStreamingFile(params: {
  body: Blob;
  expiration: number;
  oneTime: boolean;
  requireAuth?: boolean;
  oidcEnabled: boolean;
}): Promise<ApiResponse> {
  try {
    const response = await fetch(`${backendDomain}/create/file`, {
      method: 'POST',
      body: params.body,
      ...crossOriginCredentials(params.oidcEnabled),
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Yopass-Expiration': String(params.expiration),
        'X-Yopass-OneTime': String(params.oneTime),
        'X-Yopass-RequireAuth': String(params.requireAuth ?? false),
      },
    });
    return { data: await response.json(), status: response.status };
  } catch (error) {
    return {
      data: { message: error instanceof Error ? error.message : String(error) },
      status: 500,
    };
  }
}
