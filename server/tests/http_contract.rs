//! The public HTTP contract: routes per feature flag, /config keys, exact error
//! bodies and headers. Clients depend on these, so refactors must not drift them.

mod common;

use common::*;
use serde_json::{Value, json};
use std::collections::BTreeSet;
use yopass_server::db::Secret;

async fn seeded(builder: Builder) -> Harness {
    let harness = builder.build();
    let db = &harness.app.db;
    db.put(
        UUID_KEY,
        &Secret {
            message: "***ENCRYPTED***".into(),
            expiration: 60,
            ..Secret::default()
        },
    )
    .await
    .unwrap();
    db.put(
        &format!("stream:{UUID_KEY}"),
        &Secret {
            expiration: 60,
            ..Secret::default()
        },
    )
    .await
    .unwrap();
    db.put(
        &format!("filedata:{UUID_KEY}"),
        &Secret {
            message: "cGdwLWRhdGE=".into(),
            expiration: 60,
            ..Secret::default()
        },
    )
    .await
    .unwrap();
    harness
}

fn secret_body() -> Value {
    json!({ "message": PGP_MESSAGE, "expiration": 3600, "one_time": true })
}

async fn probe(builder: fn() -> Builder, method: &str, path: &str, body: Option<Value>, want: u16) {
    let harness = seeded(builder()).await;
    let mut request = req(method, path);
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = harness.send(request).await;
    assert_eq!(
        response.status,
        want,
        "{method} {path}: {}",
        response.text()
    );
}

async fn upload_probe(builder: fn() -> Builder, want: u16) {
    let harness = seeded(builder()).await;
    let response = harness.send(upload_req(PGP_BINARY, "3600", true)).await;
    assert_eq!(
        response.status,
        want,
        "POST /create/file: {}",
        response.text()
    );
}

#[tokio::test]
async fn routes_on_a_default_unlicensed_server() {
    let b: fn() -> Builder = Builder::new;
    let s = format!("/secret/{UUID_KEY}");
    let f = format!("/file/{UUID_KEY}");
    probe(b, "POST", "/create/secret", Some(secret_body()), 200).await;
    probe(b, "GET", &s, None, 200).await;
    probe(b, "GET", &format!("{s}/status"), None, 200).await;
    probe(b, "DELETE", &s, None, 204).await;
    upload_probe(b, 200).await;
    probe(b, "GET", &f, None, 200).await;
    probe(b, "GET", &format!("{f}/status"), None, 200).await;
    probe(b, "DELETE", &f, None, 204).await;
    probe(b, "POST", "/request", None, 404).await;
    probe(b, "GET", "/auth/login", None, 404).await;
    probe(b, "GET", "/config", None, 200).await;
    probe(b, "GET", "/health", None, 200).await;
    probe(b, "GET", "/ready", None, 200).await;
    probe(b, "GET", "/version", None, 200).await;
    probe(b, "OPTIONS", "/create/secret", None, 200).await;
    probe(b, "OPTIONS", "/create/file", None, 200).await;
    probe(b, "OPTIONS", &f, None, 200).await;
    probe(b, "OPTIONS", &format!("{s}/receipt"), None, 200).await;
    probe(b, "OPTIONS", "/config", None, 200).await;
}

#[tokio::test]
async fn read_only_keeps_retrieval_and_removes_creation() {
    let b: fn() -> Builder = || Builder::new().settings(|s| s.read_only = true);
    probe(b, "POST", "/create/secret", Some(secret_body()), 404).await;
    upload_probe(b, 404).await;
    probe(b, "GET", &format!("/secret/{UUID_KEY}"), None, 200).await;
    probe(b, "GET", &format!("/file/{UUID_KEY}"), None, 200).await;
    probe(b, "DELETE", &format!("/secret/{UUID_KEY}"), None, 204).await;
}

#[tokio::test]
async fn disabled_upload_removes_every_file_route() {
    let b: fn() -> Builder = || Builder::new().settings(|s| s.disable_upload = true);
    upload_probe(b, 404).await;
    probe(b, "GET", &format!("/file/{UUID_KEY}"), None, 404).await;
    probe(b, "DELETE", &format!("/file/{UUID_KEY}"), None, 404).await;
    probe(b, "GET", &format!("/file/{UUID_KEY}/status"), None, 404).await;
    probe(b, "POST", "/create/secret", Some(secret_body()), 200).await;
}

