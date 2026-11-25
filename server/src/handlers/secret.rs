//! Creating, reading, inspecting and deleting secrets.

use super::{
    AppState, BodyError, Key, client_ip, json_body_limit, json_error, json_ok, no_store, read_body,
    seal_notify, seal_restriction,
};
use crate::app::{App, STREAM_KEY_PREFIX};
use crate::armor::is_pgp_encrypted;
use crate::audit::{Auditor, Fields};
use crate::auth::{ACCESS_METHOD_OIDC, Session};
use crate::db::{Abort, DbError, Secret};
use crate::lifecycle::{self, AccessError, Kind, Revoked, StoreError, Track};
use crate::util::{expiration_in_seconds, generate_id, is_preset_expiration, redact_error};
use crate::webhook::{KIND_SECRET, WebhookNotifier};
use axum::extract::Request;
use axum::http::{StatusCode, request::Parts};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;

use std::sync::Arc;

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
        /// Email the signed-in creator on the first view; implies a receipt.
        #[serde(default)]
        notify: bool,
        #[serde(default)]
        label: String,
        /// The one email address that may open the secret, besides its creator.
        #[serde(default)]
        recipient: String,
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
    let Ok(CreateBody {
        mut secret,
        receipt,
        notify,
        label,
        recipient,
    }) = serde_json::from_slice(&data)
    else {
        return json_error(StatusCode::BAD_REQUEST, "Unable to parse json");
    };

    let policy = CreationPolicy {
        expiration: secret.expiration,
        one_time: secret.one_time,
        require_auth: secret.require_auth,
        // An email notification rides on the receipt, so it implies one.
        receipt: receipt || notify,
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
    let (session, notify_label) = (session.as_ref(), notify.then_some(label.as_str()));
    let sealed = match seal_notify(&app, session, &key, notify_label, secret.expiration, &audit) {
        Ok(sealed) => sealed,
        Err(response) => return response,
    };
    let (headers, lifetime) = (&parts.headers, secret.expiration);
    secret.restriction =
        match seal_restriction(&app, session, headers, &key, &recipient, lifetime, &audit) {
            Ok(sealed) => sealed,
            Err(response) => return response,
        };
    // A recipient implies sign-in, also for anything reading the flag alone.
    secret.require_auth |= secret.restriction.is_some();
    audit.set_secret_id(&key);
    let track = Track::new(receipt, sealed.as_deref());
    let receipt_token = match lifecycle::store_text(&app, &key, &secret, track).await {
        Ok(token) => token,
        Err(error) => return store_failure(error, &audit),
    };
    let mut response = serde_json::json!({ "message": key });
    if let Some(token) = receipt_token {
        response["receipt_token"] = token.into();
    }
    // Confirms the restriction, so a client can tell a server that ignored it.
    if secret.restriction.is_some() {
        response["restricted"] = true.into();
    }

    audit.success(Fields {
        one_time: Some(secret.one_time),
        expiration: Some(secret.expiration),
        require_auth: Some(secret.require_auth),
        restricted: Some(secret.restriction.is_some()),
        ..Fields::default()
    });
    if let Some(webhook) = app.webhook() {
        webhook.secret_created(&key, KIND_SECRET, secret.one_time, secret.expiration);
    }
    json_ok(&response)
}

/// Translates a failed store into its audit record and response.
pub fn store_failure(error: StoreError, audit: &Auditor) -> Response {
    let (reason, status, message) = match error {
        StoreError::TooLarge => (
            "file too large",
            StatusCode::PAYLOAD_TOO_LARGE,
            "File too large",
        ),
        StoreError::FileWrite => (
            "failed to store file",
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to store file",
        ),
        StoreError::SecretWrite => (
            "database error",
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to store secret in database",
        ),
        StoreError::MetadataWrite => (
            "failed to store metadata",
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to store metadata",
        ),
        StoreError::ReceiptWrite => (
            "failed to store receipt",
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to store receipt in database",
        ),
    };
    audit.failure(reason);
    json_error(status, message)
}

/// The audit fields of a granted read. A restricted secret was opened by the
/// signed-in identity the audit record already names.
pub fn access_fields(secret: &Secret) -> Fields {
    let restricted = secret.restriction.is_some();
    Fields {
        one_time: Some(secret.one_time),
        require_auth: Some(secret.require_auth),
        restricted: Some(restricted),
        access_method: restricted.then_some(ACCESS_METHOD_OIDC),
        ..Fields::default()
    }
}

/// Reports a granted view. A restricted secret was opened by the session that
/// was granted access.
pub fn report_view(
    webhook: &WebhookNotifier,
    key: &str,
    kind: Kind,
    secret: &Secret,
    session: Option<&Session>,
) {
    let kind_name = kind.webhook_kind();
    match session.filter(|_| secret.restriction.is_some()) {
        Some(viewer) => webhook.secret_viewed_by(key, kind_name, secret.one_time, &viewer.email),
        None => webhook.secret_viewed(key, kind_name, secret.one_time),
    }
}

/// Reports a signed-in identity that a restricted secret refused.
pub fn report_denial(
    app: &App,
    key: &str,
    kind: Kind,
    error: AccessError,
    session: Option<&Session>,
) {
    if let (AccessError::Denied(Abort::NotRecipient), Some(session), Some(webhook)) =
        (error, session, app.webhook())
    {
        webhook.secret_access_denied(key, kind.webhook_kind(), &session.email);
    }
}

