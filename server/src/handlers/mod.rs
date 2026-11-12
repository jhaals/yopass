//! HTTP handlers and the request helpers they share.

use crate::app::App;
use crate::files::{BodyTooLarge, ByteStream};
use crate::util::is_valid_key;
use axum::body::Body;
use axum::extract::{FromRequestParts, Path};
use axum::http::header::{self, HeaderValue};
use axum::http::{Extensions, HeaderMap, StatusCode, request::Parts};
use axum::response::{IntoResponse, Response};
use bytes::{Bytes, BytesMut};
use futures_util::{StreamExt, stream};
use http_body_util::BodyExt;
use serde::Serialize;
use std::io;
use std::net::IpAddr;
use std::sync::Arc;
use std::time::Duration;
use tokio::time::Instant;

pub mod file;
pub mod ops;
pub mod receipt;
pub mod request;
pub mod secret;

/// Per-connection facts, attached by the server loop.
#[derive(Clone, Copy, Debug)]
pub struct ConnInfo {
    pub peer: IpAddr,
    pub tls: bool,
}

pub fn json_error(status: StatusCode, message: &str) -> Response {
    (
        status,
        axum::Json(serde_json::json!({ "message": message })),
    )
        .into_response()
}

pub fn json_ok<T: Serialize>(value: &T) -> Response {
    (StatusCode::OK, axum::Json(value)).into_response()
}

/// Sensitive responses must not be stored: a cached copy outlives a consumed secret.
pub fn no_store(mut response: Response) -> Response {
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

pub fn found(location: &str) -> Response {
    let mut response = StatusCode::FOUND.into_response();
    if let Ok(value) = HeaderValue::from_str(location) {
        response.headers_mut().insert(header::LOCATION, value);
    }
    response
}

pub fn not_found_page() -> Response {
    (StatusCode::NOT_FOUND, "404 page not found\n").into_response()
}

pub async fn cors_preflight(methods: &'static str, headers: &'static str) -> Response {
    let mut response = StatusCode::OK.into_response();
    let map = response.headers_mut();
    map.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static(methods),
    );
    if !headers.is_empty() {
        map.insert(
            header::ACCESS_CONTROL_ALLOW_HEADERS,
            HeaderValue::from_static(headers),
        );
    }
    if methods.starts_with("POST, GET") {
        map.insert(
            header::ACCESS_CONTROL_EXPOSE_HEADERS,
            HeaderValue::from_static("Content-Length"),
        );
    }
    response
}

/// A header's value, empty when it is missing or not text.
pub fn header_str<'a>(headers: &'a HeaderMap, name: &str) -> &'a str {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
}

/// A validated secret ID from the path. Anything else is a plain 404, so a
/// malformed key never reaches a database key or a file path.
pub struct Key(pub String);

impl<S: Send + Sync> FromRequestParts<S> for Key {
    type Rejection = Response;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Response> {
        let Path(key) = Path::<String>::from_request_parts(parts, state)
            .await
            .map_err(|_| not_found_page())?;
        if is_valid_key(&key) {
            Ok(Self(key))
        } else {
            Err(not_found_page())
        }
    }
}

/// The nearest untrusted client IP. A trusted proxy may append to a
/// client-supplied X-Forwarded-For, so the chain is read right to left.
pub fn client_ip(app: &App, headers: &HeaderMap, extensions: &Extensions) -> String {
    let Some(peer) = extensions.get::<ConnInfo>().map(|c| c.peer.to_canonical()) else {
        return String::new();
    };
    let trusted = |ip: IpAddr| app.settings.trusted_proxies.iter().any(|p| p.contains(ip));
    if !trusted(peer) {
        return peer.to_string();
    }
    let hops: Vec<&str> = headers
        .get_all("x-forwarded-for")
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .collect();
    for hop in hops.iter().rev() {
        let Ok(ip) = hop.trim().parse::<IpAddr>() else {
            return peer.to_string();
        };
        if !trusted(ip) {
            return ip.to_canonical().to_string();
        }
    }
    peer.to_string()
}

/// Whether the request was made over HTTPS. X-Forwarded-Proto is only believed
/// from a trusted proxy once any are configured.
pub fn is_secure(app: &App, headers: &HeaderMap, extensions: &Extensions) -> bool {
    let conn = extensions.get::<ConnInfo>();
    if conn.is_some_and(|c| c.tls) {
        return true;
    }
    if !headers
        .get("x-forwarded-proto")
        .is_some_and(|v| v == "https")
    {
        return false;
    }
    let proxies = &app.settings.trusted_proxies;
    proxies.is_empty() || conn.is_some_and(|c| proxies.iter().any(|p| p.contains(c.peer)))
}

pub fn request_host(parts: &Parts) -> String {
    parts
        .uri
        .authority()
        .map(|authority| authority.to_string())
        .or_else(|| {
            parts
                .headers
                .get(header::HOST)
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned)
        })
        .unwrap_or_default()
}

/// Largest JSON envelope carrying an armored message of `n` bytes: armor wraps
/// at 64 characters and each newline escapes to two bytes.
pub fn json_body_limit(n: u64) -> u64 {
    n + n / 64 + 4096
}

pub enum BodyError {
    TooLarge,
    TimedOut,
    Read,
}

/// Reads at most `limit` bytes within `deadline`.
pub async fn read_body(
    mut body: Body,
    limit: u64,
    deadline: Option<Duration>,
) -> Result<Bytes, BodyError> {
    let deadline = deadline.map(|d| Instant::now() + d);
    let mut data = BytesMut::new();
    loop {
        let frame = match deadline {
            Some(at) => tokio::time::timeout_at(at, body.frame())
                .await
                .map_err(|_| BodyError::TimedOut)?,
            None => body.frame().await,
        };
        let Some(frame) = frame else {
            return Ok(data.freeze());
        };
        let Ok(chunk) = frame.map_err(|_| BodyError::Read)?.into_data() else {
            continue; // trailers
        };
        if data.len() as u64 + chunk.len() as u64 > limit {
            return Err(BodyError::TooLarge);
        }
        data.extend_from_slice(&chunk);
    }
}

/// Turns the request body into a stream enforcing a byte limit (when non-zero)
/// and an overall deadline, so a stalled upload ends on its own.
pub fn limited_stream(body: Body, limit: u64, deadline: Option<Instant>) -> ByteStream {
    let chunks = stream::unfold(
        (body.into_data_stream(), 0u64, false),
        move |(mut body, mut seen, done)| async move {
            if done {
                return None;
            }
            let next = match deadline {
                Some(at) => match tokio::time::timeout_at(at, body.next()).await {
                    Ok(next) => next,
                    Err(_) => {
                        let error =
                            io::Error::new(io::ErrorKind::TimedOut, "file transfer timed out");
                        return Some((Err(error), (body, seen, true)));
                    }
                },
                None => body.next().await,
            };
            match next? {
                Ok(chunk) => {
                    seen += chunk.len() as u64;
                    if limit > 0 && seen > limit {
                        return Some((Err(io::Error::other(BodyTooLarge)), (body, seen, true)));
                    }
                    Some((Ok(chunk), (body, seen, false)))
                }
                Err(error) => Some((Err(io::Error::other(error)), (body, seen, true))),
            }
        },
    );
    Box::pin(chunks)
}

pub type AppState = axum::extract::State<Arc<App>>;
