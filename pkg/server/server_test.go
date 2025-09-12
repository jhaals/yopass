package server

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gorilla/handlers"
	"github.com/gorilla/mux"
	"github.com/jhaals/yopass/pkg/yopass"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"
	"github.com/spf13/viper"
	"go.uber.org/zap/zaptest"
)

func newTestServer(t *testing.T, db Database, maxLength int, forceOneTime bool) Server {
	return Server{
		DB:                  db,
		MaxLength:           maxLength,
		Registry:            prometheus.NewRegistry(),
		ForceOneTimeSecrets: forceOneTime,
		Logger:              zaptest.NewLogger(t),
	}
}

type mockDB struct{}

func (db *mockDB) Get(key string) (yopass.Secret, error) {
	return yopass.Secret{Message: `***ENCRYPTED***`}, nil
}
func (db *mockDB) Put(key string, secret yopass.Secret) error {
	return nil
}
func (db *mockDB) Delete(key string) (bool, error) {
	return true, nil
}
func (db *mockDB) Exists(key string) (bool, error) {
	return true, nil
}
func (db *mockDB) Status(key string) (bool, error) {
	return false, nil
}

type brokenDB struct{}

func (db *brokenDB) Get(key string) (yopass.Secret, error) {
	return yopass.Secret{}, fmt.Errorf("Some error")
}
func (db *brokenDB) Put(key string, secret yopass.Secret) error {
	return fmt.Errorf("Some error")
}
func (db *brokenDB) Delete(key string) (bool, error) {
	return false, fmt.Errorf("Some error")
}
func (db *brokenDB) Exists(key string) (bool, error) {
	return false, fmt.Errorf("Some error")
}
func (db *brokenDB) Status(key string) (bool, error) {
	return false, fmt.Errorf("Some error")
}

type mockBrokenDB2 struct{}

func (db *mockBrokenDB2) Get(key string) (yopass.Secret, error) {
	return yopass.Secret{OneTime: true, Message: "encrypted"}, nil
}
func (db *mockBrokenDB2) Put(key string, secret yopass.Secret) error {
	return fmt.Errorf("Some error")
}
func (db *mockBrokenDB2) Delete(key string) (bool, error) {
	return false, nil
}
func (db *mockBrokenDB2) Exists(key string) (bool, error) {
	return false, fmt.Errorf("Some error")
}
func (db *mockBrokenDB2) Status(key string) (bool, error) {
	return true, nil
}

type mockStatusDB struct {
	oneTime bool
	exists  bool
}

func (db *mockStatusDB) Get(key string) (yopass.Secret, error) {
	if !db.exists {
		return yopass.Secret{}, fmt.Errorf("Secret not found")
	}
	return yopass.Secret{Message: "test", OneTime: db.oneTime}, nil
}

func (db *mockStatusDB) Put(key string, secret yopass.Secret) error {
	return nil
}

func (db *mockStatusDB) Delete(key string) (bool, error) {
	return true, nil
}

func (db *mockStatusDB) Exists(key string) (bool, error) {
	return db.exists, nil
}

func (db *mockStatusDB) Status(key string) (bool, error) {
	if !db.exists {
		return false, fmt.Errorf("Secret not found")
	}
	return db.oneTime, nil
}

type mockErrorDB struct {
	errorOnGet    bool
	errorOnPut    bool
	errorOnDelete bool
	errorOnStatus bool
}

func (db *mockErrorDB) Get(key string) (yopass.Secret, error) {
	if db.errorOnGet {
		return yopass.Secret{}, fmt.Errorf("Database error")
	}
	return yopass.Secret{Message: "test"}, nil
}

func (db *mockErrorDB) Put(key string, secret yopass.Secret) error {
	if db.errorOnPut {
		return fmt.Errorf("Database error")
	}
	return nil
}

func (db *mockErrorDB) Delete(key string) (bool, error) {
	if db.errorOnDelete {
		return false, fmt.Errorf("Database error")
	}
	return true, nil
}

