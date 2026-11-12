//! Streaming file upload and download.

use super::secret::{
    CreationPolicy, access_failure, check_creation_policy, delete_entry, store_failure,
};
use super::{AppState, Key, client_ip, json_error, json_ok, limited_stream, no_store};
use crate::app::App;
use crate::armor::is_openpgp_binary;
use crate::audit::{Auditor, Fields};
use crate::db::Secret;
use crate::files::{ByteStream, is_too_large};
use crate::lifecycle::{self, Kind};
use crate::util::generate_id;
use crate::webhook::KIND_FILE;
use axum::body::Body;
use axum::extract::Request;
use axum::http::header::{self, HeaderValue};
use axum::http::{HeaderMap, StatusCode, request::Parts};
use axum::response::{IntoResponse, Response};
use bytes::Bytes;
use futures_util::{Stream, StreamExt, stream};
use std::io;
use std::pin::Pin;
use std::task::{Context, Poll};
use tokio::time::Instant;

fn header_is_true(headers: &HeaderMap, name: &str) -> bool {
    headers.get(name).is_some_and(|value| value == "true")
}

fn is_octet_stream(headers: &HeaderMap) -> bool {
    headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .is_some_and(|media| {
            media
                .trim()
                .eq_ignore_ascii_case("application/octet-stream")
        })
}

/// Checks everything knowable from the headers, before touching the body.
/// Returns the policy and the declared Content-Length.
fn upload_policy(
    app: &App,
    headers: &HeaderMap,
    audit: &Auditor,
) -> Result<(CreationPolicy, Option<u64>), Response> {
    if !is_octet_stream(headers) {
        audit.failure("invalid content-type");
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "Content-Type must be application/octet-stream",
        ));
    }
    let Some(expiration) = headers.get("x-yopass-expiration") else {
        audit.failure("missing expiration header");
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "X-Yopass-Expiration header required",
        ));
    };
    let Some(expiration) = expiration.to_str().ok().and_then(|v| v.parse::<i32>().ok()) else {
        audit.failure("invalid expiration");
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "Invalid expiration specified",
        ));
    };
    let policy = CreationPolicy {
        expiration,
        one_time: header_is_true(headers, "x-yopass-onetime"),
        require_auth: header_is_true(headers, "x-yopass-requireauth"),
        receipt: header_is_true(headers, "x-yopass-receipt"),
    };
    check_creation_policy(app, &policy, audit)?;

    // Reject early on Content-Length; the stream enforces the limit on the bytes
    // actually read, as a safety net for a missing or lying header.
    let max_size = app.effective_max_file_size();
    let declared = headers
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());
    if max_size > 0 && declared.is_some_and(|length| length > max_size) {
        audit.failure("file too large");
        return Err(json_error(StatusCode::PAYLOAD_TOO_LARGE, "File too large"));
    }
    Ok((policy, declared))
}

