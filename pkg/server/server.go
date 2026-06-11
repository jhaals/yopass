package server

import (
	"encoding/json"
	"net/http"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/ProtonMail/go-crypto/openpgp/armor"
	"github.com/gorilla/handlers"
	"github.com/gorilla/mux"
	"github.com/gorilla/securecookie"
	"github.com/jhaals/yopass/pkg/yopass"
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

	// Feature toggles
	ReadOnly              bool
	DisableUpload         bool
	PrefetchSecret        bool
	DisableFeatures       bool
	NoLanguageSwitcher    bool
	DisableSecretRequests bool

	// Authentication
	RequireAuth         bool     // require authentication to create secrets
	AllowedEmailDomains []string // restrict logins to these email domains

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

	// requestMu serializes load → check → store sequences on secret requests
	// so two concurrent fulfillments cannot both pass the pending check and
	// silently overwrite each other. Guards a single instance only; the
	// database layer has no compare-and-swap.
	requestMu sync.Mutex
}

// jsonError writes a {"message": ...} error body with the given status code
// and a correct application/json content type.
func jsonError(w http.ResponseWriter, code int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	if err := json.NewEncoder(w).Encode(map[string]string{"message": message}); err != nil {
		zap.L().Error("Failed to write error response", zap.Error(err))
	}
}

// authorizeSecretAccess enforces RequireAuth for secret retrieval and
// deletion. It writes the error response and audit event itself and reports
// whether the request may proceed.
func (y *Server) authorizeSecretAccess(w http.ResponseWriter, secret yopass.Secret, session *sessionData, sessionErr error, audit *auditor) bool {
	if !secret.RequireAuth {
		return true
	}
	if sessionErr != nil || session == nil {
		audit.denied("authentication required", withRequireAuth(true))
		jsonError(w, http.StatusUnauthorized, "authentication required")
		return false
	}
	if !y.emailAllowed(session.Email) {
		audit.denied("email domain not permitted", withRequireAuth(true))
		jsonError(w, http.StatusForbidden, "email domain not permitted")
		return false
	}
	return true
}

// claimOneTimeSecret atomically claims a one-time secret by deleting its
// database key before the content is served. Delete returns false when the
// key is already gone, meaning a concurrent request claimed the secret first.
// It writes the error response and audit event itself and reports whether the
// caller now owns the secret.
func (y *Server) claimOneTimeSecret(w http.ResponseWriter, dbKey string, audit *auditor) bool {
	deleted, err := y.DB.Delete(dbKey)
	if err != nil {
		y.Logger.Error("Failed to claim one-time secret", zap.Error(err))
		audit.failure("failed to claim one-time secret", withOneTime(true))
		jsonError(w, http.StatusInternalServerError, "Failed to process secret")
		return false
	}
	if !deleted {
		audit.denied("claimed by concurrent request", withOneTime(true))
		jsonError(w, http.StatusNotFound, "Secret not found")
		return false
	}
	return true
}

// createSecret validates and stores a new PGP-encrypted secret, responding
// with the generated secret ID.
func (y *Server) createSecret(w http.ResponseWriter, request *http.Request) {
	session, _ := y.getSession(request)
	audit := y.newAuditor("secret.created", y.getRealClientIP(request), session)

	decoder := json.NewDecoder(request.Body)
	var s yopass.Secret
	if err := decoder.Decode(&s); err != nil {
		y.Logger.Debug("Unable to decode request", zap.Error(err))
		jsonError(w, http.StatusBadRequest, "Unable to parse json")
		return
	}

	if !isPGPEncrypted(s.Message) {
		audit.failure("message not PGP encrypted")
		jsonError(w, http.StatusBadRequest, "Message must be PGP encrypted")
		return
	}

	if !validExpiration(s.Expiration) {
		audit.failure("invalid expiration")
		jsonError(w, http.StatusBadRequest, "Invalid expiration specified")
		return
	}

	if y.ForceExpiration != "" {
		forced := expirationInSeconds(y.ForceExpiration)
		if s.Expiration != forced {
			audit.failure("expiration does not match forced value")
			jsonError(w, http.StatusBadRequest, "Expiration does not match server policy")
			return
		}
	}

	if s.RequireAuth && y.OIDCProvider == nil {
		audit.failure("auth required but OIDC not configured")
		jsonError(w, http.StatusBadRequest, "Authentication not configured on this server")
		return
	}

	if !s.OneTime && y.ForceOneTimeSecrets {
		audit.failure("one-time required by server policy")
		jsonError(w, http.StatusBadRequest, "Secret must be one time download")
		return
	}

	if len(s.Message) > y.MaxLength {
		audit.failure("message too long")
		jsonError(w, http.StatusBadRequest, "The encrypted message is too long")
		return
	}

	key, err := yopass.GenerateID()
	if err != nil {
		y.Logger.Error("Unable to generate ID", zap.Error(err))
		audit.failure("failed to generate ID")
		jsonError(w, http.StatusInternalServerError, "Unable to generate ID")
		return
	}
	audit.setSecretID(key)

	// store secret in database with specified expiration.
	if err := y.DB.Put(key, s); err != nil {
		y.Logger.Error("Unable to store secret", zap.Error(err))
		audit.failure("database error")
		jsonError(w, http.StatusInternalServerError, "Failed to store secret in database")
		return
	}

	audit.success(withOneTime(s.OneTime), withExpiration(s.Expiration), withRequireAuth(s.RequireAuth))
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(map[string]string{"message": key}); err != nil {
		y.Logger.Error("Failed to write response", zap.Error(err))
	}
}

