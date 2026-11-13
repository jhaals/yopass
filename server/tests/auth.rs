//! Authentication: session cookies, cookie authority, API tokens and OIDC against
//! a real HTTP identity provider.

mod common;

use axum::Router;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use common::*;
use jsonwebtoken::jwk::{Jwk, JwkSet};
use jsonwebtoken::{Algorithm, EncodingKey, Header};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::net::TcpListener;
use yopass_server::app::{self, App};
use yopass_server::audit::AuditLogger;
use yopass_server::auth::{CookieCodec, Oidc, OidcConfig, Session, parse_api_tokens};
use yopass_server::db::memory::MemoryDb;
use yopass_server::db::{Database, Secret};
use yopass_server::util::now_unix;

const SIGNING_KEY: &str = include_str!("fixtures/ec_private.pem");
const OTHER_KEY: &str = include_str!("fixtures/ec_other_private.pem");

fn protected(one_time: bool) -> Secret {
    Secret {
        require_auth: true,
        ..secret("ciphertext", one_time)
    }
}

fn with_sessions() -> Harness {
    Builder::new().licensed().sessions().build()
}

#[tokio::test]
async fn protected_secrets_need_a_session() {
    let harness = with_sessions();
    harness
        .app
        .db
        .put(UUID_KEY, &protected(true))
        .await
        .unwrap();
    let path = format!("/secret/{UUID_KEY}");

    let anonymous = harness.get(&path).await;
    assert_eq!(anonymous.status, 401);
    assert_eq!(anonymous.message(), "authentication required");
    let event = harness.last_audit();
    assert_eq!(event["outcome"], "denied");
    assert_eq!(event["require_auth"], true);

    // A denied read consumes nothing, and status still reports the requirement.
    let status = harness.get(&format!("{path}/status")).await;
    assert_eq!(status.json(), json!({"oneTime": true, "requireAuth": true}));

    let authenticated = harness
        .send(req("GET", &path).header("cookie", &harness.session_cookie("user@example.com")))
        .await;
    assert_eq!(authenticated.status, 200);
    assert_eq!(authenticated.json()["message"], "ciphertext");
    assert_eq!(harness.last_audit()["user_email"], "user@example.com");
    assert_eq!(harness.get(&path).await.status, 404);
}

#[tokio::test]
async fn protected_files_need_a_session_for_read_and_delete() {
    let harness = with_sessions();
    let db = &harness.app.db;
    db.put(&format!("stream:{UUID_KEY}"), &protected(false))
        .await
        .unwrap();
    db.put(
        &format!("filedata:{UUID_KEY}"),
        &Secret {
            message: "Y2lwaGVy".into(),
            expiration: 60,
            ..Secret::default()
        },
    )
    .await
    .unwrap();
    let path = format!("/file/{UUID_KEY}");
    let cookie = harness.session_cookie("user@example.com");

    assert_eq!(harness.get(&path).await.status, 401);
    assert_eq!(harness.delete(&path).await.status, 401);
    assert_eq!(
        harness
            .send(req("GET", &path).header("cookie", &cookie))
            .await
            .body,
        b"cipher"
    );
    assert_eq!(
        harness
            .send(req("DELETE", &path).header("cookie", &cookie))
            .await
            .status,
        204
    );
    assert_eq!(harness.get(&path).await.status, 404);
}

#[tokio::test]
async fn email_domain_rules_apply_on_every_request() {
    let harness = Builder::new()
        .licensed()
        .sessions()
        .settings(|s| s.allowed_email_domains = vec!["Corp.Example.com".into()])
        .build();
    harness
        .app
        .db
        .put(UUID_KEY, &protected(false))
        .await
        .unwrap();
    let path = format!("/secret/{UUID_KEY}");
    let attempt = |email: &str| {
        let cookie = harness.session_cookie(email);
        let (harness, path) = (&harness, path.clone());
        async move {
            harness
                .send(req("GET", &path).header("cookie", &cookie))
                .await
                .status
        }
    };
    assert_eq!(attempt("a@corp.example.com").await, 200);
    assert_eq!(attempt("a@CORP.EXAMPLE.COM").await, 200);
    for email in [
        "a@other.com",
        "a@corp.example.com.evil.com",
        "a@evil.com@",
        "no-at-sign",
        "@",
        "a@",
    ] {
        assert_eq!(attempt(email).await, 403, "{email}");
    }
    let denied = harness
        .send(req("DELETE", &path).header("cookie", &harness.session_cookie("a@other.com")))
        .await;
    assert_eq!(denied.status, 403);
    assert_eq!(denied.message(), "email domain not permitted");
}

#[tokio::test]
async fn forged_or_foreign_session_cookies_are_ignored() {
    let harness = with_sessions();
    harness
        .app
        .db
        .put(UUID_KEY, &protected(false))
        .await
        .unwrap();
    let path = format!("/secret/{UUID_KEY}");
    let other = CookieCodec::from_key([1; 32]);
    let session = Session {
        id: "x".into(),
        sub: "s".into(),
        email: "a@b.c".into(),
        name: "n".into(),
    };
    let forged = format!(
        "yopass_session={}",
        other.seal("yopass_session", &session, 60).unwrap()
    );
    for cookie in [
        forged.as_str(),
        "yopass_session=garbage",
        "yopass_session=",
        "yopass_session=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    ] {
        assert_eq!(
            harness
                .send(req("GET", &path).header("cookie", cookie))
                .await
                .status,
            401,
            "{cookie}"
        );
    }
    // An expired session is refused by the server, whatever the browser did.
    let codec = harness.app.sessions.as_ref().unwrap();
    let expired = format!(
        "yopass_session={}",
        codec.seal("yopass_session", &session, -1).unwrap()
    );
    assert_eq!(
        harness
            .send(req("GET", &path).header("cookie", &expired))
            .await
            .status,
        401
    );
}

