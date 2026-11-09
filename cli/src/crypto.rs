//! OpenPGP encryption compatible with pkg/yopass/yopass.go and the website:
//! SKESKv6 + SEIPDv2 (AES-256/GCM) on encrypt; anything go-crypto reads on decrypt.

use pgp::armor::{self, BlockType, Dearmor, DearmorOptions};
use pgp::composed::{decrypt_session_key_with_password, DecryptionOptions, Esk, Message};
use pgp::crypto::aead::{AeadAlgorithm, ChunkSize};
use pgp::crypto::hash::HashAlgorithm;
use pgp::crypto::sym::SymmetricKeyAlgorithm;
use pgp::packet::{PacketTrait, SymEncryptedProtectedData, SymKeyEncryptedSessionKey};
use pgp::ser::Serialize;
use pgp::types::{Password, Seipdv1ReadMode, StringToKey};
use rand_core::OsRng;
use rand_core::RngCore;
use std::collections::BTreeMap;
use std::fmt;
use std::io::{Cursor, Read, Write};

const ARMOR_HEADER: &[u8] = b"-----BEGIN PGP MESSAGE-----";
const ITERATED_S2K_COUNT: u8 = 224;
const ARGON2_PASSES: u8 = 3;
const ARGON2_PARALLELISM: u8 = 4;
const ARGON2_MEMORY_EXP: u8 = 16; // 64 MiB
/// Default clients use 64 MiB; cap sender-controlled Argon2 memory at 128 MiB.
const MAX_ARGON2_MEMORY_EXP: u8 = 17;
/// Yopass clients use 3 passes, parallelism 4 and one key packet. Together these
/// bound the work a wrong key can trigger.
const MAX_ARGON2_PASSES: u8 = 16;
const MAX_ARGON2_PARALLELISM: u8 = 16;
const MAX_KEY_PACKETS: usize = 8;
const MAX_DECOMPRESSED_SIZE: u64 = 1 << 20;
const MAX_NESTED_COMPRESSION: usize = 32;

#[derive(Debug, PartialEq)]
pub enum DecryptError {
    InvalidMessage,
    InvalidKey,
    Read(String),
}

impl fmt::Display for DecryptError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidMessage => f.write_str("invalid message"),
            Self::InvalidKey => f.write_str("could not decrypt: invalid decryption key"),
            Self::Read(err) => write!(f, "could not read plaintext: {err}"),
        }
    }
}

struct Raw<'a>(&'a [u8]);

impl Serialize for Raw<'_> {
    fn to_writer<W: Write>(&self, writer: &mut W) -> pgp::errors::Result<()> {
        writer.write_all(self.0)?;
        Ok(())
    }
    fn write_len(&self) -> usize {
        self.0.len()
    }
}

/// rPGP's message builder drops the file name, which the website needs to save
/// downloads, so the literal packet is serialized here.
fn literal_packet(mode: u8, file_name: &[u8], mut data: Vec<u8>) -> Result<Vec<u8>, String> {
    let file_name = &file_name[..file_name.len().min(255)];
    let len = 1 + 1 + file_name.len() + 4 + data.len();
    let mut header = Vec::with_capacity(6 + 6 + file_name.len());
    header.push(0xc0 | 11);
    match len {
        0..=191 => header.push(len as u8),
        192..=8383 => {
            header.push((((len - 192) >> 8) + 192) as u8);
            header.push(((len - 192) & 0xff) as u8);
        }
        _ => {
            // shortcut: fixed lengths stop at 4 GiB where Go's partial lengths go on; upgrade if uploads get that big.
            let len = u32::try_from(len).map_err(|_| "file larger than 4 GiB".to_string())?;
            header.push(0xff);
            header.extend(len.to_be_bytes());
        }
    }
    header.push(mode);
    header.push(file_name.len() as u8);
    header.extend(file_name);
    header.extend([0; 4]); // No modification time, like the Go CLI.
    data.splice(0..0, header); // In place, so the plaintext is not held twice.
    Ok(data)
}

fn default_s2k(argon2: bool) -> StringToKey {
    if argon2 {
        StringToKey::new_argon2(OsRng, ARGON2_PASSES, ARGON2_PARALLELISM, ARGON2_MEMORY_EXP)
    } else {
        StringToKey::new_iterated(OsRng, HashAlgorithm::Sha256, ITERATED_S2K_COUNT)
    }
}

