package server

// Tests for the require_auth feature across both text secrets and streaming files.
//
// Uses mockOIDCProvider defined in oidc_test.go (same package).

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gorilla/mux"
	"github.com/jhaals/yopass/pkg/yopass"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/spf13/viper"
	"go.uber.org/zap/zaptest"
)

// pgpTestMessage is a minimal valid PGP-armored message used by require_auth tests.
// Newlines are escaped so the constant can be embedded directly in JSON strings.
const pgpTestMessage = `-----BEGIN PGP MESSAGE-----\nVersion: OpenPGP.js v4.10.8\nComment: https://openpgpjs.org\n\nwy4ECQMIRthQ3aO85NvgAfASIX3dTwsFVt0gshPu7n1tN05e8rpqxOk6PYNm\nxtt90k4BqHuTCLNlFRJjuiuE8zdIc+j5zTN5zihxUReVqokeqULLOx2FBMHZ\nsbfqaG/iDbp+qDOc98IagMyPrEqKDxnhVVOraXy5dD9RDsntLso=\n=0vwU\n-----END PGP MESSAGE-----`

// newServerWithOIDC returns a Server that has a non-nil OIDCProvider and a
// working CookieCodec so require_auth enforcement can be tested end-to-end.
func newServerWithOIDC(t *testing.T, db Database) Server {
	t.Helper()
	return Server{
		DB:          db,
		FileStore:   NewDatabaseFileStore(db.(*testDB)), // testDB satisfies both interfaces
		MaxLength:   10000,
		MaxFileSize: 1024 * 1024,
		Registry:    prometheus.NewRegistry(),
		Logger:      zaptest.NewLogger(t),
		OIDCProvider: &mockOIDCProvider{},
		CookieCodec:  NewCookieCodec(""),
	}
}

// sessionCookiesFor creates a valid session cookie for the given server.
func sessionCookiesFor(t *testing.T, srv Server) []*http.Cookie {
	t.Helper()
	rSet := httptest.NewRequest(http.MethodGet, "/", nil)
	wSet := httptest.NewRecorder()
	if err := srv.setSession(wSet, rSet, &sessionData{Sub: "u1", Email: "user@example.com", Name: "User"}); err != nil {
		t.Fatalf("setSession: %v", err)
	}
	return wSet.Result().Cookies()
}

// ── createSecret: require_auth validation ────────────────────────────────────

func TestCreateSecretRequireAuth_NoOIDC_Returns400(t *testing.T) {
	// require_auth=true must be rejected when no OIDC provider is configured.
	db := newTestDB()
	srv := Server{
		DB:        db,
		FileStore: NewDatabaseFileStore(db),
		MaxLength: 10000,
		Registry:  prometheus.NewRegistry(),
		Logger:    zaptest.NewLogger(t),
		// OIDCProvider intentionally nil
	}

	body := `{"message":"` + pgpTestMessage + `","expiration":3600,"one_time":false,"require_auth":true}`
	req := httptest.NewRequest(http.MethodPost, "/create/secret", strings.NewReader(body))
	w := httptest.NewRecorder()
	srv.createSecret(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", w.Code, w.Body.String())
	}
}

func TestCreateSecretRequireAuth_WithOIDC_Stores(t *testing.T) {
	// require_auth=true is accepted when OIDC is configured and the field is persisted.
	db := newTestDB()
	srv := newServerWithOIDC(t, db)

	body := `{"message":"` + pgpTestMessage + `","expiration":3600,"one_time":false,"require_auth":true}`
	req := httptest.NewRequest(http.MethodPost, "/create/secret", strings.NewReader(body))
	w := httptest.NewRecorder()
	srv.createSecret(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	// Extract the UUID from the response.
	var resp map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("invalid response JSON: %v", err)
	}
	id := resp["message"]

	// Verify the stored secret has RequireAuth=true.
	stored, err := db.Get(id)
	if err != nil {
		t.Fatalf("secret not found in DB: %v", err)
	}
	if !stored.RequireAuth {
		t.Error("expected RequireAuth=true in stored secret")
	}
}

