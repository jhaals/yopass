//! Path keys are bearer capabilities and query strings may hold OIDC codes, so
//! access logs carry route templates and fingerprints only.

mod common;

use common::*;
use serde_json::Value;
use yopass_server::db::Secret;
use yopass_server::util::redact_secret_id;

fn request_logs(secret_id: &str) -> Vec<Value> {
    captured_logs()
        .text()
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|entry| {
            entry["fields"]["message"] == "Request handled"
                && entry["fields"]["secret_id"] == secret_id
        })
        .collect()
}

#[tokio::test]
async fn access_logs_redact_capabilities() {
    let logs = captured_logs();
    let harness = Builder::new().licensed().build();
    let db = &harness.app.db;
    for (index, (method, path, template)) in [
        ("GET", "/secret/{id}", "/secret/{key}"),
        ("DELETE", "/secret/{id}", "/secret/{key}"),
        ("GET", "/secret/{id}/status", "/secret/{key}/status"),
        ("GET", "/secret/{id}/receipt", "/secret/{key}/receipt"),
        ("GET", "/file/{id}", "/file/{key}"),
        ("DELETE", "/file/{id}", "/file/{key}"),
        ("OPTIONS", "/file/{id}", "/file/{key}"),
        ("GET", "/file/{id}/status", "/file/{key}/status"),
        ("GET", "/file/{id}/receipt", "/file/{key}/receipt"),
        ("GET", "/request/{id}", "/request/{key}"),
        ("DELETE", "/request/{id}", "/request/{key}"),
        ("GET", "/request/{id}/secret", "/request/{key}/secret"),
        ("POST", "/request/{id}/secret", "/request/{key}/secret"),
        ("PUT", "/request/{id}/key", "/request/{key}/key"),
    ]
    .into_iter()
    .enumerate()
    {
        let id = format!("Unique{index:04}AccessLogKeyA")
            .chars()
            .take(22)
            .collect::<String>();
        assert_eq!(id.len(), 22);
        db.put(
            &id,
            &Secret {
                message: "encrypted-content".into(),
                expiration: 60,
                ..Secret::default()
            },
        )
        .await
        .unwrap();
        db.put(
            &format!("stream:{id}"),
            &Secret {
                require_auth: true,
                expiration: 60,
                ..Secret::default()
            },
        )
        .await
        .unwrap();
        let url = format!(
            "{}?code=private-code&token=private-token",
            path.replace("{id}", &id)
        );
        let response = harness
            .send(
                req(method, &url)
                    .header("authorization", "Bearer private-bearer")
                    .header("x-yopass-request-token", "private-management-token")
                    .body("{}"),
            )
            .await;
        let entries = request_logs(&redact_secret_id(&id));
        assert_eq!(entries.len(), 1, "{method} {path}");
        let fields = &entries[0]["fields"];
        assert_eq!(fields["uri"], template, "{method} {path}");
        assert_eq!(
            fields["responseStatus"],
            response.status.as_u16(),
            "{method} {path}"
        );
        assert_eq!(fields["method"], method);
        let text = logs.text();
        assert!(!text.contains(&id), "{method} {path}: raw key logged");
    }
    let text = logs.text();
    for leak in [
        "private-code",
        "private-token",
        "private-bearer",
        "private-management-token",
        "encrypted-content",
    ] {
        assert!(!text.contains(leak), "{leak} logged");
    }
}

#[tokio::test]
async fn unmatched_paths_are_not_logged_verbatim() {
    let logs = captured_logs();
    let harness = harness();
    harness
        .get("/unknown/private-static-token?code=private-static-code")
        .await;
    harness.get("/secret/not-a-valid-private-key").await;
    let text = logs.text();
    assert!(!text.contains("private-static-token"));
    assert!(!text.contains("private-static-code"));
    assert!(!text.contains("not-a-valid-private-key"));
}

#[tokio::test]
async fn backend_errors_do_not_leak_keys_into_logs() {
    let logs = captured_logs();
    let db = FaultDb::new(std::sync::Arc::new(
        yopass_server::db::memory::MemoryDb::new(),
    ));
    let harness = Builder::with_db(db.clone()).licensed().build();
    const KEY: &str = "LeakCheckKey0123456789";
    db.inner.put(KEY, &secret("x", true)).await.unwrap();
    *db.faults.claim.lock().unwrap() = Some(ClaimFault::Backend);
    harness.get(&format!("/secret/{KEY}")).await;
    *db.faults.claim.lock().unwrap() = None;
    *db.faults.update.lock().unwrap() = Some("receipt/");
    harness.get(&format!("/secret/{KEY}")).await;
    *db.faults.update.lock().unwrap() = None;
    *db.faults.status.lock().unwrap() = Some("");
    harness.get(&format!("/secret/{KEY}/status")).await;
    harness.get(&format!("/request/{KEY}")).await;
    harness.get(&format!("/secret/{KEY}/receipt")).await;
    assert!(!logs.text().contains(KEY), "raw key in backend error logs");
}