/// A session must not be spendable from a page or link on another site, including
/// by a consuming GET.
#[tokio::test]
async fn foreign_origins_cannot_use_the_session() {
    let cases: Vec<(&str, &str, Vec<(&str, &str)>, u16)> = vec![
        (
            "cross-site navigation",
            "",
            vec![
                ("sec-fetch-site", "cross-site"),
                ("sec-fetch-mode", "navigate"),
            ],
            401,
        ),
        (
            "same-site image",
            "",
            vec![
                ("sec-fetch-site", "same-site"),
                ("sec-fetch-mode", "no-cors"),
            ],
            401,
        ),
        (
            "cross-site navigation, frontend set",
            "https://app.example.com",
            vec![
                ("sec-fetch-site", "cross-site"),
                ("sec-fetch-mode", "navigate"),
            ],
            401,
        ),
        (
            "cross-site fetch, frontend set",
            "https://app.example.com",
            vec![
                ("sec-fetch-site", "cross-site"),
                ("origin", "https://evil.com"),
            ],
            401,
        ),
        (
            "no fetch metadata, frontend set",
            "https://app.example.com",
            vec![("origin", "https://evil.com")],
            401,
        ),
        (
            "same-origin redirected navigation",
            "",
            vec![
                ("sec-fetch-site", "same-origin"),
                ("sec-fetch-mode", "navigate"),
            ],
            401,
        ),
        (
            "foreign origin without metadata",
            "",
            vec![("origin", "https://evil.example")],
            401,
        ),
        (
            "own explicit origin",
            "",
            vec![("origin", "http://example.com")],
            200,
        ),
        (
            "unknown fetch site",
            "",
            vec![("sec-fetch-site", "unknown")],
            401,
        ),
        (
            "bundled frontend",
            "",
            vec![("sec-fetch-site", "same-origin")],
            200,
        ),
        (
            "typed API navigation",
            "",
            vec![("sec-fetch-site", "none"), ("sec-fetch-mode", "navigate")],
            401,
        ),
        (
            "split frontend",
            "https://app.example.com",
            vec![
                ("sec-fetch-site", "cross-site"),
                ("origin", "https://app.example.com"),
            ],
            200,
        ),
        ("non-browser client", "", vec![], 200),
    ];
    for (name, frontend, headers, want) in cases {
        let frontend = frontend.to_owned();
        let harness = Builder::new()
            .licensed()
            .sessions()
            .settings(move |s| s.frontend_url = frontend)
            .build();
        harness
            .app
            .db
            .put(UUID_KEY, &protected(true))
            .await
            .unwrap();
        let mut request = req("GET", &format!("/secret/{UUID_KEY}"))
            .header("host", "example.com")
            .header("cookie", &harness.session_cookie("user@example.com"));
        for (header, value) in &headers {
            request = request.header(header, value);
        }
        let response = harness.send(request).await;
        assert_eq!(response.status, want, "{name}");
        // A refused request must leave the one-time secret intact.
        let remains = harness.app.db.status(UUID_KEY).await.is_ok();
        assert_eq!(remains, want != 200, "{name}");
    }
}

#[tokio::test]
async fn foreign_origin_cannot_create_with_a_session() {
    let (harness, _idp) = oidc_harness(|s| s.require_auth = true).await;
    let cookie = harness.session_cookie("user@example.com");
    let body = json!({ "message": PGP_MESSAGE, "expiration": 3600 });
    let response = harness
        .send(
            req("POST", "/create/secret")
                .header("cookie", &cookie)
                .header("sec-fetch-site", "cross-site")
                .json(&body),
        )
        .await;
    assert_eq!(response.status, 401);
    let own = harness
        .send(
            req("POST", "/create/secret")
                .header("cookie", &cookie)
                .header("sec-fetch-site", "same-origin")
                .json(&body),
        )
        .await;
    assert_eq!(own.status, 200);
}

#[tokio::test]
async fn logout_revokes_the_replayed_cookie_and_resists_csrf() {
    for (site, denied) in [
        ("same-site", true),
        ("cross-site", true),
        ("unexpected", true),
        ("same-origin", false),
        ("none", false),
    ] {
        let (harness, _idp) = oidc_harness(|_| {}).await;
        let cookie = harness.session_cookie("user@example.com");
        let me = || req("GET", "/auth/me").header("cookie", &cookie);
        assert_eq!(harness.send(me()).await.status, 200);
        let response = harness
            .send(
                req("POST", "/auth/logout")
                    .header("cookie", &cookie)
                    .header("sec-fetch-site", site)
                    .header("origin", "null"),
            )
            .await;
        assert_eq!(harness.last_audit()["event"], "auth.logout", "{site}");
        if denied {
            assert_eq!(response.status, 403, "{site}");
            assert!(response.headers.get("set-cookie").is_none(), "{site}");
            assert_eq!(
                harness.send(me()).await.status,
                200,
                "{site}: a rejected logout must not revoke"
            );
        } else {
            assert_eq!(response.status, 303, "{site}");
            let cleared = response.header("set-cookie").unwrap();
            assert!(cleared.contains("Max-Age=0"), "{cleared}");
            assert_eq!(
                harness.send(me()).await.status,
                401,
                "{site}: a stolen cookie must stop working"
            );
        }
    }
    // Logout has no GET route that a cross-site image could trigger.
    let (harness, _idp) = oidc_harness(|_| {}).await;
    assert_eq!(harness.get("/auth/logout").await.status, 404);
}

#[tokio::test]
async fn split_origin_logout_is_checked_by_origin() {
    let (harness, _idp) = oidc_harness(|s| s.frontend_url = "https://app.example.com".into()).await;
    let cookie = harness.session_cookie("user@example.com");
    let evil = harness
        .send(
            req("POST", "/auth/logout")
                .header("cookie", &cookie)
                .header("origin", "https://evil.example.com"),
        )
        .await;
    assert_eq!(evil.status, 403);
    let own = harness
        .send(
            req("POST", "/auth/logout")
                .header("cookie", &cookie)
                .header("origin", "https://app.example.com")
                .header("sec-fetch-site", "cross-site"),
        )
        .await;
    assert_eq!(own.status, 303);
    assert_eq!(own.header("location"), Some("https://app.example.com/"));
}

#[tokio::test]
async fn me_hides_the_session_id_and_rechecks_the_domain() {
    let (harness, _idp) =
        oidc_harness(|s| s.allowed_email_domains = vec!["example.com".into()]).await;
    assert_eq!(harness.get("/auth/me").await.status, 401);
    let ok = harness
        .send(req("GET", "/auth/me").header("cookie", &harness.session_cookie("a@example.com")))
        .await;
    assert_eq!(ok.header("cache-control"), Some("no-store"));
    let body = ok.json();
    assert_eq!(body["email"], "a@example.com");
    assert!(body.get("jti").is_none());
    let forbidden = harness
        .send(req("GET", "/auth/me").header("cookie", &harness.session_cookie("a@other.com")))
        .await;
    assert_eq!(forbidden.status, 403);
    assert_eq!(forbidden.header("cache-control"), Some("no-store"));
}

fn api_token_settings(s: &mut yopass_server::app::Settings) {
    s.require_auth = true;
    s.api_tokens = parse_api_tokens(&["ci:0123456789abcdef0123".to_string()]).unwrap();
}