#[tokio::test]
async fn disabled_prefetch_removes_status_routes() {
    let b: fn() -> Builder = || Builder::new().settings(|s| s.prefetch_secret = false);
    probe(b, "GET", &format!("/secret/{UUID_KEY}/status"), None, 404).await;
    probe(b, "GET", &format!("/file/{UUID_KEY}/status"), None, 404).await;
}

#[tokio::test]
async fn secret_request_routes_follow_the_license() {
    let licensed: fn() -> Builder = || Builder::new().licensed();
    probe(licensed, "POST", "/request", Some(json!({})), 400).await;
    let read_only: fn() -> Builder = || Builder::new().licensed().settings(|s| s.read_only = true);
    probe(read_only, "POST", "/request", Some(json!({})), 404).await;
    let disabled: fn() -> Builder = || {
        Builder::new()
            .licensed()
            .settings(|s| s.disable_secret_requests = true)
    };
    probe(disabled, "POST", "/request", Some(json!({})), 404).await;
    // An expired license stops creation but keeps routes draining.
    let expired: fn() -> Builder = || {
        let mut b = Builder::new();
        b.license = expired_license();
        b
    };
    probe(expired, "POST", "/request", Some(json!({})), 403).await;
    probe(expired, "GET", &format!("/request/{UUID_KEY}"), None, 404).await;
}

#[tokio::test]
async fn malformed_keys_are_plain_not_found() {
    let harness = seeded(Builder::new()).await;
    for path in [
        "/secret/short",
        "/secret/12345678-1234-1234-1234-12345678901",
        "/secret/ABCDEF78-1234-1234-1234-123456789012",
        "/secret/..%2f..%2fetc%2fpasswd",
        "/secret/abc%0d%0aflush_all",
        "/file/short",
        "/file/%2e%2e",
        "/secret/short/status",
        "/secret/short/receipt",
    ] {
        let response = harness.get(path).await;
        assert_eq!(response.status, 404, "{path}");
        assert!(!response.text().contains("ENCRYPTED"), "{path}");
    }
    assert_eq!(harness.delete("/secret/short").await.status, 404);
    // Nothing got past validation to touch stored data.
    assert_eq!(
        harness.get(&format!("/secret/{UUID_KEY}")).await.status,
        200
    );
}

/// Internal records live under prefixes the key pattern cannot match.
#[tokio::test]
async fn internal_namespaces_are_unreachable_through_secret_routes() {
    let harness = seeded(Builder::new().licensed()).await;
    let db = &harness.app.db;
    for prefix in [
        "request/",
        "receipt/",
        "session-revoked/",
        "claim:",
        "filedata:",
        "stream:",
    ] {
        db.put(
            &format!("{prefix}{UUID_KEY}"),
            &Secret {
                message: "internal".into(),
                expiration: 60,
                ..Secret::default()
            },
        )
        .await
        .unwrap();
        for path in [
            format!("/secret/{prefix}{UUID_KEY}"),
            format!("/secret/{}{UUID_KEY}", prefix.replace('/', "%2f")),
        ] {
            let response = harness.get(&path).await;
            assert_eq!(response.status, 404, "{path}");
            assert!(!response.text().contains("internal"), "{path}");
        }
    }
}

async fn config_keys(builder: Builder) -> BTreeSet<String> {
    let response = seeded(builder).await.get("/config").await;
    assert_eq!(response.status, 200);
    response
        .json()
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect()
}

fn set(keys: &[&str]) -> BTreeSet<String> {
    keys.iter().map(|k| (*k).to_owned()).collect()
}