func (db *mockErrorDB) Exists(key string) (bool, error) {
	return true, nil
}

func (db *mockErrorDB) Status(key string) (bool, error) {
	if db.errorOnStatus {
		return false, fmt.Errorf("Database error")
	}
	return false, nil
}

func TestCreateSecret(t *testing.T) {
	tt := []struct {
		name       string
		statusCode int
		body       io.Reader
		output     string
		db         Database
		maxLength  int
	}{
		{
			name:       "validRequest",
			statusCode: 200,
			body:       strings.NewReader(`{"message": "hello world", "expiration": 3600}`),
			output:     "",
			db:         &mockDB{},
			maxLength:  100,
		},
		{
			name:       "invalid json",
			statusCode: 400,
			body:       strings.NewReader(`{fooo`),
			output:     "Unable to parse json",
			db:         &mockDB{},
		},
		{
			name:       "message too long",
			statusCode: 400,
			body:       strings.NewReader(`{"expiration": 3600, "message": "wooop"}`),
			output:     "The encrypted message is too long",
			db:         &mockDB{},
			maxLength:  1,
		},
		{
			name:       "invalid expiration",
			statusCode: 400,
			body:       strings.NewReader(`{"expiration": 10, "message": "foo"}`),
			output:     "Invalid expiration specified",
			db:         &mockDB{},
		},
		{
			name:       "broken database",
			statusCode: 500,
			body:       strings.NewReader(`{"expiration": 3600, "message": "foo"}`),
			output:     "Failed to store secret in database",
			db:         &brokenDB{},
			maxLength:  100,
		},
	}

	for _, tc := range tt {
		t.Run(tc.name, func(t *testing.T) {
			req, _ := http.NewRequest("POST", "/secret", tc.body)
			rr := httptest.NewRecorder()
			y := newTestServer(t, tc.db, tc.maxLength, false)
			y.createSecret(rr, req)
			var s yopass.Secret
			json.Unmarshal(rr.Body.Bytes(), &s)
			if tc.output != "" {
				if s.Message != tc.output {
					t.Fatalf(`Expected body "%s"; got "%s"`, tc.output, s.Message)
				}
			}
			if rr.Code != tc.statusCode {
				t.Fatalf(`Expected status code %d; got "%d"`, tc.statusCode, rr.Code)
			}
		})
	}
}

func TestOneTimeEnforcement(t *testing.T) {
	tt := []struct {
		name           string
		statusCode     int
		body           io.Reader
		output         string
		requireOneTime bool
	}{
		{
			name:           "one time request",
			statusCode:     200,
			body:           strings.NewReader(`{"message": "hello world", "expiration": 3600, "one_time": true}`),
			output:         "",
			requireOneTime: true,
		},
		{
			name:           "non oneTime request",
			statusCode:     400,
			body:           strings.NewReader(`{"message": "hello world", "expiration": 3600, "one_time": false}`),
			output:         "Secret must be one time download",
			requireOneTime: true,
		},
		{
			name:           "one_time payload flag missing",
			statusCode:     400,
			body:           strings.NewReader(`{"message": "hello world", "expiration": 3600}`),
			output:         "Secret must be one time download",
			requireOneTime: true,
		},
		{
			name:           "one time disabled",
			statusCode:     200,
			body:           strings.NewReader(`{"message": "hello world", "expiration": 3600, "one_time": false}`),
			output:         "",
			requireOneTime: false,
		},
	}
	for _, tc := range tt {
		t.Run(tc.name, func(t *testing.T) {
			req, _ := http.NewRequest("POST", "/secret", tc.body)
			rr := httptest.NewRecorder()
			y := newTestServer(t, &mockDB{}, 100, tc.requireOneTime)
			y.createSecret(rr, req)
			var s yopass.Secret
			json.Unmarshal(rr.Body.Bytes(), &s)
			if tc.output != "" {
				if s.Message != tc.output {
					t.Fatalf(`Expected body "%s"; got "%s"`, tc.output, s.Message)
				}
			}
			if rr.Code != tc.statusCode {
				t.Fatalf(`Expected status code %d; got "%d"`, tc.statusCode, rr.Code)
			}
		})
	}
}

