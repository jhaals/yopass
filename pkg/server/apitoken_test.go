package server

// Tests for machine-to-machine API token authentication on the
// --require-auth gated creation endpoints.
//
// Uses mockOIDCProvider from oidc_test.go and the stream/request test
// helpers (same package).

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jhaals/yopass/pkg/yopass"
)

const testAPITokenSecret = "0123456789abcdef0123456789abcdef"

// testAPIToken builds an APIToken as ParseAPITokens would, with the
// secret's digest precomputed.
func testAPIToken(name, secret string) APIToken {
	return APIToken{Name: name, digest: sha256.Sum256([]byte(secret))}
}

// enableAPITokens turns srv into a require-auth server with one API token
// named "cmdb" configured.
func enableAPITokens(srv *Server) {
	srv.RequireAuth = true
	srv.APITokens = []APIToken{testAPIToken("cmdb", testAPITokenSecret)}
}

func createSecretRequestWithAuth(authorization string) *http.Request {
	body := `{"message":"` + pgpTestMessage + `","expiration":3600,"one_time":false}`
	req := httptest.NewRequest(http.MethodPost, "/create/secret", strings.NewReader(body))
	if authorization != "" {
		req.Header.Set("Authorization", authorization)
	}
	return req
}

func TestParseAPITokens(t *testing.T) {
	tests := []struct {
		name    string
		entries []string
		want    []APIToken
		wantErr string
	}{
		{
			name:    "single valid token",
			entries: []string{"cmdb:" + testAPITokenSecret},
			want:    []APIToken{testAPIToken("cmdb", testAPITokenSecret)},
		},
		{
			name:    "multiple tokens",
			entries: []string{"cmdb:" + testAPITokenSecret, "ops:" + testAPITokenSecret + "x"},
			want: []APIToken{
				testAPIToken("cmdb", testAPITokenSecret),
				testAPIToken("ops", testAPITokenSecret+"x"),
			},
		},
		{
			name:    "secret may contain colons",
			entries: []string{"svc:abc:def:0123456789abcdef"},
			want:    []APIToken{testAPIToken("svc", "abc:def:0123456789abcdef")},
		},
		{
			name:    "missing separator",
			entries: []string{"justonevalue0123456789"},
			wantErr: "expected format name:secret",
		},
		{
			name:    "empty name",
			entries: []string{":" + testAPITokenSecret},
			wantErr: "expected format name:secret",
		},
		{
			name:    "empty secret",
			entries: []string{"cmdb:"},
			wantErr: "expected format name:secret",
		},
		{
			name:    "secret too short",
			entries: []string{"cmdb:short"},
			wantErr: "at least 16 characters",
		},
		{
			name:    "duplicate name",
			entries: []string{"cmdb:" + testAPITokenSecret, "cmdb:" + testAPITokenSecret + "x"},
			wantErr: "duplicate api-token name",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ParseAPITokens(tc.entries)
			if tc.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("expected error containing %q, got %v", tc.wantErr, err)
				}
				// The secret must never leak into the error message.
				for _, entry := range tc.entries {
					if _, secret, ok := strings.Cut(entry, ":"); ok && secret != "" && strings.Contains(err.Error(), secret) {
						t.Fatalf("error message leaks token secret: %v", err)
					}
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if len(got) != len(tc.want) {
				t.Fatalf("expected %d tokens, got %d", len(tc.want), len(got))
			}
			for i := range tc.want {
				if got[i] != tc.want[i] {
					t.Errorf("token %d: expected %+v, got %+v", i, tc.want[i], got[i])
				}
			}
		})
	}
}

func TestAPIToken_CreateSecret(t *testing.T) {
	tests := []struct {
		name          string
		authorization string
		allowedDomain string
		expectedCode  int
	}{
		{
			name:          "valid token → 200",
			authorization: "Bearer " + testAPITokenSecret,
			expectedCode:  http.StatusOK,
		},
		{
			name:          "lowercase scheme accepted → 200",
			authorization: "bearer " + testAPITokenSecret,
			expectedCode:  http.StatusOK,
		},
		{
			name:          "wrong token → 401",
			authorization: "Bearer wrong-token-0123456789abcdef",
			expectedCode:  http.StatusUnauthorized,
		},
		{
			name:          "no credentials → 401",
			authorization: "",
			expectedCode:  http.StatusUnauthorized,
		},
		{
			name:          "non-bearer scheme → 401",
			authorization: "Basic " + testAPITokenSecret,
			expectedCode:  http.StatusUnauthorized,
		},
		{
			name:          "token bypasses email domain restriction → 200",
			authorization: "Bearer " + testAPITokenSecret,
			allowedDomain: "allowed.com",
			expectedCode:  http.StatusOK,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			srv := newServerWithOIDC(t, newTestDB())
			enableAPITokens(&srv)
			srv.AllowedEmailDomains = allowedDomainsOrNil(tc.allowedDomain)
			handler := srv.HTTPHandler()

			w := httptest.NewRecorder()
			handler.ServeHTTP(w, createSecretRequestWithAuth(tc.authorization))

			if w.Code != tc.expectedCode {
				t.Fatalf("expected %d, got %d: %s", tc.expectedCode, w.Code, w.Body.String())
			}
		})
	}
}