fn encrypt_packets(literal: &[u8], key: &[u8], s2k: StringToKey) -> pgp::errors::Result<Vec<u8>> {
    let mut rng = OsRng;
    let mut session_key = vec![0u8; SymmetricKeyAlgorithm::AES256.key_size()];
    rng.fill_bytes(&mut session_key);
    let skesk = SymKeyEncryptedSessionKey::encrypt_v6(
        &mut rng,
        &Password::from(key),
        &session_key.clone().into(),
        s2k,
        SymmetricKeyAlgorithm::AES256,
        AeadAlgorithm::Gcm,
    )?;
    let seipd = SymEncryptedProtectedData::encrypt_seipdv2(
        &mut rng,
        SymmetricKeyAlgorithm::AES256,
        AeadAlgorithm::Gcm,
        ChunkSize::C256KiB,
        &session_key,
        literal,
    )?;
    let mut out = Vec::new();
    skesk.to_writer_with_header(&mut out)?;
    seipd.to_writer_with_header(&mut out)?;
    Ok(out)
}

/// Armored message for the /create/secret endpoint.
pub fn encrypt(data: Vec<u8>, key: &[u8], argon2: bool) -> Result<String, String> {
    let literal = literal_packet(b'u', b"", data)?;
    let packets = encrypt_packets(&literal, key, default_s2k(argon2))
        .map_err(|err| format!("could not encrypt: {err}"))?;
    let headers = BTreeMap::from([("Comment".to_string(), vec!["https://yopass.se".to_string()])]);
    let mut out = Vec::new();
    armor::write(
        &Raw(&packets),
        BlockType::Message,
        &mut out,
        Some(&headers),
        true,
    )
    .map_err(|err| format!("could not close armor: {err}"))?;
    String::from_utf8(out).map_err(|err| format!("could not close armor: {err}"))
}

/// Binary message carrying the file name, for the /create/file endpoint.
pub fn encrypt_binary(
    data: Vec<u8>,
    key: &[u8],
    file_name: &[u8],
    argon2: bool,
) -> Result<Vec<u8>, String> {
    let literal = literal_packet(b'b', file_name, data)?;
    encrypt_packets(&literal, key, default_s2k(argon2))
        .map_err(|err| format!("could not encrypt: {err}"))
}

fn decrypt_options() -> DecryptionOptions {
    DecryptionOptions::new().set_seipdv1_read_mode(Seipdv1ReadMode::CheckFirst {
        max_message_size: usize::MAX,
    })
}

/// Rejects sender-chosen costs before any key derivation runs, so a hostile message
/// cannot pin the CPU. Checking rPGP's own parse result leaves no room for
/// disagreement with a separate pre-parser.
fn check_key_packets(esk: &[Esk]) -> Result<Vec<&SymKeyEncryptedSessionKey>, DecryptError> {
    let skesks: Vec<_> = esk
        .iter()
        .filter_map(|packet| match packet {
            Esk::SymKeyEncryptedSessionKey(skesk) => Some(skesk),
            Esk::PublicKeyEncryptedSessionKey(_) => None,
        })
        .collect();
    let too_costly = |skesk: &&SymKeyEncryptedSessionKey| {
        matches!(skesk.s2k(), Some(StringToKey::Argon2 { t, p, m_enc, .. })
            if *t > MAX_ARGON2_PASSES || *p > MAX_ARGON2_PARALLELISM || *m_enc > MAX_ARGON2_MEMORY_EXP)
    };
    if skesks.len() > MAX_KEY_PACKETS || skesks.iter().any(too_costly) {
        return Err(DecryptError::InvalidMessage);
    }
    Ok(skesks)
}

fn parse_message(raw: &[u8]) -> Result<Message<'_>, DecryptError> {
    Message::from_bytes(Cursor::new(raw)).map_err(|_| DecryptError::InvalidMessage)
}

