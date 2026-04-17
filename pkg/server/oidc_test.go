package server

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-jose/go-jose/v4"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/spf13/viper"
	"github.com/zitadel/oidc/v3/pkg/client/rp"
	httphelper "github.com/zitadel/oidc/v3/pkg/http"
	"github.com/zitadel/oidc/v3/pkg/oidc"
	"go.uber.org/zap/zaptest"
	"golang.org/x/oauth2"
)

// newOIDCTestServer returns a Server wired with a real CookieCodec but no OIDCProvider.
func newOIDCTestServer(t *testing.T) Server {
	t.Helper()
	return Server{
		DB:          &mockDB{},
		FileStore:   NewDatabaseFileStore(&mockDB{}),
		Registry:    prometheus.NewRegistry(),
		Logger:      zaptest.NewLogger(t),
		CookieCodec: NewCookieCodec(""),
	}
}

// --- deriveKey ---

func TestDeriveKey_EmptyFallsBackToRandom(t *testing.T) {
	k1 := deriveKey("", "label")
	k2 := deriveKey("", "label")
	if len(k1) != 32 {
		t.Fatalf("expected 32-byte key, got %d", len(k1))
	}
	if string(k1) == string(k2) {
		t.Fatal("two random keys should differ")
	}
}

func TestDeriveKey_InvalidHexFallsBackToRandom(t *testing.T) {
	k := deriveKey(strings.Repeat("zz", 64), "label")
	if len(k) != 32 {
		t.Fatalf("expected 32-byte key, got %d", len(k))
	}
}

func TestDeriveKey_Deterministic(t *testing.T) {
	master := strings.Repeat("ab", 64) // valid 128-hex
	k1 := deriveKey(master, "label")
	k2 := deriveKey(master, "label")
	if string(k1) != string(k2) {
		t.Fatal("same master+label should produce the same key")
	}
}

func TestDeriveKey_DifferentLabels(t *testing.T) {
	master := strings.Repeat("ab", 64)
	k1 := deriveKey(master, "oidc-state-hash")
	k2 := deriveKey(master, "oidc-state-enc")
	if string(k1) == string(k2) {
		t.Fatal("different labels should produce different keys")
	}
}

// --- NewCookieCodec ---

