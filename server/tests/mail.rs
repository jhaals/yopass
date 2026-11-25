//! Email notifications: who is mailed, when, and what the mail and the stored
//! record may contain.

mod common;

use common::smtp::{AfterMail, GARBLED, Smtp};
use common::*;
use prometheus::Registry;
use serde_json::json;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tokio::net::TcpListener;
use yopass_server::auth::{CookieCodec, Session, parse_api_tokens};
use yopass_server::db::Database;
use yopass_server::db::memory::MemoryDb;
use yopass_server::mail::{MailConfig, Mailer, SmtpTls};
use yopass_server::util::redact_secret_id;

const ALICE: &str = "alice@example.com";

fn config(port: u16) -> MailConfig {
    MailConfig {
        port: Some(port),
        tls: SmtpTls::None,
        app_name: "Acme Share".into(),
        public_url: "https://share.example.com/".into(),
        backoff: Duration::from_millis(1),
        ..MailConfig::new(
            "127.0.0.1",
            "noreply@example.com",
            CookieCodec::from_key([3; 32]),
        )
    }
}

struct Setup {
    harness: Harness,
    smtp: Smtp,
    db: Arc<MemoryDb>,
    cookie: String,
}

async fn setup_with(mutate: impl FnOnce(&mut MailConfig)) -> Setup {
    let (smtp, port) = Smtp::start().await;
    let mut config = config(port);
    mutate(&mut config);
    let db = Arc::new(MemoryDb::new());
    let mut builder = Builder::with_db(db.clone()).licensed().sessions();
    builder.mail = Some(Mailer::start(config, None).unwrap());
    let harness = builder.build();
    let cookie = harness.session_cookie(ALICE);
    Setup {
        harness,
        smtp,
        db,
        cookie,
    }
}

async fn setup() -> Setup {
    setup_with(|_| {}).await
}

impl Setup {
    async fn create(&self, body: serde_json::Value) -> Resp {
        self.harness
            .send(
                req("POST", "/create/secret")
                    .header("cookie", &self.cookie)
                    .json(&body),
            )
            .await
    }

    async fn create_request(&self, notify: bool) -> Resp {
        self.harness
            .send(
                req("POST", "/request").header("cookie", &self.cookie).json(
                    &json!({ "public_key": PUBLIC_KEY, "expiration": 3600, "notify": notify }),
                ),
            )
            .await
    }

    async fn fulfill(&self, id: &str) -> Resp {
        self.harness
            .send(
                req("POST", &format!("/request/{id}/secret"))
                    .json(&json!({ "message": PGP_MESSAGE })),
            )
            .await
    }

    async fn stored(&self, key: &str) -> String {
        self.db.status(key).await.unwrap().message
    }
}

fn notifying_secret() -> serde_json::Value {
    json!({
        "message": PGP_MESSAGE, "expiration": 3600, "one_time": false,
        "notify": true, "label": "Prod DB password",
    })
}

#[tokio::test]
async fn the_creator_is_mailed_once_when_their_secret_is_first_viewed() {
    let s = setup().await;
    let created = s.create(notifying_secret()).await;
    assert_eq!(created.status, 200, "{}", created.text());
    let key = created.message();
    // The notification rides on a read receipt, asked for or not.
    assert!(created.json()["receipt_token"].is_string());
    s.smtp.expect_none_beyond(0).await;

    assert_eq!(s.harness.get(&format!("/secret/{key}")).await.status, 200);
    s.smtp.wait_for(1).await;
    assert_eq!(s.harness.get(&format!("/secret/{key}")).await.status, 200);
    s.smtp.expect_none_beyond(1).await;

    let mails = s.smtp.mails.lock().unwrap();
    let mail = &mails[0];
    assert_eq!(mail.to, ALICE);
    assert_eq!(mail.from, "noreply@example.com");
    let data = &mail.data;
    assert!(
        data.contains("Subject: Acme Share: your secret was viewed"),
        "{data}"
    );
    assert!(
        data.contains("From: \"Acme Share\" <noreply@example.com>"),
        "{data}"
    );
    assert!(data.contains("Content-Type: text/plain"), "{data}");
    let message_id = data.lines().find(|l| l.starts_with("Message-ID:")).unwrap();
    assert!(message_id.ends_with("@example.com>"), "{message_id}");
    for line in [
        "A secret you shared was viewed.",
        "Label: Prod DB password",
        "Kind: text",
        "One-time: no",
        "Created: ",
        "Viewed: ",
        &format!("ID: {}", redact_secret_id(&key)),
        "https://share.example.com",
    ] {
        assert!(data.contains(line), "missing {line:?} in {data}");
    }
    // Nothing about the viewer, whose address the harness sets.
    assert!(!data.contains("203.0.113.9"), "{data}");
    // Never a way to the secret itself.
    assert!(!data.contains(&key), "{data}");
    assert!(!data.contains("/#/s/"), "{data}");
}

