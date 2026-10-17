// @vitest-environment node
import { deflateSync } from 'node:zlib';
import { armor, createMessage, encrypt, enums, readKey } from 'openpgp';
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
    expect(
      await decryptRequestSecret(encrypted, keys.privateKey, 'file'),
    ).toEqual({
      kind: 'file',
      data: bytes,
      filename: file.name,
    });
  });

  it.each(['text', undefined] as const)(
    'treats a filename as text for kind %s',
    async kind => {
      const encrypted = await encryptFileWithPublicKey(
        new File(['text answer'], 'answer.txt'),
        keys.publicKey,
      );
      expect(
        await decryptRequestSecret(encrypted, keys.privateKey, kind),
      ).toEqual({ kind: 'text', text: 'text answer' });
    },
  );

  it('keeps a file response binary even when its filename is absent', async () => {
    const encrypted = await encryptWithPublicKey(
      'binary contents',
      keys.publicKey,
    );
    expect(
      await decryptRequestSecret(encrypted, keys.privateKey, 'file'),
    ).toEqual({
      kind: 'file',
      data: new TextEncoder().encode('binary contents'),
      filename: 'download',
    });
  });
});

it('rejects excessive sender-selected Argon2 memory before deriving a key', async () => {
  const forged = `-----BEGIN PGP MESSAGE-----

wxYECQQAAAAAAAAAAAAAAAAAAAAAAQEe0kEBAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==
-----END PGP MESSAGE-----`;
  await expect(decryptMessage(forged, 'anykey', 'utf8')).rejects.toThrow(
    /maxArgon2MemoryExponent/,
  );
});

describe('decompression limits', () => {
  const oversized = 'x'.repeat(2 << 20);
  const compressedConfig = {
    preferredCompressionAlgorithm: enums.compression.zlib,
  };

  it('rejects oversized compressed password messages', async () => {
    const encrypted = await encrypt({
      message: await createMessage({ text: oversized }),
      passwords: 'key',
      config: compressedConfig,
    });
    await expect(decryptMessage(encrypted, 'key', 'utf8')).rejects.toThrow(
      /Maximum decompressed message size exceeded/,
    );
  });

  it('rejects oversized compressed request messages', async () => {
    const keys = await generateRequestKeyPair();
    const encrypted = await encrypt({
      message: await createMessage({ text: oversized }),
      encryptionKeys: await readKey({ armoredKey: keys.publicKey }),
      config: compressedConfig,
    });
    await expect(
      decryptRequestSecret(encrypted, keys.privateKey),
    ).rejects.toThrow(/Maximum decompressed message size exceeded/);
  });

  it('bounds decompression during parsing before decryption starts', async () => {
    function packet(tag: number, data: Uint8Array) {
      const header = new Uint8Array(6);
      header[0] = 0xc0 | tag;
      header[1] = 255;
      new DataView(header.buffer).setUint32(2, data.length);
      return new Uint8Array([...header, ...data]);
    }
    const literal = packet(
      11,
      new Uint8Array([
        117,
        0,
        0,
        0,
        0,
        0,
        ...new TextEncoder().encode(oversized),
      ]),
    );
    const compressed = packet(8, new Uint8Array([2, ...deflateSync(literal)]));
    const message = armor(enums.armor.message, compressed);
    await expect(decryptMessage(message, 'key', 'utf8')).rejects.toThrow(
      /Maximum decompressed message size exceeded/,
    );
  });

  it('keeps small compressed and large uncompressed messages compatible', async () => {
    for (const [plaintext, config] of [
      ['small', compressedConfig],
      [
        oversized,
        { preferredCompressionAlgorithm: enums.compression.uncompressed },
      ],
    ] as const) {
      const encrypted = await encrypt({
        message: await createMessage({ text: plaintext }),
        passwords: 'key',
        config,
      });
      expect((await decryptMessage(encrypted, 'key', 'utf8')).data).toBe(
        plaintext,
      );
    }
  });
});
