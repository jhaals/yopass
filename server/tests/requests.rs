//! The secret request lifecycle and its races.

mod common;

use axum::body::Body;
use common::*;
use futures_util::stream;
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::Duration;
use tokio::task::JoinSet;
use yopass_server::db::memory::MemoryDb;
use yopass_server::db::{Database, Secret};
use yopass_server::util::now_unix;

const TOKEN: &str = "x-yopass-request-token";

async fn create(harness: &Harness, note: &str) -> (String, String) {
    let response = harness
        .send(req("POST", "/request").json(&json!({
            "public_key": PUBLIC_KEY, "label": "db password", "note": note, "expiration": 3600,
        })))
        .await;
    assert_eq!(response.status, 200, "{}", response.text());
    let body = response.json();
    assert!(body["expires_at"].as_i64().unwrap() > now_unix());
    (
        body["id"].as_str().unwrap().to_owned(),
        body["token"].as_str().unwrap().to_owned(),
    )
}

fn fulfill(id: &str, key_version: &str) -> Req {
    req("POST", &format!("/request/{id}/secret"))
        .json(&json!({ "message": PGP_MESSAGE, "key_version": key_version }))
}

fn licensed() -> Harness {
    Builder::new().licensed().build()
}

#[tokio::test]
async fn full_lifecycle() {
    let harness = licensed();
    let (id, token) = create(&harness, "please send").await;

    let view = harness.get(&format!("/request/{id}")).await;
    assert_eq!(view.header("cache-control"), Some("no-store"));
    let body = view.json();
    assert_eq!(body["public_key"], PUBLIC_KEY);
    assert_eq!(body["label"], "db password");
    assert_eq!(body["note"], "please send");
    assert_eq!(body["state"], "pending");
    assert!(body.get("token_hash").is_none(), "hash must stay private");
    assert!(body.get("secret").is_none());

    let early = harness
        .send(req("GET", &format!("/request/{id}/secret")).header(TOKEN, &token))
        .await;
    assert_eq!(early.status, 409);
    assert_eq!(early.message(), "No secret has been provided yet");

    let provided = harness.send(fulfill(&id, "")).await;
    assert_eq!(provided.status, 200);
    assert_eq!(provided.message(), "secret provided");

    // The note stops being exposed to link holders once answered.
    let fulfilled = harness.get(&format!("/request/{id}")).await.json();
    assert_eq!(fulfilled["state"], "fulfilled");
    assert_eq!(fulfilled["note"], "");
    assert!(!fulfilled.to_string().contains("BEGIN PGP MESSAGE"));

    let again = harness.send(fulfill(&id, "")).await;
    assert_eq!(again.status, 409);
    assert_eq!(
        again.message(),
        "A secret has already been provided for this request"
    );

    let fetched = harness
        .send(req("GET", &format!("/request/{id}/secret")).header(TOKEN, &token))
        .await;
    assert_eq!(fetched.status, 200);
    assert_eq!(fetched.header("cache-control"), Some("no-store"));
    assert_eq!(
        fetched.json(),
        json!({ "message": PGP_MESSAGE, "kind": "text" })
    );

    // Retrievable once, then gone for everyone.
    assert_eq!(
        harness
            .send(req("GET", &format!("/request/{id}/secret")).header(TOKEN, &token))
            .await
            .status,
        404
    );
    assert_eq!(harness.get(&format!("/request/{id}")).await.status, 404);
}

#[tokio::test]
async fn management_token_protects_fetch_revoke_and_rotate() {
    let harness = licensed();
    let (id, token) = create(&harness, "").await;
    harness.send(fulfill(&id, "")).await;
    for bad in ["", "wrong", &"a".repeat(4096)] {
        let fetch = harness
            .send(req("GET", &format!("/request/{id}/secret")).header(TOKEN, bad))
            .await;
        assert_eq!(fetch.status, 401);
        assert_eq!(fetch.message(), "Invalid request token");
        assert!(!fetch.text().contains("BEGIN PGP"));
        assert_eq!(
            harness
                .send(req("DELETE", &format!("/request/{id}")).header(TOKEN, bad))
                .await
                .status,
            401
        );
    }
    assert_eq!(
        harness
            .send(req("GET", &format!("/request/{id}/secret")))
            .await
            .status,
        401
    );
    assert_eq!(
        harness
            .send(req("GET", &format!("/request/{id}/secret")).header(TOKEN, &token))
            .await
            .status,
        200
    );
}