#[tokio::test]
async fn the_address_and_label_are_not_stored_in_plaintext_and_are_dropped_once_used() {
    let s = setup().await;
    let key = s.create(notifying_secret()).await.message();
    let receipt = s.stored(&format!("receipt/{key}")).await;
    assert!(receipt.contains("\"notify\""), "{receipt}");
    assert!(!receipt.contains("alice"), "{receipt}");
    assert!(!receipt.contains("Prod DB"), "{receipt}");

    s.harness.get(&format!("/secret/{key}")).await;
    let receipt = s.stored(&format!("receipt/{key}")).await;
    assert!(!receipt.contains("notify"), "{receipt}");
}

#[tokio::test]
async fn a_file_download_notifies_with_its_label() {
    let s = setup().await;
    let created = s
        .harness
        .send(
            upload_req(PGP_BINARY, "3600", true)
                .header("cookie", &s.cookie)
                .header("x-yopass-notify", "true")
                .header("x-yopass-label", "Q3%20report%3A%20final"),
        )
        .await;
    assert_eq!(created.status, 200, "{}", created.text());
    assert!(created.json()["receipt_token"].is_string());
    let key = created.message();
    assert_eq!(s.harness.get(&format!("/file/{key}")).await.status, 200);
    s.smtp.wait_for(1).await;
    let mails = s.smtp.mails.lock().unwrap();
    assert!(mails[0].data.contains("Kind: file"), "{}", mails[0].data);
    assert!(mails[0].data.contains("One-time: yes"), "{}", mails[0].data);
    // The header value arrives percent-encoded and is shown decoded.
    assert!(
        mails[0].data.contains("Label: Q3 report: final"),
        "{}",
        mails[0].data
    );
}

#[tokio::test]
async fn only_a_signed_in_user_on_a_mail_enabled_server_can_opt_in() {
    let s = setup().await;
    // Not signed in.
    let anonymous = s
        .harness
        .send(req("POST", "/create/secret").json(&notifying_secret()))
        .await;
    assert_eq!(anonymous.status, 400);
    assert_eq!(anonymous.message(), "Sign in to be notified by email");
    // An account whose address cannot be mailed is told at opt-in.
    let unmailable = s.harness.cookie_for(&Session {
        id: "login-1".into(),
        sub: "user-2".into(),
        email: "not an address".into(),
        name: "User".into(),
        email_verified: true,
    });
    let refused = s
        .harness
        .send(
            req("POST", "/create/secret")
                .header("cookie", &unmailable)
                .json(&notifying_secret()),
        )
        .await;
    assert_eq!(
        refused.message(),
        "Your account's email address cannot receive notifications"
    );
    // A login the identity provider did not vouch for, as one made while
    // --oidc-require-verified-email=false was still set.
    let unverified = s.harness.cookie_for(&Session {
        id: "login-2".into(),
        sub: "user-3".into(),
        email: "mallory@example.com".into(),
        name: "User".into(),
        email_verified: false,
    });
    for refused in [
        req("POST", "/create/secret").json(&notifying_secret()),
        req("POST", "/request")
            .json(&json!({ "public_key": PUBLIC_KEY, "expiration": 3600, "notify": true })),
        upload_req(PGP_BINARY, "3600", true).header("x-yopass-notify", "true"),
    ] {
        let refused = s.harness.send(refused.header("cookie", &unverified)).await;
        assert_eq!(
            refused.message(),
            "Sign in again with a verified email address to be notified by email"
        );
    }
    let request = s
        .harness
        .send(
            req("POST", "/request")
                .json(&json!({ "public_key": PUBLIC_KEY, "expiration": 3600, "notify": true })),
        )
        .await;
    assert_eq!(request.status, 400);
    let upload = s
        .harness
        .send(upload_req(PGP_BINARY, "3600", true).header("x-yopass-notify", "true"))
        .await;
    assert_eq!(upload.status, 400);

    let mut long = notifying_secret();
    long["label"] = "é".repeat(101).into();
    assert_eq!(s.create(long).await.message(), "Label is too long");
    let long_header = s
        .harness
        .send(
            upload_req(PGP_BINARY, "3600", true)
                .header("cookie", &s.cookie)
                .header("x-yopass-notify", "true")
                .header("x-yopass-label", &"%C3%A9".repeat(101)),
        )
        .await;
    assert_eq!(long_header.message(), "Label is too long");
    let mut exact = notifying_secret();
    exact["label"] = "é".repeat(100).into();
    assert_eq!(s.create(exact).await.status, 200);
    let mut multiline = notifying_secret();
    multiline["label"] = "a\nb".into();
    assert_eq!(s.create(multiline).await.status, 400);

    // Nothing was stored for the refused ones: one secret and its receipt.
    assert_eq!(s.db.keys().len(), 2, "{:?}", s.db.keys());

    // No mail server configured.
    let plain = Builder::new().licensed().sessions().build();
    let cookie = plain.session_cookie(ALICE);
    let refused = plain
        .send(
            req("POST", "/create/secret")
                .header("cookie", &cookie)
                .json(&notifying_secret()),
        )
        .await;
    assert_eq!(refused.status, 400);
    assert_eq!(
        refused.message(),
        "Email notifications are not enabled on this server"
    );
    assert!(plain.get("/config").await.json()["EMAIL_NOTIFICATIONS"].is_null());
    // The upload preflight allows the opt-in headers only where mail can be sent.
    let allowed = async |harness: &Harness| {
        let preflight = harness.send(req("OPTIONS", "/create/file")).await;
        preflight
            .header("access-control-allow-headers")
            .unwrap()
            .to_owned()
    };
    assert!(!allowed(&plain).await.contains("X-Yopass-Notify"));
    assert!(
        allowed(&s.harness)
            .await
            .ends_with("X-Yopass-Receipt, X-Yopass-Notify, X-Yopass-Label")
    );
    assert_eq!(
        s.harness.get("/config").await.json()["EMAIL_NOTIFICATIONS"],
        true
    );
}

