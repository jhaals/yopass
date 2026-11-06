//! Stores encrypted files on the local filesystem.
//!
//! Everything below the base path goes through a capability handle, so a symlink
//! planted in the store cannot make the server read, write or delete files
//! outside of it.

use super::{ByteStream, FileError, FileStore};
use crate::util::{generate_id, now_unix, random_hex, redact_error, redact_secret_id};
use async_trait::async_trait;
use bytes::Bytes;
use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::ambient_authority;
use cap_std::fs::{Dir, DirBuilder, DirBuilderExt, OpenOptions, OpenOptionsExt};
use futures_util::{StreamExt, stream};
use serde::{Deserialize, Serialize};
use std::io::{self, ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;

const O_NONBLOCK: i32 = if cfg!(target_os = "linux") {
    0o4000
} else {
    0x0004
};
const TEMP_MARKER: &str = ".tmp.";
const MAX_WALK_DEPTH: usize = 4;
const READ_CHUNK: usize = 64 * 1024;

#[derive(Serialize, Deserialize)]
struct FileMeta {
    expiration_unix: i64,
}

#[derive(Clone)]
pub struct DiskFileStore {
    base: PathBuf,
}

fn dir_of(key: &str) -> &str {
    key.get(..2).unwrap_or("_")
}

fn bin_path(key: &str) -> String {
    format!("{}/{key}.bin", dir_of(key))
}

fn meta_path(key: &str) -> String {
    format!("{}/{key}.meta", dir_of(key))
}

fn storage(context: &str, error: impl std::fmt::Display) -> FileError {
    FileError::Storage(format!("{context}: {error}"))
}

fn ignore_missing(result: io::Result<()>) -> io::Result<()> {
    match result {
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, FileError> + Send + 'static,
) -> Result<T, FileError> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|e| storage("file store task failed", e))?
}

fn create_private(root: &Dir, path: &str) -> io::Result<cap_std::fs::File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true).mode(0o600);
    root.open_with(path, &options)
}

impl DiskFileStore {
    pub fn new(base: impl AsRef<Path>) -> Result<Self, FileError> {
        let base = base.as_ref().to_owned();
        let mut builder = std::fs::DirBuilder::new();
        builder.recursive(true);
        std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
        builder
            .create(&base)
            .map_err(|e| storage("could not create file store directory", e))?;
        Ok(Self { base })
    }

    fn open_root(base: &Path) -> Result<Dir, FileError> {
        Dir::open_ambient_dir(base, ambient_authority())
            .map_err(|e| storage("could not open file store directory", e))
    }

    /// Writes the sidecar first so expiry cleanup can find what a failed or
    /// interrupted upload leaves behind, then creates the temp file.
    fn begin_save(
        base: &Path,
        key: &str,
        expiration: i32,
    ) -> Result<(String, cap_std::fs::File), FileError> {
        let root = Self::open_root(base)?;
        let mut builder = DirBuilder::new();
        builder.mode(0o700);
        match root.create_dir_with(dir_of(key), &builder) {
            Err(e) if e.kind() != ErrorKind::AlreadyExists => {
                return Err(storage("could not create directory", e));
            }
            _ => {}
        }
        let meta = serde_json::to_vec(&FileMeta {
            expiration_unix: now_unix() + i64::from(expiration),
        })
        .map_err(|e| storage("could not encode metadata", e))?;
        // A key is a fresh random capability, so its metadata cannot exist yet.
        let mut file = create_private(&root, &meta_path(key))
            .map_err(|e| storage("could not write metadata", e))?;
        file.write_all(&meta)
            .map_err(|e| storage("could not write metadata", e))?;
        let temp = format!("{}/{key}{TEMP_MARKER}{}", dir_of(key), random_hex());
        match create_private(&root, &temp) {
            Ok(file) => Ok((temp, file)),
            Err(error) => {
                let _ = root.remove_file(meta_path(key));
                Err(storage("could not create temp file", error))
            }
        }
    }

    /// Removes the upload's leftovers. Expiry cleanup retries anything left.
    fn abort_save(base: &Path, key: &str, temp: &str) {
        if let Ok(root) = Self::open_root(base) {
            let _ = root.remove_file(temp);
            let _ = root.remove_file(meta_path(key));
        }
    }

