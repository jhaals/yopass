//! Read receipts: a delivery that cannot be recorded must not happen.

mod common;

use common::*;
use serde_json::json;
use std::sync::Arc;
use tokio::task::JoinSet;
use yopass_server::db::Database;
use yopass_server::db::Secret;
use yopass_server::db::memory::MemoryDb;
use yopass_server::util::now_unix;

const TOKEN: &str = "x-yopass-receipt-token";

async fn create_with_receipt(harness: &Harness, one_time: bool) -> (String, String) {
    let response = harness
        .send(req("POST", "/create/secret").json(&json!({
            "message": PGP_MESSAGE, "expiration": 3600, "one_time": one_time, "receipt": true,
        })))
        .await;
    assert_eq!(response.status, 200, "{}", response.text());
    let body = response.json();
    (
        body["message"].as_str().unwrap().to_owned(),
        body["receipt_token"].as_str().unwrap().to_owned(),
    )
}

#[tokio::test]
async fn lifecycle() {
    let harness = Builder::new().licensed().build();
    let (key, token) = create_with_receipt(&harness, false).await;
    let check = |path: String| {
        let (harness, token) = (&harness, token.clone());
        async move { harness.send(req("GET", &path).header(TOKEN, &token)).await }
    };
    let pending = check(format!("/secret/{key}/receipt")).await;
    assert_eq!(pending.status, 200);
    assert_eq!(pending.header("cache-control"), Some("no-store"));
    assert_eq!(pending.json()["state"], "pending");
    assert_eq!(pending.json()["one_time"], false);
    assert!(pending.json().get("viewed_at").is_none());

    assert_eq!(harness.get(&format!("/secret/{key}")).await.status, 200);
    let viewed = check(format!("/secret/{key}/receipt")).await.json();
    assert_eq!(viewed["state"], "viewed");
    let first_view = viewed["viewed_at"].as_i64().unwrap();
    assert!(first_view >= now_unix() - 5);

    // A second view of a multi-view secret does not rewrite the record.
    harness.get(&format!("/secret/{key}")).await;
    assert_eq!(
        check(format!("/secret/{key}/receipt")).await.json()["viewed_at"],
        first_view
    );
    // Receipts are keyed by raw ID, so the file route shares them.
    assert_eq!(check(format!("/file/{key}/receipt")).await.status, 200);
}

/// Identical answers hide whether a receipt exists from a mere link holder.
#[tokio::test]
async fn secret_id_alone_reveals_nothing() {
    let harness = Builder::new().licensed().build();
    let (key, _) = create_with_receipt(&harness, false).await;
    let plain = harness.create_secret(false).await;
    let responses = [
        harness.get(&format!("/secret/{key}/receipt")).await,
        harness
            .send(req("GET", &format!("/secret/{key}/receipt")).header(TOKEN, "wrong"))
            .await,
        harness.get(&format!("/secret/{plain}/receipt")).await,
        harness.get(&format!("/secret/{UUID_KEY}/receipt")).await,
    ];
    for response in &responses {
        assert_eq!(response.status, 404);
        assert_eq!(response.text(), responses[0].text());
    }
    assert_eq!(
        harness
            .audit_events()
            .iter()
            .filter(|e| e["outcome"] == "denied")
            .count(),
        2
    );
}

#[tokio::test]
async fn requires_a_license_and_respects_the_flag() {
    let unlicensed = harness();
    let body = json!({ "message": PGP_MESSAGE, "expiration": 3600, "receipt": true });
    let response = unlicensed
        .send(req("POST", "/create/secret").json(&body))
        .await;
    assert_eq!(response.status, 400);
    assert_eq!(
        response.message(),
        "Read receipts are not enabled on this server"
    );
    let disabled = Builder::new()
        .licensed()
        .settings(|s| s.disable_read_receipts = true)
        .build();
    assert_eq!(
        disabled
            .send(req("POST", "/create/secret").json(&body))
            .await
            .status,
        400
    );
    assert_eq!(disabled.get("/config").await.json()["READ_RECEIPTS"], false);
}

#[tokio::test]
async fn checkable_and_recorded_through_a_read_only_instance() {
    let db = Arc::new(MemoryDb::new());
    let writer = Builder::with_db(db.clone()).licensed().build();
    let (key, token) = create_with_receipt(&writer, true).await;
    let reader = Builder::with_db(db)
        .settings(|s| s.read_only = true)
        .build();
    assert_eq!(reader.get(&format!("/secret/{key}")).await.status, 200);
    let receipt = reader
        .send(req("GET", &format!("/secret/{key}/receipt")).header(TOKEN, &token))
        .await;
    assert_eq!(receipt.json()["state"], "viewed");
}