#[tokio::test]
async fn disabling_read_receipts_disables_secret_mails_but_not_request_mails() {
    let (smtp, port) = Smtp::start().await;
    let mut builder = Builder::new()
        .licensed()
        .sessions()
        .settings(|s| s.disable_read_receipts = true);
    builder.mail = Some(Mailer::start(config(port), None).unwrap());
    let harness = builder.build();
    let cookie = harness.session_cookie(ALICE);
    let refused = harness
        .send(
            req("POST", "/create/secret")
                .header("cookie", &cookie)
                .json(&notifying_secret()),
        )
        .await;
    assert_eq!(refused.status, 400);
    assert_eq!(
        refused.message(),
        "Read receipts are not enabled on this server"
    );
    let upload = harness
        .send(
            upload_req(PGP_BINARY, "3600", true)
                .header("cookie", &cookie)
                .header("x-yopass-notify", "true"),
        )
        .await;
    assert_eq!(
        upload.message(),
        "Read receipts are not enabled on this server"
    );
    let request = harness
        .send(
            req("POST", "/request")
                .header("cookie", &cookie)
                .json(&json!({ "public_key": PUBLIC_KEY, "expiration": 3600, "notify": true })),
        )
        .await;
    assert_eq!(request.status, 200, "{}", request.text());
    let id = request.json()["id"].as_str().unwrap().to_owned();
    let fulfilled = harness
        .send(
            req("POST", &format!("/request/{id}/secret")).json(&json!({ "message": PGP_MESSAGE })),
        )
        .await;
    assert_eq!(fulfilled.status, 200);
    smtp.wait_for(1).await;
}

#[tokio::test]
async fn an_api_token_cannot_opt_in() {
    let (smtp, port) = Smtp::start().await;
    let mut builder = Builder::new().licensed().sessions().settings(|s| {
        s.require_auth_all = true;
        s.api_tokens = parse_api_tokens(&["ci:0123456789abcdef0123".to_owned()]).unwrap();
    });
    builder.mail = Some(Mailer::start(config(port), None).unwrap());
    let harness = builder.build();
    let bearer = "Bearer 0123456789abcdef0123";
    let refused = harness
        .send(
            req("POST", "/create/secret")
                .header("authorization", bearer)
                .json(&notifying_secret()),
        )
        .await;
    assert_eq!(refused.status, 400, "{}", refused.text());
    assert_eq!(refused.message(), "Sign in to be notified by email");
    // The token itself is fine: the same secret without the opt-in is stored.
    let mut plain = notifying_secret();
    plain["notify"] = false.into();
    let stored = harness
        .send(
            req("POST", "/create/secret")
                .header("authorization", bearer)
                .json(&plain),
        )
        .await;
    assert_eq!(stored.status, 200, "{}", stored.text());
    for refused in [
        req("POST", "/request")
            .json(&json!({ "public_key": PUBLIC_KEY, "expiration": 3600, "notify": true })),
        upload_req(PGP_BINARY, "3600", true).header("x-yopass-notify", "true"),
    ] {
        let refused = harness.send(refused.header("authorization", bearer)).await;
        assert_eq!(refused.message(), "Sign in to be notified by email");
    }
    drop(smtp);
}

#[tokio::test]
async fn the_requester_is_mailed_when_their_request_is_fulfilled() {
    let s = setup().await;
    let created = s.create_request(true).await;
    assert_eq!(created.status, 200, "{}", created.text());
    let id = created.json()["id"].as_str().unwrap().to_owned();
    let record = s.stored(&format!("request/{id}")).await;
    assert!(record.contains("\"notify\""), "{record}");
    assert!(!record.contains("alice"), "{record}");
    // The public view of the request does not show the sealed address either.
    let public = s.harness.get(&format!("/request/{id}")).await;
    assert!(!public.text().contains("notify"), "{}", public.text());

    assert_eq!(s.fulfill(&id).await.status, 200);
    s.smtp.wait_for(1).await;
    assert_eq!(s.fulfill(&id).await.status, 409);
    s.smtp.expect_none_beyond(1).await;
    assert!(!s.stored(&format!("request/{id}")).await.contains("notify"));

    let mails = s.smtp.mails.lock().unwrap();
    let data = &mails[0].data;
    assert_eq!(mails[0].to, ALICE);
    assert!(
        data.contains("Subject: Acme Share: your secret request was fulfilled"),
        "{data}"
    );
    for line in [
        "Kind: text",
        "Created: ",
        "Fulfilled: ",
        &format!("ID: {}", redact_secret_id(&id)),
        "https://share.example.com/#/requests",
    ] {
        assert!(data.contains(line), "missing {line:?} in {data}");
    }
    assert!(!data.contains(&id), "{data}");
}