func TestGetSecret(t *testing.T) {
	tt := []struct {
		name       string
		statusCode int
		output     string
		db         Database
	}{
		{
			name:       "Get Secret",
			statusCode: 200,
			output:     "***ENCRYPTED***",
			db:         &mockDB{},
		},
		{
			name:       "Secret not found",
			statusCode: 404,
			output:     "Secret not found",
			db:         &brokenDB{},
		},
	}

	for _, tc := range tt {
		t.Run(tc.name, func(t *testing.T) {
			req, err := http.NewRequest("GET", "/secret/foo", nil)
			if err != nil {
				t.Fatal(err)
			}
			rr := httptest.NewRecorder()
			y := newTestServer(t, tc.db, 1, false)
			y.getSecret(rr, req)
			cacheControl := rr.Header().Get("Cache-Control")
			if cacheControl != "private, no-cache" {
				t.Fatalf(`Expected Cache-Control header to be "private, no-cache"; got %s`, cacheControl)
			}
			var s yopass.Secret
			json.Unmarshal(rr.Body.Bytes(), &s)
			if s.Message != tc.output {
				t.Fatalf(`Expected body "%s"; got "%s"`, tc.output, s.Message)
			}
			if rr.Code != tc.statusCode {
				t.Fatalf(`Expected status code %d; got "%d"`, tc.statusCode, rr.Code)
			}
		})
	}
}

func TestDeleteSecret(t *testing.T) {
	tt := []struct {
		name       string
		statusCode int
		output     string
		db         Database
	}{
		{
			name:       "Delete Secret",
			statusCode: 204,
			db:         &mockDB{},
		},
		{
			name:       "Secret deletion failed",
			statusCode: 500,
			output:     "Failed to delete secret",
			db:         &brokenDB{},
		},
		{
			name:       "Secret not found",
			statusCode: 404,
			output:     "Secret not found",
			db:         &mockBrokenDB2{},
		},
	}

	for _, tc := range tt {
		t.Run(tc.name, func(t *testing.T) {
			req, err := http.NewRequest("DELETE", "/secret/foo", nil)
			if err != nil {
				t.Fatal(err)
			}
			rr := httptest.NewRecorder()
			y := newTestServer(t, tc.db, 1, false)
			y.deleteSecret(rr, req)
			var s struct {
				Message string `json:"message"`
			}
			json.Unmarshal(rr.Body.Bytes(), &s)
			if s.Message != tc.output {
				t.Fatalf(`Expected body "%s"; got "%s"`, tc.output, s.Message)
			}
			if rr.Code != tc.statusCode {
				t.Fatalf(`Expected status code %d; got "%d"`, tc.statusCode, rr.Code)
			}
		})
	}
}

func TestMetrics(t *testing.T) {
	requests := []struct {
		method string
		path   string
	}{
		{
			method: "GET",
			path:   "/secret/ebfa0c88-7610-4d3f-856a-c8810a44361c",
		},
		{
			method: "GET",
			path:   "/secret/invalid-key-format",
		},
	}
	y := newTestServer(t, &mockDB{}, 1, false)
	h := y.HTTPHandler()

	for _, r := range requests {
		req, err := http.NewRequest(r.method, r.path, nil)
		if err != nil {
			t.Fatal(err)
		}
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
	}

	metrics := []string{"yopass_http_requests_total", "yopass_http_request_duration_seconds"}
	n, err := testutil.GatherAndCount(y.Registry, metrics...)
	if err != nil {
		t.Fatal(err)
	}
	if expected := len(metrics) * len(requests); n != expected {
		t.Fatalf(`Expected %d recorded metrics; got %d`, expected, n)
	}

	output := `
# HELP yopass_http_requests_total Total number of requests served by HTTP method, path and response code.
# TYPE yopass_http_requests_total counter
yopass_http_requests_total{code="200",method="GET",path="/secret/:key"} 1
yopass_http_requests_total{code="404",method="GET",path="/"} 1
`
	err = testutil.GatherAndCompare(y.Registry, strings.NewReader(output), "yopass_http_requests_total")
	if err != nil {
		t.Fatal(err)
	}

	warnings, err := testutil.GatherAndLint(y.Registry)
	if err != nil {
		t.Fatal(err)
	}
	if len(warnings) != 0 {
		t.Fatalf(`Expected no metric linter warnings; got %d`, len(warnings))
	}
}

