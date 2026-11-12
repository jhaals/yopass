//! Shared test harness: backends, an in-process HTTP client, fault injection.
#![allow(dead_code)]

pub mod fake_s3;

use async_trait::async_trait;
use axum::Router;
use axum::body::Body;
use axum::http::{HeaderMap, Method, Request, StatusCode};
use bytes::Bytes;
use futures_util::{StreamExt, stream};
use http_body_util::BodyExt;
use serde_json::Value;
use std::net::IpAddr;
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tower::ServiceExt;
use yopass_server::app::{self, App, Settings};
use yopass_server::audit::AuditLogger;
use yopass_server::auth::{CookieCodec, SESSION_COOKIE, SESSION_MAX_AGE, Session};
use yopass_server::db::memcached::Memcached;
use yopass_server::db::memory::MemoryDb;
use yopass_server::db::redis::Redis;
use yopass_server::db::{Authorize, Database, DbError, Secret, UpdateFn};
use yopass_server::files::database::DatabaseFileStore;
use yopass_server::files::{ByteStream, FileError, FileStore};
use yopass_server::handlers::ConnInfo;
use yopass_server::license::License;
use yopass_server::util::now_unix;

pub const PGP_MESSAGE: &str = "-----BEGIN PGP MESSAGE-----\nVersion: OpenPGP.js v4.10.8\nComment: https://openpgpjs.org\n\nwy4ECQMIRthQ3aO85NvgAfASIX3dTwsFVt0gshPu7n1tN05e8rpqxOk6PYNm\nxtt90k4BqHuTCLNlFRJjuiuE8zdIc+j5zTN5zihxUReVqokeqULLOx2FBMHZ\nsbfqaG/iDbp+qDOc98IagMyPrEqKDxnhVVOraXy5dD9RDsntLso=\n=0vwU\n-----END PGP MESSAGE-----";
pub const PUBLIC_KEY: &str = include_str!("../fixtures/public_key.asc");
pub const UUID_KEY: &str = "12345678-1234-1234-1234-123456789012";
/// A new-format SKESK packet header followed by payload.
pub const PGP_BINARY: &[u8] = b"\xc3\x04data";

pub fn redis_url() -> Option<String> {
    std::env::var("REDIS_URL").ok().filter(|v| !v.is_empty())
}

pub fn memcached_addr() -> Option<String> {
    std::env::var("MEMCACHED").ok().filter(|v| !v.is_empty())
}