    /// Opens only regular files inside the store. Non-blocking, because opening
    /// a FIFO planted in the store would otherwise hang the worker thread.
    fn open_blob(base: &Path, key: &str) -> Result<(cap_std::fs::File, u64), FileError> {
        let root = Self::open_root(base)?;
        let mut options = OpenOptions::new();
        options
            .read(true)
            .follow(FollowSymlinks::No)
            .custom_flags(O_NONBLOCK);
        let file = root.open_with(bin_path(key), &options).map_err(|e| {
            if e.kind() == ErrorKind::NotFound {
                FileError::NotFound
            } else {
                storage("could not open file", e)
            }
        })?;
        let meta = file
            .metadata()
            .map_err(|e| storage("could not stat file", e))?;
        if !meta.is_file() {
            return Err(storage("could not open file", "not a regular file"));
        }
        Ok((file, meta.len()))
    }

    fn cleanup_blocking(base: &Path) -> io::Result<()> {
        let root = Dir::open_ambient_dir(base, ambient_authority())?;
        walk(&root, 0);
        Ok(())
    }

    /// Runs one expiry sweep.
    pub async fn cleanup_expired(&self) {
        let base = self.base.clone();
        let swept = tokio::task::spawn_blocking(move || Self::cleanup_blocking(&base)).await;
        match swept {
            Ok(Ok(())) => {}
            Ok(Err(error)) => tracing::warn!(error = %error, "Error during file store cleanup"),
            Err(error) => tracing::warn!(error = %error, "Error during file store cleanup"),
        }
    }

    /// Sweeps expired files until `stop` fires.
    pub async fn run_cleanup(self, interval: Duration, stop: CancellationToken) {
        super::run_periodic(interval, stop, || self.cleanup_expired()).await;
    }
}

/// Aborts a save dropped before it reached its final step.
struct PendingSave {
    base: PathBuf,
    key: String,
    temp: Option<String>,
}

impl Drop for PendingSave {
    fn drop(&mut self) {
        let Some(temp) = self.temp.take() else { return };
        let (base, key) = (
            std::mem::take(&mut self.base),
            std::mem::take(&mut self.key),
        );
        let abort = move || DiskFileStore::abort_save(&base, &key, &temp);
        match tokio::runtime::Handle::try_current() {
            Ok(runtime) => drop(runtime.spawn_blocking(abort)),
            Err(_) => abort(),
        }
    }
}

/// Walks with no-follow semantics so a planted symlink cannot point the sweeper
/// at metadata or blobs outside the store.
fn walk(dir: &Dir, depth: usize) {
    let Ok(entries) = dir.entries() else { return };
    let (mut metas, mut temps) = (Vec::new(), Vec::new());
    for entry in entries.flatten() {
        let (Ok(kind), Ok(name)) = (entry.file_type(), entry.file_name().into_string()) else {
            continue;
        };
        if kind.is_dir() {
            if depth < MAX_WALK_DEPTH
                && let Ok(child) = dir.open_dir_nofollow(&name)
            {
                walk(&child, depth + 1);
            }
        } else if kind.is_file() {
            if name.ends_with(".meta") {
                metas.push(name);
            } else if name.contains(TEMP_MARKER) {
                temps.push(name);
            }
        }
    }
    for meta in metas {
        sweep_entry(dir, &meta, &temps);
    }
}

fn sweep_entry(dir: &Dir, meta_name: &str, temps: &[String]) {
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    let Ok(file) = dir.open_with(meta_name, &options) else {
        return;
    };
    let mut data = Vec::new();
    if file.take(4096).read_to_end(&mut data).is_err() {
        return;
    }
    let Ok(meta) = serde_json::from_slice::<FileMeta>(&data) else {
        return;
    };
    if now_unix() <= meta.expiration_unix {
        return;
    }
    let Some(key) = meta_name.strip_suffix(".meta") else {
        return;
    };
    let secret_id = redact_secret_id(key);
    // Unlink upload temps first so an expired active upload cannot publish a blob.
    let prefix = format!("{key}{TEMP_MARKER}");
    for temp in temps.iter().filter(|t| t.starts_with(&prefix)) {
        if let Err(error) = ignore_missing(dir.remove_file(temp)) {
            tracing::warn!(
                secret_id,
                error = redact_error(&error, key),
                "Failed to remove expired temp file"
            );
            return; // keep the metadata so the next sweep retries
        }
    }
    if let Err(error) = ignore_missing(dir.remove_file(format!("{key}.bin"))) {
        tracing::warn!(
            secret_id,
            error = redact_error(&error, key),
            "Failed to remove expired file"
        );
        return; // keep the metadata so the next sweep retries
    }
    if let Err(error) = ignore_missing(dir.remove_file(meta_name)) {
        tracing::warn!(
            secret_id,
            error = redact_error(&error, key),
            "Failed to remove expired meta"
        );
    }
    tracing::debug!(secret_id, "Cleaned up expired file");
}

