//! Differential test against the Go server. It runs both binaries on the same
//! backend and compares their answers to the same requests, then checks that each
//! can read what the other stored.
//!
//! Build the Go server and point YOPASS_GO_SERVER at it to enable:
//!   go build -o /tmp/yopass-go ./cmd/yopass-server
//!   YOPASS_GO_SERVER=/tmp/yopass-go MEMCACHED=localhost:11211 REDIS_URL=... cargo test --test parity

mod common;

use common::fake_s3::FakeS3;
use common::{PGP_BINARY, PGP_MESSAGE, PUBLIC_KEY, UUID_KEY, eventually};
use serde_json::{Value, json};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

struct Server {
    child: Child,
    base: String,
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

async fn start(binary: &str, args: &[&str]) -> Server {
    start_with_env(binary, args, &[]).await
}

async fn start_with_env(binary: &str, args: &[&str], env: &[(&str, String)]) -> Server {
    let port = free_port();
    let child = Command::new(binary)
        .envs(env.iter().map(|(k, v)| (k, v)))
        .args([
            "--address=127.0.0.1".to_owned(),
            format!("--port={port}"),
            "--asset-path=".to_owned(),
            "--log-level=error".to_owned(),
        ])
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let base = format!("http://127.0.0.1:{port}");
    let server = Server {
        child,
        base: base.clone(),
    };
    for _ in 0..200 {
        if reqwest::get(format!("{base}/health")).await.is_ok() {
            return server;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("{binary} did not start");
}

const RUST_BIN: &str = env!("CARGO_BIN_EXE_yopass-server");

fn go_binary() -> Option<String> {
    std::env::var("YOPASS_GO_SERVER")
        .ok()
        .filter(|v| !v.is_empty())
}

/// Backend flag sets to compare on. Memcached and Redis each get a run.
fn backend_args() -> Vec<Vec<String>> {
    let mut list = Vec::new();
    if let Ok(address) = std::env::var("MEMCACHED") {
        list.push(vec![
            "--database=memcached".to_owned(),
            format!("--memcached={address}"),
        ]);
    }
    for name in ["REDIS_URL", "SENTINEL_URL"] {
        if let Some(url) = std::env::var(name).ok().filter(|v| !v.is_empty()) {
            list.push(vec![
                "--database=redis".to_owned(),
                format!("--redis={url}"),
            ]);
        }
    }
    // Without one, parity tests would pass without comparing anything.
    assert!(
        !list.is_empty(),
        "YOPASS_GO_SERVER is set: also set MEMCACHED, REDIS_URL or SENTINEL_URL"
    );
    list
}

#[derive(Debug, PartialEq)]
struct Answer {
    status: u16,
    body: Value,
    headers: Vec<(&'static str, Option<String>)>,
}

const COMPARED_HEADERS: [&str; 11] = [
    "cache-control",
    "content-security-policy",
    "referrer-policy",
    "x-content-type-options",
    "x-frame-options",
    "x-xss-protection",
    "strict-transport-security",
    "access-control-allow-origin",
    "access-control-allow-methods",
    "access-control-allow-headers",
    "access-control-expose-headers",
];

async fn ask(
    client: &reqwest::Client,
    base: &str,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: &[u8],
) -> Answer {
    let mut request = client
        .request(method.parse().unwrap(), format!("{base}{path}"))
        .body(body.to_vec());
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    let response = match request.send().await {
        Ok(response) => response,
        Err(_) => {
            return Answer {
                status: 0,
                body: Value::Null,
                headers: Vec::new(),
            };
        }
    };
    let status = response.status().as_u16();
    let headers: Vec<_> = COMPARED_HEADERS
        .iter()
        .map(|name| {
            (
                *name,
                response
                    .headers()
                    .get(*name)
                    .map(|v| v.to_str().unwrap().to_owned()),
            )
        })
        .collect();
    let content_type = response
        .headers()
        .get("content-type")
        .map(|v| v.to_str().unwrap().to_owned());
    let raw = response.bytes().await.unwrap();
    // Only JSON bodies are part of the contract; 404 pages may differ in wording.
    let mut body = match content_type.as_deref() {
        Some(t) if t.starts_with("application/json") => {
            serde_json::from_slice(&raw).unwrap_or(Value::Null)
        }
        _ => Value::Null,
    };
    // Generated IDs are random; their shape is the contract.
    if status == 200 && body["message"].as_str().is_some_and(|m| m.len() == 22) {
        body["message"] = "<generated id>".into();
    }
    Answer {
        status,
        body,
        headers,
    }
}

fn secret_body(extra: Value) -> Vec<u8> {
    let mut body = json!({"message": PGP_MESSAGE, "expiration": 3600, "one_time": true});
    for (key, value) in extra.as_object().unwrap() {
        body[key] = value.clone();
    }
    body.to_string().into_bytes()
}

const JSON: (&str, &str) = ("content-type", "application/json");

fn upload_headers() -> Vec<(&'static str, &'static str)> {
    vec![
        ("content-type", "application/octet-stream"),
        ("x-yopass-expiration", "3600"),
        ("x-yopass-onetime", "true"),
    ]
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn answers_match_the_go_server() {
    let Some(go) = go_binary() else {
        eprintln!("skipped: set YOPASS_GO_SERVER");
        return;
    };
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    for backend in backend_args() {
        for flags in [
            vec![],
            vec!["--read-only"],
            vec!["--disable-upload"],
            vec!["--prefetch-secret=false"],
            vec!["--force-onetime-secrets", "--max-length=2000"],
            vec!["--force-expiration=1d", "--default-expiry=1d"],
            vec![
                "--allow-custom-expiration",
                "--min-expiration=2m",
                "--max-expiration=2d",
                "--default-expiry=1h",
            ],
            vec!["--cors-allow-origin=https://app.example.com"],
            vec!["--frontend-url=https://app.example.com"],
            vec![
                "--logo-url=https://cdn.example.com/logo.svg",
                "--privacy-notice-url=https://p",
                "--imprint-url=https://i",
                "--public-url=https://u",
                "--disable-features",
                "--disable-one-click-link",
                "--no-language-switcher",
                "--no-theme-switcher",
                "--argon2",
                "--default-onetime-secrets=false",
                "--default-read-receipt",
            ],
        ] {
            let args: Vec<&str> = backend
                .iter()
                .map(String::as_str)
                .chain(flags.iter().copied())
                .collect();
            let go_server = start(&go, &args).await;
            let rust_server = start(RUST_BIN, &args).await;
            let cases: Vec<(&str, String, Vec<(&str, &str)>, Vec<u8>)> = vec![
                ("GET", "/config".into(), vec![], vec![]),
                ("OPTIONS", "/config".into(), vec![], vec![]),
                ("GET", "/health".into(), vec![], vec![]),
                ("HEAD", "/health".into(), vec![], vec![]),
                ("GET", "/ready".into(), vec![], vec![]),
                ("OPTIONS", "/create/secret".into(), vec![], vec![]),
                ("OPTIONS", "/create/file".into(), vec![], vec![]),
                ("OPTIONS", format!("/file/{UUID_KEY}"), vec![], vec![]),
                (
                    "OPTIONS",
                    format!("/secret/{UUID_KEY}/receipt"),
                    vec![],
                    vec![],
                ),
                (
                    "OPTIONS",
                    format!("/file/{UUID_KEY}/receipt"),
                    vec![],
                    vec![],
                ),
                ("GET", format!("/secret/{UUID_KEY}"), vec![], vec![]),
                ("DELETE", format!("/secret/{UUID_KEY}"), vec![], vec![]),
                ("GET", format!("/secret/{UUID_KEY}/status"), vec![], vec![]),
                ("GET", format!("/secret/{UUID_KEY}/receipt"), vec![], vec![]),
                ("GET", format!("/file/{UUID_KEY}"), vec![], vec![]),
                ("DELETE", format!("/file/{UUID_KEY}"), vec![], vec![]),
                ("GET", format!("/file/{UUID_KEY}/status"), vec![], vec![]),
                ("GET", format!("/file/{UUID_KEY}/receipt"), vec![], vec![]),
                ("HEAD", format!("/secret/{UUID_KEY}"), vec![], vec![]),
                ("HEAD", format!("/file/{UUID_KEY}"), vec![], vec![]),
                ("HEAD", "/config".into(), vec![], vec![]),
                ("HEAD", "/ready".into(), vec![], vec![]),
                ("HEAD", "/version".into(), vec![], vec![]),
                ("POST", "/config".into(), vec![], vec![]),
                ("POST", format!("/secret/{UUID_KEY}"), vec![], vec![]),
                ("PUT", format!("/file/{UUID_KEY}"), vec![], vec![]),
                ("GET", "/secret/not-a-key".into(), vec![], vec![]),
                (
                    "POST",
                    "/request".into(),
                    vec![JSON],
                    json!({"public_key": PUBLIC_KEY, "expiration": 3600})
                        .to_string()
                        .into_bytes(),
                ),
                ("GET", "/auth/me".into(), vec![], vec![]),
                ("GET", "/auth/login".into(), vec![], vec![]),
                (
                    "POST",
                    "/create/secret".into(),
                    vec![JSON],
                    b"{not json".to_vec(),
                ),
                (
                    "POST",
                    "/create/secret".into(),
                    vec![JSON],
                    secret_body(json!({"message": "plaintext"})),
                ),
                (
                    "POST",
                    "/create/secret".into(),
                    vec![JSON],
                    secret_body(json!({"message": ""})),
                ),
                (
                    "POST",
                    "/create/secret".into(),
                    vec![JSON],
                    secret_body(json!({"expiration": 123})),
                ),
                (
                    "POST",
                    "/create/secret".into(),
                    vec![JSON],
                    secret_body(json!({"expiration": 0})),
                ),
                (
                    "POST",
                    "/create/secret".into(),
                    vec![JSON],
                    secret_body(json!({"expiration": -1})),
                ),
                (
                    "POST",
                    "/create/secret".into(),
                    vec![JSON],
                    secret_body(json!({"expiration": 300})),
                ),
                (
                    "POST",
                    "/create/secret".into(),
                    vec![JSON],
                    secret_body(json!({"expiration": 86400})),
                ),
                (
                    "POST",
                    "/create/secret".into(),
                    vec![JSON],
                    secret_body(json!({"one_time": false})),
                ),
                (
                    "POST",
                    "/create/secret".into(),
                    vec![JSON],
                    secret_body(json!({"require_auth": true})),
                ),
                (
                    "POST",
                    "/create/secret".into(),
                    vec![JSON],
                    secret_body(json!({"receipt": true})),
                ),
                (
                    "POST",
                    "/create/secret".into(),
                    vec![JSON],
                    format!(r#"{{"message":"{}"}}"#, "x".repeat(200_000)).into_bytes(),
                ),
                (
                    "POST",
                    "/create/file".into(),
                    vec![("content-type", "text/plain")],
                    PGP_BINARY.to_vec(),
                ),
                (
                    "POST",
                    "/create/file".into(),
                    vec![("content-type", "application/octet-stream")],
                    PGP_BINARY.to_vec(),
                ),
                (
                    "POST",
                    "/create/file".into(),
                    upload_headers(),
                    b"plain".to_vec(),
                ),
                ("POST", "/create/file".into(), upload_headers(), vec![]),
                (
                    "POST",
                    "/create/file".into(),
                    vec![
                        ("content-type", "application/octet-stream"),
                        ("x-yopass-expiration", "abc"),
                    ],
                    PGP_BINARY.to_vec(),
                ),
                (
                    "POST",
                    "/create/file".into(),
                    vec![
                        ("content-type", "application/octet-stream"),
                        ("x-yopass-expiration", "123"),
                    ],
                    PGP_BINARY.to_vec(),
                ),
                (
                    "POST",
                    "/create/file".into(),
                    upload_headers(),
                    vec![0xc3; 2 << 20],
                ),
            ];
            for (method, path, headers, body) in &cases {
                let from_go = ask(&client, &go_server.base, method, path, headers, body).await;
                let from_rust = ask(&client, &rust_server.base, method, path, headers, body).await;
                assert_eq!(
                    from_rust, from_go,
                    "{flags:?} {method} {path} (left is Rust, right is Go)"
                );
            }
        }
    }
}

async fn create_secret(client: &reqwest::Client, base: &str) -> String {
    let response = client
        .post(format!("{base}/create/secret"))
        .header(JSON.0, JSON.1)
        .body(secret_body(json!({})))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    response.json::<Value>().await.unwrap()["message"]
        .as_str()
        .unwrap()
        .to_owned()
}

/// Both servers can share a backend, in both directions, with one-time claims
/// holding across them.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stored_data_is_interoperable() {
    let Some(go) = go_binary() else {
        eprintln!("skipped: set YOPASS_GO_SERVER");
        return;
    };
    let client = reqwest::Client::new();
    for backend in backend_args() {
        let args: Vec<&str> = backend.iter().map(String::as_str).collect();
        let go_server = start(&go, &args).await;
        let rust_server = start(RUST_BIN, &args).await;
        for (writer, reader) in [(&go_server, &rust_server), (&rust_server, &go_server)] {
            // One-time secret: exactly one delivery across both servers.
            let key = create_secret(&client, &writer.base).await;
            let status = ask(
                &client,
                &reader.base,
                "GET",
                &format!("/secret/{key}/status"),
                &[],
                &[],
            )
            .await;
            assert_eq!(status.body, json!({"oneTime": true, "requireAuth": false}));
            let read = ask(
                &client,
                &reader.base,
                "GET",
                &format!("/secret/{key}"),
                &[],
                &[],
            )
            .await;
            assert_eq!(read.status, 200);
            assert_eq!(read.body["message"], PGP_MESSAGE);
            assert_eq!(read.body["one_time"], true);
            for server in [&go_server, &rust_server] {
                assert_eq!(
                    ask(
                        &client,
                        &server.base,
                        "GET",
                        &format!("/secret/{key}"),
                        &[],
                        &[]
                    )
                    .await
                    .status,
                    404
                );
                assert_eq!(
                    ask(
                        &client,
                        &server.base,
                        "GET",
                        &format!("/secret/{key}/status"),
                        &[],
                        &[]
                    )
                    .await
                    .status,
                    404
                );
            }

            // File stored by one, downloaded through the other.
            let mut upload = client
                .post(format!("{}/create/file", writer.base))
                .body(PGP_BINARY);
            for (name, value) in upload_headers() {
                upload = upload.header(name, value);
            }
            let created: Value = upload.send().await.unwrap().json().await.unwrap();
            let file = created["message"].as_str().unwrap();
            let bytes = client
                .get(format!("{}/file/{file}", reader.base))
                .send()
                .await
                .unwrap()
                .bytes()
                .await
                .unwrap();
            assert_eq!(&bytes[..], PGP_BINARY);
            assert_eq!(
                ask(
                    &client,
                    &writer.base,
                    "GET",
                    &format!("/file/{file}"),
                    &[],
                    &[]
                )
                .await
                .status,
                404
            );

            // Deleting through the other server.
            let key = create_secret(&client, &writer.base).await;
            assert_eq!(
                ask(
                    &client,
                    &reader.base,
                    "DELETE",
                    &format!("/secret/{key}"),
                    &[],
                    &[]
                )
                .await
                .status,
                204
            );
            assert_eq!(
                ask(
                    &client,
                    &writer.base,
                    "GET",
                    &format!("/secret/{key}"),
                    &[],
                    &[]
                )
                .await
                .status,
                404
            );
        }
    }
}

/// One-time claims hold when both implementations race on one backend.
#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn one_time_claims_hold_across_implementations() {
    let Some(go) = go_binary() else {
        eprintln!("skipped: set YOPASS_GO_SERVER");
        return;
    };
    let client = reqwest::Client::new();
    for backend in backend_args() {
        let args: Vec<&str> = backend.iter().map(String::as_str).collect();
        let go_server = start(&go, &args).await;
        let rust_server = start(RUST_BIN, &args).await;
        for _ in 0..30 {
            let key = create_secret(&client, &go_server.base).await;
            let requests = (0..16).map(|index| {
                let base = if index % 2 == 0 {
                    &go_server.base
                } else {
                    &rust_server.base
                };
                client.get(format!("{base}/secret/{key}")).send()
            });
            let results = futures_util::future::join_all(requests).await;
            let delivered = results
                .iter()
                .filter(|r| r.as_ref().unwrap().status() == 200)
                .count();
            assert_eq!(
                delivered, 1,
                "{backend:?}: delivered {delivered} times across implementations"
            );
        }
    }
}

async fn upload(client: &reqwest::Client, base: &str, one_time: bool) -> String {
    let created: Value = client
        .post(format!("{base}/create/file"))
        .header("content-type", "application/octet-stream")
        .header("x-yopass-expiration", "3600")
        .header("x-yopass-onetime", if one_time { "true" } else { "false" })
        .body(PGP_BINARY)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    created["message"].as_str().unwrap().to_owned()
}

/// Both servers on one bucket: each reads what the other stored, and each
/// one's sweeper removes what the other stored once it expires.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn s3_files_are_interoperable() {
    let Some(go) = go_binary() else {
        eprintln!("skipped: set YOPASS_GO_SERVER");
        return;
    };
    let db = backend_args().swap_remove(0);
    // The Go SDK streams uploads over TLS only.
    let fake = FakeS3::start_tls().await;
    let env = fake.env();
    let mut args = db.clone();
    args.extend(fake.args("yopass/"));
    let client = reqwest::Client::new();

    // Reading across implementations, with sweepers off.
    let mut quiet = args.clone();
    quiet.push("--disable-file-cleanup".to_owned());
    let quiet: Vec<&str> = quiet.iter().map(String::as_str).collect();
    let go_server = start_with_env(&go, &quiet, &env).await;
    let rust_server = start_with_env(RUST_BIN, &quiet, &env).await;
    let mut written = Vec::new();
    for (writer, reader) in [(&go_server, &rust_server), (&rust_server, &go_server)] {
        let key = upload(&client, &writer.base, true).await;
        let object = format!("yopass/{key}");
        let stored = fake.object(&object).unwrap_or_else(|| {
            panic!(
                "{object} not in {:?}; puts {:?}",
                fake.keys(),
                fake.state()
                    .log
                    .iter()
                    .map(|l| (
                        l.op,
                        l.key.clone(),
                        l.headers.get("content-encoding").cloned(),
                        l.headers.get("x-amz-content-sha256").cloned()
                    ))
                    .collect::<Vec<_>>()
            )
        });
        assert_eq!(stored.data, PGP_BINARY);
        let expires = stored.expires.expect("an Expires header");
        written.push(expires.clone());
        let download = client
            .get(format!("{}/file/{key}", reader.base))
            .send()
            .await
            .unwrap();
        assert_eq!(download.status(), 200);
        assert_eq!(&download.bytes().await.unwrap()[..], PGP_BINARY);
        let gone = fake.clone();
        eventually("the one-time blob is removed", async || {
            gone.object(&object).is_none()
        })
        .await;
        let again = ask(
            &client,
            &writer.base,
            "GET",
            &format!("/file/{key}"),
            &[],
            &[],
        )
        .await;
        assert_eq!(again.status, 404);

        let key = upload(&client, &writer.base, false).await;
        let deleted = ask(
            &client,
            &reader.base,
            "DELETE",
            &format!("/file/{key}"),
            &[],
            &[],
        )
        .await;
        assert_eq!(deleted.status, 204);
        assert!(fake.object(&format!("yopass/{key}")).is_none());
    }
    // Both write the lifetime the same way, and never as a tag.
    for expires in &written {
        assert!(httpdate::parse_http_date(expires).is_ok(), "{expires}");
        assert!(
            expires.ends_with(" GMT") && expires.len() == 29,
            "{expires}"
        );
    }
    assert!(
        fake.ops("put")
            .iter()
            .all(|p| !p.headers.contains_key("x-amz-tagging"))
    );

    // The same answers when the bucket misbehaves or a body has no length.
    let stream_body = || {
        reqwest::Body::wrap_stream(futures_util::stream::iter([Ok::<_, std::io::Error>(
            bytes::Bytes::from_static(PGP_BINARY),
        )]))
    };
    let mut answers = Vec::new();
    for server in [&go_server, &rust_server] {
        let key = upload(&client, &server.base, true).await;
        fake.state().fail.insert(("get", None));
        let unavailable = ask(
            &client,
            &server.base,
            "GET",
            &format!("/file/{key}"),
            &[],
            &[],
        )
        .await;
        fake.state().fail.clear();
        let retried = ask(
            &client,
            &server.base,
            "GET",
            &format!("/file/{key}"),
            &[],
            &[],
        )
        .await;
        fake.state().fail.insert(("head_bucket", None));
        let ready = ask(&client, &server.base, "GET", "/ready", &[], &[]).await;
        fake.state().fail.clear();
        let mut chunked = client
            .post(format!("{}/create/file", server.base))
            .body(stream_body());
        for (name, value) in upload_headers() {
            chunked = chunked.header(name, value);
        }
        let chunked = chunked.send().await.unwrap();
        let chunked_status = chunked.status().as_u16();
        let chunked: Value = chunked.json().await.unwrap_or(Value::Null);
        answers.push((
            unavailable.status,
            unavailable.body,
            retried.status,
            ready.status,
            chunked_status,
            chunked,
        ));
    }
    assert_eq!(answers[0], answers[1]);
    assert_eq!(answers[0].0, 503);
    assert_eq!(answers[0].2, 200);
    assert_eq!(answers[0].3, 503);
    drop((go_server, rust_server));

    // Each sweeper removes the other's expired objects and keeps live ones.
    let mut sweeping = args.clone();
    sweeping.push("--cleanup-interval=1".to_owned());
    let sweeping: Vec<&str> = sweeping.iter().map(String::as_str).collect();
    for (sweeper, writer) in [(go.as_str(), RUST_BIN), (RUST_BIN, go.as_str())] {
        let writer = start_with_env(writer, &quiet, &env).await;
        let expired = format!("yopass/{}", upload(&client, &writer.base, false).await);
        let live = format!("yopass/{}", upload(&client, &writer.base, false).await);
        let past = httpdate::fmt_http_date(std::time::SystemTime::now() - Duration::from_secs(60));
        fake.state().objects.get_mut(&expired).unwrap().expires = Some(past);
        let _sweeper = start_with_env(sweeper, &sweeping, &env).await;
        let swept = fake.clone();
        eventually(
            "the other implementation sweeps the expired object",
            async || swept.object(&expired).is_none(),
        )
        .await;
        assert!(fake.object(&live).is_some(), "a live object must survive");
    }
}