func TestNewCookieCodec_RandomKeys(t *testing.T) {
	// Empty key → random keys; codec must still encode/decode.
	codec := NewCookieCodec("")
	var want = "hello"
	encoded, err := codec.Encode("test", want)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	var got string
	if err := codec.Decode("test", encoded, &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestNewCookieCodec_DeterministicKey(t *testing.T) {
	// Valid 128-hex key → both codecs must produce the same result.
	key := strings.Repeat("ab", 64) // 128 hex chars = 64 bytes
	c1 := NewCookieCodec(key)
	c2 := NewCookieCodec(key)

	encoded, err := c1.Encode("test", "value")
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	var got string
	if err := c2.Decode("test", encoded, &got); err != nil {
		t.Fatalf("cross-codec decode: %v", err)
	}
	if got != "value" {
		t.Fatalf("got %q, want %q", got, "value")
	}
}

func TestNewCookieCodec_InvalidHexFallsBackToRandom(t *testing.T) {
	// 128-char string that isn't valid hex → falls back to random keys.
	// Validation before calling NewCookieCodec (done in main) prevents this
	// path in production, but the function still generates random keys as a
	// safety net so callers without validation don't get a nil codec.
	codec := NewCookieCodec(strings.Repeat("zz", 64))
	if codec == nil {
		t.Fatal("expected non-nil codec")
	}
	// Different random key each time means the two codecs can't cross-decode.
	other := NewCookieCodec(strings.Repeat("zz", 64))
	encoded, _ := codec.Encode("test", "x")
	var got string
	if err := other.Decode("test", encoded, &got); err == nil {
		t.Fatal("expected cross-codec decode to fail with different random keys")
	}
}

// --- isSecure ---

func TestIsSecure(t *testing.T) {
	tests := []struct {
		name           string
		setup          func(*http.Request)
		trustedProxies []string
		secure         bool
	}{
		{"plain HTTP", func(r *http.Request) {}, nil, false},
		// No trusted proxies configured: header is still trusted (backward compat).
		{"X-Forwarded-Proto https, no trusted proxies", func(r *http.Request) { r.Header.Set("X-Forwarded-Proto", "https") }, nil, true},
		{"X-Forwarded-Proto http", func(r *http.Request) { r.Header.Set("X-Forwarded-Proto", "http") }, nil, false},
		// Trusted proxies configured: only trust header when remote IP matches.
		{"X-Forwarded-Proto https, trusted proxy matches", func(r *http.Request) {
			r.Header.Set("X-Forwarded-Proto", "https")
			r.RemoteAddr = "127.0.0.1:1234"
		}, []string{"127.0.0.1"}, true},
		{"X-Forwarded-Proto https, trusted proxy does not match", func(r *http.Request) {
			r.Header.Set("X-Forwarded-Proto", "https")
			r.RemoteAddr = "10.0.0.5:1234"
		}, []string{"127.0.0.1"}, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			s := &Server{TrustedProxies: tc.trustedProxies}
			r := httptest.NewRequest(http.MethodGet, "/", nil)
			tc.setup(r)
			if got := s.isSecure(r); got != tc.secure {
				t.Fatalf("isSecure = %v, want %v", got, tc.secure)
			}
		})
	}
}

// --- session round-trip (getSession / setSession / clearSession) ---

func TestSessionRoundTrip(t *testing.T) {
	s := newOIDCTestServer(t)

	want := &sessionData{Sub: "user123", Email: "alice@example.com", Name: "Alice"}

	// setSession writes a cookie into the ResponseRecorder.
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	if err := s.setSession(w, r, want); err != nil {
		t.Fatalf("setSession: %v", err)
	}

	// Copy the Set-Cookie header into a new request so getSession can read it.
	r2 := httptest.NewRequest(http.MethodGet, "/", nil)
	for _, c := range w.Result().Cookies() {
		r2.AddCookie(c)
	}

	got, err := s.getSession(r2)
	if err != nil {
		t.Fatalf("getSession: %v", err)
	}
	if got == nil {
		t.Fatal("expected session, got nil")
	}
	if got.Sub != want.Sub || got.Email != want.Email || got.Name != want.Name {
		t.Fatalf("session mismatch: got %+v, want %+v", got, want)
	}
}

func TestGetSession_NoCookie(t *testing.T) {
	s := newOIDCTestServer(t)
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	got, err := s.getSession(r)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != nil {
		t.Fatalf("expected nil session, got %+v", got)
	}
}

func TestGetSession_TamperedCookie(t *testing.T) {
	s := newOIDCTestServer(t)
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "tampered|garbage"})
	got, err := s.getSession(r)
	if err == nil {
		t.Fatal("expected decode error for tampered cookie")
	}
	if got != nil {
		t.Fatal("expected nil session on error")
	}
}

func TestSetSession_SameSiteLax_SameOrigin(t *testing.T) {
	viper.Reset()
	s := newOIDCTestServer(t)
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.Host = "example.com"
	// No frontend-url configured → same-origin → SameSite=Lax.
	if err := s.setSession(w, r, &sessionData{Sub: "u"}); err != nil {
		t.Fatalf("setSession: %v", err)
	}
	for _, c := range w.Result().Cookies() {
		if c.Name == sessionCookieName {
			if c.SameSite != http.SameSiteLaxMode {
				t.Fatalf("expected SameSite=Lax, got %v", c.SameSite)
			}
			return
		}
	}
	t.Fatal("session cookie not found")
}

func TestSetSession_SameSiteNone_CrossOrigin(t *testing.T) {
	viper.Reset()
	viper.Set("frontend-url", "https://app.example.com")
	t.Cleanup(viper.Reset)

	s := newOIDCTestServer(t)
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.Host = "api.example.com"
	// frontend-url host differs from backend host → cross-origin → SameSite=None; Secure.
	if err := s.setSession(w, r, &sessionData{Sub: "u"}); err != nil {
		t.Fatalf("setSession: %v", err)
	}
	for _, c := range w.Result().Cookies() {
		if c.Name == sessionCookieName {
			if c.SameSite != http.SameSiteNoneMode {
				t.Fatalf("expected SameSite=None, got %v", c.SameSite)
			}
			if !c.Secure {
				t.Fatal("expected Secure=true for SameSite=None cookie")
			}
			return
		}
	}
	t.Fatal("session cookie not found")
}

