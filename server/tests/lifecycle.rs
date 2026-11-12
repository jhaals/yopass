//! The secret lifecycle's ordering invariants, without the HTTP stack.

mod common;

use bytes::Bytes;
use common::*;
use futures_util::{StreamExt, stream};
use std::io;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use yopass_server::app::{App, Settings};
use yopass_server::db::Database;
use yopass_server::db::memory::MemoryDb;
use yopass_server::files::{BodyTooLarge, ByteStream};
use yopass_server::lifecycle::{self, AccessError, Kind, Revoked, StoreError, Upload};

const ID: &str = UUID_KEY;

fn app(db: Arc<dyn Database>, files: Arc<FaultStore>) -> Arc<App> {
    Arc::new(App::new(Settings::default(), db, Some(files)))
}

async fn file_fixture(one_time: bool) -> (Arc<App>, Arc<FaultDb>, Arc<FaultStore>) {
    let db = FaultDb::new(Arc::new(MemoryDb::new()));
    let store = Arc::new(FaultStore::default());
    store
        .blobs
        .lock()
        .unwrap()
        .insert(ID.into(), PGP_BINARY.to_vec());
    db.put(&format!("stream:{ID}"), &secret("", one_time))
        .await
        .unwrap();
    (app(db.clone(), store.clone()), db, store)
}

#[tokio::test]
async fn a_one_time_text_secret_is_delivered_once() {
    let db = Arc::new(MemoryDb::new());
    db.put(ID, &secret(PGP_MESSAGE, true)).await.unwrap();
    let app = app(db, Arc::default());
    assert_eq!(
        lifecycle::read_text(&app, ID, None).await.unwrap().message,
        PGP_MESSAGE
    );
    assert_eq!(
        lifecycle::read_text(&app, ID, None).await.unwrap_err(),
        AccessError::NotFound
    );
}

#[tokio::test]
async fn a_failed_receipt_write_prevents_the_claim() {
    let db = FaultDb::new(Arc::new(MemoryDb::new()));
    db.put(ID, &secret(PGP_MESSAGE, true)).await.unwrap();
    let app = app(db.clone(), Arc::default());
    *db.faults.update.lock().unwrap() = Some("receipt/");
    assert_eq!(
        lifecycle::read_text(&app, ID, None).await.unwrap_err(),
        AccessError::ReceiptUnavailable
    );
    *db.faults.update.lock().unwrap() = None;
    assert!(lifecycle::read_text(&app, ID, None).await.is_ok());
}

#[tokio::test]
async fn a_store_outage_leaves_a_one_time_file_retryable() {
    let (app, _db, store) = file_fixture(true).await;
    store.fail_load.store(true, Ordering::SeqCst);
    let failed = lifecycle::open_file(&app, ID, None, || {}).await;
    assert_eq!(failed.err(), Some(AccessError::FileStoreUnavailable));
    store.fail_load.store(false, Ordering::SeqCst);
    assert!(lifecycle::open_file(&app, ID, None, || {}).await.is_ok());
}

#[tokio::test]
async fn a_claimed_one_time_file_is_deleted_when_delivery_ends() {
    let (app, _db, store) = file_fixture(true).await;
    let mut delivery = lifecycle::open_file(&app, ID, None, || {}).await.unwrap();
    assert_eq!(delivery.size, PGP_BINARY.len() as u64);
    assert_eq!(delivery.content.next().await.unwrap().unwrap(), PGP_BINARY);
    assert!(store.blobs.lock().unwrap().contains_key(ID));
    drop(delivery);
    eventually("blob deleted", async || {
        store.blobs.lock().unwrap().is_empty()
    })
    .await;
    let again = lifecycle::open_file(&app, ID, None, || {}).await;
    assert_eq!(again.err(), Some(AccessError::NotFound));
}

#[tokio::test]
async fn a_failed_cleanup_after_delivery_is_reported() {
    let (app, _db, store) = file_fixture(true).await;
    store.fail_delete.store(true, Ordering::SeqCst);
    let reported = Arc::new(AtomicBool::new(false));
    let flag = reported.clone();
    let delivery = lifecycle::open_file(&app, ID, None, move || flag.store(true, Ordering::SeqCst))
        .await
        .unwrap();
    drop(delivery);
    eventually("cleanup failure reported", async || {
        reported.load(Ordering::SeqCst)
    })
    .await;
}

#[tokio::test]
async fn a_multi_view_file_keeps_its_blob() {
    let (app, _db, store) = file_fixture(false).await;
    drop(lifecycle::open_file(&app, ID, None, || {}).await.unwrap());
    app.tasks.close();
    app.tasks.wait().await;
    assert!(store.blobs.lock().unwrap().contains_key(ID));
}

#[tokio::test]
async fn a_missing_blob_drops_its_stale_metadata() {
    let (app, db, store) = file_fixture(false).await;
    store.blobs.lock().unwrap().clear();
    let opened = lifecycle::open_file(&app, ID, None, || {}).await;
    assert_eq!(opened.err(), Some(AccessError::FileMissing));
    assert!(db.status(&format!("stream:{ID}")).await.is_err());
}

