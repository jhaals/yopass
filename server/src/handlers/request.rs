//! Secret requests: the requester publishes a public key, a responder encrypts a
//! secret against it, and the requester collects it with a management token. The
//! private key stays in the requester's browser.

use super::secret::check_expiration_policy;
use super::{
    AppState, BodyError, Key, client_ip, header_str, json_body_limit, json_error, json_ok,
    no_store, read_body,
};
use crate::app::{App, REQUEST_KEY_PREFIX, REQUEST_TOKEN_HEADER};
use crate::armor::{
    MAX_PUBLIC_KEY_LENGTH, is_pgp_encrypted, is_pgp_public_key, max_armored_file_length,
};
use crate::audit::{Auditor, Fields};
use crate::db::{Abort, DbError, Secret};
use crate::util::{
    generate_id, generate_token, now_unix, redact_error, seconds_until, token_matches_hash,
};
use axum::extract::Request;
use axum::http::{HeaderMap, StatusCode, request::Parts};
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};

const STATE_PENDING: &str = "pending";
const STATE_FULFILLED: &str = "fulfilled";
const KIND_TEXT: &str = "text";
const KIND_FILE: &str = "file";
const MAX_LABEL_LENGTH: usize = 100;
pub const MAX_NOTE_LENGTH_CAP: usize = 10000;
/// File answers live inside the request record in the database, so the cap keeps
/// a full record within Memcached's default 1MB item limit.
const MAX_REQUEST_FILE_SIZE: u64 = 512 * 1024;

/// The stored record, encoded inside `Secret::message`. Shared with the Go server.
#[derive(Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct SecretRequest {
    #[serde(default)]
    pub public_key: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub key_version: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub label: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub note: String,
    #[serde(default)]
    pub token_hash: String,
    #[serde(default)]
    pub state: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub secret: String,
    /// Empty on old records and means text.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub kind: String,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub expires_at: i64,
}

fn parse(record: &Secret) -> Option<SecretRequest> {
    serde_json::from_str::<SecretRequest>(&record.message)
        .ok()
        .filter(|request| !request.token_hash.is_empty() && seconds_until(request.expires_at) > 0)
}

/// An empty kind comes from old records or clients and means text.
fn kind_or_text(kind: &str) -> &str {
    if kind.is_empty() { KIND_TEXT } else { kind }
}

fn db_key(id: &str) -> String {
    format!("{REQUEST_KEY_PREFIX}{id}")
}

fn token_header(headers: &HeaderMap) -> &str {
    header_str(headers, REQUEST_TOKEN_HEADER)
}

/// Keeps backend failures distinct from permanently missing requests: telling a
/// requester their request is gone during an outage would make them discard it.
async fn require_request(app: &App, id: &str, audit: &Auditor) -> Result<SecretRequest, Response> {
    match app.db.status(&db_key(id)).await {
        Ok(record) => parse(&record).ok_or_else(|| {
            audit.failure("not found");
            json_error(StatusCode::NOT_FOUND, "Secret request not found")
        }),
        Err(DbError::NotFound) => {
            audit.failure("not found");
            Err(json_error(
                StatusCode::NOT_FOUND,
                "Secret request not found",
            ))
        }
        Err(error) => {
            tracing::error!(
                error = redact_error(&error, id),
                "Unable to load secret request"
            );
            audit.failure("database error");
            Err(json_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Database temporarily unavailable",
            ))
        }
    }
}

/// Atomically applies a lifecycle transition, safely across instances. The stored
/// deadline is preserved: every update carries only the remaining lifetime.
async fn update_request<F>(app: &App, id: &str, transition: F) -> Result<(), DbError>
where
    F: Fn(&mut SecretRequest) -> Result<(), Abort> + Send + Sync,
{
    app.db
        .update(&db_key(id), &|record| {
            let mut request = parse(&record).ok_or(DbError::Aborted(Abort::InvalidRecord))?;
            // Computed once: a later zero would persist an expired request forever.
            let ttl = seconds_until(request.expires_at);
            if ttl == 0 {
                return Err(DbError::Aborted(Abort::InvalidRecord));
            }
            transition(&mut request).map_err(DbError::Aborted)?;
            Ok(Secret {
                message: serde_json::to_string(&request)
                    .map_err(|e| DbError::Backend(e.to_string()))?,
                expiration: ttl,
                ..Secret::default()
            })
        })
        .await
}

