package server

import (
	"net/http"
	"net/url"

	"github.com/gorilla/handlers"
	"github.com/gorilla/mux"
	"github.com/gorilla/securecookie"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/zitadel/oidc/v3/pkg/client/rp"
	"go.uber.org/zap"
)

// Server struct holding database and settings.
// All configuration is carried in struct fields so the package can be used
// as a library without global state; cmd/yopass-server populates them from
// the CLI flags of the same names.
type Server struct {
	DB                  Database
	FileStore           FileStore
	MaxLength           int
	MaxFileSize         int64
	Registry            *prometheus.Registry
	ForceOneTimeSecrets bool
	AssetPath           string
	Logger              *zap.Logger
	TrustedProxies      []string
	Version             string
	License             LicenseStatus
	OIDCProvider        rp.RelyingParty
	CookieCodec         *securecookie.SecureCookie
	Audit               AuditLogger

	// Webhooks, when non-nil, receives secret lifecycle events
	// (license-gated, configured via --webhook-url).
	Webhooks *WebhookNotifier

	// Feature toggles
	Argon2                bool
	ReadOnly              bool
	DisableUpload         bool
	PrefetchSecret        bool
	DisableFeatures       bool
	NoLanguageSwitcher    bool
	DisableSecretRequests bool
	DisableReadReceipts   bool

	// Authentication
	RequireAuth         bool       // require authentication to create secrets
	AllowedEmailDomains []string   // restrict logins to these email domains
	APITokens           []APIToken // static bearer tokens for machine-to-machine creation

	// URLs and CORS
	CORSAllowOrigin  string
	FrontendURL      string
	PrivacyNoticeURL string
	ImprintURL       string
	PublicURL        string
	LogoURL          string

	// Branding and theming (license-gated)
	AppName          string
	ThemeLight       string
	ThemeDark        string
	ThemeCustomLight string
	ThemeCustomDark  string

	// DefaultExpiry is the default secret lifetime ("1h", "1d" or "1w").
	DefaultExpiry string

	// ForceExpiration, when non-empty, is the server-enforced secret lifetime
	// ("1h", "1d" or "1w"). Clients may not choose a different value.
	ForceExpiration string
}

// corsPreflight returns an OPTIONS handler advertising the given methods and
// request headers.
func corsPreflight(methods, headers string) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Access-Control-Allow-Methods", methods)
		if headers != "" {
			w.Header().Set("Access-Control-Allow-Headers", headers)
		}
	}
}

