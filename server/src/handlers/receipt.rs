//! Read receipts: access metadata that lives as long as its secret. A receipt
//! never contains secret content.

use super::{AppState, Key, client_ip, header_str, json_error, json_ok, no_store};
use crate::app::RECEIPT_TOKEN_HEADER;
use crate::audit::{Auditor, Fields};
use crate::lifecycle;
use crate::util::token_matches_hash;
use axum::http::{StatusCode, request::Parts};
use axum::response::Response;

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