/// Every backend reachable in this environment. Only the in-memory one is always
/// present; set REDIS_URL, VALKEY_URL and MEMCACHED to include the real ones.
pub fn backends() -> Vec<(&'static str, Arc<dyn Database>)> {
    let mut list: Vec<(&'static str, Arc<dyn Database>)> =
        vec![("memory", Arc::new(MemoryDb::new()))];
    if let Some(url) = redis_url() {
        list.push(("redis", Arc::new(Redis::new(&url).unwrap())));
    }
    if let Some(url) = std::env::var("VALKEY_URL").ok().filter(|v| !v.is_empty()) {
        list.push(("valkey", Arc::new(Redis::new(&url).unwrap())));
    }
    if let Some(address) = memcached_addr() {
        list.push(("memcached", Arc::new(Memcached::new(&address))));
    }
    if let Some(url) = sentinel_url() {
        list.push(("sentinel", Arc::new(Redis::new(&url).unwrap())));
    }
    list
}

/// A Sentinel set, as `tests/sentinel.sh` prints it.
pub fn sentinel_url() -> Option<String> {
    std::env::var("SENTINEL_URL").ok().filter(|v| !v.is_empty())
}

/// A connection to the first Sentinel of `url`, with its Sentinel password.
pub async fn sentinel_conn(url: &str) -> redis::aio::MultiplexedConnection {
    let url = url::Url::parse(url).unwrap();
    let password = url.password().unwrap_or("");
    let address = format!(
        "redis://:{password}@{}:{}",
        url.host_str().unwrap(),
        url.port().unwrap()
    );
    redis::Client::open(address)
        .unwrap()
        .get_multiplexed_async_connection()
        .await
        .unwrap()
}

/// The primary's address, as the Sentinels report it.
pub async fn sentinel_primary(sentinel: &mut redis::aio::MultiplexedConnection) -> (String, u16) {
    let (host, port): (String, String) = redis::cmd("SENTINEL")
        .arg("get-master-addr-by-name")
        .arg("mymaster")
        .query_async(sentinel)
        .await
        .unwrap();
    (host, port.parse().unwrap())
}

/// A direct connection to one node of the Sentinel set of `url`, with the
/// Redis password from its query.
pub async fn sentinel_node(
    url: &str,
    address: &(String, u16),
) -> redis::aio::MultiplexedConnection {
    let url = url::Url::parse(url).unwrap();
    let password = url
        .query_pairs()
        .find(|(k, _)| k == "password")
        .map(|(_, v)| v.into_owned())
        .unwrap_or_default();
    redis::Client::open(format!("redis://:{password}@{}:{}", address.0, address.1))
        .unwrap()
        .get_multiplexed_async_connection()
        .await
        .unwrap()
}

pub fn valid_license() -> License {
    License::valid_until(now_unix() + 3600)
}

pub fn expired_license() -> License {
    License {
        valid: false,
        expires_at: Some(now_unix() - 10),
        licensee: String::new(),
    }
}

#[derive(Clone, Default)]
pub struct SharedBuffer(pub Arc<Mutex<Vec<u8>>>);

impl std::io::Write for SharedBuffer {
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(data);
        Ok(data.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl SharedBuffer {
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.0.lock().unwrap()).into_owned()
    }
}

/// Captures every log line of the test binary. Tests share it, so they search for
/// values unique to themselves.
pub fn captured_logs() -> SharedBuffer {
    static LOGS: OnceLock<SharedBuffer> = OnceLock::new();
    LOGS.get_or_init(|| {
        let buffer = SharedBuffer::default();
        let writer = buffer.clone();
        tracing_subscriber::fmt()
            .json()
            .with_max_level(tracing::Level::DEBUG)
            .with_writer(move || writer.clone())
            .try_init()
            .ok();
        buffer
    })
    .clone()
}

pub struct Harness {
    pub app: Arc<App>,
    pub router: Router,
    pub audit: SharedBuffer,
    pub peer: IpAddr,
}

pub struct Builder {
    pub settings: Settings,
    pub db: Arc<dyn Database>,
    pub files: Option<Arc<dyn FileStore>>,
    pub license: License,
    pub session_key: bool,
    pub webhooks: Option<yopass_server::webhook::WebhookNotifier>,
}

impl Builder {
    pub fn new() -> Self {
        Self::with_db(Arc::new(MemoryDb::new()))
    }

    pub fn with_db(db: Arc<dyn Database>) -> Self {
        let files: Arc<dyn FileStore> = Arc::new(DatabaseFileStore::new(db.clone()));
        Self {
            settings: Settings {
                asset_path: String::new(),
                ..Settings::default()
            },
            db,
            files: Some(files),
            license: License::default(),
            session_key: false,
            webhooks: None,
        }
    }

    pub fn licensed(mut self) -> Self {
        self.license = valid_license();
        self
    }

    pub fn settings(mut self, mutate: impl FnOnce(&mut Settings)) -> Self {
        mutate(&mut self.settings);
        self
    }

    pub fn files(mut self, files: Arc<dyn FileStore>) -> Self {
        self.files = Some(files);
        self
    }

    pub fn sessions(mut self) -> Self {
        self.session_key = true;
        self
    }

    pub fn build(self) -> Harness {
        let audit = SharedBuffer::default();
        let mut app = App::new(self.settings, self.db, self.files);
        app.license = self.license;
        app.audit_logger = Some(Arc::new(AuditLogger::new(Box::new(audit.clone()))));
        app.webhooks = self.webhooks;
        if self.session_key {
            app.sessions = Some(CookieCodec::from_key([9; 32]));
        }
        let app = Arc::new(app);
        Harness {
            router: app::router(app.clone()),
            app,
            audit,
            peer: "203.0.113.9".parse().unwrap(),
        }
    }
}

pub fn harness() -> Harness {
    Builder::new().build()
}

pub struct Resp {
    pub status: StatusCode,
    pub headers: HeaderMap,
    pub body: Vec<u8>,
}

impl Resp {
    pub fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or_else(|_| panic!("not JSON: {}", self.text()))
    }

    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    pub fn message(&self) -> String {
        self.json()["message"]
            .as_str()
            .unwrap_or_default()
            .to_owned()
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).and_then(|v| v.to_str().ok())
    }
}

