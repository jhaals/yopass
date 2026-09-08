package server

import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/handlers"
	"github.com/gorilla/mux"
	"github.com/jhaals/yopass/pkg/yopass"
	"github.com/stretchr/testify/assert"
	"go.uber.org/zap"
	"go.uber.org/zap/zaptest/observer"
)

func TestGetRealClientIP(t *testing.T) {
	tests := []struct {
		name           string
		trustedProxies []string
		remoteAddr     string
		xForwardedFor  string
		expectedIP     string
	}{
		{
			name:           "No trusted proxies - should use RemoteAddr",
			trustedProxies: []string{},
			remoteAddr:     "192.168.1.100:12345",
			xForwardedFor:  "203.0.113.10",
			expectedIP:     "192.168.1.100",
		},
		{
			name:           "Trusted proxy with single IP - should use X-Forwarded-For",
			trustedProxies: []string{"192.168.1.100"},
			remoteAddr:     "192.168.1.100:12345",
			xForwardedFor:  "203.0.113.10",
			expectedIP:     "203.0.113.10",
		},
		{
			name:           "Untrusted proxy - should use RemoteAddr",
			trustedProxies: []string{"192.168.1.200"},
			remoteAddr:     "192.168.1.100:12345",
			xForwardedFor:  "203.0.113.10",
			expectedIP:     "192.168.1.100",
		},
		{
			name:           "Trusted proxy with CIDR - should use X-Forwarded-For",
			trustedProxies: []string{"192.168.1.0/24"},
			remoteAddr:     "192.168.1.100:12345",
			xForwardedFor:  "203.0.113.10",
			expectedIP:     "203.0.113.10",
		},
		{
			name:           "Multiple IPs in X-Forwarded-For - should use first",
			trustedProxies: []string{"192.168.1.100"},
			remoteAddr:     "192.168.1.100:12345",
			xForwardedFor:  "203.0.113.10, 10.0.0.1, 172.16.0.1",
			expectedIP:     "203.0.113.10",
		},
		{
			name:           "Invalid IP in X-Forwarded-For - should fallback to RemoteAddr",
			trustedProxies: []string{"192.168.1.100"},
			remoteAddr:     "192.168.1.100:12345",
			xForwardedFor:  "invalid-ip",
			expectedIP:     "192.168.1.100",
		},
		{
			name:           "Empty X-Forwarded-For - should fallback to RemoteAddr",
			trustedProxies: []string{"192.168.1.100"},
			remoteAddr:     "192.168.1.100:12345",
			xForwardedFor:  "",
			expectedIP:     "192.168.1.100",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			server := &Server{
				TrustedProxies: tt.trustedProxies,
			}

			req := httptest.NewRequest("GET", "/", nil)
			req.RemoteAddr = tt.remoteAddr
			if tt.xForwardedFor != "" {
				req.Header.Set("X-Forwarded-For", tt.xForwardedFor)
			}

			actualIP := server.getRealClientIP(req)
			assert.Equal(t, tt.expectedIP, actualIP)
		})
	}
}

func TestHTTPAccessLogsRedactCapabilities(t *testing.T) {
	for _, id := range []string{"12345678-1234-1234-1234-123456789012", "AbCdEf0123456789GhIjKl"} {
		for _, endpoint := range []struct{ method, path, want string }{
			{"GET", "/secret/", "/secret/{key}"},
			{"DELETE", "/secret/", "/secret/{key}"},
			{"GET", "/secret/%s/status", "/secret/{key}/status"},
			{"GET", "/secret/%s/receipt", "/secret/{key}/receipt"},
			{"GET", "/file/", "/file/{key}"},
			{"DELETE", "/file/", "/file/{key}"},
			{"OPTIONS", "/file/", "/file/{key}"},
			{"GET", "/file/%s/status", "/file/{key}/status"},
			{"GET", "/file/%s/receipt", "/file/{key}/receipt"},
			{"GET", "/request/", "/request/{key}"},
			{"DELETE", "/request/", "/request/{key}"},
			{"GET", "/request/%s/secret", "/request/{key}/secret"},
			{"POST", "/request/%s/secret", "/request/{key}/secret"},
			{"PUT", "/request/%s/key", "/request/{key}/key"},
		} {
			t.Run(id+endpoint.method+endpoint.want, func(t *testing.T) {
				core, logs := observer.New(zap.DebugLevel)
				db := newMemoryDB()
				// Include a successful public read and a denied protected file
				// read; remaining probes exercise missing/invalid request paths.
				if err := db.Put(id, yopass.Secret{Message: "encrypted-content"}); err != nil {
					t.Fatal(err)
				}
				if err := db.Put(streamKeyPrefix+id, yopass.Secret{RequireAuth: true}); err != nil {
					t.Fatal(err)
				}
				y := newRequestTestServer(t, db, true)
				y.Logger, y.PrefetchSecret = zap.New(core), true
				y.AssetPath = t.TempDir()
				path := endpoint.path + id
				if strings.Contains(endpoint.path, "%s") {
					path = strings.ReplaceAll(endpoint.path, "%s", id)
				}
				r := httptest.NewRequest(endpoint.method, path+"?code=private-code&token=private-token", strings.NewReader("{}"))
				r.Header.Set("Authorization", "Bearer private-bearer")
				r.Header.Set("X-Yopass-Request-Token", "private-management-token")
				w := httptest.NewRecorder()
				y.HTTPHandler().ServeHTTP(w, r)
				entries := logs.FilterMessage("Request handled").All()
				if len(entries) != 1 {
					t.Fatalf("access log count = %d", len(entries))
				}
				fields := entries[0].ContextMap()
				assert.Equal(t, endpoint.want, fields["uri"])
				assert.Equal(t, redactSecretID(id), fields["secret_id"])
				assert.Equal(t, int64(w.Code), fields["responseStatus"])
				for _, entry := range logs.All() {
					encoded, err := json.Marshal(entry.ContextMap())
					if err != nil {
						t.Fatal(err)
					}
					for _, sensitive := range []string{id, "private-code", "private-token", "private-bearer", "private-management-token", "encrypted-content"} {
						assert.NotContains(t, string(encoded), sensitive)
					}
				}
			})
		}
	}
}

