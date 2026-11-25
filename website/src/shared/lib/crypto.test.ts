// @vitest-environment node
import { deflateSync } from 'node:zlib';
import {
  armor,
  createMessage,
  encrypt,
  enums,
  generateKey,
  readKey,
} from 'openpgp';
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

describe('key derivation limits', () => {
  async function encryptWith(
    passwords: string[],
    s2kArgon2Params?: { passes: number; parallelism: number },
  ) {
    return encrypt({
      message: await createMessage({ text: 'secret' }),
      passwords,
      config: s2kArgon2Params && {
        s2kType: enums.s2k.argon2,
        s2kArgon2Params: { ...s2kArgon2Params, memoryExponent: 10 },
      },
    });
  }

  it('accepts Argon2 passes and parallelism at the limits', async () => {
    const encrypted = await encryptWith(['key'], {
      passes: 16,
      parallelism: 16,
    });
    expect((await decryptMessage(encrypted, 'key', 'utf8')).data).toBe(
      'secret',
    );
  });

  it.each([
    [17, 4],
    [3, 17],
  ])('rejects Argon2 passes=%i parallelism=%i', async (passes, parallelism) => {
    const encrypted = await encryptWith(['key'], { passes, parallelism });
    await expect(decryptMessage(encrypted, 'key', 'utf8')).rejects.toThrow(
      /key derivation cost/,
    );
  });

  it('rejects more than 8 password key packets', async () => {
    const passwords = Array.from({ length: 9 }, (_, i) => `k${i}`);
    const atLimit = await encryptWith(passwords.slice(0, 8));
    expect((await decryptMessage(atLimit, 'k0', 'utf8')).data).toBe('secret');
    const over = await encryptWith(passwords);
    await expect(decryptMessage(over, 'k0', 'utf8')).rejects.toThrow(
      /key derivation cost/,
    );
  });
});

describe('request key algorithms', () => {
  const refusal = /Unsupported request key algorithm/;

  it('refuses an RSA key before fingerprinting or encrypting', async () => {
    const { publicKey } = await generateKey({
      type: 'rsa',
      rsaBits: 2048,
      userIDs: [{ name: 'Yopass Secret Request' }],
      format: 'armored',
    });
    await expect(publicKeyFingerprint(publicKey)).rejects.toThrow(refusal);
    await expect(encryptWithPublicKey('secret', publicKey)).rejects.toThrow(
      refusal,
    );
    await expect(
      encryptFileWithPublicKey(new File(['secret'], 'secret.txt'), publicKey),
    ).rejects.toThrow(refusal);
  });

  it('refuses a DSA key without verifying its self-signatures', async () => {
    function mpi(value: number) {
      return [0, 32 - Math.clz32(value), value];
    }
    // A v4 DSA primary key (p, q, g, y) and a user ID.
    const key = new Uint8Array([
      ...[0xc6, 18, 4, 0, 0, 0, 1, enums.publicKey.dsa],
      ...[...mpi(23), ...mpi(11), ...mpi(2), ...mpi(3)],
      ...[0xcd, 1, 0x41],
    ]);
    const publicKey = armor(enums.armor.publicKey, key);
    expect(
      (await readKey({ armoredKey: publicKey })).getAlgorithmInfo(),
    ).toEqual({ algorithm: 'dsa', bits: 5 });
    await expect(publicKeyFingerprint(publicKey)).rejects.toThrow(refusal);
    await expect(encryptWithPublicKey('secret', publicKey)).rejects.toThrow(
      refusal,
    );
  });

  it('accepts an RFC 9580 Curve25519 key', async () => {
    const { publicKey } = await generateKey({
      type: 'curve25519',
      userIDs: [{ name: 'Yopass Secret Request' }],
      format: 'armored',
      config: { v6Keys: true },
    });
    await expect(publicKeyFingerprint(publicKey)).resolves.toMatch(
      /^[0-9a-f]+$/,
    );
    await expect(encryptWithPublicKey('secret', publicKey)).resolves.toContain(
      'BEGIN PGP MESSAGE',
    );
  });

  it('refuses a Curve25519 key with a subkey of another algorithm', async () => {
    const { privateKey } = await generateKey({
      userIDs: [{ name: 'Yopass Secret Request' }],
      subkeys: [{ type: 'rsa', rsaBits: 2048 }],
      format: 'object',
    });
    const publicKey = privateKey.toPublic().armor();
    await expect(publicKeyFingerprint(publicKey)).rejects.toThrow(refusal);
  });
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
