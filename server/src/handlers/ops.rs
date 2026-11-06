//! Configuration, health, version, logo and static assets.

use super::{AppState, json_ok, not_found_page};
use crate::app::{DEFAULT_THEME_DARK, DEFAULT_THEME_LIGHT};
use crate::handlers::request::effective_request_file_size;
use crate::util::{expiration_in_seconds, format_size};
use axum::extract::Request;
use axum::http::header::{self, HeaderValue};
use axum::http::{Method, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use tower::ServiceExt;
use tower_http::services::{ServeDir, ServeFile};

pub async fn config(state: AppState) -> Response {
    let app = state.0;
    let s = &app.settings;
    let licensed = app.license.currently_valid();
    let mut config = Map::new();
    let mut set = |key: &str, value: Value| {
        config.insert(key.to_owned(), value);
    };
    set("ALLOW_CUSTOM_EXPIRATION", s.allow_custom_expiration.into());
    set("MIN_EXPIRATION", s.min_expiration.into());
    set("MAX_EXPIRATION", s.max_expiration.into());
    set("DISABLE_UPLOAD", s.disable_upload.into());
    set("READ_ONLY", s.read_only.into());
    set("PREFETCH_SECRET", s.prefetch_secret.into());
    set("DISABLE_FEATURES", s.disable_features.into());
    set("DISABLE_ONE_CLICK_LINK", s.disable_one_click_link.into());
    set("NO_LANGUAGE_SWITCHER", s.no_language_switcher.into());
    set("NO_THEME_SWITCHER", s.no_theme_switcher.into());
    set("FORCE_ONETIME_SECRETS", s.force_onetime_secrets.into());
    set("DEFAULT_ONETIME_SECRETS", s.default_onetime_secrets.into());
    set("DEFAULT_READ_RECEIPT", s.default_read_receipt.into());
    set(
        "DEFAULT_EXPIRY",
        expiration_in_seconds(&s.default_expiry).into(),
    );
    set("ARGON2", s.argon2.into());
    if !s.force_expiration.is_empty() {
        set(
            "FORCE_EXPIRATION",
            expiration_in_seconds(&s.force_expiration).into(),
        );
    }
    let max_file_size = app.effective_max_file_size();
    if max_file_size > 0 {
        set("MAX_FILE_SIZE", format_size(max_file_size).into());
    }
    for (key, value) in [
        ("PRIVACY_NOTICE_URL", &s.privacy_notice_url),
        ("IMPRINT_URL", &s.imprint_url),
        ("PUBLIC_URL", &s.public_url),
    ] {
        if !value.is_empty() {
            set(key, value.clone().into());
        }
    }
    set("OIDC_ENABLED", app.oidc_enabled().into());
    set(
        "REQUIRE_AUTH",
        (app.oidc_enabled() && s.require_auth).into(),
    );
    set("SECRET_REQUESTS", app.secret_requests_enabled().into());
    let draining = app.secret_request_routes_enabled() && !app.secret_requests_enabled();
    set("SECRET_REQUESTS_DRAINING", draining.into());
    if app.secret_request_routes_enabled() {
        set("MAX_REQUEST_NOTE_LENGTH", s.max_request_note_length.into());
        if !s.disable_upload {
            set(
                "MAX_REQUEST_FILE_SIZE",
                format_size(effective_request_file_size(&app)).into(),
            );
        }
    }
    // Only useful where secrets can be created.
    set(
        "READ_RECEIPTS",
        (app.read_receipts_enabled() && !s.read_only).into(),
    );

    if licensed {
        set("THEME_LIGHT", s.theme_light.clone().into());
        set("THEME_DARK", s.theme_dark.clone().into());
        for (key, raw) in [
            ("THEME_CUSTOM_LIGHT", &s.theme_custom_light),
            ("THEME_CUSTOM_DARK", &s.theme_custom_dark),
        ] {
            if let Ok(vars) = serde_json::from_str::<HashMap<String, String>>(raw) {
                set(key, json!(vars));
            }
        }
        if !s.logo_url.is_empty() {
            set("LOGO_URL", s.logo_url.clone().into());
        }
        if !s.app_name.is_empty() {
            set("APP_NAME", s.app_name.clone().into());
        }
        if s.hide_app_name {
            set("HIDE_APP_NAME", true.into());
        }
    } else {
        set("THEME_LIGHT", DEFAULT_THEME_LIGHT.into());
        set("THEME_DARK", DEFAULT_THEME_DARK.into());
    }

    let mut response = json_ok(&config);
    response.headers_mut().insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("content-type"),
    );
    response
}

fn uncached(mut response: Response) -> Response {
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-cache, no-store, must-revalidate"),
    );
    response
}

/// Liveness: the process is up.
pub async fn health() -> Response {
    uncached(json_ok(&json!({ "status": "healthy" })))
}

/// Readiness: the backends answer. The reason stays generic; details go to logs.
pub async fn ready(state: AppState) -> Response {
    let app = state.0;
    let not_ready = |reason: &str| {
        uncached(
            (
                StatusCode::SERVICE_UNAVAILABLE,
                axum::Json(json!({ "status": "not ready", "error": reason })),
            )
                .into_response(),
        )
    };
    if let Err(error) = app.db.health().await {
        tracing::debug!(error = %error, "Readiness check failed");
        return not_ready("database connectivity failed");
    }
    if let Some(files) = &app.files
        && let Err(error) = files.health().await
    {
        tracing::debug!(error = %error, "Readiness check failed: file store");
        return not_ready("file store connectivity failed");
    }
    uncached(json_ok(&json!({ "status": "ready" })))
}

pub async fn version(state: AppState) -> Response {
    let version = &state.0.settings.version;
    let version = if version.is_empty() {
        "unknown"
    } else {
        version
    };
    json_ok(&json!({ "version": version }))
}

pub async fn logo(state: AppState, request: Request) -> Response {
    let asset_path = &state.0.settings.asset_path;
    if asset_path.is_empty() {
        return not_found_page();
    }
    let file = ServeFile::new(std::path::Path::new(asset_path).join("yopass.svg"));
    match file.oneshot(request).await {
        Ok(response) => response.into_response(),
        Err(never) => match never {},
    }
}

/// An empty asset path serves nothing: it must never mean the working directory.
pub async fn static_files(state: AppState, request: Request) -> Response {
    let asset_path = &state.0.settings.asset_path;
    if asset_path.is_empty() || !matches!(*request.method(), Method::GET | Method::HEAD) {
        return not_found_page();
    }
    match ServeDir::new(asset_path).oneshot(request).await {
        Ok(response) if response.status() == StatusCode::NOT_FOUND => not_found_page(),
        Ok(response) => response.into_response(),
        Err(never) => match never {},
    }
}