func TestCreateSecretRequireAuth_False_AlwaysAccepted(t *testing.T) {
	// require_auth=false (the default) must work regardless of OIDC configuration.
	db := newTestDB()
	srv := Server{
		DB:        db,
		FileStore: NewDatabaseFileStore(db),
		MaxLength: 10000,
		Registry:  prometheus.NewRegistry(),
		Logger:    zaptest.NewLogger(t),
		// OIDCProvider intentionally nil
	}

	body := `{"message":"` + pgpTestMessage + `","expiration":3600,"one_time":false,"require_auth":false}`
	req := httptest.NewRequest(http.MethodPost, "/create/secret", strings.NewReader(body))
	w := httptest.NewRecorder()
	srv.createSecret(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
}

// ── getSecret: require_auth enforcement ──────────────────────────────────────

func TestGetSecret_RequireAuth(t *testing.T) {
	tests := []struct {
		name          string
		requireAuth   bool
		withSession   bool
		allowedDomain string
		expectedCode  int
	}{
		{
			name:         "RequireAuth=true, no session → 401",
			requireAuth:  true,
			withSession:  false,
			expectedCode: http.StatusUnauthorized,
		},
		{
			name:         "RequireAuth=true, valid session → 200",
			requireAuth:  true,
			withSession:  true,
			expectedCode: http.StatusOK,
		},
		{
			name:         "RequireAuth=false, no session → 200",
			requireAuth:  false,
			withSession:  false,
			expectedCode: http.StatusOK,
		},
		{
			name:          "RequireAuth=true, session with matching domain → 200",
			requireAuth:   true,
			withSession:   true,
			allowedDomain: "example.com",
			expectedCode:  http.StatusOK,
		},
		{
			name:          "RequireAuth=true, session with disallowed domain → 403",
			requireAuth:   true,
			withSession:   true,
			allowedDomain: "allowed.com",
			expectedCode:  http.StatusForbidden,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if tc.allowedDomain != "" {
				viper.Set("oidc-allowed-domain", tc.allowedDomain)
				t.Cleanup(func() { viper.Set("oidc-allowed-domain", "") })
			}
			db := newTestDB()
			srv := newServerWithOIDC(t, db)

			// Pre-seed the DB with a secret.
			const key = "testkey-123"
			if err := db.Put(key, yopass.Secret{
				Message:     pgpTestMessage,
				OneTime:     false,
				Expiration:  3600,
				RequireAuth: tc.requireAuth,
			}); err != nil {
				t.Fatalf("DB.Put: %v", err)
			}

			req := httptest.NewRequest(http.MethodGet, "/secret/"+key, nil)
			req = mux.SetURLVars(req, map[string]string{"key": key})
			if tc.withSession {
				for _, c := range sessionCookiesFor(t, srv) {
					req.AddCookie(c)
				}
			}

			w := httptest.NewRecorder()
			srv.getSecret(w, req)

			if w.Code != tc.expectedCode {
				t.Fatalf("expected %d, got %d: %s", tc.expectedCode, w.Code, w.Body.String())
			}
		})
	}
}

// TestGetSecret_RequireAuth_OneTime verifies that an unauthenticated request to
// a one-time secret protected by RequireAuth does NOT consume the secret.
func TestGetSecret_RequireAuth_OneTime(t *testing.T) {
	const key = "onetimekey-auth"

	t.Run("unauthenticated request leaves secret intact", func(t *testing.T) {
		db := newTestDB()
		srv := newServerWithOIDC(t, db)

		if err := db.Put(key, yopass.Secret{
			Message:     pgpTestMessage,
			OneTime:     true,
			Expiration:  3600,
			RequireAuth: true,
		}); err != nil {
			t.Fatalf("DB.Put: %v", err)
		}

		// Unauthenticated request – must return 401 and NOT consume the secret.
		req := httptest.NewRequest(http.MethodGet, "/secret/"+key, nil)
		req = mux.SetURLVars(req, map[string]string{"key": key})
		w := httptest.NewRecorder()
		srv.getSecret(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Fatalf("expected 401, got %d: %s", w.Code, w.Body.String())
		}

		// Secret must still exist – authenticated read should succeed.
		req2 := httptest.NewRequest(http.MethodGet, "/secret/"+key, nil)
		req2 = mux.SetURLVars(req2, map[string]string{"key": key})
		for _, c := range sessionCookiesFor(t, srv) {
			req2.AddCookie(c)
		}
		w2 := httptest.NewRecorder()
		srv.getSecret(w2, req2)

		if w2.Code != http.StatusOK {
			t.Fatalf("secret was destroyed by unauthenticated request: expected 200, got %d: %s", w2.Code, w2.Body.String())
		}
	})

	t.Run("authenticated request consumes one-time secret", func(t *testing.T) {
		db := newTestDB()
		srv := newServerWithOIDC(t, db)

		if err := db.Put(key, yopass.Secret{
			Message:     pgpTestMessage,
			OneTime:     true,
			Expiration:  3600,
			RequireAuth: true,
		}); err != nil {
			t.Fatalf("DB.Put: %v", err)
		}

		cookies := sessionCookiesFor(t, srv)

		req := httptest.NewRequest(http.MethodGet, "/secret/"+key, nil)
		req = mux.SetURLVars(req, map[string]string{"key": key})
		for _, c := range cookies {
			req.AddCookie(c)
		}
		w := httptest.NewRecorder()
		srv.getSecret(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		// Second read must return 404 – secret was consumed.
		req2 := httptest.NewRequest(http.MethodGet, "/secret/"+key, nil)
		req2 = mux.SetURLVars(req2, map[string]string{"key": key})
		for _, c := range cookies {
			req2.AddCookie(c)
		}
		w2 := httptest.NewRecorder()
		srv.getSecret(w2, req2)

		if w2.Code != http.StatusNotFound {
			t.Fatalf("one-time secret should be gone after first read: expected 404, got %d", w2.Code)
		}
	})
}

// ── getSecretStatus: requireAuth field ───────────────────────────────────────

func TestGetSecretStatus_RequireAuthField(t *testing.T) {
	tests := []struct {
		name        string
		requireAuth bool
	}{
		{"requireAuth=false", false},
		{"requireAuth=true", true},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			db := newTestDB()
			const key = "statuskey"
			if err := db.Put(key, yopass.Secret{
				Message:     pgpTestMessage,
				OneTime:     false,
				RequireAuth: tc.requireAuth,
			}); err != nil {
				t.Fatalf("DB.Put: %v", err)
			}

			srv := newTestServer(t, db, 10000, false)
			req := httptest.NewRequest(http.MethodGet, "/secret/"+key+"/status", nil)
			req = mux.SetURLVars(req, map[string]string{"key": key})
			w := httptest.NewRecorder()
			srv.getSecretStatus(w, req)

			if w.Code != http.StatusOK {
				t.Fatalf("expected 200, got %d", w.Code)
			}

			var resp map[string]bool
			if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
				t.Fatalf("invalid JSON: %v", err)
			}
			if resp["requireAuth"] != tc.requireAuth {
				t.Errorf("expected requireAuth=%v, got %v", tc.requireAuth, resp["requireAuth"])
			}
		})
	}
}

