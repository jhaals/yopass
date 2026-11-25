//! Read receipts: access metadata that lives as long as its secret. A receipt
//! never contains secret content.

use super::{AppState, Key, client_ip, gate_session, header_str, json_error, json_ok, no_store};
use crate::app::RECEIPT_TOKEN_HEADER;
use crate::audit::{Auditor, Fields};
use crate::lifecycle;
use crate::util::token_matches_hash;
use axum::http::{StatusCode, request::Parts};
use axum::response::Response;

/// Stands in for the stored hash when there is no receipt, so the presented
/// token is hashed either way. It is never the basis of an answer.
const NO_RECEIPT_HASH: &str = "0000000000000000000000000000000000000000000000000000000000000000";

/// Requires a receipt token. Identical 404s hide whether a receipt exists from
/// anyone holding only the secret ID.
pub async fn get_receipt(state: AppState, Key(id): Key, parts: Parts) -> Response {
    let app = state.0;
    let ip = client_ip(&app, &parts.headers, &parts.extensions);
    let mut audit = Auditor::new(
        app.audit(),
        "secret.receipt_checked",
        ip,
        gate_session(&parts),
    );
    audit.set_secret_id(&id);
    let not_found = |audit: &Auditor, reason| {
        audit.failure(reason);
        no_store(json_error(StatusCode::NOT_FOUND, "Receipt not found"))
    };

    let receipt = match lifecycle::receipt(&app, &id).await {
        Ok(receipt) => receipt,
        Err(lifecycle::ReceiptLookupFailed) => {
            audit.failure("database error");
            return no_store(json_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Database temporarily unavailable",
            ));
        }
    };
    // The caller chooses the token's length, so hashing it only when a receipt
    // exists would tell the two 404s apart by their response time.
    let token = header_str(&parts.headers, RECEIPT_TOKEN_HEADER);
    let stored_hash = receipt
        .as_ref()
        .map_or(NO_RECEIPT_HASH, |r| r.token_hash.as_str());
    let token_valid = std::hint::black_box(token_matches_hash(token, stored_hash));
    let Some(receipt) = receipt else {
        return not_found(&audit, "not found");
    };
    if !token_valid {
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
    // The token holder is the creator, who named the recipient themselves.
    if let Some(email) = receipt
        .viewer
        .as_deref()
        .and_then(|sealed| app.open_viewer(&id, sealed))
    {
        response["viewer_email"] = email.into();
    }
    if let Some(method) = &receipt.access_method {
        response["access_method"] = method.clone().into();
    }
    no_store(json_ok(&response))
}
