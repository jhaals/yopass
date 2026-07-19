package server

import (
	"encoding/json"
	"net/http"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
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

// jsonError writes a {"message": ...} error body with the given status code
// and a correct application/json content type.
func jsonError(w http.ResponseWriter, code int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	if err := json.NewEncoder(w).Encode(map[string]string{"message": message}); err != nil {
		zap.L().Error("Failed to write error response", zap.Error(err))
	}
}

// writeJSON writes v as a JSON response body with the given status code and
// a correct application/json content type, logging encode failures.
func (y *Server) writeJSON(w http.ResponseWriter, code int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		y.Logger.Error("Failed to write response", zap.Error(err))
	}
}

// oidcEnabled reports whether OIDC authentication is configured. Deliberately
// not gated on the license expiring at runtime: authentication is security
// infrastructure, so dropping it mid-run would strip protection from — and
// strand access to — secrets created with RequireAuth. The hard license gate
// for OIDC applies at startup (cmd/yopass-server validateFlags).
func (y *Server) oidcEnabled() bool {
	return y.OIDCProvider != nil
}

// UnlicensedMaxFileSize is the upload size cap for servers without a
// currently valid license. cmd/yopass-server applies it at startup;
// effectiveMaxFileSize re-applies it when a license expires at runtime.
const UnlicensedMaxFileSize int64 = 1 * 1024 * 1024

