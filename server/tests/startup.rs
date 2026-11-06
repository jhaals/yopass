//! The real startup path, with an injected license: the key embedded in the binary
//! cannot be signed for here, so the licensed branches are unreachable from the CLI.

mod common;

use axum::Json;
use axum::Router;
use axum::routing::get;
use clap::Parser;
use common::*;
use serde_json::json;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use yopass_server::config::Config;
use yopass_server::license::License;
use yopass_server::server::run_with_license;

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn config(args: &[String]) -> Config {
    let mut argv = vec![
        "yopass-server".to_owned(),
        "--address=127.0.0.1".to_owned(),
        "--asset-path=".to_owned(),
    ];
    argv.extend_from_slice(args);
    Config::try_parse_from(argv).unwrap()
}

struct Running {
    base: String,
    stop: oneshot::Sender<()>,
    task: tokio::task::JoinHandle<Result<(), String>>,
}

impl Running {
    async fn start(mut args: Vec<String>, license: License) -> Self {
        let port = free_port();
        args.push(format!("--port={port}"));
        let (stop, stopped) = oneshot::channel();
        let config = config(&args);
        let task = tokio::spawn(run_with_license(config, license, async {
            let _ = stopped.await;
        }));
        let base = format!("http://127.0.0.1:{port}");
        wait_for_port(port).await;
        Self { base, stop, task }
    }

    async fn stop(self) {
        let _ = self.stop.send(());
        let result = tokio::time::timeout(Duration::from_secs(10), self.task)
            .await
            .expect("the server must stop")
            .unwrap();
        assert_eq!(result, Ok(()));
    }
}

