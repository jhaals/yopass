//! Application state, routes and middleware.

use crate::audit::AuditLogger;
use crate::auth::{self, ApiToken, CookieCodec, Oidc};
use crate::db::Database;
use crate::files::FileStore;
use crate::handlers::{self, client_ip, cors_preflight, not_found_page};
use crate::license::License;
use crate::metrics::{Metrics, normalized_method};
use crate::util::redact_secret_id;
use crate::webhook::WebhookNotifier;
use axum::Router;
use axum::extract::{MatchedPath, Request, State};
use axum::http::header::{self, HeaderValue};
use axum::http::{HeaderName, Method, StatusCode};
use axum::middleware::{Next, from_fn_with_state};
use axum::response::{IntoResponse, Response};
use axum::routing::{MethodFilter, MethodRouter, delete, get as get_or_head, on, post, put};
use http_body::Body as _;
use std::net::IpAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio_util::task::TaskTracker;
use tower::ServiceBuilder;

pub const RECEIPT_TOKEN_HEADER: &str = "X-Yopass-Receipt-Token";
pub const REQUEST_TOKEN_HEADER: &str = "X-Yopass-Request-Token";
pub const STREAM_KEY_PREFIX: &str = "stream:";
pub const RECEIPT_KEY_PREFIX: &str = "receipt/";
pub const REQUEST_KEY_PREFIX: &str = "request/";
pub const UNLICENSED_MAX_FILE_SIZE: u64 = 1 << 20;
pub const DEFAULT_MIN_EXPIRATION: i32 = 60;
pub const DEFAULT_MAX_EXPIRATION: i32 = 90 * 86400;
pub const DEFAULT_THEME_LIGHT: &str = "emerald";
pub const DEFAULT_THEME_DARK: &str = "dim";

/// A trusted proxy address or CIDR block.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TrustedProxy {
    network: IpAddr,
    prefix: u8,
}

impl TrustedProxy {
    pub fn parse(value: &str) -> Option<Self> {
        let (address, prefix) = match value.split_once('/') {
            Some((address, prefix)) => (address, Some(prefix.parse::<u8>().ok()?)),
            None => (value, None),
        };
        let network = address.parse::<IpAddr>().ok()?.to_canonical();
        let width = if network.is_ipv4() { 32 } else { 128 };
        let prefix = prefix.unwrap_or(width);
        (prefix <= width).then_some(Self { network, prefix })
    }

    pub fn contains(&self, ip: IpAddr) -> bool {
        fn masked(address: u128, prefix: u8, width: u8) -> u128 {
            let bits = u32::from(width - prefix);
            if bits >= 128 { 0 } else { address >> bits }
        }
        match (self.network, ip.to_canonical()) {
            (IpAddr::V4(a), IpAddr::V4(b)) => {
                masked(u128::from(u32::from(a)), self.prefix, 32)
                    == masked(u128::from(u32::from(b)), self.prefix, 32)
            }
            (IpAddr::V6(a), IpAddr::V6(b)) => {
                masked(u128::from(a), self.prefix, 128) == masked(u128::from(b), self.prefix, 128)
            }
            _ => false,
        }
    }
}