// ── streamUpload: require_auth header ────────────────────────────────────────

func TestStreamUploadRequireAuth_NoOIDC_Returns400(t *testing.T) {
	db := newTestDB()
	srv := newStreamTestServer(t, db) // OIDCProvider is nil

	req := streamUploadRequest(pgpBody("data"), "3600", "false", "file.bin")
	req.Header.Set("X-Yopass-RequireAuth", "true")
	w := httptest.NewRecorder()
	srv.streamUpload(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", w.Code, w.Body.String())
	}
}

func TestStreamUploadRequireAuth_WithOIDC_Stores(t *testing.T) {
	db := newTestDB()
	srv := Server{
		DB:           db,
		FileStore:    NewDatabaseFileStore(db),
		MaxLength:    10000,
		MaxFileSize:  1024 * 1024,
		Registry:     prometheus.NewRegistry(),
		Logger:       zaptest.NewLogger(t),
		OIDCProvider: &mockOIDCProvider{},
		CookieCodec:  NewCookieCodec(""),
	}

	req := streamUploadRequest(pgpBody("encrypted-data"), "3600", "false", "secret.bin")
	req.Header.Set("X-Yopass-RequireAuth", "true")
	w := httptest.NewRecorder()
	srv.streamUpload(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("invalid response JSON: %v", err)
	}
	id := resp["message"]

	stored, err := db.Get(streamKeyPrefix + id)
	if err != nil {
		t.Fatalf("metadata not found in DB: %v", err)
	}
	if !stored.RequireAuth {
		t.Error("expected RequireAuth=true in stored metadata")
	}
}

