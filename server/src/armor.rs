//! Structural checks for OpenPGP armor and packet framing.
//!
//! This is input hygiene, not a security boundary: armor says nothing about
//! whether a payload is really encrypted, only the client can guarantee that.
//! Nothing here verifies a signature or does public-key arithmetic, because
//! attacker-chosen parameters can make those take minutes. Responders' clients
//! verify keys before encrypting.

use base64::Engine;
use base64::engine::general_purpose::STANDARD;

const MESSAGE: &str = "PGP MESSAGE";
const PUBLIC_KEY: &str = "PGP PUBLIC KEY BLOCK";

pub const MAX_PUBLIC_KEY_LENGTH: usize = 16 * 1024;
const MAX_ARMOR_LINE: usize = 96;

const TAG_SECRET_KEY: u8 = 5;
const TAG_PUBLIC_KEY: u8 = 6;
const TAG_SECRET_SUBKEY: u8 = 7;

/// Decodes the armor block and returns its type and binary body.
///
/// Text before the BEGIN line is skipped, as the Go parser does. The END marker
/// must terminate the input: a marker planted above or inside the header block
/// must not vouch for a body that was never terminated.
fn decode(content: &str) -> Option<(&str, Vec<u8>)> {
    let mut lines = content.split('\n').map(|l| l.trim_end_matches('\r'));
    let kind = lines.find_map(|line| {
        line.strip_prefix("-----BEGIN ")?
            .strip_suffix("-----")
            .filter(|kind| !kind.is_empty())
    })?;

    // Header lines run up to the first blank line; each must be "Key: value".
    for line in lines.by_ref() {
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        if !line.contains(": ") {
            return None;
        }
    }

    let end = format!("-----END {kind}-----");
    let mut encoded = String::new();
    let mut closed = false;
    for line in lines.by_ref() {
        let line = line.trim_end();
        if line == end {
            closed = true;
            break;
        }
        if line.len() > MAX_ARMOR_LINE {
            return None;
        }
        // The optional CRC24 line is not verified: RFC 9580 made it optional.
        if line.len() == 5 && line.starts_with('=') {
            continue;
        }
        encoded.push_str(line);
    }
    if !closed || lines.any(|line| !line.trim().is_empty()) {
        return None;
    }
    let body = STANDARD.decode(encoded).ok()?;
    Some((kind, body))
}

/// True for a well-formed armored PGP message with a non-empty payload.
pub fn is_pgp_encrypted(content: &str) -> bool {
    matches!(decode(content), Some((MESSAGE, body)) if !body.is_empty())
}

/// True when `tag_byte` starts an encrypted message: a PKESK or SKESK packet.
pub fn is_openpgp_binary(tag_byte: u8) -> bool {
    matches!(packet_tag(tag_byte), Some(1 | 3))
}

fn packet_tag(byte: u8) -> Option<u8> {
    if byte & 0x80 == 0 {
        return None;
    }
    Some(if byte & 0x40 != 0 {
        byte & 0x3f
    } else {
        (byte & 0x3c) >> 2
    })
}

/// Walks a packet sequence without interpreting it, yielding each packet's tag
/// and body. `None` as an item means the framing is broken.
fn packets(mut data: &[u8]) -> impl Iterator<Item = Option<(u8, &[u8])>> {
    std::iter::from_fn(move || {
        if data.is_empty() {
            return None;
        }
        let parsed = next_packet(data);
        match parsed {
            Some((tag, body, rest)) => {
                data = rest;
                Some(Some((tag, body)))
            }
            None => {
                data = &[];
                Some(None)
            }
        }
    })
}

fn next_packet(data: &[u8]) -> Option<(u8, &[u8], &[u8])> {
    let (&first, rest) = data.split_first()?;
    let tag = packet_tag(first)?;
    let (length, rest) = if first & 0x40 != 0 {
        match *rest.first()? {
            n @ 0..=191 => (usize::from(n), &rest[1..]),
            n @ 192..=223 => {
                let low = *rest.get(1)?;
                (
                    ((usize::from(n) - 192) << 8) + usize::from(low) + 192,
                    &rest[2..],
                )
            }
            255 => (
                u32::from_be_bytes(rest.get(1..5)?.try_into().ok()?) as usize,
                &rest[5..],
            ),
            // Partial lengths are reserved for data packets, never keys.
            _ => return None,
        }
    } else {
        match first & 0x03 {
            0 => (usize::from(*rest.first()?), &rest[1..]),
            1 => (
                usize::from(u16::from_be_bytes(rest.get(..2)?.try_into().ok()?)),
                &rest[2..],
            ),
            2 => (
                u32::from_be_bytes(rest.get(..4)?.try_into().ok()?) as usize,
                &rest[4..],
            ),
            _ => return None,
        }
    };
    let body = rest.get(..length)?;
    Some((tag, body, &rest[length..]))
}

