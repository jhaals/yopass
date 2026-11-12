//! Command line flags and environment variables. Names match the Go server, so an
//! existing deployment's settings carry over. Features yopass-next does not have
//! yet fail startup rather than being silently ignored.

use crate::app::{
    DEFAULT_THEME_DARK, DEFAULT_THEME_LIGHT, Settings, TrustedProxy, UNLICENSED_MAX_FILE_SIZE,
};
use crate::auth::parse_api_tokens;
use crate::db::memcached::memcached_expiration;
use crate::handlers::request::MAX_NOTE_LENGTH_CAP;
use crate::license::License;
use crate::util::{
    is_preset_expiration, now_unix, parse_expiration_duration, parse_size, preset_expiration,
};
use clap::{CommandFactory, FromArgMatches, Parser};
use std::collections::HashMap;
use std::time::Duration;

/// Same grammar as Go's strconv.ParseBool: a typo must not silently mean false.
fn parse_bool(value: &str) -> Result<bool, String> {
    match value {
        "1" | "t" | "T" | "TRUE" | "true" | "True" => Ok(true),
        "0" | "f" | "F" | "FALSE" | "false" | "False" => Ok(false),
        _ => Err("expected true or false".into()),
    }
}

/// `30s`, `5m`, `1h30m` or `0`. A bare number other than 0 has no unit and is refused.
fn parse_timeout(value: &str) -> Result<Duration, String> {
    if value == "0" {
        return Ok(Duration::ZERO);
    }
    let invalid = || "use a duration with a unit (e.g. 30s, 5m, or 1h), or 0".to_owned();
    if value.is_empty() {
        return Err(invalid());
    }
    let (mut total, mut rest) = (0u64, value);
    while !rest.is_empty() {
        let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
        let amount: u64 = rest[..digits].parse().map_err(|_| invalid())?;
        let unit = &rest[digits..];
        let (seconds, length) = if unit.starts_with('h') {
            (3600, 1)
        } else if unit.starts_with('m') {
            (60, 1)
        } else if unit.starts_with('s') {
            (1, 1)
        } else {
            return Err(invalid());
        };
        total = amount
            .checked_mul(seconds)
            .and_then(|s| total.checked_add(s))
            .ok_or_else(invalid)?;
        rest = &unit[length..];
    }
    Ok(Duration::from_secs(total))
}