#[tokio::test]
async fn api_tokens_only_open_creation() {
    let (harness, _idp) = oidc_harness(api_token_settings).await;
    let body = json!({ "message": PGP_MESSAGE, "expiration": 3600, "require_auth": true });
    let create = |token: &str| {
        req("POST", "/create/secret")
            .header("authorization", &format!("Bearer {token}"))
            .json(&body)
    };

    let denied = harness.send(create("wrong-token-wrong-token")).await;
    assert_eq!(denied.status, 401);
    assert_eq!(harness.last_audit()["error"], "invalid API token");

    let created = harness.send(create("0123456789abcdef0123")).await;
    assert_eq!(created.status, 200);
    let event = harness.last_audit();
    assert_eq!(event["user_email"], "service:ci");
    assert_eq!(event["user_subject"], "api-token:ci");

    // A creation credential is not a retrieval credential.
    let key = created.message();
    let retrieve = harness
        .send(
            req("GET", &format!("/secret/{key}"))
                .header("authorization", "Bearer 0123456789abcdef0123"),
        )
        .await;
    assert_eq!(retrieve.status, 401);

    let upload = harness
        .send(
            upload_req(PGP_BINARY, "3600", true)
                .header("authorization", "Bearer 0123456789abcdef0123"),
        )
        .await;
    assert_eq!(upload.status, 200);
    let request = harness
        .send(
            req("POST", "/request")
                .header("authorization", "Bearer 0123456789abcdef0123")
                .json(&json!({"public_key": PUBLIC_KEY, "expiration": 3600})),
        )
        .await;
    assert_eq!(request.status, 200);
    assert_eq!(
        harness
            .send(upload_req(PGP_BINARY, "3600", true))
            .await
            .status,
        401
    );
}

#[tokio::test]
async fn require_auth_gates_creation_but_a_session_also_works() {
    let (harness, _idp) = oidc_harness(|s| {
        s.require_auth = true;
        s.allowed_email_domains = vec!["example.com".into()];
    })
    .await;
    let body = json!({ "message": PGP_MESSAGE, "expiration": 3600 });
    let anonymous = harness
        .send(req("POST", "/create/secret").json(&body))
        .await;
    assert_eq!(anonymous.status, 401);
    assert_eq!(harness.last_audit()["error"], "authentication required");
    let wrong = harness
        .send(
            req("POST", "/create/secret")
                .header("cookie", &harness.session_cookie("a@other.com"))
                .json(&body),
        )
        .await;
    assert_eq!(wrong.status, 403);
    let ok = harness
        .send(
            req("POST", "/create/secret")
                .header("cookie", &harness.session_cookie("a@example.com"))
                .json(&body),
        )
        .await;
    assert_eq!(ok.status, 200);
    assert_eq!(harness.last_audit()["user_email"], "a@example.com");
    assert_eq!(harness.get("/config").await.json()["REQUIRE_AUTH"], true);
    assert_eq!(harness.get("/config").await.json()["OIDC_ENABLED"], true);
}

#[tokio::test]
async fn require_auth_all_gates_everything_but_fulfilment() {
    let id = "00000000-0000-4000-8000-000000000000";
    let gated = [
        ("POST", "/create/secret".to_owned()),
        ("POST", "/create/file".to_owned()),
        ("POST", "/request".to_owned()),
        ("GET", format!("/secret/{id}")),
        ("DELETE", format!("/secret/{id}")),
        ("GET", format!("/secret/{id}/status")),
        ("GET", format!("/secret/{id}/receipt")),
        ("GET", format!("/file/{id}")),
        ("DELETE", format!("/file/{id}")),
        ("GET", format!("/file/{id}/status")),
        ("GET", format!("/file/{id}/receipt")),
        ("DELETE", format!("/request/{id}")),
        ("GET", format!("/request/{id}/secret")),
        ("PUT", format!("/request/{id}/key")),
    ];
    let open = [
        ("GET", format!("/request/{id}")),
        ("POST", format!("/request/{id}/secret")),
        ("GET", "/config".to_owned()),
        ("OPTIONS", format!("/secret/{id}/receipt")),
    ];
    for all in [false, true] {
        let (harness, _idp) = oidc_harness(|s| {
            s.require_auth = !all; // require_auth_all alone must imply it
            s.require_auth_all = all;
            s.prefetch_secret = true;
        })
        .await;
        for (method, path) in &gated {
            let creation = path.starts_with("/create/") || path == "/request";
            let status = harness
                .send(req(method, path).json(&json!({})))
                .await
                .status;
            assert_eq!(
                status == 401,
                all || creation,
                "all={all} {method} {path}: {status}"
            );
        }
        for (method, path) in &open {
            let status = harness
                .send(req(method, path).json(&json!({})))
                .await
                .status;
            assert_ne!(status, 401, "all={all} {method} {path}");
        }
        assert_eq!(harness.get("/config").await.json()["REQUIRE_AUTH_ALL"], all);
        let signed_in = harness
            .send(
                req("GET", &format!("/secret/{id}"))
                    .header("cookie", &harness.session_cookie("a@example.com")),
            )
            .await;
        assert_ne!(signed_in.status, 401);
    }
}

#[tokio::test]
async fn require_auth_all_fails_closed_without_oidc() {
    let harness = Builder::new()
        .licensed()
        .settings(|s| s.require_auth_all = true)
        .build();
    for (method, path) in [
        ("POST", "/create/secret"),
        ("GET", "/secret/00000000-0000-4000-8000-000000000000"),
    ] {
        let status = harness
            .send(req(method, path).json(&json!({})))
            .await
            .status;
        assert_eq!(status, 401, "{method} {path}");
    }
}

/// The identity a request was authorized as stays with it, even if the session is
/// logged out concurrently: audit records must not lose their user.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn handler_keeps_the_identity_that_passed_the_gate() {
    let db = FaultDb::new(Arc::new(MemoryDb::new()));
    let (harness, _idp) = oidc_harness_with(db.clone(), |s| s.require_auth = true).await;
    let session = Session {
        id: "session-being-logged-out".into(),
        sub: "u".into(),
        email: "a@b.c".into(),
        name: "n".into(),
    };
    let cookie = harness.cookie_for(&session);
    // Revocation lands right after the gate's lookup.
    let calls = db
        .faults
        .status_calls
        .load(std::sync::atomic::Ordering::SeqCst);
    let revoke = db.clone();
    let task = tokio::spawn(async move {
        loop {
            if revoke
                .faults
                .status_calls
                .load(std::sync::atomic::Ordering::SeqCst)
                > calls
            {
                revoke
                    .inner
                    .put(
                        "session-revoked/session-being-logged-out",
                        &secret("revoked", false),
                    )
                    .await
                    .unwrap();
                return;
            }
            tokio::task::yield_now().await;
        }
    });
    let response = harness
        .send(
            req("POST", "/create/secret")
                .header("cookie", &cookie)
                .json(&json!({"message": PGP_MESSAGE, "expiration": 3600})),
        )
        .await;
    task.await.unwrap();
    assert_eq!(response.status, 200);
    assert_eq!(harness.last_audit()["user_email"], "a@b.c");
    // Later requests see the logout.
    assert_eq!(
        harness
            .send(req("GET", "/auth/me").header("cookie", &cookie))
            .await
            .status,
        401
    );
}

