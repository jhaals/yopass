// @vitest-environment node
import {
  createMessage,
  encrypt,
  generateKey,
  readMessage,
  readPrivateKey,
  type PrivateKey,
} from 'openpgp';
import { expect, it } from 'vitest';
import { decryptFile } from './fileCrypto';

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
  const decrypted = await decryptFile(message, 'password');
  // One verification, and one hash of the file, per packet without the fix.
  expect(decrypted.signatures).toHaveLength(0);
  const plaintext = await new Response(decrypted.data as BodyInit).bytes();
  expect(plaintext).toEqual(content);
});