pub struct Req {
    method: Method,
    path: String,
    headers: Vec<(String, String)>,
    body: Body,
}

pub fn req(method: &str, path: &str) -> Req {
    Req {
        method: method.parse().unwrap(),
        path: path.to_owned(),
        headers: Vec::new(),
        body: Body::empty(),
    }
}

impl Req {
    pub fn header(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.to_owned(), value.to_owned()));
        self
    }

    pub fn body(mut self, body: impl Into<Body>) -> Self {
        self.body = body.into();
        self
    }

    pub fn json(self, value: &Value) -> Self {
        self.header("content-type", "application/json")
            .body(value.to_string())
    }
}

impl Harness {
    pub async fn send(&self, request: Req) -> Resp {
        let mut builder = Request::builder().method(request.method).uri(request.path);
        for (name, value) in request.headers {
            builder = builder.header(name, value);
        }
        let mut http = builder.body(request.body).unwrap();
        http.extensions_mut().insert(ConnInfo {
            peer: self.peer,
            tls: false,
        });
        let response = self.router.clone().oneshot(http).await.unwrap();
        let (parts, body) = response.into_parts();
        let body = body
            .collect()
            .await
            .map(|b| b.to_bytes().to_vec())
            .unwrap_or_default();
        Resp {
            status: parts.status,
            headers: parts.headers,
            body,
        }
    }

    pub async fn get(&self, path: &str) -> Resp {
        self.send(req("GET", path)).await
    }

    pub async fn delete(&self, path: &str) -> Resp {
        self.send(req("DELETE", path)).await
    }

    pub async fn create_secret(&self, one_time: bool) -> String {
        let response = self
            .send(req("POST", "/create/secret").json(&serde_json::json!({
                "message": PGP_MESSAGE, "expiration": 3600, "one_time": one_time,
            })))
            .await;
        assert_eq!(response.status, 200, "{}", response.text());
        response.message()
    }

    pub async fn upload(&self, one_time: bool) -> String {
        let response = self.send(upload_req(PGP_BINARY, "3600", one_time)).await;
        assert_eq!(response.status, 200, "{}", response.text());
        response.message()
    }

    pub fn audit_events(&self) -> Vec<Value> {
        self.audit
            .text()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    pub fn last_audit(&self) -> Value {
        self.audit_events().pop().expect("no audit event recorded")
    }

    /// A session cookie as the login flow would issue it.
    pub fn session_cookie(&self, email: &str) -> String {
        let session = Session {
            id: yopass_server::util::random_hex(),
            sub: "user-1".into(),
            email: email.into(),
            name: "User".into(),
        };
        self.cookie_for(&session)
    }

    pub fn cookie_for(&self, session: &Session) -> String {
        let codec = self.app.sessions.as_ref().expect("sessions enabled");
        format!(
            "{SESSION_COOKIE}={}",
            codec
                .seal(SESSION_COOKIE, session, SESSION_MAX_AGE)
                .unwrap()
        )
    }
}

pub fn upload_req(body: &'static [u8], expiration: &str, one_time: bool) -> Req {
    req("POST", "/create/file")
        .header("content-type", "application/octet-stream")
        .header("x-yopass-expiration", expiration)
        .header("x-yopass-onetime", if one_time { "true" } else { "false" })
        .body(body)
}

pub fn secret(message: &str, one_time: bool) -> Secret {
    Secret {
        message: message.into(),
        expiration: 60,
        one_time,
        require_auth: false,
    }
}

/// Runs async work from inside a synchronous database callback.
pub fn block_on<F: std::future::Future>(future: F) -> F::Output {
    tokio::task::block_in_place(|| tokio::runtime::Handle::current().block_on(future))
}

/// Wraps a database and fails selected operations, for outage and error paths.
#[derive(Default)]
pub struct Faults {
    pub status: Mutex<Option<&'static str>>,
    pub put: Mutex<Option<&'static str>>,
    pub update: Mutex<Option<&'static str>>,
    pub delete: Mutex<Option<&'static str>>,
    pub claim: Mutex<Option<ClaimFault>>,
    pub health: AtomicBool,
    /// Runs inside the claim after authorization, before the value is consumed.
    pub during_claim: Mutex<Option<Box<dyn Fn(Arc<dyn Database>, String) + Send + Sync>>>,
    pub status_calls: AtomicUsize,
    /// Runs once right after a status read, before the handler acts on it.
    pub after_status: Mutex<Option<Box<dyn FnOnce(Arc<dyn Database>, String) + Send + Sync>>>,
}

#[derive(Clone, Copy)]
pub enum ClaimFault {
    Backend,
    LostRace,
}

pub struct FaultDb {
    pub inner: Arc<dyn Database>,
    pub faults: Faults,
}

impl FaultDb {
    pub fn new(inner: Arc<dyn Database>) -> Arc<Self> {
        Arc::new(Self {
            inner,
            faults: Faults::default(),
        })
    }

