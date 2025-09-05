import {
  encrypt,
  decrypt,
  readMessage,
  createMessage,
  type DecryptMessageResult,
} from 'openpgp';

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