// getSecret returns a secret, consuming it when it is one-time.
func (y *Server) getSecret(w http.ResponseWriter, request *http.Request) {
	w.Header().Set("Cache-Control", "private, no-cache")

	secretKey := mux.Vars(request)["key"]
	session, sessionErr := y.getSession(request)
	audit := y.newAuditor("secret.accessed", y.getRealClientIP(request), session)
	audit.setSecretID(secretKey)

	// Use Status (non-destructive) so auth is checked before one-time secrets are consumed.
	secret, err := y.DB.Status(secretKey)
	if err != nil {
		y.Logger.Debug("Secret not found", zap.Error(err))
		audit.failure("not found")
		jsonError(w, http.StatusNotFound, "Secret not found")
		return
	}

	if !y.authorizeSecretAccess(w, secret, session, sessionErr, audit) {
		return
	}

	if secret.OneTime && !y.claimOneTimeSecret(w, secretKey, audit) {
		return
	}

	data, err := secret.ToJSON()
	if err != nil {
		y.Logger.Error("Failed to encode request", zap.Error(err))
		jsonError(w, http.StatusInternalServerError, "Failed to encode secret")
		return
	}

	// Log success before writing: for one-time secrets the secret has already
	// been deleted, so the meaningful outcome (consumed) is already determined.
	// Logging after a write failure would record the wrong outcome.
	audit.success(withOneTime(secret.OneTime), withRequireAuth(secret.RequireAuth))
	if _, err := w.Write(data); err != nil {
		y.Logger.Error("Failed to write response", zap.Error(err))
	}
}

// getSecretStatus returns minimal status for a secret without returning the secret content
func (y *Server) getSecretStatus(w http.ResponseWriter, request *http.Request) {
	w.Header().Set("Cache-Control", "private, no-cache")
	w.Header().Set("Content-Type", "application/json")

	secretKey := mux.Vars(request)["key"]
	session, _ := y.getSession(request)
	audit := y.newAuditor("secret.status_checked", y.getRealClientIP(request), session)
	audit.setSecretID(secretKey)

	secret, err := y.DB.Status(secretKey)
	if err != nil {
		y.Logger.Debug("Secret not found", zap.Error(err))
		audit.failure("not found")
		jsonError(w, http.StatusNotFound, "Secret not found")
		return
	}

	audit.success(withOneTime(secret.OneTime), withRequireAuth(secret.RequireAuth))
	resp := map[string]bool{"oneTime": secret.OneTime, "requireAuth": secret.RequireAuth}
	if err := json.NewEncoder(w).Encode(resp); err != nil {
		y.Logger.Error("Failed to write status response", zap.Error(err))
	}
}