    fn fail(slot: &Mutex<Option<&'static str>>, key: &str) -> Result<(), DbError> {
        match *slot.lock().unwrap() {
            Some(prefix) if key.starts_with(prefix) => Err(DbError::Backend(format!(
                "database transport failure for {key}"
            ))),
            _ => Ok(()),
        }
    }
}

#[async_trait]
impl Database for FaultDb {
    async fn status(&self, key: &str) -> Result<Secret, DbError> {
        self.faults.status_calls.fetch_add(1, Ordering::SeqCst);
        Self::fail(&self.faults.status, key)?;
        let value = self.inner.status(key).await;
        let hook = self.faults.after_status.lock().unwrap().take();
        if let Some(hook) = hook {
            hook(self.inner.clone(), key.to_owned());
        }
        value
    }

    async fn get_authorized(&self, key: &str, authorize: &Authorize) -> Result<Secret, DbError> {
        let hook = &self.faults.during_claim;
        let claim = *self.faults.claim.lock().unwrap();
        let inner = self.inner.clone();
        let authorized = |secret: &Secret| {
            authorize(secret)?;
            if let Some(hook) = &*hook.lock().unwrap() {
                hook(inner.clone(), key.to_owned());
            }
            Ok(())
        };
        if let Some(fault) = claim {
            authorized(&self.inner.status(key).await?).map_err(DbError::Aborted)?;
            return match fault {
                ClaimFault::Backend => Err(DbError::Backend(format!("claim failed for {key}"))),
                ClaimFault::LostRace => Err(DbError::NotFound),
            };
        }
        self.inner.get_authorized(key, &authorized).await
    }

    async fn delete_authorized(&self, key: &str, authorize: &Authorize) -> Result<(), DbError> {
        Self::fail(&self.faults.delete, key)?;
        let hook = &self.faults.during_claim;
        let inner = self.inner.clone();
        self.inner
            .delete_authorized(key, &|secret: &Secret| {
                authorize(secret)?;
                if let Some(hook) = &*hook.lock().unwrap() {
                    hook(inner.clone(), key.to_owned());
                }
                Ok(())
            })
            .await
    }

    async fn put(&self, key: &str, secret: &Secret) -> Result<(), DbError> {
        Self::fail(&self.faults.put, key)?;
        self.inner.put(key, secret).await
    }

    async fn delete(&self, key: &str) -> Result<bool, DbError> {
        Self::fail(&self.faults.delete, key)?;
        self.inner.delete(key).await
    }

    async fn update(&self, key: &str, update: &UpdateFn) -> Result<(), DbError> {
        Self::fail(&self.faults.update, key)?;
        self.inner.update(key, update).await
    }

    async fn health(&self) -> Result<(), DbError> {
        if self.faults.health.load(Ordering::SeqCst) {
            return Err(DbError::Backend("backend down".into()));
        }
        self.inner.health().await
    }
}

/// Wraps a store and injects failures.
#[derive(Default)]
pub struct FaultStore {
    pub blobs: Mutex<std::collections::HashMap<String, Vec<u8>>>,
    pub fail_load: AtomicBool,
    pub fail_save: AtomicBool,
    pub fail_delete: AtomicBool,
    pub deletes: AtomicUsize,
    pub saves_started: AtomicUsize,
}

#[async_trait]
impl FileStore for FaultStore {
    async fn save(
        &self,
        key: &str,
        mut body: ByteStream,
        _size: Option<u64>,
        _expiration: i32,
    ) -> Result<(), FileError> {
        self.saves_started.fetch_add(1, Ordering::SeqCst);
        let mut data = Vec::new();
        while let Some(chunk) = body.next().await {
            data.extend_from_slice(&chunk.map_err(FileError::Read)?);
        }
        if self.fail_save.load(Ordering::SeqCst) {
            return Err(FileError::Storage(format!(
                "s3 put https://bucket/{key} failed"
            )));
        }
        self.blobs.lock().unwrap().insert(key.to_owned(), data);
        Ok(())
    }