func TestIsCrossOrigin_DefaultPortStripped(t *testing.T) {
	viper.Reset()
	// frontend-url has no explicit port; r.Host has the default HTTPS port.
	// They should be treated as the same origin.
	viper.Set("frontend-url", "https://example.com")
	t.Cleanup(viper.Reset)

	s := &Server{}
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.Host = "example.com:443"
	r.Header.Set("X-Forwarded-Proto", "https")

	if s.isCrossOrigin(r) {
		t.Fatal("expected same-origin when default port 443 is explicit in r.Host")
	}
}

func TestIsCrossOrigin_DefaultHTTPPortStripped(t *testing.T) {
	viper.Reset()
	viper.Set("frontend-url", "http://example.com")
	t.Cleanup(viper.Reset)

	s := &Server{}
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.Host = "example.com:80"

	if s.isCrossOrigin(r) {
		t.Fatal("expected same-origin when default port 80 is explicit in r.Host")
	}
}

func TestIsCrossOrigin_NonDefaultPortMatches(t *testing.T) {
	viper.Reset()
	viper.Set("frontend-url", "https://example.com:8443")
	t.Cleanup(viper.Reset)

	s := &Server{}
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.Host = "example.com:8443"
	r.Header.Set("X-Forwarded-Proto", "https")

	if s.isCrossOrigin(r) {
		t.Fatal("expected same-origin when non-default ports match")
	}
}

func TestSetSession_SameOriginWithExplicitDefaultPort(t *testing.T) {
	viper.Reset()
	viper.Set("frontend-url", "https://example.com")
	t.Cleanup(viper.Reset)

	s := newOIDCTestServer(t)
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.Host = "example.com:443"
	r.Header.Set("X-Forwarded-Proto", "https")

	if err := s.setSession(w, r, &sessionData{Sub: "u"}); err != nil {
		t.Fatalf("setSession: %v", err)
	}
	for _, c := range w.Result().Cookies() {
		if c.Name == sessionCookieName {
			if c.SameSite != http.SameSiteLaxMode {
				t.Fatalf("expected SameSite=Lax for same-origin with explicit default port, got %v", c.SameSite)
			}
			return
		}
	}
	t.Fatal("session cookie not found")
}

func TestClearSession(t *testing.T) {
	s := newOIDCTestServer(t)
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "/auth/logout", nil)
	s.clearSession(w, r)

	cookies := w.Result().Cookies()
	for _, c := range cookies {
		if c.Name == sessionCookieName {
			if c.MaxAge != -1 {
				t.Fatalf("expected MaxAge=-1, got %d", c.MaxAge)
			}
			return
		}
	}
	t.Fatal("session cookie not present in response after clearSession")
}

// --- oidcMeHandler ---

func TestOIDCMeHandler_Unauthenticated(t *testing.T) {
	s := newOIDCTestServer(t)
	r := httptest.NewRequest(http.MethodGet, "/auth/me", nil)
	w := httptest.NewRecorder()
	s.oidcMeHandler(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("got %d, want 401", w.Code)
	}
}

func TestOIDCMeHandler_TamperedCookie(t *testing.T) {
	s := newOIDCTestServer(t)
	r := httptest.NewRequest(http.MethodGet, "/auth/me", nil)
	r.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "bad|data"})
	w := httptest.NewRecorder()
	s.oidcMeHandler(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("got %d, want 401", w.Code)
	}
}

func TestOIDCMeHandler_Authenticated(t *testing.T) {
	s := newOIDCTestServer(t)

	// Create a valid session.
	rSet := httptest.NewRequest(http.MethodGet, "/", nil)
	wSet := httptest.NewRecorder()
	sess := &sessionData{Sub: "u1", Email: "bob@example.com", Name: "Bob"}
	if err := s.setSession(wSet, rSet, sess); err != nil {
		t.Fatalf("setSession: %v", err)
	}

	r := httptest.NewRequest(http.MethodGet, "/auth/me", nil)
	for _, c := range wSet.Result().Cookies() {
		r.AddCookie(c)
	}
	w := httptest.NewRecorder()
	s.oidcMeHandler(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("got %d, want 200", w.Code)
	}
	var got sessionData
	if err := json.NewDecoder(w.Body).Decode(&got); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if got.Email != sess.Email || got.Name != sess.Name {
		t.Fatalf("response mismatch: got %+v, want %+v", got, sess)
	}
}

