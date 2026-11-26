//! Emailed one-time codes: a named recipient who cannot sign in through the
//! instance's identity provider proves the address with a code sent to it.

mod common;

use common::smtp::Smtp;
use common::*;
use serde_json::json;
use std::time::Duration;
use yopass_server::app::Settings;
use yopass_server::auth::CookieCodec;
use yopass_server::mail::{MailConfig, Mailer, SmtpTls};

const SENDER: &str = "alice@example.com";
const GUEST: &str = "guest@outside.test";

struct Setup {
    harness: Harness,
    smtp: Smtp,
}

async fn setup_on(db: std::sync::Arc<dyn yopass_server::db::Database>) -> Setup {
    setup_full(db, |_| {}).await
}

async fn setup_with(mutate: impl FnOnce(&mut Settings)) -> Setup {
    setup_full(
        std::sync::Arc::new(yopass_server::db::memory::MemoryDb::new()),
        mutate,
    )
    .await
}

async fn setup_full(
    db: std::sync::Arc<dyn yopass_server::db::Database>,
    mutate: impl FnOnce(&mut Settings),
) -> Setup {
    let (smtp, port) = Smtp::start().await;
    let config = MailConfig {
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
    };
    let mut builder = Builder::with_db(db).licensed().sessions().settings(|s| {
        s.recipient_email_code = true;
        s.allowed_email_domains = vec!["example.com".into()];
        mutate(s);
    });
    builder.mail = Some(Mailer::start(config, None).unwrap());
    Setup {
        harness: builder.build(),
        smtp,
    }
}

async fn setup() -> Setup {
    setup_with(|_| {}).await
}

impl Setup {
    async fn create_for(&self, recipient: &str, extra: serde_json::Value) -> String {
        let mut body = json!({
            "message": PGP_MESSAGE, "expiration": 3600, "one_time": false,
            "recipient": recipient,
        });
        body.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let created = self
            .harness
            .send(
                req("POST", "/create/secret")
                    .header("cookie", &self.harness.session_cookie(SENDER))
                    .json(&body),
            )
            .await;
        assert_eq!(created.status, 200, "{}", created.text());
        created.message()
    }

    async fn request_code(&self, path: &str, email: &str) -> Resp {
        self.harness
            .send(req("POST", &format!("{path}/code")).json(&json!({ "email": email })))
            .await
    }

    async fn verify(&self, path: &str, code: &str) -> Resp {
        self.verify_as(path, GUEST, code).await
    }

    async fn verify_as(&self, path: &str, email: &str, code: &str) -> Resp {
        self.harness
            .send(
                req("POST", &format!("{path}/code/verify"))
                    .json(&json!({ "email": email, "code": code })),
            )
            .await
    }

    /// The code in the newest mail, which carries nothing else of six digits on a line.
    async fn code(&self, nth: usize) -> String {
        self.smtp.wait_for(nth).await;
        let mails = self.smtp.mails.lock().unwrap();
        let data = &mails[nth - 1].data;
        data.lines()
            .map(str::trim)
            .find(|line| line.len() == 6 && line.bytes().all(|b| b.is_ascii_digit()))
            .unwrap_or_else(|| panic!("no code in {data}"))
            .to_owned()
    }

    /// Requests, receives and redeems a code; returns the grant cookie.
    async fn grant(&self, path: &str, nth: usize) -> String {
        assert_eq!(self.request_code(path, GUEST).await.status, 202);
        let code = self.code(nth).await;
        let verified = self.verify(path, &code).await;
        assert_eq!(verified.status, 200, "{}", verified.text());
        cookie_of(&verified)
    }
}

/// `name=value` of the grant cookie a response sets.
fn cookie_of(response: &Resp) -> String {
    let set = response.header("set-cookie").expect("a grant cookie");
    set.split(';').next().unwrap().to_owned()
}