#[tokio::test]
async fn nobody_is_mailed_without_opting_in() {
    let s = setup().await;
    let created = s
        .create(json!({ "message": PGP_MESSAGE, "expiration": 3600, "receipt": true }))
        .await;
    s.harness
        .get(&format!("/secret/{}", created.message()))
        .await;
    let id = s.create_request(false).await.json()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(s.fulfill(&id).await.status, 200);
    s.smtp.expect_none_beyond(0).await;
}

#[tokio::test]
async fn a_temporary_refusal_is_retried_and_a_permanent_one_is_not() {
    let s = setup().await;
    s.smtp.reject_code.store(451, Ordering::SeqCst);
    s.smtp.rejections.store(2, Ordering::SeqCst);
    let key = s.create(notifying_secret()).await.message();
    assert_eq!(s.harness.get(&format!("/secret/{key}")).await.status, 200);
    s.smtp.wait_for(1).await;
    assert_eq!(s.smtp.attempts.load(Ordering::SeqCst), 3);

    s.smtp.reject_code.store(550, Ordering::SeqCst);
    s.smtp.rejections.store(5, Ordering::SeqCst);
    let key = s.create(notifying_secret()).await.message();
    assert_eq!(s.harness.get(&format!("/secret/{key}")).await.status, 200);
    s.smtp.expect_none_beyond(1).await;
    assert_eq!(s.smtp.attempts.load(Ordering::SeqCst), 4);
}

#[tokio::test]
async fn a_mail_server_that_never_answers_does_not_hold_up_the_view() {
    // Accepts connections and then says nothing.
    let silent = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = silent.local_addr().unwrap().port();
    let s = setup_with(|config| config.port = Some(port)).await;
    let key = s.create(notifying_secret()).await.message();
    let view = tokio::time::timeout(
        Duration::from_secs(2),
        s.harness.get(&format!("/secret/{key}")),
    )
    .await
    .expect("the view waited for the mail server");
    assert_eq!(view.status, 200);
    let id = s.create_request(true).await.json()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(s.fulfill(&id).await.status, 200);
}

#[tokio::test]
async fn a_changed_key_drops_the_mail_but_keeps_the_receipt_working() {
    let s = setup().await;
    let created = s.create(notifying_secret()).await;
    let key = created.message();
    let token = created.json()["receipt_token"].as_str().unwrap().to_owned();

    // The same database behind an instance started with another key.
    let (other_smtp, port) = Smtp::start().await;
    let mut builder = Builder::with_db(s.db.clone()).licensed();
    builder.mail = Some(
        Mailer::start(
            MailConfig {
                sealer: CookieCodec::from_key([4; 32]),
                ..config(port)
            },
            None,
        )
        .unwrap(),
    );
    let rotated = builder.build();
    assert_eq!(rotated.get(&format!("/secret/{key}")).await.status, 200);
    other_smtp.expect_none_beyond(0).await;
    s.smtp.expect_none_beyond(0).await;
    let receipt = rotated
        .send(
            req("GET", &format!("/secret/{key}/receipt")).header("x-yopass-receipt-token", &token),
        )
        .await;
    assert_eq!(receipt.json()["state"], "viewed");

    // A request is still fulfilled; its mail is dropped the same way.
    let logs = captured_logs();
    let id = s.create_request(true).await.json()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let fulfilled = rotated
        .send(
            req("POST", &format!("/request/{id}/secret")).json(&json!({ "message": PGP_MESSAGE })),
        )
        .await;
    assert_eq!(fulfilled.status, 200);
    other_smtp.expect_none_beyond(0).await;
    let fingerprint = redact_secret_id(&id);
    assert!(
        logs.text().lines().any(|line| {
            line.contains("stored address cannot be read") && line.contains(&fingerprint)
        }),
        "the dropped notification was not logged"
    );
}

