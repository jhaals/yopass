//! Creating, reading, inspecting and deleting secrets.

use super::{
    AppState, BodyError, Key, client_ip, json_body_limit, json_error, json_ok, no_store, read_body,
};
use crate::app::{App, STREAM_KEY_PREFIX};
use crate::armor::is_pgp_encrypted;
use crate::audit::{Auditor, Fields};
use crate::auth::Session;
use crate::db::{Abort, DbError, Secret};
use crate::files::FileError;
use crate::handlers::receipt::{create_receipt, mark_receipt_viewed};
use crate::util::{expiration_in_seconds, generate_id, is_preset_expiration, redact_error};
use crate::webhook::KIND_SECRET;
use axum::extract::Request;
use axum::http::{StatusCode, request::Parts};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

/// Client-requested attributes validated by `check_creation_policy`.
pub struct CreationPolicy {
    pub expiration: i32,
    pub one_time: bool,
    pub require_auth: bool,
    pub receipt: bool,
}

/// Enforces the server-side policy shared by /create/secret and /create/file.
pub fn check_creation_policy(
    app: &App,
    policy: &CreationPolicy,
    audit: &Auditor,
) -> Result<(), Response> {
    if policy.receipt && !app.read_receipts_enabled() {
        audit.failure("read receipts not enabled");
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "Read receipts are not enabled on this server",
        ));
    }
    check_expiration_policy(app, policy.expiration, audit)?;
    if policy.require_auth && !app.oidc_enabled() {
        audit.failure("auth required but OIDC not configured");
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "Authentication not configured on this server",
        ));
    }
    if !policy.one_time && app.settings.force_onetime_secrets {
        audit.failure("one-time required by server policy");
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "Secret must be one time download",
        ));
    }
    Ok(())
}

pub fn accepts_expiration(app: &App, seconds: i32) -> bool {
    if !app.settings.allow_custom_expiration {
        return is_preset_expiration(seconds);
    }
    seconds > 0 && seconds >= app.settings.min_expiration && seconds <= app.settings.max_expiration
}

/// Validates the lifetime for secrets, files and secret requests.
pub fn check_expiration_policy(
    app: &App,
    expiration: i32,
    audit: &Auditor,
) -> Result<(), Response> {
    if !accepts_expiration(app, expiration) {
        audit.failure("invalid expiration");
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "Invalid expiration specified",
        ));
    }
    let forced = &app.settings.force_expiration;
    if !forced.is_empty() && expiration != expiration_in_seconds(forced) {
        audit.failure("expiration does not match forced value");
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "Expiration does not match server policy",
        ));
    }
    Ok(())
}

pub async fn create_secret(state: AppState, request: Request) -> Response {
    let app = state.0;
    let (parts, body) = request.into_parts();
    let session = app.session(&parts).await;
    let ip = client_ip(&app, &parts.headers, &parts.extensions);
    let mut audit = Auditor::new(app.audit(), "secret.created", ip, session.as_ref());

    #[derive(Deserialize)]
    struct CreateBody {
        #[serde(flatten)]
        secret: Secret,
        #[serde(default)]
        receipt: bool,
    }
    let limit = json_body_limit(app.settings.max_length);
    let data = match read_body(body, limit, app.settings.request_timeout).await {
        Ok(data) => data,
        Err(BodyError::TooLarge) => {
            audit.failure("request body too large");
            return json_error(StatusCode::PAYLOAD_TOO_LARGE, "Request body too large");
        }
        Err(BodyError::TimedOut) => {
            return json_error(StatusCode::REQUEST_TIMEOUT, "Request timed out");
        }
        Err(BodyError::Read) => return json_error(StatusCode::BAD_REQUEST, "Unable to parse json"),
    };
    let Ok(CreateBody { secret, receipt }) = serde_json::from_slice(&data) else {
        return json_error(StatusCode::BAD_REQUEST, "Unable to parse json");
    };

    let policy = CreationPolicy {
        expiration: secret.expiration,
        one_time: secret.one_time,
        require_auth: secret.require_auth,
        receipt,
    };
    if let Err(response) = check_creation_policy(&app, &policy, &audit) {
        return response;
    }
    if secret.message.len() as u64 > app.settings.max_length {
        audit.failure("message too long");
        return json_error(StatusCode::BAD_REQUEST, "The encrypted message is too long");
    }
    if !is_pgp_encrypted(&secret.message) {
        audit.failure("message not PGP encrypted");
        return json_error(StatusCode::BAD_REQUEST, "Message must be PGP encrypted");
    }

    let key = generate_id();
    audit.set_secret_id(&key);
    if let Err(error) = app.db.put(&key, &secret).await {
        tracing::error!(error = redact_error(&error, &key), "Unable to store secret");
        audit.failure("database error");
        return json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to store secret in database",
        );
    }

    // Start the receipt TTL after storage so it cannot expire before the secret.
    let mut response = serde_json::json!({ "message": key });
    if receipt {
        match create_receipt(&app, &key, secret.one_time, secret.expiration).await {
            Ok(token) => response["receipt_token"] = token.into(),
            Err(error) => {
                tracing::error!(
                    error = redact_error(&error, &key),
                    "Unable to store read receipt"
                );
                if let Err(error) = app.db.delete(&key).await {
                    tracing::error!(
                        error = redact_error(&error, &key),
                        "Failed to delete secret after receipt error"
                    );
                }
                audit.failure("failed to store receipt");
                return json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Failed to store receipt in database",
                );
            }
        }
    }

    audit.success(Fields {
        one_time: Some(secret.one_time),
        expiration: Some(secret.expiration),
        require_auth: Some(secret.require_auth),
    });
    if let Some(webhook) = app.webhook() {
        webhook.secret_created(&key, KIND_SECRET, secret.one_time, secret.expiration);
    }
    json_ok(&response)
}

