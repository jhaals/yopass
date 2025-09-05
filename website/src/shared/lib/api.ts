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

const post = async (url: string, body: SecretBody): Promise<ApiResponse> => {
  try {
    const request = await fetch(url, {
      body: JSON.stringify(body),
      method: 'POST',
    });
    return { data: await request.json(), status: request.status };
  } catch (error) {
    return { data: { message: error as string }, status: 500 };
  }
};

export const postSecret = async (body: SecretBody): Promise<ApiResponse> => {
  return post(backendDomain + '/secret', body);
};

export const uploadFile = async (body: SecretBody): Promise<ApiResponse> => {
  return post(backendDomain + '/file', body);
};
