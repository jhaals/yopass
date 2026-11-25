import { readMessage } from 'openpgp';
import { runInWorker } from '@shared/lib/decryptInWorker';
import {
  MalformedFileError,
  decryptFileMessage,
  decryptionConfig,
} from '@shared/lib/decryption';

// Files up to this size are decrypted from bytes, in a worker. Larger ones
// stream on the page's thread, so as not to hold several copies in memory.
// shortcut: OpenPGP.js passes each sender-chosen partial-length part of a
// stream on as its own chunk, so one-byte parts can still slow the page for
// larger files; streaming in the worker too would close that.
const maxBufferedFileSize = 64 << 20;

// Rejects with a MalformedFileError when the file cannot be parsed, and with
// a DecryptionTimeoutError when a buffered file takes too long.
export async function decryptFile(
  ciphertext: Blob,
  passwords: string,
): Promise<{
  data: Uint8Array | ReadableStream<Uint8Array>;
  filename: string;
}> {
  if (ciphertext.size <= maxBufferedFileSize) {
    const bytes = await ciphertext.arrayBuffer();
    return runInWorker('file', [bytes, passwords], [bytes]);
  }
  const message = await readMessage({
    binaryMessage: ciphertext.stream() as ReadableStream<Uint8Array>,
    config: decryptionConfig,
  }).catch(error => {
    throw new MalformedFileError(error);
  });
  const { data, filename } = await decryptFileMessage(message, passwords);
  return { data: data as ReadableStream<Uint8Array>, filename };
}