// --- oidcUserinfoCallback ---

func TestOIDCUserinfoCallback_EmptySubject(t *testing.T) {
	viper.Reset()
	t.Cleanup(viper.Reset)

	s := newOIDCTestServer(t)
	r := httptest.NewRequest(http.MethodGet, "/auth/callback", nil)
	w := httptest.NewRecorder()

	info := &oidc.UserInfo{} // Subject is ""
	s.oidcUserinfoCallback(w, r, nil, "", nil, info)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("got %d, want 401 for empty subject", w.Code)
	}
}

func TestOIDCUserinfoCallback_ValidSubject(t *testing.T) {
	viper.Reset()
	t.Cleanup(viper.Reset)

	s := newOIDCTestServer(t)
	r := httptest.NewRequest(http.MethodGet, "/auth/callback", nil)
	w := httptest.NewRecorder()

	info := &oidc.UserInfo{}
	info.Subject = "user-123"
	info.Email = "alice@example.com"
	s.oidcUserinfoCallback(w, r, nil, "", nil, info)

	// Should redirect (302), not error.
	if w.Code != http.StatusFound {
		t.Fatalf("got %d, want 302 for valid subject", w.Code)
	}
}

// --- oidcLogoutHandler ---

func TestOIDCLogoutHandler(t *testing.T) {
	viper.Reset()
	s := newOIDCTestServer(t)

	// Set a valid session first.
	rSet := httptest.NewRequest(http.MethodGet, "/", nil)
	wSet := httptest.NewRecorder()
	_ = s.setSession(wSet, rSet, &sessionData{Sub: "u1"})

	r := httptest.NewRequest(http.MethodGet, "/auth/logout", nil)
	for _, c := range wSet.Result().Cookies() {
		r.AddCookie(c)
	}
	w := httptest.NewRecorder()
	s.oidcLogoutHandler(w, r)

	if w.Code != http.StatusFound {
		t.Fatalf("got %d, want 302", w.Code)
	}
	// Session cookie should be cleared.
	for _, c := range w.Result().Cookies() {
		if c.Name == sessionCookieName && c.MaxAge != -1 {
			t.Fatalf("session cookie MaxAge not -1 after logout")
		}
	}
}

func TestOIDCLogoutHandler_FrontendURL(t *testing.T) {
	viper.Reset()
	viper.Set("frontend-url", "https://app.example.com")
	t.Cleanup(viper.Reset)

	s := newOIDCTestServer(t)
	r := httptest.NewRequest(http.MethodGet, "/auth/logout", nil)
	w := httptest.NewRecorder()
	s.oidcLogoutHandler(w, r)

	loc := w.Header().Get("Location")
	if !strings.HasPrefix(loc, "https://app.example.com") {
		t.Fatalf("redirect location %q does not start with frontend-url", loc)
	}
}

// --- emailAllowed ---

func TestEmailAllowed(t *testing.T) {
	tests := []struct {
		domains []string
		email   string
		want    bool
	}{
		{nil, "alice@any.org", true},                                        // no restriction → always allowed
		{[]string{"example.com"}, "alice@example.com", true},
		{[]string{"Example.COM"}, "alice@example.com", true},               // case-insensitive
		{[]string{"example.com"}, "alice@other.org", false},
		{[]string{"example.com"}, "notanemail", false},                     // no @ → rejected
		{[]string{"example.com"}, "@example.com", true},                   // empty local part: domain still matches
		{nil, "user@", false},                                               // empty domain, no restriction → rejected
		{nil, "", false},                                                    // empty email, no restriction → rejected
		{[]string{"corp.example.com", "example.com"}, "alice@example.com", true},  // multi-domain: second matches
		{[]string{"corp.example.com", "other.org"}, "alice@example.com", false},   // multi-domain: no match
		{[]string{"corp.example.com", "example.com"}, "bob@corp.example.com", true}, // multi-domain: first matches
	}
	for _, tc := range tests {
		t.Run(tc.email, func(t *testing.T) {
			viper.Reset()
			if len(tc.domains) > 0 {
				viper.Set("oidc-allowed-domains", tc.domains)
			}
			t.Cleanup(viper.Reset)
			if got := emailAllowed(tc.email); got != tc.want {
				t.Fatalf("emailAllowed(%q) with domains %v = %v, want %v", tc.email, tc.domains, got, tc.want)
			}
		})
	}
}

