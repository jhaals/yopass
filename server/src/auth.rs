//! OIDC login, encrypted session cookies, API tokens and cookie authority checks.

use crate::app::App;
use crate::audit::{Auditor, Fields};
use crate::db::{Abort, Secret};
use crate::handlers::{client_ip, found, is_secure, json_error, json_ok, no_store, request_host};
use crate::util::{constant_time_digest_eq, now_unix, random_hex, random_key, random_nonce};
use aes_gcm::aead::{Aead, Payload};
use aes_gcm::{Aes256Gcm, Key, KeyInit, Nonce as GcmNonce};
use axum::extract::rejection::QueryRejection;
use axum::extract::{Query, Request, State};
use axum::http::header::{AUTHORIZATION, COOKIE, ORIGIN, SET_COOKIE};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, request::Parts};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use cookie::{Cookie, SameSite};
use hkdf::Hkdf;
use openidconnect::core::{
    CoreAuthenticationFlow, CoreClient, CoreClientAuthMethod, CoreIdTokenVerifier,
    CoreJsonWebKeySet, CoreJwsSigningAlgorithm, CoreProviderMetadata,
};
use openidconnect::{
    AccessToken, AuthType, AuthorizationCode, ClaimsVerificationError, ClientId, ClientSecret,
    CsrfToken, EndpointMaybeSet, EndpointNotSet, EndpointSet, IssuerUrl, JsonWebKeySetUrl, Nonce,
    OAuth2TokenResponse, PkceCodeChallenge, PkceCodeVerifier, RedirectUrl, Scope, TokenResponse,
};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use std::time::{Duration, Instant};
use subtle::ConstantTimeEq;

pub const SESSION_COOKIE: &str = "yopass_session";
const FLOW_COOKIE: &str = "yopass_oidc_flow";
pub const SESSION_MAX_AGE: i64 = 24 * 3600;
const FLOW_MAX_AGE: i64 = 600;
/// Keeps logged-out session IDs out of reach of the /secret/{key} routes.
pub const REVOKED_SESSION_PREFIX: &str = "session-revoked/";
const MIN_API_TOKEN_LENGTH: usize = 16;
const MAX_USERINFO_BYTES: usize = 1 << 20;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Session {
    /// Identifies this login so logout can revoke it. Empty for API tokens.
    #[serde(rename = "jti", default, skip_serializing_if = "String::is_empty")]
    pub id: String,
    pub sub: String,
    pub email: String,
    pub name: String,
}

/// A named static bearer token. Only a SHA-256 digest of the secret is kept.
#[derive(Clone)]
pub struct ApiToken {
    pub name: String,
    digest: [u8; 32],
}

/// Parses `name:secret` entries. Errors never include a secret, so a
/// misconfigured value cannot reach logs.
pub fn parse_api_tokens(entries: &[String]) -> Result<Vec<ApiToken>, String> {
    let mut tokens: Vec<ApiToken> = Vec::with_capacity(entries.len());
    for entry in entries {
        let Some((name, secret)) = entry
            .split_once(':')
            .filter(|(n, s)| !n.is_empty() && !s.is_empty())
        else {
            return Err("invalid api-token entry: expected format name:secret".into());
        };
        if secret.len() < MIN_API_TOKEN_LENGTH {
            return Err(format!(
                "api-token {name:?}: secret must be at least {MIN_API_TOKEN_LENGTH} characters"
            ));
        }
        if tokens.iter().any(|t| t.name == name) {
            return Err(format!("duplicate api-token name {name:?}"));
        }
        tokens.push(ApiToken {
            name: name.to_owned(),
            digest: Sha256::digest(secret.as_bytes()).into(),
        });
    }
    Ok(tokens)
}

pub fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    let value = headers.get(AUTHORIZATION)?.to_str().ok()?;
    let prefix = value.get(..7)?;
    prefix
        .eq_ignore_ascii_case("bearer ")
        .then(|| value[7..].trim())
        .filter(|token| !token.is_empty())
}

/// Authenticated encryption for cookie values, bound to the cookie's name so one
/// cookie cannot be replayed as the other.
#[derive(Clone)]
pub struct CookieCodec {
    key: [u8; 32],
}

#[derive(Serialize, Deserialize)]
struct Sealed<T> {
    exp: i64,
    data: T,
}

impl CookieCodec {
    pub fn from_key(key: [u8; 32]) -> Self {
        Self { key }
    }

    /// Derives per-purpose keys from the 64-byte shared key, or uses a random
    /// key when none is configured (single instance only).
    pub fn derive(master_hex: &str, label: &str) -> Self {
        let derived = hex::decode(master_hex)
            .ok()
            .filter(|raw| raw.len() == 64)
            .map(|raw| {
                let mut key = [0u8; 32];
                Hkdf::<Sha256>::new(None, &raw)
                    .expand(label.as_bytes(), &mut key)
                    .expect("32 bytes is a valid HKDF output length");
                key
            });
        Self::from_key(derived.unwrap_or_else(random_key))
    }

