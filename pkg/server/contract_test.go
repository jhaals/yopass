package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/jhaals/yopass/pkg/yopass"
	"github.com/prometheus/client_golang/prometheus"
	"go.uber.org/zap/zaptest"
)

// These tests pin the public HTTP contract: which routes exist under which
// feature flags, the exact key set of the /config response, and the exact
// error bodies of the creation policy checks. They exist so refactors of the
// handler internals cannot silently change the wire contract.

const contractTestID = "12345678-1234-1234-1234-123456789012"

const contractPGPMessage = `-----BEGIN PGP MESSAGE-----
Version: OpenPGP.js v4.10.8
Comment: https://openpgpjs.org

wy4ECQMIRthQ3aO85NvgAfASIX3dTwsFVt0gshPu7n1tN05e8rpqxOk6PYNm
xtt90k4BqHuTCLNlFRJjuiuE8zdIc+j5zTN5zihxUReVqokeqULLOx2FBMHZ
sbfqaG/iDbp+qDOc98IagMyPrEqKDxnhVVOraXy5dD9RDsntLso=
=0vwU
-----END PGP MESSAGE-----`

// contractSecretBody is a valid /create/secret payload.
func contractSecretBody() string {
	b, _ := json.Marshal(map[string]interface{}{
		"message":    contractPGPMessage,
		"expiration": 3600,
		"one_time":   true,
	})
	return string(b)
}

// newContractServer builds a Server with a stateful DB seeded with a text
// secret and a file secret, then applies mutate to toggle feature flags.
func newContractServer(t *testing.T, mutate func(*Server)) http.Handler {
	t.Helper()
	db := newMemoryDB()
	if err := db.Put(contractTestID, yopass.Secret{Message: "***ENCRYPTED***"}); err != nil {
		t.Fatal(err)
	}
	if err := db.Put(streamKeyPrefix+contractTestID, yopass.Secret{}); err != nil {
		t.Fatal(err)
	}
	fs := NewDatabaseFileStore(db)
	if err := fs.Save(context.Background(), contractTestID, strings.NewReader("pgp-data"), 8, 3600); err != nil {
		t.Fatal(err)
	}
	y := Server{
		DB:             db,
		FileStore:      fs,
		MaxLength:      10000,
		MaxFileSize:    1024 * 1024,
		Registry:       prometheus.NewRegistry(),
		Logger:         zaptest.NewLogger(t),
		PrefetchSecret: true,
	}
	if mutate != nil {
		mutate(&y)
	}
	return y.HTTPHandler()
}

func validLicense() LicenseStatus {
	return LicenseStatus{Valid: true, ExpiresAt: time.Now().Add(24 * time.Hour)}
}

