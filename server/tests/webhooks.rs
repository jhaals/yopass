//! Webhook delivery, signing, retries and expiry tracking.

mod common;

use axum::Router;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::routing::post;
use bytes::Bytes;
use common::*;
use serde_json::{Value, json};
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::net::TcpListener;
use yopass_server::util::redact_secret_id;
use yopass_server::webhook::{WebhookConfig, WebhookNotifier, sign_body};

#[derive(Clone, Default)]
struct Receiver {
    deliveries: Arc<Mutex<Vec<(HeaderMap, Bytes)>>>,
    status: Arc<AtomicU16>,
}

async fn receive(State(receiver): State<Receiver>, headers: HeaderMap, body: Bytes) -> StatusCode {
    receiver.deliveries.lock().unwrap().push((headers, body));
    StatusCode::from_u16(receiver.status.load(Ordering::SeqCst)).unwrap()
}

impl Receiver {
    async fn start() -> (Self, String) {
        let receiver = Self::default();
        receiver.status.store(200, Ordering::SeqCst);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/hook", listener.local_addr().unwrap());
        let router = Router::new()
            .route("/hook", post(receive))
            .with_state(receiver.clone());
        tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        (receiver, url)
    }

    fn events(&self) -> Vec<Value> {
        self.deliveries
            .lock()
            .unwrap()
            .iter()
            .map(|(_, body)| serde_json::from_slice(body).unwrap())
            .collect()
    }

    fn event_names(&self) -> Vec<String> {
        self.events()
            .iter()
            .map(|e| e["event"].as_str().unwrap().to_owned())
            .collect()
    }