#[tokio::test]
async fn config_keys_match_the_go_server() {
    assert_eq!(
        config_keys(Builder::new()).await,
        set(&[
            "ALLOW_CUSTOM_EXPIRATION",
            "ARGON2",
            "DEFAULT_EXPIRY",
            "DEFAULT_ONETIME_SECRETS",
            "DEFAULT_READ_RECEIPT",
            "DISABLE_FEATURES",
            "DISABLE_ONE_CLICK_LINK",
            "DISABLE_UPLOAD",
            "FORCE_ONETIME_SECRETS",
            "MAX_EXPIRATION",
            "MAX_FILE_SIZE",
            "MIN_EXPIRATION",
            "NO_LANGUAGE_SWITCHER",
            "NO_THEME_SWITCHER",
            "OIDC_ENABLED",
            "PREFETCH_SECRET",
            "READ_ONLY",
            "READ_RECEIPTS",
            "REQUIRE_AUTH",
            "REQUIRE_AUTH_ALL",
            "SECRET_REQUESTS",
            "SECRET_REQUESTS_DRAINING",
            "THEME_DARK",
            "THEME_LIGHT",
        ])
    );
    let full = Builder::new().licensed().settings(|s| {
        s.force_expiration = "1d".into();
        s.privacy_notice_url = "https://example.com/privacy".into();
        s.imprint_url = "https://example.com/imprint".into();
        s.public_url = "https://secrets.example.com".into();
        s.logo_url = "/logo.svg".into();
        s.app_name = "Example Secrets".into();
        s.theme_custom_light = r#"{"--color-primary":"red"}"#.into();
        s.theme_custom_dark = r#"{"--color-primary":"blue"}"#.into();
    });
    assert_eq!(
        config_keys(full).await,
        set(&[
            "ALLOW_CUSTOM_EXPIRATION",
            "APP_NAME",
            "ARGON2",
            "DEFAULT_EXPIRY",
            "DEFAULT_ONETIME_SECRETS",
            "DEFAULT_READ_RECEIPT",
            "DISABLE_FEATURES",
            "DISABLE_ONE_CLICK_LINK",
            "DISABLE_UPLOAD",
            "FORCE_EXPIRATION",
            "FORCE_ONETIME_SECRETS",
            "IMPRINT_URL",
            "LOGO_URL",
            "MAX_EXPIRATION",
            "MAX_FILE_SIZE",
            "MAX_REQUEST_FILE_SIZE",
            "MAX_REQUEST_NOTE_LENGTH",
            "MIN_EXPIRATION",
            "NO_LANGUAGE_SWITCHER",
            "NO_THEME_SWITCHER",
            "OIDC_ENABLED",
            "PREFETCH_SECRET",
            "PRIVACY_NOTICE_URL",
            "PUBLIC_URL",
            "READ_ONLY",
            "READ_RECEIPTS",
            "REQUIRE_AUTH",
            "REQUIRE_AUTH_ALL",
            "SECRET_REQUESTS",
            "SECRET_REQUESTS_DRAINING",
            "THEME_CUSTOM_DARK",
            "THEME_CUSTOM_LIGHT",
            "THEME_DARK",
            "THEME_LIGHT",
        ])
    );
}

#[tokio::test]
async fn config_values() {
    let response = Builder::new()
        .settings(|s| {
            s.default_expiry = "1d".into();
            s.max_file_size = 512 * 1024;
            s.default_onetime_secrets = false;
            s.theme_light = "ignored-without-license".into();
            s.logo_url = "/hidden-without-license.svg".into();
        })
        .build()
        .get("/config")
        .await;
    let config = response.json();
    assert_eq!(config["DEFAULT_EXPIRY"], 86400);
    assert_eq!(config["MAX_FILE_SIZE"], "512KB");
    assert_eq!(config["DEFAULT_ONETIME_SECRETS"], false);
    assert_eq!(config["MIN_EXPIRATION"], 60);
    assert_eq!(config["MAX_EXPIRATION"], 90 * 86400);
    // Branding needs a license.
    assert_eq!(config["THEME_LIGHT"], "emerald");
    assert_eq!(config["THEME_DARK"], "dim");
    assert!(config.get("LOGO_URL").is_none());
    // A read-only instance reports no receipts even with a valid license.
    let read_only = Builder::new()
        .licensed()
        .settings(|s| s.read_only = true)
        .build()
        .get("/config")
        .await
        .json();
    assert_eq!(read_only["READ_RECEIPTS"], false);
    assert_eq!(read_only["SECRET_REQUESTS"], false);
    let licensed = Builder::new()
        .licensed()
        .build()
        .get("/config")
        .await
        .json();
    assert_eq!(licensed["READ_RECEIPTS"], true);
    assert_eq!(licensed["SECRET_REQUESTS"], true);
    assert_eq!(licensed["MAX_REQUEST_FILE_SIZE"], "512KB");
    let mut draining = Builder::new();
    draining.license = expired_license();
    let draining = draining.build().get("/config").await.json();
    assert_eq!(draining["SECRET_REQUESTS"], false);
    assert_eq!(draining["SECRET_REQUESTS_DRAINING"], true);
}

