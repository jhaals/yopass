// @vitest-environment node
import { createMessage, encrypt } from 'openpgp';
import { expect, it } from 'vitest';
import { runDecryptionOp } from './decryption';

async function encrypted(binary: Uint8Array) {
  return encrypt({
    message: await createMessage({ binary, filename: 'a.bin' }),
    passwords: 'key',
    format: 'binary',
  }) as Promise<Uint8Array<ArrayBuffer>>;
}

it('hands the decrypted buffer back instead of copying it', async () => {
  const ciphertext = await encrypted(new Uint8Array([1, 2, 3]));
  const [response, transfer] = await runDecryptionOp({
    op: 'file',
    args: [ciphertext.buffer, 'key'],
  });
  expect(response).toEqual({
    ok: true,
    result: { data: new Uint8Array([1, 2, 3]), filename: 'a.bin' },
  });
  expect(transfer).toEqual([
    (response as { result: { data: Uint8Array } }).result.data.buffer,
  ]);
});

it('reports errors as plain data that a worker can post', async () => {
  const [response, transfer] = await runDecryptionOp({
    op: 'file',
    args: [new ArrayBuffer(4), 'key'],
  });
  expect(response).toMatchObject({ ok: false, name: 'MalformedFileError' });
  expect(transfer).toEqual([]);
});