    async fn wait_for(&self, count: usize) {
        for _ in 0..500 {
            if self.deliveries.lock().unwrap().len() >= count {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("expected {count} deliveries, got {:?}", self.event_names());
    }
}

fn config(url: &str) -> WebhookConfig {
    WebhookConfig {
        backoff: Duration::from_millis(1),
        expiry_interval: Duration::from_millis(50),
        ..WebhookConfig::new(url, "key")
    }
}

async fn with_webhooks() -> (Harness, Receiver) {
    let (receiver, url) = Receiver::start().await;
    let notifier = WebhookNotifier::start(config(&url), None).unwrap();
    let mut builder = Builder::new().licensed();
    builder.webhooks = Some(notifier);
    (builder.build(), receiver)
}

#[tokio::test]
async fn invalid_urls_are_refused_without_quoting_them() {
    for url in [
        "",
        "not a url",
        "ftp://example.com",
        "/relative",
        "https://user:hunter2@",
        "http://",
    ] {
        let error = WebhookNotifier::start(WebhookConfig::new(url, ""), None)
            .err()
            .unwrap_or_else(|| panic!("{url} accepted"));
        assert!(!error.contains("hunter2"), "{error}");
    }
}

#[tokio::test]
async fn lifecycle_events_carry_only_fingerprints() {
    let (harness, receiver) = with_webhooks().await;
    let key = harness.create_secret(false).await;
    harness.get(&format!("/secret/{key}")).await;
    receiver.wait_for(2).await;
    let events = receiver.events();
    assert_eq!(events[0]["event"], "secret.created");
    assert_eq!(events[0]["kind"], "secret");
    assert_eq!(events[0]["expiration_seconds"], 3600);
    assert_eq!(events[0]["secret_id"], redact_secret_id(&key));
    assert_eq!(events[1]["event"], "secret.viewed");
    assert!(events[1].get("expiration_seconds").is_none());
    let raw = format!("{events:?}");
    assert!(!raw.contains(&key), "raw key sent to webhook receiver");
    assert!(!raw.contains("BEGIN PGP"));
}

#[tokio::test]
async fn deliveries_are_signed_and_retries_keep_the_same_payload() {
    let (receiver, url) = Receiver::start().await;
    receiver.status.store(500, Ordering::SeqCst);
    let notifier = WebhookNotifier::start(config(&url), None).unwrap();
    let mut builder = Builder::new().licensed();
    builder.webhooks = Some(notifier);
    let harness = builder.build();
    harness.create_secret(false).await;
    receiver.wait_for(3).await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    let deliveries = receiver.deliveries.lock().unwrap().clone();
    assert_eq!(deliveries.len(), 3, "gives up after max attempts");
    let (first_headers, first_body) = &deliveries[0];
    let event: Value = serde_json::from_slice(first_body).unwrap();
    assert!(!event["delivery_id"].as_str().unwrap().is_empty());
    for (headers, body) in &deliveries {
        assert_eq!(body, first_body, "a retry changed the signed payload");
        assert_eq!(
            headers["x-yopass-delivery"],
            event["delivery_id"].as_str().unwrap()
        );
        assert_eq!(headers["x-yopass-event"], "secret.created");
        assert_eq!(headers["user-agent"], "yopass-webhook");
        assert_eq!(headers["content-type"], "application/json");
        assert_eq!(
            headers["x-yopass-signature"],
            format!("sha256={}", sign_body("key", body)).as_str()
        );
        assert_eq!(
            headers["x-yopass-signature"],
            first_headers["x-yopass-signature"]
        );
    }
}

#[test]
fn signature_is_hmac_sha256_of_the_body() {
    // Computed independently: printf body | openssl dgst -sha256 -hmac key
    assert_eq!(
        sign_body("key", b"body"),
        "515aae133b435d4000956731f68ae5cf5eb85d4f0dc6a546d2bfcd3595ec1ae1"
    );
    assert_ne!(sign_body("key", b"body"), sign_body("other", b"body"));
}

#[tokio::test]
async fn unsigned_when_no_secret_is_configured() {
    let (receiver, url) = Receiver::start().await;
    let notifier = WebhookNotifier::start(
        WebhookConfig {
            secret: String::new(),
            ..config(&url)
        },
        None,
    )
    .unwrap();
    notifier.secret_created("id", "secret", false, 60);
    receiver.wait_for(1).await;
    assert!(
        receiver.deliveries.lock().unwrap()[0]
            .0
            .get("x-yopass-signature")
            .is_none()
    );
    notifier.stop().await;
}

#[tokio::test]
async fn redirects_are_not_followed() {
    // The signed body must not be resent somewhere unconfigured.
    let (target, target_url) = Receiver::start().await;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/hook", listener.local_addr().unwrap());
    let router = Router::new().route(
        "/hook",
        post(move || {
            let location = target_url.clone();
            async move { (StatusCode::TEMPORARY_REDIRECT, [("location", location)]) }
        }),
    );
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let notifier = WebhookNotifier::start(config(&url), None).unwrap();
    notifier.secret_created("id", "secret", false, 60);
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(target.deliveries.lock().unwrap().is_empty());
    notifier.stop().await;
}

#[tokio::test]
async fn failed_attempts_never_log_the_url() {
    let logs = captured_logs();
    let url = "http://webhook-user:hunter2-pass@127.0.0.1:1/hunter2-path?token=hunter2-query";
    let notifier = WebhookNotifier::start(config(url), None).unwrap();
    notifier.secret_created("id", "secret", false, 60);
    tokio::time::sleep(Duration::from_millis(100)).await;
    notifier.stop().await;
    assert!(
        !logs.text().contains("hunter2"),
        "webhook credentials logged"
    );
    assert!(
        logs.text().contains("webhook: delivery"),
        "the failure should still be visible"
    );
}

#[tokio::test]
async fn expiry_events_and_cancellation() {
    let (receiver, url) = Receiver::start().await;
    let notifier = WebhookNotifier::start(config(&url), None).unwrap();
    notifier.secret_created("expires", "file", true, 0);
    notifier.secret_created("viewed-once", "secret", true, 0);
    notifier.secret_viewed("viewed-once", "secret", true);
    notifier.secret_created("deleted", "secret", false, 0);
    notifier.secret_deleted("deleted");
    notifier.secret_created("multi-view", "secret", false, 0);
    notifier.secret_viewed("multi-view", "secret", false);
    notifier.request_created("request", 0);
    notifier.request_fulfilled("request");
    notifier.request_created("revoked", 0);
    notifier.request_closed("revoked");
    receiver.wait_for(12).await;
    tokio::time::sleep(Duration::from_millis(150)).await;
    notifier.stop().await;

    let events = receiver.events();
    let expired = |event: &str, id: &str| {
        events
            .iter()
            .filter(|e| e["event"] == event && e["secret_id"] == redact_secret_id(id))
            .count()
    };
    assert_eq!(expired("secret.expired", "expires"), 1);
    assert_eq!(
        expired("secret.expired", "viewed-once"),
        0,
        "consumed secrets do not expire"
    );
    assert_eq!(expired("secret.expired", "deleted"), 0);
    assert_eq!(
        expired("secret.expired", "multi-view"),
        1,
        "multi-view secrets still expire"
    );
    assert_eq!(
        expired("request.expired", "request"),
        1,
        "uncollected requests still expire"
    );
    assert_eq!(expired("request.expired", "revoked"), 0);
}

#[tokio::test]
async fn request_events() {
    let (harness, receiver) = with_webhooks().await;
    let response = harness
        .send(req("POST", "/request").json(&json!({"public_key": PUBLIC_KEY, "expiration": 3600})))
        .await;
    let id = response.json()["id"].as_str().unwrap().to_owned();
    harness
        .send(req("POST", &format!("/request/{id}/secret")).json(&json!({"message": PGP_MESSAGE})))
        .await;
    receiver.wait_for(2).await;
    assert_eq!(
        receiver.event_names(),
        ["request.created", "request.fulfilled"]
    );
    assert_eq!(receiver.events()[0]["kind"], "request");
}

#[tokio::test]
async fn file_events() {
    let (harness, receiver) = with_webhooks().await;
    let key = harness.upload(true).await;
    harness.get(&format!("/file/{key}")).await;
    receiver.wait_for(2).await;
    assert_eq!(receiver.event_names(), ["secret.created", "secret.viewed"]);
    assert_eq!(receiver.events()[1]["kind"], "file");
}

#[tokio::test]
async fn bounded_queue_and_tracker_drop_instead_of_blocking() {
    let (receiver, url) = Receiver::start().await;
    let notifier = WebhookNotifier::start(
        WebhookConfig {
            queue_size: 2,
            max_expiries: 1,
            ..config(&url)
        },
        None,
    )
    .unwrap();
    let started = std::time::Instant::now();
    for index in 0..10_000 {
        notifier.secret_created(&format!("id-{index}"), "secret", false, 3600);
    }
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "enqueueing must not wait on the receiver"
    );
    notifier.stop().await;
    assert!(receiver.deliveries.lock().unwrap().len() < 100);
}

#[tokio::test]
async fn delivery_metrics_are_recorded() {
    let (receiver, url) = Receiver::start().await;
    let registry = prometheus::Registry::new();
    let notifier = WebhookNotifier::start(config(&url), Some(&registry)).unwrap();
    notifier.secret_created("id", "secret", false, 3600);
    receiver.wait_for(1).await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    notifier.stop().await;
    let families = registry.gather();
    assert!(
        families
            .iter()
            .any(|f| f.name() == "yopass_webhook_deliveries_total")
    );
}

/// A license lapsing mid-run stops the watcher too, not only the request handlers.
#[tokio::test]
async fn no_expiry_events_after_the_license_lapses() {
    let (receiver, url) = Receiver::start().await;
    let notifier = WebhookNotifier::start(
        WebhookConfig {
            license: Some(expired_license()),
            ..config(&url)
        },
        None,
    )
    .unwrap();
    notifier.secret_created("tracked", "secret", false, 0);
    receiver.wait_for(1).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(receiver.event_names(), ["secret.created"]);
    notifier.stop().await;
}

#[tokio::test]
async fn nothing_is_sent_when_the_license_expires() {
    let (receiver, url) = Receiver::start().await;
    let notifier = WebhookNotifier::start(config(&url), None).unwrap();
    let mut builder = Builder::new();
    builder.license = expired_license();
    builder.webhooks = Some(notifier);
    let harness = builder.build();
    harness.create_secret(false).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(receiver.deliveries.lock().unwrap().is_empty());
}

#[tokio::test]
async fn stopping_during_a_retry_backoff_returns_promptly() {
    let (receiver, url) = Receiver::start().await;
    receiver.status.store(500, Ordering::SeqCst);
    let notifier = WebhookNotifier::start(
        WebhookConfig {
            backoff: Duration::from_secs(60),
            max_attempts: 5,
            ..config(&url)
        },
        None,
    )
    .unwrap();
    notifier.secret_created(UUID_KEY, "text", false, 3600);
    receiver.wait_for(1).await;
    tokio::time::timeout(Duration::from_secs(5), notifier.stop())
        .await
        .expect("shutdown must not wait out the backoff");
    assert_eq!(receiver.deliveries.lock().unwrap().len(), 1);
}

/// Tracking the same ID again moves its deadline instead of adding a second
/// expiry, so it expires once, at the later time.
#[tokio::test]
async fn retracking_an_id_replaces_its_deadline() {
    let (receiver, url) = Receiver::start().await;
    let notifier = WebhookNotifier::start(config(&url), None).unwrap();
    notifier.request_created(UUID_KEY, 0);
    notifier.request_created(UUID_KEY, 1);
    receiver.wait_for(2).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        receiver.event_names(),
        ["request.created", "request.created"],
        "the first deadline was replaced"
    );
    receiver.wait_for(3).await;
    assert_eq!(receiver.event_names()[2], "request.expired");
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(receiver.events().len(), 3, "expired exactly once");
    notifier.stop().await;
}