// deleteSecret removes a secret ahead of its expiration, enforcing
// RequireAuth before the deletion is allowed.
func (y *Server) deleteSecret(w http.ResponseWriter, request *http.Request) {
	secretKey := mux.Vars(request)["key"]
	session, sessionErr := y.getSession(request)
	audit := y.newAuditor("secret.deleted", y.getRealClientIP(request), session)
	audit.setSecretID(secretKey)

	// Check metadata first to enforce RequireAuth before allowing deletion.
	secret, err := y.DB.Status(secretKey)
	if err != nil {
		audit.failure("not found")
		jsonError(w, http.StatusNotFound, "Secret not found")
		return
	}

	if !y.authorizeSecretAccess(w, secret, session, sessionErr, audit) {
		return
	}

	deleted, err := y.DB.Delete(secretKey)
	if err != nil {
		audit.failure("database error")
		jsonError(w, http.StatusInternalServerError, "Failed to delete secret")
		return
	}

	if !deleted {
		audit.failure("not found")
		jsonError(w, http.StatusNotFound, "Secret not found")
		return
	}

	audit.success()
	w.WriteHeader(http.StatusNoContent)
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

func (y *Server) configHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Headers", "content-type")
	w.Header().Set("Content-Type", "application/json")

	config := map[string]interface{}{
		"DISABLE_UPLOAD":        y.DisableUpload,
		"READ_ONLY":             y.ReadOnly,
		"PREFETCH_SECRET":       y.PrefetchSecret,
		"DISABLE_FEATURES":      y.DisableFeatures,
		"NO_LANGUAGE_SWITCHER":  y.NoLanguageSwitcher,
		"FORCE_ONETIME_SECRETS": y.ForceOneTimeSecrets,
		"DEFAULT_EXPIRY":        expirationInSeconds(y.DefaultExpiry),
	}
	if y.ForceExpiration != "" {
		config["FORCE_EXPIRATION"] = expirationInSeconds(y.ForceExpiration)
	}
	if y.MaxFileSize > 0 {
		config["MAX_FILE_SIZE"] = FormatSize(y.MaxFileSize)
	}

	// Add optional string URLs only if they are provided
	if y.PrivacyNoticeURL != "" {
		config["PRIVACY_NOTICE_URL"] = y.PrivacyNoticeURL
	}
	if y.ImprintURL != "" {
		config["IMPRINT_URL"] = y.ImprintURL
	}
	if y.PublicURL != "" {
		config["PUBLIC_URL"] = y.PublicURL
	}
	if y.License.Valid && y.LogoURL != "" {
		config["LOGO_URL"] = y.LogoURL
	}

	oidcEnabled := y.OIDCProvider != nil
	config["OIDC_ENABLED"] = oidcEnabled
	config["REQUIRE_AUTH"] = oidcEnabled && y.RequireAuth
	config["SECRET_REQUESTS"] = y.secretRequestsEnabled()

	if y.License.Valid {
		config["THEME_LIGHT"] = y.ThemeLight
		config["THEME_DARK"] = y.ThemeDark

		if y.ThemeCustomLight != "" {
			var vars map[string]string
			if err := json.Unmarshal([]byte(y.ThemeCustomLight), &vars); err == nil {
				config["THEME_CUSTOM_LIGHT"] = vars
			}
		}
		if y.ThemeCustomDark != "" {
			var vars map[string]string
			if err := json.Unmarshal([]byte(y.ThemeCustomDark), &vars); err == nil {
				config["THEME_CUSTOM_DARK"] = vars
			}
		}

		if y.AppName != "" {
			config["APP_NAME"] = y.AppName
		}
	} else {
		config["THEME_LIGHT"] = "emerald"
		config["THEME_DARK"] = "dim"
	}

	if err := json.NewEncoder(w).Encode(config); err != nil {
		y.Logger.Error("Failed to encode config response", zap.Error(err))
	}
}

// logoHandler serves the built-in yopass.svg logo.
func (y *Server) logoHandler(w http.ResponseWriter, r *http.Request) {
	http.ServeFile(w, r, filepath.Join(y.AssetPath, "yopass.svg"))
}

// versionHandler returns the server version
func (y *Server) versionHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	version := y.Version
	if version == "" {
		version = "unknown"
	}
	if err := json.NewEncoder(w).Encode(map[string]string{
		"version": version,
	}); err != nil {
		y.Logger.Error("Failed to write response", zap.Error(err))
	}
}

// healthHandler performs liveness check (shallow check - process is alive)
func (y *Server) healthHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")

	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(map[string]string{
		"status": "healthy",
	}); err != nil {
		y.Logger.Error("Failed to write response", zap.Error(err))
	}
}

