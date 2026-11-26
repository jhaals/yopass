//! HTTP handlers and the request helpers they share.

use crate::app::App;
use crate::audit::Auditor;
use crate::auth::{Restriction, Session};
use crate::files::{BodyTooLarge, ByteStream};
use crate::mail::{MAX_LABEL_LENGTH, is_valid_recipient};
use crate::util::{is_valid_key, now_unix};
use axum::body::Body;
use axum::extract::{FromRequestParts, MatchedPath, Path, Request};
use axum::http::header::{self, HeaderValue};
use axum::http::{Extensions, HeaderMap, Method, StatusCode, request::Parts};
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

pub mod code;
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

pub struct InvalidRecipientHeader;

/// The recipient a file upload names. A header that is present must hold one
/// percent-encoded address: anything else is an error, never "no recipient".
pub fn recipient_header(headers: &HeaderMap) -> Result<String, InvalidRecipientHeader> {
    let mut values = headers.get_all("x-yopass-recipient").iter();
    let Some(value) = values.next() else {
        return Ok(String::new());
    };
    if values.next().is_some() {
        return Err(InvalidRecipientHeader);
    }
    let text = value.to_str().map_err(|_| InvalidRecipientHeader)?;
    let decoded = percent_encoding::percent_decode_str(text)
        .decode_utf8()
        .map_err(|_| InvalidRecipientHeader)?;
    let decoded = decoded.trim();
    if decoded.is_empty() {
        return Err(InvalidRecipientHeader);
    }
    Ok(decoded.to_owned())
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

/// The audit event of a state-changing route. A request the CORS middleware
/// refuses is recorded under the name its handler would have logged.
fn origin_checked_event(method: &Method, template: &str) -> Option<&'static str> {
    Some(match (method.as_str(), template) {
        ("POST", "/auth/logout") => "auth.logout",
        ("POST", "/create/secret") => "secret.created",
        ("DELETE", "/secret/{key}") => "secret.deleted",
        ("POST", "/create/file") => "file.uploaded",
        ("DELETE", "/file/{key}") => "file.deleted",
        ("POST", "/request") => "request.created",
        ("DELETE", "/request/{key}") => "request.revoked",
        ("POST", "/request/{key}/secret") => "request.fulfilled",
        ("PUT", "/request/{key}/key") => "request.key_rotated",
        ("POST", "/secret/{key}/code") => "secret.code_requested",
        ("POST", "/secret/{key}/code/verify") => "secret.code_failed",
        ("POST", "/file/{key}/code") => "file.code_requested",
        ("POST", "/file/{key}/code/verify") => "file.code_failed",
        _ => return None,
    })
}

/// No handler runs for a request the CORS middleware refuses, so without this
/// split-origin deployments would not audit the cross-origin attempts that
/// same-origin deployments record as denied.
pub async fn audit_origin_denied(app: &App, request: Request) {
    let (mut parts, _) = request.into_parts();
    let Some(template) = parts
        .extensions
        .get::<MatchedPath>()
        .map(|p| p.as_str().to_owned())
    else {
        return;
    };
    let Some(event) = origin_checked_event(&parts.method, &template) else {
        return;
    };
    let ip = client_ip(app, &parts.headers, &parts.extensions);
    let mut audit = Auditor::new(app.audit(), event, ip, None);
    if template.contains("{key}") {
        // As in the handlers, a malformed key is not an event.
        let Ok(Key(key)) = Key::from_request_parts(&mut parts, &()).await else {
            return;
        };
        audit.set_secret_id(&key);
    }
    audit.denied("cross-origin request");
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
    // Header values may hold bytes that are not text. Split the raw bytes, so
    // such a hop ends the walk like any other garbage instead of hiding the
    // hops a trusted proxy appended to the same value.
    let hops: Vec<&[u8]> = headers
        .get_all("x-forwarded-for")
        .iter()
        .flat_map(|value| value.as_bytes().split(|byte| *byte == b','))
        .collect();
    for hop in hops.iter().rev() {
        let hop = std::str::from_utf8(hop).unwrap_or_default();
        let Ok(ip) = hop.trim().parse::<IpAddr>() else {
            return peer.to_string();
        };
        if !trusted(ip) {
            return ip.to_canonical().to_string();
        }
    }
    peer.to_string()
}

/// The identity `--require-auth-all` admitted, for audit records of handlers
/// that authorize by token. Routes that gate does not cover have none.
pub fn gate_session(parts: &Parts) -> Option<&Session> {
    parts.extensions.get()
}

