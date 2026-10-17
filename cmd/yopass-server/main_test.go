package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"testing/synctest"
	"time"

	"github.com/jhaals/yopass/pkg/server"
	"github.com/jhaals/yopass/pkg/yopass"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/spf13/viper"
	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
	"go.uber.org/zap/zaptest/observer"
)

// mockDatabase is a mock implementation of server.Database for testing
type mockDatabase struct {
	healthErr error
}

func (m *mockDatabase) Get(key string) (yopass.Secret, error) {
	return yopass.Secret{}, errors.New("not implemented")
}

func (m *mockDatabase) Put(key string, secret yopass.Secret) error {
	return errors.New("not implemented")
}

func (m *mockDatabase) Delete(key string) (bool, error) {
	return false, errors.New("not implemented")
}

func (m *mockDatabase) Status(key string) (yopass.Secret, error) {
	return yopass.Secret{}, errors.New("not implemented")
}

func (m *mockDatabase) Update(key string, fn func(yopass.Secret) (yopass.Secret, error)) error {
	return errors.New("not implemented")
}

func (m *mockDatabase) Health() error {
	return m.healthErr
}

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
			registry := prometheus.NewRegistry()
			srv := &server.Server{
				Registry:      registry,
				DisableUpload: tt.disableUpload,
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
	expected := `invalid Redis URL: redis: invalid connection URL; check the scheme and percent-encode credentials`
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

func TestSetupWebhooksDoesNotLogCredentials(t *testing.T) {
	viper.Set("webhook-url", "https://user:hunter2@hooks.example.com/catch/pathtoken?sig=querytoken")
	t.Cleanup(func() { viper.Set("webhook-url", "") })
	core, logs := observer.New(zapcore.DebugLevel)

	webhooks, err := setupWebhooks(zap.New(core), prometheus.NewRegistry())
	if err != nil {
		t.Fatalf("Expected a valid URL, got %v", err)
	}
	t.Cleanup(webhooks.Stop)
	fields := logs.FilterMessage("webhook notifications enabled").All()[0].ContextMap()
	if _, ok := fields["url"]; ok || fields["host"] != "hooks.example.com" {
		t.Errorf("Expected only the host 'hooks.example.com' to be logged, got %v", fields)
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

func TestConfigureZapLoggerLogLevel(t *testing.T) {
	tests := []struct {
		name      string
		logLevel  string
		debugWant bool
	}{
		{name: "default empty stays info", logLevel: "", debugWant: false},
		{name: "info level", logLevel: "info", debugWant: false},
		{name: "debug level via LOG_LEVEL", logLevel: "debug", debugWant: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			viper.Reset()
			viper.Set("log-level", tt.logLevel)
			defer viper.Reset()

			logger := configureZapLogger()
			if logger == nil {
				t.Fatal("Expected non-nil logger")
			}
			if got := logger.Core().Enabled(zapcore.DebugLevel); got != tt.debugWant {
				t.Errorf("debug enabled: got %v, want %v", got, tt.debugWant)
			}
		})
	}
}

func TestGetStringSliceCSV(t *testing.T) {
	tests := []struct {
		name  string
		value interface{}
		want  []string
	}{
		{
			name:  "comma-separated env string is split",
			value: "192.168.1.0/24,10.0.0.0/8",
			want:  []string{"192.168.1.0/24", "10.0.0.0/8"},
		},
		{
			name:  "single value without comma",
			value: "127.0.0.0/8",
			want:  []string{"127.0.0.0/8"},
		},
		{
			name:  "whitespace around values is trimmed",
			value: "corp.example.com, example.com",
			want:  []string{"corp.example.com", "example.com"},
		},
		{
			name:  "already-split slice from flag parsing",
			value: []string{"127.0.0.0/8", "::1/128"},
			want:  []string{"127.0.0.0/8", "::1/128"},
		},
		{
			name:  "empty entries are dropped",
			value: "a,,b, ,c",
			want:  []string{"a", "b", "c"},
		},
		{
			name:  "empty value yields nil",
			value: "",
			want:  nil,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			viper.Reset()
			viper.Set("trusted-proxies", tt.value)
			defer viper.Reset()

			got := getStringSliceCSV("trusted-proxies")
			if len(got) != len(tt.want) {
				t.Fatalf("got %v, want %v", got, tt.want)
			}
			for i := range got {
				if got[i] != tt.want[i] {
					t.Errorf("element %d: got %q, want %q", i, got[i], tt.want[i])
				}
			}
		})
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

func TestEffectiveFileTransferTimeout(t *testing.T) {
	for _, tt := range []struct {
		name                string
		request, file, want time.Duration
	}{
		{"explicit file timeout", 30 * time.Second, 5 * time.Minute, 5 * time.Minute},
		{"fallback to request timeout", 30 * time.Second, 0, 30 * time.Second},
		{"both disabled", 0, 0, 0},
		{"request disabled", 0, time.Minute, time.Minute},
	} {
		t.Run(tt.name, func(t *testing.T) {
			setFlag(t, "request-timeout", tt.request)
			setFlag(t, "file-transfer-timeout", tt.file)
			if got := effectiveFileTransferTimeout(); got != tt.want {
				t.Fatalf("effective file transfer timeout = %s, want %s", got, tt.want)
			}
		})
	}
}

func TestApplicationServerTimeouts(t *testing.T) {
	for _, timeout := range []time.Duration{0, 3 * time.Second} {
		setFlag(t, "request-timeout", timeout)
		srv := newApplicationServer("127.0.0.1:0", http.NotFoundHandler())
		if srv.ReadTimeout != timeout || srv.WriteTimeout != timeout {
			t.Fatalf("expected %s read/write timeouts, got %s/%s", timeout, srv.ReadTimeout, srv.WriteTimeout)
		}
		if srv.HTTP2 == nil || srv.HTTP2.WriteByteTimeout != 30*time.Second {
			t.Fatal("HTTP/2 write-progress limit must stay enabled even with request timeouts off")
		}
	}
	metrics := newMetricsServer("127.0.0.1:0", http.NotFoundHandler())
	if metrics.HTTP2 == nil || metrics.HTTP2.WriteByteTimeout != 30*time.Second {
		t.Fatal("metrics listener must also bound blocked HTTP/2 writes")
	}
}

func TestApplicationServerLimitsHeaderSize(t *testing.T) {
	testServerLimitsHeaderSize(t, newApplicationServer)
}

func TestMetricsServerLimitsHeaderSize(t *testing.T) {
	testServerLimitsHeaderSize(t, newMetricsServer)
}

func testServerLimitsHeaderSize(t *testing.T, newServer func(string, http.Handler) *http.Server) {
	t.Helper()
	for _, protocol := range []struct {
		name  string
		url   string
		major int
	}{
		{"HTTP1", "http://example.com", 1},
		{"HTTP2", "https://example.com", 2},
	} {
		t.Run(protocol.name, func(t *testing.T) {
			var handled atomic.Int32
			handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				handled.Add(1)
				w.WriteHeader(http.StatusNoContent)
			})
			ts := httptest.NewTestServer(t, handler)
			ts.Config = newServer("", handler)
			if ts.Config.TLSConfig == nil {
				ts.Config.TLSConfig = &tls.Config{}
			}
			// The in-memory server uses Serve; production ServeTLS adds ALPN itself.
			ts.Config.TLSConfig.NextProtos = []string{"h2", "http/1.1"}
			ts.EnableHTTP2 = true
			client := ts.Client()
			client.Timeout = 5 * time.Second
			for _, size := range []int{12 << 10, 32 << 10} {
				req, err := http.NewRequest(http.MethodGet, protocol.url, nil)
				if err != nil {
					t.Fatal(err)
				}
				req.Header.Set("Cookie", "session="+strings.Repeat("a", size))
				resp, err := client.Do(req)
				if size == 12<<10 {
					if err != nil {
						t.Fatal(err)
					}
					resp.Body.Close()
					if resp.StatusCode != http.StatusNoContent || resp.ProtoMajor != protocol.major {
						t.Fatalf("ordinary headers: status %d, protocol %s", resp.StatusCode, resp.Proto)
					}
				} else if err == nil {
					resp.Body.Close()
					if resp.StatusCode != http.StatusRequestHeaderFieldsTooLarge {
						t.Fatalf("oversized headers: status %d", resp.StatusCode)
					}
				} else if protocol.major == 1 {
					t.Fatal(err)
				}
			}
			if got := handled.Load(); got != 1 {
				t.Fatalf("handler called %d times; oversized headers must be rejected", got)
			}
		})
	}
}

func TestServersRejectCompressedHTTP2Headers(t *testing.T) {
	for name, newServer := range map[string]func(string, http.Handler) *http.Server{
		"application": newApplicationServer,
		"metrics":     newMetricsServer,
	} {
		t.Run(name, func(t *testing.T) {
			var handled atomic.Bool
			handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				handled.Store(true)
				w.WriteHeader(http.StatusNoContent)
			})
			ts := httptest.NewTestServer(t, handler)
			ts.Config = newServer("", handler)
			ts.Config.TLSConfig = &tls.Config{NextProtos: []string{"h2"}}
			ts.EnableHTTP2 = true
			transport := ts.Client().Transport.(*http.Transport)
			transport.TLSClientConfig.NextProtos = []string{"h2"}
			conn, err := transport.DialTLSContext(context.Background(), "tcp", "example.com:443")
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			if err := conn.SetDeadline(time.Now().Add(5 * time.Second)); err != nil {
				t.Fatal(err)
			}
			if err := conn.(*tls.Conn).HandshakeContext(context.Background()); err != nil {
				t.Fatal(err)
			}
			if got := conn.(*tls.Conn).ConnectionState().NegotiatedProtocol; got != "h2" {
				t.Fatalf("negotiated protocol %q, want h2", got)
			}
			// Send raw frames so the client cannot refuse the server's advertised limit.
			if _, err := io.WriteString(conn, "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n"); err != nil {
				t.Fatal(err)
			}
			// Empty SETTINGS, then HEADERS on stream 1 with END_HEADERS | END_STREAM.
			if _, err := conn.Write([]byte{0, 0, 0, 4, 0, 0, 0, 0, 0}); err != nil {
				t.Fatal(err)
			}
			// HPACK: GET, https, /, literal authority; index a 1000-byte cookie,
			// then repeat dynamic entry 62: ~1 KiB expands to >40 KiB of headers.
			block := append([]byte{0x82, 0x87, 0x84, 0x01, 11}, "example.com"...)
			block = append(block, 0x60, 0x7f, 0xe9, 0x06)
			block = append(block, strings.Repeat("a", 1000)...)
			block = append(block, bytes.Repeat([]byte{0xbe}, 39)...)
			frame := []byte{0, byte(len(block) >> 8), byte(len(block)), 1, 5, 0, 0, 0, 1}
			if _, err := conn.Write(append(frame, block...)); err != nil {
				t.Fatal(err)
			}
			for {
				var header [9]byte
				if _, err := io.ReadFull(conn, header[:]); err != nil {
					t.Fatal(err)
				}
				size := int64(header[0])<<16 | int64(header[1])<<8 | int64(header[2])
				if size > 16<<10 {
					t.Fatal("unexpectedly large response frame")
				}
				if _, err := io.CopyN(io.Discard, conn, size); err != nil {
					t.Fatal(err)
				}
				// HEADERS, RST_STREAM, or GOAWAY means the server decided the request.
				if header[3] == 1 || header[3] == 3 || header[3] == 7 {
					break
				}
			}
			if handled.Load() {
				t.Fatal("compressed oversized headers reached the handler")
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
	viper.Set("max-file-size", "1MB")
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
	viper.Set("max-file-size", "1MB")
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
		name        string
		healthErr   error
		wantErr     bool
		errContains string
	}{
		{
			name:      "success with healthy database",
			healthErr: nil,
			wantErr:   false,
		},
		{
			name:        "error with unhealthy database",
			healthErr:   errors.New("connection refused"),
			wantErr:     true,
			errContains: "database health check failed",
		},
		{
			name:        "error with timeout",
			healthErr:   errors.New("timeout"),
			wantErr:     true,
			errContains: "database health check failed",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Create test logger
			core, _ := observer.New(zapcore.DebugLevel)
			logger := zap.New(core)

			// Create mock database
			db := &mockDatabase{
				healthErr: tt.healthErr,
			}

			err := performHealthCheck(logger, db)

			if tt.wantErr {
				if err == nil {
					t.Fatalf("expected error containing %q, got nil", tt.errContains)
				}
				if tt.errContains != "" && !strings.Contains(err.Error(), tt.errContains) {
					t.Errorf("expected error containing %q, got %q", tt.errContains, err.Error())
				}
			} else {
				if err != nil {
					t.Fatalf("expected no error, got %v", err)
				}
			}
		})
	}
}

func (db *mockDatabase) GetAuthorized(key string, authorize func(yopass.Secret) error) (yopass.Secret, error) {
	s, err := db.Status(key)
	if err != nil {
		return yopass.Secret{}, err
	}
	if err := authorize(s); err != nil {
		return yopass.Secret{}, err
	}
	return db.Get(key)
}

func (db *mockDatabase) DeleteAuthorized(key string, authorize func(yopass.Secret) error) (bool, error) {
	s, err := db.Status(key)
	if err != nil {
		return false, err
	}
	if err := authorize(s); err != nil {
		return false, err
	}
	return db.Delete(key)
}

func TestSetupDatabaseRedisDoesNotLogPassword(t *testing.T) {
	viper.Set("database", "redis")
	t.Cleanup(viper.Reset)
	core, logs := observer.New(zap.DebugLevel)
	for _, raw := range []string{"redis://user:hunter2@localhost:6379/0", "redis://:1#hunter2@localhost:6379/0"} {
		viper.Set("redis", raw)
		db, err := setupDatabase(zap.New(core))
		if err != nil {
			t.Fatal(err)
		}
		_ = db
	}
	for _, entry := range logs.All() {
		if strings.Contains(fmt.Sprint(entry.ContextMap()), "hunter2") {
			t.Fatal("credential leaked in log")
		}
	}
}

func TestFileCleanupWithUploadsDisabled(t *testing.T) {
	for _, disabledCleanup := range []bool{false, true} {
		t.Run(fmt.Sprint(disabledCleanup), func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				viper.Reset()
				t.Cleanup(viper.Reset)
				dir := t.TempDir()
				viper.Set("disable-upload", true)
				viper.Set("disable-file-cleanup", disabledCleanup)
				viper.Set("file-store", "disk")
				viper.Set("file-store-path", dir)
				viper.Set("cleanup-interval", 1)
				store, err := setupFileStore(zap.NewNop(), &mockDatabase{})
				if err != nil {
					t.Fatal(err)
				}
				if err := store.Save(context.Background(), "expired", strings.NewReader("data"), 4, -1); err != nil {
					t.Fatal(err)
				}
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				startFileCleanup(ctx, store, zap.NewNop())
				synctest.Sleep(2 * time.Second)
				_, err = os.Stat(filepath.Join(dir, "ex", "expired.bin"))
				if disabledCleanup && err != nil {
					t.Fatalf("disabled cleanup removed file: %v", err)
				}
				if !disabledCleanup && !os.IsNotExist(err) {
					t.Fatalf("expired file remains: %v", err)
				}
			})
		})
	}
}
