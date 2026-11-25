//! The accept loop: connection limits, TLS and graceful shutdown.

use crate::handlers::ConnInfo;
use axum::Router;
use axum::body::Body;
use axum::http::Version;
use bytes::{Buf, Bytes};
use http_body::{Frame, SizeHint};
use hyper::body::Incoming;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use hyper_util::server::conn::auto;
use hyper_util::server::graceful::{GracefulShutdown, Watcher};
use pin_project_lite::pin_project;
use rustls_pki_types::pem::{self, PemObject};
use rustls_pki_types::{CertificateDer, PrivateKeyDer};
use std::future::Future;
use std::io;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::task::{Context, Poll, Waker, ready};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::TcpListener;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio::time::{Instant, Sleep};
use tokio_rustls::TlsAcceptor;
use tokio_rustls::rustls::ServerConfig;
use tokio_util::sync::{CancellationToken, DropGuard, WaitForCancellationFutureOwned};
use tower::ServiceExt;

/// Decoded headers per request or HTTP/2 stream, limiting compression amplification.
const MAX_HEADER_BYTES: u32 = 16 << 10;
const MAX_HEADERS: usize = 100;
const HEADER_READ_TIMEOUT: Duration = Duration::from_secs(10);
const TLS_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// Each stream may hold a file open and the connection cap budgets for all of
/// them, so every extra stream costs connections when descriptors are scarce.
/// It also bounds the handlers a connection runs, see `HandlerSlots`.
const MAX_CONCURRENT_STREAMS: u32 = 16;
/// Response bytes an HTTP/2 stream may queue ahead of the peer. hyper's default
/// is 400 KiB per stream, and the peer chooses its own window, so one that opens
/// it wide and stops reading would otherwise pin that much on every stream.
/// hyper still takes up to two body chunks on top of this.
const MAX_STREAM_SEND_BUFFER: usize = 16 << 10;
pub const SHUTDOWN_GRACE: Duration = Duration::from_secs(20);
const ACCEPT_BACKOFF: Duration = Duration::from_millis(100);
/// Bounds how long and how much a closing connection keeps discarding.
const LINGER_TIME: Duration = Duration::from_secs(2);
const LINGER_BYTES: u64 = 64 << 20;

#[derive(Clone, Copy)]
pub struct Limits {
    /// A connection with no request in progress is closed after this, whatever
    /// else the peer sends, as Go's IdleTimeout only runs between requests.
    pub idle: Duration,
    /// A peer that stops reading is closed after this, even mid-response. Stream
    /// deadlines cannot unblock a connection writer whose peer went silent. On
    /// HTTP/2 it also applies to a response whose data the peer's flow-control
    /// window holds back.
    pub write_stall: Duration,
    /// Deadline for writing a response that sets no `TransferDeadline` of its own.
    pub response: Option<Duration>,
    /// Open connections, including TLS handshakes. At the cap the listener stops
    /// accepting and new peers wait in the kernel backlog, so slow clients
    /// cannot exhaust file descriptors the database and file store need.
    pub max_connections: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            idle: Duration::from_secs(120),
            write_stall: Duration::from_secs(30),
            response: None,
            max_connections: MAX_CONNECTIONS,
        }
    }
}

/// Bounds memory as well: each open connection holds its own buffers.
const MAX_CONNECTIONS: usize = 10_000;
/// Descriptors kept back for the database pool (128), the metrics listener and
/// everything else the process opens.
const RESERVED_FDS: u64 = 256;
/// A connection's socket plus an open asset or stored file for each stream.
const FDS_PER_CONNECTION: u64 = 1 + MAX_CONCURRENT_STREAMS as u64;
/// The smallest cap, for hosts that leave almost no descriptors.
const MIN_CONNECTIONS: usize = 16;
pub const METRICS_CONNECTIONS: usize = 64;
pub const METRICS_RESPONSE_TIMEOUT: Duration = Duration::from_secs(30);
const SATURATION_LOG_INTERVAL: Duration = Duration::from_secs(60);

