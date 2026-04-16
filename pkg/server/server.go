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
	"github.com/spf13/viper"
	"github.com/zitadel/oidc/v3/pkg/client/rp"
	"go.uber.org/zap"
)

// Server struct holding database and settings.
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
}

// createSecret creates secret
func (y *Server) createSecret(w http.ResponseWriter, request *http.Request) {
	session, _ := y.getSession(request)
	clientIP := y.getRealClientIP(request)

	decoder := json.NewDecoder(request.Body)
	var s yopass.Secret
	if err := decoder.Decode(&s); err != nil {
		y.Logger.Debug("Unable to decode request", zap.Error(err))
		http.Error(w, `{"message": "Unable to parse json"}`, http.StatusBadRequest)
		return
	}

	if !isPGPEncrypted(s.Message) {
		y.audit().Log(AuditEvent{
			Timestamp: time.Now().UTC(), Event: "secret.created", Outcome: OutcomeFailure,
			ClientIP: clientIP, UserEmail: sessionEmail(session), UserSubject: sessionSub(session),
			Error: "message not PGP encrypted",
		})
		http.Error(w, `{"message": "Message must be PGP encrypted"}`, http.StatusBadRequest)
		return
	}

	if !validExpiration(s.Expiration) {
		y.audit().Log(AuditEvent{
			Timestamp: time.Now().UTC(), Event: "secret.created", Outcome: OutcomeFailure,
			ClientIP: clientIP, UserEmail: sessionEmail(session), UserSubject: sessionSub(session),
			Error: "invalid expiration",
		})
		http.Error(w, `{"message": "Invalid expiration specified"}`, http.StatusBadRequest)
		return
	}

	if s.RequireAuth && y.OIDCProvider == nil {
		y.audit().Log(AuditEvent{
			Timestamp: time.Now().UTC(), Event: "secret.created", Outcome: OutcomeFailure,
			ClientIP: clientIP, UserEmail: sessionEmail(session), UserSubject: sessionSub(session),
			Error: "auth required but OIDC not configured",
		})
		http.Error(w, `{"message": "Authentication not configured on this server"}`, http.StatusBadRequest)
		return
	}

	if !s.OneTime && y.ForceOneTimeSecrets {
		y.audit().Log(AuditEvent{
			Timestamp: time.Now().UTC(), Event: "secret.created", Outcome: OutcomeFailure,
			ClientIP: clientIP, UserEmail: sessionEmail(session), UserSubject: sessionSub(session),
			Error: "one-time required by server policy",
		})
		http.Error(w, `{"message": "Secret must be one time download"}`, http.StatusBadRequest)
		return
	}

	if len(s.Message) > y.MaxLength {
		y.audit().Log(AuditEvent{
			Timestamp: time.Now().UTC(), Event: "secret.created", Outcome: OutcomeFailure,
			ClientIP: clientIP, UserEmail: sessionEmail(session), UserSubject: sessionSub(session),
			Error: "message too long",
		})
		http.Error(w, `{"message": "The encrypted message is too long"}`, http.StatusBadRequest)
		return
	}

	// Generate new secret ID
	key, err := yopass.GenerateID()
	if err != nil {
		y.Logger.Error("Unable to generate ID", zap.Error(err))
		y.audit().Log(AuditEvent{
			Timestamp: time.Now().UTC(), Event: "secret.created", Outcome: OutcomeFailure,
			ClientIP: clientIP, UserEmail: sessionEmail(session), UserSubject: sessionSub(session),
			Error: "failed to generate ID",
		})
		http.Error(w, `{"message": "Unable to generate ID"}`, http.StatusInternalServerError)
		return
	}

	// store secret in memcache with specified expiration.
	if err := y.DB.Put(key, s); err != nil {
		y.Logger.Error("Unable to store secret", zap.Error(err))
		y.audit().Log(AuditEvent{
			Timestamp: time.Now().UTC(), Event: "secret.created", Outcome: OutcomeFailure,
			ClientIP: clientIP, SecretID: key,
			UserEmail: sessionEmail(session), UserSubject: sessionSub(session),
			Error: "database error",
		})
		http.Error(w, `{"message": "Failed to store secret in database"}`, http.StatusInternalServerError)
		return
	}

	y.audit().Log(AuditEvent{
		Timestamp: time.Now().UTC(), Event: "secret.created", Outcome: OutcomeSuccess,
		ClientIP: clientIP, SecretID: key,
		OneTime: boolPtr(s.OneTime), ExpirationSeconds: int32Ptr(s.Expiration), RequireAuth: boolPtr(s.RequireAuth),
		UserEmail: sessionEmail(session), UserSubject: sessionSub(session),
	})
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(map[string]string{"message": key}); err != nil {
		y.Logger.Error("Failed to write response", zap.Error(err))
	}
}