// HTTPHandler containing all routes
func (y *Server) HTTPHandler() http.Handler {
	if y.Audit == nil {
		y.Audit = NewNoopAuditLogger()
	}
	mx := mux.NewRouter()
	mx.Use(newMetricsMiddleware(y.Registry))
	mx.Use(y.corsMiddleware)

	secretOptions := corsPreflight("POST, OPTIONS", "Content-Type")
	requestOptions := corsPreflight("GET, POST, PUT, DELETE, OPTIONS", "Content-Type, "+requestTokenHeader)

	// Only register write endpoints if not in read-only mode
	if !y.ReadOnly {
		mx.Handle("/create/secret", y.maybeRequireAuth(y.createSecret)).Methods(http.MethodPost)
		mx.HandleFunc("/create/secret", secretOptions).Methods(http.MethodOptions)
	}

	// Secret request endpoints — business feature, requires a valid license.
	// Note the asymmetry on /request/{id}/secret: POST is the *responder*
	// fulfilling the request with an encrypted secret, GET is the *requester*
	// retrieving it (authorized by the management token header).
	// If the license expires at runtime, createSecretRequest rejects new
	// requests per request, while the remaining endpoints stay functional so
	// already-issued requests (TTL-bounded to at most a week) can drain
	// instead of stranding their participants.
	if y.secretRequestsEnabled() {
		mx.Handle("/request", y.maybeRequireAuth(y.createSecretRequest)).Methods(http.MethodPost)
		mx.HandleFunc("/request", requestOptions).Methods(http.MethodOptions)
		mx.HandleFunc("/request/"+keyParameter, y.getSecretRequest).Methods(http.MethodGet)
		mx.HandleFunc("/request/"+keyParameter, y.revokeSecretRequest).Methods(http.MethodDelete)
		mx.HandleFunc("/request/"+keyParameter, requestOptions).Methods(http.MethodOptions)
		mx.HandleFunc("/request/"+keyParameter+"/secret", y.fulfillSecretRequest).Methods(http.MethodPost)
		mx.HandleFunc("/request/"+keyParameter+"/secret", y.fetchRequestSecret).Methods(http.MethodGet)
		mx.HandleFunc("/request/"+keyParameter+"/secret", requestOptions).Methods(http.MethodOptions)
		mx.HandleFunc("/request/"+keyParameter+"/key", y.rotateRequestKey).Methods(http.MethodPut)
		mx.HandleFunc("/request/"+keyParameter+"/key", requestOptions).Methods(http.MethodOptions)
	}

	// Read endpoints - always available
	if y.PrefetchSecret {
		mx.HandleFunc("/secret/"+keyParameter+"/status", y.secretStatusHandler("", "secret.status_checked")).Methods(http.MethodGet)
	}
	mx.HandleFunc("/secret/"+keyParameter, y.getSecret).Methods(http.MethodGet)
	mx.HandleFunc("/secret/"+keyParameter, y.deleteSecretHandler("", "secret.deleted", false)).Methods(http.MethodDelete)

	// Read receipt status — registered unconditionally so receipts created on
	// a licensed write instance stay checkable through read-only replicas;
	// without receipts the endpoints simply return 404. Receipts are keyed by
	// the raw ID, so the /secret and /file routes share one handler.
	receiptOptions := corsPreflight("GET, OPTIONS", "Content-Type, "+receiptTokenHeader)
	mx.HandleFunc("/secret/"+keyParameter+"/receipt", y.getSecretReceipt).Methods(http.MethodGet)
	mx.HandleFunc("/secret/"+keyParameter+"/receipt", receiptOptions).Methods(http.MethodOptions)
	mx.HandleFunc("/file/"+keyParameter+"/receipt", y.getSecretReceipt).Methods(http.MethodGet)
	mx.HandleFunc("/file/"+keyParameter+"/receipt", receiptOptions).Methods(http.MethodOptions)

	mx.HandleFunc("/config", y.configHandler).Methods(http.MethodGet)
	mx.HandleFunc("/config", corsPreflight("GET, OPTIONS", "")).Methods(http.MethodOptions)

	// OIDC authentication routes — only registered when OIDC is configured
	if y.oidcEnabled() {
		mx.HandleFunc("/auth/login", y.oidcLoginHandler).Methods(http.MethodGet)
		mx.HandleFunc("/auth/callback", y.oidcCallbackHandler).Methods(http.MethodGet)
		mx.HandleFunc("/auth/logout", y.oidcLogoutHandler).Methods(http.MethodPost)
		mx.HandleFunc("/auth/me", y.oidcMeHandler).Methods(http.MethodGet)
	}

	// File upload/download endpoints
	if y.FileStore == nil && !y.DisableUpload {
		y.FileStore = NewDatabaseFileStore(y.DB)
	}
	if !y.ReadOnly && !y.DisableUpload {
		mx.Handle("/create/file", y.maybeRequireAuth(y.streamUpload)).Methods(http.MethodPost)
		mx.HandleFunc("/create/file", y.streamOptions).Methods(http.MethodOptions)
	}
	if !y.DisableUpload {
		mx.HandleFunc("/file/"+keyParameter, y.streamDownload).Methods(http.MethodGet)
		mx.HandleFunc("/file/"+keyParameter, y.streamOptions).Methods(http.MethodOptions)
		mx.HandleFunc("/file/"+keyParameter, y.deleteSecretHandler(streamKeyPrefix, "file.deleted", true)).Methods(http.MethodDelete)
		if y.PrefetchSecret {
			mx.HandleFunc("/file/"+keyParameter+"/status", y.secretStatusHandler(streamKeyPrefix, "file.status_checked")).Methods(http.MethodGet)
		}
	}

	mx.HandleFunc("/health", y.healthHandler).Methods(http.MethodGet, http.MethodHead)
	mx.HandleFunc("/ready", y.readyHandler).Methods(http.MethodGet, http.MethodHead)
	mx.HandleFunc("/version", y.versionHandler).Methods(http.MethodGet)
	mx.HandleFunc("/logo", y.logoHandler).Methods(http.MethodGet)

	mx.PathPrefix("/").Handler(http.FileServer(http.Dir(y.AssetPath)))

	var extraImgSrc []string
	if y.LogoURL != "" {
		if u, err := url.Parse(y.LogoURL); err == nil && u.IsAbs() && u.Host != "" {
			extraImgSrc = []string{u.Scheme + "://" + u.Host}
		}
	}
	return handlers.CustomLoggingHandler(nil, SecurityHeadersHandler(extraImgSrc, y.Argon2, mx), y.httpLogFormatter(mx))
}

const keyParameter = "{key:(?:[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}|[a-zA-Z0-9]{22})}"