// readyHandler performs readiness check (deep check - can handle traffic)
func (y *Server) readyHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")

	if y.DB == nil {
		y.Logger.Warn("Readiness check failed: database is nil")
		w.WriteHeader(http.StatusServiceUnavailable)
		if err := json.NewEncoder(w).Encode(map[string]string{
			"status": "not ready",
			"error":  "database not configured",
		}); err != nil {
			y.Logger.Error("Failed to write response", zap.Error(err))
		}
		return
	}

	if err := y.DB.Health(); err != nil {
		y.Logger.Debug("Readiness check failed", zap.Error(err))
		w.WriteHeader(http.StatusServiceUnavailable)
		if err := json.NewEncoder(w).Encode(map[string]string{
			"status": "not ready",
			"error":  "database connectivity failed",
		}); err != nil {
			y.Logger.Error("Failed to write response", zap.Error(err))
		}
		return
	}

	if y.FileStore != nil {
		if err := y.FileStore.Health(r.Context()); err != nil {
			y.Logger.Debug("Readiness check failed: file store", zap.Error(err))
			w.WriteHeader(http.StatusServiceUnavailable)
			if err := json.NewEncoder(w).Encode(map[string]string{
				"status": "not ready",
				"error":  "file store connectivity failed",
			}); err != nil {
				y.Logger.Error("Failed to write response", zap.Error(err))
			}
			return
		}
	}

	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(map[string]string{
		"status": "ready",
	}); err != nil {
		y.Logger.Error("Failed to write response", zap.Error(err))
	}
}

// secretRequestsEnabled reports whether the secret request feature is active:
// it requires a valid license and is unavailable in read-only mode.
func (y *Server) secretRequestsEnabled() bool {
	return y.License.Valid && !y.ReadOnly && !y.DisableSecretRequests
}

// maybeRequireAuth wraps a handler with requireAuthMiddleware when OIDC is
// configured and the --require-auth flag is set. Otherwise it returns the
// handler as-is.
func (y *Server) maybeRequireAuth(h http.HandlerFunc) http.Handler {
	if y.OIDCProvider != nil && y.RequireAuth {
		return y.requireAuthMiddleware(h)
	}
	return h
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
		mx.HandleFunc("/secret/"+keyParameter+"/status", y.getSecretStatus).Methods(http.MethodGet)
	}
	mx.HandleFunc("/secret/"+keyParameter, y.getSecret).Methods(http.MethodGet)
	mx.HandleFunc("/secret/"+keyParameter, y.deleteSecret).Methods(http.MethodDelete)

	mx.HandleFunc("/config", y.configHandler).Methods(http.MethodGet)
	mx.HandleFunc("/config", corsPreflight("GET, OPTIONS", "")).Methods(http.MethodOptions)

	// OIDC authentication routes — only registered when OIDC is configured
	if y.OIDCProvider != nil {
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
		mx.HandleFunc("/file/"+keyParameter, y.deleteStreamSecret).Methods(http.MethodDelete)
		if y.PrefetchSecret {
			mx.HandleFunc("/file/"+keyParameter+"/status", y.getStreamSecretStatus).Methods(http.MethodGet)
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
	return handlers.CustomLoggingHandler(nil, SecurityHeadersHandler(extraImgSrc, mx), y.httpLogFormatter())
}

const keyParameter = "{key:(?:[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}|[a-zA-Z0-9]{22})}"

// expirations is the single source of truth for the supported secret
// lifetimes, mapping the human-readable form to seconds.
var expirations = map[string]int32{
	"1h": 3600,
	"1d": 86400,
	"1w": 604800,
}

// ValidExpiryString reports whether s is a supported human-readable expiry
// duration ("1h", "1d" or "1w").
func ValidExpiryString(s string) bool {
	_, ok := expirations[s]
	return ok
}

// validExpiration reports whether expiration matches one of the supported
// lifetimes in seconds.
func validExpiration(expiration int32) bool {
	for _, ttl := range expirations {
		if ttl == expiration {
			return true
		}
	}
	return false
}

// expirationInSeconds converts a human-readable expiry duration string
// [1h, 1d, 1w] to its equivalent in seconds, defaulting to one hour.
func expirationInSeconds(s string) int32 {
	if ttl, ok := expirations[s]; ok {
		return ttl
	}
	return expirations["1h"]
}

// isPGPEncrypted verifies that the provided content is a valid PGP encrypted message
func isPGPEncrypted(content string) bool {
	if content == "" {
		return false
	}

	// Try to decode the armored PGP message
	_, err := armor.Decode(strings.NewReader(content))
	return err == nil
}

// corsMiddleware returns a middleware which sets CORS headers on all responses
func (y *Server) corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if y.FrontendURL != "" {
			// Credentialed cross-origin requests require a specific origin (not wildcard)
			// and Access-Control-Allow-Credentials: true.
			// Browsers send Origin as scheme://host (no path), so strip any path.
			origin := y.FrontendURL
			if u, err := url.Parse(y.FrontendURL); err == nil && u.Host != "" {
				origin = u.Scheme + "://" + u.Host
			}
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Credentials", "true")
			// Vary: Origin tells caches that the response differs by origin so they
			// do not serve a cached CORS response to a different requester.
			w.Header().Add("Vary", "Origin")
		} else {
			w.Header().Set("Access-Control-Allow-Origin", y.CORSAllowOrigin)
		}
		next.ServeHTTP(w, r)
	})
}

