//! Delivers secret lifecycle events to one operator-configured URL. Deliveries
//! happen on a background task so request handlers never block on the receiver.
//!
//! Expired events come from an in-memory watcher, per instance and not persisted.

use crate::license::License;
use crate::util::{generate_id, redact_secret_id};
use hmac::{Hmac, KeyInit, Mac};
use prometheus::{CounterVec, Opts, Registry};
use serde::Serialize;
use sha2::Sha256;
use std::collections::{BTreeSet, HashMap};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use time::OffsetDateTime;
use tokio::sync::mpsc;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

pub const KIND_SECRET: &str = "secret";
pub const KIND_FILE: &str = "file";
pub const KIND_REQUEST: &str = "request";

const SIGNATURE_HEADER: &str = "X-Yopass-Signature";

/// The JSON payload. The ID is the fingerprint used in audit logs: the raw
/// retrieval key is never sent, so a compromised receiver cannot fetch secrets.
#[derive(Clone, Debug, Serialize)]
pub struct WebhookEvent {
    pub event: &'static str,
    pub delivery_id: String,
    #[serde(with = "time::serde::rfc3339")]
    pub timestamp: OffsetDateTime,
    pub secret_id: String,
    pub kind: &'static str,
    pub one_time: bool,
    #[serde(skip_serializing_if = "is_zero")]
    pub expiration_seconds: i32,
}

fn is_zero(value: &i32) -> bool {
    *value == 0
}

#[derive(Clone)]
pub struct WebhookConfig {
    /// Expiry events stop when this lapses, as handler events do.
    pub license: Option<License>,
    pub url: String,
    pub secret: String,
    pub max_attempts: u32,
    pub timeout: Duration,
    pub backoff: Duration,
    pub queue_size: usize,
    pub expiry_interval: Duration,
    pub max_expiries: usize,
}

impl WebhookConfig {
    pub fn new(url: impl Into<String>, secret: impl Into<String>) -> Self {
        Self {
            license: None,
            url: url.into(),
            secret: secret.into(),
            max_attempts: 3,
            timeout: Duration::from_secs(10),
            backoff: Duration::from_secs(2),
            queue_size: 256,
            expiry_interval: Duration::from_secs(5),
            max_expiries: 100_000,
        }
    }
}

#[derive(Clone)]
struct Tracked {
    kind: &'static str,
    one_time: bool,
    lifetime: i32,
    deadline: Instant,
    expired_event: &'static str,
}

#[derive(Default)]
struct Expiries {
    by_id: HashMap<String, Tracked>,
    by_deadline: BTreeSet<(Instant, String)>,
}

struct Shared {
    config: WebhookConfig,
    client: reqwest::Client,
    queue: mpsc::Sender<WebhookEvent>,
    expiries: Mutex<Expiries>,
    deliveries: Option<CounterVec>,
}

#[derive(Clone)]
pub struct WebhookNotifier {
    shared: Arc<Shared>,
    stop: CancellationToken,
    tasks: TaskTracker,
}

/// Compatible with the Go server: HMAC-SHA256 of the raw body, as hex.
pub fn sign_body(secret: &str, body: &[u8]) -> String {
    let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(secret.as_bytes())
        .expect("HMAC accepts any key length");
    mac.update(body);
    hex::encode(mac.finalize().into_bytes())
}

