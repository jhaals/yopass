//! The server binary: configuration errors fail startup without leaking values.

use std::process::{Command, Stdio};
use std::time::Duration;

const BIN: &str = env!("CARGO_BIN_EXE_yopass-server");

/// Every case here must exit by itself. A server that starts instead would run
/// forever, so that fails the test rather than hanging it.
fn run(args: &[&str], env: &[(&str, &str)]) -> (bool, String) {
    let mut command = Command::new(BIN);
    command
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env_clear();
    // Coverage runs collect from child processes through this variable.
    if let Some(profile) = std::env::var_os("LLVM_PROFILE_FILE") {
        command.env("LLVM_PROFILE_FILE", profile);
    }
    for (name, value) in env {
        command.env(name, value);
    }
    let mut child = command.spawn().unwrap();
    let started = std::time::Instant::now();
    while child.try_wait().unwrap().is_none() {
        if started.elapsed() > Duration::from_secs(20) {
            child.kill().unwrap();
            panic!("{args:?} did not exit: the server started instead of failing");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let output = child.wait_with_output().unwrap();
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    (output.status.success(), text)
}

#[test]
fn unsupported_features_refuse_to_start() {
    for (args, expected) in [
        (vec!["--file-store=s3"], "file-store-s3-bucket is required"),
        (
            vec![
                "--database=redis",
                "--redis=redis://h:1/0?master_name=m&replica_only=true",
            ],
            "replica_only, route_by_latency and route_randomly are not supported",
        ),
        (vec!["--database=oracle"], "unsupported database"),
    ] {
        let (ok, text) = run(&args, &[]);
        assert!(!ok, "{args:?} must not start");
        assert!(text.contains(expected), "{args:?}: {text}");
    }
}

#[test]
fn business_flags_without_a_license_refuse_to_start() {
    let (ok, text) = run(&["--oidc-issuer=https://id.example.com"], &[]);
    assert!(!ok);
    assert!(
        text.contains("refusing to start without authentication"),
        "{text}"
    );
    let (ok, _) = run(&["--audit-log"], &[]);
    assert!(!ok);
}

#[test]
fn startup_errors_never_echo_credentials() {
    let cases: Vec<(Vec<String>, Vec<(&str, &str)>)> = vec![
        (
            vec![
                "--database=redis".into(),
                "--redis=redis://:hunter2@[not-a-host/0".into(),
            ],
            vec![],
        ),
        (
            vec!["--database=redis".into()],
            vec![("REDIS", "redis://:hunter2@[not-a-host/0")],
        ),
        (
            vec!["--webhook-url=https://user:hunter2@example.com/x".into()],
            vec![],
        ),
        (
            vec![
                "--license-key=hunter2.hunter2.hunter2".into(),
                "--webhook-url=https://x".into(),
            ],
            vec![],
        ),
    ];
    for (args, env) in cases {
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        let (ok, text) = run(&args, &env);
        assert!(!ok, "{args:?}");
        assert!(!text.contains("hunter2"), "{args:?}: {text}");
    }
    // --help must not reveal environment values of secret settings either.
    let (_, help) = run(
        &["--help"],
        &[
            ("LICENSE_KEY", "hunter2"),
            ("WEBHOOK_SECRET", "hunter2"),
            ("OIDC_CLIENT_SECRET", "hunter2"),
            ("API_TOKEN", "a:hunter2"),
            ("REDIS", "redis://:hunter2@h"),
            ("OIDC_SESSION_KEY", "hunter2"),
            ("WEBHOOK_URL", "https://hunter2"),
        ],
    );
    assert!(!help.contains("hunter2"), "{help}");
}

#[test]
fn obsolete_setting_is_rejected_rather_than_dropping_the_allow_list() {
    let (ok, text) = run(&[], &[("OIDC_ALLOWED_DOMAIN", "example.com")]);
    assert!(!ok);
    assert!(text.contains("OIDC_ALLOWED_DOMAINS"), "{text}");
}

#[test]
fn malformed_booleans_are_rejected_from_the_environment() {
    let (ok, text) = run(
        &["--port=0", "--health-check"],
        &[("FORCE_ONETIME_SECRETS", "yes")],
    );
    assert!(!ok);
    assert!(text.contains("expected true or false"), "{text}");
}

#[test]
fn empty_environment_values_count_as_unset() {
    let (ok, text) = run(
        &["--health-check", "--memcached=127.0.0.1:1"],
        &[
            ("DISABLE_UPLOAD", ""),
            ("PREFETCH_SECRET", ""),
            ("MAX_LENGTH", ""),
            ("TRUSTED_PROXIES", ""),
        ],
    );
    assert!(
        !ok,
        "the backend is unreachable, so this must fail at the health check"
    );
    assert!(text.contains("health check failed"), "{text}");
}

#[test]
fn health_check_reports_the_backend() {
    let Ok(address) = std::env::var("MEMCACHED") else {
        return;
    };
    let (ok, text) = run(&["--health-check", &format!("--memcached={address}")], &[]);
    assert!(ok, "{text}");
}

#[test]
fn server_starts_serves_and_stops_on_sigterm() {
    let Ok(address) = std::env::var("MEMCACHED") else {
        return;
    };
    let port = free_port();
    let mut child = Command::new(BIN)
        .args([
            format!("--port={port}"),
            "--address=127.0.0.1".into(),
            format!("--memcached={address}"),
            "--asset-path=".into(),
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut started = false;
    for _ in 0..100 {
        if serving(port) {
            started = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(started, "server did not start");
    // Something else answering on a reused port would make this test meaningless.
    if let Some(status) = child.try_wait().unwrap() {
        panic!(
            "server exited before SIGTERM ({status}): {}",
            stderr_of(child)
        );
    }
    Command::new("kill")
        .args(["-TERM", &child.id().to_string()])
        .status()
        .unwrap();
    for _ in 0..200 {
        if let Some(status) = child.try_wait().unwrap() {
            assert!(
                status.success(),
                "unclean shutdown: {status}: {}",
                stderr_of(child)
            );
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    child.kill().unwrap();
    panic!("server did not stop on SIGTERM");
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

#[test]
fn health_check_fails_when_the_backend_is_down() {
    for args in [
        vec!["--health-check", "--memcached=127.0.0.1:1"],
        vec![
            "--health-check",
            "--database=redis",
            "--redis=redis://127.0.0.1:1/0",
        ],
    ] {
        let (ok, text) = run(&args, &[]);
        assert!(!ok, "{args:?}");
        assert!(text.contains("database health check failed"), "{text}");
    }
}

#[test]
fn invalid_log_level_is_refused() {
    let (ok, text) = run(&["--log-level=[not-a-filter"], &[]);
    assert!(!ok);
    assert!(text.contains("invalid log level"), "{text}");
}

/// A stop request during startup still shuts down cleanly.
#[test]
fn sigterm_during_startup_is_a_clean_shutdown() {
    let Ok(address) = std::env::var("MEMCACHED") else {
        return;
    };
    for _ in 0..10 {
        let port = free_port();
        let mut child = Command::new(BIN)
            .args([
                format!("--port={port}"),
                "--address=127.0.0.1".into(),
                format!("--memcached={address}"),
                "--asset-path=".into(),
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        // As soon as it answers, while background startup work may still run.
        while !serving(port) {
            std::thread::sleep(Duration::from_millis(1));
        }
        Command::new("kill")
            .args(["-TERM", &child.id().to_string()])
            .status()
            .unwrap();
        let status = child.wait().unwrap();
        assert!(status.success(), "unclean shutdown: {status}");
    }
}

fn stderr_of(child: std::process::Child) -> String {
    let output = child.wait_with_output().unwrap();
    String::from_utf8_lossy(&output.stderr).into_owned()
}

/// True once the port answers HTTP. A bare successful connect is not enough: on
/// loopback, connecting to an unbound ephemeral port can connect to itself.
fn serving(port: u16) -> bool {
    use std::io::{Read, Write};
    let Ok(mut conn) = std::net::TcpStream::connect(("127.0.0.1", port)) else {
        return false;
    };
    let _ = conn.set_read_timeout(Some(Duration::from_secs(2)));
    let mut head = [0; 7];
    conn.write_all(b"GET /health HTTP/1.0\r\n\r\n").is_ok()
        && conn.read_exact(&mut head).is_ok()
        && &head == b"HTTP/1."
}

/// TLS to Redis trusts the system roots, which SSL_CERT_FILE replaces, as the Go
/// server does, so a private CA works. Set REDIS_TLS_URL to a `rediss://` server
/// whose certificate tests/fixtures/s3_ca.pem signed.
#[test]
fn redis_tls_trusts_the_configured_roots() {
    let Some(url) = std::env::var("REDIS_TLS_URL")
        .ok()
        .filter(|v| !v.is_empty())
    else {
        eprintln!("skipped: set REDIS_TLS_URL");
        return;
    };
    let ca = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/s3_ca.pem");
    let redis = format!("--redis={url}");
    let args = ["--health-check", "--database=redis", redis.as_str()];
    let (ok, text) = run(&args, &[("SSL_CERT_FILE", ca)]);
    assert!(ok, "{text}");
    let (ok, _) = run(&args, &[("SSL_CERT_FILE", "/nonexistent")]);
    assert!(!ok, "an untrusted certificate must fail");
}
