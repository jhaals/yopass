package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/jhaals/yopass/pkg/server"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/spf13/viper"
	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
	"go.uber.org/zap/zaptest/observer"
)

func TestConfigHandler(t *testing.T) {
    tests := []struct {
        name          string
        disableUpload bool
        wantStatus    int
        wantHeader    string
        wantJSON      bool
    }{
        {
            name:          "uploads enabled",
            disableUpload: false,
            wantStatus:    http.StatusOK,
            wantHeader:    "application/json",
            wantJSON:      false,
        },
        {
            name:          "uploads disabled",
            disableUpload: true,
            wantStatus:    http.StatusOK,
            wantHeader:    "application/json",
            wantJSON:      true,
        },
    }
	for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            viper.Reset()
            viper.Set("disable-upload", tt.disableUpload)

            registry := prometheus.NewRegistry()
            srv := &server.Server{
                Registry: registry,
            }

            handler := srv.HTTPHandler()
            req := httptest.NewRequest("GET", "/config", nil)
            rr := httptest.NewRecorder()
            handler.ServeHTTP(rr, req)

            if rr.Code != tt.wantStatus {
                t.Fatalf("status: got %v, want %v", rr.Code, tt.wantStatus)
            }
            if ct := rr.Header().Get("Content-Type"); ct != tt.wantHeader {
                t.Errorf("Content-Type: got %q, want %q", ct, tt.wantHeader)
            }

            var cfg map[string]bool
            if err := json.Unmarshal(rr.Body.Bytes(), &cfg); err != nil {
                t.Fatalf("unmarshal JSON: %v", err)
            }
            if got := cfg["DISABLE_UPLOAD"]; got != tt.wantJSON {
                t.Errorf("DISABLE_UPLOAD: got %v, want %v", got, tt.wantJSON)
            }
        })
    }
}

func TestSetupDatabase(t *testing.T) {
	viper.Set("database", "memcached")
	viper.Set("memcached", "localhost:11211")

	core, logs := observer.New(zapcore.DebugLevel)
	logger := zap.New(core)

	db, _ := setupDatabase(logger)
	if db == nil {
		t.Fatal("Expected non-nil database")
	}

	if logs.FilterMessage("configured Memcached").Len() != 1 {
		t.Error("Expected log message 'configured Memcached'")
	}
}

func TestSetupDatabaseRedis(t *testing.T) {
	viper.Set("database", "redis")
	viper.Set("redis", "redis://localhost:6379/0")

	core, logs := observer.New(zapcore.DebugLevel)
	logger := zap.New(core)

	db, _ := setupDatabase(logger)
	if db == nil {
		t.Fatal("Expected non-nil database")
	}

	if logs.FilterMessage("configured Redis").Len() != 1 {
		t.Error("Expected log message 'configured Redis'")
	}
}

func TestSetupDatabaseRedisWithInvalidUrl(t *testing.T) {
	viper.Set("database", "redis")
	viper.Set("redis", "boop")

	core, _ := observer.New(zapcore.DebugLevel)
	logger := zap.New(core)

	_, err := setupDatabase(logger)
	expected := `invalid Redis URL: invalid redis URL scheme: `
	if err.Error() != expected {
		t.Fatalf("Expected '%s', got '%v'", expected, err.Error())
	}
}

func TestSetupDatabaseInvalid(t *testing.T) {
	viper.Set("database", "invalid")
	core, _ := observer.New(zapcore.DebugLevel)
	logger := zap.New(core)

	_, err := setupDatabase(logger)
	expected := `unsupported database, expected 'memcached' or 'redis' got 'invalid'`
	if err.Error() != expected {
		t.Fatalf("Expected '%s', got '%v'", expected, err.Error())
	}
}

func TestMetricsHandler(t *testing.T) {
	registry := setupRegistry()

	handler := metricsHandler(registry)

	req, err := http.NewRequest("GET", "/metrics", nil)
	if err != nil {
		t.Fatalf("Could not create request: %v", err)
	}

	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if status := rr.Code; status != http.StatusOK {
		t.Errorf("Handler returned wrong status code: got %v want %v", status, http.StatusOK)
	}

	if body := rr.Body.String(); len(body) == 0 {
		t.Error("Handler returned empty body")
	}
}

func TestConfigureZapLogger(t *testing.T) {
	logger := configureZapLogger()

	if logger == nil {
		t.Fatal("Expected non-nil logger")
	}

	// Check if logger is working by capturing logs
	core, logs := observer.New(zapcore.DebugLevel)
	testLogger := zap.New(core)
	testLogger.Debug("test log message")

	if logs.FilterMessage("test log message").Len() != 1 {
		t.Error("Expected log message 'test log message'")
	}
}