/// Everything configurable about the HTTP behaviour.
#[derive(Clone)]
pub struct Settings {
    pub max_length: u64,
    pub max_file_size: u64,
    pub max_request_note_length: usize,
    pub force_onetime_secrets: bool,
    pub default_onetime_secrets: bool,
    pub default_read_receipt: bool,
    pub asset_path: String,
    pub trusted_proxies: Vec<TrustedProxy>,
    pub version: String,
    pub request_timeout: Option<Duration>,
    pub file_transfer_timeout: Option<Duration>,
    pub argon2: bool,
    pub read_only: bool,
    pub disable_upload: bool,
    pub prefetch_secret: bool,
    pub disable_features: bool,
    pub disable_one_click_link: bool,
    pub no_language_switcher: bool,
    pub no_theme_switcher: bool,
    pub disable_secret_requests: bool,
    pub disable_read_receipts: bool,
    pub allow_unverified_email: bool,
    pub require_auth: bool,
    /// Also gates viewing, deletion and management routes; implies `require_auth`.
    pub require_auth_all: bool,
    pub allowed_email_domains: Vec<String>,
    pub api_tokens: Vec<ApiToken>,
    pub cors_allow_origin: String,
    pub frontend_url: String,
    pub privacy_notice_url: String,
    pub imprint_url: String,
    pub public_url: String,
    pub logo_url: String,
    pub app_name: String,
    pub hide_app_name: bool,
    pub theme_light: String,
    pub theme_dark: String,
    pub theme_custom_light: String,
    pub theme_custom_dark: String,
    pub default_expiry: String,
    pub allow_custom_expiration: bool,
    pub min_expiration: i32,
    pub max_expiration: i32,
    pub force_expiration: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            max_length: 10000,
            max_file_size: 512 * 1024,
            max_request_note_length: 1000,
            force_onetime_secrets: false,
            default_onetime_secrets: true,
            default_read_receipt: false,
            asset_path: String::new(),
            trusted_proxies: Vec::new(),
            version: String::new(),
            request_timeout: Some(Duration::from_secs(30)),
            file_transfer_timeout: Some(Duration::from_secs(300)),
            argon2: false,
            read_only: false,
            disable_upload: false,
            prefetch_secret: true,
            disable_features: false,
            disable_one_click_link: false,
            no_language_switcher: false,
            no_theme_switcher: false,
            disable_secret_requests: false,
            disable_read_receipts: false,
            allow_unverified_email: false,
            require_auth: false,
            require_auth_all: false,
            allowed_email_domains: Vec::new(),
            api_tokens: Vec::new(),
            cors_allow_origin: "*".into(),
            frontend_url: String::new(),
            privacy_notice_url: String::new(),
            imprint_url: String::new(),
            public_url: String::new(),
            logo_url: String::new(),
            app_name: String::new(),
            hide_app_name: false,
            theme_light: DEFAULT_THEME_LIGHT.into(),
            theme_dark: DEFAULT_THEME_DARK.into(),
            theme_custom_light: String::new(),
            theme_custom_dark: String::new(),
            default_expiry: "1h".into(),
            allow_custom_expiration: false,
            min_expiration: DEFAULT_MIN_EXPIRATION,
            max_expiration: DEFAULT_MAX_EXPIRATION,
            force_expiration: String::new(),
        }
    }
}

/// Shared state behind every handler.
pub struct App {
    pub settings: Settings,
    pub db: Arc<dyn Database>,
    pub files: Option<Arc<dyn FileStore>>,
    pub license: License,
    pub audit_logger: Option<Arc<AuditLogger>>,
    pub webhooks: Option<WebhookNotifier>,
    pub oidc: Option<Oidc>,
    pub sessions: Option<CookieCodec>,
    pub metrics: Metrics,
    /// Handlers and post-delivery cleanup, awaited during shutdown.
    pub tasks: TaskTracker,
    csp: HeaderValue,
}

impl App {
    pub fn new(
        settings: Settings,
        db: Arc<dyn Database>,
        files: Option<Arc<dyn FileStore>>,
    ) -> Self {
        Self {
            csp: content_security_policy(&settings.logo_url),
            settings,
            db,
            files,
            license: License::default(),
            audit_logger: None,
            webhooks: None,
            oidc: None,
            sessions: None,
            metrics: Metrics::new(),
            tasks: TaskTracker::new(),
        }
    }

    /// Audit logging is a business feature and stops when the license expires.
    pub fn audit(&self) -> Option<Arc<AuditLogger>> {
        self.license
            .currently_valid()
            .then(|| self.audit_logger.clone())
            .flatten()
    }