/// Translates an access-control abort into its audit record and response.
pub fn denied_response(abort: Abort, audit: &Auditor) -> Response {
    let fields = Fields {
        require_auth: Some(true),
        ..Fields::default()
    };
    match abort {
        Abort::DomainForbidden => {
            audit.denied_with("email domain not permitted", fields);
            json_error(StatusCode::FORBIDDEN, "email domain not permitted")
        }
        _ => {
            audit.denied_with("authentication required", fields);
            json_error(StatusCode::UNAUTHORIZED, "authentication required")
        }
    }
}

/// Reads a secret, consuming it when one-time. Authorization sits inside the
/// backend's claim, so a replacement cannot be consumed using an earlier
/// snapshot's access policy. The receipt write must precede the claim: a failed
/// write has to prevent delivery while the secret is still intact.
pub async fn read_authorized(
    app: &Arc<App>,
    db_key: &str,
    receipt_id: &str,
    session: Option<&Session>,
    audit: &Auditor,
) -> Result<Secret, Response> {
    let secret = match app.db.status(db_key).await {
        Ok(secret) => secret,
        Err(DbError::NotFound) => {
            audit.failure("not found or claim failed");
            return Err(json_error(StatusCode::NOT_FOUND, "Secret not found"));
        }
        Err(error) => {
            tracing::error!(
                error = redact_error(&error, receipt_id),
                "Unable to read secret"
            );
            audit.failure("database error");
            return Err(json_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Database temporarily unavailable",
            ));
        }
    };
    if let Err(abort) = app.check_access(&secret, session) {
        return Err(denied_response(abort, audit));
    }
    claim_authorized(app, db_key, receipt_id, session, audit).await
}

/// The rest of `read_authorized`, for a caller that has read and checked a
/// snapshot itself.
pub async fn claim_authorized(
    app: &Arc<App>,
    db_key: &str,
    receipt_id: &str,
    session: Option<&Session>,
    audit: &Auditor,
) -> Result<Secret, Response> {
    if let Err(error) = mark_receipt_viewed(app, receipt_id).await {
        tracing::error!(
            error = redact_error(&error, receipt_id),
            "Unable to store viewed read receipt"
        );
        audit.failure("failed to store read receipt");
        return Err(json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Database temporarily unavailable",
        ));
    }

    let claim_attempted = AtomicBool::new(false);
    let result = app
        .db
        .get_authorized(db_key, &|snapshot| {
            app.check_access(snapshot, session)?;
            claim_attempted.store(snapshot.one_time, Ordering::Relaxed);
            Ok(())
        })
        .await;
    let one_time = Fields {
        one_time: Some(true),
        ..Fields::default()
    };
    match result {
        Ok(secret) => Ok(secret),
        Err(DbError::Aborted(abort)) => Err(denied_response(abort, audit)),
        Err(DbError::NotFound) if claim_attempted.load(Ordering::Relaxed) => {
            audit.denied_with("claimed by concurrent request", one_time);
            Err(json_error(StatusCode::NOT_FOUND, "Secret not found"))
        }
        Err(error) if claim_attempted.load(Ordering::Relaxed) => {
            tracing::error!(
                error = redact_error(&error, receipt_id),
                "Failed to claim one-time secret"
            );
            audit.failure_with("failed to claim one-time secret", one_time);
            Err(json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to process secret",
            ))
        }
        Err(DbError::NotFound) => {
            audit.failure("not found or claim failed");
            Err(json_error(StatusCode::NOT_FOUND, "Secret not found"))
        }
        Err(error) => {
            tracing::error!(
                error = redact_error(&error, receipt_id),
                "Unable to read secret"
            );
            audit.failure("database error");
            Err(json_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Database temporarily unavailable",
            ))
        }
    }
}