func TestHTTPLogFormatterNeverFallsBackToRawURL(t *testing.T) {
	router := mux.NewRouter()
	router.HandleFunc("/secret/"+keyParameter, func(http.ResponseWriter, *http.Request) {}).Methods("GET")
	router.HandleFunc("/auth/callback", func(http.ResponseWriter, *http.Request) {}).Methods("GET")
	router.HandleFunc("/config", func(http.ResponseWriter, *http.Request) {}).Methods("GET")
	const id = "12345678-1234-1234-1234-123456789012"
	for _, tc := range []struct{ method, target, want string }{
		{"GET", "/auth/callback?code=private-code&state=private-state", "/auth/callback"},
		{"GET", "/config?token=private-token", "/config"},
		{"GET", "/%73ecret/" + id, "/secret/{key}"},
		{"GET", "/secret/%31" + id[1:], "/secret/{key}"},
		{"GET", "https://private-user:private-password@example.com/secret/" + id + "?code=private-code", "/secret/{key}"},
		{"POST", "/secret/" + id, "unmatched"},
		{"GET", "/secret/" + id + "/unknown", "unmatched"},
		{"GET", "/private-token", "unmatched"},
		{"CONNECT", "/private-token", "unmatched"},
	} {
		t.Run(tc.method+tc.target, func(t *testing.T) {
			core, logs := observer.New(zap.DebugLevel)
			y := &Server{Logger: zap.New(core)}
			r := httptest.NewRequest(tc.method, tc.target, nil)
			r.ProtoMajor = 2
			r.Host = "private-host"
			for _, emptyURI := range []bool{false, true} {
				if emptyURI {
					r.RequestURI = ""
				}
				y.httpLogFormatter(router)(nil, handlers.LogFormatterParams{
					Request: r, URL: *r.URL, StatusCode: 404,
				})
				entry := logs.TakeAll()[0]
				fields := entry.ContextMap()
				assert.Equal(t, tc.want, fields["uri"])
				encoded, err := json.Marshal(fields)
				if err != nil {
					t.Fatal(err)
				}
				assert.NotContains(t, string(encoded), id)
				assert.NotContains(t, string(encoded), "private-")
			}
		})
	}
	core, logs := observer.New(zap.DebugLevel)
	y := &Server{Logger: zap.New(core)}
	// The missing-request error path must not serialize params.URL either.
	y.httpLogFormatter(router)(nil, handlers.LogFormatterParams{URL: url.URL{Path: "/secret/" + id, RawQuery: "code=private-code"}})
	assert.Empty(t, logs.All()[0].ContextMap())
}

func TestHTTPAccessLogStaticFallback(t *testing.T) {
	core, logs := observer.New(zap.DebugLevel)
	y := newRequestTestServer(t, newMemoryDB(), false)
	y.Logger, y.AssetPath = zap.New(core), t.TempDir()
	w := httptest.NewRecorder()
	y.HTTPHandler().ServeHTTP(w, httptest.NewRequest("GET", "/unknown/private-token?code=private-code", nil))
	entries := logs.FilterMessage("Request handled").All()
	if len(entries) != 1 {
		t.Fatalf("access log count = %d", len(entries))
	}
	assert.Equal(t, "/", entries[0].ContextMap()["uri"])
	assert.NotContains(t, entries[0].ContextMap(), "secret_id")
}

