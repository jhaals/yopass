//! The secret lifecycle: storing, claiming and revoking secrets, files and
//! their receipts. Knows nothing about HTTP or auditing; handlers map its
//! outcomes to responses and audit records.

use crate::app::{App, RECEIPT_KEY_PREFIX, STREAM_KEY_PREFIX};
use crate::auth::Session;
use crate::db::{Abort, DbError, Secret};
use crate::files::{ByteStream, FileError, is_too_large};
use crate::util::{generate_token, now_unix, redact_error, redact_secret_id, seconds_until};
use bytes::Bytes;
use futures_util::Stream;
use serde::{Deserialize, Serialize};
use std::io;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::task::{Context, Poll};
use std::time::Duration;
use tokio::time::Instant;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Text,
    File,
}

impl Kind {
    fn db_key(self, id: &str) -> String {
        match self {
            Kind::Text => id.to_owned(),
            Kind::File => format!("{STREAM_KEY_PREFIX}{id}"),
        }
    }
}

/// Why a secret was not delivered or revoked. Backend errors are already logged.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccessError {
    NotFound,
    /// Present at lookup, gone at the claim, and not one-time.
    Vanished,
    Denied(Abort),
    /// Another reader claimed the one-time secret first.
    ClaimedConcurrently,
    /// The one-time claim failed in the backend; delivery is undecided.
    ClaimFailed,
    /// The view could not be recorded, so nothing was claimed.
    ReceiptUnavailable,
    DbUnavailable,
    /// Nothing was claimed: a one-time link stays retryable.
    FileStoreUnavailable,
    /// The blob is gone; its stale metadata was dropped.
    FileMissing,
}

const STATE_PENDING: &str = "pending";
const STATE_VIEWED: &str = "viewed";

#[derive(Serialize, Deserialize)]
pub(crate) struct Receipt {
    pub token_hash: String,
    pub state: String,
    pub one_time: bool,
    pub created_at: i64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub viewed_at: i64,
    pub expires_at: i64,
}

fn is_zero(value: &i64) -> bool {
    *value == 0
}

fn parse_receipt(record: &Secret) -> Option<Receipt> {
    serde_json::from_str::<Receipt>(&record.message)
        .ok()
        .filter(|receipt| !receipt.token_hash.is_empty())
}

/// Stores a pending receipt and returns its token. Callers store the secret
/// first, and the extra second covers `expires_at` truncating to whole seconds
/// while backends count from the moment of the write: a receipt must never lapse
/// before its secret, or a retrieval at the end of the lifetime goes unrecorded.
async fn create_receipt(
    app: &App,
    id: &str,
    one_time: bool,
    expiration: i32,
) -> Result<String, DbError> {
    let (token, token_hash) = generate_token();
    let now = now_unix();
    let ttl = i64::from(expiration) + 1;
    let receipt = Receipt {
        token_hash,
        state: STATE_PENDING.into(),
        one_time,
        created_at: now,
        viewed_at: 0,
        expires_at: now + ttl,
    };
    let message = serde_json::to_string(&receipt).map_err(|e| DbError::Backend(e.to_string()))?;
    let record = Secret {
        message,
        expiration: ttl.min(i64::from(i32::MAX)) as i32,
        ..Secret::default()
    };
    app.db
        .put(&format!("{RECEIPT_KEY_PREFIX}{id}"), &record)
        .await?;
    Ok(token)
}

/// Records authorized access, including on read-only instances. A missing,
/// invalid, expired or already viewed receipt is not an error.
async fn mark_receipt_viewed(app: &App, id: &str) -> Result<(), DbError> {
    let result = app
        .db
        .update(&format!("{RECEIPT_KEY_PREFIX}{id}"), &|record| {
            let unchanged = || DbError::Aborted(Abort::Unchanged);
            let mut receipt = parse_receipt(&record).ok_or_else(unchanged)?;
            // Computed once: a zero would persist an expired receipt forever.
            let ttl = seconds_until(receipt.expires_at);
            if ttl == 0 || receipt.state == STATE_VIEWED {
                return Err(unchanged());
            }
            receipt.state = STATE_VIEWED.into();
            receipt.viewed_at = now_unix();
            Ok(Secret {
                message: serde_json::to_string(&receipt)
                    .map_err(|e| DbError::Backend(e.to_string()))?,
                expiration: ttl,
                ..Secret::default()
            })
        })
        .await;
    match result {
        Err(DbError::Aborted(Abort::Unchanged) | DbError::NotFound) => Ok(()),
        other => other,
    }
}