    fn cipher(&self) -> Aes256Gcm {
        Aes256Gcm::new(&Key::<Aes256Gcm>::from(self.key))
    }

    pub fn seal<T: Serialize>(&self, name: &str, data: &T, max_age: i64) -> Option<String> {
        let plaintext = serde_json::to_vec(&Sealed {
            exp: now_unix() + max_age,
            data,
        })
        .ok()?;
        let nonce = random_nonce();
        let ciphertext = self
            .cipher()
            .encrypt(
                &GcmNonce::from(nonce),
                Payload {
                    msg: &plaintext,
                    aad: name.as_bytes(),
                },
            )
            .ok()?;
        let mut sealed = nonce.to_vec();
        sealed.extend_from_slice(&ciphertext);
        Some(URL_SAFE_NO_PAD.encode(sealed))
    }

    pub fn open<T: DeserializeOwned>(&self, name: &str, value: &str) -> Option<T> {
        let sealed = URL_SAFE_NO_PAD.decode(value).ok()?;
        if sealed.len() < 12 {
            return None;
        }
        let (nonce, ciphertext) = sealed.split_at(12);
        let nonce: [u8; 12] = nonce.try_into().ok()?;
        let plaintext = self
            .cipher()
            .decrypt(
                &GcmNonce::from(nonce),
                Payload {
                    msg: ciphertext,
                    aad: name.as_bytes(),
                },
            )
            .ok()?;
        let sealed: Sealed<T> = serde_json::from_slice(&plaintext).ok()?;
        (sealed.exp > now_unix()).then_some(sealed.data)
    }
}

fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get_all(COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(Cookie::split_parse)
        .flatten()
        .find(|cookie| cookie.name() == name)
        .map(|cookie| cookie.value().to_owned())
}

/// Scheme and host of `raw`, lowercased with default ports stripped, as browsers
/// send them in `Origin`.
pub fn normalize_origin(raw: &str) -> String {
    match url::Url::parse(raw) {
        Ok(url) if url.has_host() => url.origin().ascii_serialization(),
        _ => raw.to_ascii_lowercase(),
    }
}

fn normalize_host(scheme: &str, host: &str) -> String {
    let host = host.to_ascii_lowercase();
    let default_port = match scheme {
        "http" => ":80",
        "https" => ":443",
        _ => return host,
    };
    host.strip_suffix(default_port)
        .map_or_else(|| host.clone(), str::to_owned)
}

impl App {
    /// Cookie authority belongs to the frontend, including for consuming GETs:
    /// a cross-site link must not be able to spend a user's session.
    pub fn from_foreign_origin(
        &self,
        method: &Method,
        headers: &HeaderMap,
        secure: bool,
        host: &str,
    ) -> bool {
        let header = |name: &str| headers.get(name).and_then(|v| v.to_str().ok());
        if method == Method::GET && header("sec-fetch-mode") == Some("navigate") {
            return true;
        }
        if let Some(origin) = headers.get(ORIGIN).and_then(|v| v.to_str().ok()) {
            let frontend = &self.settings.frontend_url;
            let allowed = if frontend.is_empty() {
                format!("{}://{host}", if secure { "https" } else { "http" })
            } else {
                frontend.clone()
            };
            if normalize_origin(origin) != normalize_origin(&allowed) {
                return true;
            }
            if !frontend.is_empty() {
                return false;
            }
        }
        !matches!(
            header("sec-fetch-site"),
            None | Some("same-origin" | "none")
        )
    }

    /// The identity behind a request, if any. A session already authorized by
    /// `require_auth` wins so handlers attribute audit events to the identity
    /// that passed the gate, even if it logs out while the request is in flight.
    pub async fn session(&self, parts: &Parts) -> Option<Session> {
        if let Some(session) = parts.extensions.get::<Session>() {
            return Some(session.clone());
        }
        let secure = is_secure(self, &parts.headers, &parts.extensions);
        let host = request_host(parts);
        if self.from_foreign_origin(&parts.method, &parts.headers, secure, &host) {
            return None;
        }
        self.cookie_session(&parts.headers).await
    }

    /// Also used after the logout handler's own origin checks.
    pub async fn cookie_session(&self, headers: &HeaderMap) -> Option<Session> {
        let codec = self.sessions.as_ref()?;
        let value = cookie_value(headers, SESSION_COOKIE)?;
        let session: Session = codec.open(SESSION_COOKIE, &value)?;
        (!self.session_revoked(&session.id).await).then_some(session)
    }

    /// Lookup failures count as not revoked: a storage outage must not sign every
    /// user out, and the cookie expires on its own within `SESSION_MAX_AGE`.
    async fn session_revoked(&self, id: &str) -> bool {
        !id.is_empty()
            && self
                .db
                .status(&format!("{REVOKED_SESSION_PREFIX}{id}"))
                .await
                .is_ok()
    }