pub async fn get_secret(state: AppState, Key(key): Key, parts: Parts) -> Response {
    let app = state.0;
    let session = app.session(&parts).await;
    let ip = client_ip(&app, &parts.headers, &parts.extensions);
    let mut audit = Auditor::new(app.audit(), "secret.accessed", ip, session.as_ref());
    audit.set_secret_id(&key);

    let secret = match read_authorized(&app, &key, &key, session.as_ref(), &audit).await {
        Ok(secret) => secret,
        Err(response) => return no_store(response),
    };
    // Logged before writing: for one-time secrets the outcome is already decided.
    audit.success(Fields {
        one_time: Some(secret.one_time),
        require_auth: Some(secret.require_auth),
        ..Fields::default()
    });
    if let Some(webhook) = app.webhook() {
        webhook.secret_viewed(&key, KIND_SECRET, secret.one_time);
    }
    no_store(json_ok(&secret))
}

async fn status(
    app: Arc<App>,
    key: String,
    parts: Parts,
    prefix: &str,
    event: &'static str,
) -> Response {
    let session = app.session(&parts).await;
    let ip = client_ip(&app, &parts.headers, &parts.extensions);
    let mut audit = Auditor::new(app.audit(), event, ip, session.as_ref());
    audit.set_secret_id(&key);
    let response = match app.db.status(&format!("{prefix}{key}")).await {
        Ok(secret) => {
            audit.success(Fields {
                one_time: Some(secret.one_time),
                require_auth: Some(secret.require_auth),
                ..Fields::default()
            });
            json_ok(
                &serde_json::json!({ "oneTime": secret.one_time, "requireAuth": secret.require_auth }),
            )
        }
        Err(DbError::NotFound) => {
            audit.failure("not found");
            json_error(StatusCode::NOT_FOUND, "Secret not found")
        }
        Err(error) => {
            tracing::error!(
                error = redact_error(&error, &key),
                "Unable to read secret status"
            );
            audit.failure("database error");
            json_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Database temporarily unavailable",
            )
        }
    };
    no_store(response)
}

/// Non-destructive, so the browser can warn before spending a one-time link.
pub async fn secret_status(state: AppState, Key(key): Key, parts: Parts) -> Response {
    status(state.0, key, parts, "", "secret.status_checked").await
}

pub async fn file_status(state: AppState, Key(key): Key, parts: Parts) -> Response {
    status(
        state.0,
        key,
        parts,
        STREAM_KEY_PREFIX,
        "file.status_checked",
    )
    .await
}

/// Removes a secret ahead of its expiration, enforcing `require_auth`. Files also
/// remove their blob after the metadata key is gone.
pub async fn delete_entry(
    app: Arc<App>,
    key: String,
    parts: Parts,
    prefix: &str,
    event: &'static str,
    delete_blob: bool,
) -> Response {
    let session = app.session(&parts).await;
    let ip = client_ip(&app, &parts.headers, &parts.extensions);
    let mut audit = Auditor::new(app.audit(), event, ip, session.as_ref());
    audit.set_secret_id(&key);

    let deleted = app
        .db
        .delete_authorized(&format!("{prefix}{key}"), &|snapshot| {
            app.check_access(snapshot, session.as_ref())
        })
        .await;
    match deleted {
        Ok(()) => {}
        Err(DbError::Aborted(abort)) => return denied_response(abort, &audit),
        Err(DbError::NotFound) => {
            audit.failure("not found");
            return json_error(StatusCode::NOT_FOUND, "Secret not found");
        }
        Err(error) => {
            tracing::error!(
                error = redact_error(&error, &key),
                "Failed to delete secret"
            );
            audit.failure("database error");
            return json_error(StatusCode::INTERNAL_SERVER_ERROR, "Failed to delete secret");
        }
    }

    if delete_blob && let Err(error) = delete_file_bounded(&app, &key).await {
        tracing::error!(
            error = redact_error(&error, &key),
            "Failed to delete streaming file"
        );
        // Revocation succeeded; expiry cleanup owns any remaining ciphertext.
        audit
            .with_event("file.cleanup_failed")
            .failure("failed to delete file from store after revocation");
    }

    audit.success(Fields::default());
    if let Some(webhook) = app.webhook() {
        webhook.secret_deleted(&key);
    }
    StatusCode::NO_CONTENT.into_response()
}

pub async fn delete_secret(state: AppState, Key(key): Key, parts: Parts) -> Response {
    delete_entry(state.0, key, parts, "", "secret.deleted", false).await
}

/// Finishes file cleanup within a bound, even if the requesting client is gone.
pub async fn delete_file_bounded(app: &App, key: &str) -> Result<(), FileError> {
    let Some(files) = &app.files else {
        return Ok(());
    };
    tokio::time::timeout(Duration::from_secs(5), files.delete(key))
        .await
        .map_err(|_| FileError::Storage("file delete timed out".into()))?
}