#[async_trait]
impl FileStore for DiskFileStore {
    async fn save(
        &self,
        key: &str,
        mut body: ByteStream,
        _size: Option<u64>,
        expiration: i32,
    ) -> Result<(), FileError> {
        let (base, owned_key) = (self.base.clone(), key.to_owned());
        let (temp, file) =
            blocking(move || Self::begin_save(&base, &owned_key, expiration)).await?;
        let mut file = tokio::fs::File::from_std(file.into_std());
        // A caller's deadline can drop this future mid-write; the leftovers
        // must not outlive it, since the sweeper finds temps only by their meta.
        let mut pending = PendingSave {
            base: self.base.clone(),
            key: key.to_owned(),
            temp: Some(temp),
        };

        let mut failure = None;
        while let Some(chunk) = body.next().await {
            match chunk {
                Ok(chunk) => {
                    if let Err(error) = file.write_all(&chunk).await {
                        failure = Some(storage("could not write file", error));
                        break;
                    }
                }
                Err(error) => {
                    failure = Some(FileError::Read(error));
                    break;
                }
            }
        }
        if failure.is_none()
            && let Err(error) = file.flush().await
        {
            failure = Some(storage("could not close temp file", error));
        }
        drop(file);

        // From here the blocking task finishes or aborts the save by itself.
        let temp = pending.temp.take().unwrap_or_default();
        let (base, owned_key) = (self.base.clone(), key.to_owned());
        blocking(move || {
            if let Some(failure) = failure {
                Self::abort_save(&base, &owned_key, &temp);
                return Err(failure);
            }
            let root = Self::open_root(&base)?;
            // Fails if expiry cleanup unlinked the temp file of an upload that
            // outlasted its lifetime: nothing may be published then.
            if let Err(error) = root.rename(&temp, &root, bin_path(&owned_key)) {
                Self::abort_save(&base, &owned_key, &temp);
                return Err(storage("could not rename temp file", error));
            }
            Ok(())
        })
        .await
    }

    async fn load(&self, key: &str) -> Result<(ByteStream, u64), FileError> {
        let (base, key) = (self.base.clone(), key.to_owned());
        let (file, size) = blocking(move || Self::open_blob(&base, &key)).await?;
        let file = tokio::fs::File::from_std(file.into_std());
        let chunks = stream::try_unfold(file, |mut file| async move {
            let mut buffer = vec![0; READ_CHUNK];
            let read = file.read(&mut buffer).await?;
            if read == 0 {
                return Ok(None);
            }
            buffer.truncate(read);
            Ok(Some((Bytes::from(buffer), file)))
        });
        Ok((Box::pin(chunks), size))
    }

    async fn delete(&self, key: &str) -> Result<(), FileError> {
        let (base, key) = (self.base.clone(), key.to_owned());
        blocking(move || {
            let root = Self::open_root(&base)?;
            ignore_missing(root.remove_file(bin_path(&key)))
                .map_err(|e| storage("could not delete file", e))?;
            // Retained above if blob deletion fails, so the sweeper can retry.
            ignore_missing(root.remove_file(meta_path(&key)))
                .map_err(|e| storage("could not delete metadata", e))
        })
        .await
    }

