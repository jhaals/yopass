import {
  encrypt,
  decrypt,
  readMessage,
  createMessage,
  DecryptMessageResult,
} from 'openpgp';

type Response = {
  // TODO: this shouldn't be any
  data: any;
  status: number;
};

export const randomString = (): string => {
  let text = '';
  const possible =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 22; i++) {
    text += possible.charAt(randomInt(0, possible.length));
  }
  return text;
};

const randomInt = (min: number, max: number): number => {
  const byteArray = new Uint8Array(1);
  window.crypto.getRandomValues(byteArray);

  const range = max - min;
  const maxRange = 256;
  if (byteArray[0] >= Math.floor(maxRange / range) * range) {
    return randomInt(min, max);
  }
  return min + (byteArray[0] % range);
};

export const backendDomain = process.env.REACT_APP_BACKEND_URL
  ? `${process.env.REACT_APP_BACKEND_URL}`
  : '';

export const postSecret = async (body: any): Promise<Response> => {
  return post(backendDomain + '/secret', body);
};

export const uploadFile = async (body: any): Promise<Response> => {
  return post(backendDomain + '/file', body);
};

const post = async (url: string, body: any): Promise<Response> => {
  const request = await fetch(url, {
    body: JSON.stringify(body),
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
  });
  return { data: await request.json(), status: request.status };
};

export const decryptMessage = async (
  data: string,
  passwords: string,
  format: 'utf8' | 'binary',
): Promise<DecryptMessageResult> => {
  return decrypt({
    message: await readMessage({ armoredMessage: data }),
    passwords,
    format,
  });
};

export const encryptMessage = async (data: string, passwords: string) => {
  return encrypt({
    message: await createMessage({ text: data }),
    passwords,
  });
};

export function isErrorWithMessage(
  error: unknown,
): error is { message: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof (error as Record<string, unknown>).message === 'string'
  );
}

export default randomString;