#[tokio::test]
async fn an_external_recipient_opens_the_secret_with_a_mailed_code() {
    let s = setup().await;
    let key = s.create_for(GUEST, json!({ "receipt": true })).await;
    let path = format!("/secret/{key}");
    assert_eq!(s.harness.get(&path).await.status, 401);

    let requested = s.request_code(&path, GUEST).await;
    assert_eq!(requested.status, 202, "{}", requested.text());
    let code = s.code(1).await;
    {
        let mails = s.smtp.mails.lock().unwrap();
        let mail = &mails[0];
        assert_eq!(mail.to, GUEST);
        assert!(mail.data.contains("Subject: Acme Share: "), "{}", mail.data);
        assert!(mail.data.contains("Acme Share"), "{}", mail.data);
        assert!(mail.data.contains("Never share this code"), "{}", mail.data);
        // No way to the secret and nothing about who sent it.
        for absent in [key.as_str(), "http", SENDER, "/#/"] {
            assert!(!mail.data.contains(absent), "{absent:?} in {}", mail.data);
        }
    }

    let verified = s.verify(&path, &code).await;
    assert_eq!(verified.status, 200, "{}", verified.text());
    let set_cookie = verified.header("set-cookie").unwrap().to_owned();
    assert!(set_cookie.contains(&format!("Path={path}")), "{set_cookie}");
    assert!(set_cookie.contains("HttpOnly"), "{set_cookie}");
    let cookie = cookie_of(&verified);

    let opened = s
        .harness
        .send(req("GET", &path).header("cookie", &cookie))
        .await;
    assert_eq!(opened.status, 200, "{}", opened.text());
    assert_eq!(opened.json()["message"], PGP_MESSAGE);
    let accessed = s.harness.last_audit();
    assert_eq!(accessed["event"], "secret.accessed");
    assert_eq!(accessed["user_email"], GUEST);
    assert_eq!(accessed["access_method"], "email_code");

    // Multi-view: the grant opens it again while it lasts.
    let again = s
        .harness
        .send(req("GET", &path).header("cookie", &cookie))
        .await;
    assert_eq!(again.status, 200);
}

#[tokio::test]
async fn the_receipt_names_the_guest_and_the_code_method() {
    let s = setup().await;
    let created = s
        .harness
        .send(
            req("POST", "/create/secret")
                .header("cookie", &s.harness.session_cookie(SENDER))
                .json(&json!({
                    "message": PGP_MESSAGE, "expiration": 3600, "one_time": true,
                    "recipient": GUEST, "receipt": true,
                })),
        )
        .await;
    let key = created.message();
    let token = created.json()["receipt_token"].as_str().unwrap().to_owned();
    let path = format!("/secret/{key}");
    let cookie = s.grant(&path, 1).await;
    let opened = s
        .harness
        .send(req("GET", &path).header("cookie", &cookie))
        .await;
    assert_eq!(opened.status, 200);
    let receipt = s
        .harness
        .send(req("GET", &format!("{path}/receipt")).header("x-yopass-receipt-token", &token))
        .await
        .json();
    assert_eq!(receipt["state"], "viewed");
    assert_eq!(receipt["viewer_email"], GUEST);
    assert_eq!(receipt["access_method"], "email_code");
    // One-time: the grant does not outlive the secret.
    let gone = s
        .harness
        .send(req("GET", &path).header("cookie", &cookie))
        .await;
    assert_eq!(gone.status, 404);
}

#[tokio::test]
async fn the_answer_never_says_whether_a_code_was_sent() {
    let s = setup().await;
    let restricted = format!("/secret/{}", s.create_for(GUEST, json!({})).await);
    // Inside the allowed domains a recipient must sign in.
    let internal = format!(
        "/secret/{}",
        s.create_for("bob@example.com", json!({})).await
    );
    let open = format!("/secret/{}", s.harness.create_secret(false).await);
    let missing = "/secret/AbCdEf0123456789GhIjKlr";

    let expected = s.request_code(&restricted, GUEST).await;
    assert_eq!(expected.status, 202);
    s.smtp.wait_for(1).await;
    for (path, email) in [
        (restricted.as_str(), "someone@outside.test"),
        (restricted.as_str(), "not an address"),
        (internal.as_str(), "bob@example.com"),
        (open.as_str(), GUEST),
        (missing, GUEST),
    ] {
        let answer = s.request_code(path, email).await;
        assert_eq!(answer.status, expected.status, "{path} {email}");
        assert_eq!(answer.body, expected.body, "{path} {email}");
    }
    s.smtp.expect_none_beyond(1).await;
    // Matched case-insensitively, like a sign-in.
    s.request_code(&restricted, "Guest@Outside.TEST").await;
    s.smtp.wait_for(2).await;
}

#[tokio::test]
async fn a_code_is_single_use_and_five_wrong_guesses_burn_it() {
    let s = setup().await;
    let path = format!("/secret/{}", s.create_for(GUEST, json!({})).await);

    s.request_code(&path, GUEST).await;
    let code = s.code(1).await;
    assert_eq!(s.verify(&path, &code).await.status, 200);
    assert_eq!(s.verify(&path, &code).await.status, 403, "reused");

    s.request_code(&path, GUEST).await;
    let code = s.code(2).await;
    let wrong = if code == "000000" { "111111" } else { "000000" };
    for _ in 0..5 {
        let refused = s.verify(&path, wrong).await;
        assert_eq!(refused.status, 403);
        assert!(refused.header("set-cookie").is_none());
    }
    assert_eq!(s.verify(&path, &code).await.status, 403, "burnt");

    // Guessing needs the address: a link alone cannot burn the recipient's codes.
    s.request_code(&path, GUEST).await;
    let code = s.code(3).await;
    for _ in 0..6 {
        let refused = s.verify_as(&path, "someone@outside.test", wrong).await;
        assert_eq!(refused.status, 403);
    }
    assert_eq!(
        s.verify(&path, &code).await.status,
        200,
        "not burnt by strangers"
    );
    for malformed in ["", "12345", "1234567", "abcdef"] {
        assert_eq!(
            s.verify(&path, malformed).await.status,
            403,
            "{malformed:?}"
        );
    }
    let events: Vec<_> = s
        .harness
        .audit_events()
        .into_iter()
        .map(|e| e["event"].as_str().unwrap().to_owned())
        .collect();
    for event in [
        "secret.code_requested",
        "secret.code_verified",
        "secret.code_failed",
    ] {
        assert!(events.iter().any(|e| e == event), "{event} in {events:?}");
    }
}