impl WebhookNotifier {
    /// Validates the configuration and starts the background tasks. Errors never
    /// quote the URL: its user info, path and query may carry credentials.
    pub fn start(config: WebhookConfig, registry: Option<&Registry>) -> Result<Self, String> {
        let url = url::Url::parse(&config.url)
            .ok()
            .filter(|u| matches!(u.scheme(), "http" | "https") && u.has_host());
        if url.is_none() {
            return Err("webhook URL must be an absolute http(s) URL".into());
        }
        let client = reqwest::Client::builder()
            .timeout(config.timeout)
            // A redirect would resend the signed body somewhere unconfigured.
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| "failed to build webhook client".to_owned())?;
        let deliveries = registry.map(|registry| {
            let counter = CounterVec::new(
                Opts::new(
                    "yopass_webhook_deliveries_total",
                    "Webhook delivery attempts by event name and outcome (delivered, failed, dropped).",
                ),
                &["event", "outcome"],
            )
            .expect("static metric definition");
            let _ = registry.register(Box::new(counter.clone()));
            counter
        });
        let (sender, receiver) = mpsc::channel(config.queue_size);
        let notifier = Self {
            shared: Arc::new(Shared {
                config,
                client,
                queue: sender,
                expiries: Mutex::default(),
                deliveries,
            }),
            stop: CancellationToken::new(),
            tasks: TaskTracker::new(),
        };
        notifier
            .tasks
            .spawn(notifier.clone().delivery_worker(receiver));
        notifier.tasks.spawn(notifier.clone().expiry_watcher());
        notifier.tasks.close();
        Ok(notifier)
    }

    /// Discards queued events; an in-flight delivery finishes its current attempt.
    pub async fn stop(&self) {
        self.stop.cancel();
        self.tasks.wait().await;
    }

    fn count(&self, event: &str, outcome: &str) {
        if let Some(deliveries) = &self.shared.deliveries {
            deliveries.with_label_values(&[event, outcome]).inc();
        }
    }

    fn enqueue(
        &self,
        event: &'static str,
        id: &str,
        kind: &'static str,
        one_time: bool,
        expiration: i32,
    ) {
        let event = WebhookEvent {
            event,
            delivery_id: String::new(),
            timestamp: OffsetDateTime::now_utc(),
            secret_id: redact_secret_id(id),
            kind,
            one_time,
            expiration_seconds: expiration,
        };
        let Err(error) = self.shared.queue.try_send(event) else {
            return;
        };
        // Closed means the delivery worker is gone, normally after stop(), not a flood.
        let (message, event) = match error {
            mpsc::error::TrySendError::Full(event) => {
                ("webhook: queue full, dropping event", event)
            }
            mpsc::error::TrySendError::Closed(event) => {
                ("webhook: notifier stopped, dropping event", event)
            }
        };
        // A flood of events can push out the notice of a read, so that one stands out.
        if event.event == "secret.viewed" {
            tracing::error!(
                event = event.event,
                secret_id = event.secret_id,
                "{message}"
            );
        } else {
            tracing::warn!(
                event = event.event,
                secret_id = event.secret_id,
                "{message}"
            );
        }
        self.count(event.event, "dropped");
    }

    fn track(
        &self,
        id: &str,
        kind: &'static str,
        one_time: bool,
        lifetime: i32,
        expired_event: &'static str,
    ) {
        let deadline = Instant::now() + Duration::from_secs(lifetime.max(0) as u64);
        let mut expiries = self
            .shared
            .expiries
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if let Some(old) = expiries.by_id.get(id).map(|t| t.deadline) {
            expiries.by_deadline.remove(&(old, id.to_owned()));
        } else if expiries.by_id.len() >= self.shared.config.max_expiries {
            tracing::warn!(
                max = self.shared.config.max_expiries,
                "webhook: expiry tracker full, dropping entry"
            );
            return;
        }
        expiries.by_deadline.insert((deadline, id.to_owned()));
        expiries.by_id.insert(
            id.to_owned(),
            Tracked {
                kind,
                one_time,
                lifetime,
                deadline,
                expired_event,
            },
        );
    }

    fn cancel_expiry(&self, id: &str) {
        let mut expiries = self
            .shared
            .expiries
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if let Some(tracked) = expiries.by_id.remove(id) {
            expiries
                .by_deadline
                .remove(&(tracked.deadline, id.to_owned()));
        }
    }

    fn take_expired(&self, now: Instant) -> Vec<(String, Tracked)> {
        let mut expiries = self
            .shared
            .expiries
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let mut due = Vec::new();
        while let Some((deadline, id)) = expiries.by_deadline.first().cloned() {
            if deadline > now {
                break;
            }
            expiries.by_deadline.pop_first();
            if let Some(tracked) = expiries.by_id.remove(&id) {
                due.push((id, tracked));
            }
        }
        due
    }

    pub fn secret_created(&self, id: &str, kind: &'static str, one_time: bool, expiration: i32) {
        self.track(id, kind, one_time, expiration, "secret.expired");
        self.enqueue("secret.created", id, kind, one_time, expiration);
    }

    /// One-time secrets are deleted on view, so their expiry tracking ends.
    pub fn secret_viewed(&self, id: &str, kind: &'static str, one_time: bool) {
        if one_time {
            self.cancel_expiry(id);
        }
        self.enqueue("secret.viewed", id, kind, one_time, 0);
    }

    pub fn secret_deleted(&self, id: &str) {
        self.cancel_expiry(id);
    }

    pub fn request_created(&self, id: &str, expiration: i32) {
        self.track(id, KIND_REQUEST, false, expiration, "request.expired");
        self.enqueue("request.created", id, KIND_REQUEST, false, expiration);
    }

    /// The request stays tracked: one never collected still expires.
    pub fn request_fulfilled(&self, id: &str) {
        self.enqueue("request.fulfilled", id, KIND_REQUEST, false, 0);
    }

    pub fn request_closed(&self, id: &str) {
        self.cancel_expiry(id);
    }

    async fn delivery_worker(self, mut receiver: mpsc::Receiver<WebhookEvent>) {
        loop {
            tokio::select! {
                _ = self.stop.cancelled() => return,
                event = receiver.recv() => match event {
                    Some(event) => self.deliver(event).await,
                    None => return,
                },
            }
        }
    }

    async fn expiry_watcher(self) {
        let mut ticker = tokio::time::interval(self.shared.config.expiry_interval);
        loop {
            tokio::select! {
                _ = self.stop.cancelled() => return,
                now = ticker.tick() => {
                    let due = self.take_expired(now);
                    if self.shared.config.license.as_ref().is_some_and(|l| !l.currently_valid()) {
                        continue;
                    }
                    for (id, tracked) in due {
                        self.enqueue(tracked.expired_event, &id, tracked.kind, tracked.one_time, tracked.lifetime);
                    }
                }
            }
        }
    }

    /// The deduplication ID sits in the signed body and is reused across retries.
    async fn deliver(&self, mut event: WebhookEvent) {
        event.delivery_id = generate_id();
        let Ok(body) = serde_json::to_vec(&event) else {
            tracing::error!("webhook: failed to encode event");
            self.count(event.event, "failed");
            return;
        };
        let mut backoff = self.shared.config.backoff;
        for attempt in 1..=self.shared.config.max_attempts {
            if self.attempt(&event, &body).await {
                self.count(event.event, "delivered");
                return;
            }
            if attempt < self.shared.config.max_attempts {
                tokio::select! {
                    _ = tokio::time::sleep(backoff) => backoff *= 2,
                    _ = self.stop.cancelled() => {
                        self.count(event.event, "failed");
                        return;
                    }
                }
            }
        }
        tracing::error!(
            event = event.event,
            secret_id = event.secret_id,
            attempts = self.shared.config.max_attempts,
            "webhook: delivery failed permanently"
        );
        self.count(event.event, "failed");
    }

    async fn attempt(&self, event: &WebhookEvent, body: &[u8]) -> bool {
        let config = &self.shared.config;
        let mut request = self
            .shared
            .client
            .post(&config.url)
            .header("Content-Type", "application/json")
            .header("User-Agent", "yopass-webhook")
            .header("X-Yopass-Event", event.event)
            .header("X-Yopass-Delivery", &event.delivery_id)
            .body(body.to_vec());
        if !config.secret.is_empty() {
            request = request.header(
                SIGNATURE_HEADER,
                format!("sha256={}", sign_body(&config.secret, body)),
            );
        }
        match request.send().await {
            Ok(response) if response.status().is_success() => true,
            Ok(response) => {
                tracing::warn!(
                    event = event.event,
                    status = response.status().as_u16(),
                    "webhook: receiver returned non-2xx status"
                );
                false
            }
            Err(error) => {
                // The error display quotes the URL, which may carry credentials.
                let error = error.without_url();
                tracing::warn!(event = event.event, error = %error, "webhook: delivery attempt failed");
                false
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use tracing_subscriber::layer::SubscriberExt;

    /// The level and message of every event logged.
    #[derive(Clone, Default)]
    struct Logged(Arc<Mutex<Vec<(tracing::Level, String)>>>);

    impl<S: tracing::Subscriber> tracing_subscriber::Layer<S> for Logged {
        fn on_event(
            &self,
            event: &tracing::Event<'_>,
            _: tracing_subscriber::layer::Context<'_, S>,
        ) {
            struct Message(String);
            impl tracing::field::Visit for Message {
                fn record_debug(
                    &mut self,
                    field: &tracing::field::Field,
                    value: &dyn std::fmt::Debug,
                ) {
                    if field.name() == "message" {
                        self.0 = format!("{value:?}");
                    }
                }
            }
            let mut message = Message(String::new());
            event.record(&mut message);
            let level = *event.metadata().level();
            self.0.lock().unwrap().push((level, message.0));
        }
    }

    #[test]
    fn dropped_views_stand_out_and_shutdown_is_not_reported_as_a_full_queue() {
        let (queue, receiver) = mpsc::channel(1);
        let notifier = WebhookNotifier {
            shared: Arc::new(Shared {
                config: WebhookConfig::new("http://receiver.invalid", ""),
                client: reqwest::Client::new(),
                queue,
                expiries: Mutex::default(),
                deliveries: None,
            }),
            stop: CancellationToken::new(),
            tasks: TaskTracker::new(),
        };
        let logged = Logged::default();
        let subscriber = tracing_subscriber::registry().with(logged.clone());
        tracing::subscriber::with_default(subscriber, || {
            notifier.secret_created("a", KIND_SECRET, true, 60); // fills the queue
            notifier.secret_viewed("a", KIND_SECRET, true);
            notifier.secret_created("b", KIND_SECRET, true, 60);
            drop(receiver);
            notifier.secret_viewed("b", KIND_SECRET, true);
            notifier.secret_created("c", KIND_SECRET, true, 60);
        });
        let full = "webhook: queue full, dropping event".to_owned();
        let stopped = "webhook: notifier stopped, dropping event".to_owned();
        assert_eq!(
            *logged.0.lock().unwrap(),
            [
                (tracing::Level::ERROR, full.clone()),
                (tracing::Level::WARN, full),
                (tracing::Level::ERROR, stopped.clone()),
                (tracing::Level::WARN, stopped),
            ]
        );
    }
}