/// Raises the soft open-file limit to the hard one, as the Go runtime does at
/// startup, and returns a connection cap that leaves room for everything else.
pub fn connection_cap() -> usize {
    use rustix::process::{Resource, Rlimit, getrlimit, setrlimit};
    let limit = getrlimit(Resource::Nofile);
    // macOS reports an unlimited hard limit but refuses more than OPEN_MAX.
    for target in [limit.maximum, Some(10_240)].into_iter().flatten() {
        if limit.current.is_some_and(|current| current >= target) {
            break;
        }
        let raised = Rlimit {
            current: Some(target),
            maximum: limit.maximum,
        };
        if setrlimit(Resource::Nofile, raised).is_ok() {
            break;
        }
    }
    let available = getrlimit(Resource::Nofile).current.unwrap_or(u64::MAX);
    cap_for(available)
}

fn cap_for(open_files: u64) -> usize {
    let usable = open_files.saturating_sub(RESERVED_FDS) / FDS_PER_CONNECTION;
    usize::try_from(usable)
        .unwrap_or(usize::MAX)
        .clamp(MIN_CONNECTIONS, MAX_CONNECTIONS)
}

pin_project! {
    /// Enforces `Limits` on any socket, covering HTTP/1 and HTTP/2 alike.
    pub struct GuardedIo<T> {
        #[pin]
        inner: T,
        limits: Limits,
        idle: Pin<Box<Sleep>>,
        stall: Option<Pin<Box<Sleep>>>,
        linger: Option<Pin<Box<Sleep>>>,
        lingered: u64,
        active: Arc<Requests>,
        last_active: Instant,
        killed: Pin<Box<WaitForCancellationFutureOwned>>,
    }
}

impl<T> GuardedIo<T> {
    /// `active` counts requests in progress; only their traffic postpones the
    /// idle limit, so PINGs between requests do not keep a connection open.
    /// Cancelling `kill` closes the connection: the watchdog of an HTTP/1
    /// response uses it.
    pub(crate) fn new(
        inner: T,
        limits: Limits,
        active: Arc<Requests>,
        kill: CancellationToken,
    ) -> Self {
        Self {
            inner,
            limits,
            active,
            last_active: Instant::now(),
            killed: Box::pin(kill.cancelled_owned()),
            idle: Box::pin(tokio::time::sleep(limits.idle)),
            stall: None,
            linger: None,
            lingered: 0,
        }
    }
}

fn expired(what: &str) -> io::Error {
    io::Error::new(io::ErrorKind::TimedOut, format!("connection {what}"))
}

fn killed(killed: &mut Pin<Box<WaitForCancellationFutureOwned>>, cx: &mut Context<'_>) -> bool {
    killed.as_mut().poll(cx).is_ready()
}

/// The accounting both write paths share: progress clears the stall timer and,
/// during a request, counts as activity; no progress runs the stall timer.
fn track_write(
    poll: Poll<io::Result<usize>>,
    cx: &mut Context<'_>,
    limits: &Limits,
    active: &Requests,
    last_active: &mut Instant,
    stall: &mut Option<Pin<Box<Sleep>>>,
) -> Poll<io::Result<usize>> {
    match poll {
        Poll::Ready(result) => {
            *stall = None;
            if active.open() {
                *last_active = Instant::now();
            }
            Poll::Ready(result)
        }
        Poll::Pending => {
            let timer =
                stall.get_or_insert_with(|| Box::pin(tokio::time::sleep(limits.write_stall)));
            if timer.as_mut().poll(cx).is_ready() {
                return Poll::Ready(Err(expired("write stalled")));
            }
            Poll::Pending
        }
    }
}

impl<T: AsyncRead> AsyncRead for GuardedIo<T> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let mut this = self.project();
        if killed(this.killed, cx) {
            return Poll::Ready(Err(expired("closed by a response watchdog")));
        }
        let before = buf.filled().len();
        match this.inner.as_mut().poll_read(cx, buf) {
            Poll::Ready(result) => {
                if result.is_ok() && buf.filled().len() > before && this.active.open() {
                    *this.last_active = Instant::now();
                }
                Poll::Ready(result)
            }
            // The timer is only re-armed when it fires, from the last activity,
            // instead of on every read and write.
            Poll::Pending => {
                while this.idle.as_mut().poll(cx).is_ready() {
                    let now = Instant::now();
                    // Read before `changed`, which `finish` sets first.
                    let open = this.active.open();
                    // A request starting or ending restarts the limit even when
                    // none of its bytes were counted.
                    *this.last_active = (*this.last_active).max(this.active.changed());
                    let due = *this.last_active + this.limits.idle;
                    if due <= now {
                        if !open {
                            return Poll::Ready(Err(expired("idle")));
                        }
                        *this.last_active = now;
                    }
                    let next = *this.last_active + this.limits.idle;
                    this.idle.as_mut().reset(next);
                }
                Poll::Pending
            }
        }
    }
}