// effectiveMaxFileSize returns the upload size limit honoring runtime license
// expiry: a limit that was only permitted by a license (>1MB) falls back to
// the unlicensed cap once the license is no longer valid.
func (y *Server) effectiveMaxFileSize() int64 {
	if y.MaxFileSize > UnlicensedMaxFileSize && !y.License.CurrentlyValid() {
		return UnlicensedMaxFileSize
	}
	return y.MaxFileSize
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

// creationPolicy holds the client-requested attributes common to text secret
// and file creation, validated against server policy by checkCreationPolicy.
type creationPolicy struct {
	expiration  int32
	oneTime     bool
	requireAuth bool
	receipt     bool
}

// checkCreationPolicy enforces the server-side creation policy shared by
// /create/secret and /create/file. It writes the error response and audit
// event itself and reports whether the request may proceed.
func (y *Server) checkCreationPolicy(w http.ResponseWriter, p creationPolicy, audit *auditor) bool {
	if p.receipt && !y.readReceiptsEnabled() {
		audit.failure("read receipts not enabled")
		jsonError(w, http.StatusBadRequest, "Read receipts are not enabled on this server")
		return false
	}
	if !validExpiration(p.expiration) {
		audit.failure("invalid expiration")
		jsonError(w, http.StatusBadRequest, "Invalid expiration specified")
		return false
	}
	if y.ForceExpiration != "" && p.expiration != expirationInSeconds(y.ForceExpiration) {
		audit.failure("expiration does not match forced value")
		jsonError(w, http.StatusBadRequest, "Expiration does not match server policy")
		return false
	}
	if p.requireAuth && !y.oidcEnabled() {
		audit.failure("auth required but OIDC not configured")
		jsonError(w, http.StatusBadRequest, "Authentication not configured on this server")
		return false
	}
	if !p.oneTime && y.ForceOneTimeSecrets {
		audit.failure("one-time required by server policy")
		jsonError(w, http.StatusBadRequest, "Secret must be one time download")
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
	var body struct {
		yopass.Secret
		Receipt bool `json:"receipt"`
	}
	if err := decoder.Decode(&body); err != nil {
		y.Logger.Debug("Unable to decode request", zap.Error(err))
		jsonError(w, http.StatusBadRequest, "Unable to parse json")
		return
	}
	s := body.Secret

	if !y.checkCreationPolicy(w, creationPolicy{
		expiration:  s.Expiration,
		oneTime:     s.OneTime,
		requireAuth: s.RequireAuth,
		receipt:     body.Receipt,
	}, audit) {
		return
	}

	if !isPGPEncrypted(s.Message) {
		audit.failure("message not PGP encrypted")
		jsonError(w, http.StatusBadRequest, "Message must be PGP encrypted")
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

	// Store the receipt before the secret: if it fails the request aborts
	// without leaving a secret that silently lacks its requested receipt.
	response := map[string]string{"message": key}
	if body.Receipt {
		token, err := y.createReceipt(key, s.OneTime, s.Expiration)
		if err != nil {
			y.Logger.Error("Unable to store read receipt", zap.Error(err))
			audit.failure("failed to store receipt")
			jsonError(w, http.StatusInternalServerError, "Failed to store receipt in database")
			return
		}
		response["receipt_token"] = token
	}

	// store secret in database with specified expiration.
	if err := y.DB.Put(key, s); err != nil {
		y.Logger.Error("Unable to store secret", zap.Error(err))
		audit.failure("database error")
		jsonError(w, http.StatusInternalServerError, "Failed to store secret in database")
		return
	}

	audit.success(withOneTime(s.OneTime), withExpiration(s.Expiration), withRequireAuth(s.RequireAuth))
	y.webhookCreated(key, WebhookKindSecret, s.OneTime, s.Expiration)
	y.writeJSON(w, http.StatusOK, response)
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
	y.markReceiptViewed(secretKey)
	y.webhookViewed(secretKey, WebhookKindSecret, secret.OneTime)
	if _, err := w.Write(data); err != nil {
		y.Logger.Error("Failed to write response", zap.Error(err))
	}
}

// secretStatusHandler returns the handler for the non-destructive status
// endpoint. Text secrets and files share it; they differ only in database
// key prefix and audit event name.
func (y *Server) secretStatusHandler(keyPrefix, auditEvent string) http.HandlerFunc {
	return func(w http.ResponseWriter, request *http.Request) {
		w.Header().Set("Cache-Control", "private, no-cache")

		key := mux.Vars(request)["key"]
		session, _ := y.getSession(request)
		audit := y.newAuditor(auditEvent, y.getRealClientIP(request), session)
		audit.setSecretID(key)

		secret, err := y.DB.Status(keyPrefix + key)
		if err != nil {
			y.Logger.Debug("Secret not found", zap.Error(err))
			audit.failure("not found")
			jsonError(w, http.StatusNotFound, "Secret not found")
			return
		}

		audit.success(withOneTime(secret.OneTime), withRequireAuth(secret.RequireAuth))
		y.writeJSON(w, http.StatusOK, map[string]bool{
			"oneTime":     secret.OneTime,
			"requireAuth": secret.RequireAuth,
		})
	}
}

// deleteSecretHandler returns the handler removing a secret ahead of its
// expiration, enforcing RequireAuth before the deletion is allowed. Text
// secrets and files share it; files additionally remove the stored blob
// (deleteBlob) after the metadata key is gone.
func (y *Server) deleteSecretHandler(keyPrefix, auditEvent string, deleteBlob bool) http.HandlerFunc {
	return func(w http.ResponseWriter, request *http.Request) {
		key := mux.Vars(request)["key"]
		session, sessionErr := y.getSession(request)
		audit := y.newAuditor(auditEvent, y.getRealClientIP(request), session)
		audit.setSecretID(key)

		// Check metadata first to enforce RequireAuth before allowing deletion.
		secret, err := y.DB.Status(keyPrefix + key)
		if err != nil {
			audit.failure("not found")
			jsonError(w, http.StatusNotFound, "Secret not found")
			return
		}

		if !y.authorizeSecretAccess(w, secret, session, sessionErr, audit) {
			return
		}

		deleted, err := y.DB.Delete(keyPrefix + key)
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

		if deleteBlob {
			if err := y.FileStore.Delete(request.Context(), key); err != nil {
				y.Logger.Error("Failed to delete streaming file", zap.Error(err))
				audit.failure("failed to delete file from store")
				jsonError(w, http.StatusInternalServerError, "Failed to delete secret file")
				return
			}
		}

		audit.success()
		y.webhookDeleted(key)
		w.WriteHeader(http.StatusNoContent)
	}
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
		"ARGON2":                y.Argon2,
	}
	if y.ForceExpiration != "" {
		config["FORCE_EXPIRATION"] = expirationInSeconds(y.ForceExpiration)
	}
	if maxFileSize := y.effectiveMaxFileSize(); maxFileSize > 0 {
		config["MAX_FILE_SIZE"] = FormatSize(maxFileSize)
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
	if y.License.CurrentlyValid() && y.LogoURL != "" {
		config["LOGO_URL"] = y.LogoURL
	}

	config["OIDC_ENABLED"] = y.oidcEnabled()
	config["REQUIRE_AUTH"] = y.oidcEnabled() && y.RequireAuth
	config["SECRET_REQUESTS"] = y.secretRequestsEnabled()
	// File responses to secret requests have their own, stricter size limit
	// (they are stored in the database backend, not the file store).
	if y.secretRequestsEnabled() && !y.DisableUpload {
		config["MAX_REQUEST_FILE_SIZE"] = FormatSize(y.effectiveRequestFileSize())
	}
	// The toggle is only useful where secrets can be created, so read-only
	// instances report false even with a valid license.
	config["READ_RECEIPTS"] = y.readReceiptsEnabled() && !y.ReadOnly

	if y.License.CurrentlyValid() {
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
		config["THEME_LIGHT"] = DefaultThemeLight
		config["THEME_DARK"] = DefaultThemeDark
	}

	y.writeJSON(w, http.StatusOK, config)
}

// logoHandler serves the built-in yopass.svg logo.
func (y *Server) logoHandler(w http.ResponseWriter, r *http.Request) {
	http.ServeFile(w, r, filepath.Join(y.AssetPath, "yopass.svg"))
}

// versionHandler returns the server version
func (y *Server) versionHandler(w http.ResponseWriter, r *http.Request) {
	version := y.Version
	if version == "" {
		version = "unknown"
	}
	y.writeJSON(w, http.StatusOK, map[string]string{"version": version})
}

// healthHandler performs liveness check (shallow check - process is alive)
func (y *Server) healthHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
	y.writeJSON(w, http.StatusOK, map[string]string{"status": "healthy"})
}

// readyHandler performs readiness check (deep check - can handle traffic)
func (y *Server) readyHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")

	notReady := func(logMsg, reason string, err error) {
		y.Logger.Debug(logMsg, zap.Error(err))
		y.writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"status": "not ready",
			"error":  reason,
		})
	}

	if y.DB == nil {
		y.Logger.Warn("Readiness check failed: database is nil")
		y.writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"status": "not ready",
			"error":  "database not configured",
		})
		return
	}

	if err := y.DB.Health(); err != nil {
		notReady("Readiness check failed", "database connectivity failed", err)
		return
	}

	if y.FileStore != nil {
		if err := y.FileStore.Health(r.Context()); err != nil {
			notReady("Readiness check failed: file store", "file store connectivity failed", err)
			return
		}
	}

	y.writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
}

