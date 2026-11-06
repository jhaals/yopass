//! Small helpers shared across the server: IDs, tokens, durations and sizes.

use base64::Engine;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

const BASE62: &[u8; 62] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

fn random_bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    // A failing OS RNG leaves no safe way to mint capabilities; the panic is
    // contained per request by the detached handler task.
    getrandom::fill(&mut bytes).expect("operating system RNG failed");
    bytes
}

/// A random 22-character base62 secret ID carrying 128 bits of entropy.
pub fn generate_id() -> String {
    let mut n = u128::from_be_bytes(random_bytes());
    let mut id = [0u8; 22];
    for slot in id.iter_mut().rev() {
        *slot = BASE62[(n % 62) as usize];
        n /= 62;
    }
    String::from_utf8_lossy(&id).into_owned()
}

/// A random 128-bit value as lowercase hex, for OIDC state and session IDs.
pub fn random_hex() -> String {
    hex::encode(random_bytes::<16>())
}

pub fn random_key() -> [u8; 32] {
    random_bytes()
}

pub fn random_nonce() -> [u8; 12] {
    random_bytes()
}

/// A new access token and the SHA-256 hex digest stored in its place.
pub fn generate_token() -> (String, String) {
    let token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(random_bytes::<32>());
    let hash = hex::encode(Sha256::digest(token.as_bytes()));
    (token, hash)
}

/// Constant-time comparison over two fixed-size digests.
pub fn token_matches_hash(token: &str, hash: &str) -> bool {
    if token.is_empty() || hash.is_empty() {
        return false;
    }
    let Ok(stored) = hex::decode(hash) else {
        return false;
    };
    Sha256::digest(token.as_bytes())
        .as_slice()
        .ct_eq(&stored)
        .into()
}

/// Compares attacker-supplied values of any length without leaking a prefix match.
pub fn constant_time_digest_eq(a: &[u8], b: &[u8]) -> bool {
    Sha256::digest(a).ct_eq(&Sha256::digest(b)).into()
}

/// The fingerprint logged in place of a secret ID. Path keys are bearer
/// capabilities and must never reach logs, audit records or webhooks.
pub fn redact_secret_id(id: &str) -> String {
    if id.is_empty() {
        return String::new();
    }
    let mut digest = hex::encode(Sha256::digest(id.as_bytes()));
    digest.truncate(12);
    digest
}

/// Replaces a raw key inside an error message with its fingerprint: file store
/// errors name the object they failed on.
pub fn redact_error(error: &impl std::fmt::Display, key: &str) -> String {
    let message = error.to_string();
    if key.is_empty() {
        return message;
    }
    message.replace(key, &redact_secret_id(key))
}

/// True for a lowercase UUID or a 22-character alphanumeric ID. Everything else
/// is refused before it can reach a database key or a file path.
pub fn is_valid_key(key: &str) -> bool {
    let bytes = key.as_bytes();
    if bytes.len() == 22 {
        return bytes.iter().all(u8::is_ascii_alphanumeric);
    }
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => *b == b'-',
            _ => b.is_ascii_digit() || (b'a'..=b'f').contains(b),
        })
}

/// AWS SDK crates whose debug logs print object keys, which are secret IDs.
const AWS_LOG_TARGETS: [&str; 10] = [
    "aws_config",
    "aws_runtime",
    "aws_sdk_s3",
    "aws_sdk_sso",
    "aws_sdk_ssooidc",
    "aws_sdk_sts",
    "aws_sigv4",
    "aws_smithy_http_client",
    "aws_smithy_runtime",
    "aws_smithy_runtime_api",
];

/// The log filter for `--log-level`. A general debug level leaves the AWS SDK
/// at info; naming one of its crates in the filter opts that crate back in.
pub fn log_filter(level: &str) -> Option<tracing_subscriber::EnvFilter> {
    let mut filter = tracing_subscriber::EnvFilter::try_new(level).ok()?;
    for target in AWS_LOG_TARGETS {
        if !level.contains(target) {
            filter = filter.add_directive(format!("{target}=info").parse().ok()?);
        }
    }
    Some(filter)
}

pub fn now_unix() -> i64 {
    time::OffsetDateTime::now_utc().unix_timestamp()
}

/// Seconds until `expires_at`, or 0 once passed. A 0 must never reach a
/// backend: it would mean "no expiry" there.
pub fn seconds_until(expires_at: i64) -> i32 {
    expires_at
        .saturating_sub(now_unix())
        .clamp(0, i64::from(i32::MAX)) as i32
}