// getSecret from database
func (y *Server) getSecret(w http.ResponseWriter, request *http.Request) {
	w.Header().Set("Cache-Control", "private, no-cache")

	secretKey := mux.Vars(request)["key"]
	session, sessionErr := y.getSession(request)
	clientIP := y.getRealClientIP(request)

	// Use Status (non-destructive) so auth is checked before one-time secrets are consumed.
	secret, err := y.DB.Status(secretKey)
	if err != nil {
		y.Logger.Debug("Secret not found", zap.Error(err))
		y.audit().Log(AuditEvent{
			Timestamp: time.Now().UTC(), Event: "secret.accessed", Outcome: OutcomeFailure,
			ClientIP: clientIP, SecretID: secretKey,
			UserEmail: sessionEmail(session), UserSubject: sessionSub(session),
			Error: "not found",
		})
		http.Error(w, `{"message": "Secret not found"}`, http.StatusNotFound)
		return
	}

	if secret.RequireAuth {
		w.Header().Set("Content-Type", "application/json")
		if sessionErr != nil || session == nil {
			y.audit().Log(AuditEvent{
				Timestamp: time.Now().UTC(), Event: "secret.accessed", Outcome: OutcomeDenied,
				ClientIP: clientIP, SecretID: secretKey, RequireAuth: boolPtr(true),
				Error: "authentication required",
			})
			http.Error(w, `{"message": "authentication required"}`, http.StatusUnauthorized)
			return
		}
		if !emailAllowed(session.Email) {
			y.audit().Log(AuditEvent{
				Timestamp: time.Now().UTC(), Event: "secret.accessed", Outcome: OutcomeDenied,
				ClientIP: clientIP, SecretID: secretKey, RequireAuth: boolPtr(true),
				UserEmail: session.Email, UserSubject: session.Sub,
				Error: "email domain not permitted",
			})
			http.Error(w, `{"message": "email domain not permitted"}`, http.StatusForbidden)
			return
		}
	}

	if secret.OneTime {
		deleted, err := y.DB.Delete(secretKey)
		if err != nil {
			y.Logger.Error("Failed to delete one-time secret", zap.Error(err))
			y.audit().Log(AuditEvent{
				Timestamp: time.Now().UTC(), Event: "secret.accessed", Outcome: OutcomeFailure,
				ClientIP: clientIP, SecretID: secretKey, OneTime: boolPtr(true),
				UserEmail: sessionEmail(session), UserSubject: sessionSub(session),
				Error: "failed to claim one-time secret",
			})
			http.Error(w, `{"message": "Failed to process secret"}`, http.StatusInternalServerError)
			return
		}
		if !deleted {
			y.audit().Log(AuditEvent{
				Timestamp: time.Now().UTC(), Event: "secret.accessed", Outcome: OutcomeDenied,
				ClientIP: clientIP, SecretID: secretKey, OneTime: boolPtr(true),
				UserEmail: sessionEmail(session), UserSubject: sessionSub(session),
				Error: "claimed by concurrent request",
			})
			http.Error(w, `{"message": "Secret not found"}`, http.StatusNotFound)
			return
		}
	}

	data, err := secret.ToJSON()
	if err != nil {
		y.Logger.Error("Failed to encode request", zap.Error(err))
		http.Error(w, `{"message": "Failed to encode secret"}`, http.StatusInternalServerError)
		return
	}

	// Log success before writing: for one-time secrets the secret has already
	// been deleted, so the meaningful outcome (consumed) is already determined.
	// Logging after a write failure would record the wrong outcome.
	y.audit().Log(AuditEvent{
		Timestamp: time.Now().UTC(), Event: "secret.accessed", Outcome: OutcomeSuccess,
		ClientIP: clientIP, SecretID: secretKey,
		OneTime: boolPtr(secret.OneTime), RequireAuth: boolPtr(secret.RequireAuth),
		UserEmail: sessionEmail(session), UserSubject: sessionSub(session),
	})
	if _, err := w.Write(data); err != nil {
		y.Logger.Error("Failed to write response", zap.Error(err))
	}
}

