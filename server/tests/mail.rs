//! Email notifications: who is mailed, when, and what the mail and the stored
//! record may contain.

mod common;

use common::*;
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use yopass_server::auth::{CookieCodec, Session, parse_api_tokens};
use yopass_server::db::Database;
use yopass_server::db::memory::MemoryDb;
use yopass_server::mail::{MailConfig, Mailer, SmtpTls};
use yopass_server::util::redact_secret_id;

const ALICE: &str = "alice@example.com";

struct Received {
    from: String,
    to: String,
    data: String,
}

/// A plaintext SMTP server that records what it accepts.
#[derive(Clone, Default)]
struct Smtp {
    mails: Arc<Mutex<Vec<Received>>>,
    /// How many RCPT commands to answer with `reject_code` first.
    rejections: Arc<AtomicUsize>,
    reject_code: Arc<AtomicUsize>,
    attempts: Arc<AtomicUsize>,
}

impl Smtp {
    async fn start() -> (Self, u16) {
        let smtp = Self::default();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = smtp.clone();
        tokio::spawn(async move {
            loop {
                let (stream, _) = listener.accept().await.unwrap();
                tokio::spawn(server.clone().session(stream));
            }
        });
        (smtp, port)
    }

    async fn session(self, stream: tokio::net::TcpStream) {
        let (read, mut write) = stream.into_split();
        let mut lines = BufReader::new(read).lines();
        let (mut from, mut to) = (String::new(), String::new());
        write.write_all(b"220 fake ESMTP\r\n").await.unwrap();
        while let Ok(Some(line)) = lines.next_line().await {
            let address = || {
                let start = line.find('<').unwrap() + 1;
                line[start..line.find('>').unwrap()].to_owned()
            };
            let reply = if line.starts_with("MAIL FROM") {
                from = address();
                "250 ok".to_owned()
            } else if line.starts_with("RCPT TO") {
                to = address();
                self.attempts.fetch_add(1, Ordering::SeqCst);
                let reject = self
                    .rejections
                    .try_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1))
                    .is_ok();
                if reject {
                    format!("{} no", self.reject_code.load(Ordering::SeqCst))
                } else {
                    "250 ok".to_owned()
                }
            } else if line == "DATA" {
                write.write_all(b"354 go\r\n").await.unwrap();
                let mut data = String::new();
                while let Ok(Some(line)) = lines.next_line().await {
                    if line == "." {
                        break;
                    }
                    data += &line;
                    data.push('\n');
                }
                self.mails.lock().unwrap().push(Received {
                    from: from.clone(),
                    to: to.clone(),
                    data,
                });
                "250 ok".to_owned()
            } else if line == "QUIT" {
                let _ = write.write_all(b"221 bye\r\n").await;
                return;
            } else {
                "250 ok".to_owned()
            };
            write
                .write_all(format!("{reply}\r\n").as_bytes())
                .await
                .unwrap();
        }
    }

    fn count(&self) -> usize {
        self.mails.lock().unwrap().len()
    }

    async fn wait_for(&self, count: usize) {
        eventually("mail delivery", async || self.count() >= count).await;
    }

    /// Long enough for a queued mail to arrive, had one been sent.
    async fn expect_none_beyond(&self, count: usize) {
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(self.count(), count);
    }
}

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
                .header("x-yopass-label", "Q3%20r%C3%A9sum%C3%A9"),
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
    // Non-ASCII bodies are transfer-encoded, so only the ASCII part shows.
    assert!(!mails[0].data.contains("Q3%20"), "{}", mails[0].data);
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
}

#[tokio::test]
async fn notifications_stop_when_the_license_lapses() {
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