/// Tries every SKESK in order, as a wrong password can yield a plausible session
/// key, and returns the authenticated inner packets.
fn open_encrypted(raw: &[u8], key: &[u8]) -> Result<Vec<u8>, DecryptError> {
    let password = Password::from(key);
    let parsed = parse_message(raw)?;
    // Plain literal messages are refused: a secret must be encrypted, as in the Go CLI.
    let Message::Encrypted { esk, .. } = &parsed else {
        return Err(DecryptError::InvalidMessage);
    };
    let skesks = check_key_packets(esk)?;
    if skesks.is_empty() {
        return Err(DecryptError::InvalidMessage);
    }
    let mut unreadable = false;
    for skesk in skesks {
        let Ok(session_key) = decrypt_session_key_with_password(skesk, &password) else {
            continue;
        };
        let Message::Encrypted { mut edata, .. } = parse_message(raw)? else {
            return Err(DecryptError::InvalidMessage);
        };
        if edata
            .decrypt_with_options(&session_key, decrypt_options())
            .is_err()
        {
            continue;
        }
        let mut inner = Vec::new();
        // A wrong key can surface only here, so later key packets still get their turn.
        if edata.read_to_end(&mut inner).is_ok() {
            return Ok(inner);
        }
        unreadable = true;
    }
    // go-crypto reports payloads that will not decrypt as an invalid message.
    Err(if unreadable {
        DecryptError::InvalidMessage
    } else {
        DecryptError::InvalidKey
    })
}

fn read_literal(mut message: Message<'_>) -> Result<Vec<u8>, DecryptError> {
    let mut limited = false;
    let mut depth = 0;
    while message.is_compressed() {
        depth += 1;
        if depth > MAX_NESTED_COMPRESSION {
            return Err(DecryptError::InvalidMessage);
        }
        limited = true;
        message = message
            .decompress()
            .map_err(|_| DecryptError::InvalidMessage)?;
    }
    // Anything else, such as a nested encrypted message, would come out as "plaintext".
    if message.literal_data_header().is_none() {
        return Err(DecryptError::InvalidMessage);
    }
    let mut plaintext = Vec::new();
    let read = if limited {
        (&mut message)
            .take(MAX_DECOMPRESSED_SIZE + 1)
            .read_to_end(&mut plaintext)
    } else {
        message.read_to_end(&mut plaintext)
    };
    read.map_err(|err| DecryptError::Read(err.to_string()))?;
    if limited && plaintext.len() as u64 > MAX_DECOMPRESSED_SIZE {
        return Err(DecryptError::Read(
            "decompressed message too large".to_string(),
        ));
    }
    Ok(plaintext)
}

/// Decrypts armored or binary ciphertext into plaintext.
pub fn decrypt(ciphertext: &[u8], key: &[u8]) -> Result<Vec<u8>, DecryptError> {
    // rPGP can panic on hostile input (unknown AEAD ids in SEIPDv2, for one).
    std::panic::catch_unwind(|| decrypt_unguarded(ciphertext, key))
        .unwrap_or(Err(DecryptError::InvalidMessage))
}

