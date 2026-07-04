package server

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gorilla/securecookie"
	"github.com/zitadel/oidc/v3/pkg/client/rp"
	httphelper "github.com/zitadel/oidc/v3/pkg/http"
	"github.com/zitadel/oidc/v3/pkg/oidc"
	"go.uber.org/zap"
	"golang.org/x/crypto/hkdf"
)

const sessionCookieName = "yopass_session"

type sessionData struct {
	Sub   string `json:"sub"`
	Email string `json:"email"`
	Name  string `json:"name"`
}

// NewCookieCodec creates a securecookie codec for session management.
// If key is a 128-hex-character string (64 bytes), it is used as the
// HMAC (first 32 bytes) and AES-256 (last 32 bytes) keys — required for
// multi-instance deployments behind a load balancer.
// Otherwise two 32-byte random keys are generated at startup (single-instance only).
func NewCookieCodec(key string) *securecookie.SecureCookie {
	var hashKey, encryptKey []byte

	if len(key) == 128 {
		raw, err := hex.DecodeString(key)
		if err == nil && len(raw) == 64 {
			hashKey = raw[:32]
			encryptKey = raw[32:]
		}
	}

	if hashKey == nil {
		hashKey = make([]byte, 32)
		encryptKey = make([]byte, 32)
		if _, err := io.ReadFull(rand.Reader, hashKey); err != nil {
			panic("oidc: failed to generate session hash key: " + err.Error())
		}
		if _, err := io.ReadFull(rand.Reader, encryptKey); err != nil {
			panic("oidc: failed to generate session encrypt key: " + err.Error())
		}
	}

	return securecookie.New(hashKey, encryptKey)
}

// deriveKey returns a 32-byte key derived from masterHex using HKDF-SHA256 with label as info.
// Falls back to a fresh random key if masterHex is empty or invalid.
func deriveKey(masterHex, label string) []byte {
	raw, err := hex.DecodeString(masterHex)
	if err != nil || len(raw) != 64 {
		k := make([]byte, 32)
		if _, err := io.ReadFull(rand.Reader, k); err != nil {
			panic("oidc: failed to generate key: " + err.Error())
		}
		return k
	}
	r := hkdf.New(sha256.New, raw, nil, []byte(label))
	k := make([]byte, 32)
	if _, err := io.ReadFull(r, k); err != nil {
		panic("oidc: failed to derive key: " + err.Error())
	}
	return k
}

// OIDCConfig carries the settings needed to set up the OIDC relying party,
// mirroring the oidc-* CLI flags.
type OIDCConfig struct {
	Issuer       string
	ClientID     string
	ClientSecret string
	RedirectURL  string
	// SessionKey is the same 128-hex value as --oidc-session-key; when
	// non-empty the OIDC redirect-flow cookies (state + PKCE) use keys derived
	// from it so the flow works correctly across multiple instances without
	// sticky sessions.
	SessionKey string
}

// NewOIDCProvider creates a zitadel relying party from the given config.
func NewOIDCProvider(ctx context.Context, logger *zap.Logger, cfg OIDCConfig) (rp.RelyingParty, error) {
	if cfg.Issuer == "" || cfg.ClientID == "" || cfg.RedirectURL == "" {
		return nil, fmt.Errorf("oidc-issuer, oidc-client-id, and oidc-redirect-url are all required")
	}

	// State/PKCE cookie keys. When SessionKey is provided (multi-instance deployments)
	// keys are derived deterministically so any instance can verify the cookie.
	// Otherwise fresh random keys are generated (ephemeral, single-instance only).
	cookieHashKey := deriveKey(cfg.SessionKey, "oidc-state-hash")
	cookieEncKey := deriveKey(cfg.SessionKey, "oidc-state-enc")
	cookieHandler := httphelper.NewCookieHandler(cookieHashKey, cookieEncKey)

	options := []rp.Option{
		rp.WithCookieHandler(cookieHandler),
		rp.WithPKCE(cookieHandler),
	}

	logger.Info("initializing OIDC provider",
		zap.String("issuer", cfg.Issuer),
		zap.String("redirect_url", cfg.RedirectURL),
	)

	provider, err := rp.NewRelyingPartyOIDC(
		ctx,
		cfg.Issuer,
		cfg.ClientID,
		cfg.ClientSecret,
		cfg.RedirectURL,
		[]string{oidc.ScopeOpenID, oidc.ScopeEmail, oidc.ScopeProfile},
		options...,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to create OIDC relying party: %w", err)
	}
	return provider, nil
}