    pub fn webhook(&self) -> Option<&WebhookNotifier> {
        self.license
            .currently_valid()
            .then_some(self.webhooks.as_ref())
            .flatten()
    }

    /// Deliberately not gated on runtime license expiry: authentication is
    /// security infrastructure, and dropping it mid-run would strip protection
    /// from secrets created with `require_auth`.
    pub fn oidc_enabled(&self) -> bool {
        self.oidc.is_some()
    }

    pub fn read_receipts_enabled(&self) -> bool {
        self.license.currently_valid() && !self.settings.disable_read_receipts
    }

    pub fn secret_requests_enabled(&self) -> bool {
        self.license.currently_valid()
            && !self.settings.read_only
            && !self.settings.disable_secret_requests
    }

    /// Existing requests must drain even after a restart with an expired key.
    pub fn secret_request_routes_enabled(&self) -> bool {
        (self.license.currently_valid() || self.license.expired())
            && !self.settings.read_only
            && !self.settings.disable_secret_requests
    }

    /// Limits only a license permitted fall back when the license expires. A size
    /// of 0 means unlimited, which is one of them.
    pub fn effective_max_file_size(&self) -> u64 {
        let size = self.settings.max_file_size;
        if (size == 0 || size > UNLICENSED_MAX_FILE_SIZE) && !self.license.currently_valid() {
            UNLICENSED_MAX_FILE_SIZE
        } else {
            size
        }
    }
}

/// Runs the rest of the pipeline on its own task, so a client disconnect cannot
/// cancel a handler between steps. Dropping a handler future halfway would leave
/// a claim without its audit record, or an upload without its commit or cleanup.
async fn detach(State(app): State<Arc<App>>, request: Request, next: Next) -> Response {
    match app.tasks.spawn(next.run(request)).await {
        Ok(response) => response,
        Err(error) => {
            tracing::error!(panicked = error.is_panic(), "request task failed");
            handlers::json_error(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
        }
    }
}

/// The route template of a matched request. Path keys are bearer capabilities and
/// query strings may hold OIDC codes, so the raw URL must never be logged.
fn route_template(request: &Request) -> String {
    request
        .extensions()
        .get::<MatchedPath>()
        .map_or_else(|| "/".to_owned(), |path| path.as_str().to_owned())
}

async fn access_log(State(app): State<Arc<App>>, request: Request, next: Next) -> Response {
    let template = route_template(&request);
    let host = client_ip(&app, request.headers(), request.extensions());
    let method = request.method().clone();
    let protocol = format!("{:?}", request.version());
    let secret_id = template
        .contains("{key}")
        .then(|| request.uri().path().split('/').nth(2).map(redact_secret_id))
        .flatten();
    let response = next.run(request).await;
    tracing::info!(
        host,
        method = normalized_method(method.as_str()),
        uri = template,
        protocol,
        responseStatus = response.status().as_u16(),
        responseSize = response.body().size_hint().exact(),
        secret_id,
        "Request handled"
    );
    response
}

async fn security_headers(State(app): State<Arc<App>>, request: Request, next: Next) -> Response {
    let https = handlers::is_secure(&app, request.headers(), request.extensions());
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    let mut set = |name: &'static str, value: HeaderValue| {
        headers.insert(HeaderName::from_static(name), value);
    };
    set("content-security-policy", app.csp.clone());
    set("referrer-policy", HeaderValue::from_static("no-referrer"));
    set(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    set("x-frame-options", HeaderValue::from_static("DENY"));
    set(
        "x-xss-protection",
        HeaderValue::from_static("1; mode=block"),
    );
    if https {
        set(
            "strict-transport-security",
            HeaderValue::from_static("max-age=31536000"),
        );
    }
    response
}

/// WebAssembly compilation is required to decrypt existing Argon2 messages,
/// whatever the current encryption setting.
fn content_security_policy(logo_url: &str) -> HeaderValue {
    let logo_origin = url::Url::parse(logo_url)
        .ok()
        .filter(|u| u.has_host())
        .map(|u| {
            format!(
                " {}://{}",
                u.scheme(),
                u.authority().rsplit('@').next().unwrap_or("")
            )
        });
    let policy = format!(
        "default-src 'self'; font-src 'self' data:; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:{}; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'",
        logo_origin.unwrap_or_default()
    );
    HeaderValue::from_str(&policy)
        .unwrap_or_else(|_| HeaderValue::from_static("default-src 'self'"))
}

async fn record_metrics(State(app): State<Arc<App>>, request: Request, next: Next) -> Response {
    let path = route_template(&request).replace("{key}", ":key");
    let method = normalized_method(request.method().as_str()).to_owned();
    let started = Instant::now();
    let response = next.run(request).await;
    app.metrics.record(
        &method,
        &path,
        response.status().as_u16(),
        started.elapsed().as_secs_f64(),
    );
    response
}

/// Sets CORS headers and, in split-origin deployments, refuses state-changing
/// requests from any other origin.
async fn cors(State(app): State<Arc<App>>, request: Request, next: Next) -> Response {
    let frontend = &app.settings.frontend_url;
    let allow_origin = if frontend.is_empty() {
        None
    } else {
        let allowed = auth::normalize_origin(frontend);
        let method = request.method();
        let mutating = method != Method::GET && method != Method::HEAD && method != Method::OPTIONS;
        if mutating
            && let Some(origin) = request
                .headers()
                .get(header::ORIGIN)
                .and_then(|v| v.to_str().ok())
            && auth::normalize_origin(origin) != allowed
        {
            return (StatusCode::FORBIDDEN, "origin not allowed").into_response();
        }
        Some(allowed)
    };
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    match allow_origin {
        Some(allowed) => {
            if let Ok(value) = HeaderValue::from_str(&allowed) {
                headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, value);
            }
            headers.insert(
                header::ACCESS_CONTROL_ALLOW_CREDENTIALS,
                HeaderValue::from_static("true"),
            );
            headers.append(header::VARY, HeaderValue::from_static("Origin"));
        }
        None => {
            if let Ok(value) = HeaderValue::from_str(&app.settings.cors_allow_origin) {
                headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, value);
            }
        }
    }
    response
}