#[tokio::test]
async fn expired_license_lowers_a_licensed_file_size() {
    let mut builder = Builder::new().settings(|s| s.max_file_size = 10 << 20);
    builder.license = expired_license();
    assert_eq!(
        builder.build().get("/config").await.json()["MAX_FILE_SIZE"],
        "1MB"
    );
    let licensed = Builder::new()
        .licensed()
        .settings(|s| s.max_file_size = 10 << 20)
        .build();
    assert_eq!(
        licensed.get("/config").await.json()["MAX_FILE_SIZE"],
        "10MB"
    );
}

async fn policy_error(builder: Builder, body: Value, want: u16, message: &str) {
    let response = seeded(builder)
        .await
        .send(req("POST", "/create/secret").json(&body))
        .await;
    assert_eq!(response.status, want, "{}", response.text());
    assert_eq!(response.message(), message);
}

#[tokio::test]
async fn creation_policy_errors_are_exact() {
    let raw = seeded(Builder::new())
        .await
        .send(req("POST", "/create/secret").body("{not json"))
        .await;
    assert_eq!(raw.status, 400);
    assert_eq!(raw.message(), "Unable to parse json");
    let with = |key: &str, value: Value| {
        let mut body = secret_body();
        body[key] = value;
        body
    };
    policy_error(
        Builder::new(),
        with("message", json!("plaintext")),
        400,
        "Message must be PGP encrypted",
    )
    .await;
    policy_error(
        Builder::new(),
        with("expiration", json!(123)),
        400,
        "Invalid expiration specified",
    )
    .await;
    policy_error(
        Builder::new(),
        with("expiration", json!(0)),
        400,
        "Invalid expiration specified",
    )
    .await;
    policy_error(
        Builder::new(),
        with("expiration", json!(-3600)),
        400,
        "Invalid expiration specified",
    )
    .await;
    policy_error(
        Builder::new().settings(|s| s.force_expiration = "1d".into()),
        secret_body(),
        400,
        "Expiration does not match server policy",
    )
    .await;
    policy_error(
        Builder::new(),
        with("require_auth", json!(true)),
        400,
        "Authentication not configured on this server",
    )
    .await;
    policy_error(
        Builder::new().settings(|s| s.force_onetime_secrets = true),
        with("one_time", json!(false)),
        400,
        "Secret must be one time download",
    )
    .await;
    policy_error(
        Builder::new().settings(|s| s.max_length = 10),
        secret_body(),
        400,
        "The encrypted message is too long",
    )
    .await;
    policy_error(
        Builder::new(),
        with("receipt", json!(true)),
        400,
        "Read receipts are not enabled on this server",
    )
    .await;
    // Missing fields and wrong types.
    policy_error(
        Builder::new(),
        json!({"expiration": 3600}),
        400,
        "Message must be PGP encrypted",
    )
    .await;
    policy_error(
        Builder::new(),
        with("one_time", json!("yes")),
        400,
        "Unable to parse json",
    )
    .await;
    policy_error(
        Builder::new(),
        with("expiration", json!(1e30)),
        400,
        "Unable to parse json",
    )
    .await;
}