impl<T: AsyncRead + AsyncWrite> AsyncWrite for GuardedIo<T> {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let this = self.project();
        if killed(this.killed, cx) {
            return Poll::Ready(Err(expired("closed by a response watchdog")));
        }
        let poll = this.inner.poll_write(cx, buf);
        track_write(
            poll,
            cx,
            this.limits,
            this.active,
            this.last_active,
            this.stall,
        )
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.project().inner.poll_flush(cx)
    }

    /// Closes like Go's server: send FIN, then discard what the peer is still
    /// sending. Closing with unread data would reset the connection, and a client
    /// mid-upload would see a network error instead of the response just written.
    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let mut this = self.project();
        if this.linger.is_none() {
            if let Err(error) = ready!(this.inner.as_mut().poll_shutdown(cx)) {
                return Poll::Ready(Err(error));
            }
            *this.linger = Some(Box::pin(tokio::time::sleep(LINGER_TIME)));
        }
        let Some(linger) = this.linger.as_mut() else {
            return Poll::Ready(Ok(()));
        };
        if linger.as_mut().poll(cx).is_ready() {
            return Poll::Ready(Ok(()));
        }
        let mut scratch = [0u8; 8192];
        while *this.lingered < LINGER_BYTES {
            let mut buffer = ReadBuf::new(&mut scratch);
            match this.inner.as_mut().poll_read(cx, &mut buffer) {
                Poll::Pending => return Poll::Pending,
                Poll::Ready(Err(_)) => return Poll::Ready(Ok(())),
                Poll::Ready(Ok(())) if buffer.filled().is_empty() => return Poll::Ready(Ok(())),
                Poll::Ready(Ok(())) => *this.lingered += buffer.filled().len() as u64,
            }
        }
        Poll::Ready(Ok(()))
    }

    fn poll_write_vectored(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        let this = self.project();
        if killed(this.killed, cx) {
            return Poll::Ready(Err(expired("closed by a response watchdog")));
        }
        let poll = this.inner.poll_write_vectored(cx, bufs);
        track_write(
            poll,
            cx,
            this.limits,
            this.active,
            this.last_active,
            this.stall,
        )
    }

    fn is_write_vectored(&self) -> bool {
        self.inner.is_write_vectored()
    }
}

/// Says what is wrong with a PEM file without quoting it. The parser's own messages
/// include the line it stopped at, and in a key file that lost its line breaks that
/// line is the whole private key.
fn pem_error(error: &pem::Error) -> String {
    match error {
        pem::Error::Io(_) | pem::Error::NoItemsFound | pem::Error::SectionTooLarge => {
            error.to_string()
        }
        pem::Error::MissingSectionEnd { .. } => "missing section end marker".to_owned(),
        pem::Error::IllegalSectionStart { .. } => "illegal section start".to_owned(),
        pem::Error::Base64Decode(_) => "base64 decode error".to_owned(),
        _ => "invalid PEM".to_owned(),
    }
}

/// Loads a certificate chain and key. Paths are operator configuration, not secrets;
/// the files' content is, so errors never quote it.
pub fn load_tls(cert_path: &str, key_path: &str) -> Result<TlsAcceptor, String> {
    let certs = CertificateDer::pem_file_iter(cert_path)
        .and_then(|certs| certs.collect::<Result<Vec<_>, _>>())
        .map_err(|e| format!("could not read --tls-cert: {}", pem_error(&e)))?;
    let key = PrivateKeyDer::from_pem_file(key_path)
        .map_err(|e| format!("could not read --tls-key: {}", pem_error(&e)))?;
    // TLS 1.2 is the minimum the protocol default set offers.
    let mut config = ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .map_err(|e| format!("invalid TLS configuration: {e}"))?;
    config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
    Ok(TlsAcceptor::from(Arc::new(config)))
}

tokio::task_local! {
    /// Cancelling it ends the task serving the current HTTP/2 stream, which
    /// resets that stream and leaves the others on its connection alone.
    static STREAM: CancellationToken;
}