// getSecretStatus returns minimal status for a secret without returning the secret content
func (y *Server) getSecretStatus(w http.ResponseWriter, request *http.Request) {
	w.Header().Set("Cache-Control", "private, no-cache")
	w.Header().Set("Content-Type", "application/json")

	secretKey := mux.Vars(request)["key"]
	clientIP := y.getRealClientIP(request)
	session, _ := y.getSession(request)

	secret, err := y.DB.Status(secretKey)
	if err != nil {
		y.Logger.Debug("Secret not found", zap.Error(err))
		y.audit().Log(AuditEvent{
			Timestamp: time.Now().UTC(), Event: "secret.status_checked", Outcome: OutcomeFailure,
			ClientIP: clientIP, SecretID: secretKey,
			UserEmail: sessionEmail(session), UserSubject: sessionSub(session),
			Error: "not found",
		})
		http.Error(w, `{"message": "Secret not found"}`, http.StatusNotFound)
		return
	}

	y.audit().Log(AuditEvent{
		Timestamp: time.Now().UTC(), Event: "secret.status_checked", Outcome: OutcomeSuccess,
		ClientIP: clientIP, SecretID: secretKey,
		OneTime: boolPtr(secret.OneTime), RequireAuth: boolPtr(secret.RequireAuth),
		UserEmail: sessionEmail(session), UserSubject: sessionSub(session),
	})
	resp := map[string]bool{"oneTime": secret.OneTime, "requireAuth": secret.RequireAuth}
	if err := json.NewEncoder(w).Encode(resp); err != nil {
		y.Logger.Error("Failed to write status response", zap.Error(err))
	}
}

// deleteSecret from database
func (y *Server) deleteSecret(w http.ResponseWriter, request *http.Request) {
	secretKey := mux.Vars(request)["key"]
	session, sessionErr := y.getSession(request)
	clientIP := y.getRealClientIP(request)

	// Check metadata first to enforce RequireAuth before allowing deletion.
	secret, err := y.DB.Status(secretKey)
	if err != nil {
		y.audit().Log(AuditEvent{
			Timestamp: time.Now().UTC(), Event: "secret.deleted", Outcome: OutcomeFailure,
			ClientIP: clientIP, SecretID: secretKey,
			UserEmail: sessionEmail(session), UserSubject: sessionSub(session),
			Error: "not found",
		})
		http.Error(w, `{"message": "Secret not found"}`, http.StatusNotFound)
		return
	}

	if secret.RequireAuth {
		w.Header().Set("Content-Type", "application/json")
		if sessionErr != nil || session == nil {
			y.audit().Log(AuditEvent{
				Timestamp: time.Now().UTC(), Event: "secret.deleted", Outcome: OutcomeDenied,
				ClientIP: clientIP, SecretID: secretKey, RequireAuth: boolPtr(true),
				Error: "authentication required",
			})
			http.Error(w, `{"message": "authentication required"}`, http.StatusUnauthorized)
			return
		}
		if !emailAllowed(session.Email) {
			y.audit().Log(AuditEvent{
				Timestamp: time.Now().UTC(), Event: "secret.deleted", Outcome: OutcomeDenied,
				ClientIP: clientIP, SecretID: secretKey, RequireAuth: boolPtr(true),
				UserEmail: session.Email, UserSubject: session.Sub,
				Error: "email domain not permitted",
			})
			http.Error(w, `{"message": "email domain not permitted"}`, http.StatusForbidden)
			return
		}
	}

	deleted, err := y.DB.Delete(secretKey)
	if err != nil {
		y.audit().Log(AuditEvent{
			Timestamp: time.Now().UTC(), Event: "secret.deleted", Outcome: OutcomeFailure,
			ClientIP: clientIP, SecretID: secretKey,
			UserEmail: sessionEmail(session), UserSubject: sessionSub(session),
			Error: "database error",
		})
		http.Error(w, `{"message": "Failed to delete secret"}`, http.StatusInternalServerError)
		return
	}

	if !deleted {
		y.audit().Log(AuditEvent{
			Timestamp: time.Now().UTC(), Event: "secret.deleted", Outcome: OutcomeFailure,
			ClientIP: clientIP, SecretID: secretKey,
			UserEmail: sessionEmail(session), UserSubject: sessionSub(session),
			Error: "not found",
		})
		http.Error(w, `{"message": "Secret not found"}`, http.StatusNotFound)
		return
	}

	y.audit().Log(AuditEvent{
		Timestamp: time.Now().UTC(), Event: "secret.deleted", Outcome: OutcomeSuccess,
		ClientIP: clientIP, SecretID: secretKey,
		UserEmail: sessionEmail(session), UserSubject: sessionSub(session),
	})
	w.WriteHeader(204)
}

