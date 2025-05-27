import {
  encrypt,
  decrypt,
  readMessage,
  createMessage,
  type DecryptMessageResult,
} from "openpgp";

type Response = {
  // TODO: this shouldn't be any
  data: {
    message: string;
  };
  status: number;
};

export const randomString = (): string => {
  let text = "";
  const possible =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
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

export const backendDomain = process.env.YOPASS_BACKEND_URL
  ? `${process.env.YOPASS_BACKEND_URL}`
  : "";

export interface Secret {
  message: string;
  expiration: number;
  one_time: boolean;
}
export const postSecret = async (body: Secret): Promise<Response> => {
  return post(backendDomain + "/secret", body);
};

export const uploadFile = async (body: Secret): Promise<Response> => {
  return post(backendDomain + "/file", body);
};

const post = async (url: string, body: Secret): Promise<Response> => {
  try {
    const request = await fetch(url, {
      body: JSON.stringify(body),
      method: "POST",
    });

    if (!request.ok) {
      throw new Error(`HTTP error! status: ${request.status}`);
    }

    const data = await request.json();
    return { data, status: request.status };
  } catch (error) {
    return { data: { message: error as string }, status: 500 };
  }
};

export const decryptMessage = async (
  data: string,
  passwords: string,
  format: "utf8" | "binary"
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

export default randomString;