/// GET only. axum answers HEAD by running the GET handler unless HEAD has its own
/// route, and a link scanner's HEAD must never consume a one-time secret.
fn get<H, T>(handler: H) -> MethodRouter<Arc<App>>
where
    H: axum::handler::Handler<T, Arc<App>>,
    T: 'static,
{
    on(MethodFilter::GET, handler).merge(on(MethodFilter::HEAD, handlers::ops::static_files))
}

fn gated(
    app: &Arc<App>,
    event: &'static str,
    route: MethodRouter<Arc<App>>,
) -> MethodRouter<Arc<App>> {
    // require_auth_all fails closed even without OIDC.
    if app.settings.require_auth_all || (app.oidc_enabled() && app.settings.require_auth) {
        route.route_layer(from_fn_with_state((app.clone(), event), auth::require_auth))
    } else {
        route
    }
}

/// `gated` for the non-creation routes that `--require-auth-all` also covers.
/// Without OIDC nobody can sign in, so gated requests are refused, not let through.
fn gated_all(
    app: &Arc<App>,
    event: &'static str,
    route: MethodRouter<Arc<App>>,
) -> MethodRouter<Arc<App>> {
    if app.settings.require_auth_all {
        route.route_layer(from_fn_with_state((app.clone(), event), auth::require_auth))
    } else {
        route
    }
}

fn options(methods: &'static str, headers: &'static str) -> MethodRouter<Arc<App>> {
    on(MethodFilter::OPTIONS, move || {
        cors_preflight(methods, headers)
    })
}

