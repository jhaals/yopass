//! Stores file data in the database backend, base64-encoded. Suitable for files
//! within the backend's item size limit.

use super::{ByteStream, FileError, FileStore};
use crate::db::{Database, DbError, Secret};
use async_trait::async_trait;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use bytes::{Bytes, BytesMut};
use futures_util::{StreamExt, stream};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};

pub const FILE_DATA_KEY_PREFIX: &str = "filedata:";

/// The most a declared Content-Length reserves before the bytes arrive, a
/// little above the largest file that fits a default Memcached item.
const MAX_RESERVE: u64 = 2 << 20;

type BufferKey = (String, [u8; 32]);

/// Concurrent downloads of one file share a single decoded buffer, so stalled
/// clients cost memory per file rather than per connection. The database is
/// still consulted on every load and the digest ties a buffer to its content.
#[derive(Default)]
struct Buffers(Mutex<HashMap<BufferKey, Weak<SharedFile>>>);

struct SharedFile {
    data: Vec<u8>,
    key: BufferKey,
    buffers: Arc<Buffers>,
}

impl AsRef<[u8]> for SharedFile {
    fn as_ref(&self) -> &[u8] {
        &self.data
    }
}

impl Drop for SharedFile {
    fn drop(&mut self) {
        let mut buffers = self.buffers.0.lock().unwrap_or_else(|e| e.into_inner());
        // A new buffer for this key may already have replaced this dead entry.
        if buffers
            .get(&self.key)
            .is_some_and(|w| w.strong_count() == 0)
        {
            buffers.remove(&self.key);
        }
    }
}

pub struct DatabaseFileStore {
    db: Arc<dyn Database>,
    buffers: Arc<Buffers>,
}

impl DatabaseFileStore {
    pub fn new(db: Arc<dyn Database>) -> Self {
        Self {
            db,
            buffers: Arc::default(),
        }
    }

    #[cfg(test)]
    fn tracked_buffers(&self) -> usize {
        self.buffers.0.lock().unwrap().len()
    }
}

fn storage(error: DbError) -> FileError {
    match error {
        DbError::NotFound => FileError::NotFound,
        other => FileError::Storage(other.to_string()),
    }
}

#[async_trait]
impl FileStore for DatabaseFileStore {
    async fn save(
        &self,
        key: &str,
        mut body: ByteStream,
        size: Option<u64>,
        expiration: i32,
    ) -> Result<(), FileError> {
        // Sized up front, as growing it would briefly hold up to twice the file.
        // The limit can be off and a client can stall, so a declared length
        // reserves only up to the cap; a larger file grows past it.
        let reserve = size.unwrap_or(0).min(MAX_RESERVE) as usize;
        let mut data = BytesMut::with_capacity(reserve);
        while let Some(chunk) = body.next().await {
            data.extend_from_slice(&chunk.map_err(FileError::Read)?);
        }
        // The raw bytes go before the write, which makes its own copies.
        let message = STANDARD.encode(&data);
        drop(data);
        let secret = Secret {
            message,
            expiration,
            ..Secret::default()
        };
        self.db
            .put(&format!("{FILE_DATA_KEY_PREFIX}{key}"), &secret)
            .await
            .map_err(storage)
    }

    async fn load(&self, key: &str) -> Result<(ByteStream, u64), FileError> {
        let secret = self
            .db
            .get(&format!("{FILE_DATA_KEY_PREFIX}{key}"))
            .await
            .map_err(storage)?;
        let buffer_key: BufferKey = (key.to_owned(), Sha256::digest(&secret.message).into());
        let lock = || self.buffers.0.lock().unwrap_or_else(|e| e.into_inner());
        let active = lock().get(&buffer_key).and_then(Weak::upgrade);
        let shared = match active {
            Some(shared) => shared,
            None => {
                // Outside the lock: a large file must not stall every other load.
                let data = STANDARD
                    .decode(&secret.message)
                    .map_err(|e| FileError::Storage(format!("decoding file data: {e}")))?;
                let mut buffers = lock();
                // Another download may have decoded the same content meanwhile.
                match buffers.get(&buffer_key).and_then(Weak::upgrade) {
                    Some(shared) => shared,
                    None => {
                        let shared = Arc::new(SharedFile {
                            data,
                            key: buffer_key.clone(),
                            buffers: self.buffers.clone(),
                        });
                        buffers.insert(buffer_key, Arc::downgrade(&shared));
                        shared
                    }
                }
            }
        };
        let size = shared.data.len() as u64;
        let bytes = Bytes::from_owner(ArcBuffer(shared));
        Ok((Box::pin(stream::once(async move { Ok(bytes) })), size))
    }