/// Whatever ends a request or secret early also ends its expiry tracking, so a
/// receiver is never told something expired that was collected or revoked.
#[tokio::test]
async fn collected_and_revoked_entries_never_report_an_expiry() {
    let (receiver, url) = Receiver::start().await;
    let mut builder = Builder::new().licensed().settings(|s| {
        s.allow_custom_expiration = true;
        s.min_expiration = 1;
    });
    builder.webhooks = Some(WebhookNotifier::start(config(&url), None).unwrap());
    let harness = builder.build();
    let create =
        || req("POST", "/request").json(&json!({"public_key": PUBLIC_KEY, "expiration": 1}));
    let fetched = harness.send(create()).await.json();
    let (id, token) = (
        fetched["id"].as_str().unwrap().to_owned(),
        fetched["token"].as_str().unwrap().to_owned(),
    );
    harness
        .send(req("POST", &format!("/request/{id}/secret")).json(&json!({"message": PGP_MESSAGE})))
        .await;
    let fetch = harness
        .send(req("GET", &format!("/request/{id}/secret")).header("x-yopass-request-token", &token))
        .await;
    assert_eq!(fetch.status, 200);

    let revoked = harness.send(create()).await.json();
    let response = harness
        .send(
            req(
                "DELETE",
                &format!("/request/{}", revoked["id"].as_str().unwrap()),
            )
            .header("x-yopass-request-token", revoked["token"].as_str().unwrap()),
        )
        .await;
    assert_eq!(response.status, 204);

    let deleted = harness
        .send(req("POST", "/create/secret").json(&json!({"message": PGP_MESSAGE, "expiration": 1})))
        .await
        .message();
    assert_eq!(
        harness.delete(&format!("/secret/{deleted}")).await.status,
        204
    );

    let untouched = harness
        .send(req("POST", "/create/secret").json(&json!({"message": PGP_MESSAGE, "expiration": 1})))
        .await
        .message();
    tokio::time::sleep(Duration::from_millis(2500)).await;
    let expired: Vec<Value> = receiver
        .events()
        .into_iter()
        .filter(|e| e["event"].as_str().unwrap().ends_with(".expired"))
        .collect();
    assert_eq!(expired.len(), 1, "{:?}", receiver.event_names());
    assert_eq!(expired[0]["secret_id"], redact_secret_id(&untouched));
}