/// The lifetimes selectable without `--allow-custom-expiration`.
pub fn preset_expiration(value: &str) -> Option<i32> {
    match value {
        "1h" => Some(3600),
        "1d" => Some(86400),
        "1w" => Some(604_800),
        _ => None,
    }
}

pub fn is_preset_expiration(seconds: i32) -> bool {
    matches!(seconds, 3600 | 86400 | 604_800)
}

/// Parses positive whole-second durations such as `90d` or `1d12h`. Fractions,
/// signs, whitespace and values exceeding `i32` are rejected.
pub fn parse_expiration_duration(value: &str) -> Option<i32> {
    if value.is_empty() {
        return None;
    }
    let (mut rest, mut total) = (value.as_bytes(), 0i32);
    while !rest.is_empty() {
        let digits = rest.iter().take_while(|b| b.is_ascii_digit()).count();
        if digits == 0 || digits == rest.len() {
            return None;
        }
        let amount: i32 = std::str::from_utf8(&rest[..digits]).ok()?.parse().ok()?;
        let unit = match rest[digits] {
            b's' => 1,
            b'm' => 60,
            b'h' => 3600,
            b'd' => 86400,
            b'w' => 604_800,
            _ => return None,
        };
        total = total.checked_add(amount.checked_mul(unit)?)?;
        rest = &rest[digits + 1..];
    }
    (total > 0).then_some(total)
}

/// Converts a human-readable duration to seconds, defaulting to one hour.
pub fn expiration_in_seconds(value: &str) -> i32 {
    parse_expiration_duration(value).unwrap_or(3600)
}

/// Parses `10000`, `512KB`, `1.5GB` and friends using binary units.
pub fn parse_size(value: &str) -> Result<u64, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("empty size string".into());
    }
    if let Ok(n) = value.parse::<u64>() {
        return Ok(n);
    }
    let upper = value.to_ascii_uppercase();
    let (suffix, multiplier) = [
        ("GB", 1u64 << 30),
        ("MB", 1 << 20),
        ("KB", 1 << 10),
        ("G", 1 << 30),
        ("M", 1 << 20),
        ("K", 1 << 10),
    ]
    .into_iter()
    .find(|(suffix, _)| upper.ends_with(suffix))
    .ok_or_else(|| format!("invalid size format: {value} (use K, M, G, KB, MB, or GB suffix)"))?;
    let number: f64 = value[..value.len() - suffix.len()]
        .trim()
        .parse()
        .map_err(|_| format!("invalid size value: {value}"))?;
    let bytes = number * multiplier as f64;
    if !bytes.is_finite() || bytes < 0.0 || bytes >= i64::MAX as f64 {
        return Err(format!("invalid size value: {value}"));
    }
    Ok(bytes.round() as u64)
}

