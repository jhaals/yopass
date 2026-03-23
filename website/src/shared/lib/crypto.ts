import {
  encrypt,
  decrypt,
  readMessage,
  createMessage,
  enums,
  type DecryptMessageResult,
  type Config,
} from 'openpgp';

export const encryptionConfig: Partial<Config> = {
  aeadProtect: true,
  preferredAEADAlgorithm: enums.aead.gcm,
  s2kType: enums.s2k.argon2,
};

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
    config: encryptionConfig,
  });
}