/// A viewed receipt outlives the secret it describes.
#[tokio::test]
async fn receipt_remains_after_a_one_time_secret_is_gone() {
    let harness = Builder::new().licensed().build();
    let (key, token) = create_with_receipt(&harness, true).await;
    harness.get(&format!("/secret/{key}")).await;
    assert_eq!(harness.get(&format!("/secret/{key}")).await.status, 404);
    let receipt = harness
        .send(req("GET", &format!("/secret/{key}/receipt")).header(TOKEN, &token))
        .await;
    assert_eq!(receipt.status, 200);
    assert_eq!(receipt.json()["state"], "viewed");
}

#[tokio::test]
async fn expires_slightly_after_its_secret() {
    let db = Arc::new(MemoryDb::new());
    let harness = Builder::with_db(db.clone()).licensed().build();
    let (key, _) = create_with_receipt(&harness, false).await;
    let secret_ttl = db.status(&key).await.unwrap().expiration;
    let receipt = db.status(&format!("receipt/{key}")).await.unwrap();
    assert_eq!(
        receipt.expiration,
        secret_ttl + 1,
        "created after its secret, it must also end after it"
    );
}

#[tokio::test]
async fn expired_record_is_not_found() {
    let db = Arc::new(MemoryDb::new());
    let harness = Builder::with_db(db.clone()).licensed().build();
    let (key, token) = create_with_receipt(&harness, false).await;
    let stale = db.status(&format!("receipt/{key}")).await.unwrap();
    let mut record: serde_json::Value = serde_json::from_str(&stale.message).unwrap();
    record["expires_at"] = (now_unix() - 1).into();
    db.put(
        &format!("receipt/{key}"),
        &Secret {
            message: record.to_string(),
            expiration: 60,
            ..Secret::default()
        },
    )
    .await
    .unwrap();
    let response = harness
        .send(req("GET", &format!("/secret/{key}/receipt")).header(TOKEN, &token))
        .await;
    assert_eq!(response.status, 404);
    // Marking must not resurrect it, and the secret stays retrievable.
    assert_eq!(harness.get(&format!("/secret/{key}")).await.status, 200);
}

#[tokio::test]
async fn updating_a_receipt_preserves_its_deadline() {
    let db = Arc::new(MemoryDb::new());
    let harness = Builder::with_db(db.clone()).licensed().build();
    let (key, _) = create_with_receipt(&harness, false).await;
    let before = db.status(&format!("receipt/{key}")).await.unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&before.message).unwrap();
    harness.get(&format!("/secret/{key}")).await;
    let after = db.status(&format!("receipt/{key}")).await.unwrap();
    let updated: serde_json::Value = serde_json::from_str(&after.message).unwrap();
    assert_eq!(updated["expires_at"], parsed["expires_at"]);
    assert!(after.expiration <= before.expiration);
    assert!(after.expiration > 0);
}

/// If the receipt cannot be stored, creation is undone rather than handing out a
/// token that will never report anything.
#[tokio::test]
async fn failed_receipt_store_removes_the_secret() {
    let memory = Arc::new(MemoryDb::new());
    let db = FaultDb::new(memory.clone());
    let harness = Builder::with_db(db.clone()).licensed().build();
    *db.faults.put.lock().unwrap() = Some("receipt/");
    let response = harness
        .send(
            req("POST", "/create/secret")
                .json(&json!({ "message": PGP_MESSAGE, "expiration": 3600, "receipt": true })),
        )
        .await;
    assert_eq!(response.status, 500);
    assert_eq!(response.message(), "Failed to store receipt in database");
    assert!(
        memory.keys().is_empty(),
        "secret left behind without its receipt"
    );

    let upload = harness
        .send(upload_req(PGP_BINARY, "3600", true).header("x-yopass-receipt", "true"))
        .await;
    assert_eq!(upload.status, 500);
    assert!(
        memory.keys().is_empty(),
        "file left behind without its receipt: {:?}",
        memory.keys()
    );
}