#[tokio::test]
async fn at_most_three_codes_are_sent_per_ten_minutes_and_only_the_newest_counts() {
    let s = setup().await;
    let path = format!("/secret/{}", s.create_for(GUEST, json!({})).await);
    for _ in 0..4 {
        assert_eq!(s.request_code(&path, GUEST).await.status, 202);
    }
    let first = s.code(1).await;
    let newest = s.code(3).await;
    s.smtp.expect_none_beyond(3).await;
    if first != newest {
        assert_eq!(s.verify(&path, &first).await.status, 403, "replaced");
    }
    assert_eq!(s.verify(&path, &newest).await.status, 200);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn racing_first_requests_still_send_at_most_three_codes() {
    for (name, db) in backends() {
        let s = setup_on(db).await;
        let path = format!("/secret/{}", s.create_for(GUEST, json!({})).await);
        let requests = (0..10).map(|_| s.request_code(&path, GUEST));
        for answer in futures_util::future::join_all(requests).await {
            assert_eq!(answer.status, 202, "{name}");
        }
        s.smtp.wait_for(3).await;
        s.smtp.expect_none_beyond(3).await;
    }
}

#[tokio::test]
async fn grants_stop_working_when_codes_are_turned_off() {
    let db: std::sync::Arc<dyn yopass_server::db::Database> =
        std::sync::Arc::new(yopass_server::db::memory::MemoryDb::new());
    let on = setup_on(db.clone()).await;
    let path = format!("/secret/{}", on.create_for(GUEST, json!({})).await);
    let cookie = on.grant(&path, 1).await;
    let off = setup_full(db, |settings| {
        settings.recipient_email_code = false;
        settings.require_auth_all = true;
    })
    .await;
    for target in [path.clone(), format!("{path}/status")] {
        let answer = off
            .harness
            .send(req("GET", &target).header("cookie", &cookie))
            .await;
        assert_eq!(answer.status, 401, "{target}");
    }
}

#[tokio::test]
async fn the_code_routes_only_take_json() {
    let s = setup().await;
    let path = format!("/secret/{}", s.create_for(GUEST, json!({})).await);
    // What a cross-site form could send without a preflight.
    for content_type in [
        "text/plain",
        "application/x-www-form-urlencoded",
        "multipart/form-data",
    ] {
        for route in ["code", "code/verify"] {
            let answer = s
                .harness
                .send(
                    req("POST", &format!("{path}/{route}"))
                        .header("content-type", content_type)
                        .body(json!({ "email": GUEST, "code": "123456" }).to_string()),
                )
                .await;
            assert_eq!(answer.status, 415, "{route} {content_type}");
        }
    }
    s.smtp.expect_none_beyond(0).await;
}

#[tokio::test]
async fn a_grant_opens_only_its_own_secret_and_nothing_else() {
    let s = setup().await;
    let first = format!("/secret/{}", s.create_for(GUEST, json!({})).await);
    let second = format!("/secret/{}", s.create_for(GUEST, json!({})).await);
    let cookie = s.grant(&first, 1).await;
    let with = |r: Req| r.header("cookie", &cookie);

    assert_eq!(s.harness.send(with(req("GET", &second))).await.status, 401);
    // Viewing only: no deleting, no session, no creating.
    assert_eq!(
        s.harness.send(with(req("DELETE", &first))).await.status,
        401
    );
    assert_ne!(
        s.harness.send(with(req("GET", "/auth/me"))).await.status,
        200
    );
    let create = s
        .harness
        .send(with(req("POST", "/create/secret")).json(&json!({
            "message": PGP_MESSAGE, "expiration": 3600, "recipient": "bob@example.com",
        })))
        .await;
    assert_eq!(create.status, 401, "{}", create.text());
    assert_eq!(s.harness.send(with(req("GET", &first))).await.status, 200);
}

#[tokio::test]
async fn files_take_codes_too() {
    let s = setup().await;
    let uploaded = s
        .harness
        .send(
            upload_req(PGP_BINARY, "3600", false)
                .header("cookie", &s.harness.session_cookie(SENDER))
                .header("x-yopass-recipient", GUEST),
        )
        .await;
    assert_eq!(uploaded.status, 200, "{}", uploaded.text());
    let path = format!("/file/{}", uploaded.message());
    let cookie = s.grant(&path, 1).await;
    let downloaded = s
        .harness
        .send(req("GET", &path).header("cookie", &cookie))
        .await;
    assert_eq!(downloaded.status, 200);
    assert_eq!(downloaded.body, PGP_BINARY);
    assert_eq!(s.harness.last_audit()["access_method"], "email_code");
}

#[tokio::test]
async fn a_grant_satisfies_require_auth_all_for_its_secret() {
    let s = setup_with(|settings| settings.require_auth_all = true).await;
    let path = format!("/secret/{}", s.create_for(GUEST, json!({})).await);
    assert_eq!(s.harness.get(&path).await.status, 401);
    let cookie = s.grant(&path, 1).await;
    for target in [path.clone(), format!("{path}/status")] {
        let answer = s
            .harness
            .send(req("GET", &target).header("cookie", &cookie))
            .await;
        assert_eq!(answer.status, 200, "{target}: {}", answer.text());
    }
    let plain = s
        .harness
        .send(
            req("POST", "/create/secret")
                .header("cookie", &s.harness.session_cookie(SENDER))
                .json(&json!({ "message": PGP_MESSAGE, "expiration": 3600 })),
        )
        .await;
    let other = format!("/secret/{}", plain.message());
    let refused = s
        .harness
        .send(req("GET", &other).header("cookie", &cookie))
        .await;
    assert_eq!(refused.status, 401);
}

#[tokio::test]
async fn without_allowed_domains_every_recipient_may_use_a_code() {
    let s = setup_with(|settings| settings.allowed_email_domains.clear()).await;
    let path = format!(
        "/secret/{}",
        s.create_for("bob@example.com", json!({})).await
    );
    // Bob signs in first, which binds the secret to his account...
    let bob = s.harness.session_cookie("bob@example.com");
    let signed_in = s
        .harness
        .send(req("GET", &path).header("cookie", &bob))
        .await;
    assert_eq!(signed_in.status, 200);
    // ...and a code to his mailbox still works: the mailbox is the proof.
    assert_eq!(s.request_code(&path, "bob@example.com").await.status, 202);
    let code = s.code(1).await;
    let cookie = cookie_of(&s.verify_as(&path, "bob@example.com", &code).await);
    let opened = s
        .harness
        .send(req("GET", &path).header("cookie", &cookie))
        .await;
    assert_eq!(opened.status, 200);
}

#[tokio::test]
async fn the_mail_follows_the_browser_language() {
    let s = setup().await;
    let path = format!("/secret/{}", s.create_for(GUEST, json!({})).await);
    s.harness
        .send(
            req("POST", &format!("{path}/code"))
                .header("accept-language", "sv-SE,sv;q=0.9,en;q=0.8")
                .json(&json!({ "email": GUEST })),
        )
        .await;
    s.code(1).await;
    let english = {
        s.request_code(&path, GUEST).await;
        s.code(2).await;
        s.smtp.mails.lock().unwrap()[1].data.clone()
    };
    let swedish = s.smtp.mails.lock().unwrap()[0].data.clone();
    assert_ne!(swedish, english);
    assert!(swedish.contains("Content-Language: sv"), "{swedish}");
    assert!(english.contains("Content-Language: en"), "{english}");
}

#[tokio::test]
async fn codes_are_off_unless_enabled() {
    let s = setup_with(|settings| settings.recipient_email_code = false).await;
    let config = s.harness.get("/config").await.json();
    assert!(config["RECIPIENT_EMAIL_CODE"].is_null());
    // An address that could never sign in is refused, as before.
    let refused = s
        .harness
        .send(
            req("POST", "/create/secret")
                .header("cookie", &s.harness.session_cookie(SENDER))
                .json(&json!({
                    "message": PGP_MESSAGE, "expiration": 3600, "recipient": GUEST,
                })),
        )
        .await;
    assert_eq!(refused.status, 400);
    let path = format!(
        "/secret/{}",
        s.create_for("bob@example.com", json!({})).await
    );
    assert_eq!(s.request_code(&path, "bob@example.com").await.status, 404);

    let on = setup().await;
    assert_eq!(
        on.harness.get("/config").await.json()["RECIPIENT_EMAIL_CODE"],
        true
    );
    // Retrieval instances serve the code flow too.
    let read_only = setup_with(|settings| settings.read_only = true).await;
    assert_eq!(
        read_only.harness.get("/config").await.json()["RECIPIENT_EMAIL_CODE"],
        true
    );
}