    async fn revoke_session(&self, id: &str) {
        if id.is_empty() {
            return;
        }
        let record = Secret {
            expiration: SESSION_MAX_AGE as i32,
            message: "revoked".into(),
            ..Secret::default()
        };
        if let Err(error) = self
            .db
            .put(&format!("{REVOKED_SESSION_PREFIX}{id}"), &record)
            .await
        {
            tracing::error!(error = %error, "failed to revoke session");
        }
    }

    pub fn email_allowed(&self, email: &str) -> bool {
        let Some((_, domain)) = email.split_once('@').filter(|(_, d)| !d.is_empty()) else {
            return false;
        };
        let allowed = &self.settings.allowed_email_domains;
        allowed.is_empty() || allowed.iter().any(|a| a.eq_ignore_ascii_case(domain))
    }

    /// Enforces `require_auth` for retrieval and deletion.
    pub fn check_access(&self, secret: &Secret, session: Option<&Session>) -> Result<(), Abort> {
        if !secret.require_auth {
            return Ok(());
        }
        let session = session.ok_or(Abort::Unauthenticated)?;
        if !self.email_allowed(&session.email) {
            return Err(Abort::DomainForbidden);
        }
        Ok(())
    }

    fn api_token_session(&self, headers: &HeaderMap) -> Option<Session> {
        if self.settings.api_tokens.is_empty() {
            return None;
        }
        let presented: [u8; 32] = Sha256::digest(bearer_token(headers)?.as_bytes()).into();
        // Hashing first means a partial match is not observable through timing.
        self.settings
            .api_tokens
            .iter()
            .find(|t| bool::from(t.digest.ct_eq(&presented)))
            .map(|token| Session {
                id: String::new(),
                sub: format!("api-token:{}", token.name),
                email: format!("service:{}", token.name),
                name: token.name.clone(),
            })
    }

    fn cookie_flags(
        &self,
        headers: &HeaderMap,
        extensions: &axum::http::Extensions,
        host: &str,
    ) -> (SameSite, bool) {
        let secure = is_secure(self, headers, extensions);
        let cross_origin = url::Url::parse(&self.settings.frontend_url)
            .ok()
            .and_then(|url| {
                let frontend = url.host_str()?.to_ascii_lowercase();
                let frontend = match url.port() {
                    Some(port) => format!("{frontend}:{port}"),
                    None => frontend,
                };
                let scheme = if secure { "https" } else { "http" };
                Some(normalize_host(url.scheme(), &frontend) != normalize_host(scheme, host))
            })
            .unwrap_or(false);
        // Browsers only send a cross-site cookie that is SameSite=None; Secure.
        if cross_origin {
            (SameSite::None, true)
        } else {
            (SameSite::Lax, secure)
        }
    }

    pub fn home_url(&self) -> String {
        let frontend = self.settings.frontend_url.trim_end_matches('/');
        if frontend.is_empty() {
            "/".into()
        } else {
            format!("{frontend}/")
        }
    }
}

fn set_cookie(
    response: &mut Response,
    name: &'static str,
    value: String,
    same_site: SameSite,
    secure: bool,
    max_age: i64,
) {
    let cookie = Cookie::build((name, value))
        .path("/")
        .http_only(true)
        .secure(secure)
        .same_site(same_site)
        .max_age(cookie::time::Duration::seconds(max_age))
        .build();
    if let Ok(value) = HeaderValue::from_str(&cookie.to_string()) {
        response.headers_mut().append(SET_COOKIE, value);
    }
}