#[tokio::test]
async fn revoking_a_file_removes_metadata_then_blob() {
    let (app, db, store) = file_fixture(false).await;
    assert_eq!(
        lifecycle::revoke(&app, Kind::File, ID, None).await,
        Ok(Revoked::Clean)
    );
    assert!(store.blobs.lock().unwrap().is_empty());
    assert!(db.status(&format!("stream:{ID}")).await.is_err());
    assert_eq!(
        lifecycle::revoke(&app, Kind::File, ID, None).await,
        Err(AccessError::NotFound)
    );
}

#[tokio::test]
async fn a_revoked_file_whose_blob_cannot_be_deleted_is_still_revoked() {
    let (app, db, store) = file_fixture(false).await;
    store.fail_delete.store(true, Ordering::SeqCst);
    assert_eq!(
        lifecycle::revoke(&app, Kind::File, ID, None).await,
        Ok(Revoked::BlobLeftBehind)
    );
    assert!(db.status(&format!("stream:{ID}")).await.is_err());
}

#[tokio::test]
async fn auth_required_secrets_are_denied_without_a_session_and_stay_intact() {
    let db = Arc::new(MemoryDb::new());
    let mut record = secret(PGP_MESSAGE, true);
    record.require_auth = true;
    db.put(ID, &record).await.unwrap();
    let app = app(db.clone(), Arc::default());
    assert!(matches!(
        lifecycle::read_text(&app, ID, None).await,
        Err(AccessError::Denied(_))
    ));
    assert!(matches!(
        lifecycle::revoke(&app, Kind::Text, ID, None).await,
        Err(AccessError::Denied(_))
    ));
    assert!(db.status(ID).await.is_ok());
}

fn upload(chunks: Vec<io::Result<Bytes>>) -> Upload {
    let body: ByteStream = Box::pin(stream::iter(chunks));
    Upload {
        body,
        declared_size: None,
        deadline: None,
    }
}

fn binary() -> Upload {
    upload(vec![Ok(Bytes::from_static(PGP_BINARY))])
}

fn store_fixture() -> (Arc<App>, Arc<FaultDb>, Arc<FaultStore>) {
    let db = FaultDb::new(Arc::new(MemoryDb::new()));
    let store = Arc::new(FaultStore::default());
    (app(db.clone(), store.clone()), db, store)
}

#[tokio::test]
async fn a_stored_text_secret_with_a_receipt_records_its_view() {
    let (app, _db, _store) = store_fixture();
    let token = lifecycle::store_text(&app, ID, &secret(PGP_MESSAGE, true), true)
        .await
        .unwrap();
    assert!(token.is_some_and(|token| !token.is_empty()));
    assert!(lifecycle::read_text(&app, ID, None).await.is_ok());
    let stored = app.db.status(&format!("receipt/{ID}")).await.unwrap();
    assert!(stored.message.contains(r#""state":"viewed""#));
}

#[tokio::test]
async fn a_failed_receipt_write_leaves_no_text_secret_behind() {
    let (app, db, _store) = store_fixture();
    *db.faults.put.lock().unwrap() = Some("receipt/");
    assert_eq!(
        lifecycle::store_text(&app, ID, &secret(PGP_MESSAGE, false), true).await,
        Err(StoreError::ReceiptWrite)
    );
    assert!(db.status(ID).await.is_err());
}

#[tokio::test]
async fn a_failed_receipt_write_leaves_no_file_behind() {
    let (app, db, store) = store_fixture();
    *db.faults.put.lock().unwrap() = Some("receipt/");
    let stored = lifecycle::store_file(&app, ID, binary(), &secret("", false), true).await;
    assert_eq!(stored, Err(StoreError::ReceiptWrite));
    assert!(db.status(&format!("stream:{ID}")).await.is_err());
    assert!(store.blobs.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_failed_metadata_write_removes_the_blob() {
    let (app, db, store) = store_fixture();
    *db.faults.put.lock().unwrap() = Some("stream:");
    let stored = lifecycle::store_file(&app, ID, binary(), &secret("", false), false).await;
    assert_eq!(stored, Err(StoreError::MetadataWrite));
    assert!(store.blobs.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_failed_save_is_cleaned_up_and_stores_no_metadata() {
    let (app, db, store) = store_fixture();
    store.fail_save.store(true, Ordering::SeqCst);
    let stored = lifecycle::store_file(&app, ID, binary(), &secret("", false), true).await;
    assert_eq!(stored, Err(StoreError::FileWrite));
    assert_eq!(store.deletes.load(Ordering::SeqCst), 1);
    assert!(db.status(&format!("stream:{ID}")).await.is_err());
    assert!(db.status(&format!("receipt/{ID}")).await.is_err());
}

#[tokio::test]
async fn an_upload_over_its_limit_is_too_large() {
    let (app, _db, store) = store_fixture();
    let body = upload(vec![
        Ok(Bytes::from_static(PGP_BINARY)),
        Err(io::Error::other(BodyTooLarge)),
    ]);
    let stored = lifecycle::store_file(&app, ID, body, &secret("", false), false).await;
    assert_eq!(stored, Err(StoreError::TooLarge));
    assert!(store.blobs.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_stored_file_can_be_opened() {
    let (app, _db, _store) = store_fixture();
    let stored = lifecycle::store_file(&app, ID, binary(), &secret("", false), false).await;
    assert_eq!(stored, Ok(None));
    let mut delivery = lifecycle::open_file(&app, ID, None, || {}).await.unwrap();
    assert_eq!(delivery.content.next().await.unwrap().unwrap(), PGP_BINARY);
}
