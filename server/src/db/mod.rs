//! The database abstraction and its Redis/Valkey and Memcached backends.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

pub mod memcached;
pub mod memory;
mod pool;
pub mod redis;
mod sentinel;

/// Bounds a single backend round trip. A backend that stops answering must not
/// hold a handler, and with it a one-time secret, forever.
pub(crate) const OP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// Maximum attempts an `update` makes when it loses a compare-and-swap race.
pub(crate) const UPDATE_RETRIES: usize = 5;

/// Claim ownership markers contain no ciphertext and are short-lived.
pub(crate) const CLAIM_RECORD_TTL: u64 = 60;

/// The value stored per key. The JSON encoding is shared with the Go server.
#[derive(Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Secret {
    #[serde(default, skip_serializing_if = "is_zero")]
    pub expiration: i32,
    #[serde(default)]
    pub message: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub one_time: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub require_auth: bool,
}

fn is_zero(value: &i32) -> bool {
    *value == 0
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Secret")
            .field("expiration", &self.expiration)
            .field("one_time", &self.one_time)
            .field("require_auth", &self.require_auth)
            .finish_non_exhaustive()
    }
}

/// Why a callback stopped an authorized read or an update. The value in the
/// database stays untouched.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Abort {
    Unauthenticated,
    DomainForbidden,
    InvalidRecord,
    KeyRotated,
    AlreadyFulfilled,
    InvalidToken,
    Unchanged,
    Stale,
}

#[derive(Debug, thiserror::Error)]
pub enum DbError {
    /// The key does not exist or another caller claimed it.
    #[error("key not found")]
    NotFound,
    #[error("aborted: {0:?}")]
    Aborted(Abort),
    /// Anything else, meaning "unreachable", not "gone".
    #[error("{0}")]
    Backend(String),
}

pub type Authorize<'a> = dyn Fn(&Secret) -> Result<(), Abort> + Send + Sync + 'a;
pub type UpdateFn<'a> = dyn Fn(Secret) -> Result<Secret, DbError> + Send + Sync + 'a;

#[async_trait]
pub trait Database: Send + Sync + 'static {
    /// Reads a value without consuming it, even when it is one-time.
    async fn status(&self, key: &str) -> Result<Secret, DbError>;

    /// Authorizes a snapshot and then atomically claims it if it is one-time.
    /// The claim fails with `NotFound` if any write replaced that snapshot, even
    /// with identical content. `authorize` runs at most once and an `Err` from it
    /// leaves the value intact.
    async fn get_authorized(&self, key: &str, authorize: &Authorize) -> Result<Secret, DbError>;

    /// Authorizes and deletes the same version, including multi-view values.
    /// `Ok` means this caller is the one that removed it.
    async fn delete_authorized(&self, key: &str, authorize: &Authorize) -> Result<(), DbError>;

    /// Writes exactly once. An error does not prove the write did not happen, so
    /// callers must never send it again: a delayed copy could restore a value
    /// after it was claimed.
    async fn put(&self, key: &str, secret: &Secret) -> Result<(), DbError>;

    /// Returns whether a value was removed.
    async fn delete(&self, key: &str) -> Result<bool, DbError>;

    /// Atomically applies `update` and stores the result with its expiration,
    /// retrying on contention. `update` may run several times.
    async fn update(&self, key: &str, update: &UpdateFn) -> Result<(), DbError>;

    async fn health(&self) -> Result<(), DbError>;

    /// `get_authorized` with no access policy.
    async fn get(&self, key: &str) -> Result<Secret, DbError> {
        self.get_authorized(key, &|_| Ok(())).await
    }
}

/// A zero lifetime means "never expire" to the backends, so nothing may be
/// stored without one.
pub(crate) fn require_lifetime(secret: &Secret) -> Result<(), DbError> {
    if secret.expiration <= 0 {
        return Err(DbError::Backend(
            "refusing to store a value without a positive lifetime".into(),
        ));
    }
    Ok(())
}

/// Sized for the message, so a large one is not copied while the buffer grows.
/// The margin covers escaped newlines, one per 64-column line of an armored message.
pub(crate) fn encode(secret: &Secret) -> Result<String, DbError> {
    let mut json = Vec::with_capacity(secret.message.len() + secret.message.len() / 32 + 128);
    serde_json::to_writer(&mut json, secret).map_err(|e| DbError::Backend(e.to_string()))?;
    String::from_utf8(json).map_err(|e| DbError::Backend(e.to_string()))
}

pub(crate) fn decode(value: &[u8]) -> Result<Secret, DbError> {
    serde_json::from_slice(value).map_err(|e| DbError::Backend(format!("invalid record: {e}")))
}

#[cfg(test)]
mod tests {

    #[test]
    fn an_armored_message_encodes_without_reallocating() {
        let line = "a".repeat(64) + "\n";
        let message = line.repeat(1000);
        let reserved = message.len() + message.len() / 32 + 128;
        let secret = Secret {
            message,
            expiration: 60,
            ..Secret::default()
        };
        let json = encode(&secret).unwrap();
        assert_eq!(json.capacity(), reserved);
        assert_eq!(decode(json.as_bytes()).unwrap().message, secret.message);
    }

    use super::*;

    #[test]
    fn json_matches_the_go_encoding() {
        let secret = Secret {
            expiration: 3600,
            message: "m".into(),
            one_time: true,
            require_auth: false,
        };
        assert_eq!(
            serde_json::to_string(&secret).unwrap(),
            r#"{"expiration":3600,"message":"m","one_time":true}"#
        );
        assert_eq!(
            serde_json::to_string(&Secret::default()).unwrap(),
            r#"{"message":""}"#
        );
        let parsed: Secret = serde_json::from_str(r#"{"message":"m"}"#).unwrap();
        assert!(!parsed.one_time && parsed.expiration == 0);
    }

    #[test]
    fn debug_output_omits_ciphertext() {
        let secret = Secret {
            message: "ciphertext".into(),
            ..Secret::default()
        };
        assert!(!format!("{secret:?}").contains("ciphertext"));
    }
}