/// Runs the tasks hyper spawns, one per HTTP/2 stream, so that each can be
/// ended on its own. HTTP/1 spawns none: its requests run in the connection's
/// task.
#[derive(Clone)]
struct StreamExecutor;

impl<F> hyper::rt::Executor<F> for StreamExecutor
where
    F: Future + Send + 'static,
    F::Output: Send + 'static,
{
    fn execute(&self, future: F) {
        let cancel = CancellationToken::new();
        tokio::spawn(STREAM.scope(cancel.clone(), cancel.run_until_cancelled_owned(future)));
    }
}

fn builder() -> auto::Builder<StreamExecutor> {
    let mut builder = auto::Builder::new(StreamExecutor);
    builder
        .http1()
        .timer(hyper_util::rt::TokioTimer::new())
        .header_read_timeout(HEADER_READ_TIMEOUT)
        .max_buf_size(MAX_HEADER_BYTES as usize)
        .max_headers(MAX_HEADERS);
    builder
        .http2()
        .timer(hyper_util::rt::TokioTimer::new())
        .max_header_list_size(MAX_HEADER_BYTES)
        .max_concurrent_streams(MAX_CONCURRENT_STREAMS)
        .max_send_buf_size(MAX_STREAM_SEND_BUFFER)
        .max_pending_accept_reset_streams(20)
        .max_local_error_reset_streams(1024);
    builder
}

/// Bounds the handlers one connection has running. A handler runs on its own
/// task and outlives its request, so resetting an HTTP/2 stream frees the
/// stream's place in `MAX_CONCURRENT_STREAMS` while its handler carries on.
/// Counting handlers instead, as Go's server does, keeps a client that resets
/// every stream from starting more work than one that waits for its answers.
/// Handlers also outlive their connection, so the listener counts them too: a
/// client that closes and reconnects cannot pile up more than every connection
/// could run at once, and never more than `MAX_LISTENER_HANDLERS`. A new
/// handler waits for a slot; the handlers holding them are bounded by their own
/// database and transfer timeouts. Health probes have slots of their own, so
/// they answer while the others are all taken instead of failing and getting
/// the server restarted.
#[derive(Clone)]
pub struct HandlerSlots {
    connection: Arc<Semaphore>,
    listener: ListenerSlots,
}

/// A listener's handler slots: as many as all its connections have, up to
/// `MAX_LISTENER_HANDLERS`, and as many for probes as one connection has.
#[derive(Clone)]
struct ListenerSlots {
    handlers: Arc<Semaphore>,
    probes: Arc<Semaphore>,
}

/// At high descriptor limits connections × streams reaches 160,000 handlers,
/// too many to bound memory, so the listener stops there.
const MAX_LISTENER_HANDLERS: usize = 4096;

impl ListenerSlots {
    fn new(max_connections: usize) -> Self {
        let handlers = max_connections.saturating_mul(MAX_CONCURRENT_STREAMS as usize);
        Self {
            handlers: Arc::new(Semaphore::new(handlers.min(MAX_LISTENER_HANDLERS))),
            probes: Arc::new(Semaphore::new(MAX_CONCURRENT_STREAMS as usize)),
        }
    }
}

impl HandlerSlots {
    fn new(listener: ListenerSlots) -> Self {
        Self {
            connection: Arc::new(Semaphore::new(MAX_CONCURRENT_STREAMS as usize)),
            listener,
        }
    }

    /// Waits for a slot, which is free again when the returned permits are dropped.
    pub async fn acquire(&self, probe: bool) -> [OwnedSemaphorePermit; 2] {
        let wait = async |slots: &Arc<Semaphore>| {
            let slot = slots.clone().acquire_owned().await;
            slot.expect("never closed")
        };
        let listener = if probe {
            &self.listener.probes
        } else {
            &self.listener.handlers
        };
        [wait(&self.connection).await, wait(listener).await]
    }
}

/// A connection's requests whose response is not fully written yet, and when
/// that last changed.
pub(crate) struct Requests {
    open: AtomicUsize,
    changed: Mutex<Instant>,
}

impl Requests {
    fn new() -> Self {
        Self {
            open: AtomicUsize::new(0),
            changed: Mutex::new(Instant::now()),
        }
    }

