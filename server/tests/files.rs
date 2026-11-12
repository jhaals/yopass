//! File upload and download, including transient failures and cleanup.

mod common;

use async_trait::async_trait;
use axum::body::Body;
use bytes::Bytes;
use common::*;
use futures_util::{StreamExt, stream};
use serde_json::json;
use std::io;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tokio::task::JoinSet;
use yopass_server::db::Database;
use yopass_server::db::memory::MemoryDb;
use yopass_server::files::disk::DiskFileStore;
use yopass_server::files::{ByteStream, FileError, FileStore};
use yopass_server::util::redact_secret_id;

fn with_fault_store() -> (Harness, Arc<FaultStore>) {
    let store = Arc::new(FaultStore::default());
    (Builder::new().files(store.clone()).build(), store)
}

#[tokio::test]
async fn upload_download_and_headers() {
    let harness = harness();
    let key = harness.upload(false).await;
    for _ in 0..2 {
        let response = harness.get(&format!("/file/{key}")).await;
        assert_eq!(response.status, 200);
        assert_eq!(response.body, PGP_BINARY);
        assert_eq!(
            response.header("content-type"),
            Some("application/octet-stream")
        );
        assert_eq!(response.header("content-length"), Some("6"));
        assert_eq!(response.header("cache-control"), Some("no-store"));
        assert_eq!(
            response.header("access-control-expose-headers"),
            Some("Content-Length")
        );
    }
    assert_eq!(
        harness.get(&format!("/file/{key}/status")).await.json(),
        json!({"oneTime": false, "requireAuth": false})
    );
    assert_eq!(harness.delete(&format!("/file/{key}")).await.status, 204);
    assert_eq!(harness.get(&format!("/file/{key}")).await.status, 404);
}

#[tokio::test]
async fn upload_validation_is_exact() {
    let db = Arc::new(MemoryDb::new());
    let harness = Builder::with_db(db.clone()).build();
    let cases: Vec<(Req, u16, &str)> = vec![
        (
            req("POST", "/create/file").body(PGP_BINARY),
            400,
            "Content-Type must be application/octet-stream",
        ),
        (
            req("POST", "/create/file")
                .header("content-type", "text/plain")
                .body(PGP_BINARY),
            400,
            "Content-Type must be application/octet-stream",
        ),
        (
            req("POST", "/create/file")
                .header("content-type", "application/octet-stream")
                .body(PGP_BINARY),
            400,
            "X-Yopass-Expiration header required",
        ),
        (
            upload_req(PGP_BINARY, "abc", true),
            400,
            "Invalid expiration specified",
        ),
        (
            upload_req(PGP_BINARY, "99999999999", true),
            400,
            "Invalid expiration specified",
        ),
        (
            upload_req(PGP_BINARY, "123", true),
            400,
            "Invalid expiration specified",
        ),
        (
            upload_req(b"plain text", "3600", true),
            400,
            "Invalid data: not an OpenPGP message",
        ),
        (
            upload_req(b"", "3600", true),
            400,
            "Invalid data: not an OpenPGP message",
        ),
    ];
    for (request, status, message) in cases {
        let response = harness.send(request).await;
        assert_eq!(response.status, status, "{message}");
        assert_eq!(response.message(), message);
    }
    assert!(
        db.keys().is_empty(),
        "a refused upload stored {:?}",
        db.keys()
    );
    // Media type parameters and case are fine.
    let response = harness
        .send(
            req("POST", "/create/file")
                .header("content-type", "Application/Octet-Stream; charset=binary")
                .header("x-yopass-expiration", "3600")
                .body(PGP_BINARY),
        )
        .await;
    assert_eq!(response.status, 200);
}

#[tokio::test]
async fn upload_policy_applies() {
    let forced = Builder::new()
        .settings(|s| s.force_onetime_secrets = true)
        .build();
    assert_eq!(
        forced
            .send(upload_req(PGP_BINARY, "3600", false))
            .await
            .message(),
        "Secret must be one time download"
    );
    let expiry = Builder::new()
        .settings(|s| s.force_expiration = "1d".into())
        .build();
    assert_eq!(
        expiry
            .send(upload_req(PGP_BINARY, "3600", true))
            .await
            .message(),
        "Expiration does not match server policy"
    );
    let no_oidc = harness();
    let response = no_oidc
        .send(upload_req(PGP_BINARY, "3600", true).header("x-yopass-requireauth", "true"))
        .await;
    assert_eq!(
        response.message(),
        "Authentication not configured on this server"
    );
    let response = no_oidc
        .send(upload_req(PGP_BINARY, "3600", true).header("x-yopass-receipt", "true"))
        .await;
    assert_eq!(
        response.message(),
        "Read receipts are not enabled on this server"
    );
}

