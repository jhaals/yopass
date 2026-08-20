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

// Returns the encryption config, optionally with Argon2 key derivation.
// Argon2 is opt-in (server flag --argon2) because its WASM implementation
// requires the 'wasm-unsafe-eval' CSP directive.
export function getEncryptionConfig(argon2?: boolean): Partial<Config> {
  if (argon2) {
    return { ...encryptionConfig, s2kType: enums.s2k.argon2 };
  }
  return encryptionConfig;
}

export async function encryptMessage(
  data: string,
  passwords: string,
  argon2?: boolean,
) {
  return encrypt({
    message: await createMessage({ text: data }),
    passwords,
    config: getEncryptionConfig(argon2),
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

// Encrypts a file for a secret request. The filename travels inside the
// encrypted literal data packet, so the server never sees it.
export async function encryptFileWithPublicKey(
  file: File,
  armoredPublicKey: string,
): Promise<string> {
  return encrypt({
    message: await createMessage({
      binary: new Uint8Array(await file.arrayBuffer()),
      filename: file.name,
    }),
    encryptionKeys: await readKey({ armoredKey: armoredPublicKey }),
    config: encryptionConfig,
  }) as Promise<string>;
}

export type DecryptedRequestSecret =
  | { kind: 'text'; text: string }
  | { kind: 'file'; data: Uint8Array<ArrayBuffer>; filename: string };

// Decrypts a secret provided for a request. A filename in the literal data
// packet marks a file response; without one the payload is a text secret
// (including all secrets provided before file responses existed).
export async function decryptRequestSecret(
  armoredMessage: string,
  armoredPrivateKey: string,
): Promise<DecryptedRequestSecret> {
  const result = await decrypt({
    message: await readMessage({ armoredMessage }),
    decryptionKeys: await readPrivateKey({ armoredKey: armoredPrivateKey }),
    format: 'binary',
  });
  const data = result.data as Uint8Array<ArrayBuffer>;
  if (result.filename) {
    return { kind: 'file', data, filename: result.filename };
  }
  return { kind: 'text', text: new TextDecoder().decode(data) };
}