pub async fn create_request(state: AppState, request: Request) -> Response {
    let app = state.0;
    let (parts, body) = request.into_parts();
    let session = app.session(&parts).await;
    let ip = client_ip(&app, &parts.headers, &parts.extensions);
    let mut audit = Auditor::new(app.audit(), "request.created", ip, session.as_ref());

    if !app.secret_requests_enabled() {
        audit.denied("secret requests disabled");
        return json_error(
            StatusCode::FORBIDDEN,
            "Secret requests are currently disabled",
        );
    }

    #[derive(Deserialize)]
    struct CreateBody {
        #[serde(default)]
        public_key: String,
        #[serde(default)]
        label: String,
        #[serde(default)]
        note: String,
        #[serde(default)]
        expiration: i32,
    }
    // A note character is at most 12 bytes JSON-escaped (a surrogate pair).
    let max_note = app.settings.max_request_note_length;
    let limit = (MAX_PUBLIC_KEY_LENGTH + 4096 + 12 * max_note) as u64;
    let parsed = read_body(body, limit, app.settings.request_timeout)
        .await
        .ok()
        .and_then(|data| serde_json::from_slice::<CreateBody>(&data).ok());
    let Some(body) = parsed else {
        audit.failure("unable to parse json");
        return json_error(StatusCode::BAD_REQUEST, "Unable to parse json");
    };

    if !is_pgp_public_key(&body.public_key) {
        audit.failure("invalid public key");
        return json_error(
            StatusCode::BAD_REQUEST,
            "A valid PGP public key is required",
        );
    }
    if let Err(response) = check_expiration_policy(&app, body.expiration, &audit) {
        return response;
    }
    if body.label.len() > MAX_LABEL_LENGTH {
        audit.failure("label too long");
        return json_error(StatusCode::BAD_REQUEST, "Label is too long");
    }
    let note = body.note.trim();
    if note.chars().count() > max_note {
        audit.failure("note too long");
        return json_error(StatusCode::BAD_REQUEST, "Note is too long");
    }

    let id = generate_id();
    audit.set_secret_id(&id);
    let (token, token_hash) = generate_token();
    let now = now_unix();
    let record = SecretRequest {
        public_key: body.public_key,
        label: body.label,
        note: note.to_owned(),
        token_hash,
        state: STATE_PENDING.into(),
        created_at: now,
        expires_at: now + i64::from(body.expiration),
        ..SecretRequest::default()
    };
    let stored = match serde_json::to_string(&record) {
        Ok(message) => {
            let secret = Secret {
                message,
                expiration: body.expiration,
                ..Secret::default()
            };
            app.db.put(&db_key(&id), &secret).await
        }
        Err(error) => Err(DbError::Backend(error.to_string())),
    };
    if let Err(error) = stored {
        tracing::error!(
            error = redact_error(&error, &id),
            "Unable to store secret request"
        );
        audit.failure("database error");
        return json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to store request in database",
        );
    }

    audit.success(Fields {
        expiration: Some(body.expiration),
        ..Fields::default()
    });
    if let Some(webhook) = app.webhook() {
        webhook.request_created(&id, body.expiration);
    }
    json_ok(&serde_json::json!({ "id": id, "token": token, "expires_at": record.expires_at }))
}

/// The public view for responders. The ciphertext and token hash stay out.
pub async fn get_request(state: AppState, Key(id): Key, parts: Parts) -> Response {
    let app = state.0;
    let ip = client_ip(&app, &parts.headers, &parts.extensions);
    let mut audit = Auditor::new(app.audit(), "request.viewed", ip, None);
    audit.set_secret_id(&id);
    let request = match require_request(&app, &id, &audit).await {
        Ok(request) => request,
        Err(response) => return no_store(response),
    };
    audit.success(Fields::default());
    no_store(json_ok(&serde_json::json!({
        "public_key": request.public_key,
        "key_version": request.key_version,
        "label": request.label,
        "note": request.note,
        "state": request.state,
        "expires_at": request.expires_at,
    })))
}

/// The raw limit for file answers: the smaller of --max-file-size and the record
/// cap. An unlimited --max-file-size still leaves the cap in place.
pub fn effective_request_file_size(app: &App) -> u64 {
    match app.effective_max_file_size() {
        size if size > 0 && size < MAX_REQUEST_FILE_SIZE => size,
        _ => MAX_REQUEST_FILE_SIZE,
    }
}

fn fulfill_body_limit(app: &App) -> u64 {
    let text = json_body_limit(app.settings.max_length);
    if app.settings.disable_upload {
        return text;
    }
    text.max(json_body_limit(max_armored_file_length(
        effective_request_file_size(app),
    )))
}