#[tokio::test]
async fn revoke_is_final() {
    let harness = licensed();
    let (id, token) = create(&harness, "").await;
    assert_eq!(
        harness
            .send(req("DELETE", &format!("/request/{id}")).header(TOKEN, &token))
            .await
            .status,
        204
    );
    assert_eq!(harness.get(&format!("/request/{id}")).await.status, 404);
    assert_eq!(harness.send(fulfill(&id, "")).await.status, 404);
}

#[tokio::test]
async fn rotation_invalidates_stale_answers() {
    let harness = licensed();
    let (id, token) = create(&harness, "").await;
    let path = format!("/request/{id}/key");
    let rotate = |token: &str| {
        req("PUT", &path)
            .header(TOKEN, token)
            .json(&json!({ "public_key": PUBLIC_KEY }))
    };
    assert_eq!(harness.send(rotate("wrong")).await.status, 401);
    let rotated = harness.send(rotate(&token)).await;
    assert_eq!(rotated.status, 200);
    assert_eq!(rotated.message(), "public key updated");

    let version = harness.get(&format!("/request/{id}")).await.json()["key_version"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(!version.is_empty());
    // An answer encrypted to the old key could never be decrypted.
    let stale = harness.send(fulfill(&id, "")).await;
    assert_eq!(stale.status, 412);
    assert_eq!(
        stale.message(),
        "Request key changed; open the new request link"
    );
    assert_eq!(harness.send(fulfill(&id, &version)).await.status, 200);

    let late = harness.send(rotate(&token)).await;
    assert_eq!(late.status, 409);
}

#[tokio::test]
async fn validation() {
    let harness = licensed();
    let post = |body: Value| {
        let harness = &harness;
        async move { harness.send(req("POST", "/request").json(&body)).await }
    };
    let base = || json!({ "public_key": PUBLIC_KEY, "expiration": 3600 });
    let with = |key: &str, value: Value| {
        let mut body = base();
        body[key] = value;
        body
    };
    assert_eq!(
        post(json!({})).await.message(),
        "A valid PGP public key is required"
    );
    assert_eq!(
        post(with("public_key", json!("not a key"))).await.message(),
        "A valid PGP public key is required"
    );
    assert_eq!(
        post(with("public_key", json!(PGP_MESSAGE))).await.message(),
        "A valid PGP public key is required"
    );
    assert_eq!(
        post(with("expiration", json!(123))).await.message(),
        "Invalid expiration specified"
    );
    assert_eq!(
        post(with("label", json!("x".repeat(101)))).await.message(),
        "Label is too long"
    );
    assert_eq!(
        post(with("note", json!("é".repeat(1001)))).await.message(),
        "Note is too long"
    );
    assert_eq!(
        post(with("note", json!(format!("  {}  ", "é".repeat(1000)))))
            .await
            .status,
        200
    );
    let raw = harness.send(req("POST", "/request").body("{bad")).await;
    assert_eq!(raw.message(), "Unable to parse json");
    let (id, _) = create(&harness, "").await;
    let bad = harness
        .send(req("POST", &format!("/request/{id}/secret")).json(&json!({"message": "plaintext"})))
        .await;
    assert_eq!(bad.message(), "Message must be PGP encrypted");
    let kind = harness
        .send(
            req("POST", &format!("/request/{id}/secret"))
                .json(&json!({"message": PGP_MESSAGE, "kind": "video"})),
        )
        .await;
    assert_eq!(kind.message(), "Invalid secret kind");
}

#[tokio::test]
async fn notes_can_be_disabled() {
    let harness = Builder::new()
        .licensed()
        .settings(|s| s.max_request_note_length = 0)
        .build();
    let response = harness
        .send(
            req("POST", "/request")
                .json(&json!({"public_key": PUBLIC_KEY, "expiration": 3600, "note": "x"})),
        )
        .await;
    assert_eq!(response.message(), "Note is too long");
}

#[tokio::test]
async fn forced_expiration_applies() {
    let harness = Builder::new()
        .licensed()
        .settings(|s| s.force_expiration = "1d".into())
        .build();
    let response = harness
        .send(req("POST", "/request").json(&json!({"public_key": PUBLIC_KEY, "expiration": 3600})))
        .await;
    assert_eq!(
        response.message(),
        "Expiration does not match server policy"
    );
}

#[tokio::test]
async fn file_answers_have_their_own_limits() {
    let harness = licensed();
    let (id, token) = create(&harness, "").await;
    let file = |id: &str, message: &str| {
        req("POST", &format!("/request/{id}/secret"))
            .json(&json!({"message": message, "kind": "file"}))
    };
    // Larger than --max-length, within the file limit.
    let large = format!(
        "-----BEGIN PGP MESSAGE-----\n\n{}=\n-----END PGP MESSAGE-----\n",
        format!("{}\n", "A".repeat(64)).repeat(1000) + "AAA"
    );
    assert!(large.len() > 10_000);
    assert_eq!(
        harness
            .send(req("POST", &format!("/request/{id}/secret")).json(&json!({"message": large})))
            .await
            .message(),
        "The encrypted message is too long"
    );
    assert_eq!(
        harness.send(file(&id, &large)).await.status,
        200,
        "file answers may exceed max-length"
    );
    let fetched = harness
        .send(req("GET", &format!("/request/{id}/secret")).header(TOKEN, &token))
        .await;
    assert_eq!(fetched.json()["kind"], "file");

    let (id, _) = create(&harness, "").await;
    let too_large = format!(
        "-----BEGIN PGP MESSAGE-----\n\n{}\n-----END PGP MESSAGE-----\n",
        format!("{}\n", "A".repeat(64)).repeat(13000)
    );
    assert_eq!(harness.send(file(&id, &too_large)).await.status, 413);

    let disabled = Builder::new()
        .licensed()
        .settings(|s| s.disable_upload = true)
        .build();
    let (id, _) = create(&disabled, "").await;
    let response = disabled.send(file(&id, PGP_MESSAGE)).await;
    assert_eq!(response.status, 400);
    assert_eq!(
        response.message(),
        "File responses are disabled on this server"
    );
    assert_eq!(disabled.send(fulfill(&id, "")).await.status, 200);
}

#[tokio::test]
async fn old_records_default_to_text() {
    let db = Arc::new(MemoryDb::new());
    let harness = Builder::with_db(db.clone()).licensed().build();
    let (token, hash) = yopass_server::util::generate_token();
    let record = json!({ "public_key": PUBLIC_KEY, "token_hash": hash, "state": "fulfilled", "secret": PGP_MESSAGE, "created_at": 1, "expires_at": now_unix() + 60 });
    db.put(
        &format!("request/{UUID_KEY}"),
        &Secret {
            message: record.to_string(),
            expiration: 60,
            ..Secret::default()
        },
    )
    .await
    .unwrap();
    let fetched = harness
        .send(req("GET", &format!("/request/{UUID_KEY}/secret")).header(TOKEN, &token))
        .await;
    assert_eq!(fetched.json()["kind"], "text");
}

#[tokio::test]
async fn invalid_records_are_not_found() {
    let db = Arc::new(MemoryDb::new());
    let harness = Builder::with_db(db.clone()).licensed().build();
    let expired =
        json!({ "token_hash": "h", "state": "pending", "expires_at": now_unix() - 60 }).to_string();
    for message in ["invalid JSON", "{}", expired.as_str()] {
        db.put(
            &format!("request/{UUID_KEY}"),
            &Secret {
                message: message.into(),
                expiration: 60,
                ..Secret::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(
            harness.get(&format!("/request/{UUID_KEY}")).await.status,
            404,
            "{message}"
        );
        assert_eq!(
            harness.send(fulfill(UUID_KEY, "")).await.status,
            404,
            "{message}"
        );
    }
}

#[tokio::test]
async fn updates_keep_the_original_deadline() {
    let db = Arc::new(MemoryDb::new());
    let harness = Builder::with_db(db.clone()).licensed().build();
    let (id, _) = create(&harness, "").await;
    let before = db.status(&format!("request/{id}")).await.unwrap();
    let deadline = serde_json::from_str::<Value>(&before.message).unwrap()["expires_at"].clone();
    harness.send(fulfill(&id, "")).await;
    let after = db.status(&format!("request/{id}")).await.unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&after.message).unwrap()["expires_at"],
        deadline
    );
    assert!(after.expiration <= before.expiration && after.expiration > 0);
}

/// Requests keep working through an outage and are reported as temporarily
/// unavailable, never as gone: a requester would discard them.
#[tokio::test]
async fn outage_is_retryable_and_not_reported_as_gone() {
    let logs = captured_logs();
    let db = FaultDb::new(Arc::new(MemoryDb::new()));
    let harness = Builder::with_db(db.clone()).licensed().build();
    let (id, token) = create(&harness, "").await;
    harness.send(fulfill(&id, "")).await;
    *db.faults.status.lock().unwrap() = Some("");
    for (method, path, header, value) in [
        ("GET", format!("/request/{id}"), TOKEN, ""),
        (
            "GET",
            format!("/request/{id}/secret"),
            TOKEN,
            token.as_str(),
        ),
        ("DELETE", format!("/request/{id}"), TOKEN, token.as_str()),
    ] {
        let response = harness.send(req(method, &path).header(header, value)).await;
        assert_eq!(response.status, 503, "{method} {path}");
        assert!(!response.text().contains(&id));
        assert_eq!(harness.last_audit()["error"], "database error");
    }
    *db.faults.status.lock().unwrap() = None;
    assert!(!logs.text().contains(&id), "raw ID logged during outage");
    assert_eq!(
        harness
            .send(req("GET", &format!("/request/{id}/secret")).header(TOKEN, &token))
            .await
            .status,
        200
    );
}

#[tokio::test]
async fn license_expiry_stops_creation_but_issued_requests_drain() {
    let db = Arc::new(MemoryDb::new());
    let active = Builder::with_db(db.clone()).licensed().build();
    let (id, token) = create(&active, "").await;

    let mut builder = Builder::with_db(db);
    builder.license = expired_license();
    let expired = builder.build();
    let response = expired
        .send(req("POST", "/request").json(&json!({"public_key": PUBLIC_KEY, "expiration": 3600})))
        .await;
    assert_eq!(response.status, 403);
    assert_eq!(response.message(), "Secret requests are currently disabled");
    assert_eq!(expired.send(fulfill(&id, "")).await.status, 200);
    assert_eq!(
        expired
            .send(req("GET", &format!("/request/{id}/secret")).header(TOKEN, &token))
            .await
            .status,
        200
    );
}

#[tokio::test]
async fn audit_trail_has_no_token_or_content() {
    let harness = licensed();
    let (id, token) = create(&harness, "secret note text").await;
    harness.send(fulfill(&id, "")).await;
    harness
        .send(req("GET", &format!("/request/{id}/secret")).header(TOKEN, &token))
        .await;
    let events: Vec<String> = harness
        .audit_events()
        .iter()
        .map(|e| e["event"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(
        events,
        [
            "request.created",
            "request.fulfilled",
            "request.secret_accessed"
        ]
    );
    let raw = harness.audit.text();
    for leak in [id.as_str(), token.as_str(), "BEGIN PGP", "secret note text"] {
        assert!(!raw.contains(leak), "{leak} in audit log");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn exactly_one_concurrent_answer_is_accepted() {
    for (name, db) in backends() {
        let harness = Arc::new(Builder::with_db(db).licensed().build());
        for _ in 0..5 {
            let (id, _) = create(&harness, "").await;
            let mut tasks = JoinSet::new();
            for _ in 0..12 {
                let (harness, id) = (harness.clone(), id.clone());
                tasks.spawn(async move { harness.send(fulfill(&id, "")).await.status.as_u16() });
            }
            let (mut accepted, mut failed) = (0, 0);
            while let Some(status) = tasks.join_next().await {
                match status.unwrap() {
                    200 => accepted += 1,
                    409 => {}
                    // Backends may give up after too many lost races, safely.
                    500 => failed += 1,
                    other => panic!("{name}: {other}"),
                }
            }
            assert_eq!(
                accepted, 1,
                "{name}: {accepted} answers accepted, {failed} failed"
            );
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn exactly_one_concurrent_fetch_gets_the_secret() {
    for (name, db) in backends() {
        let harness = Arc::new(Builder::with_db(db).licensed().build());
        for _ in 0..5 {
            let (id, token) = create(&harness, "").await;
            harness.send(fulfill(&id, "")).await;
            let mut tasks = JoinSet::new();
            for _ in 0..12 {
                let (harness, id, token) = (harness.clone(), id.clone(), token.clone());
                tasks.spawn(async move {
                    harness
                        .send(req("GET", &format!("/request/{id}/secret")).header(TOKEN, &token))
                        .await
                });
            }
            let mut delivered = 0;
            while let Some(response) = tasks.join_next().await {
                let response = response.unwrap();
                if response.status == 200 {
                    delivered += 1;
                } else {
                    assert!(!response.text().contains("BEGIN PGP"), "{name}");
                }
            }
            assert_eq!(delivered, 1, "{name}: answer delivered {delivered} times");
        }
    }
}

/// Whatever the order, an accepted answer is never encrypted to a replaced key.
#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn rotation_racing_an_answer_never_strands_it() {
    for (name, db) in backends() {
        let harness = Arc::new(Builder::with_db(db.clone()).licensed().build());
        for _ in 0..20 {
            let (id, token) = create(&harness, "").await;
            let (a, b) = (harness.clone(), harness.clone());
            let (ia, ib, t) = (id.clone(), id.clone(), token.clone());
            let answer =
                tokio::spawn(async move { a.send(fulfill(&ia, "")).await.status.as_u16() });
            let rotate = tokio::spawn(async move {
                b.send(
                    req("PUT", &format!("/request/{ib}/key"))
                        .header(TOKEN, &t)
                        .json(&json!({"public_key": PUBLIC_KEY})),
                )
                .await
                .status
                .as_u16()
            });
            let (answer, rotate) = (answer.await.unwrap(), rotate.await.unwrap());
            match (answer, rotate) {
                (200, 409) | (412, 200) => {}
                // A lost race reported as retryable leaves the record unchanged.
                (200, 500) | (500, 200) | (500, 500) => {}
                other => {
                    panic!("{name}: answer and rotation both took effect or neither: {other:?}")
                }
            }
            let state = harness.get(&format!("/request/{id}")).await.json();
            assert_eq!(state["state"] == "fulfilled", answer == 200, "{name}");
            assert_eq!(state["key_version"] != "", rotate == 200, "{name}");
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn revoke_racing_a_fetch_is_safe() {
    for (name, db) in backends() {
        let harness = Arc::new(Builder::with_db(db).licensed().build());
        for _ in 0..10 {
            let (id, token) = create(&harness, "").await;
            harness.send(fulfill(&id, "")).await;
            let (a, b) = (harness.clone(), harness.clone());
            let (ia, ib, ta, tb) = (id.clone(), id.clone(), token.clone(), token.clone());
            let fetch = tokio::spawn(async move {
                a.send(req("GET", &format!("/request/{ia}/secret")).header(TOKEN, &ta))
                    .await
                    .status
                    .as_u16()
            });
            let revoke = tokio::spawn(async move {
                b.send(req("DELETE", &format!("/request/{ib}")).header(TOKEN, &tb))
                    .await
                    .status
                    .as_u16()
            });
            let (fetch, revoke) = (fetch.await.unwrap(), revoke.await.unwrap());
            assert!(matches!(fetch, 200 | 404), "{name}: fetch {fetch}");
            assert!(matches!(revoke, 204 | 404), "{name}: revoke {revoke}");
            assert_eq!(
                harness.get(&format!("/request/{id}")).await.status,
                404,
                "{name}"
            );
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn fulfillment_between_load_and_claim_is_not_delivered_stale() {
    let db = FaultDb::new(Arc::new(MemoryDb::new()));
    let harness = Builder::with_db(db.clone()).licensed().build();
    let (id, token) = create(&harness, "").await;
    harness.send(fulfill(&id, "")).await;
    // The record changes after authorization: the claim must not delete the new one.
    *db.faults.during_claim.lock().unwrap() = Some(Box::new(|db, key| {
        block_on(async move {
            db.update(&key, &|value| Ok(value)).await.unwrap();
        });
    }));
    let response = harness
        .send(req("GET", &format!("/request/{id}/secret")).header(TOKEN, &token))
        .await;
    assert_eq!(response.status, 404);
    *db.faults.during_claim.lock().unwrap() = None;
    assert_eq!(
        harness
            .send(req("GET", &format!("/request/{id}/secret")).header(TOKEN, &token))
            .await
            .status,
        200
    );
}

/// The token was checked against what was loaded. If the record is replaced before
/// the claim reads it again, the check says nothing about the new record.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_record_replaced_after_the_token_check_is_not_delivered() {
    let db = FaultDb::new(Arc::new(MemoryDb::new()));
    let harness = Builder::with_db(db.clone()).licensed().build();
    let (id, token) = create(&harness, "").await;
    harness.send(fulfill(&id, "")).await;
    let replaced = Arc::new(std::sync::Mutex::new(None));
    let slot = replaced.clone();
    *db.faults.after_status.lock().unwrap() = Some(Box::new(move |db, key| {
        block_on(async move {
            let mut record = db.status(&key).await.unwrap();
            let mut parsed: Value = serde_json::from_str(&record.message).unwrap();
            parsed["token_hash"] = "another-owners-token-hash".into();
            record.message = parsed.to_string();
            db.put(&key, &record).await.unwrap();
            *slot.lock().unwrap() = Some(record);
        });
    }));
    let response = harness
        .send(req("GET", &format!("/request/{id}/secret")).header(TOKEN, &token))
        .await;
    assert_eq!(response.status, 404);
    assert!(!response.text().contains("BEGIN PGP"));
    let expected = replaced.lock().unwrap().clone().unwrap();
    assert_eq!(
        db.inner.status(&format!("request/{id}")).await.unwrap(),
        expected,
        "the replacement must survive"
    );
}

fn create_req() -> Req {
    req("POST", "/request").json(&json!({"public_key": PUBLIC_KEY, "expiration": 3600}))
}

#[tokio::test]
async fn storage_failures_answer_generically_and_keep_the_request() {
    let logs = captured_logs();
    let memory = Arc::new(MemoryDb::new());
    let db = FaultDb::new(memory.clone());
    let harness = Builder::with_db(db.clone()).licensed().build();

    *db.faults.put.lock().unwrap() = Some("request/");
    let created = harness.send(create_req()).await;
    assert_eq!(created.status, 500);
    assert_eq!(created.message(), "Failed to store request in database");
    assert!(memory.keys().is_empty());
    *db.faults.put.lock().unwrap() = None;

    let (id, token) = create(&harness, "").await;
    let rotate = || {
        req("PUT", &format!("/request/{id}/key"))
            .header(TOKEN, &token)
            .json(&json!({"public_key": PUBLIC_KEY}))
    };
    *db.faults.update.lock().unwrap() = Some("request/");
    let rotated = harness.send(rotate()).await;
    assert_eq!(rotated.status, 500);
    assert_eq!(rotated.message(), "Failed to update request");
    let answered = harness.send(fulfill(&id, "")).await;
    assert_eq!(answered.status, 500);
    assert_eq!(answered.message(), "Failed to store secret in database");
    *db.faults.update.lock().unwrap() = None;
    assert_eq!(harness.send(fulfill(&id, "")).await.status, 200);

    let fetch = || req("GET", &format!("/request/{id}/secret")).header(TOKEN, &token);
    *db.faults.delete.lock().unwrap() = Some("request/");
    let fetched = harness.send(fetch()).await;
    assert_eq!(fetched.status, 500);
    assert_eq!(fetched.message(), "Failed to process secret");
    assert!(
        !fetched.text().contains("BEGIN PGP"),
        "content without a claim"
    );
    let revoked = harness
        .send(req("DELETE", &format!("/request/{id}")).header(TOKEN, &token))
        .await;
    assert_eq!(revoked.status, 500);
    assert_eq!(revoked.message(), "Failed to revoke request");
    *db.faults.delete.lock().unwrap() = None;

    // Every failure left the answer retrievable exactly once.
    assert_eq!(harness.send(fetch()).await.status, 200);
    assert_eq!(harness.send(fetch()).await.status, 404);
    assert!(!logs.text().contains(&id), "raw request ID logged");
}

#[tokio::test]
async fn unreadable_or_stalled_bodies_are_refused() {
    let harness = Builder::new()
        .licensed()
        .settings(|s| s.request_timeout = Some(Duration::from_millis(50)))
        .build();
    let (id, token) = create(&harness, "").await;
    let broken = || {
        Body::from_stream(stream::iter([Err::<bytes::Bytes, _>(
            std::io::Error::other("connection reset"),
        )]))
    };
    let stalled = || Body::from_stream(stream::pending::<Result<bytes::Bytes, std::io::Error>>());
    // Creation and rotation fold every body failure into one 400, as Go does.
    let paths = [
        ("POST", "/request".to_owned(), 400),
        ("POST", format!("/request/{id}/secret"), 408),
        ("PUT", format!("/request/{id}/key"), 400),
    ];
    for (method, path, stalled_status) in &paths {
        let request = |body| {
            req(method, path)
                .header(TOKEN, &token)
                .header("content-type", "application/json")
                .body(body)
        };
        let response = harness.send(request(broken())).await;
        assert_eq!(response.status, 400, "{method} {path}");
        let response = harness.send(request(stalled())).await;
        assert_eq!(response.status, *stalled_status, "{method} {path}");
        let response = harness.send(request(Body::from("{not json"))).await;
        assert_eq!(response.status, 400, "{method} {path}");
    }
    assert_eq!(
        harness.get(&format!("/request/{id}")).await.json()["state"],
        "pending"
    );
}

#[tokio::test]
async fn a_file_answer_over_the_cap_is_too_large() {
    let harness = Builder::new()
        .licensed()
        .settings(|s| s.max_file_size = 1024)
        .build();
    let (id, _) = create(&harness, "").await;
    let cap = yopass_server::armor::max_armored_file_length(1024) as usize;
    let response = harness
        .send(req("POST", &format!("/request/{id}/secret")).json(&json!({
            "message": "a".repeat(cap + 1), "kind": "file",
        })))
        .await;
    assert_eq!(response.status, 413);
    assert_eq!(response.message(), "File too large");
}

#[tokio::test]
async fn rotating_an_unknown_request_is_not_found() {
    let harness = licensed();
    let response = harness
        .send(
            req("PUT", "/request/AbCdEf0123456789GhIjKl/key")
                .header(TOKEN, "anything")
                .json(&json!({"public_key": PUBLIC_KEY})),
        )
        .await;
    assert_eq!(response.status, 404);
    assert_eq!(response.message(), "Secret request not found");
}

/// Notes are counted in characters, trimmed, and cleared once answered.
#[tokio::test]
async fn notes_are_counted_in_characters_and_cleared_on_answer() {
    let harness = Builder::new()
        .licensed()
        .settings(|s| s.max_request_note_length = 5)
        .build();
    let note = |note: &str| {
        req("POST", "/request")
            .json(&json!({"public_key": PUBLIC_KEY, "expiration": 3600, "note": note}))
    };
    let (id, _) = {
        let created = harness.send(note("åäöüé")).await;
        assert_eq!(
            created.status, 200,
            "five characters fit, whatever their bytes"
        );
        let body = created.json();
        (body["id"].as_str().unwrap().to_owned(), ())
    };
    assert_eq!(
        harness.get(&format!("/request/{id}")).await.json()["note"],
        "åäöüé"
    );
    assert_eq!(harness.send(note("123456")).await.status, 400);

    let blank = harness.send(note("  \n  ")).await.json();
    let view = harness
        .get(&format!("/request/{}", blank["id"].as_str().unwrap()))
        .await
        .json();
    assert!(view.get("note").is_none_or(|n| n == ""), "{view}");

    assert_eq!(harness.send(fulfill(&id, "")).await.status, 200);
    let answered = harness.get(&format!("/request/{id}")).await.json();
    assert!(
        answered.get("note").is_none_or(|n| n == ""),
        "note exposed after answer"
    );
}

/// An ASCII-only JSON encoder sends an astral character as a 12 byte escape;
/// a note at the cap written that way must still fit the body limit.
#[tokio::test]
async fn an_escaped_note_at_the_cap_fits_the_body_limit() {
    use yopass_server::handlers::request::MAX_NOTE_LENGTH_CAP;
    let harness = Builder::new()
        .licensed()
        .settings(|s| s.max_request_note_length = MAX_NOTE_LENGTH_CAP)
        .build();
    let key = serde_json::to_string(PUBLIC_KEY).unwrap();
    let raw = format!(
        r#"{{"public_key":{key},"expiration":3600,"note":"{}"}}"#,
        r"\ud83d\ude00".repeat(MAX_NOTE_LENGTH_CAP)
    );
    let response = harness
        .send(
            req("POST", "/request")
                .header("content-type", "application/json")
                .body(axum::body::Body::from(raw)),
        )
        .await;
    assert_eq!(response.status, 200, "{}", response.text());
}

/// The request file cap holds even when uploads are otherwise unlimited.
#[tokio::test]
async fn the_request_file_cap_applies_when_uploads_are_unlimited() {
    let harness = Builder::new()
        .licensed()
        .settings(|s| s.max_file_size = 0)
        .build();
    let (id, _) = create(&harness, "").await;
    let cap = yopass_server::armor::max_armored_file_length(512 * 1024) as usize;
    let response = harness
        .send(req("POST", &format!("/request/{id}/secret")).json(&json!({
            "message": "a".repeat(cap + 1), "kind": "file",
        })))
        .await;
    assert_eq!(response.status, 413, "{}", response.text());
}