#[tokio::test]
async fn oversized_bodies_are_rejected_before_buffering() {
    let harness = Builder::new().settings(|s| s.max_length = 100).build();
    let response = harness
        .send(
            req("POST", "/create/secret")
                .body(format!(r#"{{"message":"{}"}}"#, "x".repeat(10_000))),
        )
        .await;
    assert_eq!(response.status, 413);
    assert_eq!(response.message(), "Request body too large");
}

#[tokio::test]
async fn custom_expiration_bounds() {
    let harness = Builder::new()
        .settings(|s| {
            s.allow_custom_expiration = true;
            s.min_expiration = 120;
            s.max_expiration = 86400;
        })
        .build();
    let create = |expiration: i64| {
        let harness = &harness;
        async move {
            harness
                .send(
                    req("POST", "/create/secret")
                        .json(&json!({"message": PGP_MESSAGE, "expiration": expiration})),
                )
                .await
                .status
        }
    };
    assert_eq!(create(120).await, 200);
    assert_eq!(create(86400).await, 200);
    assert_eq!(create(119).await, 400);
    assert_eq!(create(86401).await, 400);
    assert_eq!(create(0).await, 400);
    assert_eq!(create(-1).await, 400);
    assert_eq!(create(i64::from(i32::MAX) + 1).await, 400);
}

#[tokio::test]
async fn security_headers_cover_every_response() {
    let harness =
        seeded(Builder::new().settings(|s| s.logo_url = "https://cdn.example.com/logo.svg".into()))
            .await;
    for path in [
        "/config".to_owned(),
        format!("/secret/{UUID_KEY}"),
        "/nope".to_owned(),
    ] {
        let response = harness.get(&path).await;
        assert_eq!(
            response.header("x-content-type-options"),
            Some("nosniff"),
            "{path}"
        );
        assert_eq!(response.header("x-frame-options"), Some("DENY"), "{path}");
        assert_eq!(
            response.header("referrer-policy"),
            Some("no-referrer"),
            "{path}"
        );
        assert_eq!(
            response.header("x-xss-protection"),
            Some("1; mode=block"),
            "{path}"
        );
        assert_eq!(response.header("strict-transport-security"), None, "{path}");
        let csp = response.header("content-security-policy").unwrap();
        assert!(csp.contains("frame-ancestors 'none'"), "{csp}");
        assert!(csp.contains("default-src 'self'"), "{csp}");
        assert!(
            csp.contains("'wasm-unsafe-eval'"),
            "Argon2 decryption needs WebAssembly: {csp}"
        );
        assert!(
            csp.contains("img-src 'self' data: https://cdn.example.com"),
            "{csp}"
        );
    }
    let https = harness
        .send(req("GET", "/config").header("x-forwarded-proto", "https"))
        .await;
    assert_eq!(
        https.header("strict-transport-security"),
        Some("max-age=31536000")
    );
}

#[tokio::test]
async fn sensitive_responses_are_never_cacheable() {
    let harness = Builder::new().licensed().sessions().build();
    let key = harness.create_secret(false).await;
    let file = harness.upload(false).await;
    for path in [
        format!("/secret/{key}"),
        format!("/secret/{key}/status"),
        format!("/secret/{UUID_KEY}"),
        format!("/secret/{UUID_KEY}/status"),
        format!("/file/{file}"),
        format!("/file/{file}/status"),
        format!("/file/{UUID_KEY}"),
        format!("/file/{UUID_KEY}/status"),
        format!("/secret/{key}/receipt"),
        format!("/request/{UUID_KEY}"),
        format!("/request/{UUID_KEY}/secret"),
    ] {
        let response = harness.get(&path).await;
        assert_eq!(
            response.header("cache-control"),
            Some("no-store"),
            "{path}: {}",
            response.status
        );
    }
}

#[tokio::test]
async fn cors_with_a_wildcard() {
    let harness = harness();
    let response = harness.send(req("OPTIONS", "/create/secret")).await;
    assert_eq!(response.status, 200);
    assert_eq!(response.header("access-control-allow-origin"), Some("*"));
    assert_eq!(
        response.header("access-control-allow-methods"),
        Some("POST, OPTIONS")
    );
    assert_eq!(
        response.header("access-control-allow-headers"),
        Some("Content-Type")
    );
    let stream = harness.send(req("OPTIONS", "/create/file")).await;
    assert_eq!(
        stream.header("access-control-allow-headers"),
        Some(
            "Content-Type, X-Yopass-Expiration, X-Yopass-OneTime, X-Yopass-RequireAuth, X-Yopass-Receipt"
        )
    );
    assert_eq!(
        stream.header("access-control-expose-headers"),
        Some("Content-Length")
    );
}

#[tokio::test]
async fn split_origin_cors_blocks_foreign_writes() {
    let harness = Builder::new()
        .settings(|s| s.frontend_url = "https://APP.example.com:443/path".into())
        .build();
    let key = harness.create_secret(false).await;

    let allowed = harness
        .send(req("GET", "/config").header("origin", "https://app.example.com"))
        .await;
    assert_eq!(
        allowed.header("access-control-allow-origin"),
        Some("https://app.example.com")
    );
    assert_eq!(
        allowed.header("access-control-allow-credentials"),
        Some("true")
    );
    assert!(
        allowed
            .header("vary")
            .is_some_and(|v| v.eq_ignore_ascii_case("origin"))
    );

    let denied = harness
        .send(req("DELETE", &format!("/secret/{key}")).header("origin", "https://evil.example.com"))
        .await;
    assert_eq!(denied.status, 403);
    assert_eq!(
        harness.get(&format!("/secret/{key}/status")).await.status,
        200,
        "the foreign delete must not apply"
    );

    let own = harness
        .send(req("DELETE", &format!("/secret/{key}")).header("origin", "https://app.example.com"))
        .await;
    assert_eq!(own.status, 204);
}

#[tokio::test]
async fn health_and_readiness() {
    let db = FaultDb::new(std::sync::Arc::new(
        yopass_server::db::memory::MemoryDb::new(),
    ));
    let harness = Builder::with_db(db.clone())
        .settings(|s| s.version = "next-1".into())
        .build();
    let health = harness.get("/health").await;
    assert_eq!(health.json(), json!({"status": "healthy"}));
    assert_eq!(
        health.header("cache-control"),
        Some("no-cache, no-store, must-revalidate")
    );
    assert_eq!(
        harness.get("/ready").await.json(),
        json!({"status": "ready"})
    );
    assert_eq!(
        harness.get("/version").await.json(),
        json!({"version": "next-1"})
    );
    assert_eq!(harness.send(req("HEAD", "/health")).await.status, 200);

    db.faults
        .health
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let ready = harness.get("/ready").await;
    assert_eq!(ready.status, 503);
    assert_eq!(
        ready.json(),
        json!({"status": "not ready", "error": "database connectivity failed"})
    );
    assert_eq!(
        harness.get("/health").await.status,
        200,
        "liveness must not depend on the database"
    );
}

#[tokio::test]
async fn static_assets_need_a_configured_path_and_stay_inside_it() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("index.html"), "<html>index</html>").unwrap();
    std::fs::write(dir.path().join("yopass.svg"), "<svg/>").unwrap();
    let outside = dir
        .path()
        .parent()
        .unwrap()
        .join(format!("yopass-outside-{}", std::process::id()));
    std::fs::write(&outside, "outside").unwrap();

    let served = {
        let path = dir.path().to_str().unwrap().to_owned();
        Builder::new()
            .settings(move |s| s.asset_path = path)
            .build()
    };
    assert_eq!(served.get("/").await.text(), "<html>index</html>");
    assert_eq!(served.get("/logo").await.text(), "<svg/>");
    let name = outside.file_name().unwrap().to_str().unwrap();
    for path in [
        format!("/../{name}"),
        format!("/%2e%2e/{name}"),
        format!("/..%2f{name}"),
        format!("/%2e%2e%2f{name}"),
        format!("/.//..//{name}"),
    ] {
        let response = served.get(&path).await;
        assert_eq!(response.status, 404, "{path}");
        assert!(!response.text().contains("outside"), "{path}");
    }
    std::fs::remove_file(&outside).unwrap();

    // An empty path must mean nothing, never the working directory.
    let empty = harness();
    assert_eq!(empty.get("/Cargo.toml").await.status, 404);
    assert_eq!(empty.get("/logo").await.status, 404);
    assert_eq!(empty.get("/").await.status, 404);
    assert_eq!(empty.send(req("POST", "/whatever")).await.status, 404);
}

