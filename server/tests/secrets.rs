//! Secret lifecycle, one-time races across instances, and failure handling.

mod common;

use common::*;
use serde_json::json;
use std::sync::Arc;
use tokio::task::JoinSet;
use yopass_server::db::memory::MemoryDb;
use yopass_server::db::{Database, Secret};
use yopass_server::util::redact_secret_id;

#[tokio::test]
async fn create_read_and_delete() {
    let harness = harness();
    let response = harness
        .send(
            req("POST", "/create/secret")
                .json(&json!({ "message": PGP_MESSAGE, "expiration": 3600 })),
        )
        .await;
    assert_eq!(response.status, 200);
    assert_eq!(response.header("content-type"), Some("application/json"));
    let key = response.message();
    assert_eq!(key.len(), 22);

    for _ in 0..2 {
        let read = harness.get(&format!("/secret/{key}")).await;
        assert_eq!(read.status, 200);
        assert_eq!(read.json()["message"], PGP_MESSAGE);
        assert_eq!(read.json()["expiration"], 3600);
    }
    assert_eq!(harness.delete(&format!("/secret/{key}")).await.status, 204);
    assert_eq!(harness.get(&format!("/secret/{key}")).await.status, 404);
    let again = harness.delete(&format!("/secret/{key}")).await;
    assert_eq!(again.status, 404);
    assert_eq!(again.message(), "Secret not found");
}

#[tokio::test]
async fn one_time_secret_is_delivered_once_and_status_does_not_consume_it() {
    let harness = harness();
    let key = harness.create_secret(true).await;
    for _ in 0..3 {
        let status = harness.get(&format!("/secret/{key}/status")).await;
        assert_eq!(
            status.json(),
            json!({"oneTime": true, "requireAuth": false})
        );
    }
    assert_eq!(harness.get(&format!("/secret/{key}")).await.status, 200);
    let second = harness.get(&format!("/secret/{key}")).await;
    assert_eq!(second.status, 404);
    assert_eq!(second.message(), "Secret not found");
    assert_eq!(
        harness.get(&format!("/secret/{key}/status")).await.status,
        404
    );
}