/// Builds the full HTTP service. Routes are only registered when their feature
/// is on, so a disabled feature is indistinguishable from a missing page.
pub fn router(app: Arc<App>) -> Router {
    let settings = &app.settings;
    let upload_enabled = !settings.disable_upload;
    let receipt_headers = "Content-Type, X-Yopass-Receipt-Token";
    let request_headers = "Content-Type, X-Yopass-Request-Token";
    let request_methods = "GET, POST, PUT, DELETE, OPTIONS";
    let stream_headers = "Content-Type, X-Yopass-Expiration, X-Yopass-OneTime, X-Yopass-RequireAuth, X-Yopass-Receipt";
    let stream_methods = "POST, GET, DELETE, OPTIONS";

    let mut router: Router<Arc<App>> = Router::new()
        .route(
            "/secret/{key}",
            gated_all(&app, "secret.accessed", get(handlers::secret::get_secret)).merge(gated_all(
                &app,
                "secret.deleted",
                delete(handlers::secret::delete_secret),
            )),
        )
        .route(
            "/secret/{key}/receipt",
            gated_all(
                &app,
                "secret.receipt_checked",
                get(handlers::receipt::get_receipt),
            )
            .merge(options("GET, OPTIONS", receipt_headers)),
        )
        .route(
            "/file/{key}/receipt",
            gated_all(
                &app,
                "secret.receipt_checked",
                get(handlers::receipt::get_receipt),
            )
            .merge(options("GET, OPTIONS", receipt_headers)),
        )
        .route(
            "/config",
            get(handlers::ops::config).merge(options("GET, OPTIONS", "")),
        )
        .route("/health", get_or_head(handlers::ops::health))
        .route("/ready", get_or_head(handlers::ops::ready))
        .route("/version", get(handlers::ops::version))
        .route("/logo", get(handlers::ops::logo));

    if !settings.read_only {
        router = router.route(
            "/create/secret",
            gated(
                &app,
                "secret.created",
                post(handlers::secret::create_secret),
            )
            .merge(options("POST, OPTIONS", "Content-Type")),
        );
    }
    if settings.prefetch_secret {
        router = router.route(
            "/secret/{key}/status",
            gated_all(
                &app,
                "secret.status_checked",
                get(handlers::secret::secret_status),
            ),
        );
    }
    if app.secret_request_routes_enabled() {
        use handlers::request as r;
        router = router
            .route(
                "/request",
                gated(&app, "request.created", post(r::create_request))
                    .merge(options(request_methods, request_headers)),
            )
            // GET /request/{key} and POST /request/{key}/secret serve the responder,
            // who is not expected to have an account, so --require-auth-all skips them.
            .route(
                "/request/{key}",
                get(r::get_request)
                    .merge(gated_all(
                        &app,
                        "request.revoked",
                        delete(r::revoke_request),
                    ))
                    .merge(options(request_methods, request_headers)),
            )
            .route(
                "/request/{key}/secret",
                gated_all(
                    &app,
                    "request.secret_accessed",
                    get(r::fetch_request_secret),
                )
                .merge(post(r::fulfill_request))
                .merge(options(request_methods, request_headers)),
            )
            .route(
                "/request/{key}/key",
                gated_all(&app, "request.key_rotated", put(r::rotate_request_key))
                    .merge(options(request_methods, request_headers)),
            );
    }
    if app.oidc_enabled() {
        router = router
            .route("/auth/login", get(auth::login))
            .route("/auth/callback", get(auth::callback))
            .route("/auth/logout", post(auth::logout))
            .route("/auth/me", get(auth::me));
    }
    if upload_enabled {
        use handlers::file as f;
        if !settings.read_only {
            router = router.route(
                "/create/file",
                gated(&app, "file.uploaded", post(f::upload))
                    .merge(options(stream_methods, stream_headers)),
            );
        }
        router = router.route(
            "/file/{key}",
            gated_all(&app, "file.downloaded", get(f::download))
                .merge(gated_all(&app, "file.deleted", delete(f::delete_file)))
                .merge(options(stream_methods, stream_headers)),
        );
        if settings.prefetch_secret {
            router = router.route(
                "/file/{key}/status",
                gated_all(
                    &app,
                    "file.status_checked",
                    get(handlers::secret::file_status),
                ),
            );
        }
    }

    let stack = ServiceBuilder::new()
        .layer(from_fn_with_state(app.clone(), detach))
        .layer(from_fn_with_state(app.clone(), security_headers))
        .layer(from_fn_with_state(app.clone(), access_log))
        .layer(from_fn_with_state(app.clone(), record_metrics))
        .layer(from_fn_with_state(app.clone(), cors));

    router
        .fallback(handlers::ops::static_files)
        .method_not_allowed_fallback(handlers::ops::static_files)
        .layer(stack)
        .with_state(app)
}