#[tokio::test]
async fn revocation_lookup_failure_keeps_users_signed_in() {
    let db = FaultDb::new(Arc::new(MemoryDb::new()));
    let (harness, _idp) = oidc_harness_with(db.clone(), |_| {}).await;
    let cookie = harness.session_cookie("a@example.com");
    *db.faults.status.lock().unwrap() = Some("session-revoked/");
    assert_eq!(
        harness
            .send(req("GET", "/auth/me").header("cookie", &cookie))
            .await
            .status,
        200
    );
}

#[tokio::test]
async fn cookie_attributes_follow_the_deployment() {
    let (idp, config) = FakeIdp::start().await;
    let flow = run_login(&config, &idp, |_| {}, &[]).await;
    let session = flow.session_set_cookie.unwrap();
    assert!(session.contains("HttpOnly"), "{session}");
    assert!(session.contains("SameSite=Lax"), "{session}");
    assert!(session.contains("Path=/"), "{session}");
    assert!(session.contains("Max-Age=86400"), "{session}");
    assert!(
        !session.contains("Secure"),
        "plain HTTP must not mark the cookie Secure: {session}"
    );

    let secure = run_login(&config, &idp, |_| {}, &[("x-forwarded-proto", "https")])
        .await
        .session_set_cookie
        .unwrap();
    assert!(secure.contains("Secure"), "{secure}");

    let split = run_login(
        &config,
        &idp,
        |s| s.frontend_url = "https://app.example.com".into(),
        &[("host", "api.example.com")],
    )
    .await
    .session_set_cookie
    .unwrap();
    assert!(split.contains("SameSite=None"), "{split}");
    assert!(split.contains("Secure"), "{split}");
}

#[tokio::test]
async fn untrusted_forwarded_proto_cannot_set_secure_when_proxies_are_configured() {
    let (idp, config) = FakeIdp::start().await;
    let proxy = yopass_server::app::TrustedProxy::parse("10.0.0.1").unwrap();
    let cookie = run_login(
        &config,
        &idp,
        move |s| s.trusted_proxies = vec![proxy],
        &[("x-forwarded-proto", "https")],
    )
    .await
    .session_set_cookie
    .unwrap();
    assert!(!cookie.contains("Secure"), "{cookie}");
}

// --- OIDC against a real HTTP identity provider ---

#[derive(Clone)]
struct IdpBehaviour {
    userinfo: Value,
    id_token_sub: String,
    id_token_nonce: Option<String>,
    id_token_aud: String,
    id_token_iss: Option<String>,
    id_token_exp: i64,
    signing_key: &'static str,
    published_key: &'static str,
    algorithm: Algorithm,
    omit_id_token: bool,
    fail_token: bool,
    /// Replaces the userinfo answer with this status and raw body.
    userinfo_raw: Option<(u16, String)>,
    /// Advertises only client_secret_post for the token endpoint.
    post_only: bool,
}

#[derive(Clone)]
struct FakeIdp {
    issuer: String,
    state: Arc<Mutex<IdpState>>,
}

struct IdpState {
    behaviour: IdpBehaviour,
    last_nonce: String,
    expected_verifier: Option<String>,
    token_requests: Vec<Value>,
    jwks_requests: usize,
    jwks_down: bool,
}

async fn discovery(State(idp): State<FakeIdp>) -> Response {
    let issuer = &idp.issuer;
    let methods = if idp.state.lock().unwrap().behaviour.post_only {
        json!(["client_secret_post"])
    } else {
        json!(["client_secret_basic", "client_secret_post"])
    };
    axum::Json(json!({
        "token_endpoint_auth_methods_supported": methods,
        "issuer": issuer,
        "authorization_endpoint": format!("{issuer}/authorize"),
        "token_endpoint": format!("{issuer}/token"),
        "userinfo_endpoint": format!("{issuer}/userinfo"),
        "jwks_uri": format!("{issuer}/jwks"),
        "response_types_supported": ["code"],
        "subject_types_supported": ["public"],
        "id_token_signing_alg_values_supported": ["ES256"],
    }))
    .into_response()
}

async fn jwks(State(idp): State<FakeIdp>) -> Response {
    let published = {
        let mut state = idp.state.lock().unwrap();
        state.jwks_requests += 1;
        if state.jwks_down {
            return StatusCode::SERVICE_UNAVAILABLE.into_response();
        }
        state.behaviour.published_key
    };
    let key = EncodingKey::from_ec_pem(published.as_bytes()).unwrap();
    let mut jwk = Jwk::from_encoding_key(&key, Algorithm::ES256).unwrap();
    jwk.common.key_id = Some("k1".into());
    axum::Json(JwkSet { keys: vec![jwk] }).into_response()
}

async fn token(State(idp): State<FakeIdp>, body: bytes::Bytes) -> Response {
    let form: std::collections::HashMap<String, String> =
        url::form_urlencoded::parse(&body).into_owned().collect();
    let mut state = idp.state.lock().unwrap();
    state.token_requests.push(json!(form));
    let behaviour = state.behaviour.clone();
    if behaviour.fail_token || form.get("code").map(String::as_str) != Some("good-code") {
        return (
            StatusCode::BAD_REQUEST,
            axum::Json(json!({"error": "invalid_grant"})),
        )
            .into_response();
    }
    if form.get("code_verifier").is_none_or(|v| v.len() < 43) {
        return (
            StatusCode::BAD_REQUEST,
            axum::Json(json!({"error": "invalid_request"})),
        )
            .into_response();
    }
    state.expected_verifier = form.get("code_verifier").cloned();
    let nonce = behaviour
        .id_token_nonce
        .clone()
        .unwrap_or_else(|| state.last_nonce.clone());
    let claims = json!({
        "iss": behaviour.id_token_iss.clone().unwrap_or_else(|| idp.issuer.clone()),
        "sub": behaviour.id_token_sub,
        "aud": behaviour.id_token_aud,
        "exp": behaviour.id_token_exp,
        "iat": now_unix(),
        "nonce": nonce,
    });
    let mut header = Header::new(behaviour.algorithm);
    header.kid = Some("k1".into());
    let key = if behaviour.algorithm == Algorithm::HS256 {
        // Attack: signed with the public client secret.
        EncodingKey::from_secret(b"client-secret")
    } else {
        EncodingKey::from_ec_pem(behaviour.signing_key.as_bytes()).unwrap()
    };
    let id_token = jsonwebtoken::encode(&header, &claims, &key).unwrap();
    let mut response = json!({"access_token": "access", "token_type": "Bearer", "expires_in": 3600, "id_token": id_token});
    if behaviour.omit_id_token {
        response.as_object_mut().unwrap().remove("id_token");
    }
    axum::Json(response).into_response()
}