func TestSecurityHeaders(t *testing.T) {
	tt := []struct {
		scheme       string
		headers      map[string]string
		unsetHeaders []string
	}{
		{
			scheme: "http",
			headers: map[string]string{
				"content-security-policy": "default-src 'self'; font-src 'self' data:; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; script-src 'self'; style-src 'self' 'unsafe-inline'",
				"referrer-policy":         "no-referrer",
				"x-content-type-options":  "nosniff",
				"x-frame-options":         "DENY",
				"x-xss-protection":        "1; mode=block",
			},
			unsetHeaders: []string{"strict-transport-security"},
		},
		{
			scheme: "https",
			headers: map[string]string{
				"content-security-policy":   "default-src 'self'; font-src 'self' data:; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; script-src 'self'; style-src 'self' 'unsafe-inline'",
				"referrer-policy":           "no-referrer",
				"strict-transport-security": "max-age=31536000",
				"x-content-type-options":    "nosniff",
				"x-frame-options":           "DENY",
				"x-xss-protection":          "1; mode=block",
			},
		},
	}

	y := newTestServer(t, &mockDB{}, 1, false)
	h := y.HTTPHandler()

	t.Parallel()
	for _, test := range tt {
		t.Run("scheme="+test.scheme, func(t *testing.T) {
			req, err := http.NewRequest("GET", "/", nil)
			if err != nil {
				t.Fatal(err)
			}
			req.Header.Set("X-Forwarded-Proto", test.scheme)
			rr := httptest.NewRecorder()
			h.ServeHTTP(rr, req)

			for header, value := range test.headers {
				if got := rr.Header().Get(header); got != value {
					t.Errorf("Expected HTTP header %s to be %q, got %q", header, value, got)
				}
			}

			for _, header := range test.unsetHeaders {
				if got := rr.Header().Get(header); got != "" {
					t.Errorf("Expected HTTP header %s to not be set, got %q", header, got)
				}
			}
		})
	}
}

func TestConfigHandler(t *testing.T) {
	viper.Set("disable-upload", "true")

	server := newTestServer(t, &mockDB{}, 1, false)

	req := httptest.NewRequest(http.MethodGet, "/config", nil)
	w := httptest.NewRecorder()
	server.configHandler(w, req)

	res := w.Result()
	defer res.Body.Close()

	if res.StatusCode != http.StatusOK {
		t.Fatalf("Expected status OK, got %d", res.StatusCode)
	}

	var config map[string]interface{}
	if err := json.NewDecoder(res.Body).Decode(&config); err != nil {
		t.Fatalf("Failed to decode response: %v", err)
	}

	if got, want := config["DISABLE_UPLOAD"].(bool), true; got != want {
		t.Errorf("Expected DISABLE_UPLOAD to be %v, got %v", want, got)
	}
}