// TestRouteContract asserts, per feature-flag configuration, the status code
// of a probe request against every route whose availability depends on flags.
// A 404 on a creation or request route means the route is not registered.
func TestRouteContract(t *testing.T) {
	type probe struct {
		name       string
		method     string
		path       string
		body       string
		headers    map[string]string
		wantStatus int
	}

	fileUploadProbe := func(want int) probe {
		return probe{
			name:   "POST /create/file",
			method: http.MethodPost,
			path:   "/create/file",
			// 0xc3 is a new-format SKESK packet header, accepted by isOpenPGPBinary.
			body: "\xc3\x04data",
			headers: map[string]string{
				"Content-Type":        "application/octet-stream",
				"X-Yopass-Expiration": "3600",
				"X-Yopass-OneTime":    "true",
			},
			wantStatus: want,
		}
	}

	configs := []struct {
		name   string
		mutate func(*Server)
		probes []probe
	}{
		{
			name: "default unlicensed",
			probes: []probe{
				{name: "POST /create/secret", method: http.MethodPost, path: "/create/secret", body: contractSecretBody(), wantStatus: 200},
				{name: "GET /secret/{key}", method: http.MethodGet, path: "/secret/" + contractTestID, wantStatus: 200},
				{name: "GET /secret/{key}/status", method: http.MethodGet, path: "/secret/" + contractTestID + "/status", wantStatus: 200},
				{name: "DELETE /secret/{key}", method: http.MethodDelete, path: "/secret/" + contractTestID, wantStatus: 204},
				fileUploadProbe(200),
				{name: "GET /file/{key}", method: http.MethodGet, path: "/file/" + contractTestID, wantStatus: 200},
				{name: "GET /file/{key}/status", method: http.MethodGet, path: "/file/" + contractTestID + "/status", wantStatus: 200},
				{name: "DELETE /file/{key}", method: http.MethodDelete, path: "/file/" + contractTestID, wantStatus: 204},
				{name: "POST /request not registered", method: http.MethodPost, path: "/request", wantStatus: 404},
				{name: "GET /auth/login not registered", method: http.MethodGet, path: "/auth/login", wantStatus: 404},
				{name: "GET /config", method: http.MethodGet, path: "/config", wantStatus: 200},
				{name: "GET /health", method: http.MethodGet, path: "/health", wantStatus: 200},
				{name: "GET /ready", method: http.MethodGet, path: "/ready", wantStatus: 200},
				{name: "GET /version", method: http.MethodGet, path: "/version", wantStatus: 200},
			},
		},
		{
			name:   "read-only",
			mutate: func(y *Server) { y.ReadOnly = true },
			probes: []probe{
				{name: "POST /create/secret not registered", method: http.MethodPost, path: "/create/secret", body: contractSecretBody(), wantStatus: 404},
				fileUploadProbe(404),
				{name: "GET /secret/{key} still works", method: http.MethodGet, path: "/secret/" + contractTestID, wantStatus: 200},
				{name: "GET /file/{key} still works", method: http.MethodGet, path: "/file/" + contractTestID, wantStatus: 200},
				{name: "DELETE /secret/{key} still works", method: http.MethodDelete, path: "/secret/" + contractTestID, wantStatus: 204},
			},
		},
		{
			name:   "upload disabled",
			mutate: func(y *Server) { y.DisableUpload = true },
			probes: []probe{
				fileUploadProbe(404),
				{name: "GET /file/{key} not registered", method: http.MethodGet, path: "/file/" + contractTestID, wantStatus: 404},
				{name: "POST /create/secret still works", method: http.MethodPost, path: "/create/secret", body: contractSecretBody(), wantStatus: 200},
			},
		},
		{
			name:   "prefetch disabled",
			mutate: func(y *Server) { y.PrefetchSecret = false },
			probes: []probe{
				{name: "GET /secret/{key}/status not registered", method: http.MethodGet, path: "/secret/" + contractTestID + "/status", wantStatus: 404},
				{name: "GET /file/{key}/status not registered", method: http.MethodGet, path: "/file/" + contractTestID + "/status", wantStatus: 404},
			},
		},
		{
			name:   "licensed",
			mutate: func(y *Server) { y.License = validLicense() },
			probes: []probe{
				{name: "POST /request registered", method: http.MethodPost, path: "/request", body: `{}`, wantStatus: 400},
			},
		},
		{
			name:   "licensed read-only",
			mutate: func(y *Server) { y.License = validLicense(); y.ReadOnly = true },
			probes: []probe{
				{name: "POST /request not registered", method: http.MethodPost, path: "/request", body: `{}`, wantStatus: 404},
			},
		},
		{
			name:   "licensed secret requests disabled",
			mutate: func(y *Server) { y.License = validLicense(); y.DisableSecretRequests = true },
			probes: []probe{
				{name: "POST /request not registered", method: http.MethodPost, path: "/request", body: `{}`, wantStatus: 404},
			},
		},
	}

	for _, cfg := range configs {
		t.Run(cfg.name, func(t *testing.T) {
			for _, p := range cfg.probes {
				t.Run(p.name, func(t *testing.T) {
					// Fresh server per probe so destructive probes (DELETE)
					// cannot influence each other.
					handler := newContractServer(t, cfg.mutate)
					var body *strings.Reader
					if p.body != "" {
						body = strings.NewReader(p.body)
					} else {
						body = strings.NewReader("")
					}
					req := httptest.NewRequest(p.method, p.path, body)
					for k, v := range p.headers {
						req.Header.Set(k, v)
					}
					rr := httptest.NewRecorder()
					handler.ServeHTTP(rr, req)
					if rr.Code != p.wantStatus {
						t.Errorf("%s %s: expected status %d, got %d (body %q)",
							p.method, p.path, p.wantStatus, rr.Code, rr.Body.String())
					}
				})
			}
		})
	}
}