fn decrypt_unguarded(ciphertext: &[u8], key: &[u8]) -> Result<Vec<u8>, DecryptError> {
    let dearmored;
    let raw = if ciphertext.starts_with(ARMOR_HEADER) {
        let mut body = Vec::new();
        // Like go-crypto, the armor checksum is not verified; RFC 9580 says to ignore it.
        let options = DearmorOptions::new().set_limit(usize::MAX);
        Dearmor::with_options(Cursor::new(ciphertext), options)
            .read_to_end(&mut body)
            .map_err(|_| DecryptError::InvalidMessage)?;
        dearmored = body;
        dearmored.as_slice()
    } else {
        ciphertext
    };
    let inner = open_encrypted(raw, key)?;
    let message = parse_message(&inner)?;
    read_literal(message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use pgp::composed::MessageBuilder;
    use pgp::types::CompressionAlgorithm;

    const OPENPGPJS_TEXT: &str = "-----BEGIN PGP MESSAGE-----\nVersion: OpenPGP.js v4.10.8\nComment: https://openpgpjs.org\n\nwy4ECQMIRthQ3aO85NvgAfASIX3dTwsFVt0gshPu7n1tN05e8rpqxOk6PYNm\nxtt90k4BqHuTCLNlFRJjuiuE8zdIc+j5zTN5zihxUReVqokeqULLOx2FBMHZ\nsbfqaG/iDbp+qDOc98IagMyPrEqKDxnhVVOraXy5dD9RDsntLso=\n=0vwU\n-----END PGP MESSAGE-----";
    const OPENPGPJS_FILE: &str = "-----BEGIN PGP MESSAGE-----\nVersion: OpenPGP.js v4.10.8\nComment: https://openpgpjs.org\n\nwy4ECQMIHCI4BfNkxELgEICJXDZCq2zf0+DkWHGLBNoM3SzySpFzTF9dGItJ\nwCE50lQBbdoYiYZPT1+O/KCiDpC9P5ixWODZZXjUe/ZGxBvUlUrp0tx1VHWC\ndhgGsvKwXJm0kEwGwqj6mJq/j28FSFoP9Et/LtRuEe3Ct06WOrrHQ4v9DC4=\n=mja3\n-----END PGP MESSAGE-----";
    const GO_AEAD: &str = "-----BEGIN PGP MESSAGE-----\nComment: https://yopass.se\n\nw0wGGgkDCwMIPs3irOnCQEvgbpOkU4RQyXA8A27SsXr63BxmV0/YNxqhkF5zTrtV\nFKfZE4WLhbWt4VJzDk/56ltIL91uqdY827pj7HFQ0l0CCQMMRipaKrKyyktyUW/w\n4kfFXE46fH+XIjb9Gn9K6LlPChzC6EHSHV43LC7uXtnTKmXNJqWkb5aZodU4w5uQ\n6DQzN2jeA0hmVTiZkkqEWbvvogpb8RnDh7jmgaA=\n=9Y3B\n-----END PGP MESSAGE-----";

    fn plaintext(msg: &str, key: &str) -> String {
        String::from_utf8(decrypt(msg.as_bytes(), key.as_bytes()).unwrap()).unwrap()
    }

    #[test]
    fn decrypts_vectors_from_the_go_test_suite() {
        assert_eq!(
            plaintext(OPENPGPJS_TEXT, "4VGynYHxNGcurRgVEQ7RHX"),
            "example secret message"
        );
        assert_eq!(
            plaintext(GO_AEAD, "TestAEADKey12345678901"),
            "aead test message"
        );
        assert_eq!(
            decrypt(OPENPGPJS_FILE.as_bytes(), b"zQKcZ5jzbxeUI7Ylsu0bej").unwrap(),
            b"example secret file\n"
        );
    }

    #[test]
    fn decrypts_gnupg_messages() {
        for (msg, want) in [
            (
                include_str!("../tests/fixtures/gpg-default.asc"),
                "gpg default secret\n",
            ),
            (
                include_str!("../tests/fixtures/gpg-zlib.asc"),
                "gpg zlib secret\n",
            ),
        ] {
            assert_eq!(plaintext(msg, "fixture-key"), want);
        }
    }

    #[test]
    fn a_later_key_packet_still_opens_the_message() {
        // gpg's SKESK derives the session key directly, so a wrong one only shows
        // when reading the payload. Prepend a copy with another salt.
        let mut raw = Vec::new();
        Dearmor::new(Cursor::new(include_bytes!(
            "../tests/fixtures/gpg-default.asc"
        )))
        .read_to_end(&mut raw)
        .unwrap();
        let mut other = raw[..2 + raw[1] as usize].to_vec();
        other[6] ^= 0xff;
        other.extend(&raw);
        assert_eq!(
            decrypt(&other, b"fixture-key").unwrap(),
            b"gpg default secret\n"
        );
        assert_eq!(decrypt(&other, b"wrong"), Err(DecryptError::InvalidMessage));
    }

    #[test]
    fn unencrypted_messages_are_refused() {
        let store = include_str!("../tests/fixtures/gpg-store.asc");
        assert_eq!(
            decrypt(store.as_bytes(), b"fixture-key"),
            Err(DecryptError::InvalidMessage)
        );
    }

    fn cheap_s2k() -> StringToKey {
        StringToKey::new_iterated(OsRng, HashAlgorithm::Sha256, 96)
    }

    #[test]
    fn wrong_key_and_garbage() {
        assert_eq!(
            decrypt(OPENPGPJS_TEXT.as_bytes(), b"wrong"),
            Err(DecryptError::InvalidKey)
        );
        assert_eq!(
            decrypt(GO_AEAD.as_bytes(), b"wrong"),
            Err(DecryptError::InvalidKey)
        );
        assert_eq!(
            decrypt(b"----- PGP MESSAGE -----", b""),
            Err(DecryptError::InvalidMessage)
        );
        assert_eq!(decrypt(b"", b""), Err(DecryptError::InvalidMessage));
    }

    #[test]
    fn round_trips_preserve_every_byte() {
        for data in [
            &b""[..],
            b"x",
            b"line\r\nline\n",
            b"\xff\xfe\x00binary",
            &vec![7u8; 600_000],
        ] {
            let armored = encrypt(data.to_vec(), b"key", false).unwrap();
            assert_eq!(decrypt(armored.as_bytes(), b"key").unwrap(), data);
            let binary = encrypt_binary(data.to_vec(), b"key", b"f.bin", false).unwrap();
            assert_eq!(decrypt(&binary, b"key").unwrap(), data);
            assert_eq!(file_name(&binary), b"f.bin");
        }
    }

    fn file_name(binary: &[u8]) -> Vec<u8> {
        let inner = open_encrypted(binary, b"key").unwrap();
        let message = parse_message(&inner).unwrap();
        message.literal_data_header().unwrap().file_name().to_vec()
    }

    #[test]
    fn file_name_is_truncated_like_go() {
        let name = vec![b'n'; 300];
        let binary = encrypt_binary(b"x".to_vec(), b"key", &name, false).unwrap();
        assert_eq!(file_name(&binary), vec![b'n'; 255]);
    }

    #[test]
    fn literal_length_encodings() {
        for len in [0, 180, 183, 184, 8000, 8377, 8378, 70_000] {
            let data = vec![1u8; len];
            let packets = encrypt_packets(
                &literal_packet(b'b', b"", data.clone()).unwrap(),
                b"key",
                cheap_s2k(),
            )
            .unwrap();
            assert_eq!(decrypt(&packets, b"key").unwrap(), data, "{len}");
        }
    }

    #[test]
    fn armor_checksum_is_valid_crc24() {
        let armored = encrypt(b"x".to_vec(), b"key", false).unwrap();
        let mut body = Vec::new();
        Dearmor::new(Cursor::new(armored.as_bytes()))
            .read_to_end(&mut body)
            .unwrap();
        let mut crc: u32 = 0xb704ce;
        for byte in body {
            crc ^= u32::from(byte) << 16;
            for _ in 0..8 {
                crc <<= 1;
                if crc & 0x1000000 != 0 {
                    crc ^= 0x1864cfb;
                }
            }
        }
        let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let line: String = (0..4)
            .map(|i| alphabet[((crc >> (18 - 6 * i)) & 63) as usize] as char)
            .collect();
        assert!(
            armored.contains(&format!("\n={line}\n")),
            "{armored}\n{line}"
        );
    }

    #[test]
    fn wire_format_matches_go() {
        let raw = encrypt_binary(b"x".to_vec(), b"key", b"n", false).unwrap();
        // SKESK: new-format tag 3, v6, length, AES-256, GCM, S2K length, iterated, SHA-256.
        assert_eq!(raw[0], 0xc3);
        assert_eq!(&raw[2..4], &[6, 26]);
        assert_eq!(&raw[4..9], &[9, 3, 11, 3, 8]);
        assert_eq!(raw[17], ITERATED_S2K_COUNT);
        let seipd = 2 + raw[1] as usize;
        assert_eq!(raw[seipd], 0xc0 | 18);
        // SEIPD v2, AES-256, GCM, 256 KiB chunks.
        assert_eq!(&raw[seipd + 2..seipd + 6], &[2, 9, 3, 12]);

        let armored = encrypt(b"x".to_vec(), b"key", false).unwrap();
        assert!(armored.starts_with("-----BEGIN PGP MESSAGE-----\nComment: https://yopass.se\n\n"));
        assert!(armored.trim_end().ends_with("-----END PGP MESSAGE-----"));
    }

    #[test]
    fn argon2_parameters_match_go() {
        let raw = encrypt_binary(b"x".to_vec(), b"key", b"n", true).unwrap();
        // v6, length, AES-256, GCM, S2K length, Argon2.
        assert_eq!(&raw[4..9], &[9, 3, 20, 4, raw[8]]);
        assert_eq!(
            &raw[24..27],
            &[ARGON2_PASSES, ARGON2_PARALLELISM, ARGON2_MEMORY_EXP]
        );
        assert_eq!(decrypt(&raw, b"key").unwrap(), b"x");
    }

    fn costly_skesk(version: u8, exponent: u8) -> Vec<u8> {
        let mut body = match version {
            5 => vec![5, 9, 3],
            6 => vec![6, 35, 9, 3, 20],
            _ => vec![4, 9],
        };
        body.push(4);
        body.extend([0; 16]);
        body.extend([1, 1, exponent]);
        if version >= 5 {
            body.extend([0; 60]);
        }
        let mut raw = vec![0xc3, body.len() as u8];
        raw.extend(body);
        raw
    }

    #[test]
    fn argon2_memory_is_capped_before_derivation() {
        for version in [4, 5, 6] {
            for exponent in [MAX_ARGON2_MEMORY_EXP + 1, 31] {
                let mut raw = costly_skesk(version, exponent);
                // rPGP pairs SKESK versions with payloads, so v6 needs a SEIPDv2.
                if version == 6 {
                    let real = encrypt_binary(b"x".to_vec(), b"key", b"", false).unwrap();
                    raw.extend(&real[2 + real[1] as usize..]);
                } else {
                    raw.extend([0xd2, 1, 1]);
                }
                assert_eq!(
                    decrypt(&raw, b"key"),
                    Err(DecryptError::InvalidMessage),
                    "{version} {exponent}"
                );
            }
        }
    }

    #[test]
    fn unsafe_prefixes_are_rejected() {
        let costly = costly_skesk(4, 31);
        let mut marker = vec![0xca, (3 + costly.len()) as u8];
        marker.extend(b"PGP");
        marker.extend(&costly);
        for prefix in [vec![0xc4, 4, 0, 0, 0, 0], marker, vec![0xd2, 1, 99]] {
            let mut data = prefix.clone();
            data.extend(&costly);
            data.extend([0xd2, 1, 1]);
            assert_eq!(
                decrypt(&data, b"key"),
                Err(DecryptError::InvalidMessage),
                "{prefix:x?}"
            );
        }
    }

    fn gpg_message_with_key_packets(count: usize) -> Vec<u8> {
        let mut raw = Vec::new();
        Dearmor::new(Cursor::new(include_bytes!(
            "../tests/fixtures/gpg-default.asc"
        )))
        .read_to_end(&mut raw)
        .unwrap();
        let skesk = raw[..2 + raw[1] as usize].to_vec();
        let mut data = Vec::new();
        for i in 1..count {
            let mut other = skesk.clone();
            other[6] ^= i as u8;
            data.extend(other);
        }
        data.extend(&raw);
        data
    }

    #[test]
    fn number_of_key_packets_is_capped() {
        let at_limit = gpg_message_with_key_packets(MAX_KEY_PACKETS);
        assert_eq!(
            decrypt(&at_limit, b"fixture-key").unwrap(),
            b"gpg default secret\n"
        );
        let over = gpg_message_with_key_packets(MAX_KEY_PACKETS + 1);
        assert_eq!(
            decrypt(&over, b"fixture-key"),
            Err(DecryptError::InvalidMessage)
        );
    }

    #[test]
    fn nested_encrypted_message_is_not_plaintext() {
        let literal = literal_packet(b'b', b"", b"x".to_vec()).unwrap();
        let inner = encrypt_packets(&literal, b"key", default_s2k(false)).unwrap();
        let outer = encrypt_packets(&inner, b"key", default_s2k(false)).unwrap();
        assert!(matches!(
            decrypt(&outer, b"key"),
            Err(DecryptError::InvalidMessage)
        ));
    }

    fn argon2_message(t: u8, p: u8, m_enc: u8) -> Vec<u8> {
        let literal = literal_packet(b'b', b"", b"x".to_vec()).unwrap();
        encrypt_packets(
            &literal,
            b"key",
            StringToKey::new_argon2(OsRng, t, p, m_enc),
        )
        .unwrap()
    }

    #[test]
    fn argon2_passes_and_parallelism_are_capped() {
        // Small memory keeps these fast; it must be at least 8 KiB per lane.
        let fine = argon2_message(MAX_ARGON2_PASSES, MAX_ARGON2_PARALLELISM, 8);
        assert_eq!(decrypt(&fine, b"key").unwrap(), b"x");
        // Patched in place, as rPGP refuses to create the extreme ones. Bytes 24 and 25
        // of a v6 SKESK are the passes and parallelism.
        for (t, p) in [
            (MAX_ARGON2_PASSES + 1, 1),
            (255, 1),
            (1, MAX_ARGON2_PARALLELISM + 1),
            (1, 255),
        ] {
            let mut message = argon2_message(1, 1, 8);
            message[24] = t;
            message[25] = p;
            assert_eq!(
                decrypt(&message, b"key"),
                Err(DecryptError::InvalidMessage),
                "{t} {p}"
            );
        }
    }

    fn compressed_message(size: usize) -> Vec<u8> {
        let plain = vec![b'x'; size];
        let mut builder =
            MessageBuilder::from_bytes("", plain).seipd_v1(OsRng, SymmetricKeyAlgorithm::AES256);
        builder
            .encrypt_with_password(
                StringToKey::new_iterated(OsRng, HashAlgorithm::Sha256, 96),
                &Password::from("key"),
            )
            .unwrap();
        builder.compression(CompressionAlgorithm::ZLIB);
        builder.to_vec(OsRng).unwrap()
    }

    #[test]
    fn decompression_is_limited() {
        assert_eq!(
            decrypt(&compressed_message(32 << 10), b"key")
                .unwrap()
                .len(),
            32 << 10
        );
        assert_eq!(
            decrypt(&compressed_message(1 << 20), b"key").unwrap().len(),
            1 << 20
        );
        let bomb = compressed_message(2 << 20);
        assert!(bomb.len() < 16 << 10);
        let err = decrypt(&bomb, b"key").unwrap_err();
        assert!(matches!(err, DecryptError::Read(_)));
        assert!(err.to_string().starts_with("could not read plaintext: "));
        // The limit is for decompression only.
        let big = encrypt_binary(vec![b'x'; 2 << 20], b"key", b"", false).unwrap();
        assert_eq!(decrypt(&big, b"key").unwrap().len(), 2 << 20);
    }

    /// A new-format packet with a five-byte length, valid for any body size.
    fn packet(tag: u8, body: &[u8]) -> Vec<u8> {
        let mut out = vec![0xC0 | tag, 0xFF];
        out.extend_from_slice(&(body.len() as u32).to_be_bytes());
        out.extend_from_slice(body);
        out
    }

    #[test]
    fn compression_nesting_is_limited() {
        let nested = |depth: usize| {
            let mut packets = literal_packet(b'b', b"", b"deep".to_vec()).unwrap();
            for _ in 0..depth {
                // A compressed data packet using the "uncompressed" algorithm.
                packets = packet(8, &[&[0u8][..], &packets].concat());
            }
            encrypt_packets(&packets, b"key", cheap_s2k()).unwrap()
        };
        let max = MAX_NESTED_COMPRESSION;
        assert_eq!(decrypt(&nested(max), b"key").unwrap(), b"deep");
        assert_eq!(
            decrypt(&nested(max + 1), b"key"),
            Err(DecryptError::InvalidMessage)
        );
    }

    #[test]
    fn public_key_packets_are_skipped() {
        // A v3 RSA key packet for an unknown key, as in a message encrypted to both
        // a recipient key and a password.
        let pkesk = packet(1, &[3, 1, 2, 3, 4, 5, 6, 7, 8, 1, 0, 8, 0xAB]);
        let mixed = [pkesk, compressed_message(16)].concat();
        assert_eq!(decrypt(&mixed, b"key").unwrap(), vec![b'x'; 16]);
    }

    #[test]
    fn tampering_never_releases_plaintext() {
        let original = encrypt_packets(
            &literal_packet(b'b', b"", b"top secret".to_vec()).unwrap(),
            b"key",
            cheap_s2k(),
        )
        .unwrap();
        for i in 0..original.len() {
            let mut tampered = original.clone();
            tampered[i] ^= 0x40;
            if let Ok(content) = decrypt(&tampered, b"key") {
                assert_eq!(
                    content, b"top secret",
                    "changed plaintext released, byte {i}"
                );
            }
        }
    }

    #[test]
    fn mutated_input_does_not_panic() {
        let original = encrypt_packets(
            &literal_packet(b'b', b"", b"fuzz me".to_vec()).unwrap(),
            b"key",
            cheap_s2k(),
        )
        .unwrap();
        let v4 = OPENPGPJS_TEXT.as_bytes().to_vec();
        let mut state = 0x9e3779b97f4a7c15u64;
        let mut next = move || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state as usize
        };
        for source in [&original, &v4] {
            for _ in 0..1500 {
                let mut data = source.clone();
                for _ in 0..(next() % 4 + 1) {
                    let i = next() % data.len();
                    data[i] = next() as u8;
                }
                data.truncate(data.len() - next() % 8);
                let _ = decrypt(&data, b"key");
            }
        }
    }
}