func TestHTTPLogFormatter(t *testing.T) {
	router := mux.NewRouter()
	router.HandleFunc("/", func(http.ResponseWriter, *http.Request) {})
	t.Run("Log request with no trusted proxies", func(t *testing.T) {
		ts := time.Now()
		request := httptest.NewRequest("GET", "https://yopass.se/", nil)
		request.Header.Set("X-Forwarded-For", "203.0.113.10")
		host, _, _ := net.SplitHostPort(request.RemoteAddr)

		loggerCore, logs := observer.New(zap.DebugLevel)
		logger := zap.New(loggerCore)

		server := &Server{
			Logger:         logger,
			TrustedProxies: []string{}, // No trusted proxies
		}

		formatter := server.httpLogFormatter(router)
		formatter(nil, handlers.LogFormatterParams{
			Request:    request,
			TimeStamp:  ts,
			StatusCode: 200,
			Size:       50,
		})

		if logs.Len() != 1 {
			t.Fatalf("Expected 1 log entry got %d", logs.Len())
		}
		infoLogs := logs.FilterLevelExact(zap.InfoLevel).All()
		if len(infoLogs) != 1 {
			t.Fatalf("Expected 1 info level log but got %d", len(infoLogs))
		}

		fields := infoLogs[0].Context
		for _, f := range fields {
			switch f.Key {
			case "host":
				// Should use RemoteAddr, not X-Forwarded-For
				assert.Equal(t, host, f.String)
				assert.NotEqual(t, "203.0.113.10", f.String)
			case "timestamp":
				assert.Equal(t, ts.UnixNano(), f.Integer)
			case "method":
				assert.Equal(t, "GET", f.String)
			case "uri":
				assert.Equal(t, "/", f.String)
			case "protocol":
				assert.Equal(t, "HTTP/1.1", f.String)
			case "responseStatus":
				assert.Equal(t, int64(200), f.Integer)
			case "responseSize":
				assert.Equal(t, int64(50), f.Integer)
			default:
				t.Fatalf("Unexpected fields %s", f.Key)
			}
		}

		if len(fields) != 7 {
			t.Fatalf("Expected 7 fields but got %d", len(fields))
		}
	})

	t.Run("Log request with trusted proxy", func(t *testing.T) {
		ts := time.Now()
		request := httptest.NewRequest("GET", "https://yopass.se/", nil)
		request.RemoteAddr = "192.168.1.100:12345"
		request.Header.Set("X-Forwarded-For", "203.0.113.10")

		loggerCore, logs := observer.New(zap.DebugLevel)
		logger := zap.New(loggerCore)

		server := &Server{
			Logger:         logger,
			TrustedProxies: []string{"192.168.1.100"}, // Trust this proxy
		}

		formatter := server.httpLogFormatter(router)
		formatter(nil, handlers.LogFormatterParams{
			Request:    request,
			TimeStamp:  ts,
			StatusCode: 200,
			Size:       50,
		})

		if logs.Len() != 1 {
			t.Fatalf("Expected 1 log entry got %d", logs.Len())
		}
		infoLogs := logs.FilterLevelExact(zap.InfoLevel).All()
		if len(infoLogs) != 1 {
			t.Fatalf("Expected 1 info level log but got %d", len(infoLogs))
		}

		fields := infoLogs[0].Context
		for _, f := range fields {
			switch f.Key {
			case "host":
				// Should use X-Forwarded-For since request comes from trusted proxy
				assert.Equal(t, "203.0.113.10", f.String)
			case "timestamp":
				assert.Equal(t, ts.UnixNano(), f.Integer)
			case "method":
				assert.Equal(t, "GET", f.String)
			case "uri":
				assert.Equal(t, "/", f.String)
			case "protocol":
				assert.Equal(t, "HTTP/1.1", f.String)
			case "responseStatus":
				assert.Equal(t, int64(200), f.Integer)
			case "responseSize":
				assert.Equal(t, int64(50), f.Integer)
			default:
				t.Fatalf("Unexpected fields %s", f.Key)
			}
		}

		if len(fields) != 7 {
			t.Fatalf("Expected 7 fields but got %d", len(fields))
		}
	})

	t.Run("No request", func(t *testing.T) {
		loggerCore, logs := observer.New(zap.DebugLevel)
		logger := zap.New(loggerCore)

		server := &Server{
			Logger: logger,
		}

		formatter := server.httpLogFormatter(router)
		formatter(nil, handlers.LogFormatterParams{})

		if err := logger.Sync(); err != nil {
			t.Fatalf("Unexpected error from logger.Sync %v", err)
		}

		if logs.Len() != 1 {
			t.Fatalf("Expected 1 log entry got %d", logs.Len())
		}
		errorLogs := logs.FilterLevelExact(zap.ErrorLevel).All()
		if len(errorLogs) != 1 {
			t.Fatalf("Expected 1 error level because no request was provided but got %d", len(errorLogs))
		}
	})
}