/// Answers 401/403 before a gated creation route runs. Machine clients may use an
/// API bearer token; those are service accounts, so domain rules do not apply.
pub async fn require_auth(
    State((app, event)): State<(Arc<App>, &'static str)>,
    request: Request,
    next: Next,
) -> Response {
    let (mut parts, body) = request.into_parts();
    if let Some(session) = app.api_token_session(&parts.headers) {
        parts.extensions.insert(session);
        return next.run(Request::from_parts(parts, body)).await;
    }
    let ip = client_ip(&app, &parts.headers, &parts.extensions);
    let fields = Fields {
        require_auth: Some(true),
        ..Fields::default()
    };
    let Some(session) = app.session(&parts).await else {
        let reason = if bearer_token(&parts.headers).is_some() {
            "invalid API token"
        } else {
            "authentication required"
        };
        Auditor::new(app.audit(), event, ip, None).denied_with(reason, fields);
        return json_error(StatusCode::UNAUTHORIZED, "authentication required");
    };
    if !app.email_allowed(&session.email) {
        Auditor::new(app.audit(), event, ip, Some(&session))
            .denied_with("email domain not permitted", fields);
        return json_error(StatusCode::FORBIDDEN, "email domain not permitted");
    }
    parts.extensions.insert(session);
    next.run(Request::from_parts(parts, body)).await
}

type OidcClient = CoreClient<
    EndpointSet,
    EndpointNotSet,
    EndpointNotSet,
    EndpointNotSet,
    EndpointMaybeSet,
    EndpointMaybeSet,
>;

pub struct OidcConfig {
    pub issuer: String,
    pub client_id: String,
    pub client_secret: String,
    pub redirect_url: String,
    pub session_key: String,
}

pub struct Oidc {
    client: OidcClient,
    http: reqwest::Client,
    issuer: IssuerUrl,
    jwks_uri: JsonWebKeySetUrl,
    jwks: tokio::sync::Mutex<JwksCache>,
    jwks_refetch_after: Duration,
    jwks_fresh_for: Duration,
    userinfo_url: Option<String>,
    flow: CookieCodec,
}

/// Keys are refetched after this, so one the provider withdrew stops being trusted.
const JWKS_FRESH_FOR: Duration = Duration::from_secs(3600);
/// How long keys outlive failed refetches, so a key endpoint outage does not stop
/// logins. Beyond this the server fails closed.
const JWKS_USABLE_FOR: Duration = Duration::from_secs(24 * 3600);
/// Minimum time between fetches once keys are held. A token that fails verification
/// triggers a refetch to pick up a rotation, and that must not become a request flood.
const JWKS_REFETCH_AFTER: Duration = Duration::from_secs(30);

struct JwksCache {
    keys: CoreJsonWebKeySet,
    fetched: Instant,
    last_attempt: Instant,
}

impl JwksCache {
    fn new(keys: CoreJsonWebKeySet, now: Instant) -> Self {
        Self {
            keys,
            fetched: now,
            last_attempt: now,
        }
    }

    fn is_fresh(&self, now: Instant, fresh_for: Duration) -> bool {
        now.duration_since(self.fetched) < fresh_for
    }

    fn may_fetch(&self, now: Instant, refetch_after: Duration) -> bool {
        now.duration_since(self.last_attempt) >= refetch_after
    }

    fn usable(&self, now: Instant) -> Option<CoreJsonWebKeySet> {
        (now.duration_since(self.fetched) < JWKS_USABLE_FOR).then(|| self.keys.clone())
    }
}

#[derive(Serialize, Deserialize)]
struct FlowState {
    state: String,
    nonce: String,
    pkce: String,
}

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
struct HttpError(String);

async fn oidc_http(
    client: &reqwest::Client,
    request: openidconnect::HttpRequest,
) -> Result<openidconnect::HttpResponse, HttpError> {
    let (parts, body) = request.into_parts();
    let response = client
        .request(parts.method, parts.uri.to_string())
        .headers(parts.headers)
        .body(body)
        .send()
        .await
        .map_err(|e| HttpError(e.without_url().to_string()))?;
    let mut builder = axum::http::Response::builder().status(response.status());
    for (name, value) in response.headers() {
        builder = builder.header(name, value);
    }
    let body = read_limited(response).await?;
    builder.body(body).map_err(|e| HttpError(e.to_string()))
}

async fn read_limited(mut response: reqwest::Response) -> Result<Vec<u8>, HttpError> {
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| HttpError(e.without_url().to_string()))?
    {
        if body.len() + chunk.len() > MAX_USERINFO_BYTES {
            return Err(HttpError("OIDC provider response too large".into()));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// Some providers send `email_verified` as a string.
fn flexible_bool<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<bool, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Flexible {
        Bool(bool),
        Text(String),
    }
    Ok(match Option::<Flexible>::deserialize(deserializer)? {
        Some(Flexible::Bool(value)) => value,
        Some(Flexible::Text(value)) => value.eq_ignore_ascii_case("true"),
        None => false,
    })
}

#[derive(Deserialize)]
struct UserInfo {
    #[serde(default)]
    sub: String,
    #[serde(default)]
    email: String,
    #[serde(default, deserialize_with = "flexible_bool")]
    email_verified: bool,
    #[serde(default)]
    name: String,
}

#[derive(Debug, thiserror::Error)]
enum CallbackError {
    #[error("invalid callback")]
    Rejected(&'static str),
}

impl Oidc {
    /// Discovers the provider. A failure here must stop startup: a server that
    /// came up without its authentication would hand out protected secrets.
    pub async fn discover(config: &OidcConfig) -> Result<Self, String> {
        if config.issuer.is_empty() || config.client_id.is_empty() || config.redirect_url.is_empty()
        {
            return Err(
                "oidc-issuer, oidc-client-id, and oidc-redirect-url are all required".into(),
            );
        }
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            // OIDC clients must not follow redirects: that would be an SSRF vector.
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| format!("failed to build OIDC client: {e}"))?;
        let issuer = IssuerUrl::new(config.issuer.clone())
            .map_err(|e| format!("invalid oidc-issuer: {e}"))?;
        let client_ref = http.clone();
        let metadata = CoreProviderMetadata::discover_async(issuer.clone(), &move |request| {
            let client = client_ref.clone();
            async move { oidc_http(&client, request).await }
        })
        .await
        .map_err(|e| format!("failed to discover OIDC provider: {e}"))?;
        let jwks_uri = metadata.jwks_uri().clone();
        // Discovery fetched these already, and it fails without them.
        let keys = metadata.jwks().clone();
        let userinfo_url = metadata
            .userinfo_endpoint()
            .map(|url| url.url().to_string());
        // HTTP Basic is the spec's default; follow providers that only offer POST.
        let post_only = metadata
            .token_endpoint_auth_methods_supported()
            .is_some_and(|methods| {
                !methods.contains(&CoreClientAuthMethod::ClientSecretBasic)
                    && methods.contains(&CoreClientAuthMethod::ClientSecretPost)
            });
        let secret = (!config.client_secret.is_empty())
            .then(|| ClientSecret::new(config.client_secret.clone()));
        let client = CoreClient::from_provider_metadata(
            metadata,
            ClientId::new(config.client_id.clone()),
            secret,
        )
        .set_auth_type(if post_only {
            AuthType::RequestBody
        } else {
            AuthType::BasicAuth
        })
        .set_redirect_uri(
            RedirectUrl::new(config.redirect_url.clone())
                .map_err(|e| format!("invalid oidc-redirect-url: {e}"))?,
        );
        Ok(Self {
            client,
            http,
            issuer,
            jwks_uri,
            jwks: tokio::sync::Mutex::new(JwksCache::new(keys, Instant::now())),
            jwks_refetch_after: JWKS_REFETCH_AFTER,
            jwks_fresh_for: JWKS_FRESH_FOR,
            userinfo_url,
            flow: CookieCodec::derive(&config.session_key, "yopass-oidc-flow"),
        })
    }

    /// Overrides the minimum time between key fetches.
    pub fn with_jwks_refetch_after(mut self, interval: Duration) -> Self {
        self.jwks_refetch_after = interval;
        self
    }

    /// How long keys are used before a refetch, shortened by tests.
    pub fn with_jwks_fresh_for(mut self, interval: Duration) -> Self {
        self.jwks_fresh_for = interval;
        self
    }

    /// The provider's signing keys, cached. `refetch` asks for a new copy because
    /// the cached keys did not verify a token, which is how a rotation shows up.
    /// The lock is held across the fetch so concurrent logins share one request.
    async fn signing_keys(&self, refetch: bool) -> Option<CoreJsonWebKeySet> {
        let mut cache = self.jwks.lock().await;
        let now = Instant::now();
        if !refetch && cache.is_fresh(now, self.jwks_fresh_for) {
            return Some(cache.keys.clone());
        }
        if cache.may_fetch(now, self.jwks_refetch_after) {
            cache.last_attempt = now;
            let http = self.http.clone();
            let fetched = CoreJsonWebKeySet::fetch_async(&self.jwks_uri, &move |request| {
                let client = http.clone();
                async move { oidc_http(&client, request).await }
            })
            .await;
            match fetched {
                Ok(keys) => {
                    cache.keys = keys.clone();
                    cache.fetched = now;
                    return Some(keys);
                }
                Err(_) => tracing::warn!("failed to fetch OIDC signing keys"),
            }
        }
        cache.usable(now)
    }

    /// Only asymmetric algorithms: HS256 and "none" could be forged with nothing
    /// more than the client secret, or nothing at all.
    fn id_token_verifier(&self, keys: CoreJsonWebKeySet) -> CoreIdTokenVerifier<'static> {
        CoreIdTokenVerifier::new_public_client(
            self.client.client_id().clone(),
            self.issuer.clone(),
            keys,
        )
        .set_allowed_algs([
            CoreJwsSigningAlgorithm::RsaSsaPkcs1V15Sha256,
            CoreJwsSigningAlgorithm::RsaSsaPkcs1V15Sha384,
            CoreJwsSigningAlgorithm::RsaSsaPkcs1V15Sha512,
            CoreJwsSigningAlgorithm::RsaSsaPssSha256,
            CoreJwsSigningAlgorithm::RsaSsaPssSha384,
            CoreJwsSigningAlgorithm::RsaSsaPssSha512,
            CoreJwsSigningAlgorithm::EcdsaP256Sha256,
            CoreJwsSigningAlgorithm::EcdsaP384Sha384,
            CoreJwsSigningAlgorithm::EdDsa,
        ])
    }

    fn begin(&self) -> Option<(String, String)> {
        let (challenge, verifier) = PkceCodeChallenge::new_random_sha256();
        let (url, state, nonce) = self
            .client
            .authorize_url(
                CoreAuthenticationFlow::AuthorizationCode,
                CsrfToken::new_random,
                Nonce::new_random,
            )
            .add_scope(Scope::new("email".into()))
            .add_scope(Scope::new("profile".into()))
            .set_pkce_challenge(challenge)
            .url();
        let sealed = self.flow.seal(
            FLOW_COOKIE,
            &FlowState {
                state: state.secret().clone(),
                nonce: nonce.secret().clone(),
                pkce: verifier.secret().clone(),
            },
            FLOW_MAX_AGE,
        )?;
        Some((url.to_string(), sealed))
    }

    /// Exchanges the code, verifies the ID token and returns the userinfo claims.
    async fn complete(&self, flow: FlowState, code: String) -> Result<UserInfo, CallbackError> {
        let http = self.http.clone();
        let exchange = move |request| {
            let client = http.clone();
            async move { oidc_http(&client, request).await }
        };
        let tokens = self
            .client
            .exchange_code(AuthorizationCode::new(code))
            .map_err(|_| CallbackError::Rejected("token endpoint unavailable"))?
            .set_pkce_verifier(PkceCodeVerifier::new(flow.pkce))
            .request_async(&exchange)
            .await
            .map_err(|_| CallbackError::Rejected("code exchange failed"))?;
        let id_token = tokens
            .id_token()
            .ok_or(CallbackError::Rejected("missing ID token"))?;
        let keys = self
            .signing_keys(false)
            .await
            .ok_or(CallbackError::Rejected("signing keys unavailable"))?;
        let nonce = Nonce::new(flow.nonce);
        let claims = match id_token.claims(&self.id_token_verifier(keys), &nonce) {
            Err(ClaimsVerificationError::SignatureVerification(_)) => {
                let keys = self
                    .signing_keys(true)
                    .await
                    .ok_or(CallbackError::Rejected("signing keys unavailable"))?;
                id_token.claims(&self.id_token_verifier(keys), &nonce)
            }
            other => other,
        }
        .map_err(|_| CallbackError::Rejected("invalid ID token"))?;
        let subject = claims.subject().to_string();
        let info = self.userinfo(tokens.access_token()).await?;
        // The spec requires this: userinfo for another subject must not be used.
        if !info.sub.is_empty() && info.sub != subject {
            return Err(CallbackError::Rejected("userinfo subject mismatch"));
        }
        Ok(info)
    }

    async fn userinfo(&self, access_token: &AccessToken) -> Result<UserInfo, CallbackError> {
        let url = self
            .userinfo_url
            .as_ref()
            .ok_or(CallbackError::Rejected("provider has no userinfo endpoint"))?;
        let response = self
            .http
            .get(url)
            .bearer_auth(access_token.secret())
            .send()
            .await
            .map_err(|_| CallbackError::Rejected("userinfo request failed"))?;
        if !response.status().is_success() {
            return Err(CallbackError::Rejected("userinfo request failed"));
        }
        let body = read_limited(response)
            .await
            .map_err(|_| CallbackError::Rejected("userinfo request failed"))?;
        serde_json::from_slice(&body)
            .map_err(|_| CallbackError::Rejected("invalid userinfo response"))
    }
}

/// Starts a browser login. New logins need a valid license; existing sessions are
/// unaffected so authenticated users are not locked out when a license expires.
pub async fn login(State(app): State<Arc<App>>, parts: Parts) -> Response {
    if !app.license.currently_valid() {
        return found(&format!("{}?login_error=license_expired", app.home_url()));
    }
    let Some(oidc) = &app.oidc else {
        return json_error(StatusCode::NOT_FOUND, "not found");
    };
    let Some((url, sealed)) = oidc.begin() else {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, "Failed to start login");
    };
    let (_, secure) = app.cookie_flags(&parts.headers, &parts.extensions, &request_host(&parts));
    let mut response = found(&url);
    // Lax is required: the provider's redirect back is a cross-site navigation.
    set_cookie(
        &mut response,
        FLOW_COOKIE,
        sealed,
        SameSite::Lax,
        secure,
        FLOW_MAX_AGE,
    );
    response
}