/// The encrypted body streams into the file store; metadata goes to the database.
pub async fn upload(state: AppState, request: Request) -> Response {
    let app = state.0;
    let (parts, body) = request.into_parts();
    let session = app.session(&parts).await;
    let ip = client_ip(&app, &parts.headers, &parts.extensions);
    let mut audit = Auditor::new(app.audit(), "file.uploaded", ip, session.as_ref());
    let (policy, declared) = match upload_policy(&app, &parts.headers, &audit) {
        Ok(checked) => checked,
        Err(response) => return response,
    };
    let CreationPolicy {
        expiration,
        one_time,
        require_auth,
        receipt,
    } = policy;
    let max_size = app.effective_max_file_size();
    // One deadline for reading the body and committing it, as in the Go server.
    let deadline = app
        .settings
        .file_transfer_timeout
        .map(|limit| Instant::now() + limit);
    let mut stream = limited_stream(body, max_size, deadline);

    // The stream must open with a key packet, before anything touches storage.
    let first = loop {
        match stream.next().await {
            Some(Ok(chunk)) if chunk.is_empty() => continue,
            Some(Ok(chunk)) => break chunk,
            Some(Err(error)) if is_too_large(&error) => {
                audit.failure("file too large");
                return json_error(StatusCode::PAYLOAD_TOO_LARGE, "File too large");
            }
            _ => {
                audit.failure("not an OpenPGP message");
                return json_error(
                    StatusCode::BAD_REQUEST,
                    "Invalid data: not an OpenPGP message",
                );
            }
        }
    };
    if !is_openpgp_binary(first[0]) {
        audit.failure("not an OpenPGP message");
        return json_error(
            StatusCode::BAD_REQUEST,
            "Invalid data: not an OpenPGP message",
        );
    }
    let body: ByteStream =
        Box::pin(stream::once(async move { Ok::<_, io::Error>(first) }).chain(stream));

    let key = generate_id();
    audit.set_secret_id(&key);
    let upload = lifecycle::Upload {
        body,
        declared_size: declared,
        deadline,
    };
    let meta = Secret {
        expiration,
        one_time,
        require_auth,
        ..Secret::default()
    };
    let receipt_token = match lifecycle::store_file(&app, &key, upload, &meta, receipt).await {
        Ok(token) => token,
        Err(error) => return store_failure(error, &audit),
    };
    let mut response = serde_json::json!({ "message": key });
    if let Some(token) = receipt_token {
        response["receipt_token"] = token.into();
    }

    audit.success(Fields {
        one_time: Some(one_time),
        expiration: Some(expiration),
        require_auth: Some(require_auth),
    });
    if let Some(webhook) = app.webhook() {
        webhook.secret_created(&key, KIND_FILE, one_time, expiration);
    }
    json_ok(&response)
}

/// A download body that ends with an error at its deadline, so a stalled
/// transfer is aborted rather than reported as complete.
struct DownloadStream {
    inner: ByteStream,
    deadline: Option<Pin<Box<tokio::time::Sleep>>>,
}

impl Stream for DownloadStream {
    type Item = io::Result<Bytes>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        if let Some(deadline) = &mut self.deadline
            && deadline.as_mut().poll(cx).is_ready()
        {
            self.deadline = None;
            return Poll::Ready(Some(Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "file transfer timed out",
            ))));
        }
        self.inner.as_mut().poll_next(cx)
    }
}

/// Serves the encrypted file as a binary stream.
pub async fn download(state: AppState, Key(key): Key, parts: Parts) -> Response {
    let app = state.0;
    let session = app.session(&parts).await;
    let ip = client_ip(&app, &parts.headers, &parts.extensions);
    let mut audit = Auditor::new(app.audit(), "file.downloaded", ip, session.as_ref());
    audit.set_secret_id(&key);

    let cleanup_audit = audit.clone();
    let opened = lifecycle::open_file(&app, &key, session.as_ref(), move || {
        cleanup_audit
            .with_event("file.cleanup_failed")
            .failure("failed to delete file from store after delivery");
    })
    .await;
    let lifecycle::FileDelivery {
        meta: secret,
        content,
        size,
    } = match opened {
        Ok(delivery) => delivery,
        Err(error) => return no_store(access_failure(error, &audit, "not found")),
    };

    // Record access before streaming: a disconnect must not hide a consumed file.
    audit.success(Fields {
        one_time: Some(secret.one_time),
        require_auth: Some(secret.require_auth),
        ..Fields::default()
    });
    if let Some(webhook) = app.webhook() {
        webhook.secret_viewed(&key, KIND_FILE, secret.one_time);
    }

    let deadline = app
        .settings
        .file_transfer_timeout
        .map(|limit| Instant::now() + limit);
    let body = Body::from_stream(DownloadStream {
        inner: content,
        deadline: deadline.map(|at| Box::pin(tokio::time::sleep_until(at))),
    });
    let mut response = body.into_response();
    if let Some(at) = deadline {
        response
            .extensions_mut()
            .insert(crate::serve::TransferDeadline(at));
    }
    let map = response.headers_mut();
    map.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    map.insert(
        header::ACCESS_CONTROL_EXPOSE_HEADERS,
        HeaderValue::from_static("Content-Length"),
    );
    if size > 0 {
        map.insert(header::CONTENT_LENGTH, HeaderValue::from(size));
    }
    no_store(response)
}

pub async fn delete_file(state: AppState, Key(key): Key, parts: Parts) -> Response {
    delete_entry(state.0, key, parts, Kind::File, "file.deleted").await
}
