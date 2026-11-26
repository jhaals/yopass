//! Restricted recipients: only the named recipient, or the creator, may open
//! or delete a secret.

mod common;

use common::*;
use serde_json::json;
use yopass_server::auth::{Session, parse_api_tokens};

const SENDER: &str = "sender@example.com";
const RECIPIENT: &str = "recipient@example.com";

fn licensed() -> Harness {
    Builder::new().licensed().sessions().build()
}

async fn create_restricted(harness: &Harness, one_time: bool) -> String {
    let response = harness
        .send(
            req("POST", "/create/secret")
                .header("cookie", &harness.session_cookie(SENDER))
                .json(&json!({
                    "message": PGP_MESSAGE, "expiration": 3600, "one_time": one_time,
                    "recipient": RECIPIENT,
                })),
        )
        .await;
    assert_eq!(response.status, 200, "{}", response.text());
    response.message()
}

async fn get_as(harness: &Harness, path: &str, email: Option<&str>) -> Resp {
    let mut request = req("GET", path);
    if let Some(email) = email {
        request = request.header("cookie", &harness.session_cookie(email));
    }
    harness.send(request).await
}

#[tokio::test]
async fn only_the_recipient_opens_and_a_denial_does_not_consume() {
    let harness = licensed();
    let key = create_restricted(&harness, true).await;
    let path = format!("/secret/{key}");

    let anonymous = get_as(&harness, &path, None).await;
    assert_eq!(anonymous.status, 401, "{}", anonymous.text());
    assert!(!anonymous.text().contains(RECIPIENT));
    let stranger = get_as(&harness, &path, Some("other@example.com")).await;
    assert_eq!(stranger.status, 403, "{}", stranger.text());
    assert!(!stranger.text().contains(RECIPIENT));

    // Matched case-insensitively.
    let opened = get_as(&harness, &path, Some("Recipient@Example.com")).await;
    assert_eq!(opened.status, 200, "{}", opened.text());
    assert_eq!(opened.json()["message"], PGP_MESSAGE);
    assert!(opened.json().get("restriction").is_none());
    assert_eq!(get_as(&harness, &path, Some(RECIPIENT)).await.status, 404);
}

const TOKEN: &str = "Bearer 0123456789abcdef0123";

fn with_token() -> Harness {
    Builder::new()
        .licensed()
        .sessions()
        .settings(|s| {
            s.api_tokens = parse_api_tokens(&["ci:0123456789abcdef0123".to_string()]).unwrap();
        })
        .build()
}

async fn delete_as(harness: &Harness, path: &str, email: Option<&str>) -> Resp {
    let mut request = req("DELETE", path);
    if let Some(email) = email {
        request = request.header("cookie", &harness.session_cookie(email));
    }
    harness.send(request).await
}

#[tokio::test]
async fn the_creator_may_view_and_delete_and_so_may_the_recipient() {
    let harness = licensed();
    let key = create_restricted(&harness, false).await;
    let path = format!("/secret/{key}");
    assert_eq!(get_as(&harness, &path, Some(SENDER)).await.status, 200);
    assert_eq!(get_as(&harness, &path, Some(RECIPIENT)).await.status, 200);
    assert_eq!(delete_as(&harness, &path, None).await.status, 401);
    assert_eq!(
        delete_as(&harness, &path, Some("other@example.com"))
            .await
            .status,
        403
    );
    assert_eq!(delete_as(&harness, &path, Some(SENDER)).await.status, 204);

    let key = create_restricted(&harness, false).await;
    let path = format!("/secret/{key}");
    assert_eq!(
        delete_as(&harness, &path, Some(RECIPIENT)).await.status,
        204
    );
    assert_eq!(get_as(&harness, &path, Some(RECIPIENT)).await.status, 404);
}

#[tokio::test]
async fn an_unverified_session_is_not_the_recipient() {
    let harness = licensed();
    let key = create_restricted(&harness, false).await;
    let session = Session {
        id: "s".into(),
        sub: "u".into(),
        email: RECIPIENT.into(),
        name: String::new(),
        email_verified: false,
        api_token: false,
    };
    let response = harness
        .send(req("GET", &format!("/secret/{key}")).header("cookie", &harness.cookie_for(&session)))
        .await;
    assert_eq!(response.status, 403);
}

