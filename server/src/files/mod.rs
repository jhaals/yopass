//! Storage for encrypted file blobs. Metadata lives in the database.

use async_trait::async_trait;
use bytes::Bytes;
use futures_util::Stream;
use std::future::Future;
use std::io;
use std::pin::Pin;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

pub mod database;
pub mod disk;
pub mod s3;

pub type ByteStream = Pin<Box<dyn Stream<Item = io::Result<Bytes>> + Send>>;

#[derive(Debug, thiserror::Error)]
pub enum FileError {
    /// The object definitely does not exist.
    #[error("file not found")]
    NotFound,
    /// Reading the upload failed, or it broke a limit.
    #[error("reading upload: {0}")]
    Read(io::Error),
    /// Anything else means "unreachable", not "gone". May name the object, so
    /// log it through `redact_error`.
    #[error("{0}")]
    Storage(String),
}

/// The upload stream error for a body exceeding its limit.
#[derive(Debug, thiserror::Error)]
#[error("request body too large")]
pub struct BodyTooLarge;

#[async_trait]
pub trait FileStore: Send + Sync + 'static {
    /// Consumes `body` and stores it atomically with its lifetime. `size` is the
    /// request's declared Content-Length, if it had one.
    async fn save(
        &self,
        key: &str,
        body: ByteStream,
        size: Option<u64>,
        expiration: i32,
    ) -> Result<(), FileError>;
    /// Returns the object's content and size in bytes.
    async fn load(&self, key: &str) -> Result<(ByteStream, u64), FileError>;
    async fn delete(&self, key: &str) -> Result<(), FileError>;
    async fn health(&self) -> Result<(), FileError>;
}

/// Runs `sweep` with `interval` of rest before each one, until `stop` fires,
/// abandoning a sweep in flight. Resting after a sweep, rather than ticking,
/// keeps a sweep slower than the interval from running back to back.
pub async fn run_periodic<F: Future<Output = ()>>(
    interval: Duration,
    stop: CancellationToken,
    mut sweep: impl FnMut() -> F,
) {
    loop {
        tokio::select! {
            _ = stop.cancelled() => return,
            () = tokio::time::sleep(interval) => {}
        }
        tokio::select! {
            _ = stop.cancelled() => return,
            () = sweep() => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test(start_paused = true)]
    async fn a_slow_sweep_is_followed_by_a_full_rest() {
        let runs = Arc::new(AtomicUsize::new(0));
        let stop = CancellationToken::new();
        let counted = runs.clone();
        let task = tokio::spawn(run_periodic(
            Duration::from_secs(1),
            stop.clone(),
            move || {
                let counted = counted.clone();
                async move {
                    counted.fetch_add(1, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_secs(10)).await;
                }
            },
        ));
        // Sweeps start at 1s and 12s: a 10s sweep, then a full 1s rest.
        tokio::time::sleep(Duration::from_millis(11_500)).await;
        assert_eq!(runs.load(Ordering::SeqCst), 1);
        tokio::time::sleep(Duration::from_secs(1)).await;
        assert_eq!(runs.load(Ordering::SeqCst), 2);
        stop.cancel();
        task.await.unwrap();
    }
}