async fn userinfo(State(idp): State<FakeIdp>, headers: HeaderMap) -> Response {
    if headers.get("authorization").and_then(|v| v.to_str().ok()) != Some("Bearer access") {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let behaviour = idp.state.lock().unwrap().behaviour.clone();
    if let Some((status, body)) = behaviour.userinfo_raw {
        return (StatusCode::from_u16(status).unwrap(), body).into_response();
    }
    axum::Json(behaviour.userinfo).into_response()
}

fn default_behaviour() -> IdpBehaviour {
    IdpBehaviour {
        userinfo: json!({"sub": "user-1", "email": "user@example.com", "email_verified": true, "name": "User"}),
        id_token_sub: "user-1".into(),
        id_token_nonce: None,
        id_token_aud: "client-id".into(),
        id_token_iss: None,
        id_token_exp: now_unix() + 600,
        signing_key: SIGNING_KEY,
        published_key: SIGNING_KEY,
        algorithm: Algorithm::ES256,
        omit_id_token: false,
        fail_token: false,
        userinfo_raw: None,
        post_only: false,
    }
}

impl FakeIdp {
    async fn start() -> (Self, OidcConfig) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let issuer = format!("http://{}", listener.local_addr().unwrap());
        let idp = Self {
            issuer: issuer.clone(),
            state: Arc::new(Mutex::new(IdpState {
                behaviour: default_behaviour(),
                last_nonce: String::new(),
                expected_verifier: None,
                token_requests: Vec::new(),
                jwks_requests: 0,
                jwks_down: false,
            })),
        };
        let router = Router::new()
            .route("/.well-known/openid-configuration", get(discovery))
            .route("/jwks", get(jwks))
            .route("/token", post(token))
            .route("/userinfo", get(userinfo))
            .with_state(idp.clone());
        tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let config = OidcConfig {
            issuer,
            client_id: "client-id".into(),
            client_secret: "client-secret".into(),
            redirect_url: "http://yopass.test/auth/callback".into(),
            session_key: String::new(),
        };
        (idp, config)
    }

    fn set(&self, mutate: impl FnOnce(&mut IdpBehaviour)) {
        mutate(&mut self.state.lock().unwrap().behaviour);
    }
}

fn harness_with_oidc(
    db: Arc<dyn Database>,
    oidc: Oidc,
    license: yopass_server::license::License,
    mutate: impl FnOnce(&mut yopass_server::app::Settings),
) -> Harness {
    let mut builder = Builder::with_db(db);
    mutate(&mut builder.settings);
    let audit = SharedBuffer::default();
    let mut app = App::new(builder.settings, builder.db, builder.files);
    app.license = license;
    app.audit_logger = Some(Arc::new(AuditLogger::new(Box::new(audit.clone()))));
    app.oidc = Some(oidc);
    app.sessions = Some(CookieCodec::from_key([9; 32]));
    let app = Arc::new(app);
    Harness {
        router: app::router(app.clone()),
        app,
        audit,
        peer: "203.0.113.9".parse().unwrap(),
    }
}

async fn oidc_harness(
    mutate: impl FnOnce(&mut yopass_server::app::Settings),
) -> (Harness, FakeIdp) {
    oidc_harness_with(Arc::new(MemoryDb::new()), mutate).await
}

async fn oidc_harness_with(
    db: Arc<dyn Database>,
    mutate: impl FnOnce(&mut yopass_server::app::Settings),
) -> (Harness, FakeIdp) {
    let (idp, config) = FakeIdp::start().await;
    let oidc = Oidc::discover(&config).await.unwrap();
    (harness_with_oidc(db, oidc, valid_license(), mutate), idp)
}

struct LoginFlow {
    harness: Harness,
    callback: Resp,
    session_set_cookie: Option<String>,
    flow_cookie: String,
    state: String,
}

fn query_param(url: &str, name: &str) -> String {
    url::Url::parse(url)
        .unwrap()
        .query_pairs()
        .find(|(k, _)| k == name)
        .map(|(_, v)| v.into_owned())
        .unwrap_or_default()
}

fn set_cookie_named(response: &Resp, name: &str) -> Option<String> {
    response
        .headers
        .get_all("set-cookie")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .find(|v| v.starts_with(&format!("{name}=")))
        .map(str::to_owned)
}

/// Starts a login and returns what the browser would hold at the redirect.
async fn begin_login(harness: &Harness, idp: &FakeIdp, extra: &[(&str, &str)]) -> (String, String) {
    let mut request = req("GET", "/auth/login");
    for (name, value) in extra {
        request = request.header(name, value);
    }
    let login = harness.send(request).await;
    assert_eq!(login.status, 302, "{}", login.text());
    let location = login.header("location").unwrap().to_owned();
    assert!(
        location.starts_with(&format!("{}/authorize", idp.issuer)),
        "{location}"
    );
    assert_eq!(
        query_param(&location, "code_challenge_method"),
        "S256",
        "PKCE is required"
    );
    assert!(!query_param(&location, "code_challenge").is_empty());
    assert!(query_param(&location, "scope").contains("openid"));
    idp.state.lock().unwrap().last_nonce = query_param(&location, "nonce");
    let cookie = set_cookie_named(&login, "yopass_oidc_flow").expect("flow cookie");
    assert!(
        cookie.contains("HttpOnly") && cookie.contains("SameSite=Lax"),
        "{cookie}"
    );
    let flow_cookie = cookie.split(';').next().unwrap().to_owned();
    (query_param(&location, "state"), flow_cookie)
}

