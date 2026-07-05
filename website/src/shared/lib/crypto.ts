import {
  encrypt,
  decrypt,
  readMessage,
  createMessage,
  generateKey,
  readKey,
  readPrivateKey,
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

export interface RequestKeyPair {
  privateKey: string;
  publicKey: string;
  fingerprint: string;
}

// Generates an ECC key pair for a secret request. The private key never
// leaves the requester's browser.
export async function generateRequestKeyPair(): Promise<RequestKeyPair> {
  const { privateKey, publicKey } = await generateKey({
    userIDs: [{ name: 'Yopass Secret Request' }],
    format: 'armored',
  });
  const key = await readKey({ armoredKey: publicKey });
  return { privateKey, publicKey, fingerprint: key.getFingerprint() };
}

export async function publicKeyFingerprint(
  armoredPublicKey: string,
): Promise<string> {
  const key = await readKey({ armoredKey: armoredPublicKey });
  return key.getFingerprint();
}

export async function encryptWithPublicKey(
  data: string,
  armoredPublicKey: string,
): Promise<string> {
  return encrypt({
    message: await createMessage({ text: data }),
    encryptionKeys: await readKey({ armoredKey: armoredPublicKey }),
    config: encryptionConfig,
  }) as Promise<string>;
}

export async function decryptWithPrivateKey(
  armoredMessage: string,
  armoredPrivateKey: string,
): Promise<string> {
  const result = await decrypt({
    message: await readMessage({ armoredMessage }),
    decryptionKeys: await readPrivateKey({ armoredKey: armoredPrivateKey }),
    format: 'utf8',
  });
  return result.data as string;
}