    async fn health(&self) -> Result<(), FileError> {
        let base = self.base.clone();
        blocking(move || {
            let root = Self::open_root(&base)?;
            let probe = format!(".health-check-{}", generate_id());
            let written = create_private(&root, &probe).and_then(|mut f| f.write_all(b"ok"));
            let _ = root.remove_file(&probe);
            written.map_err(|e| storage("disk file store not writable", e))
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{PermissionsExt, symlink};

    const KEY: &str = "AbCdEf0123456789GhIjKl";

    fn body(data: &'static [u8]) -> ByteStream {
        Box::pin(stream::once(async move { Ok(Bytes::from_static(data)) }))
    }

    fn store() -> (tempfile::TempDir, DiskFileStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = DiskFileStore::new(dir.path()).unwrap();
        (dir, store)
    }

    fn files_under(path: &Path) -> Vec<String> {
        let mut out = Vec::new();
        for entry in std::fs::read_dir(path).unwrap().flatten() {
            if entry.file_type().unwrap().is_dir() {
                out.extend(files_under(&entry.path()));
            } else {
                out.push(entry.file_name().into_string().unwrap());
            }
        }
        out.sort();
        out
    }

    async fn collect(mut stream: ByteStream) -> Vec<u8> {
        let mut out = Vec::new();
        while let Some(chunk) = stream.next().await {
            out.extend_from_slice(&chunk.unwrap());
        }
        out
    }

    fn write_expired_meta(dir: &Path) {
        std::fs::create_dir_all(dir.join("Ab")).unwrap();
        std::fs::write(dir.join(meta_path(KEY)), br#"{"expiration_unix":1}"#).unwrap();
    }

    #[tokio::test]
    async fn saves_loads_and_deletes_with_private_permissions() {
        let (dir, store) = store();
        store.save(KEY, body(b"cipher"), None, 60).await.unwrap();
        let (stream, size) = store.load(KEY).await.unwrap();
        assert_eq!(size, 6);
        assert_eq!(collect(stream).await, b"cipher");

        for path in [bin_path(KEY), meta_path(KEY)] {
            let mode = std::fs::metadata(dir.path().join(path))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o077, 0, "stored files must be private");
        }
        store.delete(KEY).await.unwrap();
        store.delete(KEY).await.unwrap(); // repeated delete is fine
        assert!(matches!(store.load(KEY).await, Err(FileError::NotFound)));
        assert!(files_under(dir.path()).is_empty());
    }

    #[tokio::test]
    async fn refuses_a_symlink_leading_out_of_the_store() {
        let (dir, store) = store();
        let outside = tempfile::tempdir().unwrap();
        let target = outside.path().join("private.txt");
        std::fs::write(&target, "outside").unwrap();
        std::fs::create_dir(dir.path().join("Ab")).unwrap();
        symlink(&target, dir.path().join(bin_path(KEY))).unwrap();

        assert!(matches!(store.load(KEY).await, Err(FileError::Storage(_))));
        // Deleting removes the link, never the target.
        store.delete(KEY).await.unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "outside");
    }

    #[tokio::test]
    async fn refuses_a_symlinked_directory_leading_out_of_the_store() {
        let (dir, store) = store();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join(format!("{KEY}.bin")), "outside").unwrap();
        symlink(outside.path(), dir.path().join("Ab")).unwrap();

        assert!(matches!(store.load(KEY).await, Err(FileError::Storage(_))));
        assert!(store.save(KEY, body(b"x"), None, 60).await.is_err());
        assert!(store.delete(KEY).await.is_err());
        assert!(outside.path().join(format!("{KEY}.bin")).exists());
        assert_eq!(files_under(outside.path()).len(), 1);
    }

    #[tokio::test]
    async fn refuses_non_regular_files_without_hanging() {
        let (dir, store) = store();
        std::fs::create_dir(dir.path().join("Ab")).unwrap();
        std::fs::create_dir(dir.path().join(bin_path(KEY))).unwrap();
        assert!(matches!(store.load(KEY).await, Err(FileError::Storage(_))));
        std::fs::remove_dir(dir.path().join(bin_path(KEY))).unwrap();

        // A FIFO would block a plain open() forever.
        let fifo = dir.path().join(bin_path(KEY));
        assert!(
            std::process::Command::new("mkfifo")
                .arg(&fifo)
                .status()
                .unwrap()
                .success()
        );
        let result = tokio::time::timeout(Duration::from_secs(5), store.load(KEY))
            .await
            .expect("opening a FIFO must not block");
        assert!(matches!(result, Err(FileError::Storage(_))));
    }

    #[tokio::test]
    async fn failed_upload_leaves_nothing_behind() {
        let (dir, store) = store();
        let failing: ByteStream = Box::pin(stream::iter([
            Ok(Bytes::from_static(b"partial")),
            Err(io::Error::other("connection lost")),
        ]));
        assert!(matches!(
            store.save(KEY, failing, None, 60).await,
            Err(FileError::Read(_))
        ));
        assert!(files_under(dir.path()).is_empty());
    }

    #[tokio::test]
    async fn cleanup_removes_expired_and_keeps_live_files() {
        let (dir, store) = store();
        const LIVE: &str = "ZyXwVu0123456789GhIjKl";
        store.save(LIVE, body(b"live"), None, 3600).await.unwrap();
        store.save(KEY, body(b"old"), None, 1).await.unwrap();
        std::fs::write(dir.path().join(meta_path(KEY)), br#"{"expiration_unix":1}"#).unwrap();

        store.cleanup_expired().await;
        assert!(matches!(store.load(KEY).await, Err(FileError::NotFound)));
        assert!(store.load(LIVE).await.is_ok());
        assert_eq!(files_under(dir.path()).len(), 2);
    }

    #[tokio::test]
    async fn cleanup_ignores_invalid_metadata_and_symlinks() {
        let (dir, store) = store();
        std::fs::create_dir(dir.path().join("Ab")).unwrap();
        std::fs::write(dir.path().join(meta_path(KEY)), "not json").unwrap();
        std::fs::write(dir.path().join(bin_path(KEY)), "kept").unwrap();

        let outside = tempfile::tempdir().unwrap();
        let victim = outside.path().join("victim.bin");
        std::fs::write(&victim, "outside").unwrap();
        std::fs::write(
            outside.path().join("victim.meta"),
            br#"{"expiration_unix":1}"#,
        )
        .unwrap();
        symlink(
            outside.path().join("victim.meta"),
            dir.path().join("Ab/link.meta"),
        )
        .unwrap();
        symlink(outside.path(), dir.path().join("linked")).unwrap();

        store.cleanup_expired().await;
        assert!(dir.path().join(bin_path(KEY)).exists());
        assert!(victim.exists(), "the sweeper must not act through symlinks");
        assert!(outside.path().join("victim.meta").exists());
    }

    #[tokio::test]
    async fn cleanup_works_through_a_symlinked_base_path() {
        let real = tempfile::tempdir().unwrap();
        let links = tempfile::tempdir().unwrap();
        let link = links.path().join("store");
        symlink(real.path(), &link).unwrap();
        let store = DiskFileStore::new(&link).unwrap();
        write_expired_meta(real.path());
        std::fs::write(real.path().join(bin_path(KEY)), "old").unwrap();

        store.cleanup_expired().await;
        assert!(files_under(real.path()).is_empty());
    }

    #[tokio::test]
    async fn cleanup_removes_temp_files_of_interrupted_uploads() {
        let (dir, store) = store();
        write_expired_meta(dir.path());
        let temp = dir.path().join(format!("Ab/{KEY}{TEMP_MARKER}abc"));
        std::fs::write(&temp, "partial").unwrap();
        // A temp for a different key must survive.
        let other = dir
            .path()
            .join(format!("Ab/ZyXwVu0123456789GhIjKl{TEMP_MARKER}abc"));
        std::fs::write(&other, "other").unwrap();

        store.cleanup_expired().await;
        assert!(!temp.exists());
        assert!(other.exists());
    }

    #[tokio::test]
    async fn an_upload_outlasting_its_lifetime_publishes_nothing() {
        let (dir, store) = store();
        let (sender, receiver) = tokio::sync::oneshot::channel::<()>();
        let slow: ByteStream = Box::pin(stream::once(async move {
            let _ = receiver.await;
            Ok(Bytes::from_static(b"late"))
        }));
        let saving = {
            let store = store.clone();
            tokio::spawn(async move { store.save(KEY, slow, None, 1).await })
        };
        // Wait until the upload is in flight, then expire it and sweep.
        while files_under(dir.path()).len() < 2 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        std::fs::write(dir.path().join(meta_path(KEY)), br#"{"expiration_unix":1}"#).unwrap();
        store.cleanup_expired().await;
        sender.send(()).unwrap();

        assert!(saving.await.unwrap().is_err());
        assert!(files_under(dir.path()).is_empty());
    }

    #[tokio::test]
    async fn an_upload_dropped_mid_transfer_leaves_nothing_behind() {
        let (dir, store) = store();
        let stalled: ByteStream = Box::pin(
            stream::once(async { Ok(Bytes::from_static(b"part")) }).chain(stream::pending()),
        );
        let saving = store.save(KEY, stalled, None, 3600);
        assert!(
            tokio::time::timeout(Duration::from_millis(200), saving)
                .await
                .is_err()
        );
        for _ in 0..500 {
            if files_under(dir.path()).is_empty() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("left behind: {:?}", files_under(dir.path()));
    }

    #[tokio::test]
    async fn health_reports_an_unavailable_directory() {
        let (dir, store) = store();
        store.health().await.unwrap();
        assert!(
            files_under(dir.path()).is_empty(),
            "the probe must not linger"
        );
        std::fs::remove_dir_all(dir.path()).unwrap();
        assert!(store.health().await.is_err());
    }

    /// A non-empty directory makes removal fail even for root.
    fn block_removal(path: &Path) {
        std::fs::create_dir_all(path.join("x")).unwrap();
    }

    #[tokio::test]
    async fn cleanup_keeps_metadata_until_the_blob_is_really_gone() {
        let (dir, store) = store();
        write_expired_meta(dir.path());
        block_removal(&dir.path().join(bin_path(KEY)));
        store.cleanup_expired().await;
        assert!(
            dir.path().join(meta_path(KEY)).exists(),
            "metadata is what lets the next sweep retry"
        );
        std::fs::remove_dir_all(dir.path().join(bin_path(KEY))).unwrap();
        store.cleanup_expired().await;
        assert!(!dir.path().join(meta_path(KEY)).exists());
    }

    /// Makes `dir` read-only. Returns false where that is not enforced (root).
    fn read_only(dir: &Path) -> bool {
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o500)).unwrap();
        let enforced = std::fs::write(dir.join(".probe"), "").is_err();
        if !enforced {
            let _ = std::fs::remove_file(dir.join(".probe"));
        }
        enforced
    }

    fn writable(dir: &Path) {
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    }

    #[tokio::test]
    async fn cleanup_retries_when_an_upload_temp_cannot_be_removed() {
        let (dir, store) = store();
        write_expired_meta(dir.path());
        let temp = dir.path().join(format!("Ab/{KEY}{TEMP_MARKER}abc"));
        std::fs::write(&temp, "partial").unwrap();
        std::fs::write(dir.path().join(bin_path(KEY)), "ciphertext").unwrap();
        let shard = dir.path().join("Ab");
        if !read_only(&shard) {
            writable(&shard);
            return;
        }
        store.cleanup_expired().await;
        writable(&shard);
        // Stopped at the temp: nothing published, everything kept for a retry.
        assert!(temp.exists());
        assert!(dir.path().join(bin_path(KEY)).exists());
        assert!(dir.path().join(meta_path(KEY)).exists());
        store.cleanup_expired().await;
        assert!(!temp.exists());
        assert!(!dir.path().join(bin_path(KEY)).exists());
        assert!(!dir.path().join(meta_path(KEY)).exists());
    }

    #[tokio::test]
    async fn the_cleanup_loop_sweeps_and_stops_when_cancelled() {
        let (dir, store) = store();
        write_expired_meta(dir.path());
        let stop = CancellationToken::new();
        let task = tokio::spawn(store.run_cleanup(Duration::from_millis(10), stop.clone()));
        for _ in 0..500 {
            if !dir.path().join(meta_path(KEY)).exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(!dir.path().join(meta_path(KEY)).exists());
        stop.cancel();
        tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .expect("the loop stops")
            .unwrap();
    }

    #[tokio::test]
    async fn save_fails_cleanly_when_the_shard_cannot_be_created() {
        let (dir, store) = store();
        // A file where the shard belongs.
        std::fs::write(dir.path().join("Ab"), "not a directory").unwrap();
        let error = store.save(KEY, body(b"data"), None, 60).await.unwrap_err();
        assert!(matches!(error, FileError::Storage(_)), "{error}");
        std::fs::remove_file(dir.path().join("Ab")).unwrap();

        if !read_only(dir.path()) {
            writable(dir.path());
            return;
        }
        let error = store.save(KEY, body(b"data"), None, 60).await.unwrap_err();
        writable(dir.path());
        assert!(
            error.to_string().contains("could not create directory"),
            "{error}"
        );
        assert!(files_under(dir.path()).is_empty());
    }
}