#[tokio::test]
async fn notifications_stop_when_the_license_lapses() {
    captured_logs();
    let (smtp, port) = Smtp::start().await;
    let mut builder = Builder::new().sessions();
    builder.license = expired_license();
    builder.mail = Some(Mailer::start(config(port), None).unwrap());
    let harness = builder.build();
    assert!(harness.get("/config").await.json()["EMAIL_NOTIFICATIONS"].is_null());
    let cookie = harness.session_cookie(ALICE);
    let refused = harness
        .send(
            req("POST", "/create/secret")
                .header("cookie", &cookie)
                .json(&notifying_secret()),
        )
        .await;
    assert_eq!(refused.status, 400);

    // A notification pending from before the lapse is not sent either.
    let db = Arc::new(MemoryDb::new());
    let mut licensed = Builder::with_db(db.clone()).licensed().sessions();
    licensed.mail = Some(Mailer::start(config(port), None).unwrap());
    let licensed = licensed.build();
    let created = licensed
        .send(
            req("POST", "/create/secret")
                .header("cookie", &licensed.session_cookie(ALICE))
                .json(&notifying_secret()),
        )
        .await;
    let mut lapsed = Builder::with_db(db);
    lapsed.license = expired_license();
    lapsed.mail = Some(Mailer::start(config(port), None).unwrap());
    let view = lapsed
        .build()
        .get(&format!("/secret/{}", created.message()))
        .await;
    assert_eq!(view.status, 200);
    smtp.expect_none_beyond(0).await;
    let fingerprint = redact_secret_id(&created.message());
    assert!(
        captured_logs().text().lines().any(|line| {
            line.contains("this instance cannot send mail") && line.contains(&fingerprint)
        }),
        "the skipped notification was not logged"
    );
}

#[tokio::test]
async fn a_sender_that_is_not_an_address_is_refused_at_startup() {
    let bad = MailConfig::new(
        "smtp.example.com",
        "not an address",
        CookieCodec::from_key([3; 32]),
    );
    assert!(Mailer::start(bad, None).is_err());
}

/// The mailer's next connection. A mail that was never sent fails the test
/// here instead of leaving it waiting.
async fn connection(server: &TcpListener) -> tokio::net::TcpStream {
    let accepted = tokio::time::timeout(Duration::from_secs(5), server.accept()).await;
    accepted.expect("the mailer never connected").unwrap().0
}

/// How many mails the delivery counter holds for `event` and `outcome`.
fn counted(registry: &Registry, event: &str, outcome: &str) -> u64 {
    let label = |metric: &prometheus::proto::Metric, name: &str| {
        metric
            .get_label()
            .iter()
            .find(|l| l.name() == name)
            .map(|l| l.value().to_owned())
    };
    registry
        .gather()
        .iter()
        .filter(|family| family.name() == "yopass_email_deliveries_total")
        .flat_map(|family| family.get_metric())
        .filter(|m| {
            label(m, "event").as_deref() == Some(event)
                && label(m, "outcome").as_deref() == Some(outcome)
        })
        .map(|m| m.get_counter().get_value() as u64)
        .sum()
}

/// A harness whose mailer reports to `registry`.
fn counting(config: MailConfig, registry: &Registry) -> (Harness, String) {
    let mut builder = Builder::new().licensed().sessions();
    builder.mail = Some(Mailer::start(config, Some(registry)).unwrap());
    let harness = builder.build();
    let cookie = harness.session_cookie(ALICE);
    (harness, cookie)
}

async fn create_and_view(harness: &Harness, cookie: &str) {
    let created = harness
        .send(
            req("POST", "/create/secret")
                .header("cookie", cookie)
                .json(&notifying_secret()),
        )
        .await;
    assert_eq!(created.status, 200, "{}", created.text());
    let view = harness.get(&format!("/secret/{}", created.message())).await;
    assert_eq!(view.status, 200);
}

#[tokio::test]
async fn deliveries_are_counted_by_event_and_outcome() {
    let (smtp, port) = Smtp::start().await;
    let registry = Registry::new();
    let (harness, cookie) = counting(config(port), &registry);
    create_and_view(&harness, &cookie).await;
    smtp.wait_for(1).await;
    eventually("the delivery is counted", async || {
        counted(&registry, "secret.viewed", "delivered") == 1
    })
    .await;

    smtp.reject_code.store(550, Ordering::SeqCst);
    smtp.rejections.store(1, Ordering::SeqCst);
    create_and_view(&harness, &cookie).await;
    eventually("the refusal is counted", async || {
        counted(&registry, "secret.viewed", "failed") == 1
    })
    .await;
    assert_eq!(counted(&registry, "secret.viewed", "delivered"), 1);
    assert_eq!(counted(&registry, "request.fulfilled", "delivered"), 0);
}

#[tokio::test]
async fn starttls_is_never_skipped_when_the_server_does_not_offer_it() {
    // The fake server speaks plaintext only and advertises no STARTTLS.
    let (smtp, port) = Smtp::start().await;
    let registry = Registry::new();
    let config = MailConfig {
        tls: SmtpTls::Starttls,
        username: "yopass".into(),
        password: "hunter2".into(),
        max_attempts: 1,
        ..config(port)
    };
    let (harness, cookie) = counting(config, &registry);
    create_and_view(&harness, &cookie).await;
    eventually("the delivery fails", async || {
        counted(&registry, "secret.viewed", "failed") == 1
    })
    .await;
    assert_eq!(smtp.count(), 0);
    assert_nothing_sent_in_the_clear(&smtp);
}

