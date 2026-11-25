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
    claims: AtomicUsize,
    entered: Notify,
    release: Notify,
    panic_on_status: AtomicBool,
}

impl GatedDb {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            inner: Arc::new(MemoryDb::new()),
            gate_claims: AtomicBool::new(false),
            claims: AtomicUsize::new(0),
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
        self.claims.fetch_add(1, Ordering::SeqCst);
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

/// The handler of a reset HTTP/2 stream runs on, but hyper stops counting the
/// stream at once. Without a count of its own, a connection that keeps resetting
/// its streams would start handlers without bound while never exceeding the
/// stream limit.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn reset_streams_cannot_start_more_handlers_than_the_stream_limit() {
    const STREAM_LIMIT: usize = 16;
    let db = GatedDb::new();
    let harness = Builder::with_db(db.clone()).build();
    db.inner
        .put(UUID_KEY, &secret("ciphertext", false))
        .await
        .unwrap();
    db.gate_claims.store(true, Ordering::SeqCst);
    let server = run(&harness, Limits::default()).await;

    let tcp = TcpStream::connect(&server.address).await.unwrap();
    let (mut client, connection) = h2::client::handshake(tcp).await.unwrap();
    let connection = tokio::spawn(connection);
    let get = || {
        axum::http::Request::get(format!("http://localhost/secret/{UUID_KEY}"))
            .body(())
            .unwrap()
    };
    for round in 0..3 {
        let mut streams = Vec::new();
        for _ in 0..STREAM_LIMIT {
            client = client.ready().await.unwrap();
            streams.push(client.send_request(get(), true).unwrap());
        }
        if round == 0 {
            eventually("a full round of handlers is held", async || {
                db.claims.load(Ordering::SeqCst) == STREAM_LIMIT
            })
            .await;
        } else {
            // Give hyper time to start handlers for this round, if it is going to.
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        // Dropping both halves of a stream sends RST_STREAM.
        drop(streams);
    }
    assert_eq!(
        db.claims.load(Ordering::SeqCst),
        STREAM_LIMIT,
        "reset streams made room for more handlers"
    );
    // Probes do not wait for the handlers holding the connection's slots.
    for path in ["/health", "/ready"] {
        client = client.ready().await.unwrap();
        let probe = axum::http::Request::get(format!("http://localhost{path}"))
            .body(())
            .unwrap();
        let (response, _) = client.send_request(probe, true).unwrap();
        let response = tokio::time::timeout(Duration::from_secs(5), response)
            .await
            .unwrap_or_else(|_| panic!("{path} queued behind the connection's handlers"))
            .unwrap();
        assert_eq!(response.status(), 200, "{path}");
    }

    // A handler that ends gives its slot back, so the connection still works.
    db.gate_claims.store(false, Ordering::SeqCst);
    db.release.notify_waiters();
    client = client.ready().await.unwrap();
    let (response, _) = client.send_request(get(), true).unwrap();
    let response = tokio::time::timeout(Duration::from_secs(5), response)
        .await
        .expect("a finished handler must free its slot")
        .unwrap();
    assert_eq!(response.status(), 200);
    drop(connection);
}

/// Handlers outlive their connection too. A client that closes each connection
/// and opens a new one must not start more handlers than all connections could
/// run at once.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn reconnecting_cannot_start_more_handlers_than_all_connections_hold() {
    const STREAM_LIMIT: usize = 16;
    let db = GatedDb::new();
    let harness = Builder::with_db(db.clone()).build();
    db.inner
        .put(UUID_KEY, &secret("ciphertext", false))
        .await
        .unwrap();
    db.gate_claims.store(true, Ordering::SeqCst);
    let limits = Limits {
        max_connections: 1,
        ..Limits::default()
    };
    let server = run(&harness, limits).await;
    let get = || {
        axum::http::Request::get(format!("http://localhost/secret/{UUID_KEY}"))
            .body(())
            .unwrap()
    };
    for round in 0..3 {
        let tcp = TcpStream::connect(&server.address).await.unwrap();
        let (mut client, connection) = h2::client::handshake(tcp).await.unwrap();
        let connection = tokio::spawn(connection);
        let mut streams = Vec::new();
        for _ in 0..STREAM_LIMIT {
            client = client.ready().await.unwrap();
            streams.push(client.send_request(get(), true).unwrap());
        }
        if round == 0 {
            eventually("a full round of handlers is held", async || {
                db.claims.load(Ordering::SeqCst) == STREAM_LIMIT
            })
            .await;
        } else {
            // Give the server time to start handlers for this round, if it is going to.
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        // No resets: the connection just goes away.
        connection.abort();
        drop((client, streams));
    }
    assert_eq!(
        db.claims.load(Ordering::SeqCst),
        STREAM_LIMIT,
        "closed connections made room for more handlers"
    );
}

/// Health probes do not queue behind the listener's handler slots: a server busy
/// with slow requests must not look dead and get restarted mid-transfer.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn health_probes_answer_while_every_handler_slot_is_held() {
    const STREAM_LIMIT: usize = 16;
    let db = GatedDb::new();
    let harness = Builder::with_db(db.clone()).build();
    db.inner
        .put(UUID_KEY, &secret("ciphertext", false))
        .await
        .unwrap();
    db.gate_claims.store(true, Ordering::SeqCst);
    let limits = Limits {
        max_connections: 1,
        ..Limits::default()
    };
    let server = run(&harness, limits).await;

