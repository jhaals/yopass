//! Stores file data in an S3-compatible bucket, as the Go server does: one object
//! per file under `prefix`, its lifetime in the `Expires` header. Object tagging
//! is avoided because services such as Cloudflare R2 reject it.

use super::{ByteStream, FileError, FileStore, run_periodic};
use crate::util::{now_unix, redact_error, redact_secret_id};
use async_trait::async_trait;
use aws_sdk_s3::Client;
use aws_sdk_s3::config::{Region, StalledStreamProtectionConfig};
use aws_sdk_s3::error::DisplayErrorContext;
use aws_sdk_s3::primitives::{ByteStream as SdkStream, DateTime};
use bytes::Bytes;
use futures_util::{StreamExt, stream};
use http_body::{Body, Frame, SizeHint};
use std::future::Future;
use std::io;
use std::pin::Pin;
use std::sync::{Arc, Mutex, PoisonError};
use std::task::{Context, Poll, ready};
use std::time::{Duration, SystemTime};
use tokio_util::sync::CancellationToken;

/// Bound for every call but the upload, which the transfer deadline bounds.
/// The Go server uses the same for its cleanup calls.
pub const CALL_TIMEOUT: Duration = Duration::from_secs(30);

/// Objects a sweep checks at once.
const SWEEP_CONCURRENCY: usize = 16;

#[derive(Clone)]
pub struct S3FileStore {
    client: Client,
    bucket: String,
    prefix: String,
    call_timeout: Duration,
}

impl S3FileStore {
    /// Credentials come from the standard AWS chain, and so does the region if
    /// `region` is empty (`--file-store-s3-region=""`; the flag defaults to
    /// us-east-1, as in Go). A custom `endpoint` uses path-style addressing.
    pub async fn new(bucket: &str, prefix: &str, endpoint: &str, region: &str) -> Self {
        let mut loader = aws_config::defaults(aws_config::BehaviorVersion::latest());
        if !region.is_empty() {
            loader = loader.region(Region::new(region.to_owned()));
        }
        let mut config = aws_sdk_s3::config::Builder::from(&loader.load().await);
        if !endpoint.is_empty() {
            config = config.endpoint_url(endpoint).force_path_style(true);
        }
        Self::with_client(Client::from_conf(config.build()), bucket, prefix)
    }

    /// Uses `client` with the SDK's stalled-upload check off: it would end a
    /// pausing upload as a storage fault, and the transfer deadline already
    /// bounds uploads. Downloads keep it, with the client's grace period.
    pub fn with_client(client: Client, bucket: &str, prefix: &str) -> Self {
        let config = client.config();
        let mut stalled = StalledStreamProtectionConfig::enabled().upload_enabled(false);
        if let Some(current) = config.stalled_stream_protection() {
            stalled = stalled
                .grace_period(current.grace_period())
                .download_enabled(current.download_enabled());
        }
        let config = config
            .to_builder()
            .stalled_stream_protection(stalled.build())
            .build();
        Self {
            client: Client::from_conf(config),
            bucket: bucket.to_owned(),
            prefix: prefix.to_owned(),
            call_timeout: CALL_TIMEOUT,
        }
    }

    /// Replaces [`CALL_TIMEOUT`].
    pub fn call_timeout(mut self, limit: Duration) -> Self {
        self.call_timeout = limit;
        self
    }

    /// One SDK call within the call timeout, its error rendered with its causes.
    async fn call<T, E>(&self, request: impl Future<Output = Result<T, E>>) -> Result<T, String>
    where
        E: std::error::Error + 'static,
    {
        match tokio::time::timeout(self.call_timeout, request).await {
            Ok(Ok(output)) => Ok(output),
            Ok(Err(error)) => Err(DisplayErrorContext(&error).to_string()),
            Err(_) => Err("timed out".to_owned()),
        }
    }

    fn object_key(&self, key: &str) -> String {
        format!("{}{key}", self.prefix)
    }

    /// Runs one expiry sweep: every object under the prefix whose `Expires`
    /// has passed is deleted. Objects without one are left alone.
    pub async fn cleanup_expired(&self) {
        let now = SystemTime::now();
        let mut token = None;
        loop {
            let listed = self
                .call(
                    self.client
                        .list_objects_v2()
                        .bucket(&self.bucket)
                        .prefix(&self.prefix)
                        .set_continuation_token(token.take())
                        .send(),
                )
                .await;
            let listed = match listed {
                Ok(listed) => listed,
                Err(error) => {
                    tracing::warn!(error, "S3 cleanup: failed to list objects");
                    return;
                }
            };
            // Bounded concurrency, so one slow object does not hold up the rest.
            stream::iter(listed.contents().iter().filter_map(|o| o.key()))
                .for_each_concurrent(SWEEP_CONCURRENCY, |key| self.sweep(key, now))
                .await;
            match (listed.is_truncated(), listed.next_continuation_token()) {
                (Some(true), Some(next)) => token = Some(next.to_owned()),
                _ => return,
            }
        }
    }

    async fn sweep(&self, key: &str, now: SystemTime) {
        let id = key.strip_prefix(&self.prefix).unwrap_or(key);
        let secret_id = redact_secret_id(id);
        let head = self
            .call(
                self.client
                    .head_object()
                    .bucket(&self.bucket)
                    .key(key)
                    .send(),
            )
            .await;
        let head = match head {
            Ok(head) => head,
            Err(error) => {
                let error = redact_error(&error, id);
                tracing::debug!(secret_id, error, "S3 cleanup: failed to head object");
                return;
            }
        };
        let Some(expires) = head.expires_string() else {
            return;
        };
        let Ok(expires) = httpdate::parse_http_date(expires) else {
            let value = expires.replace(id, &secret_id);
            tracing::debug!(secret_id, value, "S3 cleanup: invalid Expires header");
            return;
        };
        if now <= expires {
            return;
        }
        let deleted = self
            .call(
                self.client
                    .delete_object()
                    .bucket(&self.bucket)
                    .key(key)
                    .send(),
            )
            .await;
        match deleted {
            Ok(_) => tracing::debug!(secret_id, "Cleaned up expired S3 object"),
            Err(error) => {
                let error = redact_error(&error, id);
                tracing::warn!(
                    secret_id,
                    error,
                    "S3 cleanup: failed to delete expired object"
                );
            }
        }
    }