/// Seals the address for an "email me" opt-in on record `id`: always the
/// signed-in user's own, which the identity provider verified. API tokens have
/// no mailbox, so only an OIDC session qualifies. `notify_label` is the label
/// the creator gave when asking for the mail, and `None` when they did not ask.
pub fn seal_notify(
    app: &App,
    session: Option<&Session>,
    id: &str,
    notify_label: Option<&str>,
    lifetime: i32,
    audit: &Auditor,
) -> Result<Option<String>, Response> {
    let Some(label) = notify_label else {
        return Ok(None);
    };
    let refuse = |reason: &'static str, message| {
        audit.failure(reason);
        Err(json_error(StatusCode::BAD_REQUEST, message))
    };
    let Some(mailer) = app.mailer() else {
        return refuse(
            "email notifications not enabled",
            "Email notifications are not enabled on this server",
        );
    };
    let Some(session) = session.filter(|session| !session.id.is_empty()) else {
        return refuse(
            "email notification without a signed-in user",
            "Sign in to be notified by email",
        );
    };
    // Checked per session, not only at startup: a login made before verified
    // addresses were required stays valid for up to a day.
    if !session.email_verified {
        return refuse(
            "email notification for an unverified address",
            "Sign in again with a verified email address to be notified by email",
        );
    }
    if !is_valid_recipient(&session.email) {
        return refuse(
            "account email address not usable for mail",
            "Your account's email address cannot receive notifications",
        );
    }
    if label.chars().count() > MAX_LABEL_LENGTH {
        return refuse("label too long", "Label is too long");
    }
    if label.chars().any(char::is_control) {
        return refuse("invalid label", "Label contains invalid characters");
    }
    Ok(Some(mailer.seal(id, &session.email, label, lifetime)))
}

/// Validates a requested recipient and seals who may open the record stored
/// under `db_key`. An API token may name a recipient, even on a route that
/// does not require sign-in, but such a secret has no creator.
pub fn seal_restriction(
    app: &App,
    session: Option<&Session>,
    headers: &HeaderMap,
    db_key: &str,
    recipient: &str,
    lifetime: i32,
    audit: &Auditor,
) -> Result<Option<String>, Response> {
    let recipient = recipient.trim();
    if recipient.is_empty() {
        return Ok(None);
    }
    let refuse = |status, reason: &'static str, message| {
        audit.failure(reason);
        Err(json_error(status, message))
    };
    if !app.restricted_recipients_enabled() {
        return refuse(
            StatusCode::BAD_REQUEST,
            "restricted recipients not enabled",
            "Restricted recipients are not enabled on this server",
        );
    }
    // Invisible or spacing characters would make an address nobody signs in with.
    let unprintable = |c: char| {
        c.is_whitespace()
            || c.is_control()
            || matches!(c, '\u{200b}'..='\u{200f}' | '\u{2060}'..='\u{2064}' | '\u{feff}')
    };
    if recipient.chars().any(unprintable) || !is_valid_recipient(recipient) {
        return refuse(
            StatusCode::BAD_REQUEST,
            "invalid recipient",
            "Recipient must be a single email address",
        );
    }
    // Outside the allowed domains a recipient can only use an emailed code.
    if !app.email_allowed(recipient) && !app.code_eligible(recipient) {
        return refuse(
            StatusCode::BAD_REQUEST,
            "recipient domain not permitted",
            "The recipient cannot sign in to this server",
        );
    }
    let token = app.api_token_session(headers);
    let (creator, creator_sub) = match session.or(token.as_ref()) {
        Some(session) if session.api_token => (String::new(), String::new()),
        // Checked per session: a login from before verified addresses were
        // required stays valid for up to a day, and a creator must match later.
        Some(session) if session.email_verified => (session.email.clone(), session.sub.clone()),
        Some(_) => {
            return refuse(
                StatusCode::BAD_REQUEST,
                "recipient set from an unverified address",
                "Sign in again with a verified email address to restrict a secret",
            );
        }
        None => {
            return refuse(
                StatusCode::UNAUTHORIZED,
                "recipient set without a signed-in user",
                "Sign in to restrict a secret to a recipient",
            );
        }
    };
    let restriction = Restriction {
        recipient: recipient.to_owned(),
        recipient_sub: String::new(),
        creator,
        creator_sub,
        expires_at: now_unix() + i64::from(lifetime),
    };
    match app.seal_restriction(db_key, &restriction, lifetime) {
        Some(sealed) => Ok(Some(sealed)),
        None => refuse(
            StatusCode::INTERNAL_SERVER_ERROR,
            "failed to seal recipient",
            "Failed to store secret",
        ),
    }
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
