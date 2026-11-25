import { decrypt, PacketList, Signature, type Message } from 'openpgp';
import {
  assertBoundedKeyDerivation,
  decryptionConfig,
} from '@shared/lib/crypto';

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