/// The receipt lookup could not reach the database. Already logged.
pub(crate) struct ReceiptLookupFailed;

/// The unexpired receipt of a secret, if it has one.
pub(crate) async fn receipt(app: &App, id: &str) -> Result<Option<Receipt>, ReceiptLookupFailed> {
    match app.db.status(&format!("{RECEIPT_KEY_PREFIX}{id}")).await {
        Ok(record) => Ok(parse_receipt(&record).filter(|r| seconds_until(r.expires_at) > 0)),
        Err(DbError::NotFound) => Ok(None),
        Err(error) => {
            tracing::error!(
                error = redact_error(&error, id),
                "Unable to load read receipt"
            );
            Err(ReceiptLookupFailed)
        }
    }
}

/// Which write failed. Everything written before it has been removed again, as
/// far as the backends allowed. Backend errors are already logged.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StoreError {
    /// The upload exceeded its size limit.
    TooLarge,
    FileWrite,
    SecretWrite,
    MetadataWrite,
    ReceiptWrite,
}

/// Stores a text secret under `id`, with a receipt when asked. Returns the
/// receipt token.
pub async fn store_text(
    app: &App,
    id: &str,
    secret: &Secret,
    receipt: bool,
) -> Result<Option<String>, StoreError> {
    if let Err(error) = app.db.put(id, secret).await {
        tracing::error!(error = redact_error(&error, id), "Unable to store secret");
        return Err(StoreError::SecretWrite);
    }
    if !receipt {
        return Ok(None);
    }
    // Start the receipt TTL after storage so it cannot expire before the secret.
    match create_receipt(app, id, secret.one_time, secret.expiration).await {
        Ok(token) => Ok(Some(token)),
        Err(error) => {
            tracing::error!(
                error = redact_error(&error, id),
                "Unable to store read receipt"
            );
            if let Err(error) = app.db.delete(id).await {
                tracing::error!(
                    error = redact_error(&error, id),
                    "Failed to delete secret after receipt error"
                );
            }
            Err(StoreError::ReceiptWrite)
        }
    }
}

pub struct Upload {
    pub body: ByteStream,
    /// The request's declared Content-Length, if it had one.
    pub declared_size: Option<u64>,
    /// Bounds committing the blob to the file store.
    pub deadline: Option<Instant>,
}

/// Stores a file under `id`: the blob in the file store, `meta` (its lifetime
/// and access policy) in the database, and a receipt when asked.
/// Returns the receipt token.
pub async fn store_file(
    app: &App,
    id: &str,
    upload: Upload,
    meta: &Secret,
    receipt: bool,
) -> Result<Option<String>, StoreError> {
    let Some(files) = &app.files else {
        return Err(StoreError::FileWrite);
    };
    let saved = files.save(id, upload.body, upload.declared_size, meta.expiration);
    let saved = match upload.deadline {
        Some(at) => tokio::time::timeout_at(at, saved)
            .await
            .unwrap_or_else(|_| Err(FileError::Storage("file transfer timed out".into()))),
        None => saved.await,
    };
    if let Err(error) = saved {
        tracing::error!(
            error = redact_error(&error, id),
            "Failed to save streaming file"
        );
        // A failed response does not prove the store rejected the write.
        if let Err(error) = delete_blob(app, id).await {
            tracing::error!(
                error = redact_error(&error, id),
                "Failed to delete file after failed save"
            );
        }
        if matches!(&error, FileError::Read(read) if is_too_large(read)) {
            return Err(StoreError::TooLarge);
        }
        return Err(StoreError::FileWrite);
    }

    let meta_key = Kind::File.db_key(id);
    if let Err(error) = app.db.put(&meta_key, meta).await {
        tracing::error!(
            error = redact_error(&error, id),
            "Failed to store stream metadata"
        );
        if let Err(error) = delete_blob(app, id).await {
            tracing::error!(
                error = redact_error(&error, id),
                "Failed to delete file after metadata DB error"
            );
        }
        return Err(StoreError::MetadataWrite);
    }
    if !receipt {
        return Ok(None);
    }
    // Start the receipt TTL after upload so it cannot expire before the file.
    match create_receipt(app, id, meta.one_time, meta.expiration).await {
        Ok(token) => Ok(Some(token)),
        Err(error) => {
            tracing::error!(
                error = redact_error(&error, id),
                "Unable to store read receipt"
            );
            if let Err(error) = app.db.delete(&meta_key).await {
                tracing::error!(
                    error = redact_error(&error, id),
                    "Failed to delete stream metadata after receipt error"
                );
            }
            if let Err(error) = delete_blob(app, id).await {
                tracing::error!(
                    error = redact_error(&error, id),
                    "Failed to delete file after receipt error"
                );
            }
            Err(StoreError::ReceiptWrite)
        }
    }
}