/// Parses only the fixed header of a primary key packet: version, creation time
/// and a known public-key algorithm. No key material is touched.
fn public_key_header_valid(body: &[u8]) -> bool {
    let &[version, _, _, _, _, ref rest @ ..] = body else {
        return false;
    };
    let algorithm = match version {
        4 => rest.first(),
        // A version 3 key has a two-byte validity field before the algorithm.
        2 | 3 => rest.get(2),
        5 | 6 => rest.first(),
        _ => None,
    };
    // RSA, ElGamal, DSA, ECDH, ECDSA, EdDSA (legacy) and the RFC 9580 curve keys.
    matches!(
        algorithm,
        Some(1 | 2 | 3 | 16 | 17 | 18 | 19 | 20 | 22 | 25 | 26 | 27 | 28)
    ) && rest.len() > 1
}

/// True for a well-formed armored public key: bounded in size, opening with a
/// public primary key, with no secret key material anywhere in the block.
pub fn is_pgp_public_key(content: &str) -> bool {
    if content.is_empty() || content.len() > MAX_PUBLIC_KEY_LENGTH {
        return false;
    }
    let Some((PUBLIC_KEY, body)) = decode(content) else {
        return false;
    };
    let mut iter = packets(&body);
    let Some(Some((TAG_PUBLIC_KEY, primary))) = iter.next() else {
        return false;
    };
    public_key_header_valid(primary)
        && iter.all(|packet| {
            matches!(packet, Some((tag, _)) if tag != TAG_SECRET_KEY && tag != TAG_SECRET_SUBKEY)
        })
}