// SecurityHeadersHandler returns a middleware which sets common security
// HTTP headers on the response to mitigate common web vulnerabilities.
// extraImgSrc extends the img-src CSP directive with additional allowed origins.
func SecurityHeadersHandler(extraImgSrc []string, next http.Handler) http.Handler {
	imgSrc := append([]string{"'self'", "data:"}, extraImgSrc...)
	csp := []string{
		"default-src 'self'",
		"font-src 'self' data:",
		"form-action 'self'",
		"frame-ancestors 'none'",
		"img-src " + strings.Join(imgSrc, " "),
		"script-src 'self'",
		"style-src 'self' 'unsafe-inline'",
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-security-policy", strings.Join(csp, "; "))
		w.Header().Set("referrer-policy", "no-referrer")
		w.Header().Set("x-content-type-options", "nosniff")
		w.Header().Set("x-frame-options", "DENY")
		w.Header().Set("x-xss-protection", "1; mode=block")
		if r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https" {
			w.Header().Set("strict-transport-security", "max-age=31536000")
		}
		next.ServeHTTP(w, r)
	})
}

// newMetricsHandler creates a middleware handler recording all HTTP requests in
// the given Prometheus registry
func newMetricsMiddleware(reg prometheus.Registerer) func(http.Handler) http.Handler {
	requests := prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "yopass_http_requests_total",
			Help: "Total number of requests served by HTTP method, path and response code.",
		},
		[]string{"method", "path", "code"},
	)
	reg.MustRegister(requests)

	duration := prometheus.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "yopass_http_request_duration_seconds",
			Help:    "Histogram of HTTP request latencies by method and path.",
			Buckets: prometheus.DefBuckets,
		},
		[]string{"method", "path"},
	)
	reg.MustRegister(duration)

	return func(handler http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			rec := statusCodeRecorder{ResponseWriter: w, statusCode: http.StatusOK}
			handler.ServeHTTP(&rec, r)
			path := normalizedPath(r)
			requests.WithLabelValues(r.Method, path, strconv.Itoa(rec.statusCode)).Inc()
			duration.WithLabelValues(r.Method, path).Observe(time.Since(start).Seconds())
		})
	}
}

// normalizedPath returns a normalized mux path template representation
func normalizedPath(r *http.Request) string {
	if route := mux.CurrentRoute(r); route != nil {
		if tmpl, err := route.GetPathTemplate(); err == nil {
			return strings.ReplaceAll(tmpl, keyParameter, ":key")
		}
	}
	return "<other>"
}

// statusCodeRecorder is a HTTP ResponseWriter recording the response code
type statusCodeRecorder struct {
	http.ResponseWriter
	statusCode int
}

// WriteHeader implements http.ResponseWriter
func (rw *statusCodeRecorder) WriteHeader(code int) {
	rw.ResponseWriter.WriteHeader(code)
	rw.statusCode = code
}

// Flush implements http.Flusher so the wrapper does not hide the underlying
// writer's streaming capability from handlers.
func (rw *statusCodeRecorder) Flush() {
	if f, ok := rw.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}