async fn lookup(app: &App, kind: Kind, id: &str) -> Result<Secret, AccessError> {
    match app.db.status(&kind.db_key(id)).await {
        Ok(secret) => Ok(secret),
        Err(DbError::NotFound) => Err(AccessError::NotFound),
        Err(error) => {
            let error = redact_error(&error, id);
            match kind {
                Kind::Text => tracing::error!(error, "Unable to read secret"),
                Kind::File => tracing::error!(error, "Unable to read file metadata"),
            }
            Err(AccessError::DbUnavailable)
        }
    }
}

/// Records the view, then claims. Authorization sits inside the backend's
/// claim, so a replacement cannot be consumed using an earlier snapshot's access
/// policy. The receipt write must precede the claim: a failed write has to
/// prevent delivery while the secret is still intact.
async fn claim(
    app: &App,
    kind: Kind,
    id: &str,
    session: Option<&Session>,
) -> Result<Secret, AccessError> {
    if let Err(error) = mark_receipt_viewed(app, id).await {
        tracing::error!(
            error = redact_error(&error, id),
            "Unable to store viewed read receipt"
        );
        return Err(AccessError::ReceiptUnavailable);
    }

    let claim_attempted = AtomicBool::new(false);
    let result = app
        .db
        .get_authorized(&kind.db_key(id), &|snapshot| {
            app.check_access(snapshot, session)?;
            claim_attempted.store(snapshot.one_time, Ordering::Relaxed);
            Ok(())
        })
        .await;
    match result {
        Ok(secret) => Ok(secret),
        Err(DbError::Aborted(abort)) => Err(AccessError::Denied(abort)),
        Err(DbError::NotFound) if claim_attempted.load(Ordering::Relaxed) => {
            Err(AccessError::ClaimedConcurrently)
        }
        Err(error) if claim_attempted.load(Ordering::Relaxed) => {
            tracing::error!(
                error = redact_error(&error, id),
                "Failed to claim one-time secret"
            );
            Err(AccessError::ClaimFailed)
        }
        Err(DbError::NotFound) => Err(AccessError::Vanished),
        Err(error) => {
            tracing::error!(error = redact_error(&error, id), "Unable to read secret");
            Err(AccessError::DbUnavailable)
        }
    }
}

/// Reads a text secret, consuming it when one-time.
pub async fn read_text(
    app: &App,
    id: &str,
    session: Option<&Session>,
) -> Result<Secret, AccessError> {
    let secret = lookup(app, Kind::Text, id).await?;
    app.check_access(&secret, session)
        .map_err(AccessError::Denied)?;
    claim(app, Kind::Text, id, session).await
}

/// A claimed file. Dropping `content` deletes the blob of a one-time file,
/// however its delivery ended.
pub struct FileDelivery {
    pub meta: Secret,
    pub content: ByteStream,
    pub size: u64,
}