#[tokio::test]
async fn size_limits_hold_with_a_missing_or_lying_content_length() {
    let db = Arc::new(MemoryDb::new());
    let (harness, store) = {
        let store = Arc::new(FaultStore::default());
        (
            Builder::with_db(db.clone())
                .files(store.clone())
                .settings(|s| s.max_file_size = 8)
                .build(),
            store,
        )
    };
    // Declared too large: refused before any storage work.
    let response = harness
        .send(
            upload_req(b"\xc3\x04aaaaaaaaaaaaaaaaaaaaaaa", "3600", true)
                .header("content-length", "25"),
        )
        .await;
    assert_eq!(response.status, 413);
    assert_eq!(response.message(), "File too large");
    assert_eq!(store.saves_started.load(Ordering::SeqCst), 0);

    // No length at all: the stream enforces the limit on the bytes read.
    let chunks: Vec<Result<Bytes, io::Error>> = vec![
        Ok(Bytes::from_static(b"\xc3\x04aaaa")),
        Ok(Bytes::from_static(b"bbbbbbbbbb")),
    ];
    let response = harness
        .send(
            req("POST", "/create/file")
                .header("content-type", "application/octet-stream")
                .header("x-yopass-expiration", "3600")
                .body(Body::from_stream(stream::iter(chunks))),
        )
        .await;
    assert_eq!(response.status, 413);
    assert_eq!(response.message(), "File too large");
    assert!(store.blobs.lock().unwrap().is_empty());
    assert!(
        db.keys().is_empty(),
        "an oversized upload stored {:?}",
        db.keys()
    );
}

#[tokio::test]
async fn no_filename_is_stored_in_metadata() {
    let db = Arc::new(MemoryDb::new());
    let harness = Builder::with_db(db.clone()).build();
    let response = harness
        .send(upload_req(PGP_BINARY, "3600", true).header("x-yopass-filename", "private-name.txt"))
        .await;
    let key = response.message();
    let meta = db.status(&format!("stream:{key}")).await.unwrap();
    assert_eq!(meta.message, "");
    let all: Vec<String> = db.keys();
    assert!(!format!("{all:?}").contains("private-name"));
}

