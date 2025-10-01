import {
  encrypt,
  decrypt,
  readMessage,
  createMessage,
  type DecryptMessageResult,
} from 'openpgp';

export async function decryptMessage(
  data: string,
  passwords: string,
  format: 'utf8' | 'binary',
): Promise<DecryptMessageResult> {
  return decrypt({
    message: await readMessage({ armoredMessage: data }),
    passwords,
    format,
  });
}

export async function encryptMessage(data: string, passwords: string) {
  return encrypt({
    message: await createMessage({ text: data }),
    passwords,
  });
}