func TestAPIToken_BearerIgnoredWhenNoTokensConfigured(t *testing.T) {
	srv := newServerWithOIDC(t, newTestDB())
	srv.RequireAuth = true // no APITokens configured
	handler := srv.HTTPHandler()

	w := httptest.NewRecorder()
	handler.ServeHTTP(w, createSecretRequestWithAuth("Bearer "+testAPITokenSecret))

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d: %s", w.Code, w.Body.String())
	}
}

func TestAPIToken_SessionCookieStillWorks(t *testing.T) {
	// Configuring API tokens must not break the interactive cookie flow.
	srv := newServerWithOIDC(t, newTestDB())
	enableAPITokens(&srv)
	handler := srv.HTTPHandler()

	req := createSecretRequestWithAuth("")
	for _, c := range sessionCookiesFor(t, &srv) {
		req.AddCookie(c)
	}
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
}

func TestAPIToken_AuditAttribution(t *testing.T) {
	srv := newServerWithOIDC(t, newTestDB())
	enableAPITokens(&srv)
	audit := &capturingAuditLogger{}
	srv.Audit = audit
	handler := srv.HTTPHandler()

	w := httptest.NewRecorder()
	handler.ServeHTTP(w, createSecretRequestWithAuth("Bearer "+testAPITokenSecret))

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	if len(audit.events) != 1 {
		t.Fatalf("expected 1 audit event, got %d", len(audit.events))
	}
	e := audit.events[0]
	if e.Event != "secret.created" || e.Outcome != OutcomeSuccess {
		t.Errorf("unexpected event %q outcome %q", e.Event, e.Outcome)
	}
	if e.UserEmail != "service:cmdb" {
		t.Errorf("expected user_email service:cmdb, got %q", e.UserEmail)
	}
	if e.UserSubject != "api-token:cmdb" {
		t.Errorf("expected user_subject api-token:cmdb, got %q", e.UserSubject)
	}
}

func TestAPIToken_FileUpload(t *testing.T) {
	srv := newServerWithOIDC(t, newTestDB())
	enableAPITokens(&srv)
	handler := srv.HTTPHandler()

	// Without credentials the upload is rejected.
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, streamUploadRequest(pgpBody("data"), "3600", "false", "test.bin"))
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d: %s", w.Code, w.Body.String())
	}

	// With a valid token it succeeds.
	req := streamUploadRequest(pgpBody("data"), "3600", "false", "test.bin")
	req.Header.Set("Authorization", "Bearer "+testAPITokenSecret)
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
}

func TestAPIToken_SecretRequestCreation(t *testing.T) {
	srv := newServerWithOIDC(t, newTestDB())
	enableAPITokens(&srv)
	srv.License = LicenseStatus{Valid: true}
	handler := srv.HTTPHandler()

	body, _ := json.Marshal(map[string]interface{}{
		"public_key": testPublicKey(t),
		"expiration": 3600,
	})

	w := httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/request", bytes.NewReader(body)))
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d: %s", w.Code, w.Body.String())
	}

	req := httptest.NewRequest(http.MethodPost, "/request", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+testAPITokenSecret)
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
}

func TestAPIToken_DoesNotAuthorizeRetrieval(t *testing.T) {
	// API tokens gate creation only; retrieving a RequireAuth-protected
	// secret still demands an interactive session.
	db := newTestDB()
	srv := newServerWithOIDC(t, db)
	enableAPITokens(&srv)
	handler := srv.HTTPHandler()

	const key = "0f5c8ac2-53a4-45a4-a3a8-b6f892bd52c2"
	if err := db.Put(key, yopass.Secret{
		Message:     pgpTestMessage,
		Expiration:  3600,
		RequireAuth: true,
	}); err != nil {
		t.Fatalf("DB.Put: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/secret/"+key, nil)
	req.Header.Set("Authorization", "Bearer "+testAPITokenSecret)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d: %s", w.Code, w.Body.String())
	}
}