#[tokio::test]
async fn metrics_use_templates_and_bounded_labels() {
    let harness = harness();
    let key = harness.create_secret(false).await;
    harness.get(&format!("/secret/{key}")).await;
    harness.send(req("FOOBAR", "/config")).await;
    let metrics = String::from_utf8(harness.app.metrics.render()).unwrap();
    assert!(
        metrics
            .contains(r#"yopass_http_requests_total{code="200",method="GET",path="/secret/:key"}"#),
        "{metrics}"
    );
    assert!(metrics.contains(r#"method="<other>""#), "{metrics}");
    assert!(
        !metrics.contains(&key),
        "metrics must not contain secret IDs"
    );
    assert!(
        !metrics.contains("FOOBAR"),
        "metrics must not contain client-chosen labels"
    );
}

#[tokio::test]
async fn client_ip_trusts_only_configured_proxies() {
    use yopass_server::app::TrustedProxy;
    let case = |proxies: &[&str], peer: &str, forwarded: &[&str], want: &str| {
        let proxies: Vec<TrustedProxy> = proxies
            .iter()
            .map(|p| TrustedProxy::parse(p).unwrap())
            .collect();
        let mut harness = Builder::new()
            .licensed()
            .settings(move |s| s.trusted_proxies = proxies)
            .build();
        harness.peer = peer.parse().unwrap();
        let forwarded: Vec<String> = forwarded.iter().map(|f| (*f).to_owned()).collect();
        let want = want.to_owned();
        async move {
            let mut request = req("GET", &format!("/secret/{UUID_KEY}"));
            for value in &forwarded {
                request = request.header("x-forwarded-for", value);
            }
            harness.send(request).await;
            assert_eq!(
                harness.last_audit()["client_ip"],
                want.as_str(),
                "{forwarded:?}"
            );
        }
    };
    let proxy = "192.168.1.100";
    case(&[], proxy, &["203.0.113.10"], proxy).await;
    case(&[proxy], proxy, &["203.0.113.10"], "203.0.113.10").await;
    case(&["192.168.1.200"], proxy, &["203.0.113.10"], proxy).await;
    case(
        &["192.168.1.0/24"],
        proxy,
        &["203.0.113.10"],
        "203.0.113.10",
    )
    .await;
    // A client-supplied prefix is ignored: the nearest untrusted hop wins.
    case(&[proxy], proxy, &["1.2.3.4, 203.0.113.10"], "203.0.113.10").await;
    case(
        &[proxy],
        proxy,
        &["1.2.3.4", "203.0.113.10"],
        "203.0.113.10",
    )
    .await;
    case(
        &[proxy, "10.0.0.0/8"],
        proxy,
        &["203.0.113.10, 10.0.0.5"],
        "203.0.113.10",
    )
    .await;
    case(
        &[proxy, "10.0.0.0/8"],
        proxy,
        &["10.0.0.6, 10.0.0.5"],
        proxy,
    )
    .await;
    // Garbage in the chain stops trust instead of being logged.
    case(&[proxy], proxy, &["not-an-ip"], proxy).await;
}

#[tokio::test]
async fn readiness_covers_the_file_store() {
    let dir = tempfile::tempdir().unwrap();
    let store = yopass_server::files::disk::DiskFileStore::new(dir.path()).unwrap();
    let harness = Builder::new().files(std::sync::Arc::new(store)).build();
    assert_eq!(harness.get("/ready").await.status, 200);
    drop(dir);
    let ready = harness.get("/ready").await;
    assert_eq!(ready.status, 503);
    assert_eq!(
        ready.json(),
        json!({"status": "not ready", "error": "file store connectivity failed"})
    );
    assert_eq!(
        harness.get("/health").await.status,
        200,
        "liveness is unaffected"
    );
}

#[tokio::test]
async fn hidden_app_name_is_licensed_branding() {
    let licensed = Builder::new()
        .licensed()
        .settings(|s| s.hide_app_name = true)
        .build();
    assert_eq!(licensed.get("/config").await.json()["HIDE_APP_NAME"], true);
    let unlicensed = Builder::new().settings(|s| s.hide_app_name = true).build();
    assert!(
        unlicensed
            .get("/config")
            .await
            .json()
            .get("HIDE_APP_NAME")
            .is_none()
    );
}

#[tokio::test]
async fn bodies_without_deadlines_and_with_trailers_are_read() {
    use http_body_util::{BodyExt, StreamBody};
    let harness = Builder::new()
        .settings(|s| {
            s.request_timeout = None;
            s.file_transfer_timeout = None;
        })
        .build();
    let created = harness.create_secret(false).await;
    assert_eq!(harness.get(&format!("/secret/{created}")).await.status, 200);
    let uploaded = harness.upload(false).await;
    assert_eq!(harness.get(&format!("/file/{uploaded}")).await.status, 200);

    // Trailers after the JSON are skipped, not mistaken for body data.
    let mut trailers = axum::http::HeaderMap::new();
    trailers.insert("x-checksum", "abc".parse().unwrap());
    let body = json!({"message": PGP_MESSAGE, "expiration": 3600}).to_string();
    let frames = futures_util::stream::iter([
        Ok::<_, std::io::Error>(http_body::Frame::data(bytes::Bytes::from(body))),
        Ok(http_body::Frame::trailers(trailers)),
    ]);
    let response = harness
        .send(
            req("POST", "/create/secret")
                .header("content-type", "application/json")
                .body(axum::body::Body::new(StreamBody::new(frames).boxed())),
        )
        .await;
    assert_eq!(response.status, 200, "{}", response.text());
}

/// Without a known peer there is no client IP to trust or log.
#[tokio::test]
async fn requests_without_connection_info_log_no_client_ip() {
    use tower::ServiceExt;
    let harness = Builder::new().licensed().build();
    let request = axum::http::Request::get(format!("/secret/{UUID_KEY}"))
        .header("x-forwarded-for", "198.51.100.7")
        .body(axum::body::Body::empty())
        .unwrap();
    let response = harness.router.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), 404);
    assert_eq!(harness.last_audit()["client_ip"], "");
}

/// Writes from a foreign origin are refused; reads, same-origin writes without an
/// Origin header and equivalent spellings of the frontend's origin are not.
#[tokio::test]
async fn origin_checks_compare_normalized_origins() {
    for (frontend, origin, allowed) in [
        ("https://app.example.com", None, true),
        (
            "https://app.example.com",
            Some("https://app.example.com"),
            true,
        ),
        (
            "https://app.example.com",
            Some("https://APP.Example.com"),
            true,
        ),
        (
            "https://app.example.com",
            Some("https://app.example.com:443"),
            true,
        ),
        (
            "https://app.example.com:443",
            Some("https://app.example.com"),
            true,
        ),
        ("https://[::1]", Some("https://[::1]:443"), true),
        (
            "https://app.example.com",
            Some("https://evil.example.com"),
            false,
        ),
        (
            "https://app.example.com",
            Some("http://app.example.com"),
            false,
        ),
        (
            "https://app.example.com",
            Some("https://app.example.com:8443"),
            false,
        ),
        ("https://app.example.com", Some("null"), false),
    ] {
        let harness = Builder::new()
            .settings(|s| s.frontend_url = frontend.into())
            .build();
        let mut create = req("POST", "/create/secret")
            .json(&json!({"message": PGP_MESSAGE, "expiration": 3600}));
        if let Some(origin) = origin {
            create = create.header("origin", origin);
        }
        let status = harness.send(create).await.status;
        assert_eq!(status == 200, allowed, "{frontend} {origin:?}: {status}");
        if !allowed {
            assert_eq!(status, 403, "{frontend} {origin:?}");
            // Reads are not writes: a foreign page may still fetch config.
            let read = harness
                .send(req("GET", "/config").header("origin", origin.unwrap()))
                .await;
            assert_eq!(read.status, 200);
            // Only the configured frontend is ever named, never the caller.
            let allow = read.header("access-control-allow-origin");
            assert_ne!(
                allow, origin,
                "{frontend}: the foreign origin was reflected"
            );
            assert!(allow.is_none_or(|a| frontend.starts_with(a)), "{allow:?}");
        }
    }
}