async fn run_login(
    config: &OidcConfig,
    idp: &FakeIdp,
    mutate: impl FnOnce(&mut yopass_server::app::Settings),
    extra: &[(&str, &str)],
) -> LoginFlow {
    let oidc = Oidc::discover(config).await.unwrap();
    let harness = harness_with_oidc(Arc::new(MemoryDb::new()), oidc, valid_license(), mutate);
    let (state, flow_cookie) = begin_login(&harness, idp, extra).await;
    let mut request = req(
        "GET",
        &format!("/auth/callback?code=good-code&state={state}"),
    )
    .header("cookie", &flow_cookie);
    for (name, value) in extra {
        request = request.header(name, value);
    }
    let callback = harness.send(request).await;
    let session_set_cookie = set_cookie_named(&callback, "yopass_session");
    LoginFlow {
        harness,
        callback,
        session_set_cookie,
        flow_cookie,
        state,
    }
}

#[tokio::test]
async fn login_flow_issues_a_working_session() {
    let (idp, config) = FakeIdp::start().await;
    let flow = run_login(&config, &idp, |_| {}, &[]).await;
    assert_eq!(flow.callback.status, 302, "{}", flow.callback.text());
    assert_eq!(flow.callback.header("location"), Some("/"));
    let cookie = flow.session_set_cookie.unwrap();
    let cookie = cookie.split(';').next().unwrap();
    let me = flow
        .harness
        .send(req("GET", "/auth/me").header("cookie", cookie))
        .await
        .json();
    assert_eq!(me["email"], "user@example.com");
    assert_eq!(me["sub"], "user-1");
    assert_eq!(me["name"], "User");
    let events = flow.harness.audit_events();
    assert_eq!(events.last().unwrap()["event"], "auth.callback_success");
    assert_eq!(events.last().unwrap()["user_email"], "user@example.com");
    // The flow cookie is single use from the browser's point of view.
    let cleared = set_cookie_named(&flow.callback, "yopass_oidc_flow").unwrap();
    assert!(cleared.contains("Max-Age=0"), "{cleared}");
    // The exchange proved possession of the PKCE verifier and client secret.
    let requests = idp.state.lock().unwrap().token_requests.clone();
    assert!(requests[0]["code_verifier"].as_str().unwrap().len() >= 43);
}

/// One full login against an existing server, returning the callback's status.
async fn login_status(harness: &Harness, idp: &FakeIdp) -> StatusCode {
    let (state, flow_cookie) = begin_login(harness, idp, &[]).await;
    harness
        .send(
            req(
                "GET",
                &format!("/auth/callback?code=good-code&state={state}"),
            )
            .header("cookie", &flow_cookie),
        )
        .await
        .status
}

fn jwks_requests(idp: &FakeIdp) -> usize {
    idp.state.lock().unwrap().jwks_requests
}

fn with_oidc(oidc: Oidc) -> Harness {
    harness_with_oidc(Arc::new(MemoryDb::new()), oidc, valid_license(), |_| {})
}

#[tokio::test]
async fn signing_keys_are_cached_between_logins() {
    let (idp, config) = FakeIdp::start().await;
    // Unthrottled, so only freshness can be what prevents the fetches.
    let oidc = Oidc::discover(&config).await.unwrap();
    let harness = with_oidc(oidc.with_jwks_refetch_after(Duration::ZERO));
    for _ in 0..3 {
        assert_eq!(login_status(&harness, &idp).await, 302);
    }
    assert_eq!(jwks_requests(&idp), 1);
}

/// Providers rotate signing keys while the server keeps running, and the server
/// finds out when a token no longer verifies.
#[tokio::test]
async fn login_survives_provider_key_rotation() {
    let (idp, config) = FakeIdp::start().await;
    let oidc = Oidc::discover(&config).await.unwrap();
    let harness = with_oidc(oidc.with_jwks_refetch_after(Duration::ZERO));
    assert_eq!(login_status(&harness, &idp).await, 302);
    idp.set(|b| {
        b.signing_key = OTHER_KEY;
        b.published_key = OTHER_KEY;
    });
    assert_eq!(login_status(&harness, &idp).await, 302);
    assert_eq!(jwks_requests(&idp), 2);
    assert_eq!(login_status(&harness, &idp).await, 302);
    assert_eq!(
        jwks_requests(&idp),
        2,
        "the rotated keys must be cached too"
    );
}

/// Rotation must not be usable to bypass verification: refetched keys still decide.
#[tokio::test]
async fn refetching_does_not_accept_a_token_the_new_keys_reject() {
    let (idp, config) = FakeIdp::start().await;
    let oidc = Oidc::discover(&config).await.unwrap();
    let harness = with_oidc(oidc.with_jwks_refetch_after(Duration::ZERO));
    assert_eq!(login_status(&harness, &idp).await, 302);
    idp.set(|b| b.signing_key = OTHER_KEY);
    assert_eq!(login_status(&harness, &idp).await, 401);
    assert_eq!(jwks_requests(&idp), 2);
}

#[tokio::test]
async fn bad_tokens_cannot_flood_the_key_endpoint() {
    let (idp, config) = FakeIdp::start().await;
    let harness = with_oidc(Oidc::discover(&config).await.unwrap());
    assert_eq!(login_status(&harness, &idp).await, 302);
    idp.set(|b| b.signing_key = OTHER_KEY);
    for _ in 0..5 {
        assert_eq!(login_status(&harness, &idp).await, 401);
    }
    assert_eq!(jwks_requests(&idp), 1, "refetches must be throttled");
}

/// Only a bad signature suggests a rotation. Other failures must not cost a request.
#[tokio::test]
async fn other_token_failures_do_not_refetch() {
    let (idp, config) = FakeIdp::start().await;
    let oidc = Oidc::discover(&config).await.unwrap();
    let harness = with_oidc(oidc.with_jwks_refetch_after(Duration::ZERO));
    assert_eq!(login_status(&harness, &idp).await, 302);
    idp.set(|b| b.id_token_aud = "another-client".into());
    assert_eq!(login_status(&harness, &idp).await, 401);
    assert_eq!(jwks_requests(&idp), 1);
}

#[tokio::test]
async fn cached_keys_carry_logins_through_a_key_endpoint_outage() {
    let (idp, config) = FakeIdp::start().await;
    let oidc = Oidc::discover(&config).await.unwrap();
    // Always stale and unthrottled: every login tries the endpoint and falls back.
    let harness = with_oidc(
        oidc.with_jwks_refetch_after(Duration::ZERO)
            .with_jwks_fresh_for(Duration::ZERO),
    );
    idp.state.lock().unwrap().jwks_down = true;
    let before = jwks_requests(&idp);
    assert_eq!(login_status(&harness, &idp).await, 302);
    assert!(
        jwks_requests(&idp) > before,
        "the refetch must be attempted"
    );
    // A rotation during the outage cannot be verified, and must not be accepted.
    idp.set(|b| b.signing_key = OTHER_KEY);
    assert_eq!(login_status(&harness, &idp).await, 401);
}