#[tokio::test]
async fn a_token_creates_but_never_reads_or_deletes() {
    let harness = with_token();
    let response = harness
        .send(req("POST", "/create/secret").header("authorization", TOKEN).json(&json!({
            "message": PGP_MESSAGE, "expiration": 3600, "one_time": false, "recipient": RECIPIENT,
        })))
        .await;
    assert_eq!(response.status, 200, "{}", response.text());
    let path = format!("/secret/{}", response.message());
    for method in ["GET", "DELETE"] {
        let response = harness
            .send(req(method, &path).header("authorization", TOKEN))
            .await;
        assert!(response.status == 401 || response.status == 403, "{method}");
    }
    // No creator: only the recipient may open it.
    assert_eq!(
        get_as(&harness, &path, Some("service:ci")).await.status,
        403
    );
    assert_eq!(get_as(&harness, &path, Some(RECIPIENT)).await.status, 200);
}

#[tokio::test]
async fn creation_needs_a_sign_in_a_license_and_one_address() {
    let create = async |harness: &Harness, cookie: Option<&str>, recipient: &str| {
        let mut request = req("POST", "/create/secret").json(&json!({
            "message": PGP_MESSAGE, "expiration": 3600, "recipient": recipient,
        }));
        if let Some(email) = cookie {
            request = request.header("cookie", &harness.session_cookie(email));
        }
        harness.send(request).await
    };
    let harness = licensed();
    assert_eq!(create(&harness, None, RECIPIENT).await.status, 401);
    for invalid in ["nobody", "a@example.com, b@example.com", "@example.com"] {
        assert_eq!(
            create(&harness, Some(SENDER), invalid).await.status,
            400,
            "{invalid}"
        );
    }
    let unlicensed = Builder::new().sessions().build();
    assert_eq!(
        create(&unlicensed, Some(SENDER), RECIPIENT).await.status,
        400
    );
    let no_oidc = Builder::new().licensed().build();
    assert_eq!(create(&no_oidc, None, RECIPIENT).await.status, 400);
    // An empty recipient is no restriction.
    assert_eq!(create(&no_oidc, None, "").await.status, 200);
}

/// A client cannot plant its own sealed value, nor skip the check with one.
#[tokio::test]
async fn a_client_supplied_restriction_is_ignored() {
    let harness = licensed();
    let response = harness
        .send(req("POST", "/create/secret").json(&json!({
            "message": PGP_MESSAGE, "expiration": 3600, "restriction": "forged",
        })))
        .await;
    assert_eq!(response.status, 200);
    let path = format!("/secret/{}", response.message());
    assert_eq!(harness.get(&path).await.status, 200);
}

/// A seal this instance cannot open names nobody, so nobody opens the secret.
#[tokio::test]
async fn a_changed_session_key_fails_closed() {
    let db: std::sync::Arc<dyn yopass_server::db::Database> =
        std::sync::Arc::new(yopass_server::db::memory::MemoryDb::new());
    let before = Builder::with_db(db.clone()).licensed().sessions().build();
    let key = create_restricted(&before, false).await;
    let mut builder = Builder::with_db(db).licensed().sessions();
    builder.recipient_key = [11; 32];
    let after = builder.build();
    let path = format!("/secret/{key}");
    assert_eq!(get_as(&after, &path, Some(RECIPIENT)).await.status, 403);
    assert_eq!(get_as(&after, &path, Some(SENDER)).await.status, 403);
    assert_eq!(get_as(&after, &path, None).await.status, 401);
}

#[tokio::test]
async fn status_and_config_tell_the_frontend() {
    let harness = licensed();
    let key = create_restricted(&harness, true).await;
    let status = harness.get(&format!("/secret/{key}/status")).await.json();
    assert_eq!(status["restricted"], true);
    assert_eq!(status["requireAuth"], true);
    assert!(!status.to_string().contains(RECIPIENT));
    let plain = harness.create_secret(true).await;
    let plain = harness.get(&format!("/secret/{plain}/status")).await.json();
    assert!(plain.get("restricted").is_none());
    let config = |harness: Harness| async move { harness.get("/config").await.json() };
    assert_eq!(config(licensed()).await["RESTRICTED_RECIPIENTS"], true);
    for unavailable in [
        Builder::new().sessions().build(),
        Builder::new().licensed().build(),
        Builder::new()
            .licensed()
            .sessions()
            .settings(|s| s.read_only = true)
            .build(),
    ] {
        assert!(config(unavailable).await["RESTRICTED_RECIPIENTS"].is_null());
    }
}