#[derive(Deserialize)]
pub struct CallbackParams {
    code: Option<String>,
    state: Option<String>,
}

/// Handles the provider's redirect. Only query parameters are read, so a request
/// body cannot make this endpoint buffer or spool anything.
pub async fn callback(
    State(app): State<Arc<App>>,
    query: Result<Query<CallbackParams>, QueryRejection>,
    parts: Parts,
) -> Response {
    let ip = client_ip(&app, &parts.headers, &parts.extensions);
    let mut audit = Auditor::new(app.audit(), "auth.callback_failed", ip, None);
    let reject = |audit: &Auditor| {
        audit.denied("OIDC callback rejected before userinfo");
        json_error(StatusCode::UNAUTHORIZED, "Invalid OIDC response")
    };
    let (Some(oidc), Ok(Query(params))) = (&app.oidc, query) else {
        return reject(&audit);
    };
    let flow: Option<FlowState> = cookie_value(&parts.headers, FLOW_COOKIE)
        .and_then(|value| oidc.flow.open(FLOW_COOKIE, &value));
    let (Some(flow), Some(code), Some(state)) = (flow, params.code, params.state) else {
        return reject(&audit);
    };
    if !constant_time_digest_eq(flow.state.as_bytes(), state.as_bytes()) {
        return reject(&audit);
    }
    let info = match oidc.complete(flow, code).await {
        Ok(info) => info,
        Err(CallbackError::Rejected(reason)) => {
            tracing::info!(reason, "OIDC callback rejected");
            return reject(&audit);
        }
    };
    if info.sub.is_empty() {
        tracing::error!("OIDC userinfo missing subject claim");
        audit.failure("missing subject claim");
        return json_error(StatusCode::UNAUTHORIZED, "Invalid OIDC response");
    }
    audit.set_user(&info.email, &info.sub);
    if !app.settings.allow_unverified_email && !info.email_verified {
        tracing::info!("login rejected: email not verified by OIDC provider");
        audit.denied("email not verified");
        return (
            StatusCode::FORBIDDEN,
            "Login not permitted: your email is not verified by provider.",
        )
            .into_response();
    }
    if !app.email_allowed(&info.email) {
        tracing::info!("login rejected: email domain not permitted");
        audit.denied("email domain not permitted");
        return (
            StatusCode::FORBIDDEN,
            "Login not permitted: your email domain is not allowed on this server.",
        )
            .into_response();
    }
    let session = Session {
        id: random_hex(),
        sub: info.sub,
        email: info.email,
        name: info.name,
    };
    let sealed = app
        .sessions
        .as_ref()
        .and_then(|codec| codec.seal(SESSION_COOKIE, &session, SESSION_MAX_AGE));
    let Some(sealed) = sealed else {
        tracing::error!("failed to set session cookie");
        audit.failure("failed to create session");
        return json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to create session",
        );
    };
    audit
        .with_event("auth.callback_success")
        .success(Fields::default());
    let (same_site, secure) =
        app.cookie_flags(&parts.headers, &parts.extensions, &request_host(&parts));
    let mut response = found(&app.home_url());
    set_cookie(
        &mut response,
        SESSION_COOKIE,
        sealed,
        same_site,
        secure,
        SESSION_MAX_AGE,
    );
    set_cookie(
        &mut response,
        FLOW_COOKIE,
        String::new(),
        SameSite::Lax,
        secure,
        0,
    );
    response
}