#[derive(Parser, Clone)]
#[command(
    name = "yopass-server",
    about = "Yopass server (yopass-next alpha)",
    disable_version_flag = true
)]
pub struct Config {
    /// Listen address (default 0.0.0.0)
    #[arg(long, env = "ADDRESS", default_value = "")]
    pub address: String,
    /// Listen port
    #[arg(long, env = "PORT", default_value_t = 1337)]
    pub port: u16,
    /// Database backend ('memcached' or 'redis')
    #[arg(long, env = "DATABASE", default_value = "memcached")]
    pub database: String,
    /// Path to the assets folder
    #[arg(long, env = "ASSET_PATH", default_value = "public")]
    pub asset_path: String,
    /// Max length of encrypted secret
    #[arg(long, env = "MAX_LENGTH", default_value_t = 10000)]
    pub max_length: u64,
    /// Max file upload size (e.g. 10KB, 512KB, 1MB); capped at 1MB without a license key
    #[arg(long, env = "MAX_FILE_SIZE", default_value = "512KB")]
    pub max_file_size: String,
    /// Memcached address
    #[arg(long, env = "MEMCACHED", default_value = "localhost:11211")]
    pub memcached: String,
    /// Metrics server listen port
    #[arg(long, env = "METRICS_PORT", default_value_t = -1, allow_negative_numbers = true)]
    pub metrics_port: i32,
    /// Maximum duration for non-file request reads, with a unit (0 disables)
    #[arg(long, env = "REQUEST_TIMEOUT", default_value = "30s", value_parser = parse_timeout)]
    pub request_timeout: Duration,
    /// Maximum duration for file transfers, with a unit (0 uses request-timeout)
    #[arg(long, env = "FILE_TRANSFER_TIMEOUT", default_value = "5m", value_parser = parse_timeout)]
    pub file_transfer_timeout: Duration,
    /// Redis or Valkey URL
    #[arg(
        long,
        env = "REDIS",
        default_value = "redis://localhost:6379/0",
        hide_env_values = true,
        hide_default_value = true
    )]
    pub redis: String,
    /// Path to TLS certificate
    #[arg(long, env = "TLS_CERT", default_value = "")]
    pub tls_cert: String,
    /// Path to TLS key
    #[arg(long, env = "TLS_KEY", default_value = "")]
    pub tls_key: String,
    /// Reject non one-time secrets from being created
    #[arg(long, env = "FORCE_ONETIME_SECRETS", default_value = "false", default_missing_value = "true", num_args = 0..=1, require_equals = true, value_parser = parse_bool)]
    pub force_onetime_secrets: bool,
    /// Check one-time download by default on the forms
    #[arg(long, env = "DEFAULT_ONETIME_SECRETS", default_value = "true", default_missing_value = "true", num_args = 0..=1, require_equals = true, value_parser = parse_bool)]
    pub default_onetime_secrets: bool,
    /// Check read receipt by default on the forms when read receipts are enabled
    #[arg(long, env = "DEFAULT_READ_RECEIPT", default_value = "false", default_missing_value = "true", num_args = 0..=1, require_equals = true, value_parser = parse_bool)]
    pub default_read_receipt: bool,
    /// Use Argon2 for password key derivation when encrypting new secrets
    #[arg(long, env = "ARGON2", default_value = "false", default_missing_value = "true", num_args = 0..=1, require_equals = true, value_parser = parse_bool)]
    pub argon2: bool,
    /// Access-Control-Allow-Origin
    #[arg(long, env = "CORS_ALLOW_ORIGIN", default_value = "*")]
    pub cors_allow_origin: String,
    /// Disable the /file upload endpoints
    #[arg(long, env = "DISABLE_UPLOAD", default_value = "false", default_missing_value = "true", num_args = 0..=1, require_equals = true, value_parser = parse_bool)]
    pub disable_upload: bool,
    /// Disable all secret creation endpoints (retrieval-only mode)
    #[arg(long, env = "READ_ONLY", default_value = "false", default_missing_value = "true", num_args = 0..=1, require_equals = true, value_parser = parse_bool)]
    pub read_only: bool,
    /// Display information that the secret might be one time use
    #[arg(long, env = "PREFETCH_SECRET", default_value = "true", default_missing_value = "true", num_args = 0..=1, require_equals = true, value_parser = parse_bool)]
    pub prefetch_secret: bool,
    /// Disable features
    #[arg(long, env = "DISABLE_FEATURES", default_value = "false", default_missing_value = "true", num_args = 0..=1, require_equals = true, value_parser = parse_bool)]
    pub disable_features: bool,
    /// Hide the combined one-click link in the UI
    #[arg(long, env = "DISABLE_ONE_CLICK_LINK", default_value = "false", default_missing_value = "true", num_args = 0..=1, require_equals = true, value_parser = parse_bool)]
    pub disable_one_click_link: bool,
    /// Disable the language switcher in the UI
    #[arg(long, env = "NO_LANGUAGE_SWITCHER", default_value = "false", default_missing_value = "true", num_args = 0..=1, require_equals = true, value_parser = parse_bool)]
    pub no_language_switcher: bool,
    /// Hide the theme switcher and always use the light theme
    #[arg(long, env = "NO_THEME_SWITCHER", default_value = "false", default_missing_value = "true", num_args = 0..=1, require_equals = true, value_parser = parse_bool)]
    pub no_theme_switcher: bool,
    /// Trusted proxy IP addresses or CIDR blocks for X-Forwarded-For validation
    #[arg(long, env = "TRUSTED_PROXIES", value_delimiter = ',')]
    pub trusted_proxies: Vec<String>,
    /// URL to privacy notice page
    #[arg(long, env = "PRIVACY_NOTICE_URL", default_value = "")]
    pub privacy_notice_url: String,
    /// URL to imprint/legal notice page
    #[arg(long, env = "IMPRINT_URL", default_value = "")]
    pub imprint_url: String,
    /// Base URL of the public/read-only instance used in generated secret links
    #[arg(long, env = "PUBLIC_URL", default_value = "")]
    pub public_url: String,
    /// Allow user-entered expiration durations within configured bounds
    #[arg(long, env = "ALLOW_CUSTOM_EXPIRATION", default_value = "false", default_missing_value = "true", num_args = 0..=1, require_equals = true, value_parser = parse_bool)]
    pub allow_custom_expiration: bool,
    /// Minimum custom expiration (integer s, m, h, d, w units)
    #[arg(long, env = "MIN_EXPIRATION", default_value = "1m")]
    pub min_expiration: String,
    /// Maximum custom expiration (integer s, m, h, d, w units)
    #[arg(long, env = "MAX_EXPIRATION", default_value = "90d")]
    pub max_expiration: String,
    /// Default expiry [1h, 1d, 1w]; custom durations require --allow-custom-expiration
    #[arg(long, env = "DEFAULT_EXPIRY", default_value = "1h")]
    pub default_expiry: String,
    /// Force secrets, uploads, and requests to this duration
    #[arg(long, env = "FORCE_EXPIRATION", default_value = "")]
    pub force_expiration: String,
    /// DaisyUI theme name for light mode
    #[arg(long, env = "THEME_LIGHT", default_value = DEFAULT_THEME_LIGHT)]
    pub theme_light: String,
    /// DaisyUI theme name for dark mode
    #[arg(long, env = "THEME_DARK", default_value = DEFAULT_THEME_DARK)]
    pub theme_dark: String,
    /// JSON object of CSS variables for a custom light theme
    #[arg(long, env = "THEME_CUSTOM_LIGHT", default_value = "")]
    pub theme_custom_light: String,
    /// JSON object of CSS variables for a custom dark theme
    #[arg(long, env = "THEME_CUSTOM_DARK", default_value = "")]
    pub theme_custom_dark: String,
    /// Custom application name shown in the UI
    #[arg(long, env = "APP_NAME", default_value = "")]
    pub app_name: String,
    /// Hide the application name in the navbar
    #[arg(long, env = "HIDE_APP_NAME", default_value = "false", default_missing_value = "true", num_args = 0..=1, require_equals = true, value_parser = parse_bool)]
    pub hide_app_name: bool,
    /// URL to a logo image
    #[arg(long, env = "LOGO_URL", default_value = "")]
    pub logo_url: String,
    /// JWT license key for premium features
    #[arg(long, env = "LICENSE_KEY", default_value = "", hide_env_values = true)]
    pub license_key: String,
    /// File store backend for large files ('disk' or 's3'), defaults to database storage
    #[arg(long, env = "FILE_STORE", default_value = "")]
    pub file_store: String,
    /// Base path for disk file store
    #[arg(long, env = "FILE_STORE_PATH", default_value = "/tmp/yopass-files")]
    pub file_store_path: String,
    /// S3 bucket name for file store
    #[arg(long, env = "FILE_STORE_S3_BUCKET", default_value = "")]
    pub file_store_s3_bucket: String,
    /// S3 key prefix for file store
    #[arg(long, env = "FILE_STORE_S3_PREFIX", default_value = "yopass/")]
    pub file_store_s3_prefix: String,
    /// S3 endpoint URL (for MinIO/compatible)
    #[arg(long, env = "FILE_STORE_S3_ENDPOINT", default_value = "")]
    pub file_store_s3_endpoint: String,
    /// S3 region
    #[arg(long, env = "FILE_STORE_S3_REGION", default_value = "us-east-1")]
    pub file_store_s3_region: String,
    /// File cleanup interval in seconds
    #[arg(long, env = "CLEANUP_INTERVAL", default_value_t = 60)]
    pub cleanup_interval: u64,
    /// Disable the file store cleanup task
    #[arg(long, env = "DISABLE_FILE_CLEANUP", default_value = "false", default_missing_value = "true", num_args = 0..=1, require_equals = true, value_parser = parse_bool)]
    pub disable_file_cleanup: bool,
    /// Perform health check and exit
    #[arg(long, env = "HEALTH_CHECK", default_value = "false", default_missing_value = "true", num_args = 0..=1, require_equals = true, value_parser = parse_bool)]
    pub health_check: bool,
    /// OIDC issuer URL
    #[arg(long, env = "OIDC_ISSUER", default_value = "")]
    pub oidc_issuer: String,
    /// OIDC OAuth2 client ID
    #[arg(long, env = "OIDC_CLIENT_ID", default_value = "")]
    pub oidc_client_id: String,
    /// OIDC OAuth2 client secret
    #[arg(
        long,
        env = "OIDC_CLIENT_SECRET",
        default_value = "",
        hide_env_values = true
    )]
    pub oidc_client_secret: String,
    /// OIDC callback URL
    #[arg(long, env = "OIDC_REDIRECT_URL", default_value = "")]
    pub oidc_redirect_url: String,
    /// Require authentication to create secrets
    #[arg(long, env = "REQUIRE_AUTH", default_value = "false", default_missing_value = "true", num_args = 0..=1, require_equals = true, value_parser = parse_bool)]
    pub require_auth: bool,
    /// Require authentication for every user operation (creating, viewing, deleting, receipts, request management) except providing a secret for a secret request; implies --require-auth
    #[arg(long, env = "REQUIRE_AUTH_ALL", default_value = "false", default_missing_value = "true", num_args = 0..=1, require_equals = true, value_parser = parse_bool)]
    pub require_auth_all: bool,
    /// Require email_verified=true for OIDC logins
    #[arg(long, env = "OIDC_REQUIRE_VERIFIED_EMAIL", default_value = "true", default_missing_value = "true", num_args = 0..=1, require_equals = true, value_parser = parse_bool)]
    pub oidc_require_verified_email: bool,
    /// 64-byte hex-encoded session key for multi-instance deployments
    #[arg(
        long,
        env = "OIDC_SESSION_KEY",
        default_value = "",
        hide_env_values = true
    )]
    pub oidc_session_key: String,
    /// Restrict OIDC logins and authenticated access to these email domains
    #[arg(long, env = "OIDC_ALLOWED_DOMAINS", value_delimiter = ',')]
    pub oidc_allowed_domains: Vec<String>,
    /// Static bearer token for machine clients, formatted as name:secret
    #[arg(long, env = "API_TOKEN", value_delimiter = ',', hide_env_values = true)]
    pub api_token: Vec<String>,
    /// Frontend base URL for post-login redirect in split deployments
    #[arg(long, env = "FRONTEND_URL", default_value = "")]
    pub frontend_url: String,
    /// Enable structured audit logging to NDJSON (requires valid license)
    #[arg(long, env = "AUDIT_LOG", default_value = "false", default_missing_value = "true", num_args = 0..=1, require_equals = true, value_parser = parse_bool)]
    pub audit_log: bool,
    /// File path for audit log output (default: stdout)
    #[arg(long, env = "AUDIT_LOG_FILE", default_value = "")]
    pub audit_log_file: String,
    /// Disable the secret request feature
    #[arg(long, env = "DISABLE_SECRET_REQUESTS", default_value = "false", default_missing_value = "true", num_args = 0..=1, require_equals = true, value_parser = parse_bool)]
    pub disable_secret_requests: bool,
    /// Max characters in the optional, unencrypted note on a secret request
    #[arg(long, env = "MAX_REQUEST_NOTE_LENGTH", default_value_t = 1000)]
    pub max_request_note_length: usize,
    /// URL receiving webhook notifications; requires a valid license
    #[arg(long, env = "WEBHOOK_URL", default_value = "", hide_env_values = true)]
    pub webhook_url: String,
    /// HMAC-SHA256 key used to sign webhook payloads
    #[arg(
        long,
        env = "WEBHOOK_SECRET",
        default_value = "",
        hide_env_values = true
    )]
    pub webhook_secret: String,
    /// Disable the read receipt feature
    #[arg(long, env = "DISABLE_READ_RECEIPTS", default_value = "false", default_missing_value = "true", num_args = 0..=1, require_equals = true, value_parser = parse_bool)]
    pub disable_read_receipts: bool,
    /// Log level
    #[arg(long, env = "LOG_LEVEL", default_value = "info")]
    pub log_level: String,
}