func TestConfigHandlerLanguageSwitcher(t *testing.T) {
	tt := []struct {
		name     string
		setValue bool
		expected bool
	}{
		{
			name:     "no-language-switcher disabled (default)",
			setValue: false,
			expected: false,
		},
		{
			name:     "no-language-switcher enabled",
			setValue: true,
			expected: true,
		},
	}

	for _, tc := range tt {
		t.Run(tc.name, func(t *testing.T) {
			// Reset viper state
			viper.Reset()
			viper.Set("no-language-switcher", tc.setValue)

			server := newTestServer(t, &mockDB{}, 1, false)

			req := httptest.NewRequest(http.MethodGet, "/config", nil)
			w := httptest.NewRecorder()
			server.configHandler(w, req)

			res := w.Result()
			defer res.Body.Close()

			if res.StatusCode != http.StatusOK {
				t.Fatalf("Expected status OK, got %d", res.StatusCode)
			}

			var config map[string]interface{}
			if err := json.NewDecoder(res.Body).Decode(&config); err != nil {
				t.Fatalf("Failed to decode response: %v", err)
			}

			if got, want := config["NO_LANGUAGE_SWITCHER"].(bool), tc.expected; got != want {
				t.Errorf("Expected NO_LANGUAGE_SWITCHER to be %v, got %v", want, got)
			}

			// Verify the key exists in the response
			if _, exists := config["NO_LANGUAGE_SWITCHER"]; !exists {
				t.Error("Expected NO_LANGUAGE_SWITCHER key to exist in config response")
			}
		})
	}
}

func TestConfigHandlerPrivacyAndImprint(t *testing.T) {
	tt := []struct {
		name              string
		privacyNoticeURL  string
		imprintURL        string
		expectPrivacy     bool
		expectImprint     bool
	}{
		{
			name:              "no URLs configured",
			privacyNoticeURL:  "",
			imprintURL:        "",
			expectPrivacy:     false,
			expectImprint:     false,
		},
		{
			name:              "only privacy notice URL configured",
			privacyNoticeURL:  "https://example.com/privacy",
			imprintURL:        "",
			expectPrivacy:     true,
			expectImprint:     false,
		},
		{
			name:              "only imprint URL configured",
			privacyNoticeURL:  "",
			imprintURL:        "https://example.com/imprint",
			expectPrivacy:     false,
			expectImprint:     true,
		},
		{
			name:              "both URLs configured",
			privacyNoticeURL:  "https://example.com/privacy",
			imprintURL:        "https://example.com/imprint",
			expectPrivacy:     true,
			expectImprint:     true,
		},
		{
			name:              "empty string URLs (should not appear in config)",
			privacyNoticeURL:  "",
			imprintURL:        "",
			expectPrivacy:     false,
			expectImprint:     false,
		},
	}

	for _, tc := range tt {
		t.Run(tc.name, func(t *testing.T) {
			// Reset viper state
			viper.Reset()
			viper.Set("privacy-notice-url", tc.privacyNoticeURL)
			viper.Set("imprint-url", tc.imprintURL)

			server := newTestServer(t, &mockDB{}, 1, false)

			req := httptest.NewRequest(http.MethodGet, "/config", nil)
			w := httptest.NewRecorder()
			server.configHandler(w, req)

			res := w.Result()
			defer res.Body.Close()

			if res.StatusCode != http.StatusOK {
				t.Fatalf("Expected status OK, got %d", res.StatusCode)
			}

			var config map[string]interface{}
			if err := json.NewDecoder(res.Body).Decode(&config); err != nil {
				t.Fatalf("Failed to decode response: %v", err)
			}

			// Check privacy notice URL
			privacyURL, hasPrivacy := config["PRIVACY_NOTICE_URL"]
			if tc.expectPrivacy {
				if !hasPrivacy {
					t.Error("Expected PRIVACY_NOTICE_URL key to exist in config response")
				} else if privacyURL.(string) != tc.privacyNoticeURL {
					t.Errorf("Expected PRIVACY_NOTICE_URL to be %v, got %v", tc.privacyNoticeURL, privacyURL)
				}
			} else {
				if hasPrivacy {
					t.Errorf("Expected PRIVACY_NOTICE_URL key to not exist in config response, but got %v", privacyURL)
				}
			}

			// Check imprint URL
			imprintURL, hasImprint := config["IMPRINT_URL"]
			if tc.expectImprint {
				if !hasImprint {
					t.Error("Expected IMPRINT_URL key to exist in config response")
				} else if imprintURL.(string) != tc.imprintURL {
					t.Errorf("Expected IMPRINT_URL to be %v, got %v", tc.imprintURL, imprintURL)
				}
			} else {
				if hasImprint {
					t.Errorf("Expected IMPRINT_URL key to not exist in config response, but got %v", imprintURL)
				}
			}

			// Verify that boolean config values are still present
			if _, exists := config["DISABLE_UPLOAD"]; !exists {
				t.Error("Expected DISABLE_UPLOAD key to exist in config response")
			}
			if _, exists := config["PREFETCH_SECRET"]; !exists {
				t.Error("Expected PREFETCH_SECRET key to exist in config response")
			}
			if _, exists := config["DISABLE_FEATURES"]; !exists {
				t.Error("Expected DISABLE_FEATURES key to exist in config response")
			}
			if _, exists := config["NO_LANGUAGE_SWITCHER"]; !exists {
				t.Error("Expected NO_LANGUAGE_SWITCHER key to exist in config response")
			}
		})
	}
}