    fn open(&self) -> bool {
        self.open.load(Ordering::Acquire) > 0
    }

    fn changed(&self) -> Instant {
        *lock(&self.changed)
    }

    fn start(&self) {
        self.open.fetch_add(1, Ordering::AcqRel);
        *lock(&self.changed) = Instant::now();
    }

    /// Records the change before the count drops, so whoever sees no request
    /// open also sees when the last one ended.
    fn finish(&self) {
        *lock(&self.changed) = Instant::now();
        self.open.fetch_sub(1, Ordering::AcqRel);
    }
}

/// Counts a request from the moment hyper hands it over until its response
/// data is written or discarded, however it ends.
struct ActiveRequest(Arc<Requests>);

impl ActiveRequest {
    fn start(active: &Arc<Requests>) -> Self {
        active.start();
        Self(active.clone())
    }
}

impl Drop for ActiveRequest {
    fn drop(&mut self) {
        self.0.finish();
    }
}

struct Connection {
    router: Router,
    builder: Arc<auto::Builder<StreamExecutor>>,
    conn: ConnInfo,
    watcher: Watcher,
    active: Arc<Requests>,
    kill: CancellationToken,
    limits: Limits,
    handler_slots: ListenerSlots,
}

/// Set on a streaming response whose body must finish by this instant. The body
/// enforces it while it is polled; a watchdog ends the response if the peer
/// stops the body from being polled at all, as an HTTP/2 client can by never
/// granting flow-control window.
#[derive(Clone, Copy)]
pub struct TransferDeadline(pub Instant);

/// Time the body gets to report its own deadline error before the watchdog acts.
const DEADLINE_GRACE: Duration = Duration::from_secs(1);

/// A response's data pieces not yet fully written, and when one last moved.
struct Unsent {
    buffers: usize,
    progress: Instant,
    /// The body waiting to report its end until every piece is written.
    ended: Option<Waker>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

/// Shared by a response body and its data; the watchdog stands down once all of
/// it is gone, which is when hyper has written or discarded the last byte.
struct Delivery {
    unsent: Arc<Mutex<Unsent>>,
    _watchdog: DropGuard,
}

/// A piece of response data that reports each byte hyper writes.
struct Watched {
    data: Bytes,
    delivery: Option<Arc<Delivery>>,
    _request: Arc<ActiveRequest>,
}

impl Watched {
    fn new(data: Bytes, delivery: Option<Arc<Delivery>>, request: Arc<ActiveRequest>) -> Self {
        if let Some(delivery) = &delivery {
            let mut unsent = lock(&delivery.unsent);
            if unsent.buffers == 0 {
                unsent.progress = Instant::now();
            }
            unsent.buffers += 1;
        }
        Self {
            data,
            delivery,
            _request: request,
        }
    }
}

impl Buf for Watched {
    fn remaining(&self) -> usize {
        self.data.remaining()
    }

    fn chunk(&self) -> &[u8] {
        self.data.chunk()
    }

    fn advance(&mut self, count: usize) {
        self.data.advance(count);
        if let Some(delivery) = &self.delivery
            && count > 0
        {
            lock(&delivery.unsent).progress = Instant::now();
        }
    }
}

impl Drop for Watched {
    fn drop(&mut self) {
        if let Some(delivery) = &self.delivery {
            let mut unsent = lock(&delivery.unsent);
            unsent.buffers -= 1;
            unsent.progress = Instant::now();
            if unsent.buffers == 0
                && let Some(waker) = unsent.ended.take()
            {
                waker.wake();
            }
        }
    }
}

pin_project! {
    struct WatchedBody {
        #[pin]
        inner: Body,
        delivery: Option<Arc<Delivery>>,
        // Travels with the data too: hyper drops the body well before a slow
        // peer has received what it took.
        request: Arc<ActiveRequest>,
        // On HTTP/2 the end is reported only once all data is written: hyper
        // ends a stream's task when the body ends, leaving unsent data queued
        // where the watchdog could no longer reset that stream alone. No
        // response sends trailers, which would end the task the same way.
        hold_end: bool,
        http2: bool,
        ended: bool,
    }
}

impl http_body::Body for WatchedBody {
    type Data = Watched;
    type Error = axum::Error;

    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Watched>, axum::Error>>> {
        let this = self.project();
        let frame = if *this.ended {
            None
        } else {
            ready!(this.inner.poll_frame(cx))
        };
        if matches!(&frame, Some(Ok(frame)) if frame.is_data()) {
            *this.hold_end = *this.http2;
        }
        if frame.is_none() {
            *this.ended = true;
            if *this.hold_end
                && let Some(delivery) = this.delivery
            {
                let mut unsent = lock(&delivery.unsent);
                if unsent.buffers > 0 {
                    unsent.ended = Some(cx.waker().clone());
                    return Poll::Pending;
                }
            }
        }
        let watched = |data| Watched::new(data, this.delivery.clone(), this.request.clone());
        Poll::Ready(frame.map(|frame| frame.map(|frame| frame.map_data(watched))))
    }