impl Config {
    /// Whether creation requires authentication; `--require-auth-all` implies it.
    pub fn creation_requires_auth(&self) -> bool {
        self.require_auth || self.require_auth_all
    }

    /// Parses flags and environment. An empty variable counts as unset, as with
    /// the Go server, so `DISABLE_UPLOAD=` does not fail or flip a default.
    pub fn parse_env_and_args() -> Self {
        let command = Self::command().mut_args(|arg| {
            let empty = arg
                .get_env()
                .and_then(std::env::var_os)
                .is_some_and(|value| value.is_empty());
            if empty { arg.env(None) } else { arg }
        });
        let matches = command.get_matches();
        Self::from_arg_matches(&matches).unwrap_or_else(|error| error.exit())
    }

    /// Checks flag values and cross-flag requirements. An expired license
    /// degrades gracefully; only an absent or forged key makes business flags fatal.
    pub fn validate(&self, license: &License) -> Result<(), String> {
        let no_license = !license.currently_valid() && !license.expired();
        validate_expiration_settings(
            self.allow_custom_expiration,
            &self.min_expiration,
            &self.max_expiration,
            &self.default_expiry,
            &self.force_expiration,
            &self.database,
        )?;
        for (name, value) in [
            ("theme-light", &self.theme_light),
            ("theme-dark", &self.theme_dark),
        ] {
            if value == "custom-light" || value == "custom-dark" {
                return Err(format!(
                    "--{name} must not be set to the reserved name {value:?}"
                ));
            }
        }
        for (name, raw) in [
            ("theme-custom-light", &self.theme_custom_light),
            ("theme-custom-dark", &self.theme_custom_dark),
        ] {
            if raw.is_empty() {
                continue;
            }
            let vars: HashMap<String, String> =
                serde_json::from_str(raw).map_err(|e| format!("invalid JSON for --{name}: {e}"))?;
            for (key, value) in vars {
                if !key.starts_with("--") {
                    return Err(format!(
                        "--{name} contains invalid CSS variable key {key:?} (must start with --)"
                    ));
                }
                let unsafe_char = |c| matches!(c, ';' | '{' | '}' | '<' | '>');
                if key.contains(unsafe_char) || value.contains(unsafe_char) {
                    return Err(format!(
                        "--{name} contains invalid CSS variable {key:?} (keys and values must not contain ; {{ }} < >)"
                    ));
                }
            }
        }
        if !self.oidc_issuer.is_empty() && no_license {
            return Err("--oidc-issuer is configured but no valid license key was provided: refusing to start without authentication (provide --license-key or remove --oidc-issuer)".into());
        }
        if self.creation_requires_auth() && (self.oidc_issuer.is_empty() || no_license) {
            return Err("--require-auth or --require-auth-all is set but OIDC is not configured (check --oidc-issuer and --license-key)".into());
        }
        // Rejected rather than silently removing the allow-list.
        if std::env::var_os("OIDC_ALLOWED_DOMAIN").is_some_and(|v| !v.is_empty()) {
            return Err(
                "OIDC_ALLOWED_DOMAIN was renamed; use OIDC_ALLOWED_DOMAINS to restrict OIDC logins"
                    .into(),
            );
        }
        if !self.oidc_session_key.is_empty() {
            if self.oidc_session_key.len() != 128 {
                return Err("--oidc-session-key must be exactly 128 hex characters; generate with: openssl rand -hex 64".into());
            }
            if hex::decode(&self.oidc_session_key).is_err() {
                return Err("--oidc-session-key is 128 characters but not valid hex; generate with: openssl rand -hex 64".into());
            }
        }
        if self.audit_log && no_license {
            return Err("--audit-log requires a valid license key".into());
        }
        if !self.webhook_url.is_empty() && no_license {
            return Err("--webhook-url requires a valid license key".into());
        }
        if !self.webhook_secret.is_empty() && self.webhook_url.is_empty() {
            return Err("--webhook-secret is set but --webhook-url is not".into());
        }
        if !self.oidc_issuer.is_empty() && !self.oidc_require_verified_email {
            tracing::warn!(
                "OIDC email verification disabled: trusting provider email assertions without verification"
            );
        }
        if self.max_request_note_length > MAX_NOTE_LENGTH_CAP {
            return Err(format!(
                "--max-request-note-length must be an integer between 0 and {MAX_NOTE_LENGTH_CAP}"
            ));
        }
        if !matches!(self.database.as_str(), "memcached" | "redis") {
            return Err(format!(
                "unsupported database, expected 'memcached' or 'redis' got '{}'",
                self.database
            ));
        }
        match self.file_store.as_str() {
            "" | "disk" => {}
            "s3" if self.file_store_s3_bucket.is_empty() => {
                return Err("file-store-s3-bucket is required when file-store=s3".into());
            }
            "s3" => {
                let endpoint = &self.file_store_s3_endpoint;
                let valid = endpoint.is_empty()
                    || url::Url::parse(endpoint).is_ok_and(|url| {
                        matches!(url.scheme(), "http" | "https") && url.has_host()
                    });
                if !valid {
                    return Err("--file-store-s3-endpoint must be an absolute http(s) URL".into());
                }
            }
            other => {
                return Err(format!(
                    "unsupported file-store backend: {other} (expected 'disk' or 's3')"
                ));
            }
        }
        if self.tls_cert.is_empty() != self.tls_key.is_empty() {
            return Err("--tls-cert and --tls-key must be set together".into());
        }
        Ok(())
    }