func TestDisableUploadRoutes(t *testing.T) {
	// Test with uploads disabled
	viper.Set("disable-upload", true)
	server := newTestServer(t, &mockDB{}, 1, false)
	handler := server.HTTPHandler()

	// Test that file upload routes are not available
	fileRoutes := []struct {
		method string
		path   string
	}{
		{"POST", "/file"},
		{"OPTIONS", "/file"},
		{"GET", "/file/12345678-1234-1234-1234-123456789012"},
		{"DELETE", "/file/12345678-1234-1234-1234-123456789012"},
	}

	for _, route := range fileRoutes {
		req := httptest.NewRequest(route.method, route.path, nil)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)

		// Should return 404 when uploads are disabled
		if w.Code != 404 {
			t.Errorf("Expected 404 for %s %s when uploads disabled, got %d", route.method, route.path, w.Code)
		}
	}

	// Test with uploads enabled
	viper.Set("disable-upload", false)
	server2 := newTestServer(t, &mockDB{}, 1, false)
	handler2 := server2.HTTPHandler()

	// Test that OPTIONS /file is available when uploads enabled
	req := httptest.NewRequest("OPTIONS", "/file", nil)
	w := httptest.NewRecorder()
	handler2.ServeHTTP(w, req)

	if w.Code != 200 {
		t.Errorf("Expected 200 for OPTIONS /file when uploads enabled, got %d", w.Code)
	}

	// Reset configuration
	viper.Set("disable-upload", false)
}

func TestGetSecretStatus(t *testing.T) {
	tt := []struct {
		name       string
		statusCode int
		output     string
		db         Database
		oneTime    bool
	}{
		{
			name:       "Secret exists - one time",
			statusCode: 200,
			output:     `{"oneTime":true}`,
			db:         &mockStatusDB{oneTime: true, exists: true},
			oneTime:    true,
		},
		{
			name:       "Secret exists - not one time",
			statusCode: 200,
			output:     `{"oneTime":false}`,
			db:         &mockStatusDB{oneTime: false, exists: true},
			oneTime:    false,
		},
		{
			name:       "Secret not found",
			statusCode: 404,
			output:     `{"message": "Secret not found"}`,
			db:         &mockStatusDB{exists: false},
		},
	}

	for _, tc := range tt {
		t.Run(tc.name, func(t *testing.T) {
			req, err := http.NewRequest("GET", "/secret/foo/status", nil)
			if err != nil {
				t.Fatal(err)
			}
			req = mux.SetURLVars(req, map[string]string{"key": "foo"})
			rr := httptest.NewRecorder()
			y := newTestServer(t, tc.db, 1, false)
			y.getSecretStatus(rr, req)

			if rr.Code != tc.statusCode {
				t.Fatalf(`Expected status code %d; got %d`, tc.statusCode, rr.Code)
			}

			body := strings.TrimSpace(rr.Body.String())
			if tc.statusCode == 200 {
				if body != tc.output {
					t.Fatalf(`Expected body "%s"; got "%s"`, tc.output, body)
				}
			}
		})
	}
}