// --- requireAuthMiddleware ---

func okHandler(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusOK)
}

func authedRequest(t *testing.T, s Server, email string) *http.Request {
	t.Helper()
	rSet := httptest.NewRequest(http.MethodGet, "/", nil)
	wSet := httptest.NewRecorder()
	if err := s.setSession(wSet, rSet, &sessionData{Sub: "u", Email: email, Name: "U"}); err != nil {
		t.Fatalf("setSession: %v", err)
	}
	r := httptest.NewRequest(http.MethodGet, "/secret/x", nil)
	for _, c := range wSet.Result().Cookies() {
		r.AddCookie(c)
	}
	return r
}

func TestRequireAuthMiddleware_NoSession(t *testing.T) {
	viper.Reset()
	s := newOIDCTestServer(t)
	h := s.requireAuthMiddleware(http.HandlerFunc(okHandler))

	r := httptest.NewRequest(http.MethodGet, "/secret/x", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("got %d, want 401", w.Code)
	}
}

func TestRequireAuthMiddleware_ValidSession_NoDomainRestriction(t *testing.T) {
	viper.Reset()
	s := newOIDCTestServer(t)
	h := s.requireAuthMiddleware(http.HandlerFunc(okHandler))

	r := authedRequest(t, s, "alice@any.org")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("got %d, want 200", w.Code)
	}
}

func TestRequireAuthMiddleware_AllowedDomain(t *testing.T) {
	viper.Reset()
	viper.Set("oidc-allowed-domains", []string{"example.com"})
	t.Cleanup(viper.Reset)

	s := newOIDCTestServer(t)
	h := s.requireAuthMiddleware(http.HandlerFunc(okHandler))

	r := authedRequest(t, s, "alice@example.com")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("got %d, want 200", w.Code)
	}
}

func TestRequireAuthMiddleware_DomainCaseInsensitive(t *testing.T) {
	viper.Reset()
	viper.Set("oidc-allowed-domains", []string{"Example.COM"})
	t.Cleanup(viper.Reset)

	s := newOIDCTestServer(t)
	h := s.requireAuthMiddleware(http.HandlerFunc(okHandler))

	r := authedRequest(t, s, "alice@example.com")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("got %d, want 200", w.Code)
	}
}

func TestRequireAuthMiddleware_WrongDomain(t *testing.T) {
	viper.Reset()
	viper.Set("oidc-allowed-domains", []string{"example.com"})
	t.Cleanup(viper.Reset)

	s := newOIDCTestServer(t)
	h := s.requireAuthMiddleware(http.HandlerFunc(okHandler))

	r := authedRequest(t, s, "bob@other.org")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusForbidden {
		t.Fatalf("got %d, want 403", w.Code)
	}
}

func TestRequireAuthMiddleware_MalformedEmail(t *testing.T) {
	viper.Reset()
	viper.Set("oidc-allowed-domains", []string{"example.com"})
	t.Cleanup(viper.Reset)

	s := newOIDCTestServer(t)
	h := s.requireAuthMiddleware(http.HandlerFunc(okHandler))

	r := authedRequest(t, s, "notanemail")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusForbidden {
		t.Fatalf("got %d, want 403", w.Code)
	}
}

// --- maybeRequireAuth ---

func TestMaybeRequireAuth_NoOIDC(t *testing.T) {
	viper.Reset()
	viper.Set("require-auth", true)
	t.Cleanup(viper.Reset)

	s := newOIDCTestServer(t) // OIDCProvider is nil
	h := s.maybeRequireAuth(okHandler)

	r := httptest.NewRequest(http.MethodGet, "/", nil) // no session
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	// No OIDC → passthrough regardless of require-auth flag.
	if w.Code != http.StatusOK {
		t.Fatalf("got %d, want 200 (no OIDC provider)", w.Code)
	}
}