    async fn delete(&self, key: &str) -> Result<(), FileError> {
        self.db
            .delete(&format!("{FILE_DATA_KEY_PREFIX}{key}"))
            .await
            .map(drop)
            .map_err(storage)
    }

    async fn health(&self) -> Result<(), FileError> {
        self.db.health().await.map_err(storage)
    }
}

struct ArcBuffer(Arc<SharedFile>);

impl AsRef<[u8]> for ArcBuffer {
    fn as_ref(&self) -> &[u8] {
        self.0.as_ref().as_ref()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::memory::MemoryDb;

    fn body(data: &'static [u8]) -> ByteStream {
        Box::pin(stream::once(async move { Ok(Bytes::from_static(data)) }))
    }

    async fn collect(mut stream: ByteStream) -> Vec<u8> {
        let mut out = Vec::new();
        while let Some(chunk) = stream.next().await {
            out.extend_from_slice(&chunk.unwrap());
        }
        out
    }

    #[tokio::test]
    async fn round_trips_binary_data() {
        let store = DatabaseFileStore::new(Arc::new(MemoryDb::new()));
        store
            .save("k", body(b"\x00\xff\xfe"), None, 60)
            .await
            .unwrap();
        let (stream, size) = store.load("k").await.unwrap();
        assert_eq!(size, 3);
        assert_eq!(collect(stream).await, b"\x00\xff\xfe");
        store.delete("k").await.unwrap();
        assert!(matches!(store.load("k").await, Err(FileError::NotFound)));
    }

    #[tokio::test]
    async fn a_declared_size_reserves_only_up_to_the_cap() {
        let store = DatabaseFileStore::new(Arc::new(MemoryDb::new()));
        // Without the cap this would abort the process on allocation.
        store
            .save("k", body(b"data"), Some(u64::MAX), 60)
            .await
            .unwrap();
        let (stream, _) = store.load("k").await.unwrap();
        assert_eq!(collect(stream).await, b"data");
    }

    #[tokio::test]
    async fn active_downloads_share_one_buffer_and_release_it() {
        let store = DatabaseFileStore::new(Arc::new(MemoryDb::new()));
        store.save("k", body(b"data"), None, 60).await.unwrap();
        let (a, _) = store.load("k").await.unwrap();
        let (b, _) = store.load("k").await.unwrap();
        assert_eq!(store.tracked_buffers(), 1);
        drop(a);
        assert_eq!(store.tracked_buffers(), 1);
        assert_eq!(collect(b).await, b"data");
        assert_eq!(store.tracked_buffers(), 0);
    }

    #[tokio::test]
    async fn changed_content_is_not_served_from_an_active_buffer() {
        let store = DatabaseFileStore::new(Arc::new(MemoryDb::new()));
        store.save("k", body(b"old"), None, 60).await.unwrap();
        let (old, _) = store.load("k").await.unwrap();
        store.save("k", body(b"new"), None, 60).await.unwrap();
        let (new, _) = store.load("k").await.unwrap();
        assert_eq!(collect(new).await, b"new");
        assert_eq!(collect(old).await, b"old");
    }

    #[tokio::test]
    async fn deleted_file_is_gone_even_while_a_download_holds_its_buffer() {
        let store = DatabaseFileStore::new(Arc::new(MemoryDb::new()));
        store.save("k", body(b"data"), None, 60).await.unwrap();
        let (_active, _) = store.load("k").await.unwrap();
        store.delete("k").await.unwrap();
        assert!(matches!(store.load("k").await, Err(FileError::NotFound)));
    }

    #[tokio::test]
    async fn corrupt_stored_data_is_a_storage_error() {
        let db = std::sync::Arc::new(MemoryDb::new());
        let store = DatabaseFileStore::new(db.clone());
        let corrupt = Secret {
            expiration: 60,
            message: "%%% not base64 %%%".into(),
            ..Secret::default()
        };
        db.put(
            &format!("{FILE_DATA_KEY_PREFIX}AbCdEf0123456789GhIjKl"),
            &corrupt,
        )
        .await
        .unwrap();
        let error = store.load("AbCdEf0123456789GhIjKl").await.err().unwrap();
        assert!(error.to_string().contains("decoding file data"), "{error}");
        assert_eq!(store.tracked_buffers(), 0);
    }

    #[test]
    fn backend_errors_are_storage_errors_and_misses_are_not_found() {
        assert!(matches!(storage(DbError::NotFound), FileError::NotFound));
        assert!(matches!(
            storage(DbError::Backend("down".into())),
            FileError::Storage(message) if message.contains("down")
        ));
    }
}