// secretRequestsEnabled reports whether the secret request feature is active:
// it requires a currently valid license and is unavailable in read-only mode.
// Checked both at route registration and per request, so creating new
// requests stops as soon as the license expires.
func (y *Server) secretRequestsEnabled() bool {
	return y.License.CurrentlyValid() && !y.ReadOnly && !y.DisableSecretRequests
}

// maybeRequireAuth wraps a handler with requireAuthMiddleware when OIDC is
// configured and the --require-auth flag is set. Otherwise it returns the
// handler as-is.
func (y *Server) maybeRequireAuth(h http.HandlerFunc) http.Handler {
	if y.oidcEnabled() && y.RequireAuth {
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
	return handlers.CustomLoggingHandler(nil, SecurityHeadersHandler(extraImgSrc, y.Argon2, mx), y.httpLogFormatter())
}

const keyParameter = "{key:(?:[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}|[a-zA-Z0-9]{22})}"

// DefaultThemeLight and DefaultThemeDark are the built-in DaisyUI themes used
// when no valid license overrides them. cmd/yopass-server uses them as the
// defaults for the --theme-light and --theme-dark flags.
const (
	DefaultThemeLight = "emerald"
	DefaultThemeDark  = "dim"
)

// The supported secret lifetimes live in pkg/yopass so the server and the
// CLI client share one table; these helpers adapt it to this package's needs.

// ValidExpiryString reports whether s is a supported human-readable expiry
// duration ("1h", "1d" or "1w").
func ValidExpiryString(s string) bool {
	_, ok := yopass.ExpirationSeconds(s)
	return ok
}

// validExpiration reports whether expiration matches one of the supported
// lifetimes in seconds.
func validExpiration(expiration int32) bool {
	return yopass.ValidExpirationSeconds(expiration)
}

// expirationInSeconds converts a human-readable expiry duration string
// [1h, 1d, 1w] to its equivalent in seconds, defaulting to one hour.
func expirationInSeconds(s string) int32 {
	if ttl, ok := yopass.ExpirationSeconds(s); ok {
		return ttl
	}
	oneHour, _ := yopass.ExpirationSeconds("1h")
	return oneHour
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
// argon2 adds 'wasm-unsafe-eval' to script-src, required by the WASM-based
// Argon2 implementation in OpenPGP.js. It permits WebAssembly compilation
// only and does not enable eval() or Function().
func SecurityHeadersHandler(extraImgSrc []string, argon2 bool, next http.Handler) http.Handler {
	imgSrc := append([]string{"'self'", "data:"}, extraImgSrc...)
	scriptSrc := "script-src 'self'"
	if argon2 {
		scriptSrc += " 'wasm-unsafe-eval'"
	}
	csp := []string{
		"default-src 'self'",
		"font-src 'self' data:",
		"form-action 'self'",
		"frame-ancestors 'none'",
		"img-src " + strings.Join(imgSrc, " "),
		scriptSrc,
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

// newMetricsMiddleware creates a middleware handler recording all HTTP
// requests in the given Prometheus registry
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