/// Stores the responder's ciphertext on a pending request and marks it fulfilled.
pub async fn fulfill_request(state: AppState, Key(id): Key, request: Request) -> Response {
    let app = state.0;
    let (parts, body) = request.into_parts();
    let ip = client_ip(&app, &parts.headers, &parts.extensions);
    let mut audit = Auditor::new(app.audit(), "request.fulfilled", ip, None);
    audit.set_secret_id(&id);

    #[derive(Deserialize)]
    struct FulfillBody {
        #[serde(default)]
        message: String,
        #[serde(default)]
        key_version: String,
        #[serde(default)]
        kind: String,
    }
    let data = match read_body(body, fulfill_body_limit(&app), app.settings.request_timeout).await {
        Ok(data) => data,
        Err(BodyError::TooLarge) => {
            audit.failure("request body too large");
            return json_error(StatusCode::PAYLOAD_TOO_LARGE, "Request body too large");
        }
        Err(BodyError::TimedOut) => {
            return json_error(StatusCode::REQUEST_TIMEOUT, "Request timed out");
        }
        Err(BodyError::Read) => {
            audit.failure("unable to parse json");
            return json_error(StatusCode::BAD_REQUEST, "Unable to parse json");
        }
    };
    let Ok(body) = serde_json::from_slice::<FulfillBody>(&data) else {
        audit.failure("unable to parse json");
        return json_error(StatusCode::BAD_REQUEST, "Unable to parse json");
    };

    let kind = kind_or_text(&body.kind);
    match kind {
        KIND_TEXT => {
            if body.message.len() as u64 > app.settings.max_length {
                audit.failure("message too long");
                return json_error(StatusCode::BAD_REQUEST, "The encrypted message is too long");
            }
        }
        KIND_FILE => {
            if app.settings.disable_upload {
                audit.denied("file responses disabled");
                return json_error(
                    StatusCode::BAD_REQUEST,
                    "File responses are disabled on this server",
                );
            }
            if body.message.len() as u64
                > max_armored_file_length(effective_request_file_size(&app))
            {
                audit.failure("file too large");
                return json_error(StatusCode::PAYLOAD_TOO_LARGE, "File too large");
            }
        }
        _ => {
            audit.failure("invalid kind");
            return json_error(StatusCode::BAD_REQUEST, "Invalid secret kind");
        }
    }
    if !is_pgp_encrypted(&body.message) {
        audit.failure("message not PGP encrypted");
        return json_error(StatusCode::BAD_REQUEST, "Message must be PGP encrypted");
    }

    let updated = update_request(&app, &id, |request| {
        if request.state == STATE_FULFILLED {
            return Err(Abort::AlreadyFulfilled);
        }
        // An answer encrypted to a rotated-out key could never be decrypted.
        if request.key_version != body.key_version {
            return Err(Abort::KeyRotated);
        }
        request.state = STATE_FULFILLED.into();
        request.secret.clone_from(&body.message);
        request.note.clear(); // only useful while pending; stop exposing it to link holders
        request.kind = kind.to_owned();
        Ok(())
    })
    .await;
    match updated {
        Ok(()) => {}
        Err(DbError::NotFound | DbError::Aborted(Abort::InvalidRecord)) => {
            audit.failure("not found");
            return json_error(StatusCode::NOT_FOUND, "Secret request not found");
        }
        Err(DbError::Aborted(Abort::AlreadyFulfilled)) => {
            audit.denied("already fulfilled");
            return json_error(
                StatusCode::CONFLICT,
                "A secret has already been provided for this request",
            );
        }
        Err(DbError::Aborted(Abort::KeyRotated)) => {
            audit.denied("request key changed");
            return json_error(
                StatusCode::PRECONDITION_FAILED,
                "Request key changed; open the new request link",
            );
        }
        Err(error) => {
            tracing::error!(
                error = redact_error(&error, &id),
                "Unable to store fulfilled request"
            );
            audit.failure("database error");
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to store secret in database",
            );
        }
    }

    audit.success(Fields::default());
    if let Some(webhook) = app.webhook() {
        webhook.request_fulfilled(&id);
    }
    json_ok(&serde_json::json!({ "message": "secret provided" }))
}