#[tokio::test]
async fn the_receipt_names_the_first_viewer_and_how_they_signed_in() {
    let harness = licensed();
    let response = harness
        .send(
            req("POST", "/create/secret")
                .header("cookie", &harness.session_cookie(SENDER))
                .json(&json!({
                    "message": PGP_MESSAGE, "expiration": 3600, "one_time": false,
                    "recipient": RECIPIENT, "receipt": true,
                })),
        )
        .await;
    assert_eq!(response.status, 200, "{}", response.text());
    let (key, token) = (
        response.message(),
        response.json()["receipt_token"]
            .as_str()
            .unwrap()
            .to_owned(),
    );
    let receipt = async || {
        harness
            .send(
                req("GET", &format!("/secret/{key}/receipt"))
                    .header("x-yopass-receipt-token", &token),
            )
            .await
            .json()
    };
    let pending = receipt().await;
    assert!(pending.get("viewer_email").is_none());

    let path = format!("/secret/{key}");
    // A denial is no view.
    get_as(&harness, &path, Some("other@example.com")).await;
    assert_eq!(receipt().await["state"], "pending");

    assert_eq!(get_as(&harness, &path, Some(RECIPIENT)).await.status, 200);
    let viewed = receipt().await;
    assert_eq!(viewed["state"], "viewed");
    assert_eq!(viewed["viewer_email"], RECIPIENT);
    assert_eq!(viewed["access_method"], "oidc");
    // Only the first view is recorded.
    assert_eq!(get_as(&harness, &path, Some(SENDER)).await.status, 200);
    assert_eq!(receipt().await["viewer_email"], RECIPIENT);
}

#[tokio::test]
async fn access_and_denials_are_audited_with_the_identity() {
    let harness = licensed();
    let key = create_restricted(&harness, false).await;
    let created = harness.last_audit();
    assert_eq!(created["event"], "secret.created");
    assert_eq!(created["restricted"], true);
    assert_eq!(created["user_email"], SENDER);
    assert!(!created.to_string().contains(RECIPIENT));

    let path = format!("/secret/{key}");
    get_as(&harness, &path, Some("other@example.com")).await;
    let denied = harness.last_audit();
    assert_eq!(denied["outcome"], "denied");
    assert_eq!(denied["user_email"], "other@example.com");
    assert_eq!(denied["restricted"], true);

    get_as(&harness, &path, Some(RECIPIENT)).await;
    let accessed = harness.last_audit();
    assert_eq!(accessed["outcome"], "success");
    assert_eq!(accessed["user_email"], RECIPIENT);
    assert_eq!(accessed["access_method"], "oidc");
}

/// Nothing in storage names the recipient or the creator in plain text.
#[tokio::test]
async fn storage_holds_no_plaintext_address() {
    let db = std::sync::Arc::new(yopass_server::db::memory::MemoryDb::new());
    let harness = Builder::with_db(db.clone()).licensed().sessions().build();
    let response = harness
        .send(
            req("POST", "/create/secret")
                .header("cookie", &harness.session_cookie(SENDER))
                .json(&json!({
                    "message": PGP_MESSAGE, "expiration": 3600, "one_time": false,
                    "recipient": RECIPIENT, "receipt": true,
                })),
        )
        .await;
    let key = response.message();
    get_as(&harness, &format!("/secret/{key}"), Some(RECIPIENT)).await;
    use yopass_server::db::Database;
    for stored in [key.clone(), format!("receipt/{key}")] {
        let record = format!(
            "{:?}",
            serde_json::to_string(&db.status(&stored).await.unwrap()).unwrap()
        );
        assert!(!record.contains("example.com"), "{stored}: {record}");
    }
}

#[tokio::test]
async fn files_carry_the_recipient_in_a_header() {
    let harness = licensed();
    let response = harness
        .send(
            upload_req(PGP_BINARY, "3600", true)
                .header("cookie", &harness.session_cookie(SENDER))
                .header("x-yopass-recipient", RECIPIENT),
        )
        .await;
    assert_eq!(response.status, 200, "{}", response.text());
    let key = response.message();
    let status = harness.get(&format!("/file/{key}/status")).await.json();
    assert_eq!(status["restricted"], true);
    let path = format!("/file/{key}");
    assert_eq!(get_as(&harness, &path, None).await.status, 401);
    assert_eq!(
        get_as(&harness, &path, Some("other@example.com"))
            .await
            .status,
        403
    );
    let opened = get_as(&harness, &path, Some(RECIPIENT)).await;
    assert_eq!(opened.status, 200);
    assert_eq!(opened.body, PGP_BINARY);
    assert_eq!(get_as(&harness, &path, Some(RECIPIENT)).await.status, 404);
}