    async fn load(&self, key: &str) -> Result<(ByteStream, u64), FileError> {
        if self.fail_load.load(Ordering::SeqCst) {
            return Err(FileError::Storage(format!(
                "s3 get https://bucket/{key} failed"
            )));
        }
        let data = self
            .blobs
            .lock()
            .unwrap()
            .get(key)
            .cloned()
            .ok_or(FileError::NotFound)?;
        let size = data.len() as u64;
        Ok((
            Box::pin(stream::once(async move { Ok(Bytes::from(data)) })),
            size,
        ))
    }

    async fn delete(&self, key: &str) -> Result<(), FileError> {
        self.deletes.fetch_add(1, Ordering::SeqCst);
        if self.fail_delete.load(Ordering::SeqCst) {
            return Err(FileError::Storage(format!(
                "s3 delete https://bucket/{key} failed"
            )));
        }
        self.blobs.lock().unwrap().remove(key);
        Ok(())
    }

    async fn health(&self) -> Result<(), FileError> {
        Ok(())
    }
}

pub const FAULT_NONE: u8 = 0;
/// The backend applies the command but the reply never reaches the client.
pub const FAULT_LOST_REPLY: u8 = 1;
/// The command never reaches the backend.
pub const FAULT_LOST_COMMAND: u8 = 2;

/// A TCP proxy in front of a real backend that loses traffic around a chosen
/// command, proving recovery against the real server's behaviour.
pub struct LossyProxy {
    pub address: String,
    pub fault: Arc<AtomicU8>,
    pub seen: Arc<AtomicUsize>,
}

fn contains_ignore_case(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window.eq_ignore_ascii_case(needle))
}

impl LossyProxy {
    pub async fn start(upstream: String, command: &'static [u8]) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap().to_string();
        let fault = Arc::new(AtomicU8::new(FAULT_NONE));
        let seen = Arc::new(AtomicUsize::new(0));
        let (task_fault, task_seen) = (fault.clone(), seen.clone());
        tokio::spawn(async move {
            while let Ok((client, _)) = listener.accept().await {
                let upstream = upstream.clone();
                let (fault, seen) = (task_fault.clone(), task_seen.clone());
                tokio::spawn(async move {
                    let Ok(server) = TcpStream::connect(&upstream).await else {
                        return;
                    };
                    pump(client, server, command, fault, seen).await;
                });
            }
        });
        Self {
            address,
            fault,
            seen,
        }
    }
}

async fn pump(
    mut client: TcpStream,
    mut server: TcpStream,
    command: &[u8],
    fault: Arc<AtomicU8>,
    seen: Arc<AtomicUsize>,
) {
    let (mut buffer_c, mut buffer_s) = (vec![0u8; 1 << 16], vec![0u8; 1 << 16]);
    let mut drop_next_reply = false;
    loop {
        tokio::select! {
            read = client.read(&mut buffer_c) => {
                let Ok(n) = read else { return };
                if n == 0 { return; }
                if contains_ignore_case(&buffer_c[..n], command) {
                    seen.fetch_add(1, Ordering::SeqCst);
                    match fault.swap(FAULT_NONE, Ordering::SeqCst) {
                        FAULT_LOST_REPLY => drop_next_reply = true,
                        // Closing makes the client see the loss immediately.
                        FAULT_LOST_COMMAND => return,
                        _ => {}
                    }
                }
                if server.write_all(&buffer_c[..n]).await.is_err() { return; }
            }
            read = server.read(&mut buffer_s) => {
                let Ok(n) = read else { return };
                if n == 0 { return; }
                if drop_next_reply { return; }
                if client.write_all(&buffer_s[..n]).await.is_err() { return; }
            }
        }
    }
}

/// Polls until `condition` holds, panicking with `what` after about 5s.
pub async fn eventually(what: &str, condition: impl AsyncFn() -> bool) {
    for _ in 0..500 {
        if condition().await {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("never happened: {what}");
}