// randomState generates a random hex string for OIDC state parameter.
func randomState() string {
	b := make([]byte, 16)
	if _, err := io.ReadFull(rand.Reader, b); err != nil {
		panic("oidc: failed to generate state: " + err.Error())
	}
	return hex.EncodeToString(b)
}

// isSecure returns true if the request was made over HTTPS.
// X-Forwarded-Proto is only trusted when it arrives from a configured trusted
// proxy; without that guard an attacker who reaches the server directly can
// forge the header and cause Secure cookies to be issued over plain HTTP,
// which browsers reject — effectively a DoS against authentication.
// When no trusted proxies are configured the header is still trusted to
// preserve existing behaviour for operators who have not yet set that flag.
func (y *Server) isSecure(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	if r.Header.Get("X-Forwarded-Proto") != "https" {
		return false
	}
	if len(y.TrustedProxies) > 0 {
		remoteIP, _, _ := net.SplitHostPort(r.RemoteAddr)
		return y.isTrustedProxy(remoteIP)
	}
	return true
}

// normalizeHost strips default ports from a host string so that
// "example.com:443" with scheme "https" equals "example.com".
func normalizeHost(scheme, host string) string {
	h, port, err := net.SplitHostPort(host)
	if err != nil {
		// No port present.
		return strings.ToLower(host)
	}
	if (scheme == "http" && port == "80") || (scheme == "https" && port == "443") {
		return strings.ToLower(h)
	}
	return strings.ToLower(host)
}

// isCrossOrigin reports whether the configured frontend-url is on a different
// origin than the backend (the incoming request host). When true the session
// cookie must use SameSite=None so that browsers include it on cross-site
// fetch/XHR calls (e.g. /auth/me from app.example.com to api.example.com).
func (y *Server) isCrossOrigin(r *http.Request) bool {
	if y.FrontendURL == "" {
		return false
	}
	u, err := url.Parse(y.FrontendURL)
	if err != nil || u.Host == "" {
		return false
	}
	requestScheme := "http"
	if y.isSecure(r) {
		requestScheme = "https"
	}
	return normalizeHost(u.Scheme, u.Host) != normalizeHost(requestScheme, r.Host)
}

// getSession reads and decodes the session cookie.
// Returns nil, nil when no session cookie is present (unauthenticated).
// A session placed on the request context (an API token identity resolved
// by requireAuthMiddleware) takes precedence over the cookie so handlers
// attribute audit events to the service account.
func (y *Server) getSession(r *http.Request) (*sessionData, error) {
	if s := sessionFromContext(r.Context()); s != nil {
		return s, nil
	}
	if y.CookieCodec == nil {
		return nil, nil
	}
	cookie, err := r.Cookie(sessionCookieName)
	if err != nil {
		return nil, nil
	}
	var s sessionData
	if err := y.CookieCodec.Decode(sessionCookieName, cookie.Value, &s); err != nil {
		return nil, err
	}
	return &s, nil
}

// setSession encodes and writes the session cookie.
// For same-origin deployments SameSite=Lax is sufficient.
// For split-origin deployments (frontend-url on a different host) the cookie
// must be SameSite=None; Secure so that browsers send it on cross-site fetches.
func (y *Server) setSession(w http.ResponseWriter, r *http.Request, s *sessionData) error {
	encoded, err := y.CookieCodec.Encode(sessionCookieName, s)
	if err != nil {
		return err
	}
	sameSite := http.SameSiteLaxMode
	secure := y.isSecure(r)
	if y.isCrossOrigin(r) {
		sameSite = http.SameSiteNoneMode
		secure = true // SameSite=None requires Secure
	}
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    encoded,
		Path:     "/",
		HttpOnly: true,
		Secure:   secure,
		SameSite: sameSite,
		MaxAge:   int((24 * time.Hour).Seconds()),
	})
	return nil
}

// clearSession removes the session cookie.
// The SameSite and Secure attributes are mirrored from setSession so that
// browsers which enforce attribute matching for cookie deletion (e.g. Chrome's
// Scheme-Bound Cookies) reliably clear the session.
func (y *Server) clearSession(w http.ResponseWriter, r *http.Request) {
	sameSite := http.SameSiteLaxMode
	secure := y.isSecure(r)
	if y.isCrossOrigin(r) {
		sameSite = http.SameSiteNoneMode
		secure = true
	}
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		Secure:   secure,
		SameSite: sameSite,
		MaxAge:   -1,
	})
}

// oidcLoginHandler redirects the user to the OIDC provider.
func (y *Server) oidcLoginHandler(w http.ResponseWriter, r *http.Request) {
	rp.AuthURLHandler(randomState, y.OIDCProvider)(w, r)
}