/// Clears and revokes the session, then redirects home.
pub async fn logout(State(app): State<Arc<App>>, parts: Parts) -> Response {
    let ip = client_ip(&app, &parts.headers, &parts.extensions);
    // Split-origin requests are checked by the CORS middleware; SameSite alone
    // does not protect logout.
    if app.settings.frontend_url.is_empty() {
        let site = parts
            .headers
            .get("sec-fetch-site")
            .and_then(|v| v.to_str().ok());
        if !matches!(site, None | Some("same-origin" | "none")) {
            Auditor::new(app.audit(), "auth.logout", ip, None).denied("cross-origin request");
            return (StatusCode::FORBIDDEN, "origin not allowed").into_response();
        }
    }
    let session = app.cookie_session(&parts.headers).await;
    if let Some(session) = &session {
        app.revoke_session(&session.id).await;
    }
    Auditor::new(app.audit(), "auth.logout", ip, session.as_ref()).success(Fields::default());
    let (same_site, secure) =
        app.cookie_flags(&parts.headers, &parts.extensions, &request_host(&parts));
    // 303 so the browser follows up with GET instead of re-POSTing.
    let mut response = found(&app.home_url());
    set_cookie(
        &mut response,
        SESSION_COOKIE,
        String::new(),
        same_site,
        secure,
        0,
    );
    *response.status_mut() = StatusCode::SEE_OTHER;
    response
}