    fn is_end_stream(&self) -> bool {
        !self.hold_end && self.inner.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

/// Ends the response when it misses its deadline (its own
/// `TransferDeadline`, else `Limits::response`) or, on HTTP/2, when data is
/// waiting and none of it was written for the write-stall limit. The socket's own stall
/// limit cannot see an HTTP/2 peer that withholds window, nor can a deadline the
/// body enforces once hyper stops polling it. `kill` resets an HTTP/2 stream
/// alone, as Go's write deadline does, since a proxy may multiplex unrelated
/// clients over the connection; for HTTP/1 it closes the connection.
fn watch_response(
    mut response: axum::response::Response,
    request: ActiveRequest,
    kill: &CancellationToken,
    http2: bool,
    limits: &Limits,
) -> axum::response::Response<WatchedBody> {
    // HTTP/1 has no flow-control window; the socket's stall limit covers it.
    let stall = http2.then_some(limits.write_stall);
    let deadline = response
        .extensions_mut()
        .remove()
        .map(|TransferDeadline(at)| at)
        .or_else(|| limits.response.map(|timeout| Instant::now() + timeout))
        .map(|at| at + DEADLINE_GRACE);
    let delivery =
        (deadline.is_some() || stall.is_some()).then(|| watchdog(deadline, stall, kill.clone()));
    response.map(|inner| WatchedBody {
        inner,
        delivery,
        request: Arc::new(request),
        hold_end: false,
        http2,
        ended: false,
    })
}

fn watchdog(
    deadline: Option<Instant>,
    stall: Option<Duration>,
    kill: CancellationToken,
) -> Arc<Delivery> {
    let unsent = Arc::new(Mutex::new(Unsent {
        buffers: 0,
        progress: Instant::now(),
        ended: None,
    }));
    let done = CancellationToken::new();
    let delivery = Arc::new(Delivery {
        unsent: unsent.clone(),
        _watchdog: done.clone().drop_guard(),
    });
    tokio::spawn(async move {
        loop {
            let stall_due = stall.map(|limit| {
                let unsent = lock(&unsent);
                // Waiting for the body, such as the file store, is not the peer's doing.
                let from = if unsent.buffers == 0 {
                    Instant::now()
                } else {
                    unsent.progress
                };
                from + limit
            });
            let Some(due) = deadline.into_iter().chain(stall_due).min() else {
                return;
            };
            if due <= Instant::now() {
                return kill.cancel();
            }
            tokio::select! {
                _ = tokio::time::sleep_until(due) => {}
                _ = done.cancelled() => return,
            }
        }
    });
    delivery
}

/// A request counts as active until its response is written, so the idle limit
/// runs only between requests.
async fn serve_connection<I>(io: I, connection: Connection)
where
    I: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let Connection {
        router,
        builder,
        conn,
        watcher,
        active,
        kill,
        limits,
        handler_slots,
    } = connection;
    let slots = HandlerSlots::new(handler_slots);
    let service = service_fn(move |mut request: hyper::Request<Incoming>| {
        let router = router.clone();
        let started = ActiveRequest::start(&active);
        let kill = kill.clone();
        let http2 = request.version() == Version::HTTP_2;
        request.extensions_mut().insert(conn);
        request.extensions_mut().insert(slots.clone());
        async move {
            let response = router.oneshot(request.map(Body::new)).await?;
            // Only an HTTP/2 stream has a task of its own to end.
            let kill = STREAM.try_with(CancellationToken::clone).unwrap_or(kill);
            let response = watch_response(response, started, &kill, http2, &limits);
            Ok::<_, std::convert::Infallible>(response)
        }
    });
    let connection = builder.serve_connection(TokioIo::new(io), service);
    let connection = watcher.watch(connection.into_owned());
    // Peers vanish all the time; nothing about a failed connection is actionable.
    if let Err(error) = connection.await {
        tracing::trace!(error = %error, "connection closed with error");
    }
}

/// Serves until `stop` fires, then lets active connections finish within a grace
/// period. Never logs URLs or peer data at info level.
pub async fn serve(
    listener: TcpListener,
    router: Router,
    tls: Option<TlsAcceptor>,
    limits: Limits,
    stop: CancellationToken,
) {
    let graceful = GracefulShutdown::new();
    let builder = Arc::new(builder());
    let slots = Arc::new(Semaphore::new(limits.max_connections));
    let handler_slots = ListenerSlots::new(limits.max_connections);
    let mut last_saturation_log: Option<Instant> = None;
    loop {
        let slot = match slots.clone().try_acquire_owned() {
            Ok(slot) => slot,
            Err(_) => {
                if last_saturation_log.is_none_or(|at| at.elapsed() >= SATURATION_LOG_INTERVAL) {
                    tracing::warn!(
                        max_connections = limits.max_connections,
                        "connection limit reached; new connections wait"
                    );
                    last_saturation_log = Some(Instant::now());
                }
                tokio::select! {
                    _ = stop.cancelled() => break,
                    slot = slots.clone().acquire_owned() => slot.expect("never closed"),
                }
            }
        };
        let accepted = tokio::select! {
            _ = stop.cancelled() => break,
            accepted = listener.accept() => accepted,
        };
        let (stream, peer): (_, SocketAddr) = match accepted {
            Ok(accepted) => accepted,
            Err(error) => {
                // Usually fd exhaustion: back off instead of spinning.
                tracing::warn!(error = %error, "accept failed");
                tokio::time::sleep(ACCEPT_BACKOFF).await;
                continue;
            }
        };
        let _ = stream.set_nodelay(true);
        let tls = tls.clone();
        let active = Arc::new(Requests::new());
        let connection = Connection {
            router: router.clone(),
            builder: builder.clone(),
            conn: ConnInfo {
                peer: peer.ip(),
                tls: tls.is_some(),
            },
            watcher: graceful.watcher(),
            active: active.clone(),
            kill: CancellationToken::new(),
            limits,
            handler_slots: handler_slots.clone(),
        };
        tokio::spawn(async move {
            let _slot = slot;
            let guarded = GuardedIo::new(stream, limits, active, connection.kill.clone());
            match tls {
                None => serve_connection(guarded, connection).await,
                Some(acceptor) => {
                    let handshake =
                        tokio::time::timeout(TLS_HANDSHAKE_TIMEOUT, acceptor.accept(guarded)).await;
                    if let Ok(Ok(stream)) = handshake {
                        serve_connection(stream, connection).await;
                    }
                }
            }
        });
    }
    drop(listener);
    if tokio::time::timeout(SHUTDOWN_GRACE, graceful.shutdown())
        .await
        .is_err()
    {
        tracing::warn!("shutdown grace period ended with active connections");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_connection_cap_leaves_descriptors_for_everything_else() {
        assert_eq!(cap_for(4096), 225);
        let slots = ListenerSlots::new(cap_for(4096));
        assert_eq!(slots.handlers.available_permits(), 3600);
        let slots = ListenerSlots::new(cap_for(1 << 20));
        assert_eq!(slots.handlers.available_permits(), MAX_LISTENER_HANDLERS);
        assert_eq!(
            slots.probes.available_permits(),
            MAX_CONCURRENT_STREAMS as usize
        );
        assert_eq!(cap_for(100), MIN_CONNECTIONS);
        assert_eq!(cap_for(1 << 20), MAX_CONNECTIONS);
        // Every connection with all its streams holding a file still fits.
        for limit in [4096, 10_240, 65_536] {
            let held = cap_for(limit) as u64 * FDS_PER_CONNECTION;
            assert!(held + RESERVED_FDS <= limit, "{limit}");
        }
        assert_eq!(cap_for(u64::MAX), MAX_CONNECTIONS);
        assert!(connection_cap() >= MIN_CONNECTIONS);
    }
}