    /// The size limit after the unlicensed cap.
    pub fn resolve_max_file_size(&self, license_valid: bool) -> Result<u64, String> {
        let size = parse_size(&self.max_file_size).map_err(|e| {
            format!(
                "invalid --max-file-size value {:?}: {e}",
                self.max_file_size
            )
        })?;
        if !license_valid && (size == 0 || size > UNLICENSED_MAX_FILE_SIZE) {
            tracing::warn!(
                requested = self.max_file_size,
                "--max-file-size exceeds 1MB cap, capping to 1MB (a valid license removes this limit)"
            );
            return Ok(UNLICENSED_MAX_FILE_SIZE);
        }
        Ok(size)
    }

    pub fn settings(&self, license: &License) -> Result<Settings, String> {
        let list = |values: &[String]| -> Vec<String> {
            values
                .iter()
                .map(|v| v.trim().to_owned())
                .filter(|v| !v.is_empty())
                .collect()
        };
        let mut trusted_proxies = Vec::new();
        for proxy in list(&self.trusted_proxies) {
            // A typo must not quietly widen or disable proxy trust.
            trusted_proxies.push(
                TrustedProxy::parse(&proxy).ok_or_else(|| format!("invalid --trusted-proxies entry {proxy:?}: expected an IP address or CIDR block"))?,
            );
        }
        let api_tokens = parse_api_tokens(&list(&self.api_token))
            .map_err(|e| format!("invalid --api-token: {e}"))?;
        if !api_tokens.is_empty() && !self.creation_requires_auth() {
            return Err("--api-token is set but neither --require-auth nor --require-auth-all is: API tokens only apply when creation requires authentication".into());
        }
        let positive = |d: Duration| (!d.is_zero()).then_some(d);
        let request_timeout = positive(self.request_timeout);
        Ok(Settings {
            max_length: self.max_length,
            max_file_size: self.resolve_max_file_size(license.currently_valid())?,
            max_request_note_length: self.max_request_note_length,
            force_onetime_secrets: self.force_onetime_secrets,
            default_onetime_secrets: self.default_onetime_secrets,
            default_read_receipt: self.default_read_receipt,
            asset_path: self.asset_path.clone(),
            trusted_proxies,
            version: option_env!("YOPASS_VERSION")
                .unwrap_or(env!("CARGO_PKG_VERSION"))
                .to_owned(),
            request_timeout,
            file_transfer_timeout: positive(self.file_transfer_timeout).or(request_timeout),
            argon2: self.argon2,
            read_only: self.read_only,
            disable_upload: self.disable_upload,
            prefetch_secret: self.prefetch_secret,
            disable_features: self.disable_features,
            disable_one_click_link: self.disable_one_click_link,
            no_language_switcher: self.no_language_switcher,
            no_theme_switcher: self.no_theme_switcher,
            disable_secret_requests: self.disable_secret_requests,
            disable_read_receipts: self.disable_read_receipts,
            allow_unverified_email: !self.oidc_require_verified_email,
            require_auth: self.creation_requires_auth(),
            require_auth_all: self.require_auth_all,
            allowed_email_domains: list(&self.oidc_allowed_domains),
            api_tokens,
            cors_allow_origin: self.cors_allow_origin.clone(),
            frontend_url: self.frontend_url.clone(),
            privacy_notice_url: self.privacy_notice_url.clone(),
            imprint_url: self.imprint_url.clone(),
            public_url: self.public_url.clone(),
            logo_url: self.logo_url.clone(),
            app_name: self.app_name.clone(),
            hide_app_name: self.hide_app_name,
            theme_light: self.theme_light.clone(),
            theme_dark: self.theme_dark.clone(),
            theme_custom_light: self.theme_custom_light.clone(),
            theme_custom_dark: self.theme_custom_dark.clone(),
            default_expiry: self.default_expiry.clone(),
            allow_custom_expiration: self.allow_custom_expiration,
            min_expiration: parse_expiration_duration(&self.min_expiration).unwrap_or(60),
            max_expiration: parse_expiration_duration(&self.max_expiration).unwrap_or(90 * 86400),
            force_expiration: self.force_expiration.clone(),
        })
    }
}