#[tokio::test]
async fn login_with_string_email_verified_claim() {
    let (idp, config) = FakeIdp::start().await;
    idp.set(|b| b.userinfo["email_verified"] = json!("true"));
    assert_eq!(
        run_login(&config, &idp, |_| {}, &[]).await.callback.status,
        302
    );
}

async fn assert_rejected(
    idp: &FakeIdp,
    config: &OidcConfig,
    mutate: impl FnOnce(&mut IdpBehaviour),
    what: &str,
) {
    idp.set(|b| *b = default_behaviour());
    idp.set(mutate);
    let flow = run_login(config, idp, |_| {}, &[]).await;
    assert_ne!(flow.callback.status, 302, "{what}: login succeeded");
    assert!(flow.session_set_cookie.is_none(), "{what}: session issued");
    let event = flow.harness.last_audit();
    assert_eq!(event["event"], "auth.callback_failed", "{what}");
    assert_eq!(event["outcome"], "denied", "{what}");
}

#[tokio::test]
async fn forged_id_tokens_are_rejected() {
    let (idp, config) = FakeIdp::start().await;
    assert_rejected(
        &idp,
        &config,
        |b| b.signing_key = OTHER_KEY,
        "wrong signing key",
    )
    .await;
    assert_rejected(
        &idp,
        &config,
        |b| b.algorithm = Algorithm::HS256,
        "HS256 with the client secret",
    )
    .await;
    assert_rejected(
        &idp,
        &config,
        |b| b.id_token_nonce = Some("replayed".into()),
        "wrong nonce",
    )
    .await;
    assert_rejected(
        &idp,
        &config,
        |b| b.id_token_aud = "another-client".into(),
        "wrong audience",
    )
    .await;
    assert_rejected(
        &idp,
        &config,
        |b| b.id_token_iss = Some("https://evil.example".into()),
        "wrong issuer",
    )
    .await;
    assert_rejected(
        &idp,
        &config,
        |b| b.id_token_exp = now_unix() - 600,
        "expired",
    )
    .await;
    assert_rejected(
        &idp,
        &config,
        |b| b.omit_id_token = true,
        "missing ID token",
    )
    .await;
    assert_rejected(
        &idp,
        &config,
        |b| b.fail_token = true,
        "failed code exchange",
    )
    .await;
    assert_rejected(
        &idp,
        &config,
        |b| b.userinfo["sub"] = json!("someone-else"),
        "userinfo for another subject",
    )
    .await;
}

#[tokio::test]
async fn callback_rejects_csrf_and_replay() {
    let (idp, config) = FakeIdp::start().await;
    let flow = run_login(&config, &idp, |_| {}, &[]).await;
    let harness = flow.harness;
    let reject = |request: Req| {
        let harness = &harness;
        async move {
            let response = harness.send(request).await;
            assert_eq!(response.status, 401, "{}", response.text());
            assert!(set_cookie_named(&response, "yopass_session").is_none());
        }
    };
    let (state, cookie) = (flow.state.clone(), flow.flow_cookie.clone());
    reject(req("GET", "/auth/callback")).await;
    reject(req(
        "GET",
        &format!("/auth/callback?code=good-code&state={state}"),
    ))
    .await; // no flow cookie
    reject(req("GET", "/auth/callback?code=good-code&state=attacker").header("cookie", &cookie))
        .await;
    reject(req("GET", &format!("/auth/callback?state={state}")).header("cookie", &cookie)).await;
    reject(req("GET", "/auth/callback?code=good-code").header("cookie", &cookie)).await;
    reject(
        req(
            "GET",
            &format!("/auth/callback?code=bad-code&state={state}"),
        )
        .header("cookie", &cookie),
    )
    .await;
    // A flow cookie forged with another key, or a session cookie replayed as one.
    let forged = CookieCodec::from_key([3; 32])
        .seal(
            "yopass_oidc_flow",
            &json!({"state": "s", "nonce": "n", "pkce": "p"}),
            60,
        )
        .unwrap();
    reject(
        req("GET", "/auth/callback?code=good-code&state=s")
            .header("cookie", &format!("yopass_oidc_flow={forged}")),
    )
    .await;
}

/// A request body must not be read: the handler only looks at query parameters.
#[tokio::test]
async fn callback_ignores_the_request_body() {
    let (harness, _idp) = oidc_harness(|_| {}).await;
    let response = harness
        .send(
            req("GET", "/auth/callback")
                .header("content-type", "multipart/form-data; boundary=x")
                .body(vec![b'x'; 8 << 20]),
        )
        .await;
    assert_eq!(response.status, 401);
}

#[tokio::test]
async fn unverified_email_and_bad_domains_cannot_log_in() {
    let (idp, config) = FakeIdp::start().await;
    for verified in [json!(false), json!("false"), json!(null), json!("yes")] {
        idp.set(|b| b.userinfo["email_verified"] = verified.clone());
        let flow = run_login(&config, &idp, |_| {}, &[]).await;
        assert_eq!(flow.callback.status, 403, "{verified}");
        assert!(flow.session_set_cookie.is_none());
        assert_eq!(flow.harness.last_audit()["error"], "email not verified");
    }
    // An explicit operator opt-out, which still requires a subject.
    let flow = run_login(&config, &idp, |s| s.allow_unverified_email = true, &[]).await;
    assert_eq!(flow.callback.status, 302);
    idp.set(|b| {
        *b = default_behaviour();
        b.userinfo = json!({"email": "user@example.com", "email_verified": true});
    });
    let missing = run_login(&config, &idp, |_| {}, &[]).await;
    assert_eq!(missing.callback.status, 401);
    assert_eq!(
        missing.harness.last_audit()["error"],
        "missing subject claim"
    );

    idp.set(|b| *b = default_behaviour());
    let domain = run_login(
        &config,
        &idp,
        |s| s.allowed_email_domains = vec!["corp.com".into()],
        &[],
    )
    .await;
    assert_eq!(domain.callback.status, 403);
    assert_eq!(
        domain.harness.last_audit()["error"],
        "email domain not permitted"
    );
}