/// Returns the ciphertext to the requester and deletes the request.
pub async fn fetch_request_secret(state: AppState, Key(id): Key, parts: Parts) -> Response {
    let app = state.0;
    let ip = client_ip(&app, &parts.headers, &parts.extensions);
    let mut audit = Auditor::new(app.audit(), "request.secret_accessed", ip, None);
    audit.set_secret_id(&id);

    let request = match require_request(&app, &id, &audit).await {
        Ok(request) => request,
        Err(response) => return no_store(response),
    };
    if !token_matches_hash(token_header(&parts.headers), &request.token_hash) {
        audit.denied("invalid management token");
        return no_store(json_error(
            StatusCode::UNAUTHORIZED,
            "Invalid request token",
        ));
    }
    if request.state != STATE_FULFILLED {
        audit.failure("no secret provided yet");
        return no_store(json_error(
            StatusCode::CONFLICT,
            "No secret has been provided yet",
        ));
    }

    // Retrievable once: delete before responding, and only the exact snapshot
    // that was authorized, so a failed delete can never mean a second fetch.
    let claimed = app
        .db
        .delete_authorized(
            &db_key(&id),
            &|snapshot| match serde_json::from_str::<SecretRequest>(&snapshot.message) {
                Ok(current) if current == request => Ok(()),
                _ => Err(Abort::Stale),
            },
        )
        .await;
    match claimed {
        Ok(()) => {}
        Err(DbError::NotFound | DbError::Aborted(_)) => {
            audit.failure("already claimed");
            return no_store(json_error(
                StatusCode::NOT_FOUND,
                "Secret request not found",
            ));
        }
        Err(error) => {
            tracing::error!(
                error = redact_error(&error, &id),
                "Failed to delete fulfilled request"
            );
            audit.failure("failed to claim secret");
            return no_store(json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to process secret",
            ));
        }
    }

    let kind = kind_or_text(&request.kind);
    audit.success(Fields::default());
    if let Some(webhook) = app.webhook() {
        webhook.request_closed(&id);
    }
    no_store(json_ok(
        &serde_json::json!({ "message": request.secret, "kind": kind }),
    ))
}

/// Deletes a request. Requires the management token.
pub async fn revoke_request(state: AppState, Key(id): Key, parts: Parts) -> Response {
    let app = state.0;
    let ip = client_ip(&app, &parts.headers, &parts.extensions);
    let mut audit = Auditor::new(app.audit(), "request.revoked", ip, None);
    audit.set_secret_id(&id);

    let request = match require_request(&app, &id, &audit).await {
        Ok(request) => request,
        Err(response) => return response,
    };
    if !token_matches_hash(token_header(&parts.headers), &request.token_hash) {
        audit.denied("invalid management token");
        return json_error(StatusCode::UNAUTHORIZED, "Invalid request token");
    }
    if app.db.delete(&db_key(&id)).await.is_err() {
        audit.failure("database error");
        return json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to revoke request",
        );
    }
    audit.success(Fields::default());
    if let Some(webhook) = app.webhook() {
        webhook.request_closed(&id);
    }
    StatusCode::NO_CONTENT.into_response()
}

/// Replaces the public key of a pending request. Requires the management token,
/// checked inside the update so it applies to the record actually modified.
pub async fn rotate_request_key(state: AppState, Key(id): Key, request: Request) -> Response {
    let app = state.0;
    let (parts, body) = request.into_parts();
    let ip = client_ip(&app, &parts.headers, &parts.extensions);
    let mut audit = Auditor::new(app.audit(), "request.key_rotated", ip, None);
    audit.set_secret_id(&id);

    #[derive(Deserialize)]
    struct RotateBody {
        #[serde(default)]
        public_key: String,
    }
    let limit = (MAX_PUBLIC_KEY_LENGTH + 4096) as u64;
    let parsed = read_body(body, limit, app.settings.request_timeout)
        .await
        .ok()
        .and_then(|data| serde_json::from_slice::<RotateBody>(&data).ok());
    let Some(body) = parsed else {
        audit.failure("unable to parse json");
        return json_error(StatusCode::BAD_REQUEST, "Unable to parse json");
    };
    if !is_pgp_public_key(&body.public_key) {
        audit.failure("invalid public key");
        return json_error(
            StatusCode::BAD_REQUEST,
            "A valid PGP public key is required",
        );
    }

    let token = token_header(&parts.headers);
    let updated = update_request(&app, &id, |request| {
        if !token_matches_hash(token, &request.token_hash) {
            return Err(Abort::InvalidToken);
        }
        if request.state == STATE_FULFILLED {
            return Err(Abort::AlreadyFulfilled);
        }
        request.public_key.clone_from(&body.public_key);
        request.key_version = generate_id();
        Ok(())
    })
    .await;
    match updated {
        Ok(()) => {}
        Err(DbError::NotFound | DbError::Aborted(Abort::InvalidRecord)) => {
            audit.failure("not found");
            return json_error(StatusCode::NOT_FOUND, "Secret request not found");
        }
        Err(DbError::Aborted(Abort::InvalidToken)) => {
            audit.denied("invalid management token");
            return json_error(StatusCode::UNAUTHORIZED, "Invalid request token");
        }
        Err(DbError::Aborted(Abort::AlreadyFulfilled)) => {
            audit.denied("already fulfilled");
            return json_error(
                StatusCode::CONFLICT,
                "A secret has already been provided for this request",
            );
        }
        Err(error) => {
            tracing::error!(
                error = redact_error(&error, &id),
                "Unable to store rotated request"
            );
            audit.failure("database error");
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to update request",
            );
        }
    }
    audit.success(Fields::default());
    json_ok(&serde_json::json!({ "message": "public key updated" }))
}