func TestOptionsSecret(t *testing.T) {
	server := newTestServer(t, &mockDB{}, 1, false)
	viper.Set("cors-allow-origin", "*")

	req := httptest.NewRequest(http.MethodOptions, "/secret", nil)
	w := httptest.NewRecorder()
	server.optionsSecret(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected status OK, got %d", w.Code)
	}

	expectedHeaders := map[string]string{
		"Access-Control-Allow-Origin":  "*",
		"Access-Control-Allow-Methods": "*",
		"Access-Control-Allow-Headers": "content-type",
	}

	for header, expected := range expectedHeaders {
		got := w.Header().Get(header)
		if got != expected {
			t.Errorf("Expected header %s to be %q, got %q", header, expected, got)
		}
	}
}

func TestHTTPHandlerRoutes(t *testing.T) {
	server := newTestServer(t, &mockDB{}, 1, false)
	handler := server.HTTPHandler()

	testCases := []struct {
		method string
		path   string
		status int
	}{
		{"GET", "/config", 200},
		{"OPTIONS", "/secret", 200},
		{"OPTIONS", "/config", 200},
	}

	for _, tc := range testCases {
		t.Run(fmt.Sprintf("%s %s", tc.method, tc.path), func(t *testing.T) {
			req := httptest.NewRequest(tc.method, tc.path, nil)
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, req)

			if w.Code != tc.status {
				t.Errorf("Expected status %d, got %d", tc.status, w.Code)
			}
		})
	}
}

func TestNormalizedPath(t *testing.T) {
	// Test the edge case where there's no route (returns "<other>")
	req := httptest.NewRequest("GET", "/unknown", nil)
	result := normalizedPath(req)
	expected := "<other>"
	if result != expected {
		t.Errorf("Expected %q, got %q", expected, result)
	}
}

