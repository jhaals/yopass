//! Behaviour only a real socket shows: disconnects, stalls, limits, TLS, shutdown.

mod common;

use async_trait::async_trait;
use bytes::Bytes;
use common::*;
use futures_util::{StreamExt, stream};
use serde_json::json;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;
use yopass_server::app;
use yopass_server::db::memory::MemoryDb;
use yopass_server::db::{Authorize, Database, DbError, Secret, UpdateFn};
use yopass_server::files::disk::DiskFileStore;
use yopass_server::files::{ByteStream, FileError, FileStore};
use yopass_server::serve::{Limits, load_tls, serve};

struct Running {
    address: String,
    stop: CancellationToken,
    task: tokio::task::JoinHandle<()>,
}

async fn run(harness: &Harness, limits: Limits) -> Running {
    run_tls(harness, limits, None).await
}

async fn run_tls(
    harness: &Harness,
    limits: Limits,
    tls: Option<tokio_rustls::TlsAcceptor>,
) -> Running {
    serve_router(app::router(harness.app.clone()), limits, tls).await
}

async fn serve_router(
    router: axum::Router,
    limits: Limits,
    tls: Option<tokio_rustls::TlsAcceptor>,
) -> Running {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap().to_string();
    let stop = CancellationToken::new();
    let task = tokio::spawn(serve(listener, router, tls, limits, stop.clone()));
    Running {
        address,
        stop,
        task,
    }
}

/// Blocks chosen operations until released, to hold a handler mid-flight.
struct GatedDb {
    inner: Arc<dyn Database>,
    gate_claims: AtomicBool,
    entered: Notify,
    release: Notify,
    panic_on_status: AtomicBool,
}

impl GatedDb {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            inner: Arc::new(MemoryDb::new()),
            gate_claims: AtomicBool::new(false),
            entered: Notify::new(),
            release: Notify::new(),
            panic_on_status: AtomicBool::new(false),
        })
    }
}

#[async_trait]
impl Database for GatedDb {
    async fn status(&self, key: &str) -> Result<Secret, DbError> {
        assert!(
            !self.panic_on_status.load(Ordering::SeqCst),
            "simulated handler bug"
        );
        self.inner.status(key).await
    }
    async fn get_authorized(&self, key: &str, authorize: &Authorize) -> Result<Secret, DbError> {
        if self.gate_claims.load(Ordering::SeqCst) {
            self.entered.notify_one();
            self.release.notified().await;
        }
        self.inner.get_authorized(key, authorize).await
    }
    async fn delete_authorized(&self, key: &str, authorize: &Authorize) -> Result<(), DbError> {
        self.inner.delete_authorized(key, authorize).await
    }
    async fn put(&self, key: &str, secret: &Secret) -> Result<(), DbError> {
        self.inner.put(key, secret).await
    }
    async fn delete(&self, key: &str) -> Result<bool, DbError> {
        self.inner.delete(key).await
    }
    async fn update(&self, key: &str, update: &UpdateFn) -> Result<(), DbError> {
        self.inner.update(key, update).await
    }
    async fn health(&self) -> Result<(), DbError> {
        Ok(())
    }
}