#[tokio::test]
async fn one_time_download_deletes_the_blob() {
    let (harness, store) = with_fault_store();
    let key = harness.upload(true).await;
    let response = harness.get(&format!("/file/{key}")).await;
    assert_eq!(response.status, 200);
    assert_eq!(response.body, PGP_BINARY);
    assert_eq!(harness.get(&format!("/file/{key}")).await.status, 404);
    eventually("the blob is deleted", async || {
        store.blobs.lock().unwrap().is_empty()
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn concurrent_one_time_downloads_deliver_once_on_every_backend() {
    for (name, db) in backends() {
        let harness = Arc::new(Builder::with_db(db).build());
        for _ in 0..5 {
            let key = harness.upload(true).await;
            let mut tasks = JoinSet::new();
            for _ in 0..16 {
                let (harness, key) = (harness.clone(), key.clone());
                tasks.spawn(async move { harness.get(&format!("/file/{key}")).await });
            }
            let mut delivered = 0;
            while let Some(response) = tasks.join_next().await {
                let response = response.unwrap();
                if response.status == 200 {
                    delivered += 1;
                    assert_eq!(response.body, PGP_BINARY, "{name}");
                }
            }
            assert_eq!(delivered, 1, "{name}: file delivered {delivered} times");
        }
    }
}

/// A transient store failure must leave a one-time link retryable.
#[tokio::test]
async fn transient_load_failure_keeps_a_one_time_file() {
    let (harness, store) = with_fault_store();
    let key = harness.upload(true).await;
    store.fail_load.store(true, Ordering::SeqCst);
    let response = harness.get(&format!("/file/{key}")).await;
    assert_eq!(response.status, 503);
    assert_eq!(response.message(), "File store temporarily unavailable");
    assert!(!response.text().contains(&key));
    assert_eq!(store.deletes.load(Ordering::SeqCst), 0);
    store.fail_load.store(false, Ordering::SeqCst);
    let retried = harness.get(&format!("/file/{key}")).await;
    assert_eq!(retried.status, 200);
    assert_eq!(retried.body, PGP_BINARY);
}

#[tokio::test]
async fn missing_blob_cleans_up_stale_metadata() {
    let (harness, store) = with_fault_store();
    let key = harness.upload(false).await;
    store.blobs.lock().unwrap().clear();
    let response = harness.get(&format!("/file/{key}")).await;
    assert_eq!(response.status, 404);
    assert_eq!(response.message(), "File not found");
    assert_eq!(
        harness.get(&format!("/file/{key}/status")).await.status,
        404
    );
}

#[tokio::test]
async fn losing_a_claim_must_not_delete_the_winners_file() {
    let db = FaultDb::new(Arc::new(MemoryDb::new()));
    let store = Arc::new(FaultStore::default());
    let harness = Builder::with_db(db.clone()).files(store.clone()).build();
    let key = harness.upload(true).await;
    for fault in [ClaimFault::Backend, ClaimFault::LostRace] {
        *db.faults.claim.lock().unwrap() = Some(fault);
        let response = harness.get(&format!("/file/{key}")).await;
        assert_ne!(response.status, 200);
        assert_ne!(response.body, PGP_BINARY);
    }
    assert_eq!(store.deletes.load(Ordering::SeqCst), 0);
    assert_eq!(store.blobs.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn failed_save_cleans_up_and_stores_no_metadata() {
    let (harness, store) = with_fault_store();
    store.fail_save.store(true, Ordering::SeqCst);
    let response = harness.send(upload_req(PGP_BINARY, "3600", true)).await;
    assert_eq!(response.status, 500);
    assert_eq!(response.message(), "Failed to store file");
    assert_eq!(
        store.deletes.load(Ordering::SeqCst),
        1,
        "a failed response does not prove the store rejected the write"
    );
}

#[tokio::test]
async fn metadata_failure_removes_the_blob() {
    let db = FaultDb::new(Arc::new(MemoryDb::new()));
    let store = Arc::new(FaultStore::default());
    let harness = Builder::with_db(db.clone()).files(store.clone()).build();
    *db.faults.put.lock().unwrap() = Some("stream:");
    let response = harness.send(upload_req(PGP_BINARY, "3600", true)).await;
    assert_eq!(response.status, 500);
    assert_eq!(response.message(), "Failed to store metadata");
    assert!(store.blobs.lock().unwrap().is_empty());
}

#[tokio::test]
async fn interrupted_upload_body_cleans_up() {
    let (harness, store) = with_fault_store();
    let chunks: Vec<Result<Bytes, io::Error>> = vec![
        Ok(Bytes::from_static(b"\xc3data")),
        Err(io::Error::other("connection reset")),
    ];
    let response = harness
        .send(
            req("POST", "/create/file")
                .header("content-type", "application/octet-stream")
                .header("x-yopass-expiration", "3600")
                .body(Body::from_stream(stream::iter(chunks))),
        )
        .await;
    assert_eq!(response.status, 500);
    assert!(store.blobs.lock().unwrap().is_empty());
    assert_eq!(store.deletes.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn stalled_upload_times_out_and_cleans_up() {
    let store = Arc::new(FaultStore::default());
    let harness = Builder::new()
        .files(store.clone())
        .settings(|s| s.file_transfer_timeout = Some(Duration::from_millis(50)))
        .build();
    let stalled = stream::iter([Ok::<_, io::Error>(Bytes::from_static(b"\xc3data"))])
        .chain(stream::pending());
    let response = tokio::time::timeout(
        Duration::from_secs(5),
        harness.send(
            req("POST", "/create/file")
                .header("content-type", "application/octet-stream")
                .header("x-yopass-expiration", "3600")
                .body(Body::from_stream(stalled)),
        ),
    )
    .await
    .expect("a stalled upload must end by itself");
    assert_eq!(response.status, 500);
    assert!(store.blobs.lock().unwrap().is_empty());
}

#[tokio::test]
async fn deleted_file_reports_success_when_only_physical_cleanup_fails() {
    let (harness, store) = with_fault_store();
    let harness = {
        let builder = Builder::new().licensed().files(store.clone());
        drop(harness);
        builder.build()
    };
    let key = harness.upload(false).await;
    store.fail_delete.store(true, Ordering::SeqCst);
    // Revocation succeeded; expiry cleanup owns any remaining ciphertext.
    assert_eq!(harness.delete(&format!("/file/{key}")).await.status, 204);
    let events = harness.audit_events();
    assert!(events.iter().any(|e| e["event"] == "file.cleanup_failed"));
    assert_eq!(harness.last_audit()["event"], "file.deleted");
    assert_eq!(harness.get(&format!("/file/{key}")).await.status, 404);
}

#[tokio::test]
async fn store_errors_never_expose_raw_keys() {
    let logs = captured_logs();
    let store = Arc::new(FaultStore::default());
    let harness = Builder::new().files(store.clone()).build();
    let key = harness.upload(false).await;
    store.fail_load.store(true, Ordering::SeqCst);
    harness.get(&format!("/file/{key}")).await;
    store.fail_delete.store(true, Ordering::SeqCst);
    harness.delete(&format!("/file/{key}")).await;
    store.fail_load.store(false, Ordering::SeqCst);
    let text = logs.text();
    assert!(
        text.contains(&redact_secret_id(&key)),
        "the fingerprint should correlate"
    );
    assert!(!text.contains(&key), "raw key logged");
}

#[tokio::test]
async fn disk_store_end_to_end() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(DiskFileStore::new(dir.path()).unwrap());
    let harness = Builder::new().files(store).build();
    let key = harness.upload(true).await;
    assert!(
        dir.path()
            .join(&key[..2])
            .join(format!("{key}.bin"))
            .exists()
    );
    let response = harness.get(&format!("/file/{key}")).await;
    assert_eq!(response.body, PGP_BINARY);
    eventually("the expired blob is removed", async || {
        !dir.path()
            .join(&key[..2])
            .join(format!("{key}.bin"))
            .exists()
    })
    .await;
    assert!(
        !dir.path()
            .join(&key[..2])
            .join(format!("{key}.meta"))
            .exists()
    );
    let readiness = harness.get("/ready").await;
    assert_eq!(readiness.status, 200);
}

#[tokio::test]
async fn failed_cleanups_after_failed_uploads_are_logged_by_fingerprint() {
    let logs = captured_logs();
    let memory = Arc::new(MemoryDb::new());
    let db = FaultDb::new(memory.clone());
    let store = Arc::new(FaultStore::default());
    let harness = Builder::with_db(db.clone())
        .licensed()
        .files(store.clone())
        .build();
    store.fail_delete.store(true, Ordering::SeqCst);

    store.fail_save.store(true, Ordering::SeqCst);
    let response = harness.send(upload_req(PGP_BINARY, "3600", true)).await;
    assert_eq!(response.status, 500);
    assert_eq!(response.message(), "Failed to store file");
    store.fail_save.store(false, Ordering::SeqCst);

    *db.faults.put.lock().unwrap() = Some("stream:");
    let response = harness.send(upload_req(PGP_BINARY, "3600", true)).await;
    assert_eq!(response.message(), "Failed to store metadata");
    *db.faults.put.lock().unwrap() = Some("receipt/");
    *db.faults.delete.lock().unwrap() = Some("stream:");
    let response = harness
        .send(upload_req(PGP_BINARY, "3600", true).header("x-yopass-receipt", "true"))
        .await;
    assert_eq!(response.status, 500);
    assert!(memory.keys().iter().all(|k| !k.starts_with("receipt/")));

    let text = logs.text();
    for message in [
        "Failed to delete file after failed save",
        "Failed to delete file after metadata DB error",
        "Failed to delete stream metadata after receipt error",
        "Failed to delete file after receipt error",
    ] {
        assert!(text.contains(message), "{message} not logged");
    }
    for key in store.blobs.lock().unwrap().keys() {
        assert!(!text.contains(key.as_str()), "raw key logged");
    }
}

#[tokio::test]
async fn one_time_delivery_is_final_even_when_blob_cleanup_fails() {
    let (harness, store) = {
        let store = Arc::new(FaultStore::default());
        (
            Builder::new().licensed().files(store.clone()).build(),
            store,
        )
    };
    let key = harness.upload(true).await;
    store.fail_delete.store(true, Ordering::SeqCst);
    let response = harness.get(&format!("/file/{key}")).await;
    assert_eq!(response.status, 200);
    assert_eq!(response.body, PGP_BINARY);
    eventually("the cleanup failure is audited", async || {
        harness
            .audit_events()
            .iter()
            .any(|e| e["event"] == "file.cleanup_failed")
    })
    .await;
    assert_eq!(harness.get(&format!("/file/{key}")).await.status, 404);
}

#[tokio::test]
async fn metadata_outage_keeps_the_file_retrievable() {
    let db = FaultDb::new(Arc::new(MemoryDb::new()));
    let harness = Builder::with_db(db.clone()).build();
    let key = harness.upload(true).await;
    *db.faults.status.lock().unwrap() = Some("stream:");
    let response = harness.get(&format!("/file/{key}")).await;
    assert_eq!(response.status, 503);
    assert_eq!(response.message(), "Database temporarily unavailable");
    assert_eq!(response.header("cache-control"), Some("no-store"));
    *db.faults.status.lock().unwrap() = None;
    assert_eq!(harness.get(&format!("/file/{key}")).await.status, 200);
}

#[tokio::test]
async fn a_missing_file_store_fails_closed() {
    let mut builder = Builder::new();
    builder.files = None;
    let harness = builder.build();
    let upload = harness.send(upload_req(PGP_BINARY, "3600", true)).await;
    assert_eq!(upload.status, 500);
    assert_eq!(upload.message(), "Failed to store file");

    harness
        .app
        .db
        .put(&format!("stream:{UUID_KEY}"), &secret("", true))
        .await
        .unwrap();
    let download = harness.get(&format!("/file/{UUID_KEY}")).await;
    assert_eq!(download.status, 503);
    assert_eq!(download.message(), "File store temporarily unavailable");
    assert_eq!(
        harness.delete(&format!("/file/{UUID_KEY}")).await.status,
        204,
        "revocation needs no file store"
    );
}

/// Serves a first chunk, then never another.
struct StallingStore;

#[async_trait]
impl FileStore for StallingStore {
    async fn save(&self, _: &str, _: ByteStream, _: Option<u64>, _: i32) -> Result<(), FileError> {
        Ok(())
    }
    async fn load(&self, _: &str) -> Result<(ByteStream, u64), FileError> {
        let first = stream::once(async { Ok(Bytes::from_static(PGP_BINARY)) });
        Ok((Box::pin(first.chain(stream::pending())), 1 << 20))
    }
    async fn delete(&self, _: &str) -> Result<(), FileError> {
        Ok(())
    }
    async fn health(&self) -> Result<(), FileError> {
        Ok(())
    }
}

#[tokio::test]
async fn a_stalled_download_is_cut_at_the_transfer_deadline() {
    let harness = Builder::new()
        .files(Arc::new(StallingStore))
        .settings(|s| s.file_transfer_timeout = Some(Duration::from_millis(50)))
        .build();
    harness
        .app
        .db
        .put(&format!("stream:{UUID_KEY}"), &secret("", false))
        .await
        .unwrap();
    let response = tokio::time::timeout(
        Duration::from_secs(5),
        harness.get(&format!("/file/{UUID_KEY}")),
    )
    .await
    .expect("the deadline must end the transfer");
    // The body ends in an error, so it is never mistaken for a complete file.
    assert!(response.body.is_empty(), "{:?}", response.body);
}

#[tokio::test]
async fn stale_metadata_cleanup_failure_still_answers_not_found() {
    let logs = captured_logs();
    let db = FaultDb::new(Arc::new(MemoryDb::new()));
    let store = Arc::new(FaultStore::default());
    let harness = Builder::with_db(db.clone()).files(store.clone()).build();
    let key = harness.upload(false).await;
    store.blobs.lock().unwrap().clear();
    *db.faults.delete.lock().unwrap() = Some("stream:");
    assert_eq!(harness.get(&format!("/file/{key}")).await.status, 404);
    assert!(
        logs.text()
            .contains("Failed to clean up stale stream metadata")
    );
    assert!(!logs.text().contains(&key));
}