func TestMaybeRequireAuth_OIDCButRequireAuthFalse(t *testing.T) {
	viper.Reset()
	viper.Set("require-auth", false)
	t.Cleanup(viper.Reset)

	s := newOIDCTestServer(t)
	s.OIDCProvider = &mockOIDCProvider{} // non-nil provider
	h := s.maybeRequireAuth(okHandler)

	r := httptest.NewRequest(http.MethodGet, "/", nil) // no session
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("got %d, want 200 (require-auth=false)", w.Code)
	}
}

func TestMaybeRequireAuth_OIDCAndRequireAuthTrue_Blocks(t *testing.T) {
	viper.Reset()
	viper.Set("require-auth", true)
	t.Cleanup(viper.Reset)

	s := newOIDCTestServer(t)
	s.OIDCProvider = &mockOIDCProvider{}
	h := s.maybeRequireAuth(okHandler)

	r := httptest.NewRequest(http.MethodGet, "/", nil) // no session → should be blocked
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("got %d, want 401", w.Code)
	}
}

func TestMaybeRequireAuth_OIDCAndRequireAuthTrue_Passes(t *testing.T) {
	viper.Reset()
	viper.Set("require-auth", true)
	t.Cleanup(viper.Reset)

	s := newOIDCTestServer(t)
	s.OIDCProvider = &mockOIDCProvider{}
	h := s.maybeRequireAuth(okHandler)

	r := authedRequest(t, s, "alice@example.com")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("got %d, want 200", w.Code)
	}
}

// --- getSession with nil CookieCodec ---

func TestGetSession_NilCookieCodec(t *testing.T) {
	s := Server{CookieCodec: nil}
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	session, err := s.getSession(r)
	if err != nil {
		t.Fatalf("expected no error with nil CookieCodec, got: %v", err)
	}
	if session != nil {
		t.Fatalf("expected nil session with nil CookieCodec, got: %+v", session)
	}
}

// mockOIDCProvider satisfies the rp.RelyingParty interface minimally so we can
// set Server.OIDCProvider to non-nil without a real OIDC discovery endpoint.
// maybeRequireAuth only checks OIDCProvider != nil; no methods are called.
type mockOIDCProvider struct{}

func (m *mockOIDCProvider) OAuthConfig() *oauth2.Config { return nil }
func (m *mockOIDCProvider) Issuer() string              { return "https://mock.issuer" }
func (m *mockOIDCProvider) IsPKCE() bool                { return false }
func (m *mockOIDCProvider) CookieHandler() *httphelper.CookieHandler {
	return nil
}
func (m *mockOIDCProvider) HttpClient() *http.Client              { return http.DefaultClient }
func (m *mockOIDCProvider) IsOAuth2Only() bool                    { return false }
func (m *mockOIDCProvider) Signer() jose.Signer                   { return nil }
func (m *mockOIDCProvider) IDTokenVerifier() *rp.IDTokenVerifier  { return nil }
func (m *mockOIDCProvider) UserinfoEndpoint() string              { return "" }
func (m *mockOIDCProvider) GetDeviceAuthorizationEndpoint() string { return "" }
func (m *mockOIDCProvider) GetEndSessionEndpoint() string         { return "" }
func (m *mockOIDCProvider) GetRevokeEndpoint() string             { return "" }
func (m *mockOIDCProvider) ErrorHandler() func(http.ResponseWriter, *http.Request, string, string, string) {
	return nil
}
func (m *mockOIDCProvider) Logger(context.Context) (*slog.Logger, bool) { return nil, false }

// --- randomState ---

func TestRandomState(t *testing.T) {
	a := randomState()
	b := randomState()
	if len(a) != 32 {
		t.Fatalf("expected 32 hex chars, got %d (%q)", len(a), a)
	}
	if a == b {
		t.Fatal("two calls should produce different states")
	}
	for _, c := range a {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			t.Fatalf("non-hex character %q in state %q", c, a)
		}
	}
}

// --- NewOIDCProvider: missing-config error path ---

func TestNewOIDCProvider_MissingConfig(t *testing.T) {
	viper.Reset()
	t.Cleanup(viper.Reset)

	// All required fields empty — should fail before any network call.
	_, err := NewOIDCProvider(context.Background(), zaptest.NewLogger(t), "")
	if err == nil {
		t.Fatal("expected error when oidc-issuer, oidc-client-id, oidc-redirect-url are empty")
	}
	if !strings.Contains(err.Error(), "required") {
		t.Fatalf("error message missing 'required': %v", err)
	}

	// Partial config should also fail.
	viper.Set("oidc-issuer", "https://issuer.example")
	_, err = NewOIDCProvider(context.Background(), zaptest.NewLogger(t), "")
	if err == nil {
		t.Fatal("expected error when client-id and redirect-url are empty")
	}
}