#[tokio::test]
async fn a_lapsed_license_keeps_existing_restrictions() {
    let db: std::sync::Arc<dyn yopass_server::db::Database> =
        std::sync::Arc::new(yopass_server::db::memory::MemoryDb::new());
    let before = Builder::with_db(db.clone()).licensed().sessions().build();
    let key = create_restricted(&before, false).await;
    let mut lapsed = Builder::with_db(db).sessions();
    lapsed.license = expired_license();
    let lapsed = lapsed.build();
    let path = format!("/secret/{key}");
    assert_eq!(get_as(&lapsed, &path, None).await.status, 401);
    assert_eq!(
        get_as(&lapsed, &path, Some("other@example.com"))
            .await
            .status,
        403
    );
    assert_eq!(get_as(&lapsed, &path, Some(RECIPIENT)).await.status, 200);
}

/// Turning the feature off stops new restricted secrets, never the check on
/// existing ones.
#[tokio::test]
async fn off_without_verified_addresses_or_when_disabled() {
    let db: std::sync::Arc<dyn yopass_server::db::Database> =
        std::sync::Arc::new(yopass_server::db::memory::MemoryDb::new());
    let on = Builder::with_db(db.clone()).licensed().sessions().build();
    let key = create_restricted(&on, false).await;
    for off in [
        |s: &mut yopass_server::app::Settings| s.allow_unverified_email = true,
        |s: &mut yopass_server::app::Settings| s.disable_restricted_recipients = true,
    ] {
        let harness = Builder::with_db(db.clone())
            .licensed()
            .sessions()
            .settings(off)
            .build();
        assert!(harness.get("/config").await.json()["RESTRICTED_RECIPIENTS"].is_null());
        let created = harness
            .send(
                req("POST", "/create/secret")
                    .header("cookie", &harness.session_cookie(SENDER))
                    .json(&json!({
                        "message": PGP_MESSAGE, "expiration": 3600, "recipient": RECIPIENT,
                    })),
            )
            .await;
        assert_eq!(created.status, 400);
        let path = format!("/secret/{key}");
        assert_eq!(get_as(&harness, &path, None).await.status, 401);
        assert_eq!(
            get_as(&harness, &path, Some("other@example.com"))
                .await
                .status,
            403
        );
        assert_eq!(get_as(&harness, &path, Some(RECIPIENT)).await.status, 200);
    }
}

/// The answer confirms the restriction, so a client can tell a server that
/// silently ignored the field.
#[tokio::test]
async fn the_answer_confirms_the_restriction() {
    let harness = licensed();
    let response = harness
        .send(
            req("POST", "/create/secret")
                .header("cookie", &harness.session_cookie(SENDER))
                .json(&json!({
                    "message": PGP_MESSAGE, "expiration": 3600, "recipient": RECIPIENT,
                })),
        )
        .await;
    assert_eq!(response.json()["restricted"], true);
    let plain = harness
        .send(req("POST", "/create/secret").json(&json!({
            "message": PGP_MESSAGE, "expiration": 3600,
        })))
        .await;
    assert!(plain.json().get("restricted").is_none());
    let file = harness
        .send(
            upload_req(PGP_BINARY, "3600", true)
                .header("cookie", &harness.session_cookie(SENDER))
                .header("x-yopass-recipient", RECIPIENT),
        )
        .await;
    assert_eq!(file.json()["restricted"], true);
}

/// A recipient header that is present but unusable must not mean "no recipient".
#[tokio::test]
async fn an_unreadable_or_repeated_recipient_header_is_refused() {
    let harness = licensed();
    let raw = axum::http::HeaderValue::from_bytes("bøb@example.com".as_bytes()).unwrap();
    let mut requests = vec![
        upload_req(PGP_BINARY, "3600", true)
            .header("x-yopass-recipient", "%20")
            .header("x-yopass-recipient", RECIPIENT),
        upload_req(PGP_BINARY, "3600", true).header("x-yopass-recipient", "%FF"),
    ];
    requests.push(upload_req(PGP_BINARY, "3600", true).raw_header("x-yopass-recipient", raw));
    for request in requests {
        let response = harness
            .send(request.header("cookie", &harness.session_cookie(SENDER)))
            .await;
        assert_eq!(response.status, 400, "{}", response.text());
    }
}

