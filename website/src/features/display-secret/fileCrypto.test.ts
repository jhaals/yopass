// @vitest-environment node
import {
  createMessage,
  encrypt,
  generateKey,
  readMessage,
  readPrivateKey,
  type PrivateKey,
} from 'openpgp';
import { expect, it, vi } from 'vitest';
import { runInWorker } from '@shared/lib/decryptInWorker';
import { decryptFileMessage, decryptionOps } from '@shared/lib/decryption';
import { decryptFile } from './fileCrypto';

// The worker would run the same function.
vi.mock('@shared/lib/decryptInWorker', () => ({
  runInWorker: vi.fn((op: 'file', args: [ArrayBuffer, string]) =>
    decryptionOps[op](...args),
  ),
}));

async function encryptFile(content: Uint8Array, signingKeys: PrivateKey[]) {
  return (await encrypt({
    message: await createMessage({ binary: content }),
    passwords: 'password',
    signingKeys,
    format: 'binary',
    config: { aeadProtect: true },
  })) as Uint8Array<ArrayBuffer>;
}

it('does not hash a streamed file for its embedded signatures', async () => {
  // Each signing key adds a one-pass signature packet in front of the data.
  const signingKeys = await Promise.all(
    [1, 2, 3].map(async () =>
      readPrivateKey({
        armoredKey: (
          await generateKey({
            userIDs: [{ name: 'sender' }],
            format: 'armored',
          })
        ).privateKey,
      }),
    ),
  );
  const content = new Uint8Array(1000).fill(7);
  const encrypted = await encryptFile(content, signingKeys);
  const message = await readMessage({
    binaryMessage: new Blob([encrypted]).stream(),
  });
  const decrypted = await decryptFileMessage(message, 'password');
  // One verification, and one hash of the file, per packet without the fix.
  expect(decrypted.signatures).toHaveLength(0);
  const plaintext = await new Response(decrypted.data as BodyInit).bytes();
  expect(plaintext).toEqual(content);
});

it('decrypts a file framed in one-byte parts from bytes in the worker', async () => {
  const content = new Uint8Array(20000).fill(0x41);
  const filename = 'parts.txt';
  // A literal data packet with the smallest parts a sender may choose: a
  // first part of 512 bytes (0xe9), then one part per byte (0xe0).
  const body = Buffer.concat([
    Buffer.from([0x62, filename.length]),
    Buffer.from(filename),
    Buffer.alloc(4),
    content,
  ]);
  const literalPacket = Buffer.concat([
    Buffer.from([0xcb, 0xe9]),
    body.subarray(0, 512),
    Buffer.from([...body.subarray(512)].flatMap(byte => [0xe0, byte])),
    Buffer.from([0x00]),
  ]);
  const message = await createMessage({ binary: content });
  message.packets.write = () => literalPacket;
  const encrypted = (await encrypt({
    message,
    passwords: 'password',
    format: 'binary',
    config: { aeadProtect: true },
  })) as Uint8Array<ArrayBuffer>;

  const decrypted = await decryptFile(new Blob([encrypted]), 'password');
  // Streamed, OpenPGP.js would process every one-byte part as its own chunk.
  expect(runInWorker).toHaveBeenCalledWith(
    'file',
    [expect.any(ArrayBuffer), 'password'],
    [expect.any(ArrayBuffer)],
  );
  expect(decrypted.filename).toBe(filename);
  expect(await new Response(decrypted.data as BodyInit).bytes()).toEqual(
    content,
  );
});
