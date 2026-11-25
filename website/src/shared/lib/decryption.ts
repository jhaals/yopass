// Decryption of messages chosen by someone else. The browser runs this module
// in a worker (decryption.worker.ts), because OpenPGP.js parses and decrypts
// on the thread that calls it and the sender picks how long that takes.
import {
  decrypt,
  PacketList,
  readMessage,
  readPrivateKey,
  Signature,
  enums,
  type Config,
  type Message,
} from 'openpgp';
import { safeFilename } from './safeFilename';

// Bound sender-selected costs; Yopass emits uncompressed messages.
export const decryptionConfig: Partial<Config> = {
  maxArgon2MemoryExponent: 17,
  maxDecompressedMessageSize: 1 << 20,
};

// openpgp.js caps only Argon2 memory and derives a key for every password
// packet, so apply the CLI's pass, lane and packet caps before decrypting,
// and sum passes and iteration counts over the message.
const maxArgon2Passes = 16;
const maxArgon2Parallelism = 16;
const maxPasswordKeyPackets = 8;
// The most one key packet can encode; GnuPG writes one such packet.
const maxIteratedBytes = 65011712;

// openpgp.js decrypts the whole message once per session key its public-key
// packets yield; Yopass emits one, so this bounds a responder to 8 passes.
const maxPublicKeyPackets = 8;

export function assertBoundedKeyDerivation<T>(message: Message<T>): Message<T> {
  // openpgp.js does not type the parsed S2K fields.
  const packets = message.packets.filterByTag(
    enums.packet.symEncryptedSessionKey,
  ) as unknown as {
    s2k?: {
      type: string;
      t: number;
      p: number;
      algorithm: number;
      getCount(): number;
    };
  }[];
  let passes = 0;
  let iteratedBytes = 0;
  let tooCostly = packets.length > maxPasswordKeyPackets;
  for (const { s2k } of packets) {
    if (s2k?.type === 'argon2') {
      passes += s2k.t;
      tooCostly ||= s2k.p > maxArgon2Parallelism;
    } else if (s2k?.type === 'iterated') {
      iteratedBytes += s2k.getCount();
      // openpgp.js hashes the rest in JavaScript, synchronously.
      const { sha1, sha256, sha384, sha512 } = enums.hash;
      tooCostly ||= ![sha1, sha256, sha384, sha512].includes(s2k.algorithm);
    }
  }
  if (
    tooCostly ||
    passes > maxArgon2Passes ||
    iteratedBytes > maxIteratedBytes
  ) {
    throw new Error('Message key derivation cost exceeds Yopass limits');
  }
  return message;
}

export async function decryptMessage(
  data: string,
  passwords: string,
  format: 'utf8' | 'binary',
): Promise<{ data: string | Uint8Array; filename: string }> {
  const { data: plaintext, filename } = await decrypt({
    message: assertBoundedKeyDerivation(
      await readMessage({ armoredMessage: data, config: decryptionConfig }),
    ),
    passwords,
    format,
    config: decryptionConfig,
  });
  return { data: plaintext as string | Uint8Array, filename };
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
  const message = await readMessage({
    armoredMessage,
    config: decryptionConfig,
  });
  if (
    message.packets.filterByTag(enums.packet.publicKeyEncryptedSessionKey)
      .length > maxPublicKeyPackets
  ) {
    throw new Error('Too many session key packets');
  }
  const result = await decrypt({
    message,
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

// A file that cannot be parsed is a transport problem, not a wrong key.
export class MalformedFileError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : 'Malformed file');
    this.name = 'MalformedFileError';
  }
}

export function decryptFileMessage<
  T extends Uint8Array | ReadableStream<Uint8Array>,
>(message: Message<T>, passwords: string) {
  return decrypt({
    message: assertBoundedKeyDerivation(message),
    passwords,
    format: 'binary',
    // Yopass verifies no signatures, but on a stream OpenPGP.js hashes the
    // whole file once per sender-supplied one-pass signature packet; an
    // empty detached signature skips the embedded ones.
    signature: new Signature(new PacketList()),
    config: decryptionConfig,
  });
}

// Given bytes, OpenPGP.js joins sender-chosen partial-length parts in one
// pass; given a stream, it passes each part on as a chunk of its own.
export async function decryptFileBytes(
  ciphertext: ArrayBuffer,
  passwords: string,
): Promise<{ data: Uint8Array; filename: string }> {
  const message = await readMessage({
    binaryMessage: new Uint8Array(ciphertext),
    config: decryptionConfig,
  }).catch(error => {
    throw new MalformedFileError(error);
  });
  const { data, filename } = await decryptFileMessage(message, passwords);
  return { data: data as Uint8Array, filename };
}

export const decryptionOps = {
  message: decryptMessage,
  request: decryptRequestSecret,
  file: decryptFileBytes,
};
export type DecryptionOps = typeof decryptionOps;

export interface DecryptionRequest {
  op: keyof DecryptionOps;
  args: unknown[];
}

export type DecryptionResponse =
  { ok: true; result: unknown } | { ok: false; name: string; message: string };

// What the worker posts back for a request, and which buffers it hands over.
export async function runDecryptionOp({
  op,
  args,
}: DecryptionRequest): Promise<[DecryptionResponse, Transferable[]]> {
  try {
    const result = await (
      decryptionOps[op] as (...args: unknown[]) => Promise<{ data?: unknown }>
    )(...args);
    const transfer =
      result.data instanceof Uint8Array ? [result.data.buffer] : [];
    return [{ ok: true, result }, transfer];
  } catch (error) {
    const { name, message } =
      error instanceof Error ? error : new Error(String(error));
    return [{ ok: false, name, message }, []];
  }
}
