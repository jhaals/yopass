// @vitest-environment node
import { beforeAll, describe, expect, it } from 'vitest';
import {
  decryptMessage,
  decryptRequestSecret,
  encryptFileWithPublicKey,
  encryptMessage,
  encryptWithPublicKey,
  generateRequestKeyPair,
  publicKeyFingerprint,
  type RequestKeyPair,
} from './crypto';

describe('password encryption', () => {
  it.each([false, true])(
    'round-trips Unicode text with Argon2=%s',
    async argon2 => {
      const plaintext = 'Secret: åäö 日本語 🔑\nsecond line';
      const encrypted = await encryptMessage(
        plaintext,
        'correct password',
        argon2,
      );
      expect(encrypted).not.toContain(plaintext);
      expect(
        (await decryptMessage(encrypted, 'correct password', 'utf8')).data,
      ).toBe(plaintext);
      await expect(
        decryptMessage(encrypted, 'wrong password', 'utf8'),
      ).rejects.toThrow();
    },
  );

  it('rejects truncated ciphertext', async () => {
    const encrypted = await encryptMessage('secret', 'password');
    await expect(
      decryptMessage(
        encrypted.slice(0, encrypted.length / 2),
        'password',
        'utf8',
      ),
    ).rejects.toThrow();
  });
});

describe('request encryption', () => {
  let keys: RequestKeyPair;
  beforeAll(async () => {
    keys = await generateRequestKeyPair();
  });

  it('returns the fingerprint of the generated public key', async () => {
    expect(await publicKeyFingerprint(keys.publicKey)).toBe(keys.fingerprint);
    await expect(publicKeyFingerprint('not a public key')).rejects.toThrow();
  });

  it('round-trips text with the corresponding private key', async () => {
    const encrypted = await encryptWithPublicKey(
      'secret text 🔒',
      keys.publicKey,
    );
    expect(await decryptRequestSecret(encrypted, keys.privateKey)).toEqual({
      kind: 'text',
      text: 'secret text 🔒',
    });
    const other = await generateRequestKeyPair();
    await expect(
      decryptRequestSecret(encrypted, other.privateKey),
    ).rejects.toThrow();
  });

  it('preserves a binary file and its Unicode filename', async () => {
    const bytes = new Uint8Array([0, 255, 128, 1, 13, 10]);
    const file = new File([bytes], '秘密.bin');
    const encrypted = await encryptFileWithPublicKey(file, keys.publicKey);
    expect(encrypted).not.toContain(file.name);
    expect(await decryptRequestSecret(encrypted, keys.privateKey)).toEqual({
      kind: 'file',
      data: bytes,
      filename: file.name,
    });
  });
});