/// The current user, or 401. The domain is re-validated on every request so a
/// removal from the allow-list applies without waiting for sessions to expire.
pub async fn me(State(app): State<Arc<App>>, parts: Parts) -> Response {
    let Some(mut session) = app.session(&parts).await else {
        return no_store(json_error(StatusCode::UNAUTHORIZED, "unauthorized"));
    };
    if !app.email_allowed(&session.email) {
        return no_store(json_error(
            StatusCode::FORBIDDEN,
            "email domain not permitted",
        ));
    }
    session.id.clear();
    no_store(json_ok(&session))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn cached_at(fetched: Instant) -> JwksCache {
        JwksCache::new(CoreJsonWebKeySet::new(Vec::new()), fetched)
    }

    #[test]
    fn signing_key_cache_ages_in_stages() {
        let start = Instant::now();
        let cache = cached_at(start);
        // Fresh keys are served without a fetch.
        assert!(cache.is_fresh(
            start + JWKS_FRESH_FOR - Duration::from_secs(1),
            JWKS_FRESH_FOR
        ));
        assert!(!cache.is_fresh(start + JWKS_FRESH_FOR, JWKS_FRESH_FOR));
        // Past that they are only a fallback for a failed refetch, then not at all.
        assert!(
            cache
                .usable(start + JWKS_USABLE_FOR - Duration::from_secs(1))
                .is_some()
        );
        assert!(cache.usable(start + JWKS_USABLE_FOR).is_none());
    }

    #[test]
    fn signing_key_fetches_are_throttled() {
        let start = Instant::now();
        let cache = cached_at(start);
        assert!(!cache.may_fetch(start + Duration::from_secs(1), JWKS_REFETCH_AFTER));
        assert!(cache.may_fetch(start + JWKS_REFETCH_AFTER, JWKS_REFETCH_AFTER));
    }

    #[test]
    fn api_token_parsing() {
        let good = vec!["ci:0123456789abcdef".to_string()];
        assert_eq!(parse_api_tokens(&good).unwrap()[0].name, "ci");
        for bad in [":secretsecretsecret", "ci:", "nocolon", "ci:short"] {
            let error = parse_api_tokens(&[bad.to_string()]).err().unwrap();
            assert!(
                !error.contains("secretsecret") && !error.contains("short"),
                "{error}"
            );
        }
        let dup = vec![
            "a:0123456789abcdef".to_string(),
            "a:fedcba9876543210".to_string(),
        ];
        assert!(parse_api_tokens(&dup).is_err());
    }

    #[test]
    fn bearer_parsing() {
        let headers = |value: &str| {
            let mut map = HeaderMap::new();
            map.insert(AUTHORIZATION, value.parse().unwrap());
            map
        };
        assert_eq!(bearer_token(&headers("Bearer abc")), Some("abc"));
        assert_eq!(bearer_token(&headers("bearer abc ")), Some("abc"));
        assert_eq!(bearer_token(&headers("Basic abc")), None);
        assert_eq!(bearer_token(&headers("Bearer ")), None);
        assert_eq!(bearer_token(&HeaderMap::new()), None);
    }

    #[test]
    fn sealed_cookies_round_trip_and_resist_tampering() {
        let codec = CookieCodec::from_key([7; 32]);
        let sealed = codec.seal("a", &json!({"x": 1}), 60).unwrap();
        assert_eq!(
            codec.open::<serde_json::Value>("a", &sealed),
            Some(json!({"x": 1}))
        );
        // Bound to the cookie name, the key and the content.
        assert_eq!(codec.open::<serde_json::Value>("b", &sealed), None);
        assert_eq!(
            CookieCodec::from_key([8; 32]).open::<serde_json::Value>("a", &sealed),
            None
        );
        let mut raw = URL_SAFE_NO_PAD.decode(&sealed).unwrap();
        for index in [0, 12, raw.len() - 1] {
            raw[index] ^= 1;
            assert_eq!(
                codec.open::<serde_json::Value>("a", &URL_SAFE_NO_PAD.encode(&raw)),
                None
            );
            raw[index] ^= 1;
        }
        for garbage in ["", "abc", "!!!", "AAAA"] {
            assert_eq!(codec.open::<serde_json::Value>("a", garbage), None);
        }
    }

    #[test]
    fn sealed_cookies_expire() {
        let codec = CookieCodec::from_key([7; 32]);
        let sealed = codec.seal("a", &1, -1).unwrap();
        assert_eq!(codec.open::<i32>("a", &sealed), None);
    }

    #[test]
    fn nonces_differ_between_seals() {
        let codec = CookieCodec::from_key([7; 32]);
        assert_ne!(codec.seal("a", &1, 60), codec.seal("a", &1, 60));
    }

    #[test]
    fn key_derivation() {
        let master = "ab".repeat(64);
        let seal = |label| CookieCodec::derive(&master, label).key;
        assert_eq!(seal("x"), seal("x"));
        assert_ne!(seal("x"), seal("y"));
        // Invalid or empty keys fall back to random, never to something guessable.
        assert_ne!(
            CookieCodec::derive("", "x").key,
            CookieCodec::derive("", "x").key
        );
        assert_ne!(
            CookieCodec::derive("zz", "x").key,
            CookieCodec::derive("zz", "x").key
        );
    }

    #[test]
    fn origin_normalization() {
        assert_eq!(
            normalize_origin("https://EXAMPLE.com:443/path"),
            "https://example.com"
        );
        assert_eq!(
            normalize_origin("http://example.com:80"),
            "http://example.com"
        );
        assert_eq!(
            normalize_origin("http://example.com:8080"),
            "http://example.com:8080"
        );
        assert_eq!(normalize_origin("https://[::1]:443"), "https://[::1]");
        assert_eq!(normalize_origin("null"), "null");
        assert_eq!(normalize_host("https", "Example.com:443"), "example.com");
        assert_eq!(
            normalize_host("http", "example.com:8080"),
            "example.com:8080"
        );
        assert_eq!(normalize_host("ftp", "Example.com:21"), "example.com:21");
    }

    #[test]
    fn userinfo_accepts_string_booleans_without_trusting_other_values() {
        let parse = |json: &str| {
            serde_json::from_str::<UserInfo>(json)
                .unwrap()
                .email_verified
        };
        assert!(parse(r#"{"email_verified":true}"#));
        assert!(parse(r#"{"email_verified":"true"}"#));
        assert!(!parse(r#"{"email_verified":false}"#));
        assert!(!parse(r#"{"email_verified":"false"}"#));
        assert!(!parse(r#"{"email_verified":"yes"}"#));
        assert!(!parse(r#"{"email_verified":null}"#));
        assert!(!parse(r#"{}"#));
    }
}