    /// Sweeps expired objects until `stop` fires.
    pub async fn run_cleanup(self, interval: Duration, stop: CancellationToken) {
        run_periodic(interval, stop, || self.cleanup_expired()).await;
    }
}

fn storage(what: &str, error: String) -> FileError {
    FileError::Storage(format!("{what}: {error}"))
}

/// The upload as the SDK's request body. It keeps the stream's own error, so a
/// client fault stays distinguishable from a storage fault, and holds the body
/// to its declared length so the signed Content-Length is never wrong.
struct Upload {
    // Never contended: the Mutex only makes the stream Sync, as the SDK requires.
    stream: Mutex<ByteStream>,
    remaining: Option<u64>,
    failure: Arc<Mutex<Option<io::Error>>>,
    // The SDK polls past the end, which the upload stream does not allow.
    done: bool,
}

impl Upload {
    fn fail(&mut self, error: io::Error) -> Poll<Option<Result<Frame<Bytes>, io::Error>>> {
        self.done = true;
        *self.failure.lock().unwrap_or_else(PoisonError::into_inner) = Some(error);
        Poll::Ready(Some(Err(io::Error::other("upload body failed"))))
    }
}

impl Body for Upload {
    type Data = Bytes;
    type Error = io::Error;

    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, io::Error>>> {
        let this = self.get_mut();
        if this.done {
            return Poll::Ready(None);
        }
        let stream = this
            .stream
            .get_mut()
            .unwrap_or_else(PoisonError::into_inner);
        match ready!(stream.as_mut().poll_next(cx)) {
            Some(Ok(chunk)) => {
                if let Some(remaining) = &mut this.remaining {
                    let Some(left) = remaining.checked_sub(chunk.len() as u64) else {
                        return this.fail(io::Error::other("body longer than its Content-Length"));
                    };
                    *remaining = left;
                }
                Poll::Ready(Some(Ok(Frame::data(chunk))))
            }
            Some(Err(error)) => this.fail(error),
            None if this.remaining.is_some_and(|left| left > 0) => this.fail(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "body shorter than its Content-Length",
            )),
            None => {
                this.done = true;
                Poll::Ready(None)
            }
        }
    }

    fn is_end_stream(&self) -> bool {
        self.done
    }

    fn size_hint(&self) -> SizeHint {
        self.remaining
            .map_or_else(SizeHint::new, SizeHint::with_exact)
    }
}

#[async_trait]
impl FileStore for S3FileStore {
    async fn save(
        &self,
        key: &str,
        body: ByteStream,
        size: Option<u64>,
        expiration: i32,
    ) -> Result<(), FileError> {
        let failure = Arc::new(Mutex::new(None));
        let upload = Upload {
            stream: Mutex::new(body),
            remaining: size,
            failure: failure.clone(),
            done: false,
        };
        let mut put = self
            .client
            .put_object()
            .bucket(&self.bucket)
            .key(self.object_key(key))
            .expires(DateTime::from_secs(now_unix() + i64::from(expiration)))
            .body(SdkStream::from_body_1_x(upload));
        if let Some(size) = size {
            let size =
                i64::try_from(size).map_err(|_| storage("s3 put failed", "too large".into()))?;
            put = put.content_length(size);
        }
        let result = put.send().await;
        if let Some(error) = failure
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take()
        {
            return Err(FileError::Read(error));
        }
        result
            .map(drop)
            .map_err(|e| storage("s3 put failed", DisplayErrorContext(&e).to_string()))
    }

    async fn load(&self, key: &str) -> Result<(ByteStream, u64), FileError> {
        let request = self
            .client
            .get_object()
            .bucket(&self.bucket)
            .key(self.object_key(key))
            .send();
        let output = match tokio::time::timeout(self.call_timeout, request).await {
            Err(_) => return Err(storage("s3 get failed", "timed out".into())),
            // Only NoSuchKey proves the object is gone; a missing bucket or a
            // denied request is an outage.
            Ok(Err(error)) if error.as_service_error().is_some_and(|e| e.is_no_such_key()) => {
                return Err(FileError::NotFound);
            }
            Ok(Err(error)) => {
                return Err(storage(
                    "s3 get failed",
                    DisplayErrorContext(&error).to_string(),
                ));
            }
            Ok(Ok(output)) => output,
        };
        // 0 sends the download without a Content-Length, as Go does.
        let size = output
            .content_length()
            .and_then(|length| u64::try_from(length).ok())
            .unwrap_or(0);
        let body = stream::unfold(output.body, |mut body| async move {
            let chunk = body.next().await?;
            Some((chunk.map_err(io::Error::other), body))
        });
        Ok((Box::pin(body), size))
    }

    async fn delete(&self, key: &str) -> Result<(), FileError> {
        self.call(
            self.client
                .delete_object()
                .bucket(&self.bucket)
                .key(self.object_key(key))
                .send(),
        )
        .await
        .map(drop)
        .map_err(|e| storage("s3 delete failed", e))
    }

    async fn health(&self) -> Result<(), FileError> {
        self.call(self.client.head_bucket().bucket(&self.bucket).send())
            .await
            .map(drop)
            .map_err(|e| storage("s3 health check failed", e))
    }
}