// optionsSecret handle the Options http method by returning the correct CORS headers
func (y *Server) optionsSecret(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "content-type")
}

func (y *Server) configHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Headers", "content-type")
	w.Header().Set("Content-Type", "application/json")

	config := map[string]interface{}{
		"DISABLE_UPLOAD":        viper.GetBool("disable-upload"),
		"READ_ONLY":             viper.GetBool("read-only"),
		"PREFETCH_SECRET":       viper.GetBool("prefetch-secret"),
		"DISABLE_FEATURES":      viper.GetBool("disable-features"),
		"NO_LANGUAGE_SWITCHER":  viper.GetBool("no-language-switcher"),
		"FORCE_ONETIME_SECRETS": viper.GetBool("force-onetime-secrets"),
		"DEFAULT_EXPIRY":        expirationInSeconds(viper.GetString("default-expiry")),
	}
	if y.MaxFileSize > 0 {
		config["MAX_FILE_SIZE"] = FormatSize(y.MaxFileSize)
	}

	// Add optional string URLs only if they are provided
	if privacyURL := viper.GetString("privacy-notice-url"); privacyURL != "" {
		config["PRIVACY_NOTICE_URL"] = privacyURL
	}
	if imprintURL := viper.GetString("imprint-url"); imprintURL != "" {
		config["IMPRINT_URL"] = imprintURL
	}
	if y.License.Valid {
		if logoURL := viper.GetString("logo-url"); logoURL != "" {
			config["LOGO_URL"] = logoURL
		}
	}

	oidcEnabled := y.OIDCProvider != nil
	config["OIDC_ENABLED"] = oidcEnabled
	config["REQUIRE_AUTH"] = oidcEnabled && viper.GetBool("require-auth")

	if y.License.Valid {
		config["THEME_LIGHT"] = viper.GetString("theme-light")
		config["THEME_DARK"] = viper.GetString("theme-dark")

		if rawLight := viper.GetString("theme-custom-light"); rawLight != "" {
			var vars map[string]string
			if err := json.Unmarshal([]byte(rawLight), &vars); err == nil {
				config["THEME_CUSTOM_LIGHT"] = vars
			}
		}
		if rawDark := viper.GetString("theme-custom-dark"); rawDark != "" {
			var vars map[string]string
			if err := json.Unmarshal([]byte(rawDark), &vars); err == nil {
				config["THEME_CUSTOM_DARK"] = vars
			}
		}

		if appName := viper.GetString("app-name"); appName != "" {
			config["APP_NAME"] = appName
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

// maybeRequireAuth wraps a handler with requireAuthMiddleware when OIDC is
// configured and the --require-auth flag is set. Otherwise it returns the
// handler as-is.
func (y *Server) maybeRequireAuth(h http.HandlerFunc) http.Handler {
	if y.OIDCProvider != nil && viper.GetBool("require-auth") {
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
	mx.Use(corsMiddleware)

	// Only register write endpoints if not in read-only mode
	if !viper.GetBool("read-only") {
		mx.Handle("/create/secret", y.maybeRequireAuth(y.createSecret)).Methods(http.MethodPost)
		mx.HandleFunc("/create/secret", y.optionsSecret).Methods(http.MethodOptions)
	}

	// Read endpoints - always available
	if viper.GetBool("prefetch-secret") {
		mx.HandleFunc("/secret/"+keyParameter+"/status", y.getSecretStatus).Methods(http.MethodGet)
	}
	mx.HandleFunc("/secret/"+keyParameter, y.getSecret).Methods(http.MethodGet)
	mx.HandleFunc("/secret/"+keyParameter, y.deleteSecret).Methods(http.MethodDelete)

	mx.HandleFunc("/config", y.configHandler).Methods(http.MethodGet)
	mx.HandleFunc("/config", y.optionsSecret).Methods(http.MethodOptions)

	// OIDC authentication routes — only registered when OIDC is configured
	if y.OIDCProvider != nil {
		mx.HandleFunc("/auth/login", y.oidcLoginHandler).Methods(http.MethodGet)
		mx.HandleFunc("/auth/callback", y.oidcCallbackHandler).Methods(http.MethodGet)
		mx.HandleFunc("/auth/logout", y.oidcLogoutHandler).Methods(http.MethodPost)
		mx.HandleFunc("/auth/me", y.oidcMeHandler).Methods(http.MethodGet)
	}

	// File upload/download endpoints
	if y.FileStore == nil && !viper.GetBool("disable-upload") {
		y.FileStore = NewDatabaseFileStore(y.DB)
	}
	if !viper.GetBool("read-only") && !viper.GetBool("disable-upload") {
		mx.Handle("/create/file", y.maybeRequireAuth(y.streamUpload)).Methods(http.MethodPost)
		mx.HandleFunc("/create/file", y.streamOptions).Methods(http.MethodOptions)
	}
	if !viper.GetBool("disable-upload") {
		mx.HandleFunc("/file/"+keyParameter, y.streamDownload).Methods(http.MethodGet)
		mx.HandleFunc("/file/"+keyParameter, y.streamOptions).Methods(http.MethodOptions)
		mx.HandleFunc("/file/"+keyParameter, y.deleteStreamSecret).Methods(http.MethodDelete)
		if viper.GetBool("prefetch-secret") {
			mx.HandleFunc("/file/"+keyParameter+"/status", y.getStreamSecretStatus).Methods(http.MethodGet)
		}
	}

	mx.HandleFunc("/health", y.healthHandler).Methods(http.MethodGet, http.MethodHead)
	mx.HandleFunc("/ready", y.readyHandler).Methods(http.MethodGet, http.MethodHead)
	mx.HandleFunc("/version", y.versionHandler).Methods(http.MethodGet)
	mx.HandleFunc("/logo", y.logoHandler).Methods(http.MethodGet)

	mx.PathPrefix("/").Handler(http.FileServer(http.Dir(y.AssetPath)))
	return handlers.CustomLoggingHandler(nil, SecurityHeadersHandler(mx), y.httpLogFormatter())
}

const keyParameter = "{key:(?:[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}|[a-zA-Z0-9]{22})}"

// validExpiration validates that expiration is either
// 3600(1hour), 86400(1day) or 604800(1week)
func validExpiration(expiration int32) bool {
	for _, ttl := range []int32{3600, 86400, 604800} {
		if ttl == expiration {
			return true
		}
	}
	return false
}

// expirationInSeconds converts a human-readable expiry duration string
// [1h, 1d, 1w] to its equivalent in seconds.
func expirationInSeconds(s string) int32 {
	switch s {
	case "1h":
		return 3600
	case "1d":
		return 86400
	case "1w":
		return 604800
	default:
		return 3600
	}
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
func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if frontendURL := viper.GetString("frontend-url"); frontendURL != "" {
			// Credentialed cross-origin requests require a specific origin (not wildcard)
			// and Access-Control-Allow-Credentials: true.
			// Browsers send Origin as scheme://host (no path), so strip any path.
			origin := frontendURL
			if u, err := url.Parse(frontendURL); err == nil && u.Host != "" {
				origin = u.Scheme + "://" + u.Host
			}
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Credentials", "true")
			// Vary: Origin tells caches that the response differs by origin so they
			// do not serve a cached CORS response to a different requester.
			w.Header().Add("Vary", "Origin")
		} else {
			w.Header().Set("Access-Control-Allow-Origin", viper.GetString("cors-allow-origin"))
		}
		next.ServeHTTP(w, r)
	})
}

// SecurityHeadersHandler returns a middleware which sets common security
// HTTP headers on the response to mitigate common web vulnerabilities.
func SecurityHeadersHandler(next http.Handler) http.Handler {
	csp := []string{
		"default-src 'self'",
		"font-src 'self' data:",
		"form-action 'self'",
		"frame-ancestors 'none'",
		"img-src 'self' data:",
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