pub fn format_size(bytes: u64) -> String {
    for (unit, size) in [("GB", 1u64 << 30), ("MB", 1 << 20), ("KB", 1 << 10)] {
        if bytes >= size {
            return if bytes.is_multiple_of(size) {
                format!("{}{unit}", bytes / size)
            } else {
                format!("{:.1}{unit}", bytes as f64 / size as f64)
            };
        }
    }
    bytes.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_logging_keeps_the_aws_sdk_quiet() {
        use std::sync::{Arc, Mutex};
        use tracing_subscriber::layer::SubscriberExt;

        #[derive(Clone, Default)]
        struct Targets(Arc<Mutex<Vec<String>>>);
        impl<S: tracing::Subscriber> tracing_subscriber::Layer<S> for Targets {
            fn on_event(
                &self,
                event: &tracing::Event<'_>,
                _: tracing_subscriber::layer::Context<'_, S>,
            ) {
                let target = event.metadata().target().to_owned();
                self.0.lock().unwrap().push(target);
            }
        }

        for (level, sdk_debug) in [
            ("debug", false),
            ("trace", false),
            ("info,aws_smithy_runtime=debug", true),
        ] {
            let seen = Targets::default();
            let subscriber = tracing_subscriber::registry()
                .with(log_filter(level).unwrap())
                .with(seen.clone());
            tracing::subscriber::with_default(subscriber, || {
                tracing::debug!(target: "aws_smithy_runtime::client::orchestrator", "sdk");
                tracing::info!(target: "aws_config::meta", "sdk info");
                tracing::debug!(target: "yopass_server::files", "ours");
            });
            let seen = seen.0.lock().unwrap().clone();
            assert_eq!(
                seen.iter().any(|t| t.starts_with("aws_smithy_runtime")),
                sdk_debug,
                "{level}: {seen:?}"
            );
            assert!(seen.iter().any(|t| t == "aws_config::meta"), "{level}");
            assert_eq!(
                seen.iter().any(|t| t == "yopass_server::files"),
                level != "info,aws_smithy_runtime=debug",
                "{level}"
            );
        }
        assert!(log_filter("not a [level").is_none());
    }
    use proptest::prelude::*;

    #[test]
    fn generated_ids_match_the_route_pattern_and_are_unique() {
        let ids: std::collections::HashSet<_> = (0..1000).map(|_| generate_id()).collect();
        assert_eq!(ids.len(), 1000);
        assert!(ids.iter().all(|id| is_valid_key(id)));
    }

    #[test]
    fn key_validation_only_admits_the_two_id_shapes() {
        assert!(is_valid_key("12345678-1234-1234-1234-123456789012"));
        assert!(is_valid_key("AbCdEf0123456789GhIjKl"));
        for bad in [
            "",
            "short",
            "12345678-1234-1234-1234-12345678901G",
            "ABCDEF78-1234-1234-1234-123456789012",
            "../../../../etc/passwd",
            "AbCdEf0123456789GhIjK/",
            "AbCdEf0123456789GhIj\r\n",
            "abc def 0123456789abcd",
        ] {
            assert!(!is_valid_key(bad), "{bad:?} must be rejected");
        }
    }

    #[test]
    fn tokens_verify_only_against_their_own_hash() {
        let (token, hash) = generate_token();
        assert!(token_matches_hash(&token, &hash));
        assert!(!token_matches_hash("wrong", &hash));
        assert!(!token_matches_hash(&token, "abc"));
        assert!(!token_matches_hash(&token, "not hex"));
        assert!(!token_matches_hash("", &hash));
        assert!(!token_matches_hash(&token, ""));
    }

    #[test]
    fn redaction_matches_the_go_fingerprint() {
        // sha256("12345678-1234-1234-1234-123456789012") computed with Go's redactSecretID.
        let id = "12345678-1234-1234-1234-123456789012";
        assert_eq!(redact_secret_id(id).len(), 12);
        assert_eq!(redact_secret_id(""), "");
        let message = redact_error(&format!("s3 get {id} failed"), id);
        assert!(!message.contains(id));
        assert!(message.contains(&redact_secret_id(id)));
    }

    #[test]
    fn durations() {
        assert_eq!(parse_expiration_duration("90d"), Some(90 * 86400));
        assert_eq!(parse_expiration_duration("1d12h"), Some(129_600));
        assert_eq!(parse_expiration_duration("1w"), Some(604_800));
        for bad in [
            "",
            "1",
            "h",
            "1.5h",
            "-1h",
            "+1h",
            "1h ",
            " 1h",
            "0s",
            "1y",
            "99999999999d",
            "4000w",
        ] {
            assert_eq!(parse_expiration_duration(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn sizes() {
        assert_eq!(parse_size("10000"), Ok(10000));
        assert_eq!(parse_size("512KB"), Ok(512 * 1024));
        assert_eq!(parse_size("1m"), Ok(1 << 20));
        assert_eq!(parse_size("1.5GB"), Ok(3 << 29));
        for bad in ["", "abc", "-1", "-1MB", "infG", "NaNG", "1TB"] {
            assert!(parse_size(bad).is_err(), "{bad:?}");
        }
        assert_eq!(format_size(512), "512");
        assert_eq!(format_size(512 * 1024), "512KB");
        assert_eq!(format_size(1 << 20), "1MB");
        assert_eq!(format_size(3 << 29), "1.5GB");
    }

    #[test]
    fn seconds_until_clamps() {
        assert_eq!(seconds_until(0), 0);
        assert_eq!(seconds_until(i64::MAX), i32::MAX);
        assert!(seconds_until(now_unix() + 100) >= 99);
    }

    proptest! {
        #[test]
        fn duration_parser_never_panics(s in ".*") {
            let _ = parse_expiration_duration(&s);
        }
        #[test]
        fn size_parser_never_panics(s in ".*") {
            let _ = parse_size(&s);
        }
    }

    #[test]
    fn redaction_without_a_key_keeps_the_message() {
        assert_eq!(redact_error(&"plain failure", ""), "plain failure");
    }
}