/// Dropping a handler future when the client goes away would stop it between the
/// claim and its audit record. The handler must run to completion regardless.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn client_disconnect_cannot_cancel_a_claim_midway() {
    let db = GatedDb::new();
    let harness = Builder::with_db(db.clone()).licensed().build();
    db.inner
        .put(UUID_KEY, &secret("ciphertext", true))
        .await
        .unwrap();
    db.gate_claims.store(true, Ordering::SeqCst);
    let server = run(&harness, Limits::default()).await;

    let mut client = TcpStream::connect(&server.address).await.unwrap();
    client
        .write_all(format!("GET /secret/{UUID_KEY} HTTP/1.1\r\nHost: x\r\n\r\n").as_bytes())
        .await
        .unwrap();
    db.entered.notified().await;
    drop(client);
    // Give hyper time to notice the closed socket and drop its side.
    tokio::time::sleep(Duration::from_millis(100)).await;
    db.release.notify_one();

    let audit = harness.audit.clone();
    eventually("the claim must finish and be audited", async || {
        audit.text().contains(r#""event":"secret.accessed""#)
            && audit.text().contains(r#""outcome":"success""#)
    })
    .await;
    assert!(matches!(
        db.inner.status(UUID_KEY).await,
        Err(DbError::NotFound)
    ));
}

/// A store whose commit stalls until released, recording what happened.
#[derive(Default)]
struct SlowStore {
    entered: Notify,
    release: Notify,
    committed: AtomicBool,
    read_failed: AtomicBool,
    deletes: AtomicUsize,
    data: Mutex<Vec<u8>>,
}

#[async_trait]
impl FileStore for SlowStore {
    async fn save(
        &self,
        _key: &str,
        mut body: ByteStream,
        _size: Option<u64>,
        _expiration: i32,
    ) -> Result<(), FileError> {
        while let Some(chunk) = body.next().await {
            match chunk {
                Ok(chunk) => self.data.lock().unwrap().extend_from_slice(&chunk),
                Err(error) => {
                    self.read_failed.store(true, Ordering::SeqCst);
                    return Err(FileError::Read(error));
                }
            }
        }
        self.entered.notify_one();
        self.release.notified().await;
        self.committed.store(true, Ordering::SeqCst);
        Ok(())
    }
    async fn load(&self, _key: &str) -> Result<(ByteStream, u64), FileError> {
        Err(FileError::NotFound)
    }
    async fn delete(&self, _key: &str) -> Result<(), FileError> {
        self.deletes.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
    async fn health(&self) -> Result<(), FileError> {
        Ok(())
    }
}

fn upload_head(length: usize) -> String {
    format!(
        "POST /create/file HTTP/1.1\r\nHost: x\r\nContent-Type: application/octet-stream\r\nX-Yopass-Expiration: 3600\r\nX-Yopass-OneTime: true\r\nContent-Length: {length}\r\n\r\n"
    )
}

/// A disconnect after the final byte must not abandon the commit: the sender may
/// have seen the upload as finished, and metadata must follow the blob.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn disconnect_after_the_last_byte_still_commits() {
    let store = Arc::new(SlowStore::default());
    let db = Arc::new(MemoryDb::new());
    let harness = Builder::with_db(db.clone())
        .files(store.clone())
        .licensed()
        .build();
    let server = run(&harness, Limits::default()).await;

    let mut client = TcpStream::connect(&server.address).await.unwrap();
    client
        .write_all(upload_head(PGP_BINARY.len()).as_bytes())
        .await
        .unwrap();
    client.write_all(PGP_BINARY).await.unwrap();
    store.entered.notified().await;
    drop(client);
    tokio::time::sleep(Duration::from_millis(100)).await;
    store.release.notify_one();

    let (keys, audit) = (db.clone(), harness.audit.clone());
    eventually("metadata must be stored after the commit", async || {
        keys.keys().iter().any(|k| k.starts_with("stream:"))
            && audit.text().contains(r#""event":"file.uploaded""#)
    })
    .await;
    assert!(store.committed.load(Ordering::SeqCst));
    assert_eq!(store.deletes.load(Ordering::SeqCst), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn disconnect_during_the_body_cleans_up() {
    let store = Arc::new(SlowStore::default());
    let db = Arc::new(MemoryDb::new());
    let harness = Builder::with_db(db.clone())
        .files(store.clone())
        .licensed()
        .build();
    let server = run(&harness, Limits::default()).await;

    let mut client = TcpStream::connect(&server.address).await.unwrap();
    client
        .write_all(upload_head(1000).as_bytes())
        .await
        .unwrap();
    client.write_all(PGP_BINARY).await.unwrap();
    client.flush().await.unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    drop(client);

    let probe = store.clone();
    eventually(
        "the interrupted upload must fail and clean up",
        async || probe.deletes.load(Ordering::SeqCst) == 1,
    )
    .await;
    assert!(store.read_failed.load(Ordering::SeqCst));
    assert!(!store.committed.load(Ordering::SeqCst));
    assert!(
        db.keys().is_empty(),
        "no metadata for an interrupted upload"
    );
}

async fn large_file_harness(dir: &std::path::Path) -> (Harness, String, Vec<u8>) {
    let store = Arc::new(DiskFileStore::new(dir).unwrap());
    let harness = Builder::new()
        .files(store)
        .licensed()
        .settings(|s| s.max_file_size = 0)
        .build();
    let mut content = vec![0xc3u8];
    content.extend(std::iter::repeat_n(7u8, 32 << 20));
    let chunks = stream::iter(
        content
            .chunks(1 << 16)
            .map(|c| Ok::<_, std::io::Error>(Bytes::copy_from_slice(c)))
            .collect::<Vec<_>>(),
    );
    let response = harness
        .send(
            req("POST", "/create/file")
                .header("content-type", "application/octet-stream")
                .header("x-yopass-expiration", "3600")
                .header("x-yopass-onetime", "true")
                .body(axum::body::Body::from_stream(chunks)),
        )
        .await;
    assert_eq!(response.status, 200, "{}", response.text());
    let key = response.message();
    (harness, key, content)
}

/// However delivery ends, a claimed file's ciphertext must not stay behind, and
/// the read was recorded before the first byte.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn aborted_download_is_recorded_and_deleted() {
    let dir = tempfile::tempdir().unwrap();
    let (harness, key, _) = large_file_harness(dir.path()).await;
    let server = run(&harness, Limits::default()).await;

    let mut client = TcpStream::connect(&server.address).await.unwrap();
    client
        .write_all(format!("GET /file/{key} HTTP/1.1\r\nHost: x\r\n\r\n").as_bytes())
        .await
        .unwrap();
    let mut buffer = [0u8; 4096];
    client.read_exact(&mut buffer).await.unwrap();
    assert!(String::from_utf8_lossy(&buffer).starts_with("HTTP/1.1 200"));
    drop(client);

    let blob = dir.path().join(&key[..2]).join(format!("{key}.bin"));
    eventually(
        "the claimed file must be deleted after an aborted download",
        async || !blob.exists(),
    )
    .await;
    let events = harness.audit_events();
    assert!(
        events
            .iter()
            .any(|e| e["event"] == "file.downloaded" && e["outcome"] == "success")
    );
    assert_eq!(harness.get(&format!("/file/{key}")).await.status, 404);
}

/// A peer that stops reading is cut off, freeing the connection and the file.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stalled_reader_is_disconnected() {
    let dir = tempfile::tempdir().unwrap();
    let (harness, key, _) = large_file_harness(dir.path()).await;
    let limits = Limits {
        write_stall: Duration::from_millis(300),
        ..Limits::default()
    };
    let server = run(&harness, limits).await;

    let client = TcpStream::connect(&server.address).await.unwrap();
    client.writable().await.unwrap();
    client
        .try_write(format!("GET /file/{key} HTTP/1.1\r\nHost: x\r\n\r\n").as_bytes())
        .unwrap();
    // Never reads a byte, with the socket buffers full.
    let blob = dir.path().join(&key[..2]).join(format!("{key}.bin"));
    eventually(
        "a stalled peer must not hold the file forever",
        async || !blob.exists(),
    )
    .await;
    drop(client);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn complete_download_over_a_real_socket() {
    let dir = tempfile::tempdir().unwrap();
    let (harness, key, content) = large_file_harness(dir.path()).await;
    let server = run(&harness, Limits::default()).await;
    let response = reqwest::get(format!("http://{}/file/{key}", server.address))
        .await
        .unwrap();
    assert_eq!(response.content_length(), Some(content.len() as u64));
    let body = response.bytes().await.unwrap();
    assert!(body == content, "downloaded bytes differ");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn idle_connections_are_closed() {
    let harness = harness();
    let limits = Limits {
        idle: Duration::from_millis(200),
        ..Limits::default()
    };
    let server = run(&harness, limits).await;
    let mut client = TcpStream::connect(&server.address).await.unwrap();
    let mut buffer = [0u8; 16];
    let read = tokio::time::timeout(Duration::from_secs(5), client.read(&mut buffer)).await;
    assert!(
        matches!(read, Ok(Ok(0) | Err(_))),
        "connection must be closed: {read:?}"
    );
}

/// An HTTP/1 client that never finishes its headers must not hold a connection.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn slow_headers_time_out() {
    let harness = harness();
    let server = run(&harness, Limits::default()).await;
    let mut client = TcpStream::connect(&server.address).await.unwrap();
    client
        .write_all(b"GET /config HTTP/1.1\r\nHost: x\r\nX-Slow: ")
        .await
        .unwrap();
    let mut buffer = Vec::new();
    let read = tokio::time::timeout(Duration::from_secs(15), client.read_to_end(&mut buffer)).await;
    assert!(
        read.is_ok(),
        "the server must give up on incomplete headers"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn oversized_headers_are_refused_on_http1() {
    let harness = harness();
    let server = run(&harness, Limits::default()).await;
    let client = reqwest::Client::new();
    let url = format!("http://{}/config", server.address);
    assert_eq!(
        client
            .get(&url)
            .header("x-ok", "a".repeat(1024))
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    let response = client
        .get(&url)
        .header("x-big", "a".repeat(64 << 10))
        .send()
        .await;
    match response {
        Ok(response) => assert_eq!(response.status(), 431),
        Err(error) => assert!(error.is_request() || error.is_connect(), "{error}"),
    }
}

/// Compressed HTTP/2 headers must be bounded after decoding.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn oversized_headers_are_refused_on_http2() {
    let harness = harness();
    let server = run(&harness, Limits::default()).await;
    let client = reqwest::Client::builder()
        .http2_prior_knowledge()
        .build()
        .unwrap();
    let url = format!("http://{}/config", server.address);
    let ok = client.get(&url).send().await.unwrap();
    assert_eq!(ok.version(), reqwest::Version::HTTP_2);
    assert_eq!(ok.status(), 200);
    let mut request = client.get(&url);
    for index in 0..64 {
        request = request.header(format!("x-pad-{index}"), "a".repeat(1024));
    }
    // A stream reset is an equally valid refusal.
    if let Ok(response) = request.send().await {
        assert_eq!(response.status(), 431);
    }
    assert_eq!(
        client.get(&url).send().await.unwrap().status(),
        200,
        "the connection stays usable"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_panicking_handler_answers_500_and_the_server_survives() {
    let db = GatedDb::new();
    let harness = Builder::with_db(db.clone()).build();
    let server = run(&harness, Limits::default()).await;
    let base = format!("http://{}", server.address);
    db.panic_on_status.store(true, Ordering::SeqCst);
    let failed = reqwest::get(format!("{base}/secret/{UUID_KEY}"))
        .await
        .unwrap();
    assert_eq!(failed.status(), 500);
    let body = failed.text().await.unwrap();
    assert!(
        !body.contains("simulated"),
        "panic details must not reach clients"
    );
    db.panic_on_status.store(false, Ordering::SeqCst);
    assert_eq!(
        reqwest::get(format!("{base}/health"))
            .await
            .unwrap()
            .status(),
        200
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn tls_with_http2_and_security_headers() {
    let harness = Builder::new().licensed().build();
    let tls = load_tls("tests/fixtures/tls_cert.pem", "tests/fixtures/tls_key.pem").unwrap();
    let server = run_tls(&harness, Limits::default(), Some(tls)).await;
    let port = server.address.rsplit(':').next().unwrap();
    let url = format!("https://localhost:{port}/config");

    let client = reqwest::Client::builder()
        .tls_danger_accept_invalid_certs(true)
        .build()
        .unwrap();
    let response = client.get(&url).send().await.unwrap();
    assert_eq!(
        response.version(),
        reqwest::Version::HTTP_2,
        "ALPN must offer h2"
    );
    assert_eq!(
        response.headers()["strict-transport-security"],
        "max-age=31536000"
    );

    let tls13 = reqwest::Client::builder()
        .tls_danger_accept_invalid_certs(true)
        .tls_version_min(reqwest::tls::Version::TLS_1_3)
        .build()
        .unwrap();
    assert_eq!(tls13.get(&url).send().await.unwrap().status(), 200);

    // Plain HTTP on the TLS port gets nothing useful.
    let plain = reqwest::get(format!("http://127.0.0.1:{port}/config")).await;
    assert!(plain.is_err());

    // A client that opens the socket and never does the handshake is not served.
    let mut stalled = TcpStream::connect(&server.address).await.unwrap();
    stalled.write_all(b"\x16\x03\x01").await.unwrap();
    assert_eq!(
        client.get(&url).send().await.unwrap().status(),
        200,
        "a stalled handshake must not block others"
    );
}

#[test]
fn tls_configuration_errors_are_reported() {
    assert!(load_tls("tests/fixtures/missing.pem", "tests/fixtures/tls_key.pem").is_err());
    assert!(load_tls("tests/fixtures/tls_cert.pem", "tests/fixtures/missing.pem").is_err());
    assert!(load_tls("tests/fixtures/tls_key.pem", "tests/fixtures/tls_cert.pem").is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn shutdown_lets_active_requests_finish() {
    let db = GatedDb::new();
    let harness = Builder::with_db(db.clone()).build();
    db.inner
        .put(UUID_KEY, &secret("ciphertext", true))
        .await
        .unwrap();
    db.gate_claims.store(true, Ordering::SeqCst);
    let server = run(&harness, Limits::default()).await;
    let url = format!("http://{}/secret/{UUID_KEY}", server.address);
    let request = tokio::spawn(async move { reqwest::get(url).await.unwrap() });
    db.entered.notified().await;
    server.stop.cancel();
    tokio::time::sleep(Duration::from_millis(100)).await;
    db.release.notify_one();
    let response = request.await.unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(
        response.json::<serde_json::Value>().await.unwrap()["message"],
        "ciphertext"
    );
    tokio::time::timeout(Duration::from_secs(5), server.task)
        .await
        .expect("server must stop")
        .unwrap();
}

/// `serve` returning is what lets the process exit, so it must outlast a response
/// still being written: the secret behind it has already been claimed.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn shutdown_waits_for_a_response_still_being_written() {
    let dir = tempfile::tempdir().unwrap();
    let (harness, key, content) = large_file_harness(dir.path()).await;
    let server = run(&harness, Limits::default()).await;
    let mut client = TcpStream::connect(&server.address).await.unwrap();
    client
        .write_all(format!("GET /file/{key} HTTP/1.1\r\nHost: x\r\n\r\n").as_bytes())
        .await
        .unwrap();
    let mut received = vec![0u8; 4096];
    client.read_exact(&mut received).await.unwrap();

    server.stop.cancel();
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(
        !server.task.is_finished(),
        "shutdown must not abandon an active download"
    );

    client.read_to_end(&mut received).await.unwrap();
    assert!(received.ends_with(&content), "the download must complete");
    tokio::time::timeout(Duration::from_secs(5), server.task)
        .await
        .expect("server must stop")
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn one_time_secret_over_real_connections_on_every_backend() {
    for (name, db) in backends() {
        let harness = Builder::with_db(db).build();
        let server = run(&harness, Limits::default()).await;
        let base = format!("http://{}", server.address);
        let client = reqwest::Client::new();
        let created: serde_json::Value = client
            .post(format!("{base}/create/secret"))
            .json(&json!({"message": PGP_MESSAGE, "expiration": 3600, "one_time": true}))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let key = created["message"].as_str().unwrap();
        let requests = (0..32).map(|_| client.get(format!("{base}/secret/{key}")).send());
        let results = futures_util::future::join_all(requests).await;
        let delivered = results
            .iter()
            .filter(|r| r.as_ref().unwrap().status() == 200)
            .count();
        assert_eq!(delivered, 1, "{name}");
    }
}

/// Refused uploads must reach the client as a response, not a connection reset:
/// a browser would otherwise show a network error instead of the reason.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn refused_uploads_get_an_answer_rather_than_a_reset() {
    let harness = Builder::new().settings(|s| s.max_file_size = 1024).build();
    let server = run(&harness, Limits::default()).await;
    let client = reqwest::Client::new();
    let url = format!("http://{}/create/file", server.address);
    let large = vec![0xc3u8; 8 << 20];
    let attempt = |content_type: &'static str, expiration: &'static str, chunked: bool| {
        let (client, url, large) = (client.clone(), url.clone(), large.clone());
        async move {
            let request = client
                .post(url)
                .header("content-type", content_type)
                .header("x-yopass-expiration", expiration);
            let request = if chunked {
                let chunks: Vec<Result<Vec<u8>, std::io::Error>> =
                    large.chunks(1 << 16).map(|c| Ok(c.to_vec())).collect();
                request.body(reqwest::Body::wrap_stream(stream::iter(chunks)))
            } else {
                request.body(large)
            };
            request
                .send()
                .await
                .expect("refusal must arrive as a response")
                .status()
                .as_u16()
        }
    };
    assert_eq!(
        attempt("application/octet-stream", "3600", false).await,
        413,
        "declared too large"
    );
    assert_eq!(
        attempt("application/octet-stream", "3600", true).await,
        413,
        "found too large while reading"
    );
    assert_eq!(
        attempt("text/plain", "3600", false).await,
        400,
        "wrong content type"
    );
    assert_eq!(
        attempt("application/octet-stream", "abc", false).await,
        400,
        "bad expiration"
    );
}

/// Deterministic version of the reset: the client is still sending while the
/// response is written. Closing with unread data would destroy the unread response
/// in the client's receive buffer.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn response_survives_unread_request_data_at_close() {
    let harness = Builder::new().settings(|s| s.max_file_size = 1024).build();
    let server = run(&harness, Limits::default()).await;
    let mut client = TcpStream::connect(&server.address).await.unwrap();
    client
        .write_all(upload_head(1 << 24).as_bytes())
        .await
        .unwrap();
    client.write_all(&vec![0xc3u8; 256 << 10]).await.unwrap();
    // Let the server answer and close while that data sits unread on its side.
    tokio::time::sleep(Duration::from_millis(300)).await;
    let _ = client.write_all(&vec![0xc3u8; 1024]).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    let mut response = Vec::new();
    let mut buffer = [0u8; 4096];
    loop {
        match tokio::time::timeout(Duration::from_secs(5), client.read(&mut buffer)).await {
            Ok(Ok(0)) => break,
            Ok(Ok(read)) => response.extend_from_slice(&buffer[..read]),
            Ok(Err(error)) => panic!("response destroyed by a reset: {error}"),
            Err(_) => panic!("server did not finish closing"),
        }
    }
    let response = String::from_utf8_lossy(&response);
    assert!(response.starts_with("HTTP/1.1 413"), "{response}");
    assert!(response.contains("File too large"), "{response}");
}

/// Raw HTTP/2 so a client cannot refuse the server's advertised limit: about
/// 1 KiB of HPACK that expands to `repeats` KiB of headers once decoded. Returns
/// the first header byte of the answer, if the server answered with HEADERS.
async fn send_hpack_expansion(address: &str, path: &str, repeats: usize) -> Option<u8> {
    let mut conn = TcpStream::connect(address).await.unwrap();
    conn.write_all(b"PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n")
        .await
        .unwrap();
    conn.write_all(&[0, 0, 0, 4, 0, 0, 0, 0, 0]).await.unwrap();
    // GET, http, a literal path and authority.
    let mut block = vec![0x82, 0x86, 0x04, path.len() as u8];
    block.extend_from_slice(path.as_bytes());
    block.extend_from_slice(&[0x01, 11]);
    block.extend_from_slice(b"example.com");
    // Index a 1000 byte cookie, then repeat dynamic table entry 62.
    block.extend_from_slice(&[0x60, 0x7f, 0xe9, 0x06]);
    block.extend_from_slice(&[b'a'; 1000]);
    block.extend(std::iter::repeat_n(0xbe, repeats));
    let length = block.len();
    let mut frame = vec![0, (length >> 8) as u8, length as u8, 1, 5, 0, 0, 0, 1];
    frame.extend_from_slice(&block);
    conn.write_all(&frame).await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let mut header = [0u8; 9];
            if conn.read_exact(&mut header).await.is_err() {
                return None; // a closed connection is a refusal
            }
            let size =
                usize::from(header[0]) << 16 | usize::from(header[1]) << 8 | usize::from(header[2]);
            assert!(size <= 16 << 10, "unexpectedly large response frame");
            let mut payload = vec![0; size];
            conn.read_exact(&mut payload).await.unwrap();
            match header[3] {
                1 => return payload.first().copied(),
                3 | 7 => return None,
                _ => {}
            }
        }
    })
    .await
    .expect("the server must decide the request")
}

/// HPACK's `:status: 200`, the indexed form every encoder uses for it.
const HPACK_STATUS_200: u8 = 0x88;

#[tokio::test]
async fn compressed_oversized_headers_never_reach_the_handler() {
    let harness = harness();
    let server = run(&harness, Limits::default()).await;
    let bomb = harness.create_secret(true).await;
    let path = format!("/secret/{bomb}");

    let answer = send_hpack_expansion(&server.address, &path, 200).await;
    assert_ne!(answer, Some(HPACK_STATUS_200), "the bomb was served");
    assert_eq!(
        harness.get(&format!("{path}/status")).await.status,
        200,
        "a refused request must not consume the secret"
    );

    // The same frames with few repeats do reach the handler, so the refusal above
    // is the header limit and not a malformed test request.
    let small = send_hpack_expansion(&server.address, &path, 2).await;
    assert_eq!(small, Some(HPACK_STATUS_200));
    assert_eq!(harness.get(&format!("{path}/status")).await.status, 404);
}

async fn run_metrics(harness: &Harness) -> Running {
    serve_router(
        app::metrics_router(harness.app.clone()),
        Limits::default(),
        None,
    )
    .await
}

#[tokio::test]
async fn metrics_listener_exposes_only_metrics() {
    let harness = harness();
    let key = harness.create_secret(true).await;
    harness.get("/config").await;
    let server = run_metrics(&harness).await;
    let base = format!("http://{}", server.address);

    let metrics = reqwest::get(format!("{base}/metrics")).await.unwrap();
    assert_eq!(metrics.status(), 200);
    assert_eq!(
        metrics.headers()["content-type"],
        "text/plain; version=0.0.4; charset=utf-8"
    );
    let text = metrics.text().await.unwrap();
    assert!(text.contains("yopass_http_requests_total"), "{text}");
    assert!(!text.contains(&key), "metrics must never carry a secret ID");

    // The application's routes must not be reachable through this port.
    for path in [
        format!("/secret/{key}"),
        format!("/secret/{key}/status"),
        format!("/file/{key}"),
        "/config".to_owned(),
        "/create/secret".to_owned(),
    ] {
        let response = reqwest::get(format!("{base}{path}")).await.unwrap();
        assert_eq!(response.status(), 404, "{path}");
    }
    assert_eq!(
        harness.get(&format!("/secret/{key}/status")).await.status,
        200
    );

    let client = reqwest::Client::new();
    let post = client.post(format!("{base}/metrics")).send().await.unwrap();
    assert_eq!(post.status(), 405);
}

#[tokio::test]
async fn metrics_listener_limits_headers_on_both_protocols() {
    let harness = harness();
    let server = run_metrics(&harness).await;

    let mut plain = TcpStream::connect(&server.address).await.unwrap();
    let huge = "a".repeat(128 * 1024);
    plain
        .write_all(format!("GET /metrics HTTP/1.1\r\nHost: x\r\nX-Pad: {huge}\r\n\r\n").as_bytes())
        .await
        .unwrap();
    let mut answer = vec![0; 32];
    let read = tokio::time::timeout(Duration::from_secs(5), plain.read(&mut answer))
        .await
        .unwrap()
        .unwrap_or(0);
    assert!(
        read == 0 || String::from_utf8_lossy(&answer[..read]).contains(" 431 "),
        "{}",
        String::from_utf8_lossy(&answer[..read])
    );

    let answer = send_hpack_expansion(&server.address, "/metrics", 200).await;
    assert_ne!(answer, Some(HPACK_STATUS_200));
    let small = send_hpack_expansion(&server.address, "/metrics", 2).await;
    assert_eq!(small, Some(HPACK_STATUS_200));
}

/// Sends a refused upload and returns once the server's 413 has arrived.
async fn refused_upload(address: &str) -> TcpStream {
    let mut conn = TcpStream::connect(address).await.unwrap();
    conn.write_all(
        b"POST /create/file HTTP/1.1\r\nHost: x\r\nContent-Type: application/octet-stream\r\n\
          X-Yopass-Expiration: 3600\r\nContent-Length: 1000000000\r\n\r\n",
    )
    .await
    .unwrap();
    let mut head = vec![0; 12];
    conn.read_exact(&mut head).await.unwrap();
    assert_eq!(&head, b"HTTP/1.1 413");
    conn
}

/// The lingering close that keeps refusals readable is bounded in bytes and
/// time, so a client cannot hold the connection by continuing to send.
#[tokio::test]
async fn lingering_after_a_refusal_is_bounded() {
    let harness = Builder::new().settings(|s| s.max_file_size = 1024).build();
    let server = run(&harness, Limits::default()).await;

    let mut flood = refused_upload(&server.address).await;
    let started = std::time::Instant::now();
    let chunk = vec![0xc3u8; 1 << 20];
    let mut sent = 0usize;
    while flood.write_all(&chunk).await.is_ok() {
        sent += chunk.len();
        assert!(sent <= 96 << 20, "the server kept reading past its cap");
        assert!(started.elapsed() < Duration::from_secs(10), "never closed");
    }

    // The server half-closes at once, then keeps reading for a while; writes
    // start failing only once it has really closed.
    let mut idle = refused_upload(&server.address).await;
    let started = std::time::Instant::now();
    let mut rest = Vec::new();
    idle.read_to_end(&mut rest).await.unwrap();
    while idle.write_all(b"x").await.is_ok() {
        assert!(started.elapsed() < Duration::from_secs(10), "never closed");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(
        started.elapsed() >= Duration::from_millis(1500),
        "closed before lingering: {:?}",
        started.elapsed()
    );
}

/// At the cap, a new peer waits until an open connection closes.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn connections_beyond_the_cap_wait_for_a_free_slot() {
    let harness = harness();
    let limits = Limits {
        max_connections: 2,
        ..Limits::default()
    };
    let server = run(&harness, limits).await;
    let request = b"GET /health HTTP/1.1\r\nHost: x\r\n\r\n";
    let answers = async |client: &mut TcpStream| {
        client.write_all(request).await.unwrap();
        let mut buffer = [0u8; 12];
        tokio::time::timeout(Duration::from_millis(500), client.read_exact(&mut buffer))
            .await
            .is_ok_and(|read| read.is_ok() && buffer.starts_with(b"HTTP/1.1 200"))
    };
    let mut first = TcpStream::connect(&server.address).await.unwrap();
    let mut second = TcpStream::connect(&server.address).await.unwrap();
    assert!(answers(&mut first).await && answers(&mut second).await);

    // The kernel completes the handshake, but the server does not take it.
    let mut third = TcpStream::connect(&server.address).await.unwrap();
    assert!(!answers(&mut third).await, "a third connection was served");
    drop(first);
    let mut buffer = [0u8; 12];
    tokio::time::timeout(Duration::from_secs(5), third.read_exact(&mut buffer))
        .await
        .expect("a freed slot must admit the waiting peer")
        .unwrap();
    assert!(buffer.starts_with(b"HTTP/1.1 200"));
    drop(second);
}

/// A handler that works longer than the idle limit keeps its connection, as in
/// Go, where IdleTimeout only applies between requests.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_slow_handler_is_not_an_idle_connection() {
    let router = axum::Router::new().route(
        "/slow",
        axum::routing::get(async || {
            tokio::time::sleep(Duration::from_millis(800)).await;
            "done"
        }),
    );
    let limits = Limits {
        idle: Duration::from_millis(200),
        ..Limits::default()
    };
    let server = serve_router(router, limits, None).await;
    let response = reqwest::get(format!("http://{}/slow", server.address))
        .await
        .expect("the connection must survive the handler");
    assert_eq!(response.text().await.unwrap(), "done");

    // Between requests the idle limit still applies.
    let mut client = TcpStream::connect(&server.address).await.unwrap();
    let mut buffer = [0u8; 16];
    let read = tokio::time::timeout(Duration::from_secs(5), client.read(&mut buffer)).await;
    assert!(
        matches!(read, Ok(Ok(0) | Err(_))),
        "idle connection stayed open"
    );
}

/// An HTTP/2 client that never grants flow-control window stops hyper from
/// polling the body, so the body cannot enforce its own deadline. The watchdog
/// closes the connection instead, releasing the claimed file.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_h2_peer_withholding_window_is_cut_off_at_the_transfer_deadline() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(DiskFileStore::new(dir.path()).unwrap());
    let harness = Builder::new()
        .files(store)
        .settings(|s| s.file_transfer_timeout = Some(Duration::from_millis(300)))
        .build();
    let response = harness
        .send(
            req("POST", "/create/file")
                .header("content-type", "application/octet-stream")
                .header("x-yopass-expiration", "3600")
                .header("x-yopass-onetime", "true")
                .body(axum::body::Body::from(vec![0xc3u8; 256 << 10])),
        )
        .await;
    assert_eq!(response.status, 200, "{}", response.text());
    let key = response.message();
    let server = run(&harness, Limits::default()).await;

    let tcp = TcpStream::connect(&server.address).await.unwrap();
    let (client, connection) = h2::client::Builder::new()
        .initial_window_size(0)
        .handshake::<_, Bytes>(tcp)
        .await
        .unwrap();
    let connection = tokio::spawn(connection);
    let mut client = client.ready().await.unwrap();
    let request = axum::http::Request::get(format!("http://localhost/file/{key}"))
        .body(())
        .unwrap();
    let (response, _) = client.send_request(request, true).unwrap();
    let response = response.await.unwrap();
    assert_eq!(response.status(), 200);
    let mut body = response.into_body();
    let ended = tokio::time::timeout(Duration::from_secs(5), body.data()).await;
    assert!(
        matches!(ended, Ok(Some(Err(_)) | None)),
        "the stalled transfer was never ended"
    );
    drop(connection);
    let blob = dir.path().join(&key[..2]).join(format!("{key}.bin"));
    eventually("the claimed file is released", async || !blob.exists()).await;
}
