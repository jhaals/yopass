package server

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gorilla/securecookie"
	"github.com/spf13/viper"
	"github.com/zitadel/oidc/v3/pkg/client/rp"
	httphelper "github.com/zitadel/oidc/v3/pkg/http"
	"github.com/zitadel/oidc/v3/pkg/oidc"
	"go.uber.org/zap"
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

// deriveKey returns a 32-byte key derived from masterHex using SHA-256(master || label).
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
	h := sha256.New()
	h.Write(raw)
	h.Write([]byte(label))
	return h.Sum(nil)
}

// NewOIDCProvider creates a zitadel relying party from viper flags.
// sessionKey is the same 128-hex value as --oidc-session-key; when non-empty the
// OIDC redirect-flow cookies (state + PKCE) use keys derived from it so the flow
// works correctly across multiple instances without sticky sessions.
func NewOIDCProvider(ctx context.Context, logger *zap.Logger, sessionKey string) (rp.RelyingParty, error) {
	issuer := viper.GetString("oidc-issuer")
	clientID := viper.GetString("oidc-client-id")
	clientSecret := viper.GetString("oidc-client-secret")
	redirectURL := viper.GetString("oidc-redirect-url")

	if issuer == "" || clientID == "" || redirectURL == "" {
		return nil, fmt.Errorf("oidc-issuer, oidc-client-id, and oidc-redirect-url are all required")
	}

	// State/PKCE cookie keys. When sessionKey is provided (multi-instance deployments)
	// keys are derived deterministically so any instance can verify the cookie.
	// Otherwise fresh random keys are generated (ephemeral, single-instance only).
	cookieHashKey := deriveKey(sessionKey, "oidc-state-hash")
	cookieEncKey := deriveKey(sessionKey, "oidc-state-enc")
	cookieHandler := httphelper.NewCookieHandler(cookieHashKey, cookieEncKey)

	options := []rp.Option{
		rp.WithCookieHandler(cookieHandler),
		rp.WithPKCE(cookieHandler),
	}

	logger.Info("initializing OIDC provider",
		zap.String("issuer", issuer),
		zap.String("redirect_url", redirectURL),
	)

	provider, err := rp.NewRelyingPartyOIDC(
		ctx,
		issuer,
		clientID,
		clientSecret,
		redirectURL,
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
func isSecure(r *http.Request) bool {
	return r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https"
}

// isCrossOrigin reports whether the configured frontend-url is on a different
// origin than the backend (the incoming request host). When true the session
// cookie must use SameSite=None so that browsers include it on cross-site
// fetch/XHR calls (e.g. /auth/me from app.example.com to api.example.com).
func isCrossOrigin(r *http.Request) bool {
	frontendURL := viper.GetString("frontend-url")
	if frontendURL == "" {
		return false
	}
	u, err := url.Parse(frontendURL)
	if err != nil || u.Host == "" {
		return false
	}
	return !strings.EqualFold(u.Host, r.Host)
}

// getSession reads and decodes the session cookie.
// Returns nil, nil when no session cookie is present (unauthenticated).
func (y *Server) getSession(r *http.Request) (*sessionData, error) {
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
	secure := isSecure(r)
	if isCrossOrigin(r) {
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
func (y *Server) clearSession(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		MaxAge:   -1,
	})
}

// oidcLoginHandler redirects the user to the OIDC provider.
func (y *Server) oidcLoginHandler(w http.ResponseWriter, r *http.Request) {
	rp.AuthURLHandler(randomState, y.OIDCProvider)(w, r)
}

// homeURL returns the root URL to redirect to after login/logout.
// If a frontend-url is configured (split deployment), that is used instead of "/".
func homeURL() string {
	if frontendURL := viper.GetString("frontend-url"); frontendURL != "" {
		return frontendURL + "/"
	}
	return "/"
}

// emailAllowed reports whether email satisfies the oidc-allowed-domain restriction.
// When no domain is configured every well-formed email is allowed.
func emailAllowed(email string) bool {
	_, domain, ok := strings.Cut(email, "@")
	if !ok || domain == "" {
		return false
	}
	allowed := viper.GetString("oidc-allowed-domain")
	if allowed == "" {
		return true
	}
	return strings.EqualFold(domain, allowed)
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
	if info.Subject == "" {
		y.Logger.Error("OIDC userinfo missing subject claim")
		http.Error(w, `{"message": "Invalid OIDC response"}`, http.StatusUnauthorized)
		return
	}

	if !emailAllowed(info.Email) {
		y.Logger.Info("login rejected: email domain not permitted",
			zap.String("email", info.Email),
			zap.String("allowed_domain", viper.GetString("oidc-allowed-domain")),
		)
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
		http.Error(w, `{"message": "Failed to create session"}`, http.StatusInternalServerError)
		return
	}
	http.Redirect(w, r, homeURL(), http.StatusFound)
}

// oidcCallbackHandler handles the OIDC authorization code callback.
func (y *Server) oidcCallbackHandler(w http.ResponseWriter, r *http.Request) {
	rp.CodeExchangeHandler(rp.UserinfoCallback(y.oidcUserinfoCallback), y.OIDCProvider)(w, r)
}

// oidcLogoutHandler clears the session and redirects to the home page.
func (y *Server) oidcLogoutHandler(w http.ResponseWriter, r *http.Request) {
	y.clearSession(w)
	http.Redirect(w, r, homeURL(), http.StatusFound)
}

// oidcMeHandler returns the current user's info or 401 if not authenticated.
func (y *Server) oidcMeHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	s, err := y.getSession(r)
	if err != nil {
		y.Logger.Debug("invalid session cookie", zap.Error(err))
		http.Error(w, `{"message": "unauthorized"}`, http.StatusUnauthorized)
		return
	}
	if s == nil {
		http.Error(w, `{"message": "unauthorized"}`, http.StatusUnauthorized)
		return
	}
	if err := json.NewEncoder(w).Encode(s); err != nil {
		y.Logger.Error("failed to encode /auth/me response", zap.Error(err))
	}
}

// requireAuthMiddleware returns 401 if there is no valid session, or 403 if
// the authenticated user's email domain does not match --oidc-allowed-domain.
func (y *Server) requireAuthMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s, err := y.getSession(r)
		if err != nil || s == nil {
			w.Header().Set("Content-Type", "application/json")
			http.Error(w, `{"message": "authentication required"}`, http.StatusUnauthorized)
			return
		}
		if !emailAllowed(s.Email) {
			w.Header().Set("Content-Type", "application/json")
			http.Error(w, `{"message": "email domain not permitted"}`, http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}