    // One connection's worth of handlers holds every listener slot after it closes.
    let tcp = TcpStream::connect(&server.address).await.unwrap();
    let (mut client, connection) = h2::client::handshake(tcp).await.unwrap();
    let connection = tokio::spawn(connection);
    let mut streams = Vec::new();
    for _ in 0..STREAM_LIMIT {
        client = client.ready().await.unwrap();
        let request = axum::http::Request::get(format!("http://localhost/secret/{UUID_KEY}"))
            .body(())
            .unwrap();
        streams.push(client.send_request(request, true).unwrap());
    }
    eventually("every handler slot is held", async || {
        db.claims.load(Ordering::SeqCst) == STREAM_LIMIT
    })
    .await;
    connection.abort();
    drop((client, streams));

    for path in ["/health", "/ready"] {
        let mut probe = TcpStream::connect(&server.address).await.unwrap();
        let request = format!("GET {path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
        probe.write_all(request.as_bytes()).await.unwrap();
        let mut answer = Vec::new();
        tokio::time::timeout(Duration::from_secs(5), probe.read_to_end(&mut answer))
            .await
            .unwrap_or_else(|_| panic!("{path} queued behind the held handlers"))
            .unwrap();
        assert!(answer.starts_with(b"HTTP/1.1 200"), "{path}");
    }
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

/// Go's IdleTimeout runs between requests whatever else the peer sends. An
/// HTTP/2 peer that only sends PINGs has no request in progress, so it must not
/// keep its connection, and its share of the connection cap, for good.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn h2_pings_do_not_postpone_the_idle_limit() {
    let harness = harness();
    let limits = Limits {
        idle: Duration::from_millis(300),
        ..Limits::default()
    };
    let server = run(&harness, limits).await;
    let mut client = TcpStream::connect(&server.address).await.unwrap();
    client
        .write_all(b"PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n\0\0\0\x04\0\0\0\0\0")
        .await
        .unwrap();
    let closed = tokio::time::timeout(Duration::from_secs(3), async {
        let mut buffer = [0u8; 256];
        loop {
            let ping = b"\0\0\x08\x06\0\0\0\0\0keepopen";
            if client.write_all(ping).await.is_err() {
                return;
            }
            let read = tokio::time::timeout(Duration::from_millis(50), client.read(&mut buffer));
            if matches!(read.await, Ok(Ok(0) | Err(_))) {
                return;
            }
        }
    });
    assert!(closed.await.is_ok(), "PINGs kept an idle connection open");
}

/// A request is activity even when no traffic is counted for it: its head is
/// read before it is known to be one, and hyper drops the body of an empty
/// response before it writes the head.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_request_restarts_the_idle_limit() {
    let harness = harness();
    let limits = Limits {
        idle: Duration::from_millis(1500),
        ..Limits::default()
    };
    let server = run(&harness, limits).await;
    let mut client = TcpStream::connect(&server.address).await.unwrap();
    tokio::time::sleep(Duration::from_secs(1)).await;
    client
        .write_all(b"OPTIONS /config HTTP/1.1\r\nHost: x\r\n\r\n")
        .await
        .unwrap();
    let mut buffer = [0u8; 2048];
    let head = client.read(&mut buffer).await.unwrap();
    assert!(buffer[..head].starts_with(b"HTTP/1.1 200"));
    assert!(
        buffer[..head].ends_with(b"\r\n\r\n"),
        "the preflight answer has no body"
    );
    let early = tokio::time::timeout(Duration::from_secs(1), client.read(&mut buffer)).await;
    assert!(
        early.is_err(),
        "closed by the limit the request interrupted"
    );
    let late = tokio::time::timeout(Duration::from_secs(5), client.read(&mut buffer)).await;
    assert!(matches!(late, Ok(Ok(0) | Err(_))), "never closed: {late:?}");
}

