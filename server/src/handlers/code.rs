//! Emailed one-time codes for restricted recipients: asking for a code, and
//! trading it for a short grant to open that one secret.

use super::{AppState, BodyError, Key, client_ip, json_error, json_ok, no_store, read_body};
use crate::audit::Auditor;
use crate::codes::{self, Requested, Verified};
use crate::lifecycle::Kind;
use axum::extract::Request;
use axum::http::StatusCode;
use axum::http::header::{ACCEPT_LANGUAGE, CONTENT_TYPE, SET_COOKIE};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::json;

/// Both bodies are one short field.
const BODY_LIMIT: u64 = 1024;

/// The same answer whether or not a code went out, so the address a secret is
/// restricted to cannot be probed.
const REQUESTED: &str = "If this address may open the secret, a code was sent to it";

fn events(kind: Kind) -> (&'static str, &'static str, &'static str) {
    match kind {
        Kind::Text => (
            "secret.code_requested",
            "secret.code_verified",
            "secret.code_failed",
        ),
        Kind::File => (
            "file.code_requested",
            "file.code_verified",
            "file.code_failed",
        ),
    }
}

/// Where the grant cookie is sent: the secret's own routes.
fn route(kind: Kind, key: &str) -> String {
    format!("/{}/{key}", kind.webhook_kind())
}

async fn body<T: for<'de> Deserialize<'de>>(
    request: Request,
    timeout: Option<std::time::Duration>,
) -> Result<(axum::http::request::Parts, T), Response> {
    let (parts, body) = request.into_parts();
    // A cross-site form can only send form or plain-text bodies; JSON needs
    // a preflight that CORS decides on.
    let json = parts
        .headers
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(';').next())
        .is_some_and(|v| v.trim().eq_ignore_ascii_case("application/json"));
    if !json {
        return Err(json_error(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Content-Type must be application/json",
        ));
    }
    let data = read_body(body, BODY_LIMIT, timeout)
        .await
        .map_err(|error| match error {
            BodyError::TooLarge => {
                json_error(StatusCode::PAYLOAD_TOO_LARGE, "Request body too large")
            }
            BodyError::TimedOut => json_error(StatusCode::REQUEST_TIMEOUT, "Request timed out"),
            BodyError::Read => json_error(StatusCode::BAD_REQUEST, "Unable to parse json"),
        })?;
    let value = serde_json::from_slice(&data)
        .map_err(|_| json_error(StatusCode::BAD_REQUEST, "Unable to parse json"))?;
    Ok((parts, value))
}

async fn request_code(state: AppState, key: String, request: Request, kind: Kind) -> Response {
    #[derive(Deserialize)]
    struct Body {
        email: String,
    }
    let app = state.0;
    let (parts, Body { email }) = match body(request, app.settings.request_timeout).await {
        Ok(parsed) => parsed,
        Err(response) => return response,
    };
    let ip = client_ip(&app, &parts.headers, &parts.extensions);
    let mut audit = Auditor::new(app.audit(), events(kind).0, ip, None);
    audit.set_secret_id(&key);
    let accept = parts
        .headers
        .get(ACCEPT_LANGUAGE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    let lang = crate::code_mail::language(accept);
    match codes::request(&app, kind, &key, &email, lang).await {
        Requested::Sent => audit.success(Default::default()),
        Requested::NotEligible => audit.failure("not an eligible recipient"),
        Requested::RateLimited => audit.failure("too many codes requested"),
        // Not shown to the visitor: the answer must not depend on the address.
        Requested::MailUnavailable => audit.failure("code mail not sent"),
        Requested::DbUnavailable => audit.failure("database unavailable"),
    }
    no_store(
        (
            StatusCode::ACCEPTED,
            axum::Json(json!({ "message": REQUESTED })),
        )
            .into_response(),
    )
}

async fn verify_code(state: AppState, key: String, request: Request, kind: Kind) -> Response {
    #[derive(Deserialize)]
    struct Body {
        email: String,
        code: String,
    }
    let app = state.0;
    let (parts, Body { email, code }) = match body(request, app.settings.request_timeout).await {
        Ok(parsed) => parsed,
        Err(response) => return response,
    };
    let (_, verified_event, failed_event) = events(kind);
    let ip = client_ip(&app, &parts.headers, &parts.extensions);
    let mut audit = Auditor::new(app.audit(), failed_event, ip, None);
    audit.set_secret_id(&key);
    let email = match codes::verify(&app, kind, &key, &email, code.trim()).await {
        Verified::Granted(email) => email,
        Verified::Wrong => {
            audit.failure("wrong code");
            return json_error(StatusCode::FORBIDDEN, "Invalid or expired code");
        }
        Verified::NoCode => {
            audit.failure("no live code");
            return json_error(StatusCode::FORBIDDEN, "Invalid or expired code");
        }
        Verified::DbUnavailable => {
            audit.failure("database unavailable");
            return json_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Database temporarily unavailable",
            );
        }
    };
    let mut audit = audit.with_event(verified_event);
    audit.set_user(&email, "");
    let Some(cookie) = app.grant_cookie(&parts, &route(kind, &key), &kind.db_key(&key), &email)
    else {
        audit.failure("failed to seal grant");
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, "Failed to verify code");
    };
    audit.success(Default::default());
    let mut response = no_store(json_ok(&json!({ "message": "Code accepted" })));
    response.headers_mut().append(SET_COOKIE, cookie);
    response
}

pub async fn request_secret_code(state: AppState, Key(key): Key, request: Request) -> Response {
    request_code(state, key, request, Kind::Text).await
}

pub async fn request_file_code(state: AppState, Key(key): Key, request: Request) -> Response {
    request_code(state, key, request, Kind::File).await
}

pub async fn verify_secret_code(state: AppState, Key(key): Key, request: Request) -> Response {
    verify_code(state, key, request, Kind::Text).await
}

pub async fn verify_file_code(state: AppState, Key(key): Key, request: Request) -> Response {
    verify_code(state, key, request, Kind::File).await
}