/// Checks duration syntax, policy consistency, and Memcached's timestamp limit.
pub fn validate_expiration_settings(
    allow: bool,
    min: &str,
    max: &str,
    default_expiry: &str,
    forced: &str,
    database: &str,
) -> Result<(), String> {
    let min_seconds = parse_expiration_duration(min).ok_or_else(|| {
        format!("invalid --min-expiration {min:?}: use a positive integer duration (e.g. 1m)")
    })?;
    let max_seconds = parse_expiration_duration(max).ok_or_else(|| {
        format!("invalid --max-expiration {max:?}: use a positive integer duration (e.g. 90d)")
    })?;
    if min_seconds > max_seconds {
        return Err("--min-expiration must not exceed --max-expiration".into());
    }
    for (name, value) in [
        ("default-expiry", default_expiry),
        ("force-expiration", forced),
    ] {
        if value.is_empty() {
            continue;
        }
        let seconds = parse_expiration_duration(value);
        let accepted = if allow {
            seconds.is_some_and(|s| s >= min_seconds && s <= max_seconds)
        } else {
            preset_expiration(value).is_some() && seconds.is_some_and(is_preset_expiration)
        };
        if !accepted {
            return Err(if allow {
                format!(
                    "--{name} must be a positive duration between --min-expiration and --max-expiration"
                )
            } else {
                format!("invalid --{name} value {value:?}, expected one of: 1h, 1d, 1w")
            });
        }
    }
    if allow && database == "memcached" && memcached_expiration(max_seconds, now_unix()).is_err() {
        return Err("--max-expiration exceeds Memcached's timestamp limit".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(args: &[&str]) -> Config {
        let mut full = vec!["yopass-server"];
        full.extend_from_slice(args);
        Config::parse_from(full)
    }

    #[test]
    fn booleans_use_the_strict_grammar() {
        assert!(config(&["--read-only"]).read_only);
        assert!(config(&["--read-only=true"]).read_only);
        assert!(!config(&["--read-only=0"]).read_only);
        assert!(!config(&[]).read_only);
        assert!(config(&[]).prefetch_secret);
        assert!(!config(&["--prefetch-secret=false"]).prefetch_secret);
        for bad in ["yes", "on", "tru", ""] {
            let arg = format!("--read-only={bad}");
            assert!(
                Config::try_parse_from(["yopass-server", arg.as_str()]).is_err(),
                "{bad}"
            );
        }
    }

    #[test]
    fn timeouts_need_a_unit() {
        assert_eq!(parse_timeout("30s"), Ok(Duration::from_secs(30)));
        assert_eq!(parse_timeout("1h30m"), Ok(Duration::from_secs(5400)));
        assert_eq!(parse_timeout("0"), Ok(Duration::ZERO));
        for bad in ["", "30", "s", "-5s", "1d", "1.5s", "99999999999999999999h"] {
            assert!(parse_timeout(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn expiration_settings() {
        let check = |allow, min, max, default, forced| {
            validate_expiration_settings(allow, min, max, default, forced, "redis")
        };
        assert!(check(false, "1m", "90d", "1h", "").is_ok());
        assert!(check(false, "1m", "90d", "1w", "1d").is_ok());
        assert!(check(false, "1m", "90d", "2h", "").is_err());
        assert!(check(false, "1m", "90d", "1h", "2h").is_err());
        assert!(check(true, "1m", "90d", "2h", "3d").is_ok());
        assert!(check(true, "1h", "1m", "1h", "").is_err());
        assert!(check(true, "1m", "1h", "2h", "").is_err());
        assert!(check(true, "bad", "1h", "1h", "").is_err());
        assert!(check(true, "1m", "bad", "1h", "").is_err());
        assert!(validate_expiration_settings(true, "1m", "4000w", "1h", "", "memcached").is_err());
        // Representable as a lifetime, but past Memcached's absolute timestamp range.
        let error = validate_expiration_settings(true, "1m", "1000w", "1h", "", "memcached");
        assert_eq!(
            error.unwrap_err(),
            "--max-expiration exceeds Memcached's timestamp limit"
        );
        assert!(
            check(true, "1m", "1000w", "1h", "").is_ok(),
            "Redis has no such limit"
        );
    }

    fn valid_license() -> License {
        License::valid_until(now_unix() + 3600)
    }

    fn expired_license() -> License {
        License {
            valid: false,
            expires_at: Some(now_unix() - 10),
            licensee: String::new(),
        }
    }

    #[test]
    fn business_flags_need_a_license_but_survive_expiry() {
        for args in [
            vec!["--audit-log"],
            vec!["--webhook-url=https://example.com"],
            vec!["--oidc-issuer=https://id.example.com"],
        ] {
            let cfg = config(&args);
            assert!(cfg.validate(&License::default()).is_err(), "{args:?}");
            assert!(cfg.validate(&valid_license()).is_ok(), "{args:?}");
            assert!(cfg.validate(&expired_license()).is_ok(), "{args:?}");
        }
        assert!(
            config(&["--require-auth"])
                .validate(&valid_license())
                .is_err()
        );
    }

    #[test]
    fn s3_needs_a_bucket_and_an_absolute_endpoint() {
        let license = License::default();
        let check = |args: &[&str]| config(args).validate(&license);
        assert!(check(&["--file-store=s3", "--file-store-s3-bucket=b"]).is_ok());
        for endpoint in ["http://minio:9000", "https://s3.example.com/"] {
            let flag = format!("--file-store-s3-endpoint={endpoint}");
            assert!(check(&["--file-store=s3", "--file-store-s3-bucket=b", &flag]).is_ok());
        }
        for endpoint in ["minio:9000", "ftp://minio", "http://", "/path"] {
            let flag = format!("--file-store-s3-endpoint={endpoint}");
            let error = check(&["--file-store=s3", "--file-store-s3-bucket=b", &flag]).unwrap_err();
            assert!(
                error.contains("absolute http(s) URL"),
                "{endpoint}: {error}"
            );
        }
        let error = check(&["--file-store=s3"]).unwrap_err();
        assert_eq!(error, "file-store-s3-bucket is required when file-store=s3");
        let defaults = config(&[]);
        assert_eq!(defaults.file_store_s3_prefix, "yopass/");
        assert_eq!(defaults.file_store_s3_region, "us-east-1");
    }

    #[test]
    fn unsupported_or_inconsistent_settings_fail_closed() {
        let license = License::default();
        for args in [
            vec!["--file-store=s3"],
            vec!["--file-store=ftp"],
            vec!["--database=sqlite"],
            vec!["--webhook-secret=abc"],
            vec!["--tls-cert=/x"],
            vec!["--max-request-note-length=10001"],
            vec!["--oidc-session-key=abc"],
            vec!["--theme-light=custom-light"],
            vec!["--theme-custom-light={bad"],
            vec![r#"--theme-custom-dark={"color":"red"}"#],
            vec![r#"--theme-custom-dark={"--x":"red;}"}"#],
        ] {
            assert!(config(&args).validate(&license).is_err(), "{args:?}");
        }
        let key = format!("--oidc-session-key={}", "z".repeat(128));
        assert!(config(&[key.as_str()]).validate(&license).is_err());
        assert!(
            config(&["--trusted-proxies=not-an-ip"])
                .settings(&license)
                .is_err()
        );
        assert!(
            config(&["--api-token=ci:0123456789abcdef"])
                .settings(&license)
                .is_err()
        );
        assert!(
            config(&["--max-file-size=huge"])
                .settings(&license)
                .is_err()
        );
    }

    #[test]
    fn unlicensed_file_size_is_capped() {
        let cfg = config(&["--max-file-size=10MB"]);
        assert_eq!(
            cfg.settings(&License::default()).unwrap().max_file_size,
            UNLICENSED_MAX_FILE_SIZE
        );
        assert_eq!(
            cfg.settings(&valid_license()).unwrap().max_file_size,
            10 << 20
        );
        // 0 means unlimited, which is above the cap too.
        let unlimited = config(&["--max-file-size=0"]);
        assert_eq!(
            unlimited
                .settings(&License::default())
                .unwrap()
                .max_file_size,
            UNLICENSED_MAX_FILE_SIZE
        );
        assert_eq!(
            unlimited.settings(&valid_license()).unwrap().max_file_size,
            0
        );
    }

    #[test]
    fn list_settings_split_and_trim() {
        let cfg = config(&[
            "--trusted-proxies=10.0.0.0/8, 192.168.1.1,,",
            "--oidc-allowed-domains=a.com,b.com",
        ]);
        let settings = cfg.settings(&License::default()).unwrap();
        assert_eq!(settings.trusted_proxies.len(), 2);
        assert_eq!(settings.allowed_email_domains, ["a.com", "b.com"]);
    }

    #[test]
    fn file_transfer_timeout_falls_back_to_request_timeout() {
        let settings = config(&["--file-transfer-timeout=0", "--request-timeout=7s"])
            .settings(&License::default())
            .unwrap();
        assert_eq!(settings.file_transfer_timeout, Some(Duration::from_secs(7)));
        let disabled = config(&["--file-transfer-timeout=0", "--request-timeout=0"])
            .settings(&License::default())
            .unwrap();
        assert_eq!(disabled.file_transfer_timeout, None);
    }
}