/// Opens a file for delivery, consuming it when one-time. `on_cleanup_failure`
/// runs if a one-time blob cannot be deleted after delivery, possibly after the
/// caller has returned.
pub async fn open_file(
    app: &Arc<App>,
    id: &str,
    session: Option<&Session>,
    on_cleanup_failure: impl FnOnce() + Send + 'static,
) -> Result<FileDelivery, AccessError> {
    // Open before claiming: a transient storage failure must leave a one-time
    // link retryable. Check access first; the claim rechecks its own snapshot.
    let meta = lookup(app, Kind::File, id).await?;
    app.check_access(&meta, session)
        .map_err(AccessError::Denied)?;
    let Some(files) = &app.files else {
        return Err(AccessError::FileStoreUnavailable);
    };
    let (content, size) = match files.load(id).await {
        Ok(loaded) => loaded,
        Err(FileError::NotFound) => {
            // The file is gone: drop its stale metadata.
            match app
                .db
                .delete_authorized(&Kind::File.db_key(id), &|snapshot| {
                    app.check_access(snapshot, session)
                })
                .await
            {
                Ok(()) | Err(DbError::NotFound) => {}
                Err(DbError::Aborted(abort)) => return Err(AccessError::Denied(abort)),
                Err(error) => tracing::error!(
                    error = redact_error(&error, id),
                    "Failed to clean up stale stream metadata"
                ),
            }
            return Err(AccessError::FileMissing);
        }
        Err(error) => {
            tracing::error!(
                error = redact_error(&error, id),
                "Failed to load streaming file"
            );
            return Err(AccessError::FileStoreUnavailable);
        }
    };

    let meta = claim(app, Kind::File, id, session).await?;
    let content: ByteStream = if meta.one_time {
        Box::pin(DeleteAfterDelivery {
            inner: content,
            _delete: DeleteOnDrop {
                app: app.clone(),
                id: id.to_owned(),
                on_failure: Some(Box::new(on_cleanup_failure)),
            },
        })
    } else {
        content
    };
    Ok(FileDelivery {
        meta,
        content,
        size,
    })
}

struct DeleteAfterDelivery {
    inner: ByteStream,
    _delete: DeleteOnDrop,
}

impl Stream for DeleteAfterDelivery {
    type Item = io::Result<Bytes>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.inner.as_mut().poll_next(cx)
    }
}

/// Deletes a claimed file when its delivery ends, however it ends. Claimed files
/// can no longer be retrieved, and a disconnect must not leave ciphertext behind.
struct DeleteOnDrop {
    app: Arc<App>,
    id: String,
    on_failure: Option<Box<dyn FnOnce() + Send>>,
}

impl Drop for DeleteOnDrop {
    fn drop(&mut self) {
        let (app, id, on_failure) = (
            self.app.clone(),
            std::mem::take(&mut self.id),
            self.on_failure.take(),
        );
        let tasks = self.app.tasks.clone();
        // No runtime means the process is exiting; expiry cleanup takes over.
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(tasks.track_future(async move {
                if let Err(error) = delete_blob(&app, &id).await {
                    tracing::error!(
                        secret_id = redact_secret_id(&id),
                        error = redact_error(&error, &id),
                        "Failed to delete one-time streaming file"
                    );
                    if let Some(on_failure) = on_failure {
                        on_failure();
                    }
                }
            }));
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Revoked {
    Clean,
    /// The file is unreachable, but its blob stays until expiry cleanup.
    BlobLeftBehind,
}

/// Removes a secret ahead of its expiration, enforcing `require_auth`. Files also
/// remove their blob after the metadata key is gone.
pub async fn revoke(
    app: &App,
    kind: Kind,
    id: &str,
    session: Option<&Session>,
) -> Result<Revoked, AccessError> {
    let deleted = app
        .db
        .delete_authorized(&kind.db_key(id), &|snapshot| {
            app.check_access(snapshot, session)
        })
        .await;
    match deleted {
        Ok(()) => {}
        Err(DbError::Aborted(abort)) => return Err(AccessError::Denied(abort)),
        Err(DbError::NotFound) => return Err(AccessError::NotFound),
        Err(error) => {
            tracing::error!(error = redact_error(&error, id), "Failed to delete secret");
            return Err(AccessError::DbUnavailable);
        }
    }
    if kind == Kind::File
        && let Err(error) = delete_blob(app, id).await
    {
        tracing::error!(
            error = redact_error(&error, id),
            "Failed to delete streaming file"
        );
        return Ok(Revoked::BlobLeftBehind);
    }
    Ok(Revoked::Clean)
}

/// Finishes blob cleanup within a bound, even if the requesting client is gone.
async fn delete_blob(app: &App, id: &str) -> Result<(), FileError> {
    let Some(files) = &app.files else {
        return Ok(());
    };
    tokio::time::timeout(Duration::from_secs(5), files.delete(id))
        .await
        .map_err(|_| FileError::Storage("file delete timed out".into()))?
}
