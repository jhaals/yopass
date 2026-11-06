//! Read receipts: access metadata that lives as long as its secret. A receipt
//! never contains secret content.

use super::{AppState, Key, client_ip, header_str, json_error, json_ok, no_store};
use crate::app::{App, RECEIPT_KEY_PREFIX, RECEIPT_TOKEN_HEADER};
use crate::audit::{Auditor, Fields};
use crate::db::{Abort, DbError, Secret};
use crate::util::{generate_token, now_unix, redact_error, seconds_until, token_matches_hash};
use axum::http::{StatusCode, request::Parts};
use axum::response::Response;
use serde::{Deserialize, Serialize};

const STATE_PENDING: &str = "pending";
const STATE_VIEWED: &str = "viewed";

#[derive(Serialize, Deserialize)]
struct Receipt {
    token_hash: String,
    state: String,
    one_time: bool,
    created_at: i64,
    #[serde(default, skip_serializing_if = "is_zero")]
    viewed_at: i64,
    expires_at: i64,
}

fn is_zero(value: &i64) -> bool {
    *value == 0
}

fn parse(secret: &Secret) -> Option<Receipt> {
    serde_json::from_str::<Receipt>(&secret.message)
        .ok()
        .filter(|receipt| !receipt.token_hash.is_empty())
}

/// Stores a pending receipt and returns its token. Callers store the secret
/// first, and the extra second covers `expires_at` truncating to whole seconds
/// while backends count from the moment of the write: a receipt must never lapse
/// before its secret, or a retrieval at the end of the lifetime goes unrecorded.
pub async fn create_receipt(
    app: &App,
    id: &str,
    one_time: bool,
    expiration: i32,
) -> Result<String, DbError> {
    let (token, token_hash) = generate_token();
    let now = now_unix();
    let ttl = i64::from(expiration) + 1;
    let receipt = Receipt {
        token_hash,
        state: STATE_PENDING.into(),
        one_time,
        created_at: now,
        viewed_at: 0,
        expires_at: now + ttl,
    };
    let message = serde_json::to_string(&receipt).map_err(|e| DbError::Backend(e.to_string()))?;
    let record = Secret {
        message,
        expiration: ttl.min(i64::from(i32::MAX)) as i32,
        ..Secret::default()
    };
    app.db
        .put(&format!("{RECEIPT_KEY_PREFIX}{id}"), &record)
        .await?;
    Ok(token)
}

/// Records authorized access, including on read-only instances. A missing,
/// invalid, expired or already viewed receipt is not an error.
pub async fn mark_receipt_viewed(app: &App, id: &str) -> Result<(), DbError> {
    let result = app
        .db
        .update(&format!("{RECEIPT_KEY_PREFIX}{id}"), &|record| {
            let unchanged = || DbError::Aborted(Abort::Unchanged);
            let mut receipt = parse(&record).ok_or_else(unchanged)?;
            // Computed once: a zero would persist an expired receipt forever.
            let ttl = seconds_until(receipt.expires_at);
            if ttl == 0 || receipt.state == STATE_VIEWED {
                return Err(unchanged());
            }
            receipt.state = STATE_VIEWED.into();
            receipt.viewed_at = now_unix();
            Ok(Secret {
                message: serde_json::to_string(&receipt)
                    .map_err(|e| DbError::Backend(e.to_string()))?,
                expiration: ttl,
                ..Secret::default()
            })
        })
        .await;
    match result {
        Err(DbError::Aborted(Abort::Unchanged) | DbError::NotFound) => Ok(()),
        other => other,
    }
}

/// Requires a receipt token. Identical 404s hide whether a receipt exists from
/// anyone holding only the secret ID.
pub async fn get_receipt(state: AppState, Key(id): Key, parts: Parts) -> Response {
    let app = state.0;
    let ip = client_ip(&app, &parts.headers, &parts.extensions);
    let mut audit = Auditor::new(app.audit(), "secret.receipt_checked", ip, None);
    audit.set_secret_id(&id);
    let not_found = |audit: &Auditor, reason| {
        audit.failure(reason);
        no_store(json_error(StatusCode::NOT_FOUND, "Receipt not found"))
    };

    let receipt = match app.db.status(&format!("{RECEIPT_KEY_PREFIX}{id}")).await {
        Ok(record) => parse(&record).filter(|r| seconds_until(r.expires_at) > 0),
        Err(DbError::NotFound) => None,
        Err(error) => {
            tracing::error!(
                error = redact_error(&error, &id),
                "Unable to load read receipt"
            );
            audit.failure("database error");
            return no_store(json_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Database temporarily unavailable",
            ));
        }
    };
    let Some(receipt) = receipt else {
        return not_found(&audit, "not found");
    };
    let token = header_str(&parts.headers, RECEIPT_TOKEN_HEADER);
    if !token_matches_hash(token, &receipt.token_hash) {
        audit.denied("invalid receipt token");
        return no_store(json_error(StatusCode::NOT_FOUND, "Receipt not found"));
    }

    audit.success(Fields::default());
    let mut response = serde_json::json!({
        "state": receipt.state,
        "one_time": receipt.one_time,
        "created_at": receipt.created_at,
        "expires_at": receipt.expires_at,
    });
    if receipt.viewed_at != 0 {
        response["viewed_at"] = receipt.viewed_at.into();
    }
    no_store(json_ok(&response))
}