func TestStreamUploadRequireAuth_False_AlwaysAccepted(t *testing.T) {
	db := newTestDB()
	srv := newStreamTestServer(t, db) // no OIDC

	req := streamUploadRequest(pgpBody("data"), "3600", "false", "file.bin")
	req.Header.Set("X-Yopass-RequireAuth", "false")
	w := httptest.NewRecorder()
	srv.streamUpload(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
}

// ── streamDownload: require_auth enforcement ─────────────────────────────────

func TestStreamDownload_RequireAuth(t *testing.T) {
	tests := []struct {
		name          string
		requireAuth   bool
		withSession   bool
		allowedDomain string
		expectedCode  int
	}{
		{
			name:         "RequireAuth=true, no session → 401",
			requireAuth:  true,
			withSession:  false,
			expectedCode: http.StatusUnauthorized,
		},
		{
			name:         "RequireAuth=true, valid session → 200",
			requireAuth:  true,
			withSession:  true,
			expectedCode: http.StatusOK,
		},
		{
			name:         "RequireAuth=false, no session → 200",
			requireAuth:  false,
			withSession:  false,
			expectedCode: http.StatusOK,
		},
		{
			name:          "RequireAuth=true, session with matching domain → 200",
			requireAuth:   true,
			withSession:   true,
			allowedDomain: "example.com",
			expectedCode:  http.StatusOK,
		},
		{
			name:          "RequireAuth=true, session with disallowed domain → 403",
			requireAuth:   true,
			withSession:   true,
			allowedDomain: "allowed.com",
			expectedCode:  http.StatusForbidden,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if tc.allowedDomain != "" {
				viper.Set("oidc-allowed-domain", tc.allowedDomain)
				t.Cleanup(func() { viper.Set("oidc-allowed-domain", "") })
			}
			db := newTestDB()
			srv := Server{
				DB:           db,
				FileStore:    NewDatabaseFileStore(db),
				MaxLength:    10000,
				MaxFileSize:  1024 * 1024,
				Registry:     prometheus.NewRegistry(),
				Logger:       zaptest.NewLogger(t),
				OIDCProvider: &mockOIDCProvider{},
				CookieCodec:  NewCookieCodec(""),
			}

			// Upload a file first with the appropriate RequireAuth setting.
			uploadReq := streamUploadRequest(pgpBody("file-content"), "3600", "false", "test.bin")
			if tc.requireAuth {
				uploadReq.Header.Set("X-Yopass-RequireAuth", "true")
			}
			uploadW := httptest.NewRecorder()
			srv.streamUpload(uploadW, uploadReq)
			if uploadW.Code != http.StatusOK {
				t.Fatalf("upload failed: %d %s", uploadW.Code, uploadW.Body.String())
			}
			var uploadResp map[string]string
			if err := json.Unmarshal(uploadW.Body.Bytes(), &uploadResp); err != nil {
				t.Fatalf("invalid upload response JSON: %v", err)
			}
			key := uploadResp["message"]

			// Now attempt to download.
			downloadReq := httptest.NewRequest(http.MethodGet, "/file/"+key, nil)
			downloadReq = mux.SetURLVars(downloadReq, map[string]string{"key": key})
			downloadReq.Header.Set("Accept", "application/octet-stream")
			if tc.withSession {
				for _, c := range sessionCookiesFor(t, srv) {
					downloadReq.AddCookie(c)
				}
			}

			downloadW := httptest.NewRecorder()
			srv.streamDownload(downloadW, downloadReq)

			if downloadW.Code != tc.expectedCode {
				t.Fatalf("expected %d, got %d: %s", tc.expectedCode, downloadW.Code, downloadW.Body.String())
			}
		})
	}
}

// ── getStreamSecretStatus: requireAuth field ─────────────────────────────────

func TestGetStreamSecretStatus_RequireAuthField(t *testing.T) {
	tests := []struct {
		name        string
		requireAuth bool
	}{
		{"requireAuth=false", false},
		{"requireAuth=true", true},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			db := newTestDB()
			srv := Server{
				DB:           db,
				FileStore:    NewDatabaseFileStore(db),
				MaxLength:    10000,
				MaxFileSize:  1024 * 1024,
				Registry:     prometheus.NewRegistry(),
				Logger:       zaptest.NewLogger(t),
				OIDCProvider: &mockOIDCProvider{},
				CookieCodec:  NewCookieCodec(""),
			}

			// Upload with the desired RequireAuth setting.
			uploadReq := streamUploadRequest(pgpBody("data"), "3600", "false", "f.bin")
			if tc.requireAuth {
				uploadReq.Header.Set("X-Yopass-RequireAuth", "true")
			}
			uploadW := httptest.NewRecorder()
			srv.streamUpload(uploadW, uploadReq)
			if uploadW.Code != http.StatusOK {
				t.Fatalf("upload failed: %d %s", uploadW.Code, uploadW.Body.String())
			}
			var uploadResp map[string]string
			json.Unmarshal(uploadW.Body.Bytes(), &uploadResp)
			key := uploadResp["message"]

			// Fetch status.
			statusReq := httptest.NewRequest(http.MethodGet, "/file/"+key+"/status", nil)
			statusReq = mux.SetURLVars(statusReq, map[string]string{"key": key})
			statusW := httptest.NewRecorder()
			srv.getStreamSecretStatus(statusW, statusReq)

			if statusW.Code != http.StatusOK {
				t.Fatalf("expected 200, got %d", statusW.Code)
			}

			var resp map[string]bool
			if err := json.Unmarshal(statusW.Body.Bytes(), &resp); err != nil {
				t.Fatalf("invalid JSON: %v", err)
			}
			if resp["requireAuth"] != tc.requireAuth {
				t.Errorf("expected requireAuth=%v, got %v", tc.requireAuth, resp["requireAuth"])
			}
		})
	}
}
