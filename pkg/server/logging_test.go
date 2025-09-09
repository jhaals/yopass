package server

import (
	"net"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gorilla/handlers"
	"github.com/stretchr/testify/assert"
	"go.uber.org/zap"
	"go.uber.org/zap/zaptest/observer"
)

func TestGetRealClientIP(t *testing.T) {
	tests := []struct {
		name              string
		trustedProxies    []string
		remoteAddr        string
		xForwardedFor     string
		expectedIP        string
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

func TestHTTPLogFormatter(t *testing.T) {
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

		formatter := server.httpLogFormatter()
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
				assert.Equal(t, "https://yopass.se/", f.String)
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

		formatter := server.httpLogFormatter()
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
				assert.Equal(t, "https://yopass.se/", f.String)
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

		formatter := server.httpLogFormatter()
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