#[tokio::test]
async fn a_recipient_that_could_never_sign_in_is_refused() {
    let harness = Builder::new()
        .licensed()
        .sessions()
        .settings(|s| s.allowed_email_domains = vec!["example.com".into()])
        .build();
    for recipient in [
        "bob@example.com\u{200b}",
        "\"x y\"@example.com",
        "bob@elsewhere.org",
    ] {
        let response = harness
            .send(
                req("POST", "/create/secret")
                    .header("cookie", &harness.session_cookie(SENDER))
                    .json(&json!({
                        "message": PGP_MESSAGE, "expiration": 3600, "recipient": recipient,
                    })),
            )
            .await;
        assert_eq!(response.status, 400, "{recipient:?}");
    }
}

#[tokio::test]
async fn browsers_may_send_the_recipient_header_cross_origin() {
    let harness = licensed();
    let response = harness
        .send(
            req("OPTIONS", "/create/file")
                .header("origin", "https://elsewhere.example")
                .header("access-control-request-method", "POST"),
        )
        .await;
    let allowed = response
        .header("access-control-allow-headers")
        .unwrap_or_default();
    assert!(allowed.contains("X-Yopass-Recipient"), "{allowed}");
}

/// The route pattern of servers that predate restricted recipients: a UUID or
/// 22 base62 characters.
fn older_servers_route(id: &str) -> bool {
    let uuid = id.len() == 36 && id.chars().filter(|c| *c == '-').count() == 4;
    uuid || (id.len() == 22 && id.chars().all(|c| c.is_ascii_alphanumeric()))
}

#[tokio::test]
async fn older_servers_cannot_even_route_a_restricted_id() {
    let harness = licensed();
    let text = create_restricted(&harness, false).await;
    let file = harness
        .send(
            upload_req(PGP_BINARY, "3600", false)
                .header("cookie", &harness.session_cookie(SENDER))
                .header("x-yopass-recipient", RECIPIENT),
        )
        .await
        .message();
    for id in [&text, &file] {
        assert!(!older_servers_route(id), "{id}");
    }
    assert!(older_servers_route(&harness.create_secret(false).await));
    let opened = get_as(&harness, &format!("/file/{file}"), Some(RECIPIENT)).await;
    assert_eq!(opened.status, 200);
}

fn as_account(harness: &Harness, email: &str, sub: &str) -> String {
    harness.cookie_for(&Session {
        id: yopass_server::util::random_hex(),
        sub: sub.into(),
        email: email.into(),
        name: "User".into(),
        email_verified: true,
        api_token: false,
    })
}

#[tokio::test]
async fn a_matching_address_from_another_account_is_refused() {
    let harness = licensed();
    let response = harness
        .send(
            req("POST", "/create/secret")
                .header("cookie", &as_account(&harness, SENDER, "sender-sub"))
                .json(&json!({
                    "message": PGP_MESSAGE, "expiration": 3600, "recipient": RECIPIENT,
                })),
        )
        .await;
    assert_eq!(response.status, 200, "{}", response.text());
    let path = format!("/secret/{}", response.message());
    let open = |email: &'static str, sub: &'static str| {
        let cookie = as_account(&harness, email, sub);
        let harness = &harness;
        let path = path.clone();
        async move {
            harness
                .send(req("GET", &path).header("cookie", &cookie))
                .await
                .status
        }
    };

    // The creator is bound to the account that created it.
    assert_eq!(open(SENDER, "impostor").await, 403);
    assert_eq!(open(SENDER, "sender-sub").await, 200);
    // The recipient is bound to the account that first opened it.
    assert_eq!(open(RECIPIENT, "first").await, 200);
    assert_eq!(open(RECIPIENT, "second").await, 403);
    let delete = |sub| {
        let cookie = as_account(&harness, RECIPIENT, sub);
        harness.send(req("DELETE", &path).header("cookie", &cookie))
    };
    assert_eq!(delete("second").await.status, 403);
    assert_eq!(open(RECIPIENT, "first").await, 200);
    assert_eq!(delete("first").await.status, 204);
}