/// The separate metrics listener.
pub fn metrics_router(app: Arc<App>) -> Router {
    async fn render(State(app): State<Arc<App>>) -> Response {
        (
            [(
                header::CONTENT_TYPE,
                "text/plain; version=0.0.4; charset=utf-8",
            )],
            app.metrics.render(),
        )
            .into_response()
    }
    Router::new()
        .route("/metrics", get(render))
        .fallback(|| async { not_found_page() })
        .with_state(app)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trusted_proxy_matching() {
        let cidr = TrustedProxy::parse("10.0.0.0/8").unwrap();
        assert!(cidr.contains("10.1.2.3".parse().unwrap()));
        assert!(!cidr.contains("11.0.0.1".parse().unwrap()));
        // IPv4-mapped IPv6 peers must match their IPv4 rule.
        assert!(cidr.contains("::ffff:10.1.2.3".parse().unwrap()));
        assert!(!cidr.contains("2001:db8::1".parse().unwrap()));

        let single = TrustedProxy::parse("192.168.1.1").unwrap();
        assert!(single.contains("192.168.1.1".parse().unwrap()));
        assert!(!single.contains("192.168.1.2".parse().unwrap()));

        let v6 = TrustedProxy::parse("2001:db8::/32").unwrap();
        assert!(v6.contains("2001:db8:1::1".parse().unwrap()));
        assert!(!v6.contains("2001:db9::1".parse().unwrap()));

        assert!(
            TrustedProxy::parse("0.0.0.0/0")
                .unwrap()
                .contains("8.8.8.8".parse().unwrap())
        );
        for bad in [
            "",
            "proxy.example.com",
            "10.0.0.0/33",
            "::/129",
            "10.0.0.0/x",
        ] {
            assert_eq!(TrustedProxy::parse(bad), None, "{bad}");
        }
    }

    #[test]
    fn unlimited_file_size_falls_back_when_the_license_lapses() {
        let mut app = App::new(
            Settings {
                max_file_size: 0,
                ..Settings::default()
            },
            Arc::new(crate::db::memory::MemoryDb::new()),
            None,
        );
        assert_eq!(app.effective_max_file_size(), UNLICENSED_MAX_FILE_SIZE);
        app.license = License::valid_until(crate::util::now_unix() + 3600);
        assert_eq!(app.effective_max_file_size(), 0);
    }

    #[test]
    fn csp_only_extends_img_src_with_an_absolute_logo_origin() {
        let policy = |url| content_security_policy(url).to_str().unwrap().to_owned();
        assert!(policy("").contains("img-src 'self' data:;"));
        assert!(policy("/local.svg").contains("img-src 'self' data:;"));
        assert!(
            policy("https://cdn.example.com/x.svg?a=b")
                .contains("img-src 'self' data: https://cdn.example.com;")
        );
        assert!(!policy("https://user:pw@cdn.example.com/x.svg").contains("pw"));
    }
}
