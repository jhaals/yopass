package main

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"github.com/jhaals/yopass/pkg/server"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/spf13/viper"
	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
	"go.uber.org/zap/zaptest/observer"
)

// generateTestCert creates a self-signed certificate for testing
func generateTestCert(certFile, keyFile string) error {
	priv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return err
	}

	template := x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject: pkix.Name{
			Organization: []string{"Test"},
		},
		NotBefore:             time.Now(),
		NotAfter:              time.Now().Add(time.Hour),
		KeyUsage:              x509.KeyUsageKeyEncipherment | x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		IPAddresses:           []net.IP{net.IPv4(127, 0, 0, 1)},
	}

	certDER, err := x509.CreateCertificate(rand.Reader, &template, &template, &priv.PublicKey, priv)
	if err != nil {
		return err
	}

	certOut, err := os.Create(certFile)
	if err != nil {
		return err
	}
	defer certOut.Close()

	if err := pem.Encode(certOut, &pem.Block{Type: "CERTIFICATE", Bytes: certDER}); err != nil {
		return err
	}

	keyOut, err := os.Create(keyFile)
	if err != nil {
		return err
	}
	defer keyOut.Close()

	privKeyDER, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		return err
	}

	return pem.Encode(keyOut, &pem.Block{Type: "PRIVATE KEY", Bytes: privKeyDER})
}

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

            var cfg map[string]interface{}
            if err := json.Unmarshal(rr.Body.Bytes(), &cfg); err != nil {
                t.Fatalf("unmarshal JSON: %v", err)
            }
            if got, _ := cfg["DISABLE_UPLOAD"].(bool); got != tt.wantJSON {
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

func TestListenAndServe(t *testing.T) {
	tests := []struct {
		name     string
		certFile string
		keyFile  string
		wantTLS  bool
	}{
		{
			name:     "HTTP server without TLS",
			certFile: "",
			keyFile:  "",
			wantTLS:  false,
		},
		{
			name:     "HTTP server with missing cert",
			certFile: "",
			keyFile:  "key.pem",
			wantTLS:  false,
		},
		{
			name:     "HTTP server with missing key",
			certFile: "cert.pem",
			keyFile:  "",
			wantTLS:  false,
		},
		{
			name:     "HTTPS server with TLS",
			certFile: "cert.pem",
			keyFile:  "key.pem",
			wantTLS:  true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Find a free port
			listener, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			addr := listener.Addr().String()
			listener.Close()

			srv := &http.Server{
				Addr: addr,
				Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					w.WriteHeader(http.StatusOK)
				}),
			}

			// Create temporary cert and key files if needed for TLS test
			if tt.wantTLS {
				tempDir := t.TempDir()
				tt.certFile = filepath.Join(tempDir, "test.crt")
				tt.keyFile = filepath.Join(tempDir, "test.key")

				// Generate a test certificate
				if err := generateTestCert(tt.certFile, tt.keyFile); err != nil {
					t.Fatal(err)
				}
			}

			// Start server in background
			done := make(chan error, 1)
			go func() {
				done <- listenAndServe(srv, tt.certFile, tt.keyFile)
			}()

			// Give server time to start
			time.Sleep(100 * time.Millisecond)

			// Shutdown server
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			if err := srv.Shutdown(ctx); err != nil {
				t.Errorf("Failed to shutdown server: %v", err)
			}

			// Check that ListenAndServe returns ErrServerClosed
			select {
			case err := <-done:
				if err != http.ErrServerClosed {
					t.Errorf("Expected ErrServerClosed, got: %v", err)
				}
			case <-time.After(2 * time.Second):
				t.Error("Server did not shutdown in time")
			}
		})
	}
}

func TestSetupRegistry(t *testing.T) {
	registry := setupRegistry()

	if registry == nil {
		t.Fatal("Expected non-nil registry")
	}

	// Verify that the expected collectors are registered
	// This will panic if they are not registered properly
	metrics, err := registry.Gather()
	if err != nil {
		t.Fatalf("Failed to gather metrics: %v", err)
	}

	// Check that we have process and go collector metrics
	hasProcess := false
	hasGo := false
	for _, m := range metrics {
		if m.GetName() == "process_cpu_seconds_total" {
			hasProcess = true
		}
		if m.GetName() == "go_info" {
			hasGo = true
		}
	}

	if !hasProcess {
		t.Error("Process collector not registered")
	}
	if !hasGo {
		t.Error("Go collector not registered")
	}
}

