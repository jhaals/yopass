//! The accept loop: connection limits, TLS and graceful shutdown.

use crate::handlers::ConnInfo;
use axum::Router;
use axum::body::Body;
use axum::http::Version;
use bytes::{Buf, Bytes};
use http_body::{Frame, SizeHint};
use hyper::body::Incoming;
use hyper::service::service_fn;
use hyper_util::rt::{TokioExecutor, TokioIo};
use hyper_util::server::conn::auto;
use hyper_util::server::graceful::{GracefulShutdown, Watcher};
use pin_project_lite::pin_project;
use rustls_pki_types::pem::PemObject;
use rustls_pki_types::{CertificateDer, PrivateKeyDer};
use std::future::Future;
use std::io;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::task::{Context, Poll, ready};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::TcpListener;
use tokio::sync::Semaphore;
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
    /// A connection with no traffic in either direction is closed after this.
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
        active: Arc<AtomicUsize>,
        last_active: Instant,
        killed: Pin<Box<WaitForCancellationFutureOwned>>,
    }
}

impl<T> GuardedIo<T> {
    /// `active` counts requests in progress; a connection is not idle while a
    /// handler is still working, as Go's IdleTimeout only applies between requests.
    /// Cancelling `kill` closes the connection: the response watchdog uses it.
    pub fn new(
        inner: T,
        limits: Limits,
        active: Arc<AtomicUsize>,
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

/// The accounting both write paths share: progress clears the stall timer and
/// counts as activity; no progress runs the stall timer.
fn track_write(
    poll: Poll<io::Result<usize>>,
    cx: &mut Context<'_>,
    limits: &Limits,
    last_active: &mut Instant,
    stall: &mut Option<Pin<Box<Sleep>>>,
) -> Poll<io::Result<usize>> {
    match poll {
        Poll::Ready(result) => {
            *stall = None;
            *last_active = Instant::now();
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
                if result.is_ok() && buf.filled().len() > before {
                    *this.last_active = Instant::now();
                }
                Poll::Ready(result)
            }
            // The timer is only re-armed when it fires, from the last activity,
            // instead of on every read and write.
            Poll::Pending => {
                while this.idle.as_mut().poll(cx).is_ready() {
                    let now = Instant::now();
                    let due = *this.last_active + this.limits.idle;
                    if due <= now {
                        if this.active.load(Ordering::Acquire) == 0 {
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
        track_write(poll, cx, this.limits, this.last_active, this.stall)
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
        track_write(poll, cx, this.limits, this.last_active, this.stall)
    }

    fn is_write_vectored(&self) -> bool {
        self.inner.is_write_vectored()
    }
}

/// Loads a certificate chain and key. Paths are operator configuration, not secrets.
pub fn load_tls(cert_path: &str, key_path: &str) -> Result<TlsAcceptor, String> {
    let certs = CertificateDer::pem_file_iter(cert_path)
        .and_then(|certs| certs.collect::<Result<Vec<_>, _>>())
        .map_err(|e| format!("could not read --tls-cert: {e}"))?;
    let key = PrivateKeyDer::from_pem_file(key_path)
        .map_err(|e| format!("could not read --tls-key: {e}"))?;
    // TLS 1.2 is the minimum the protocol default set offers.
    let mut config = ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .map_err(|e| format!("invalid TLS configuration: {e}"))?;
    config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
    Ok(TlsAcceptor::from(Arc::new(config)))
}

fn builder() -> auto::Builder<TokioExecutor> {
    let mut builder = auto::Builder::new(TokioExecutor::new());
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

/// Decrements the active request count however the handler ends.
struct ActiveRequest(Arc<AtomicUsize>);

impl ActiveRequest {
    fn start(active: &Arc<AtomicUsize>) -> Self {
        active.fetch_add(1, Ordering::AcqRel);
        Self(active.clone())
    }
}

impl Drop for ActiveRequest {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

struct Connection {
    router: Router,
    builder: Arc<auto::Builder<TokioExecutor>>,
    conn: ConnInfo,
    watcher: Watcher,
    active: Arc<AtomicUsize>,
    kill: CancellationToken,
    limits: Limits,
}

/// Set on a streaming response whose body must finish by this instant. The body
/// enforces it while it is polled; a watchdog closes the connection if the peer
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
}

fn lock(unsent: &Mutex<Unsent>) -> MutexGuard<'_, Unsent> {
    unsent.lock().unwrap_or_else(|e| e.into_inner())
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
}

impl Watched {
    fn new(data: Bytes, delivery: Option<Arc<Delivery>>) -> Self {
        if let Some(delivery) = &delivery {
            let mut unsent = lock(&delivery.unsent);
            if unsent.buffers == 0 {
                unsent.progress = Instant::now();
            }
            unsent.buffers += 1;
        }
        Self { data, delivery }
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
        }
    }
}

pin_project! {
    struct WatchedBody {
        #[pin]
        inner: Body,
        delivery: Option<Arc<Delivery>>,
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
        let frame = ready!(this.inner.poll_frame(cx));
        let watched = |data| Watched::new(data, this.delivery.clone());
        Poll::Ready(frame.map(|frame| frame.map(|frame| frame.map_data(watched))))
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

/// Closes the connection when the response misses its deadline (its own
/// `TransferDeadline`, else `Limits::response`) or, with `stall`, when data is
/// waiting and none of it was written for that long. The socket's own stall
/// limit cannot see an HTTP/2 peer that withholds window, nor can a deadline the
/// body enforces once hyper stops polling it.
fn watch_response(
    mut response: axum::response::Response,
    kill: &CancellationToken,
    stall: Option<Duration>,
    response_timeout: Option<Duration>,
) -> axum::response::Response<WatchedBody> {
    let deadline = response
        .extensions_mut()
        .remove()
        .map(|TransferDeadline(at)| at)
        .or_else(|| response_timeout.map(|timeout| Instant::now() + timeout))
        .map(|at| at + DEADLINE_GRACE);
    let delivery =
        (deadline.is_some() || stall.is_some()).then(|| watchdog(deadline, stall, kill.clone()));
    response.map(|inner| WatchedBody { inner, delivery })
}

fn watchdog(
    deadline: Option<Instant>,
    stall: Option<Duration>,
    kill: CancellationToken,
) -> Arc<Delivery> {
    let unsent = Arc::new(Mutex::new(Unsent {
        buffers: 0,
        progress: Instant::now(),
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

/// A request counts as active until its response head is ready; a streaming
/// body after that is write activity with its own stall limit and deadline.
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
    } = connection;
    let service = service_fn(move |mut request: hyper::Request<Incoming>| {
        let router = router.clone();
        let started = ActiveRequest::start(&active);
        let kill = kill.clone();
        // HTTP/1 has no flow-control window; the socket's stall limit covers it.
        let stall = (request.version() == Version::HTTP_2).then_some(limits.write_stall);
        request.extensions_mut().insert(conn);
        async move {
            let response = router.oneshot(request.map(Body::new)).await?;
            drop(started);
            let response = watch_response(response, &kill, stall, limits.response);
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
        let active = Arc::new(AtomicUsize::new(0));
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
