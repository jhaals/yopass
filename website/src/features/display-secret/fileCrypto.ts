import {
  decrypt,
  PacketList,
  readMessage,
  Signature,
  type Message,
} from 'openpgp';
import {
  assertBoundedKeyDerivation,
  decryptionConfig,
} from '@shared/lib/crypto';

// Given a stream, OpenPGP.js passes each sender-chosen partial-length part on
// as its own chunk, so one-byte parts freeze the tab; given bytes, it joins
// them in one pass. Only files too large to buffer a few copies of stream.
// shortcut: larger files can still be slowed this way; an upstream OpenPGP.js
// fix or decrypting in a worker would close that.
const maxBufferedFileSize = 64 << 20;

export async function readFile(ciphertext: Blob) {
  return readMessage({
    binaryMessage:
      ciphertext.size > maxBufferedFileSize
        ? (ciphertext.stream() as ReadableStream<Uint8Array>)
        : new Uint8Array(await ciphertext.arrayBuffer()),
    config: decryptionConfig,
  });
}

export function decryptFile(message: Message<Uint8Array>, passwords: string) {
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