/// Waits for an HTTP answer. A bare successful connect is not enough: on
/// loopback, connecting to an unbound ephemeral port can connect to itself.
async fn wait_for_port(port: u16) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    for _ in 0..500 {
        if let Ok(mut conn) = tokio::net::TcpStream::connect(("127.0.0.1", port)).await {
            let mut head = [0; 5];
            let answered = conn.write_all(b"GET / HTTP/1.0\r\n\r\n").await.is_ok()
                && tokio::time::timeout(Duration::from_secs(2), conn.read_exact(&mut head))
                    .await
                    .is_ok_and(|read| read.is_ok());
            // A TLS listener answers plain HTTP with an alert, which is an answer too.
            if answered && (&head == b"HTTP/" || head[0] == 0x15) {
                return;
            }
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("port {port} never opened");
}

/// Leaves an upload behind that expired long ago, as the sweeper finds it.
fn write_expired_blob(dir: &Path, key: &str) -> (std::path::PathBuf, std::path::PathBuf) {
    let shard = dir.join(&key[..2]);
    std::fs::create_dir_all(&shard).unwrap();
    let (bin, meta) = (
        shard.join(format!("{key}.bin")),
        shard.join(format!("{key}.meta")),
    );
    std::fs::write(&bin, "ciphertext").unwrap();
    std::fs::write(&meta, br#"{"expiration_unix":1}"#).unwrap();
    (bin, meta)
}

/// Just enough of an identity provider for discovery to succeed.
async fn discovery_server() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let issuer = format!("http://{}", listener.local_addr().unwrap());
    let document = json!({
        "issuer": issuer,
        "authorization_endpoint": format!("{issuer}/authorize"),
        "token_endpoint": format!("{issuer}/token"),
        "userinfo_endpoint": format!("{issuer}/userinfo"),
        "jwks_uri": format!("{issuer}/jwks"),
        "response_types_supported": ["code"],
        "subject_types_supported": ["public"],
        "id_token_signing_alg_values_supported": ["ES256"],
    });
    let router = Router::new()
        .route(
            "/.well-known/openid-configuration",
            get(move || {
                let document = document.clone();
                async move { Json(document) }
            }),
        )
        .route("/jwks", get(|| async { Json(json!({"keys": []})) }));
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    issuer
}

fn memcached_arg() -> Option<String> {
    memcached_addr().map(|address| format!("--memcached={address}"))
}

#[tokio::test]
async fn licensed_startup_wires_every_feature() {
    let Some(memcached) = memcached_arg() else {
        return;
    };
    let files = tempfile::tempdir().unwrap();
    let audit_dir = tempfile::tempdir().unwrap();
    let audit_path = audit_dir.path().join("audit.log");
    let (bin, meta) = write_expired_blob(files.path(), UUID_KEY);
    let issuer = discovery_server().await;
    let metrics_port = free_port();
    let server = Running::start(
        vec![
            memcached,
            "--file-store=disk".into(),
            format!("--file-store-path={}", files.path().display()),
            "--cleanup-interval=1".into(),
            format!("--metrics-port={metrics_port}"),
            "--audit-log".into(),
            format!("--audit-log-file={}", audit_path.display()),
            "--webhook-url=http://127.0.0.1:1/hook".into(),
            format!("--oidc-issuer={issuer}"),
            "--oidc-client-id=client".into(),
            "--oidc-client-secret=secret".into(),
            format!("--oidc-redirect-url={issuer}/auth/callback"),
        ],
        valid_license(),
    )
    .await;

    let config: serde_json::Value = reqwest::get(format!("{}/config", server.base))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(config["OIDC_ENABLED"], true);

    // Discovery produced a working login redirect to the provider.
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let login = client
        .get(format!("{}/auth/login", server.base))
        .send()
        .await
        .unwrap();
    assert_eq!(login.status(), 302);
    assert!(
        login.headers()["location"]
            .to_str()
            .unwrap()
            .starts_with(&issuer)
    );

    // Audit events reach the configured file, private to the server's user.
    let created = client
        .post(format!("{}/create/secret", server.base))
        .json(&json!({"message": PGP_MESSAGE, "expiration": 3600}))
        .send()
        .await
        .unwrap();
    assert_eq!(created.status(), 200);
    let audit = std::fs::read_to_string(&audit_path).unwrap();
    assert!(audit.contains("secret.created"), "{audit}");
    let mode = std::fs::metadata(&audit_path).unwrap().permissions().mode();
    assert_eq!(mode & 0o777, 0o600);

    wait_for_port(metrics_port).await;
    let metrics = reqwest::get(format!("http://127.0.0.1:{metrics_port}/metrics"))
        .await
        .unwrap();
    assert_eq!(metrics.status(), 200);

    eventually("the sweeper removes the expired blob", async || {
        !bin.exists() && !meta.exists()
    })
    .await;
    server.stop().await;
}

#[tokio::test]
async fn expired_license_keeps_authentication() {
    let Some(memcached) = memcached_arg() else {
        return;
    };
    let issuer = discovery_server().await;
    let server = Running::start(
        vec![
            memcached,
            format!("--oidc-issuer={issuer}"),
            "--oidc-client-id=client".into(),
            format!("--oidc-redirect-url={issuer}/auth/callback"),
            "--require-auth".into(),
        ],
        expired_license(),
    )
    .await;
    // The session layer stays up: a protected secret must not become readable.
    let me = reqwest::get(format!("{}/auth/me", server.base))
        .await
        .unwrap();
    assert_ne!(me.status(), 404, "authentication must survive the expiry");
    server.stop().await;
}

/// Expired files are still removed when uploads are off, so ciphertext does not
/// outlive its lifetime; an operator who disabled cleanup keeps theirs.
#[tokio::test]
async fn cleanup_follows_its_own_flag_and_not_the_upload_flag() {
    let Some(memcached) = memcached_arg() else {
        return;
    };
    let swept = tempfile::tempdir().unwrap();
    let (bin, meta) = write_expired_blob(swept.path(), UUID_KEY);
    let server = Running::start(
        vec![
            memcached.clone(),
            "--disable-upload".into(),
            "--file-store=disk".into(),
            format!("--file-store-path={}", swept.path().display()),
            "--cleanup-interval=1".into(),
        ],
        License::default(),
    )
    .await;
    eventually("cleanup with uploads disabled", async || {
        !bin.exists() && !meta.exists()
    })
    .await;
    let upload = reqwest::Client::new()
        .post(format!("{}/create/file", server.base))
        .send()
        .await
        .unwrap();
    assert_eq!(upload.status(), 404, "uploads stay off");
    server.stop().await;

    let kept = tempfile::tempdir().unwrap();
    let (bin, _) = write_expired_blob(kept.path(), UUID_KEY);
    let server = Running::start(
        vec![
            memcached,
            "--disable-file-cleanup".into(),
            "--file-store=disk".into(),
            format!("--file-store-path={}", kept.path().display()),
            "--cleanup-interval=1".into(),
        ],
        License::default(),
    )
    .await;
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert!(bin.exists(), "cleanup was disabled");
    server.stop().await;
}

#[tokio::test]
async fn redis_and_tls_serve_over_the_real_listener() {
    let Some(url) = redis_url() else {
        return;
    };
    let port = free_port();
    let (stop, stopped) = oneshot::channel::<()>();
    let config = config(&[
        "--database=redis".into(),
        format!("--redis={url}"),
        format!("--port={port}"),
        "--tls-cert=tests/fixtures/tls_cert.pem".into(),
        "--tls-key=tests/fixtures/tls_key.pem".into(),
    ]);
    let task = tokio::spawn(run_with_license(config, License::default(), async {
        let _ = stopped.await;
    }));
    wait_for_port(port).await;
    let client = reqwest::Client::builder()
        .tls_danger_accept_invalid_certs(true)
        .build()
        .unwrap();
    let response = client
        .get(format!("https://localhost:{port}/ready"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let _ = stop.send(());
    assert_eq!(task.await.unwrap(), Ok(()));
}

async fn start_error(args: &[String], license: License) -> String {
    let result = tokio::time::timeout(
        Duration::from_secs(20),
        run_with_license(config(args), license, std::future::pending()),
    )
    .await
    .expect("startup must fail instead of serving");
    result.unwrap_err()
}

#[tokio::test]
async fn startup_failures_are_reported() {
    let taken = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let taken_port = taken.local_addr().unwrap().port();
    let free = free_port();
    let dir = tempfile::tempdir().unwrap();
    let blocker = dir.path().join("a-file");
    std::fs::write(&blocker, "").unwrap();
    for (args, license, expected) in [
        (
            vec![format!("--port={taken_port}")],
            License::default(),
            "could not listen",
        ),
        (
            vec![
                format!("--port={free}"),
                format!("--metrics-port={taken_port}"),
            ],
            License::default(),
            "could not listen on metrics port",
        ),
        (
            vec![
                format!("--port={free}"),
                "--tls-cert=/nonexistent/cert.pem".into(),
                "--tls-key=/nonexistent/key.pem".into(),
            ],
            License::default(),
            "could not read --tls-cert",
        ),
        (
            vec![
                format!("--port={free}"),
                "--audit-log".into(),
                "--audit-log-file=/nonexistent/dir/audit.log".into(),
            ],
            valid_license(),
            "failed to initialize audit logger",
        ),
        (
            vec![
                format!("--port={free}"),
                "--file-store=disk".into(),
                format!("--file-store-path={}", blocker.display()),
            ],
            License::default(),
            "file store directory",
        ),
        (
            vec![
                format!("--port={free}"),
                "--webhook-url=ftp://user:hunter2@example.com/".into(),
            ],
            valid_license(),
            "absolute http(s) URL",
        ),
    ] {
        let error = start_error(&args, license).await;
        assert!(error.contains(expected), "{args:?}: {error}");
        assert!(!error.contains("hunter2"), "{error}");
    }
}

#[tokio::test]
async fn health_check_mode_does_not_listen() {
    let Some(memcached) = memcached_arg() else {
        return;
    };
    let port = free_port();
    let result = run_with_license(
        config(&[memcached, "--health-check".into(), format!("--port={port}")]),
        License::default(),
        std::future::pending(),
    )
    .await;
    assert_eq!(result, Ok(()));
    assert!(std::net::TcpStream::connect(("127.0.0.1", port)).is_err());
}

/// A startup that fails leaves nothing running: the sweeper never starts when
/// a later step, here the metrics bind, fails.
#[tokio::test]
async fn a_failed_startup_starts_no_background_work() {
    let Some(memcached) = memcached_arg() else {
        return;
    };
    let taken = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let dir = tempfile::tempdir().unwrap();
    let (bin, _) = write_expired_blob(dir.path(), UUID_KEY);
    let error = start_error(
        &[
            memcached,
            format!("--port={}", free_port()),
            format!("--metrics-port={}", taken.local_addr().unwrap().port()),
            "--file-store=disk".into(),
            format!("--file-store-path={}", dir.path().display()),
            "--cleanup-interval=1".into(),
        ],
        License::default(),
    )
    .await;
    assert!(error.contains("metrics port"), "{error}");
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert!(bin.exists(), "a sweeper outlived the failed startup");
}
