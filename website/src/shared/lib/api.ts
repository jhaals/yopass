export const backendDomain = process.env.YOPASS_BACKEND_URL
  ? `${process.env.YOPASS_BACKEND_URL}`
  : '';

export interface SecretBody {
  message: string;
  expiration: number;
  one_time: boolean;
}

type ApiResponse = {
  data: { message: string };
  status: number;
};

async function post(url: string, body: SecretBody): Promise<ApiResponse> {
  try {
    const request = await fetch(url, {
      body: JSON.stringify(body),
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    return { data: await request.json(), status: request.status };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Network request failed';
    return { data: { message }, status: 500 };
  }
}

export async function postSecret(body: SecretBody): Promise<ApiResponse> {
  return post(backendDomain + '/create/secret', body);
}

export async function uploadFile(body: SecretBody): Promise<ApiResponse> {
  return post(backendDomain + '/create/file', body);
}