/// The race the whole product depends on, over HTTP, across separate server
/// instances sharing one backend.
#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn concurrent_retrieval_across_instances_delivers_once() {
    for (name, db) in backends() {
        let instances: Vec<Arc<Harness>> = (0..3)
            .map(|_| Arc::new(Builder::with_db(db.clone()).licensed().build()))
            .collect();
        for _ in 0..5 {
            let key = instances[0].create_secret(true).await;
            let mut tasks = JoinSet::new();
            let start = Arc::new(tokio::sync::Barrier::new(24));
            for index in 0..24 {
                let (instance, key, start) =
                    (instances[index % 3].clone(), key.clone(), start.clone());
                tasks.spawn(async move {
                    start.wait().await;
                    instance.get(&format!("/secret/{key}")).await
                });
            }
            let mut delivered = 0;
            while let Some(response) = tasks.join_next().await {
                let response = response.unwrap();
                match response.status.as_u16() {
                    200 => {
                        delivered += 1;
                        assert_eq!(response.json()["message"], PGP_MESSAGE);
                    }
                    404 => assert!(!response.text().contains("BEGIN PGP"), "{name}"),
                    other => panic!("{name}: unexpected status {other}: {}", response.text()),
                }
            }
            assert_eq!(delivered, 1, "{name}: secret delivered {delivered} times");
        }
        // Exactly one success across all audit logs, each loser recorded as such.
        let successes = instances
            .iter()
            .flat_map(|i| i.audit_events())
            .filter(|e| e["event"] == "secret.accessed" && e["outcome"] == "success")
            .count();
        assert_eq!(successes, 5, "{name}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn concurrent_delete_and_read_have_one_winner_per_kind() {
    for (name, db) in backends() {
        let harness = Arc::new(Builder::with_db(db).build());
        for _ in 0..10 {
            let key = harness.create_secret(true).await;
            let (a, b) = (harness.clone(), harness.clone());
            let (ka, kb) = (key.clone(), key.clone());
            let read = tokio::spawn(async move { a.get(&format!("/secret/{ka}")).await });
            let delete = tokio::spawn(async move { b.delete(&format!("/secret/{kb}")).await });
            let (read, delete) = (read.await.unwrap(), delete.await.unwrap());
            let winners = usize::from(read.status == 200) + usize::from(delete.status == 204);
            assert_eq!(
                winners, 1,
                "{name}: read {} delete {}",
                read.status, delete.status
            );
        }
    }
}

/// If another write replaces the value between authorization and claim, the
/// request must not consume the replacement using the old snapshot's policy.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn http_claim_preserves_a_replacement() {
    let db = FaultDb::new(Arc::new(MemoryDb::new()));
    let harness = Builder::with_db(db.clone()).build();
    db.inner
        .put(UUID_KEY, &secret("original", true))
        .await
        .unwrap();
    let replacement = Secret {
        require_auth: true,
        ..secret("replacement", false)
    };
    let injected = replacement.clone();
    *db.faults.during_claim.lock().unwrap() = Some(Box::new(move |db, key| {
        let value = injected.clone();
        block_on(async move { db.put(&key, &value).await.unwrap() });
    }));
    let response = harness.get(&format!("/secret/{UUID_KEY}")).await;
    assert_eq!(response.status, 404);
    assert!(!response.text().contains("original") && !response.text().contains("replacement"));
    *db.faults.during_claim.lock().unwrap() = None;
    assert_eq!(db.inner.status(UUID_KEY).await.unwrap(), replacement);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn http_delete_preserves_a_replacement() {
    let db = FaultDb::new(Arc::new(MemoryDb::new()));
    let harness = Builder::with_db(db.clone()).build();
    let original = secret("original", false);
    db.inner.put(UUID_KEY, &original).await.unwrap();
    let copy = original.clone();
    *db.faults.during_claim.lock().unwrap() = Some(Box::new(move |db, key| {
        let value = copy.clone();
        block_on(async move { db.put(&key, &value).await.unwrap() });
    }));
    assert_eq!(
        harness.delete(&format!("/secret/{UUID_KEY}")).await.status,
        404
    );
    assert_eq!(db.inner.status(UUID_KEY).await.unwrap(), original);
}

#[tokio::test]
async fn claim_failures_never_serve_content_or_leak_details() {
    for (fault, status, message, outcome, reason) in [
        (
            ClaimFault::Backend,
            500,
            "Failed to process secret",
            "failure",
            "failed to claim one-time secret",
        ),
        (
            ClaimFault::LostRace,
            404,
            "Secret not found",
            "denied",
            "claimed by concurrent request",
        ),
    ] {
        let db = FaultDb::new(Arc::new(MemoryDb::new()));
        let mut builder = Builder::with_db(db.clone()).licensed();
        builder.license = valid_license();
        let harness = builder.build();
        db.inner
            .put(UUID_KEY, &secret("encrypted content", true))
            .await
            .unwrap();
        *db.faults.claim.lock().unwrap() = Some(fault);
        let response = harness.get(&format!("/secret/{UUID_KEY}")).await;
        assert_eq!(response.status, status);
        assert_eq!(response.message(), message);
        assert!(!response.text().contains("encrypted content"));
        assert!(
            !response.text().contains(UUID_KEY),
            "backend details must not reach clients"
        );
        let event = harness.last_audit();
        assert_eq!(event["event"], "secret.accessed");
        assert_eq!(event["outcome"], outcome);
        assert_eq!(event["error"], reason);
        assert_eq!(event["one_time"], true);
        assert_eq!(event["secret_id"], redact_secret_id(UUID_KEY));
    }
}

/// A database outage must not look like a spent link.
#[tokio::test]
async fn outage_is_not_reported_as_a_missing_secret() {
    let db = FaultDb::new(Arc::new(MemoryDb::new()));
    let harness = Builder::with_db(db.clone()).build();
    db.inner
        .put(UUID_KEY, &secret("encrypted", true))
        .await
        .unwrap();
    *db.faults.status.lock().unwrap() = Some("");
    for path in [
        format!("/secret/{UUID_KEY}"),
        format!("/secret/{UUID_KEY}/status"),
    ] {
        let response = harness.get(&path).await;
        assert_eq!(response.status, 503, "{path}");
        assert_eq!(response.header("cache-control"), Some("no-store"));
        assert!(!response.text().contains(UUID_KEY));
    }
    *db.faults.status.lock().unwrap() = None;
    assert_eq!(
        harness.get(&format!("/secret/{UUID_KEY}")).await.status,
        200,
        "the secret must survive the outage"
    );
}

/// The same holds when the backend fails after the first read succeeded.
#[tokio::test]
async fn outage_after_the_status_read_is_not_reported_as_a_missing_secret() {
    let db = FaultDb::new(Arc::new(MemoryDb::new()));
    let harness = Builder::with_db(db.clone()).build();
    db.inner
        .put(UUID_KEY, &secret("encrypted", false))
        .await
        .unwrap();
    *db.faults.claim.lock().unwrap() = Some(ClaimFault::Backend);
    let response = harness.get(&format!("/secret/{UUID_KEY}")).await;
    assert_eq!(response.status, 503);
    assert_eq!(response.message(), "Database temporarily unavailable");
    assert_eq!(response.header("cache-control"), Some("no-store"));

    // A value that is really gone by then is still a plain 404.
    *db.faults.claim.lock().unwrap() = Some(ClaimFault::LostRace);
    assert_eq!(
        harness.get(&format!("/secret/{UUID_KEY}")).await.status,
        404
    );
}

#[tokio::test]
async fn store_failures_answer_generically() {
    let db = FaultDb::new(Arc::new(MemoryDb::new()));
    let harness = Builder::with_db(db.clone()).build();
    *db.faults.put.lock().unwrap() = Some("");
    let response = harness
        .send(
            req("POST", "/create/secret")
                .json(&json!({"message": PGP_MESSAGE, "expiration": 3600})),
        )
        .await;
    assert_eq!(response.status, 500);
    assert_eq!(response.message(), "Failed to store secret in database");

    *db.faults.delete.lock().unwrap() = Some("");
    db.inner.put(UUID_KEY, &secret("x", false)).await.unwrap();
    let delete = harness.delete(&format!("/secret/{UUID_KEY}")).await;
    assert_eq!(delete.status, 500);
    assert_eq!(delete.message(), "Failed to delete secret");
}

#[tokio::test]
async fn audit_records_carry_fingerprints_and_never_content() {
    let harness = Builder::new().licensed().build();
    let key = harness.create_secret(true).await;
    harness.get(&format!("/secret/{key}")).await;
    let events = harness.audit_events();
    assert_eq!(events[0]["event"], "secret.created");
    assert_eq!(events[0]["expiration_seconds"], 3600);
    assert_eq!(events[0]["secret_id"], redact_secret_id(&key));
    assert_eq!(events[1]["event"], "secret.accessed");
    assert_eq!(events[1]["client_ip"], "203.0.113.9");
    let raw = harness.audit.text();
    assert!(!raw.contains(&key), "raw key in audit log");
    assert!(!raw.contains("BEGIN PGP"), "content in audit log");
}

/// Noise must not be able to push reads out of the log.
#[tokio::test]
async fn audit_events_are_never_sampled() {
    let harness = Builder::new().licensed().build();
    for _ in 0..500 {
        harness.get(&format!("/secret/{UUID_KEY}")).await;
    }
    assert_eq!(harness.audit_events().len(), 500);
}

#[tokio::test]
async fn audit_stops_when_the_license_expires() {
    let mut builder = Builder::new();
    builder.license = expired_license();
    let harness = builder.build();
    harness.create_secret(true).await;
    assert!(harness.audit_events().is_empty());
}

/// Link scanners and previewers send HEAD. It must never spend a one-time link.
#[tokio::test]
async fn head_requests_never_consume_anything() {
    let harness = Builder::new().licensed().build();
    let secret_key = harness.create_secret(true).await;
    let file_key = harness.upload(true).await;
    let created = harness
        .send(req("POST", "/request").json(&json!({"public_key": PUBLIC_KEY, "expiration": 3600})))
        .await
        .json();
    let (id, token) = (
        created["id"].as_str().unwrap(),
        created["token"].as_str().unwrap(),
    );
    harness
        .send(req("POST", &format!("/request/{id}/secret")).json(&json!({"message": PGP_MESSAGE})))
        .await;

    for path in [
        format!("/secret/{secret_key}"),
        format!("/secret/{secret_key}/status"),
        format!("/file/{file_key}"),
        format!("/file/{file_key}/status"),
        format!("/request/{id}"),
        format!("/request/{id}/secret"),
    ] {
        let response = harness
            .send(req("HEAD", &path).header("x-yopass-request-token", token))
            .await;
        assert_eq!(
            response.status, 404,
            "HEAD {path} must not reach the handler"
        );
    }
    assert_eq!(
        harness.get(&format!("/secret/{secret_key}")).await.status,
        200
    );
    assert_eq!(harness.get(&format!("/file/{file_key}")).await.status, 200);
    let fetched = harness
        .send(req("GET", &format!("/request/{id}/secret")).header("x-yopass-request-token", token))
        .await;
    assert_eq!(fetched.status, 200);
}

#[tokio::test]
async fn unreadable_or_stalled_creation_bodies_are_refused() {
    use axum::body::Body;
    use futures_util::stream;
    let harness = Builder::new()
        .settings(|s| s.request_timeout = Some(std::time::Duration::from_millis(50)))
        .build();
    let broken = Body::from_stream(stream::iter([Err::<bytes::Bytes, _>(
        std::io::Error::other("connection reset"),
    )]));
    let stalled = Body::from_stream(stream::pending::<Result<bytes::Bytes, std::io::Error>>());
    for (body, status) in [(broken, 400), (stalled, 408)] {
        let response = harness
            .send(
                req("POST", "/create/secret")
                    .header("content-type", "application/json")
                    .body(body),
            )
            .await;
        assert_eq!(response.status, status);
    }
}

/// The transport cap leaves room for JSON-escaping armor's line breaks, so a
/// message of exactly the allowed length reaches validation.
#[tokio::test]
async fn a_message_at_the_limit_is_judged_on_content_not_escaping() {
    let harness = Builder::new().settings(|s| s.max_length = 4096).build();
    let message = "\n".repeat(4096);
    let response = harness
        .send(req("POST", "/create/secret").json(&json!({"message": message, "expiration": 3600})))
        .await;
    assert_eq!(response.status, 400);
    assert_eq!(response.message(), "Message must be PGP encrypted");
}

#[tokio::test]
async fn failed_deletes_answer_generically_and_keep_the_secret() {
    let db = FaultDb::new(Arc::new(MemoryDb::new()));
    let harness = Builder::with_db(db.clone()).build();
    let key = harness.create_secret(false).await;
    *db.faults.delete.lock().unwrap() = Some("");
    let response = harness.delete(&format!("/secret/{key}")).await;
    assert_eq!(response.status, 500);
    assert_eq!(response.message(), "Failed to delete secret");
    assert!(!response.text().contains(&key));
    *db.faults.delete.lock().unwrap() = None;
    assert_eq!(harness.get(&format!("/secret/{key}")).await.status, 200);
}

#[tokio::test]
async fn a_receipt_failure_with_a_failing_rollback_is_logged_by_fingerprint() {
    let logs = captured_logs();
    let db = FaultDb::new(Arc::new(MemoryDb::new()));
    let harness = Builder::with_db(db.clone()).licensed().build();
    *db.faults.put.lock().unwrap() = Some("receipt/");
    *db.faults.delete.lock().unwrap() = Some("");
    let response = harness
        .send(
            req("POST", "/create/secret")
                .json(&json!({ "message": PGP_MESSAGE, "expiration": 3600, "receipt": true })),
        )
        .await;
    assert_eq!(response.status, 500);
    assert!(
        logs.text()
            .contains("Failed to delete secret after receipt error")
    );
}

/// The claim rechecks the snapshot it consumes: a value replaced by a protected
/// one between the status read and the claim is refused, not delivered.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_protected_replacement_during_retrieval_is_refused() {
    let memory = Arc::new(MemoryDb::new());
    let db = FaultDb::new(memory.clone());
    let harness = Builder::with_db(db.clone()).licensed().sessions().build();
    let key = harness.create_secret(true).await;
    let replaced = key.clone();
    *db.faults.after_status.lock().unwrap() = Some(Box::new(move |inner, _| {
        let mut protected = secret("replacement", true);
        protected.require_auth = true;
        let replaced = replaced.clone();
        block_on(async move { inner.put(&replaced, &protected).await.unwrap() });
    }));
    let response = harness.get(&format!("/secret/{key}")).await;
    assert_eq!(response.status, 401);
    assert!(!response.text().contains("replacement"));
    assert_eq!(memory.status(&key).await.unwrap().message, "replacement");
}