/// A response still being delivered is not an idle connection, however slowly
/// the peer takes it. hyper is done with this body long before the peer is, so
/// the request stays unanswered until its data is written.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_slow_download_is_not_an_idle_connection() {
    const SIZE: usize = 512 << 10;
    let router = axum::Router::new().route("/large", axum::routing::get(async || vec![7u8; SIZE]));
    let limits = Limits {
        idle: Duration::from_millis(300),
        ..Limits::default()
    };
    let server = serve_router(router, limits, None).await;

    let tcp = TcpStream::connect(&server.address).await.unwrap();
    let (client, connection) = h2::client::Builder::new()
        .initial_window_size(16 << 10)
        .handshake::<_, Bytes>(tcp)
        .await
        .unwrap();
    let connection = tokio::spawn(connection);
    let mut client = client.ready().await.unwrap();
    let request = axum::http::Request::get("http://localhost/large")
        .body(())
        .unwrap();
    let (response, _) = client.send_request(request, true).unwrap();
    let mut body = response.await.unwrap().into_body();
    let started = std::time::Instant::now();
    let mut received = 0;
    while let Some(data) = body.data().await {
        let data = data.unwrap_or_else(|e| panic!("closed after {received} bytes: {e}"));
        received += data.len();
        tokio::time::sleep(Duration::from_millis(30)).await;
        body.flow_control().release_capacity(data.len()).unwrap();
    }
    assert_eq!(received, SIZE);
    assert!(started.elapsed() > Duration::from_millis(600));
    drop(connection);
}