#[tokio::test]
async fn expired_license_blocks_new_logins_but_keeps_sessions_and_protection() {
    let (_idp, config) = FakeIdp::start().await;
    let oidc = Oidc::discover(&config).await.unwrap();
    let harness = harness_with_oidc(Arc::new(MemoryDb::new()), oidc, expired_license(), |_| {});
    let login = harness.get("/auth/login").await;
    assert_eq!(login.status, 302);
    assert_eq!(
        login.header("location"),
        Some("/?login_error=license_expired")
    );
    // Authentication stays on: protected secrets must not become public.
    harness
        .app
        .db
        .put(UUID_KEY, &protected(false))
        .await
        .unwrap();
    assert_eq!(
        harness.get(&format!("/secret/{UUID_KEY}")).await.status,
        401
    );
    let cookie = harness.session_cookie("a@example.com");
    assert_eq!(
        harness
            .send(req("GET", "/auth/me").header("cookie", &cookie))
            .await
            .status,
        200
    );
    assert_eq!(harness.get("/config").await.json()["OIDC_ENABLED"], true);
}

#[tokio::test]
async fn discovery_failure_is_fatal_and_config_is_checked() {
    let unreachable = OidcConfig {
        issuer: "http://127.0.0.1:1".into(),
        client_id: "c".into(),
        client_secret: String::new(),
        redirect_url: "http://x/auth/callback".into(),
        session_key: String::new(),
    };
    assert!(Oidc::discover(&unreachable).await.is_err());
    let missing = OidcConfig {
        client_id: String::new(),
        ..unreachable
    };
    assert!(Oidc::discover(&missing).await.is_err());
}

/// Without OIDC, stored protected secrets (say from another instance) stay locked.
#[tokio::test]
async fn protected_secrets_stay_locked_without_oidc() {
    let harness = harness();
    harness
        .app
        .db
        .put(UUID_KEY, &protected(true))
        .await
        .unwrap();
    assert_eq!(
        harness.get(&format!("/secret/{UUID_KEY}")).await.status,
        401
    );
    assert!(harness.app.db.status(UUID_KEY).await.is_ok());
}

#[tokio::test]
async fn userinfo_failures_reject_the_login() {
    let logs = captured_logs();
    let (idp, config) = FakeIdp::start().await;
    for (raw, reason) in [
        ((500, "{}".to_owned()), "userinfo request failed"),
        ((200, "not json".to_owned()), "invalid userinfo response"),
        // Bounded, so a hostile provider cannot exhaust memory.
        ((200, "a".repeat(2 << 20)), "userinfo request failed"),
    ] {
        idp.set(|b| b.userinfo_raw = Some(raw.clone()));
        let flow = run_login(&config, &idp, |_| {}, &[]).await;
        assert_eq!(flow.callback.status, 401, "{}", raw.0);
        assert!(flow.session_set_cookie.is_none());
        // The audit record stays generic; the operator log names the cause.
        assert_eq!(
            flow.harness.last_audit()["error"],
            "OIDC callback rejected before userinfo"
        );
        assert!(logs.text().contains(reason), "{reason} not logged");
    }
}

/// A provider that only accepts the client secret in the body gets it there.
#[tokio::test]
async fn client_secret_follows_the_provider_auth_method() {
    let (idp, config) = FakeIdp::start().await;
    for post_only in [false, true] {
        idp.set(|b| b.post_only = post_only);
        let flow = run_login(&config, &idp, |_| {}, &[]).await;
        assert_eq!(flow.callback.status, 302);
        let state = idp.state.lock().unwrap();
        let form = state.token_requests.last().unwrap();
        assert_eq!(
            form.get("client_secret").and_then(|v| v.as_str()),
            post_only.then_some("client-secret"),
            "post_only={post_only}"
        );
    }
}

#[tokio::test]
async fn a_malformed_callback_query_is_rejected() {
    let (harness, _idp) = oidc_harness(|_| {}).await;
    for query in ["code=%ZZ&state=%ZZ", "code=a&code=b&state=s"] {
        let response = harness.get(&format!("/auth/callback?{query}")).await;
        assert_eq!(response.status, 401, "{query}");
        assert!(response.headers.get("set-cookie").is_none());
    }
}

#[tokio::test]
async fn a_failed_revocation_write_still_logs_the_user_out_here() {
    let logs = captured_logs();
    let db = FaultDb::new(Arc::new(MemoryDb::new()));
    let (harness, _idp) = oidc_harness_with(db.clone(), |_| {}).await;
    let cookie = harness.session_cookie("revocation-failure@example.com");
    *db.faults.put.lock().unwrap() = Some(yopass_server::auth::REVOKED_SESSION_PREFIX);
    let response = harness
        .send(req("POST", "/auth/logout").header("cookie", &cookie))
        .await;
    assert_eq!(response.status, 303);
    assert!(response.header("set-cookie").unwrap().contains("Max-Age=0"));
    assert!(logs.text().contains("failed to revoke session"));
}

#[tokio::test]
async fn bearer_tokens_need_the_scheme_and_a_configured_token() {
    let (harness, _idp) = oidc_harness(|s| {
        api_token_settings(s);
        s.allowed_email_domains = vec!["corp.example.com".into()];
    })
    .await;
    let body = json!({ "message": PGP_MESSAGE, "expiration": 3600 });
    let create = |authorization: &str| {
        req("POST", "/create/secret")
            .header("authorization", authorization)
            .json(&body)
    };
    // A service token is not subject to the email domain rule.
    assert_eq!(
        harness
            .send(create("bearer 0123456789abcdef0123"))
            .await
            .status,
        200
    );
    for refused in [
        "Basic 0123456789abcdef0123",
        "Bearer",
        "Bearer ",
        "0123456789abcdef0123",
        "Bearer 0123456789abcdef012",
        "Bearer 0123456789abcdef01234",
    ] {
        assert_eq!(
            harness.send(create(refused)).await.status,
            401,
            "{refused:?}"
        );
    }

    // Without configured tokens a bearer header grants nothing.
    let (plain, _idp) = oidc_harness(|s| s.require_auth = true).await;
    let response = plain.send(create("Bearer 0123456789abcdef0123")).await;
    assert_eq!(response.status, 401);
}

#[tokio::test]
async fn a_frontend_on_an_explicit_port_is_same_origin() {
    let (idp, config) = FakeIdp::start().await;
    let session = run_login(
        &config,
        &idp,
        |s| s.frontend_url = "https://app.example.com:8443".into(),
        &[
            ("host", "app.example.com:8443"),
            ("x-forwarded-proto", "https"),
        ],
    )
    .await
    .session_set_cookie
    .unwrap();
    assert!(session.contains("SameSite=Lax"), "{session}");
}
