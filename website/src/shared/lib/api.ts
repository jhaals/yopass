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
    });
    return { data: await request.json(), status: request.status };
  } catch (error) {
    return { data: { message: error as string }, status: 500 };
  }
}

export async function postSecret(body: SecretBody): Promise<ApiResponse> {
  return post(backendDomain + '/create/secret', body);
}

export async function uploadStreamingFile(params: {
  body: Blob;
  expiration: number;
  oneTime: boolean;
  filename: string;
}): Promise<ApiResponse> {
  try {
    const response = await fetch(`${backendDomain}/create/file`, {
      method: 'POST',
      body: params.body,
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Yopass-Expiration': String(params.expiration),
        'X-Yopass-OneTime': String(params.oneTime),
        'X-Yopass-Filename': params.filename,
      },
    });
    return { data: await response.json(), status: response.status };
  } catch (error) {
    return { data: { message: error as string }, status: 500 };
  }
}