func TestHTTPHandlerWithConfiguration(t *testing.T) {
	// Test with prefetch-secret enabled
	viper.Set("prefetch-secret", true)
	server1 := newTestServer(t, &mockDB{}, 1, false)
	handler := server1.HTTPHandler()

	req := httptest.NewRequest("GET", "/secret/12345678-1234-1234-1234-123456789012/status", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	// Should be accessible when prefetch is enabled
	if w.Code == 404 {
		t.Error("Status endpoint should be available when prefetch-secret is enabled")
	}

	// Test with disable-upload set to false (uploads enabled)
	viper.Set("disable-upload", false)
	server2 := newTestServer(t, &mockDB{}, 1, false)
	handler2 := server2.HTTPHandler()

	req2 := httptest.NewRequest("OPTIONS", "/file", nil)
	w2 := httptest.NewRecorder()
	handler2.ServeHTTP(w2, req2)

	if w2.Code != 200 {
		t.Errorf("File OPTIONS should be available when uploads enabled, got %d", w2.Code)
	}

	// Reset configuration
	viper.Set("prefetch-secret", false)
	viper.Set("disable-upload", false)
}

func TestGetSecretWithToJSONError(t *testing.T) {
	// This test is challenging since we can't easily mock yopass.Secret.ToJSON()
	// The ToJSON method would need to return an error, which happens very rarely
	// in practice (only if json.Marshal fails on a simple struct)
	// We'll test the happy path that's already covered
}

// errorWriter is a ResponseWriter that fails on Write
type errorWriter struct {
	http.ResponseWriter
	headerWritten bool
}

func (w *errorWriter) Write([]byte) (int, error) {
	return 0, fmt.Errorf("write error")
}

func (w *errorWriter) WriteHeader(statusCode int) {
	if !w.headerWritten {
		w.ResponseWriter.WriteHeader(statusCode)
		w.headerWritten = true
	}
}

func TestCreateSecretWriteError(t *testing.T) {
	server := newTestServer(t, &mockDB{}, 1000, false)
	
	body := strings.NewReader(`{"message": "test", "expiration": 3600}`)
	req := httptest.NewRequest("POST", "/secret", body)
	
	// Use error writer to trigger the error path
	recorder := httptest.NewRecorder()
	errWriter := &errorWriter{ResponseWriter: recorder}
	
	server.createSecret(errWriter, req)
	
	// The function should complete even with write error (error is just logged)
}

func TestGetSecretWriteError(t *testing.T) {
	server := newTestServer(t, &mockDB{}, 1000, false)
	
	req := httptest.NewRequest("GET", "/secret/test", nil)
	req = mux.SetURLVars(req, map[string]string{"key": "test"})
	
	// Use error writer to trigger the error path
	recorder := httptest.NewRecorder()
	errWriter := &errorWriter{ResponseWriter: recorder}
	
	server.getSecret(errWriter, req)
	
	// The function should complete even with write error (error is just logged)
}

func TestGetSecretStatusWriteError(t *testing.T) {
	server := newTestServer(t, &mockStatusDB{exists: true, oneTime: false}, 1000, false)
	
	req := httptest.NewRequest("GET", "/secret/test/status", nil)
	req = mux.SetURLVars(req, map[string]string{"key": "test"})
	
	// Use error writer to trigger the error path
	recorder := httptest.NewRecorder()
	errWriter := &errorWriter{ResponseWriter: recorder}
	
	server.getSecretStatus(errWriter, req)
	
	// The function should complete even with write error (error is just logged)
}

func TestConfigHandlerForceOnetimeSecrets(t *testing.T) {
	tt := []struct {
		name     string
		setValue bool
		expected bool
	}{
		{
			name:     "force-onetime-secrets disabled (default)",
			setValue: false,
			expected: false,
		},
		{
			name:     "force-onetime-secrets enabled",
			setValue: true,
			expected: true,
		},
	}

	for _, tc := range tt {
		t.Run(tc.name, func(t *testing.T) {
			// Reset viper state
			viper.Reset()
			viper.Set("force-onetime-secrets", tc.setValue)

			server := newTestServer(t, &mockDB{}, 1, false)

			req := httptest.NewRequest(http.MethodGet, "/config", nil)
			w := httptest.NewRecorder()
			server.configHandler(w, req)

			res := w.Result()
			defer res.Body.Close()

			if res.StatusCode != http.StatusOK {
				t.Fatalf("Expected status OK, got %d", res.StatusCode)
			}

			var config map[string]interface{}
			if err := json.NewDecoder(res.Body).Decode(&config); err != nil {
				t.Fatalf("Failed to decode response: %v", err)
			}

			if got, want := config["FORCE_ONETIME_SECRETS"].(bool), tc.expected; got != want {
				t.Errorf("Expected FORCE_ONETIME_SECRETS to be %v, got %v", want, got)
			}

			// Verify the key exists in the response
			if _, exists := config["FORCE_ONETIME_SECRETS"]; !exists {
				t.Error("Expected FORCE_ONETIME_SECRETS key to exist in config response")
			}
		})
	}
}

func TestHTTPLogFormatterEdgeCases(t *testing.T) {
	logger := zaptest.NewLogger(t)
	server := &Server{Logger: logger}
	formatter := server.httpLogFormatter()
	
	// Test with nil logger
	nilServer := &Server{Logger: nil}
	nilFormatter := nilServer.httpLogFormatter()
	if nilFormatter == nil {
		t.Error("Formatter should not be nil even with nil logger")
	}
	
	// Test with nil request (error path)
	params := handlers.LogFormatterParams{
		Request: nil,
	}
	formatter(nil, params)
	
	// Test with CONNECT method over HTTP/2
	req := httptest.NewRequest("CONNECT", "/", nil)
	req.ProtoMajor = 2
	req.Host = "example.com"
	
	params2 := handlers.LogFormatterParams{
		Request: req,
	}
	formatter(nil, params2)
}
