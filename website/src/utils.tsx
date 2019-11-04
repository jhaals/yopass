import * as openpgp from 'openpgp';

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

export const BACKEND_DOMAIN = process.env.REACT_APP_BACKEND_URL
  ? `${process.env.REACT_APP_BACKEND_URL}`
  : '';

export const postSecret = async (body: any) => {
  return post(BACKEND_DOMAIN + '/secret', body);
};

export const uploadFile = async (body: any) => {
  return post(BACKEND_DOMAIN + '/file', body);
};

const post = async (url: string, body: any) => {
  const request = await fetch(url, {
    body: JSON.stringify(body),
    method: 'POST',
  });
  return { data: await request.json(), status: request.status };
};

export const decryptMessage = async (data: string, passwords: string) => {
  const r = await openpgp.decrypt({
    message: await openpgp.message.readArmored(data),
    passwords,
  });
  return r.data as string;
};
export default randomString;