/// The same over HTTP/1, where hyper takes a one-frame body at once and the rest
/// is still being written long after.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_slow_http1_download_is_not_an_idle_connection() {
    const SIZE: usize = 8 << 20;
    let router = axum::Router::new().route("/large", axum::routing::get(async || vec![7u8; SIZE]));
    let limits = Limits {
        idle: Duration::from_millis(300),
        ..Limits::default()
    };
    let server = serve_router(router, limits, None).await;
    // A small receive buffer, so the response cannot sit in the kernels instead.
    let socket = tokio::net::TcpSocket::new_v4().unwrap();
    socket.set_recv_buffer_size(16 << 10).unwrap();
    let mut client = socket
        .connect(server.address.parse().unwrap())
        .await
        .unwrap();
    client
        .write_all(b"GET /large HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
        .await
        .unwrap();
    let started = std::time::Instant::now();
    let mut received = 0;
    let mut buffer = vec![0u8; 256 << 10];
    loop {
        let read = client.read(&mut buffer).await.unwrap();
        if read == 0 {
            break;
        }
        received += read;
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    assert!(received > SIZE, "closed after {received} bytes");
    assert!(started.elapsed() > Duration::from_millis(600));
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
/// resets the stream instead, releasing the claimed file.
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

/// Counts the bytes downloads read from the store, a stand-in for what the
/// server buffers for a peer that is not reading.
struct CountingStore {
    inner: DiskFileStore,
    pulled: Arc<AtomicUsize>,
}

#[async_trait]
impl FileStore for CountingStore {
    async fn save(
        &self,
        key: &str,
        body: ByteStream,
        size: Option<u64>,
        expiration: i32,
    ) -> Result<(), FileError> {
        self.inner.save(key, body, size, expiration).await
    }
    async fn load(&self, key: &str) -> Result<(ByteStream, u64), FileError> {
        let (content, size) = self.inner.load(key).await?;
        let pulled = self.pulled.clone();
        let counted = content.inspect(move |chunk| {
            if let Ok(chunk) = chunk {
                pulled.fetch_add(chunk.len(), Ordering::SeqCst);
            }
        });
        Ok((Box::pin(counted), size))
    }
    async fn delete(&self, key: &str) -> Result<(), FileError> {
        self.inner.delete(key).await
    }
    async fn health(&self) -> Result<(), FileError> {
        self.inner.health().await
    }
}

/// An HTTP/2 peer picks its own flow-control window, so one that opens it wide
/// and stops reading must not get each stream's response read into memory.
/// Raw frames, because a real client would read.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_h2_peer_that_stops_reading_is_not_buffered_for() {
    // As many as a connection may have open: any more are refused, and would
    // only loosen the bound below.
    const STREAMS: usize = 16;
    const SIZE: usize = 500_000;
    let dir = tempfile::tempdir().unwrap();
    let pulled = Arc::new(AtomicUsize::new(0));
    let store = Arc::new(CountingStore {
        inner: DiskFileStore::new(dir.path()).unwrap(),
        pulled: pulled.clone(),
    });
    let harness = Builder::new().files(store).build();
    let response = harness
        .send(
            req("POST", "/create/file")
                .header("content-type", "application/octet-stream")
                .header("x-yopass-expiration", "3600")
                .header("x-yopass-onetime", "false")
                .body(axum::body::Body::from(vec![0xc3u8; SIZE])),
        )
        .await;
    assert_eq!(response.status, 200, "{}", response.text());
    let path = format!("/file/{}", response.message());
    let server = run(&harness, Limits::default()).await;

    // A small receive buffer, so responses cannot pile up in the client's kernel.
    let socket = tokio::net::TcpSocket::new_v4().unwrap();
    socket.set_recv_buffer_size(4096).unwrap();
    let mut conn = socket
        .connect(server.address.parse().unwrap())
        .await
        .unwrap();
    let mut frames = b"PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n".to_vec();
    // SETTINGS with INITIAL_WINDOW_SIZE 2^31-1, and a WINDOW_UPDATE raising the
    // connection's window to the same.
    frames.extend_from_slice(&[0, 0, 6, 4, 0, 0, 0, 0, 0, 0, 4, 0x7f, 0xff, 0xff, 0xff]);
    frames.extend_from_slice(&[0, 0, 4, 8, 0, 0, 0, 0, 0, 0x7f, 0xff, 0, 0]);
    // GET, http, a literal path and authority.
    let mut block = vec![0x82, 0x86, 0x04, path.len() as u8];
    block.extend_from_slice(path.as_bytes());
    block.extend_from_slice(&[0x01, 1, b'x']);
    for stream in 0..STREAMS as u32 {
        frames.extend_from_slice(&[0, 0, block.len() as u8, 1, 5]);
        frames.extend_from_slice(&(1 + 2 * stream).to_be_bytes());
        frames.extend_from_slice(&block);
    }
    conn.write_all(&frames).await.unwrap();

    let probe = pulled.clone();
    eventually("the downloads must start", async || {
        probe.load(Ordering::SeqCst) > 0
    })
    .await;
    tokio::time::sleep(Duration::from_secs(1)).await;
    let held = pulled.load(Ordering::SeqCst);
    // Without a send-buffer cap every stream reads its whole file.
    assert!(
        held < STREAMS * SIZE / 2,
        "{held} bytes were read for a peer that reads nothing"
    );
    drop(conn);
}

/// Uploads a 256 KiB one-time file and returns its key.
async fn upload_256k(harness: &Harness) -> String {
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
    response.message()
}

/// Serves one 256 KiB asset, `/app.js`, with both whole-request deadlines off.
fn asset_harness(assets: &tempfile::TempDir) -> Harness {
    std::fs::write(assets.path().join("app.js"), vec![b'a'; 256 << 10]).unwrap();
    let path = assets.path().to_str().unwrap().to_owned();
    Builder::new()
        .settings(|s| {
            s.asset_path = path;
            s.request_timeout = None;
            s.file_transfer_timeout = None;
        })
        .build()
}

/// Opens an HTTP/2 connection with `window` bytes of stream window, sending
/// PINGs so the idle limit never ends it, and returns the response body.
async fn h2_get(address: &str, path: &str, window: u32) -> h2::RecvStream {
    let tcp = TcpStream::connect(address).await.unwrap();
    let (client, mut connection) = h2::client::Builder::new()
        .initial_window_size(window)
        .handshake::<_, Bytes>(tcp)
        .await
        .unwrap();
    let mut pings = connection.ping_pong().unwrap();
    tokio::spawn(connection);
    tokio::spawn(async move {
        while pings.ping(h2::Ping::opaque()).await.is_ok() {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    });
    let mut client = client.ready().await.unwrap();
    let request = axum::http::Request::get(format!("http://localhost{path}"))
        .body(())
        .unwrap();
    let (response, _) = client.send_request(request, true).unwrap();
    let response = response.await.unwrap();
    assert_eq!(response.status(), 200);
    response.into_body()
}

async fn assert_cut_off(body: &mut h2::RecvStream) {
    let ended = loop {
        match tokio::time::timeout(Duration::from_secs(5), body.data()).await {
            Ok(Some(Ok(_))) => continue,
            ended => break ended,
        }
    };
    assert!(
        matches!(ended, Ok(Some(Err(_)) | None)),
        "the stalled response was never ended"
    );
}

/// A peer that grants no window never blocks the socket and its PINGs keep the
/// connection busy; with no deadline set, the stall limit still applies.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_h2_peer_withholding_window_is_cut_off_without_any_deadline() {
    let assets = tempfile::tempdir().unwrap();
    let harness = asset_harness(&assets);
    let limits = Limits {
        write_stall: Duration::from_millis(300),
        ..Limits::default()
    };
    let server = run(&harness, limits).await;
    assert_cut_off(&mut h2_get(&server.address, "/app.js", 0).await).await;
}

/// `--request-timeout` bounds response writes, well inside the stall limit.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn responses_without_a_transfer_deadline_get_the_response_deadline() {
    let assets = tempfile::tempdir().unwrap();
    let harness = asset_harness(&assets);
    let limits = Limits {
        response: Some(Duration::from_millis(300)),
        ..Limits::default()
    };
    let server = run(&harness, limits).await;
    assert_cut_off(&mut h2_get(&server.address, "/app.js", 0).await).await;
}