/// Neither the password nor any part of the envelope reached the server.
fn assert_nothing_sent_in_the_clear(smtp: &Smtp) {
    assert!(smtp.logins.lock().unwrap().is_empty());
    for command in smtp.commands.lock().unwrap().iter() {
        for verb in ["AUTH", "MAIL", "RCPT", "DATA"] {
            assert!(!command.starts_with(verb), "sent in the clear: {command}");
        }
    }
}

#[tokio::test]
async fn implicit_tls_does_not_talk_to_a_plaintext_server() {
    let (smtp, port) = Smtp::start().await;
    let registry = Registry::new();
    let config = MailConfig {
        tls: SmtpTls::Implicit,
        username: "yopass".into(),
        password: "hunter2".into(),
        max_attempts: 1,
        ..config(port)
    };
    let (harness, cookie) = counting(config, &registry);
    create_and_view(&harness, &cookie).await;
    eventually("the delivery fails", async || {
        counted(&registry, "secret.viewed", "failed") == 1
    })
    .await;
    assert_eq!(smtp.count(), 0);
    assert_nothing_sent_in_the_clear(&smtp);
}

#[tokio::test]
async fn credentials_are_presented_and_unset_names_and_urls_are_left_out() {
    use base64::Engine;
    let s = setup_with(|config| {
        config.username = "yopass".into();
        config.password = "hunter2".into();
        config.app_name = String::new();
        config.public_url = String::new();
    })
    .await;
    let key = s.create(notifying_secret()).await.message();
    assert_eq!(s.harness.get(&format!("/secret/{key}")).await.status, 200);
    let id = s.create_request(true).await.json()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(s.fulfill(&id).await.status, 200);
    s.smtp.wait_for(2).await;

    let login = base64::engine::general_purpose::STANDARD.encode("\0yopass\0hunter2");
    assert_eq!(*s.smtp.logins.lock().unwrap(), [login.clone(), login]);
    let mails = s.smtp.mails.lock().unwrap();
    assert!(
        mails[0]
            .data
            .contains("Subject: Yopass: your secret was viewed"),
        "{}",
        mails[0].data
    );
    assert!(
        mails[0].data.contains("From: Yopass <noreply@example.com>"),
        "{}",
        mails[0].data
    );
    for mail in mails.iter() {
        assert!(!mail.data.contains("http"), "{}", mail.data);
    }
}

#[tokio::test]
async fn failures_are_logged_by_fingerprint_without_the_address() {
    let logs = captured_logs();
    let (smtp, port) = Smtp::start().await;
    let registry = Registry::new();
    let (harness, cookie) = counting(config(port), &registry);
    smtp.reject_code.store(550, Ordering::SeqCst);
    smtp.rejections.store(1, Ordering::SeqCst);
    let created = harness
        .send(
            req("POST", "/create/secret")
                .header("cookie", &cookie)
                .json(&notifying_secret()),
        )
        .await;
    let key = created.message();
    harness.get(&format!("/secret/{key}")).await;
    eventually("the refusal is counted", async || {
        counted(&registry, "secret.viewed", "failed") == 1
    })
    .await;
    let fingerprint = redact_secret_id(&key);
    let logged: Vec<String> = logs
        .text()
        .lines()
        .filter(|line| line.contains("mail: "))
        .map(str::to_owned)
        .collect();
    assert!(
        logged
            .iter()
            .any(|line| line.contains("mail: delivery failed permanently")
                && line.contains(&fingerprint)),
        "{logged:?}"
    );
    assert!(
        logged
            .iter()
            .any(|line| line.contains("\"smtp_status\":\"550\"") && line.contains(&fingerprint)),
        "{logged:?}"
    );
    for line in &logged {
        assert!(!line.contains("alice"), "{line}");
        assert!(!line.contains(&key), "{line}");
    }
}