// fullMockOIDCProvider satisfies rp.RelyingParty with enough real state for
// rp.AuthURLHandler and rp.CodeExchangeHandler to run end-to-end without
// panicking. Unlike mockOIDCProvider, it returns a non-nil *oauth2.Config and
// a real *httphelper.CookieHandler.
type fullMockOIDCProvider struct {
	oauth     *oauth2.Config
	cookies   *httphelper.CookieHandler
}

func newFullMockOIDCProvider() *fullMockOIDCProvider {
	hashKey := make([]byte, 32)
	encKey := make([]byte, 32)
	for i := range hashKey {
		hashKey[i] = byte(i + 1)
		encKey[i] = byte(i + 33)
	}
	return &fullMockOIDCProvider{
		oauth: &oauth2.Config{
			ClientID:     "client-id",
			ClientSecret: "client-secret",
			RedirectURL:  "https://app.example/callback",
			Endpoint: oauth2.Endpoint{
				AuthURL:  "https://issuer.example/authorize",
				TokenURL: "https://issuer.example/token",
			},
			Scopes: []string{"openid", "email"},
		},
		cookies: httphelper.NewCookieHandler(hashKey, encKey),
	}
}

func (m *fullMockOIDCProvider) OAuthConfig() *oauth2.Config            { return m.oauth }
func (m *fullMockOIDCProvider) Issuer() string                          { return "https://issuer.example" }
func (m *fullMockOIDCProvider) IsPKCE() bool                            { return false }
func (m *fullMockOIDCProvider) CookieHandler() *httphelper.CookieHandler { return m.cookies }
func (m *fullMockOIDCProvider) HttpClient() *http.Client                { return http.DefaultClient }
func (m *fullMockOIDCProvider) IsOAuth2Only() bool                      { return false }
func (m *fullMockOIDCProvider) Signer() jose.Signer                     { return nil }
func (m *fullMockOIDCProvider) IDTokenVerifier() *rp.IDTokenVerifier    { return nil }
func (m *fullMockOIDCProvider) UserinfoEndpoint() string                { return "" }
func (m *fullMockOIDCProvider) GetDeviceAuthorizationEndpoint() string  { return "" }
func (m *fullMockOIDCProvider) GetEndSessionEndpoint() string           { return "" }
func (m *fullMockOIDCProvider) GetRevokeEndpoint() string               { return "" }
func (m *fullMockOIDCProvider) ErrorHandler() func(http.ResponseWriter, *http.Request, string, string, string) {
	return nil
}
func (m *fullMockOIDCProvider) Logger(context.Context) (*slog.Logger, bool) { return nil, false }

// --- oidcLoginHandler ---

func TestOIDCLoginHandler_Redirects(t *testing.T) {
	s := newOIDCTestServer(t)
	s.OIDCProvider = newFullMockOIDCProvider()

	r := httptest.NewRequest(http.MethodGet, "/login", nil)
	w := httptest.NewRecorder()

	s.oidcLoginHandler(w, r)

	if w.Code != http.StatusFound {
		t.Fatalf("expected 302, got %d", w.Code)
	}
	loc := w.Header().Get("Location")
	if !strings.HasPrefix(loc, "https://issuer.example/authorize") {
		t.Fatalf("expected redirect to authorize endpoint, got %q", loc)
	}
}

// --- oidcCallbackHandler ---

func TestOIDCCallbackHandler_NoStateOrCode(t *testing.T) {
	s := newOIDCTestServer(t)
	s.OIDCProvider = newFullMockOIDCProvider()

	// No code, no state cookie → the library must reject the request.
	r := httptest.NewRequest(http.MethodGet, "/callback", nil)
	w := httptest.NewRecorder()

	s.oidcCallbackHandler(w, r)

	// rp.CodeExchangeHandler responds with an error status when state validation fails.
	if w.Code < 400 {
		t.Fatalf("expected 4xx/5xx response for missing state/code, got %d", w.Code)
	}
}
