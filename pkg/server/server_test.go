package server

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

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
		t.Run(fmt.Sprintf(tc.name), func(t *testing.T) {
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
		t.Run(fmt.Sprintf(tc.name), func(t *testing.T) {
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
		t.Run(fmt.Sprintf(tc.name), func(t *testing.T) {
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
		t.Run(fmt.Sprintf(tc.name), func(t *testing.T) {
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
				"content-security-policy": "default-src 'self'; font-src 'self' data:; form-action 'self'; frame-ancestors 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'",
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
				"content-security-policy":   "default-src 'self'; font-src 'self' data:; form-action 'self'; frame-ancestors 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'",
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

	var config map[string]bool
	if err := json.NewDecoder(res.Body).Decode(&config); err != nil {
		t.Fatalf("Failed to decode response: %v", err)
	}

	if got, want := config["DISABLE_UPLOAD"], true; got != want {
		t.Errorf("Expected DISABLE_UPLOAD to be %v, got %v", want, got)
	}
}