#[tokio::test]
async fn an_unreadable_reply_is_not_copied_into_the_log() {
    let logs = captured_logs();
    let (smtp, port) = Smtp::start().await;
    let registry = Registry::new();
    let (harness, _) = counting(config(port), &registry);
    // An address found nowhere else in this file, which the reply quotes.
    let cookie = harness.session_cookie("only-in-the-reply@example.com");
    smtp.reject_code.store(GARBLED, Ordering::SeqCst);
    smtp.rejections.store(1, Ordering::SeqCst);
    let created = harness
        .send(
            req("POST", "/create/secret")
                .header("cookie", &cookie)
                .json(&notifying_secret()),
        )
        .await;
    let key = created.message();
    harness.get(&format!("/secret/{key}")).await;
    eventually("the delivery is given up on", async || {
        counted(&registry, "secret.viewed", "failed") == 1
    })
    .await;
    let fingerprint = redact_secret_id(&key);
    let logged = logs.text();
    assert!(
        logged.lines().any(|line| {
            line.contains("mail: server sent a reply that cannot be read")
                && line.contains(&fingerprint)
        }),
        "the unreadable reply was not logged"
    );
    assert!(!logged.contains("only-in-the-reply"));
    // It is not known whether the server took the mail, so it is not resent.
    smtp.expect_none_beyond(0).await;
    assert_eq!(smtp.attempts.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn a_stored_address_that_cannot_be_mailed_is_dropped_and_counted() {
    let (smtp, port) = Smtp::start().await;
    let registry = Registry::new();
    let mailer = Mailer::start(config(port), Some(&registry)).unwrap();
    // Opt-in refuses such an address, so only an older record could hold one.
    let sealed = mailer.seal(UUID_KEY, "not an address", "", 60);
    mailer.request_fulfilled(UUID_KEY, &sealed, "text", 0, 0);
    assert_eq!(counted(&registry, "request.fulfilled", "dropped"), 1);
    smtp.expect_none_beyond(0).await;
}

#[tokio::test]
async fn a_full_queue_drops_mails_and_says_so() {
    let logs = captured_logs();
    // A server that never answers keeps the worker busy with the first mail.
    let silent = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let registry = Registry::new();
    let config = MailConfig {
        queue_size: 1,
        ..config(silent.local_addr().unwrap().port())
    };
    let (harness, cookie) = counting(config, &registry);
    create_and_view(&harness, &cookie).await;
    // The worker has taken the first mail once it connects.
    let _in_flight = connection(&silent).await;
    for _ in 0..3 {
        create_and_view(&harness, &cookie).await;
    }
    // One mail is in flight and one is queued; the other two had nowhere to go.
    assert_eq!(counted(&registry, "secret.viewed", "dropped"), 2);
    assert_eq!(counted(&registry, "secret.viewed", "delivered"), 0);
    assert!(logs.text().contains("mail: queue full, dropping mail"));
}

#[tokio::test]
async fn a_server_that_never_greets_is_tried_again() {
    // Nothing can have been sent, so every allowed attempt is made.
    let silent = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let registry = Registry::new();
    let config = MailConfig {
        timeout: Duration::from_millis(300),
        ..config(silent.local_addr().unwrap().port())
    };
    let (harness, cookie) = counting(config, &registry);
    create_and_view(&harness, &cookie).await;
    let mut held = Vec::new();
    for _ in 0..3 {
        held.push(connection(&silent).await);
    }
    eventually("the mail is given up on", async || {
        counted(&registry, "secret.viewed", "failed") == 1
    })
    .await;
    let fourth = tokio::time::timeout(Duration::from_millis(200), silent.accept()).await;
    assert!(fourth.is_err(), "more attempts than configured");
}

/// The server has the mail, but the sender never learns it. Trying again
/// would deliver a second copy.
#[tokio::test]
async fn a_mail_the_server_took_without_confirming_is_not_sent_again() {
    for behaviour in [AfterMail::HangUp, AfterMail::GoQuiet] {
        let (smtp, port) = Smtp::start().await;
        *smtp.after_mail.lock().unwrap() = behaviour;
        let registry = Registry::new();
        let config = MailConfig {
            timeout: Duration::from_millis(400),
            ..config(port)
        };
        let (harness, cookie) = counting(config, &registry);
        create_and_view(&harness, &cookie).await;
        eventually("the delivery is given up on", async || {
            counted(&registry, "secret.viewed", "failed") == 1
        })
        .await;
        // Three attempts are allowed; a second one would have arrived by now.
        smtp.expect_none_beyond(1).await;
    }
}

/// The server confirmed the mail; how long it takes to say goodbye afterwards
/// is no part of the attempt's time limit.
#[tokio::test]
async fn a_server_that_never_says_goodbye_still_counts_as_delivered() {
    let (smtp, port) = Smtp::start().await;
    *smtp.after_mail.lock().unwrap() = AfterMail::IgnoreQuit;
    let registry = Registry::new();
    let config = MailConfig {
        timeout: Duration::from_millis(300),
        ..config(port)
    };
    let (harness, cookie) = counting(config, &registry);
    create_and_view(&harness, &cookie).await;
    eventually("the mail is counted", async || {
        counted(&registry, "secret.viewed", "delivered")
            + counted(&registry, "secret.viewed", "failed")
            == 1
    })
    .await;
    assert_eq!(counted(&registry, "secret.viewed", "delivered"), 1);
}

/// A wrong password stays wrong, so the mail is given up on at once.
#[tokio::test]
async fn a_refused_login_is_not_tried_again() {
    let (smtp, port) = Smtp::start().await;
    smtp.refuse_logins.store(true, Ordering::SeqCst);
    let registry = Registry::new();
    let config = MailConfig {
        username: "yopass".into(),
        password: "wrong".into(),
        ..config(port)
    };
    let (harness, cookie) = counting(config, &registry);
    create_and_view(&harness, &cookie).await;
    eventually("the mail is given up on", async || {
        counted(&registry, "secret.viewed", "failed") == 1
    })
    .await;
    assert_eq!(smtp.logins.lock().unwrap().len(), 1);
    assert_eq!(smtp.count(), 0);
}

#[tokio::test]
async fn a_connection_that_fails_is_tried_again() {
    // A server that hangs up at once: nothing can have been sent.
    let hangup = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let registry = Registry::new();
    let (harness, cookie) = counting(config(hangup.local_addr().unwrap().port()), &registry);
    create_and_view(&harness, &cookie).await;
    for _ in 0..3 {
        drop(connection(&hangup).await);
    }
    eventually("the mail is given up on", async || {
        counted(&registry, "secret.viewed", "failed") == 1
    })
    .await;
    let fourth = tokio::time::timeout(Duration::from_millis(200), hangup.accept()).await;
    assert!(fourth.is_err(), "more attempts than configured");
}

#[tokio::test]
async fn stopping_the_mailer_abandons_a_stuck_delivery() {
    let silent = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let registry = Registry::new();
    let mailer =
        Mailer::start(config(silent.local_addr().unwrap().port()), Some(&registry)).unwrap();
    let mut builder = Builder::new().licensed().sessions();
    builder.mail = Some(mailer.clone());
    let harness = builder.build();
    create_and_view(&harness, &harness.session_cookie(ALICE)).await;
    let _in_flight = connection(&silent).await;
    // A second mail waits in the queue behind the stuck one.
    create_and_view(&harness, &harness.session_cookie(ALICE)).await;
    tokio::time::timeout(Duration::from_secs(2), mailer.stop())
        .await
        .expect("stop() waited for the mail server");
    // The outcome of the first is unknown and the second was never tried, so
    // neither is reported as a failed delivery.
    assert_eq!(counted(&registry, "secret.viewed", "dropped"), 2);
    assert_eq!(counted(&registry, "secret.viewed", "failed"), 0);
    // Mails after the stop are dropped, not queued for nobody.
    create_and_view(&harness, &harness.session_cookie(ALICE)).await;
    assert_eq!(counted(&registry, "secret.viewed", "dropped"), 3);
}

/// Sends through a real SMTP server and reads the mail back the way a mail
/// client would decode it. Runs when a Mailpit instance is provided, as
/// `MAILPIT_SMTP=host:port` and `MAILPIT_API=http://host:port`.
#[tokio::test]
async fn a_real_mail_server_accepts_and_decodes_the_mail() {
    let (Ok(smtp), Ok(api)) = (std::env::var("MAILPIT_SMTP"), std::env::var("MAILPIT_API")) else {
        return;
    };
    let (host, port) = smtp.rsplit_once(':').expect("MAILPIT_SMTP is host:port");
    let config = MailConfig {
        port: Some(port.parse().unwrap()),
        tls: SmtpTls::None,
        app_name: "Åcme Share".into(),
        public_url: "https://share.example.com".into(),
        ..MailConfig::new(host, "noreply@example.com", CookieCodec::from_key([3; 32]))
    };
    let mut builder = Builder::new().licensed().sessions();
    builder.mail = Some(Mailer::start(config, None).unwrap());
    let harness = builder.build();
    // A fresh address per run, so the search below finds only this mail.
    let recipient = format!("e2e-{}@example.com", yopass_server::util::random_hex());
    let cookie = harness.session_cookie(&recipient);
    let mut secret = notifying_secret();
    secret["label"] = "Lösenord för prod ✓".into();
    let created = harness
        .send(
            req("POST", "/create/secret")
                .header("cookie", &cookie)
                .json(&secret),
        )
        .await;
    assert_eq!(created.status, 200, "{}", created.text());
    let key = created.message();
    assert_eq!(harness.get(&format!("/secret/{key}")).await.status, 200);

    let client = reqwest::Client::new();
    let found = std::sync::Mutex::new(String::new());
    eventually("the mail reaches the mail server", async || {
        let hits: serde_json::Value = client
            .get(format!("{api}/api/v1/search?query=to:{recipient}"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let id = hits["messages"][0]["ID"].as_str().unwrap_or_default();
        *found.lock().unwrap() = id.to_owned();
        !id.is_empty()
    })
    .await;
    let id = found.into_inner().unwrap();
    let mail: serde_json::Value = client
        .get(format!("{api}/api/v1/message/{id}"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    // Leave the shared inbox as it was found.
    client
        .delete(format!("{api}/api/v1/messages"))
        .json(&json!({ "IDs": [id] }))
        .send()
        .await
        .unwrap();

    assert_eq!(
        mail["Subject"], "Åcme Share: your secret was viewed",
        "{mail}"
    );
    assert_eq!(mail["From"]["Name"], "Åcme Share", "{mail}");
    assert_eq!(mail["From"]["Address"], "noreply@example.com", "{mail}");
    assert_eq!(mail["To"][0]["Address"], recipient.as_str(), "{mail}");
    assert!(
        mail["MessageID"]
            .as_str()
            .unwrap()
            .ends_with("@example.com"),
        "{mail}"
    );
    let text = mail["Text"].as_str().unwrap();
    assert!(text.contains("Label: Lösenord för prod ✓"), "{text}");
    assert!(
        text.contains(&format!("ID: {}", redact_secret_id(&key))),
        "{text}"
    );
    assert!(text.contains("https://share.example.com"), "{text}");
    assert!(!text.contains(&key), "{text}");
    assert_eq!(mail["HTML"], "", "{mail}");
}