/// Translates an access-control abort into its audit record and response.
pub fn denied_response(abort: Abort, audit: &Auditor) -> Response {
    let fields = Fields {
        require_auth: Some(true),
        ..Fields::default()
    };
    let restricted = Fields {
        restricted: Some(true),
        ..fields
    };
    match abort {
        // The address is never revealed, only that there is one.
        Abort::RecipientRequired => {
            audit.denied_with("restricted to a recipient", restricted);
            json_error(
                StatusCode::UNAUTHORIZED,
                "This secret is restricted to a specific recipient",
            )
        }
        Abort::NotRecipient => {
            audit.denied_with("not the permitted recipient", restricted);
            json_error(
                StatusCode::FORBIDDEN,
                "Signed in as an identity that is not the permitted recipient",
            )
        }
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

/// Translates a failed read into its audit record and response. A lookup miss
/// is audited as `not_found_reason`.
pub fn access_failure(
    error: AccessError,
    audit: &Auditor,
    not_found_reason: &'static str,
) -> Response {
    let one_time = Fields {
        one_time: Some(true),
        ..Fields::default()
    };
    let unavailable = || {
        json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Database temporarily unavailable",
        )
    };
    match error {
        AccessError::NotFound => {
            audit.failure(not_found_reason);
            json_error(StatusCode::NOT_FOUND, "Secret not found")
        }
        AccessError::Vanished => {
            audit.failure("not found or claim failed");
            json_error(StatusCode::NOT_FOUND, "Secret not found")
        }
        AccessError::Denied(abort) => denied_response(abort, audit),
        AccessError::ClaimedConcurrently => {
            audit.denied_with("claimed by concurrent request", one_time);
            json_error(StatusCode::NOT_FOUND, "Secret not found")
        }
        AccessError::ClaimFailed => {
            audit.failure_with("failed to claim one-time secret", one_time);
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to process secret",
            )
        }
        AccessError::ReceiptUnavailable => {
            audit.failure("failed to store read receipt");
            unavailable()
        }
        AccessError::DbUnavailable => {
            audit.failure("database error");
            unavailable()
        }
        AccessError::FileStoreUnavailable => {
            audit.failure("file store unavailable");
            json_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "File store temporarily unavailable",
            )
        }
        AccessError::FileMissing => {
            audit.failure("file not found in store");
            json_error(StatusCode::NOT_FOUND, "File not found")
        }
    }
}

pub async fn get_secret(state: AppState, Key(key): Key, parts: Parts) -> Response {
    let app = state.0;
    let session = app.session(&parts).await;
    let ip = client_ip(&app, &parts.headers, &parts.extensions);
    let mut audit = Auditor::new(app.audit(), "secret.accessed", ip, session.as_ref());
    audit.set_secret_id(&key);

    let mut secret = match lifecycle::read_text(&app, &key, session.as_ref()).await {
        Ok(secret) => secret,
        Err(error) => {
            report_denial(&app, &key, Kind::Text, error, session.as_ref());
            return no_store(access_failure(error, &audit, "not found or claim failed"));
        }
    };
    // Logged before writing: for one-time secrets the outcome is already decided.
    audit.success(access_fields(&secret));
    if let Some(webhook) = app.webhook() {
        report_view(webhook, &key, Kind::Text, &secret, session.as_ref());
    }
    secret.restriction = None;
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
            let mut status = serde_json::json!({
                "oneTime": secret.one_time,
                "requireAuth": secret.require_auth,
            });
            if secret.restriction.is_some() {
                status["restricted"] = true.into();
            }
            json_ok(&status)
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

/// Revokes a secret or file ahead of its expiration.
pub async fn delete_entry(
    app: Arc<App>,
    key: String,
    parts: Parts,
    kind: Kind,
    event: &'static str,
) -> Response {
    let session = app.session(&parts).await;
    let ip = client_ip(&app, &parts.headers, &parts.extensions);
    let mut audit = Auditor::new(app.audit(), event, ip, session.as_ref());
    audit.set_secret_id(&key);

    let revoked = lifecycle::revoke(&app, kind, &key, session.as_ref()).await;
    if let Err(error) = revoked {
        report_denial(&app, &key, kind, error, session.as_ref());
    }
    match revoked {
        Ok(Revoked::Clean) => {}
        // Revocation succeeded; expiry cleanup owns any remaining ciphertext.
        Ok(Revoked::BlobLeftBehind) => audit
            .with_event("file.cleanup_failed")
            .failure("failed to delete file from store after revocation"),
        Err(AccessError::Denied(abort)) => return denied_response(abort, &audit),
        Err(AccessError::NotFound) => {
            audit.failure("not found");
            return json_error(StatusCode::NOT_FOUND, "Secret not found");
        }
        Err(_) => {
            audit.failure("database error");
            return json_error(StatusCode::INTERNAL_SERVER_ERROR, "Failed to delete secret");
        }
    }

    audit.success(Fields::default());
    if let Some(webhook) = app.webhook() {
        webhook.secret_deleted(&key);
    }
    StatusCode::NO_CONTENT.into_response()
}

pub async fn delete_secret(state: AppState, Key(key): Key, parts: Parts) -> Response {
    delete_entry(state.0, key, parts, Kind::Text, "secret.deleted").await
}