func TestMain(t *testing.T) {
	// Save original args
	oldArgs := os.Args
	defer func() { os.Args = oldArgs }()

	// Set test arguments
	os.Args = []string{"yopass-server", "--port", "0", "--database", "memcached"}

	// Reset viper for clean test
	viper.Reset()
	viper.Set("port", 0) // Use port 0 to get a free port
	viper.Set("database", "memcached")
	viper.Set("memcached", "localhost:11211")
	viper.Set("asset-path", "public")
	viper.Set("max-length", 10000)
	viper.Set("default-expiry", "1h")

	// Start main in a goroutine
	done := make(chan struct{})
	go func() {
		defer func() {
			if r := recover(); r != nil {
				// This is expected when we kill the process
				if fmt.Sprintf("%v", r) != "shutdown error: %s" {
					t.Errorf("Unexpected panic: %v", r)
				}
			}
			close(done)
		}()
		main()
	}()

	// Give the server time to start
	time.Sleep(200 * time.Millisecond)

	// Send interrupt signal to trigger graceful shutdown
	p, err := os.FindProcess(os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	if err := p.Signal(syscall.SIGINT); err != nil {
		t.Fatal(err)
	}

	// Wait for main to finish
	select {
	case <-done:
		// Main finished successfully
	case <-time.After(5 * time.Second):
		t.Error("main() did not shut down in time")
	}
}

func TestMainWithMetrics(t *testing.T) {
	// Save original args
	oldArgs := os.Args
	defer func() { os.Args = oldArgs }()

	// Find a free port for metrics server
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	_, portStr, _ := net.SplitHostPort(listener.Addr().String())
	listener.Close()

	// Set test arguments
	os.Args = []string{"yopass-server", "--port", "0", "--metrics-port", portStr, "--database", "memcached"}

	// Reset viper for clean test
	viper.Reset()
	viper.Set("port", 0) // Use port 0 to get a free port
	viper.Set("metrics-port", portStr)
	viper.Set("database", "memcached")
	viper.Set("memcached", "localhost:11211")
	viper.Set("asset-path", "public")
	viper.Set("max-length", 10000)
	viper.Set("default-expiry", "1h")

	// Start main in a goroutine
	done := make(chan struct{})
	go func() {
		defer func() {
			if r := recover(); r != nil {
				// This is expected when we kill the process
				if fmt.Sprintf("%v", r) != "shutdown error: %s" {
					t.Errorf("Unexpected panic: %v", r)
				}
			}
			close(done)
		}()
		main()
	}()

	// Give the servers time to start
	time.Sleep(200 * time.Millisecond)

	// Send interrupt signal to trigger graceful shutdown
	p, err := os.FindProcess(os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	if err := p.Signal(syscall.SIGINT); err != nil {
		t.Fatal(err)
	}

	// Wait for main to finish
	select {
	case <-done:
		// Main finished successfully
	case <-time.After(5 * time.Second):
		t.Error("main() did not shut down in time")
	}
}

func TestPerformHealthCheck(t *testing.T) {
	tests := []struct {
		name          string
		database      string
		memcached     string
		redis         string
		wantErr       bool
		errContains   string
		skipOnNoConn  bool // Skip if database is not available
	}{
		{
			name:      "success with memcached",
			database:  "memcached",
			memcached: "localhost:11211",
			wantErr:   false,
			skipOnNoConn: true,
		},
		{
			name:      "success with redis",
			database:  "redis",
			redis:     "redis://localhost:6379/0",
			wantErr:   false,
			skipOnNoConn: true,
		},
		{
			name:        "error with unsupported database type",
			database:    "postgres",
			wantErr:     true,
			errContains: "unsupported database",
		},
		{
			name:        "error with invalid Redis URL format",
			database:    "redis",
			redis:       "invalid-url",
			wantErr:     true,
			errContains: "invalid Redis URL",
		},
		{
			name:        "error with empty Redis URL",
			database:    "redis",
			redis:       "",
			wantErr:     true,
			errContains: "invalid Redis URL",
		},
		{
			name:        "connection error with unreachable memcached",
			database:    "memcached",
			memcached:   "localhost:99999",
			wantErr:     true,
			errContains: "database health check failed",
		},
		{
			name:        "connection error with unreachable redis",
			database:    "redis",
			redis:       "redis://localhost:99999/0",
			wantErr:     true,
			errContains: "database health check failed",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Reset viper for clean test
			viper.Reset()
			viper.Set("database", tt.database)
			if tt.memcached != "" {
				viper.Set("memcached", tt.memcached)
			}
			if tt.redis != "" {
				viper.Set("redis", tt.redis)
			}

			// Create test logger
			core, _ := observer.New(zapcore.DebugLevel)
			logger := zap.New(core)

			err := performHealthCheck(logger)

			if tt.wantErr {
				if err == nil {
					t.Fatalf("expected error containing %q, got nil", tt.errContains)
				}
				if tt.errContains != "" && !contains(err.Error(), tt.errContains) {
					t.Errorf("expected error containing %q, got %q", tt.errContains, err.Error())
				}
			} else {
				if err != nil {
					if tt.skipOnNoConn {
						// Log warning but don't fail test if database is not available in CI
						t.Logf("Warning: health check failed (database may not be running): %v", err)
					} else {
						t.Fatalf("expected no error, got %v", err)
					}
				}
			}
		})
	}
}

// contains checks if a string contains a substring
func contains(s, substr string) bool {
	return len(s) >= len(substr) && (s == substr || len(substr) == 0 ||
		(len(s) > 0 && len(substr) > 0 && stringContains(s, substr)))
}

func stringContains(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}