/// The database store hands over a file as one frame. One byte of window lets
/// hyper take it and drop the body with the rest still queued; the deadline
/// must still apply until the data is written.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_h2_peer_granting_one_byte_of_window_is_cut_off_at_the_transfer_deadline() {
    let harness = Builder::new()
        .settings(|s| s.file_transfer_timeout = Some(Duration::from_millis(300)))
        .build();
    let path = format!("/file/{}", upload_256k(&harness).await);
    let server = run(&harness, Limits::default()).await;
    assert_cut_off(&mut h2_get(&server.address, &path, 1).await).await;
}

/// A slow peer that keeps accepting bytes is served, however long it takes,
/// even of a file the database store hands over as one frame.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_slow_h2_peer_that_keeps_accepting_bytes_gets_the_whole_response() {
    let harness = Builder::new()
        .settings(|s| s.file_transfer_timeout = None)
        .build();
    let path = format!("/file/{}", upload_256k(&harness).await);
    let limits = Limits {
        write_stall: Duration::from_millis(300),
        ..Limits::default()
    };
    let server = run(&harness, limits).await;
    let mut body = h2_get(&server.address, &path, 16 << 10).await;
    let (started, mut received) = (std::time::Instant::now(), 0);
    while let Some(chunk) = body.data().await {
        let chunk = chunk.expect("a peer making progress must not be cut off");
        received += chunk.len();
        tokio::time::sleep(Duration::from_millis(100)).await;
        body.flow_control().release_capacity(chunk.len()).unwrap();
    }
    assert_eq!(received, 256 << 10);
    assert!(started.elapsed() > 2 * limits.write_stall);
}

/// A proxy speaking HTTP/2 to the server carries unrelated clients' requests on
/// one connection. A download one of them leaves unread must end alone, as in
/// Go, where the write deadline resets the stream.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_stalled_h2_download_does_not_end_other_streams_on_its_connection() {
    let db = GatedDb::new();
    let harness = Builder::with_db(db.clone())
        .settings(|s| s.file_transfer_timeout = Some(Duration::from_millis(300)))
        .build();
    let key = upload_256k(&harness).await;
    db.inner
        .put(UUID_KEY, &secret("ciphertext", true))
        .await
        .unwrap();
    let server = run(&harness, Limits::default()).await;

    let tcp = TcpStream::connect(&server.address).await.unwrap();
    let (client, connection) = h2::client::Builder::new()
        .initial_window_size(0)
        .handshake::<_, Bytes>(tcp)
        .await
        .unwrap();
    tokio::spawn(connection);
    let mut client = client.ready().await.unwrap();
    let request = axum::http::Request::get(format!("http://localhost/file/{key}"))
        .body(())
        .unwrap();
    let (stalled, _) = client.send_request(request, true).unwrap();
    let stalled = stalled.await.unwrap();
    assert_eq!(stalled.status(), 200);

    // Another client's request is held in its handler past that deadline.
    db.gate_claims.store(true, Ordering::SeqCst);
    let mut client = client.ready().await.unwrap();
    let request = axum::http::Request::get(format!("http://localhost/secret/{UUID_KEY}"))
        .body(())
        .unwrap();
    let (other, _) = client.send_request(request, true).unwrap();
    db.entered.notified().await;

    assert_cut_off(&mut stalled.into_body()).await;
    db.release.notify_one();
    let other = tokio::time::timeout(Duration::from_secs(5), other)
        .await
        .expect("the other request was never answered")
        .expect("the other stream ended with the stalled one");
    assert_eq!(other.status(), 200);
}