// homeURL returns the root URL to redirect to after login/logout.
// If a frontend URL is configured (split deployment), that is used instead of "/".
func (y *Server) homeURL() string {
	if y.FrontendURL != "" {
		return strings.TrimRight(y.FrontendURL, "/") + "/"
	}
	return "/"
}

// emailAllowed reports whether email satisfies the allowed-domains restriction.
// When no domains are configured every well-formed email is allowed.
func (y *Server) emailAllowed(email string) bool {
	_, domain, ok := strings.Cut(email, "@")
	if !ok || domain == "" {
		return false
	}
	if len(y.AllowedEmailDomains) == 0 {
		return true
	}
	for _, a := range y.AllowedEmailDomains {
		if strings.EqualFold(domain, a) {
			return true
		}
	}
	return false
}

// oidcUserinfoCallback processes the userinfo response after a successful code exchange.
func (y *Server) oidcUserinfoCallback(
	w http.ResponseWriter,
	r *http.Request,
	_ *oidc.Tokens[*oidc.IDTokenClaims],
	_ string,
	_ rp.RelyingParty,
	info *oidc.UserInfo,
) {
	audit := y.newAuditor("auth.callback_failed", y.getRealClientIP(r), nil)

	if info.Subject == "" {
		y.Logger.Error("OIDC userinfo missing subject claim")
		audit.failure("missing subject claim")
		jsonError(w, http.StatusUnauthorized, "Invalid OIDC response")
		return
	}

	if !y.emailAllowed(info.Email) {
		y.Logger.Info("login rejected: email domain not permitted")
		audit.denied("email domain not permitted", withUser(info.Email, info.Subject))
		http.Error(w, "Login not permitted: your email domain is not allowed on this server.", http.StatusForbidden)
		return
	}

	s := &sessionData{
		Sub:   info.Subject,
		Email: info.Email,
		Name:  info.Name,
	}
	if err := y.setSession(w, r, s); err != nil {
		y.Logger.Error("failed to set session cookie", zap.Error(err))
		audit.failure("failed to create session", withUser(info.Email, info.Subject))
		jsonError(w, http.StatusInternalServerError, "Failed to create session")
		return
	}
	audit.withEvent("auth.callback_success").success(withUser(info.Email, info.Subject))
	http.Redirect(w, r, y.homeURL(), http.StatusFound)
}

// oidcCallbackHandler handles the OIDC authorization code callback.
func (y *Server) oidcCallbackHandler(w http.ResponseWriter, r *http.Request) {
	rp.CodeExchangeHandler(rp.UserinfoCallback(y.oidcUserinfoCallback), y.OIDCProvider)(w, r)
}

// oidcLogoutHandler clears the session and redirects to the home page.
func (y *Server) oidcLogoutHandler(w http.ResponseWriter, r *http.Request) {
	session, _ := y.getSession(r) // read before clearing so audit captures identity
	y.clearSession(w, r)
	y.newAuditor("auth.logout", y.getRealClientIP(r), session).success()
	http.Redirect(w, r, y.homeURL(), http.StatusFound)
}

// oidcMeHandler returns the current user's info or 401 if not authenticated.
func (y *Server) oidcMeHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	s, err := y.getSession(r)
	if err != nil {
		y.Logger.Debug("invalid session cookie", zap.Error(err))
		jsonError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	if s == nil {
		jsonError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	// Re-validate the domain on every request so that removing a domain from
	// --oidc-allowed-domains takes effect immediately without waiting for
	// existing sessions to expire.
	if !y.emailAllowed(s.Email) {
		jsonError(w, http.StatusForbidden, "email domain not permitted")
		return
	}
	if err := json.NewEncoder(w).Encode(s); err != nil {
		y.Logger.Error("failed to encode /auth/me response", zap.Error(err))
	}
}

// requireAuthMiddleware returns 401 if there is no valid session, or 403 if
// the authenticated user's email domain does not match --oidc-allowed-domains.
// Machine clients may authenticate with a configured API bearer token instead
// of an interactive OIDC session; token identities are service accounts, so
// the email-domain restriction does not apply to them.
func (y *Server) requireAuthMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s := y.apiTokenSession(r); s != nil {
			next.ServeHTTP(w, r.WithContext(withSession(r.Context(), s)))
			return
		}
		s, err := y.getSession(r)
		if err != nil || s == nil {
			jsonError(w, http.StatusUnauthorized, "authentication required")
			return
		}
		if !y.emailAllowed(s.Email) {
			jsonError(w, http.StatusForbidden, "email domain not permitted")
			return
		}
		next.ServeHTTP(w, r)
	})
}