/// A delivery that cannot be recorded must not happen, and the secret stays
/// intact: the link holder could otherwise hide their read by filling the backend.
#[tokio::test]
async fn failed_receipt_update_blocks_delivery_and_keeps_the_secret() {
    for one_time in [true, false] {
        let db = FaultDb::new(Arc::new(MemoryDb::new()));
        let harness = Builder::with_db(db.clone()).licensed().build();
        let (key, token) = create_with_receipt(&harness, one_time).await;
        *db.faults.update.lock().unwrap() = Some("receipt/");
        let response = harness.get(&format!("/secret/{key}")).await;
        assert_eq!(response.status, 503);
        assert!(!response.text().contains("BEGIN PGP"));
        assert_eq!(
            harness.last_audit()["error"],
            "failed to store read receipt"
        );
        *db.faults.update.lock().unwrap() = None;
        assert_eq!(harness.get(&format!("/secret/{key}")).await.status, 200);
        let receipt = harness
            .send(req("GET", &format!("/secret/{key}/receipt")).header(TOKEN, &token))
            .await;
        assert_eq!(receipt.json()["state"], "viewed");
    }
}

#[tokio::test]
async fn denied_retrieval_does_not_mark_viewed() {
    let db = Arc::new(MemoryDb::new());
    let harness = Builder::with_db(db.clone()).licensed().sessions().build();
    let (key, token) = create_with_receipt(&harness, false).await;
    db.update(&key, &|mut value| {
        value.require_auth = true;
        Ok(value)
    })
    .await
    .unwrap();
    assert_eq!(harness.get(&format!("/secret/{key}")).await.status, 401);
    let receipt = harness
        .send(req("GET", &format!("/secret/{key}/receipt")).header(TOKEN, &token))
        .await;
    assert_eq!(receipt.json()["state"], "pending");
}

#[tokio::test]
async fn file_receipts() {
    let harness = Builder::new().licensed().build();
    let response = harness
        .send(upload_req(PGP_BINARY, "3600", true).header("x-yopass-receipt", "true"))
        .await;
    let body = response.json();
    let (key, token) = (
        body["message"].as_str().unwrap(),
        body["receipt_token"].as_str().unwrap(),
    );
    assert_eq!(
        harness
            .send(req("GET", &format!("/file/{key}/receipt")).header(TOKEN, token))
            .await
            .json()["state"],
        "pending"
    );
    harness.get(&format!("/file/{key}")).await;
    assert_eq!(
        harness
            .send(req("GET", &format!("/file/{key}/receipt")).header(TOKEN, token))
            .await
            .json()["state"],
        "viewed"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn concurrent_reads_record_exactly_one_view_timestamp() {
    for (name, db) in backends() {
        let harness = Arc::new(Builder::with_db(db).licensed().build());
        let (key, token) = create_with_receipt(&harness, false).await;
        let mut tasks = JoinSet::new();
        for _ in 0..16 {
            let (harness, key) = (harness.clone(), key.clone());
            tasks.spawn(async move { harness.get(&format!("/secret/{key}")).await.status });
        }
        while let Some(status) = tasks.join_next().await {
            let status = status.unwrap();
            // Contention may delay a reader, but never yields content without a record.
            assert!(status == 200 || status == 503, "{name}: {status}");
        }
        let receipt = harness
            .send(req("GET", &format!("/secret/{key}/receipt")).header(TOKEN, &token))
            .await;
        assert_eq!(receipt.json()["state"], "viewed", "{name}");
    }
}

/// The receipt outlives its secret by a margin; at the largest lifetime that
/// margin must saturate rather than overflow or produce an expired record.
#[tokio::test]
async fn a_receipt_at_the_maximum_lifetime_works() {
    let harness = Builder::new()
        .licensed()
        .settings(|s| {
            s.allow_custom_expiration = true;
            s.max_expiration = i32::MAX;
        })
        .build();
    let response = harness
        .send(req("POST", "/create/secret").json(&json!({
            "message": PGP_MESSAGE, "expiration": i32::MAX, "one_time": true, "receipt": true,
        })))
        .await;
    assert_eq!(response.status, 200, "{}", response.text());
    let body = response.json();
    let (key, token) = (
        body["message"].as_str().unwrap().to_owned(),
        body["receipt_token"].as_str().unwrap().to_owned(),
    );
    let receipt = || req("GET", &format!("/secret/{key}/receipt")).header(TOKEN, &token);
    assert_eq!(harness.send(receipt()).await.json()["state"], "pending");
    assert_eq!(harness.get(&format!("/secret/{key}")).await.status, 200);
    assert_eq!(harness.send(receipt()).await.json()["state"], "viewed");
}