// TestConfigContractKeys pins the exact key set of the /config response for
// an unlicensed default server and a fully configured licensed server. The
// frontend and external deployments parse these keys; additions are fine but
// must be deliberate — update the expected list when adding a key.
func TestConfigContractKeys(t *testing.T) {
	configKeys := func(t *testing.T, mutate func(*Server)) []string {
		t.Helper()
		handler := newContractServer(t, mutate)
		req := httptest.NewRequest(http.MethodGet, "/config", nil)
		rr := httptest.NewRecorder()
		handler.ServeHTTP(rr, req)
		if rr.Code != http.StatusOK {
			t.Fatalf("expected status 200, got %d", rr.Code)
		}
		var config map[string]interface{}
		if err := json.Unmarshal(rr.Body.Bytes(), &config); err != nil {
			t.Fatalf("failed to decode config: %v", err)
		}
		keys := make([]string, 0, len(config))
		for k := range config {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		return keys
	}

	t.Run("unlicensed default", func(t *testing.T) {
		want := []string{
			"ARGON2",
			"DEFAULT_EXPIRY",
			"DISABLE_FEATURES",
			"DISABLE_UPLOAD",
			"FORCE_ONETIME_SECRETS",
			"HIDE_ONECLICK_LINK",
			"MAX_FILE_SIZE",
			"NO_LANGUAGE_SWITCHER",
			"OIDC_ENABLED",
			"PREFETCH_SECRET",
			"READ_ONLY",
			"READ_RECEIPTS",
			"REQUIRE_AUTH",
			"SECRET_REQUESTS",
			"THEME_DARK",
			"THEME_LIGHT",
		}
		got := configKeys(t, nil)
		if fmt.Sprint(got) != fmt.Sprint(want) {
			t.Errorf("config keys changed.\nwant: %v\ngot:  %v", want, got)
		}
	})

	t.Run("licensed fully configured", func(t *testing.T) {
		want := []string{
			"APP_NAME",
			"ARGON2",
			"DEFAULT_EXPIRY",
			"DISABLE_FEATURES",
			"DISABLE_UPLOAD",
			"FORCE_EXPIRATION",
			"FORCE_ONETIME_SECRETS",
			"HIDE_ONECLICK_LINK",
			"IMPRINT_URL",
			"LOGO_URL",
			"MAX_FILE_SIZE",
			"MAX_REQUEST_FILE_SIZE",
			"NO_LANGUAGE_SWITCHER",
			"OIDC_ENABLED",
			"PREFETCH_SECRET",
			"PRIVACY_NOTICE_URL",
			"PUBLIC_URL",
			"READ_ONLY",
			"READ_RECEIPTS",
			"REQUIRE_AUTH",
			"SECRET_REQUESTS",
			"THEME_CUSTOM_DARK",
			"THEME_CUSTOM_LIGHT",
			"THEME_DARK",
			"THEME_LIGHT",
		}
		got := configKeys(t, func(y *Server) {
			y.License = validLicense()
			y.ForceExpiration = "1d"
			y.PrivacyNoticeURL = "https://example.com/privacy"
			y.ImprintURL = "https://example.com/imprint"
			y.PublicURL = "https://secrets.example.com"
			y.LogoURL = "/logo.svg"
			y.AppName = "Example Secrets"
			y.ThemeCustomLight = `{"--color-primary":"red"}`
			y.ThemeCustomDark = `{"--color-primary":"blue"}`
		})
		if fmt.Sprint(got) != fmt.Sprint(want) {
			t.Errorf("config keys changed.\nwant: %v\ngot:  %v", want, got)
		}
	})
}

// TestCreateSecretPolicyErrorContract pins the exact HTTP status and error
// message of every policy rejection in createSecret. Clients display these
// messages; they must not drift during refactors.
func TestCreateSecretPolicyErrorContract(t *testing.T) {
	secretBody := func(mutate func(map[string]interface{})) string {
		m := map[string]interface{}{
			"message":    contractPGPMessage,
			"expiration": 3600,
			"one_time":   true,
		}
		if mutate != nil {
			mutate(m)
		}
		b, _ := json.Marshal(m)
		return string(b)
	}

	tests := []struct {
		name        string
		mutate      func(*Server)
		body        string
		wantStatus  int
		wantMessage string
	}{
		{
			name:        "invalid json",
			body:        "{not json",
			wantStatus:  400,
			wantMessage: "Unable to parse json",
		},
		{
			name:        "message not PGP encrypted",
			body:        secretBody(func(m map[string]interface{}) { m["message"] = "plaintext" }),
			wantStatus:  400,
			wantMessage: "Message must be PGP encrypted",
		},
		{
			name:        "invalid expiration",
			body:        secretBody(func(m map[string]interface{}) { m["expiration"] = 123 }),
			wantStatus:  400,
			wantMessage: "Invalid expiration specified",
		},
		{
			name:        "expiration does not match forced value",
			mutate:      func(y *Server) { y.ForceExpiration = "1d" },
			body:        secretBody(nil), // 1h
			wantStatus:  400,
			wantMessage: "Expiration does not match server policy",
		},
		{
			name:        "require_auth without OIDC",
			body:        secretBody(func(m map[string]interface{}) { m["require_auth"] = true }),
			wantStatus:  400,
			wantMessage: "Authentication not configured on this server",
		},
		{
			name:        "one-time enforced by server",
			mutate:      func(y *Server) { y.ForceOneTimeSecrets = true },
			body:        secretBody(func(m map[string]interface{}) { m["one_time"] = false }),
			wantStatus:  400,
			wantMessage: "Secret must be one time download",
		},
		{
			name:        "message too long",
			mutate:      func(y *Server) { y.MaxLength = 10 },
			body:        secretBody(nil),
			wantStatus:  400,
			wantMessage: "The encrypted message is too long",
		},
		{
			name:        "receipt requested but not enabled",
			body:        secretBody(func(m map[string]interface{}) { m["receipt"] = true }),
			wantStatus:  400,
			wantMessage: "Read receipts are not enabled on this server",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			handler := newContractServer(t, tc.mutate)
			req := httptest.NewRequest(http.MethodPost, "/create/secret", strings.NewReader(tc.body))
			rr := httptest.NewRecorder()
			handler.ServeHTTP(rr, req)
			if rr.Code != tc.wantStatus {
				t.Fatalf("expected status %d, got %d (body %q)", tc.wantStatus, rr.Code, rr.Body.String())
			}
			var resp map[string]string
			if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
				t.Fatalf("failed to decode error body: %v", err)
			}
			if resp["message"] != tc.wantMessage {
				t.Errorf("expected message %q, got %q", tc.wantMessage, resp["message"])
			}
		})
	}
}
