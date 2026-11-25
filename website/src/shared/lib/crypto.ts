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
  type Message,
} from 'openpgp';
import { safeFilename } from './safeFilename';

export const encryptionConfig: Partial<Config> = {
  aeadProtect: true,
  preferredAEADAlgorithm: enums.aead.gcm,
};

// Bound sender-selected costs; Yopass emits uncompressed messages.
export const decryptionConfig: Partial<Config> = {
  maxArgon2MemoryExponent: 17,
  maxDecompressedMessageSize: 1 << 20,
};

// openpgp.js caps only Argon2 memory and derives a key per password packet,
// so match the CLI's pass, lane and packet caps before decrypting.
const maxArgon2Passes = 16;
const maxArgon2Parallelism = 16;
const maxPasswordKeyPackets = 8;

export function assertBoundedKeyDerivation<T>(message: Message<T>): Message<T> {
  // openpgp.js does not type the parsed S2K fields.
  const packets = message.packets.filterByTag(
    enums.packet.symEncryptedSessionKey,
  ) as unknown as { s2k?: { type: string; t: number; p: number } }[];
  if (
    packets.length > maxPasswordKeyPackets ||
    packets.some(
      ({ s2k }) =>
        s2k?.type === 'argon2' &&
        (s2k.t > maxArgon2Passes || s2k.p > maxArgon2Parallelism),
    )
  ) {
    throw new Error('Message key derivation cost exceeds Yopass limits');
  }
  return message;
}

export async function decryptMessage(
  data: string,
  passwords: string,
  format: 'utf8' | 'binary',
): Promise<DecryptMessageResult> {
  return decrypt({
    message: assertBoundedKeyDerivation(
      await readMessage({ armoredMessage: data, config: decryptionConfig }),
    ),
    passwords,
    format,
    config: decryptionConfig,
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

// openpgp.js verifies a key's self-signatures before applying its algorithm
// policy, and RSA, DSA and ElGamal cost whatever the requester's parameters
// make them cost, so accept only the Curve25519 keys Yopass generates.
const requestKeyAlgorithms = new Set(['eddsaLegacy', 'ed25519', 'x25519']);

async function readRequestPublicKey(armoredPublicKey: string) {
  const key = await readKey({ armoredKey: armoredPublicKey });
  for (const part of [key, ...key.subkeys]) {
    const { algorithm, curve } = part.getAlgorithmInfo();
    const legacyX25519 = algorithm === 'ecdh' && curve === 'curve25519Legacy';
    if (!legacyX25519 && !requestKeyAlgorithms.has(algorithm)) {
      throw new Error(`Unsupported request key algorithm: ${algorithm}`);
    }
  }
  return key;
}

export async function publicKeyFingerprint(
  armoredPublicKey: string,
): Promise<string> {
  const key = await readRequestPublicKey(armoredPublicKey);
  return key.getFingerprint();
}

export async function encryptWithPublicKey(
  data: string,
  armoredPublicKey: string,
): Promise<string> {
  return encrypt({
    message: await createMessage({ text: data }),
    encryptionKeys: await readRequestPublicKey(armoredPublicKey),
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
    encryptionKeys: await readRequestPublicKey(armoredPublicKey),
    config: encryptionConfig,
  }) as Promise<string>;
}

export type DecryptedRequestSecret =
  | { kind: 'text'; text: string }
  | { kind: 'file'; data: Uint8Array<ArrayBuffer>; filename: string };

// Legacy responses without a kind predate file responses and contain text.
export async function decryptRequestSecret(
  armoredMessage: string,
  armoredPrivateKey: string,
  kind: 'text' | 'file' = 'text',
): Promise<DecryptedRequestSecret> {
  const result = await decrypt({
    message: await readMessage({ armoredMessage, config: decryptionConfig }),
    decryptionKeys: await readPrivateKey({ armoredKey: armoredPrivateKey }),
    format: 'binary',
    config: decryptionConfig,
  });
  const data = result.data as Uint8Array<ArrayBuffer>;
  if (kind === 'file') {
    return { kind: 'file', data, filename: safeFilename(result.filename) };
  }
  return { kind: 'text', text: new TextDecoder().decode(data) };
}