/// Largest accepted armored message carrying a file of up to `n` raw bytes:
/// packet framing and AEAD tags (overestimated), base64, line wraps and markers.
/// Lines are counted as openpgp.js wraps them, 60 characters, but with CRLF
/// endings, so armor from other clients fits too. Slightly above Go's bound.
pub fn max_armored_file_length(n: u64) -> u64 {
    let with_overhead = n + n / 512 + 2048;
    let encoded = with_overhead.div_ceil(3) * 4;
    encoded + encoded.div_ceil(60) * 2 + 256
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    const VALID: &str = "-----BEGIN PGP MESSAGE-----\nVersion: OpenPGP.js v4.10.8\nComment: https://openpgpjs.org\n\nwy4ECQMIRthQ3aO85NvgAfASIX3dTwsFVt0gshPu7n1tN05e8rpqxOk6PYNm\nxtt90k4BqHuTCLNlFRJjuiuE8zdIc+j5zTN5zihxUReVqokeqULLOx2FBMHZ\nsbfqaG/iDbp+qDOc98IagMyPrEqKDxnhVVOraXy5dD9RDsntLso=\n=0vwU\n-----END PGP MESSAGE-----";

    #[test]
    fn accepts_real_messages() {
        assert!(is_pgp_encrypted(VALID));
        assert!(is_pgp_encrypted(&format!("{VALID}\n")));
        assert!(is_pgp_encrypted(&VALID.replace('\n', "\r\n")));
        // openpgp.js omits the header block entirely and the CRC since v6.
        assert!(is_pgp_encrypted(
            "-----BEGIN PGP MESSAGE-----\n\nwy4ECQ==\n-----END PGP MESSAGE-----\n"
        ));
    }

    #[test]
    fn rejects_malformed_messages() {
        for bad in [
            "",
            "hello world",
            "----- PGP MESSAGE -----",
            "-----BEGIN PGP MESSAGE-----\nincomplete",
            r#"{"message": "hello"}"#,
            // Wrong block types.
            "-----BEGIN PGP PUBLIC KEY BLOCK-----\n\nwy4ECQ==\n-----END PGP PUBLIC KEY BLOCK-----",
            "-----BEGIN NONSENSE-----\n\nwy4ECQ==\n-----END NONSENSE-----",
            // Empty payload, well formed armor around nothing.
            "-----BEGIN PGP MESSAGE-----\n\n-----END PGP MESSAGE-----",
            "-----BEGIN PGP MESSAGE-----\n\n=0vwU\n-----END PGP MESSAGE-----",
            // Bad base64.
            "-----BEGIN PGP MESSAGE-----\n\n!!!notbase64!!!\n-----END PGP MESSAGE-----",
            "-----BEGIN PGP MESSAGE-----\n\nwy4ECQ\n-----END PGP MESSAGE-----",
            // Truncated: no END marker.
            "-----BEGIN PGP MESSAGE-----\n\nwy4ECQ==\n",
            // END marker of another type.
            "-----BEGIN PGP MESSAGE-----\n\nwy4ECQ==\n-----END PGP SIGNATURE-----",
            // END marker planted above the block or inside the headers.
            "-----END PGP MESSAGE-----\n-----BEGIN PGP MESSAGE-----\n\nwy4ECQ==\n",
            "-----BEGIN PGP MESSAGE-----\nComment: -----END PGP MESSAGE-----\n\nwy4ECQ==\n",
            // Content after the END marker.
            "-----BEGIN PGP MESSAGE-----\n\nwy4ECQ==\n-----END PGP MESSAGE-----\ntrailing",
        ] {
            assert!(!is_pgp_encrypted(bad), "{bad:?} must be rejected");
        }
    }

    /// RFC 4880 4.2.2.2: a first octet of 192..=223 starts a two-octet length.
    #[test]
    fn two_octet_packet_lengths() {
        let body = vec![0u8; 300];
        let encoded = 300 - 192;
        let mut packet = vec![0xc3, 192 + (encoded >> 8) as u8, (encoded & 0xff) as u8];
        packet.extend(&body);
        let (tag, parsed, rest) = next_packet(&packet).unwrap();
        assert_eq!((tag, parsed.len(), rest.len()), (3, 300, 0));
        // The second length octet is missing, or the body is short.
        assert!(next_packet(&packet[..2]).is_none());
        assert!(next_packet(&packet[..packet.len() - 1]).is_none());
    }

    #[test]
    fn binary_tag_detection() {
        assert!(is_openpgp_binary(0xc3)); // new format SKESK
        assert!(is_openpgp_binary(0xc1)); // new format PKESK
        assert!(is_openpgp_binary(0x84)); // old format PKESK
        assert!(is_openpgp_binary(0x8c)); // old format SKESK
        assert!(!is_openpgp_binary(0x00));
        assert!(!is_openpgp_binary(b'h'));
        assert!(!is_openpgp_binary(0xd2)); // SEIPD without a key packet
    }

    fn armor_key(body: &[u8]) -> String {
        format!(
            "-----BEGIN PGP PUBLIC KEY BLOCK-----\n\n{}\n-----END PGP PUBLIC KEY BLOCK-----\n",
            STANDARD.encode(body)
        )
    }

    fn public_key_packet() -> Vec<u8> {
        // Version 4 EdDSA primary with dummy material: framing is all that is checked.
        let mut packet = vec![0xc6, 8, 4, 0, 0, 0, 0, 22, 1, 2];
        packet.extend_from_slice(&[0xcd, 1, b'u']); // user ID
        packet
    }

    #[test]
    fn public_key_framing() {
        assert!(is_pgp_public_key(&armor_key(&public_key_packet())));
        // Empty, or a secret key where a public key belongs.
        assert!(!is_pgp_public_key(""));
        assert!(!is_pgp_public_key(&armor_key(&[])));
        assert!(!is_pgp_public_key(&armor_key(&[
            0xc5, 8, 4, 0, 0, 0, 0, 22, 1, 2
        ])));
        // Secret subkey smuggled after a valid primary.
        let mut with_secret = public_key_packet();
        with_secret.extend_from_slice(&[0xc7, 1, 0]);
        assert!(!is_pgp_public_key(&armor_key(&with_secret)));
        // Truncated packet.
        let mut truncated = public_key_packet();
        truncated.extend_from_slice(&[0xc2, 5, 1]);
        assert!(!is_pgp_public_key(&armor_key(&truncated)));
        // Unknown version and algorithm.
        assert!(!is_pgp_public_key(&armor_key(&[
            0xc6, 8, 9, 0, 0, 0, 0, 22, 1, 2
        ])));
        assert!(!is_pgp_public_key(&armor_key(&[
            0xc6, 8, 4, 0, 0, 0, 0, 200, 1, 2
        ])));
        // Wrong armor type.
        let message = armor_key(&public_key_packet()).replace("PUBLIC KEY BLOCK", "MESSAGE");
        assert!(!is_pgp_public_key(&message));
    }

    #[test]
    fn public_key_size_is_capped() {
        let mut body = public_key_packet();
        body.extend(std::iter::repeat_n(0xcd_u8, MAX_PUBLIC_KEY_LENGTH));
        assert!(!is_pgp_public_key(&armor_key(&body)));
    }

    #[test]
    fn huge_dsa_parameters_are_not_evaluated() {
        // A primary key with absurd parameters costs only framing checks.
        let mut body = vec![0xc6, 0xff, 0, 0, 0x20, 0, 4, 0, 0, 0, 0, 17];
        body.extend(std::iter::repeat_n(0xff_u8, 0x2000 - 6));
        let key = armor_key(&body);
        let started = std::time::Instant::now();
        is_pgp_public_key(&key);
        assert!(started.elapsed() < std::time::Duration::from_millis(100));
    }

    #[test]
    fn armored_file_length_covers_overhead() {
        // n raw bytes plus generous OpenPGP overhead, armored at 60 characters
        // per CRLF line with markers, must always fit.
        for n in [0u64, 1, 1000, 512 * 1024, 32 << 20] {
            let packets = n + 600;
            let base64 = packets.div_ceil(3) * 4;
            let armored = base64 + base64.div_ceil(60) * 2 + 60;
            assert!(max_armored_file_length(n) >= armored, "{n}");
        }
    }

    proptest! {
        #[test]
        fn parsers_never_panic_on_text(s in ".*") {
            let _ = is_pgp_encrypted(&s);
            let _ = is_pgp_public_key(&s);
        }

        #[test]
        fn parsers_never_panic_on_armored_bytes(body in proptest::collection::vec(any::<u8>(), 0..512)) {
            let _ = is_pgp_public_key(&armor_key(&body));
        }

        #[test]
        fn random_body_round_trips_as_message(body in proptest::collection::vec(any::<u8>(), 1..256)) {
            let encoded = STANDARD.encode(&body);
            let lines: Vec<&str> = encoded.as_bytes().chunks(64).map(|c| std::str::from_utf8(c).unwrap()).collect();
            let armored = format!(
                "-----BEGIN PGP MESSAGE-----\n\n{}\n-----END PGP MESSAGE-----\n",
                lines.join("\n")
            );
            prop_assert!(is_pgp_encrypted(&armored));
        }
    }

    #[test]
    fn every_packet_length_encoding_is_parsed_exactly() {
        let body = [4, 0, 0, 0, 0, 22, 1, 2];
        let framed = |header: &[u8]| {
            let mut packet = header.to_vec();
            packet.extend_from_slice(&body);
            is_pgp_public_key(&armor_key(&packet))
        };
        // New format: five-byte length. Old format: one, two and four bytes.
        assert!(framed(&[0xc6, 0xff, 0, 0, 0, 8]));
        assert!(framed(&[0x98, 8]));
        assert!(framed(&[0x99, 0, 8]));
        assert!(framed(&[0x9a, 0, 0, 0, 8]));
        // Indeterminate and partial lengths never frame a key.
        assert!(!framed(&[0x9b]));
        assert!(!framed(&[0xc6, 0xe0]));
        // A length running past the data.
        assert!(!framed(&[0xc6, 0xff, 0, 0, 1, 0]));
        assert!(!framed(&[0xc6, 0xff, 0, 0]));
    }

    #[test]
    fn key_versions_place_the_algorithm_where_their_format_does() {
        let key = |body: &[u8]| {
            let mut packet = vec![0xc6, body.len() as u8];
            packet.extend_from_slice(body);
            is_pgp_public_key(&armor_key(&packet))
        };
        // Version 3 carries a two-byte validity field before the algorithm.
        assert!(key(&[3, 0, 0, 0, 0, 0, 0, 1, 1, 2]));
        assert!(!key(&[3, 0, 0, 0, 0, 0, 0, 200, 1, 2]));
        assert!(key(&[6, 0, 0, 0, 0, 27, 1, 2]));
        assert!(key(&[5, 0, 0, 0, 0, 25, 1, 2]));
        // Too short to hold the fixed header.
        assert!(!key(&[4, 0, 0, 0]));
        assert!(!key(&[4, 0, 0, 0, 0, 22]));
    }
}
