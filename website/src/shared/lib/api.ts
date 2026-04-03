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
    return {
      data: { message: error instanceof Error ? error.message : String(error) },
      status: 500,
    };
  }
}

export async function postSecret(body: SecretBody): Promise<ApiResponse> {
  return post(backendDomain + '/create/secret', body);
}

export interface BundleFile {
  key: string;
  filename: string;
  size: number;
}

export interface BundleManifest {
  files: BundleFile[];
  one_time: boolean;
  expiration: number;
}

export async function createBundle(
  fileKeys: string[],
  filenames: string[],
  sizes: number[],
  expiration: number,
  oneTime: boolean,
): Promise<{ data: { message: string }; status: number }> {
  try {
    const response = await fetch(`${backendDomain}/create/bundle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        file_keys: fileKeys,
        filenames,
        sizes,
        expiration,
        one_time: oneTime,
      }),
    });
    return { data: await response.json(), status: response.status };
  } catch (error) {
    return {
      data: { message: error instanceof Error ? error.message : String(error) },
      status: 500,
    };
  }
}

export async function getBundle(key: string): Promise<BundleManifest> {
  const response = await fetch(`${backendDomain}/bundle/${key}`);
  if (!response.ok) {
    throw new Error('Failed to fetch bundle');
  }
  return response.json() as Promise<BundleManifest>;
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
        'X-Yopass-Filename': params.filename.replace(
          // eslint-disable-next-line no-control-regex
          /[\x00-\x1f\x7f]/g,
          '',
        ),
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
