package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jhaals/yopass/pkg/yopass"
	"github.com/spf13/pflag"
	"github.com/spf13/viper"
)

func TestCLI(t *testing.T) {
	if !pingDemoServer() {
		t.Skip("skipping CLI integration tests - could not ping demo server")
	}

	msg := "yopass CLI integration test message"
	stdin, err := tempFile(msg)
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(stdin.Name())
	defer stdin.Close()

	out := bytes.Buffer{}
	err = encryptStdinOrFile(stdin, &out)
	if err != nil {
		t.Fatalf("expected no encryption error, got %q", err)
	}
	if !strings.HasPrefix(out.String(), viper.GetString("url")) {
		t.Fatalf("expected encrypt to return secret URL, got %q", out.String())
	}

	viper.Set("decrypt", out.String())
	out.Reset()
	err = decrypt(&out)
	if err != nil {
		t.Fatalf("expected no decryption error, got %q", err)
	}
	if out.String() != msg {
		t.Fatalf("expected secret to match original %q, got %q", msg, out.String())
	}
}

func TestInvalidExpiration(t *testing.T) {
	viper.Set("expiration", "123")
	err := encrypt(nil, nil)
	viper.Set("expiration", "1h") // reset value
	if err == nil {
		t.Fatal("expected expiration validation error, got none")
	}
	want := "Expiration can only be 1 hour (1h), 1 day (1d), or 1 week (1w)"
	if err.Error() != want {
		t.Fatalf("expected %s, got %s", want, err.Error())
	}
}

func TestMissingFileEncryption(t *testing.T) {
	viper.Set("file", "xyz")
	err := encryptStdinOrFile(nil, nil)
	if err == nil {
		t.Fatal("expected file open error, got none")
	}
	want := "Failed to open file: open xyz: no such file or directory"
	if err.Error() != want {
		t.Fatalf("expected %s, got %s", want, err.Error())
	}
}

func TestDetectsNoStdinInput(t *testing.T) {
	err := encryptStdin(os.Stdin, nil)
	if err == nil {
		t.Fatal("expected error because there is no data piped via stdin, got none")
	}
	want := "No filename or piped input to encrypt given"
	if err.Error() != want {
		t.Fatalf("expected %s, got %s", want, err.Error())
	}
}

func TestNoStdin(t *testing.T) {
	err := encryptStdin(nil, nil)
	if err == nil {
		t.Fatal("expected error because stdin is absent, got none")
	}
	want := "Failed to get file info: invalid argument"
	if err.Error() != want {
		t.Fatalf("expected %s, got %s", want, err.Error())
	}
}

func TestCLIFileUpload(t *testing.T) {
	if !pingDemoServer() {
		t.Skip("skipping CLI integration tests - could not ping demo server")
	}

	msg := "yopass CLI integration test file upload"
	file, err := tempFile(msg)
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(file.Name())
	defer file.Close()

	out := bytes.Buffer{}
	err = encryptFileByName(file.Name(), &out)
	if err != nil {
		t.Fatalf("expected no encryption error, got %q", err)
	}
	if !strings.HasPrefix(out.String(), viper.GetString("url")) {
		t.Fatalf("expected encrypt to return secret URL, got %q", out.String())
	}

	viper.Set("decrypt", out.String())
	out.Reset()
	err = decrypt(&out)
	if err != nil {
		t.Fatalf("expected no decryption error, got %q", err)
	}
	// Note yopass decrypt currently always prints the content to stdout. This
	// could be changed to create a file, but will need to handle the case that
	// the file already exists.
	if out.String() != msg {
		t.Fatalf("expected secret to match original %q, got %q", msg, out.String())
	}
}

func TestDecryptWithoutCustomKey(t *testing.T) {
	// Reset viper completely to ensure key is not set
	viper.Reset()
	viper.Set("api", "https://api.yopass.se")
	viper.Set("url", "https://yopass.se")
	viper.Set("decrypt", "https://yopass.se/#/c/21701b28-fb3f-451d-8a52-3e6c9094e7ea")
	// Do NOT set key at all - this triggers the viper.IsSet check

	err := decrypt(nil)
	if err == nil {
		t.Fatal("expected missing key error, got none")
	}
	want := "Manual decryption key required, set --key"
	if err.Error() != want {
		t.Fatalf("expected %s, got %s", want, err.Error())
	}
}

func TestDecryptWithInvalidUrl(t *testing.T) {
	viper.Set("decrypt", "https://yopass.se")
	err := decrypt(nil)
	if err == nil {
		t.Fatal("expected invalid url error, got none")
	}
	want := `Invalid yopass decrypt URL: unexpected URL: "https://yopass.se"`
	if err.Error() != want {
		t.Fatalf("expected %s, got %s", want, err.Error())
	}
}

func TestDecryptWithUnconfiguredUrl(t *testing.T) {
	viper.Set("decrypt", "")
	err := decrypt(nil)
	if err == nil {
		t.Fatal("expected unconfigured url error, got none")
	}
	want := `Unconfigured yopass decrypt URL, set --api and --url`
	if err.Error() != want {
		t.Fatalf("expected %s, got %s", want, err.Error())
	}
}

func TestSecretNotFoundError(t *testing.T) {
	viper.Set("decrypt", "https://yopass.se/#/c/21701b28-fb3f-451d-8a52-3e6c9094e7")
	viper.Set("key", "woo")
	err := decrypt(nil)
	if err == nil {
		t.Fatal("expected error, got none")
	}
	want := `Failed to fetch secret: yopass server error: unexpected response 404 Not Found: 404 page not found`
	if strings.TrimRight(err.Error(), "\n") != want {
		t.Fatalf("expected %s, got %s", want, err.Error())
	}
}

func TestExpiration(t *testing.T) {
	tests := []struct {
		input  string
		output int32
	}{
		{
			"1h",
			3600,
		},
		{
			"1d",
			86400,
		},
		{
			"1w",
			604800,
		},
		{
			"invalid",
			0,
		},
	}
	for _, tc := range tests {
		t.Run(tc.input, func(t *testing.T) {
			got := expiration(tc.input)
			if got != tc.output {
				t.Fatalf("Expected %d; got %d", tc.output, got)
			}
		})
	}
}
func TestCLIParse(t *testing.T) {
	tests := []struct {
		args   []string
		exit   int
		output string
	}{
		{
			args:   []string{},
			exit:   -1,
			output: "",
		},
		{
			args:   []string{"--one-time=false"},
			exit:   -1,
			output: "",
		},
		{
			args:   []string{"-h"},
			exit:   0,
			output: "Yopass - Secure sharing for secrets, passwords and files",
		},
		{
			args:   []string{"--help"},
			exit:   0,
			output: "Yopass - Secure sharing for secrets, passwords and files",
		},
		{
			args:   []string{"--decrypt"},
			exit:   1,
			output: "flag needs an argument: --decrypt",
		},
		{
			args:   []string{"--unknown"},
			exit:   1,
			output: "unknown flag: --unknown",
		},
	}

	for _, test := range tests {
		t.Run(strings.Join(test.args, "_"), func(t *testing.T) {
			stderr := bytes.Buffer{}
			exit := parse(test.args, &stderr)

			if test.exit != exit {
				t.Errorf("expected parse to exit with %d, got %d", test.exit, exit)
			}
			if test.output != stderr.String() && (test.output != "" && !strings.HasPrefix(stderr.String(), test.output)) {
				t.Errorf("expected parse to print %q, got: %q", test.output, stderr.String())
			}
		})
	}
}

func TestMain(t *testing.T) {
	// Save original args
	oldArgs := os.Args
	defer func() {
		os.Args = oldArgs
	}()

	tests := []struct {
		name   string
		args   []string
		setup  func()
		verify func(t *testing.T)
	}{
		{
			name: "help flag",
			args: []string{"yopass", "-h"},
			verify: func(t *testing.T) {
				// The -h flag causes parse() to return 0, and main() exits with 0
			},
		},
		{
			name: "decrypt mode",
			args: []string{"yopass", "--decrypt", "https://yopass.se/#/s/abc123/key#pass"},
			setup: func() {
				// Mock server for testing
				ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if strings.Contains(r.URL.Path, "/s/abc123") {
						resp := struct {
							Message string `json:"message"`
						}{
							Message: "encrypted_message",
						}
						json.NewEncoder(w).Encode(resp)
					}
				}))
				viper.Set("api", ts.URL)
				viper.Set("url", "https://yopass.se")
			},
		},
		{
			name: "encrypt stdin error",
			args: []string{"yopass"},
			setup: func() {
				// Reset viper settings to trigger stdin error
				viper.Reset()
				viper.Set("api", "https://api.yopass.se")
				viper.Set("url", "https://yopass.se")
				viper.Set("expiration", "1h")
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Reset pflag for each test - save old one
			oldCommandLine := pflag.CommandLine
			defer func() { pflag.CommandLine = oldCommandLine }()
			pflag.CommandLine = pflag.NewFlagSet(os.Args[0], pflag.ContinueOnError)
			pflag.String("api", viper.GetString("api"), "Yopass API server location")
			pflag.String("decrypt", viper.GetString("decrypt"), "Decrypt secret URL")
			pflag.String("expiration", viper.GetString("expiration"), "Duration after which secret will be deleted [1h, 1d, 1w]")
			pflag.String("file", viper.GetString("file"), "Read secret from file instead of stdin")
			pflag.String("key", viper.GetString("key"), "Manual encryption/decryption key")
			pflag.Bool("one-time", viper.GetBool("one-time"), "One-time download")
			pflag.String("url", viper.GetString("url"), "Yopass public URL")
			viper.BindPFlags(pflag.CommandLine)

			if tt.setup != nil {
				tt.setup()
			}

			os.Args = tt.args

			// Since main() calls os.Exit, we can't test it directly
			// Instead, we test the components that main() uses
			code := parse(tt.args[1:], os.Stderr)
			if code >= 0 {
				// main would exit here
				return
			}

			// Test would continue with encrypt/decrypt logic
			if tt.verify != nil {
				tt.verify(t)
			}
		})
	}
}

func TestEncryptionKey(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		wantKey bool
		wantErr bool
	}{
		{
			name:    "provided key",
			input:   "my-custom-key-123",
			wantKey: true,
			wantErr: false,
		},
		{
			name:    "empty key generates new",
			input:   "",
			wantKey: true,
			wantErr: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			key, err := encryptionKey(tt.input)

			if (err != nil) != tt.wantErr {
				t.Fatalf("encryptionKey() error = %v, wantErr %v", err, tt.wantErr)
			}

			if tt.wantKey && key == "" {
				t.Fatal("expected key to be generated, got empty string")
			}

			if tt.input != "" && key != tt.input {
				t.Fatalf("expected key to be %q, got %q", tt.input, key)
			}
		})
	}
}

func TestEncrypt(t *testing.T) {
	// Mock server for testing
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/secret" && r.Method == "POST" {
			// Return a mock secret ID
			resp := struct {
				Message string `json:"message"`
			}{
				Message: "test-secret-id",
			}
			json.NewEncoder(w).Encode(resp)
			return
		}
		http.NotFound(w, r)
	}))
	defer ts.Close()

	viper.Set("api", ts.URL)
	viper.Set("url", "https://yopass.se")
	viper.Set("expiration", "1h")
	viper.Set("one-time", true)

	tests := []struct {
		name          string
		setup         func()
		input         io.ReadCloser
		wantErr       bool
		errorContains string
	}{
		{
			name: "successful encryption",
			setup: func() {
				viper.Set("expiration", "1h")
				viper.Set("key", "test-key")
			},
			input:   io.NopCloser(strings.NewReader("test secret")),
			wantErr: false,
		},
		{
			name: "invalid expiration",
			setup: func() {
				viper.Set("expiration", "invalid")
			},
			input:         nil,
			wantErr:       true,
			errorContains: "Expiration can only be",
		},
		{
			name: "with generated key",
			setup: func() {
				viper.Set("expiration", "1d")
				viper.Set("key", "") // Empty key triggers generation
			},
			input:   io.NopCloser(strings.NewReader("test secret")),
			wantErr: false,
		},
		{
			name: "store error",
			setup: func() {
				viper.Set("api", "http://invalid-url-that-does-not-exist")
				viper.Set("expiration", "1w")
			},
			input:         io.NopCloser(strings.NewReader("test")),
			wantErr:       true,
			errorContains: "Failed to store secret",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.setup != nil {
				tt.setup()
			}

			out := &bytes.Buffer{}
			err := encrypt(tt.input, out)

			if (err != nil) != tt.wantErr {
				t.Fatalf("encrypt() error = %v, wantErr %v", err, tt.wantErr)
			}

			if tt.wantErr && tt.errorContains != "" {
				if !strings.Contains(err.Error(), tt.errorContains) {
					t.Fatalf("expected error to contain %q, got %q", tt.errorContains, err.Error())
				}
			}

			if !tt.wantErr && out.Len() == 0 {
				t.Fatal("expected output, got empty buffer")
			}
		})
	}
}

func TestDecryptFull(t *testing.T) {
	// Create a mock server for testing
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// The Fetch function calls /secret/{id}
		if strings.Contains(r.URL.Path, "/secret/") {
			// Return encrypted message
			encrypted, _ := yopass.Encrypt(io.NopCloser(strings.NewReader("decrypted message")), "test-key")
			resp := struct {
				Message string `json:"message"`
			}{
				Message: encrypted,
			}
			json.NewEncoder(w).Encode(resp)
			return
		}
		http.NotFound(w, r)
	}))
	defer ts.Close()

	tests := []struct {
		name    string
		setup   func()
		wantErr bool
		wantMsg string
	}{
		{
			name: "successful decrypt with key in URL",
			setup: func() {
				viper.Set("api", ts.URL)
				viper.Set("url", ts.URL)
				viper.Set("decrypt", ts.URL+"/#/s/test-id/test-key")
			},
			wantErr: false,
			wantMsg: "decrypted message",
		},
		{
			name: "decrypt with manual key",
			setup: func() {
				viper.Set("api", ts.URL)
				viper.Set("url", ts.URL)
				viper.Set("decrypt", ts.URL+"/#/c/test-id")
				viper.Set("key", "test-key")
			},
			wantErr: false,
			wantMsg: "decrypted message",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.setup != nil {
				tt.setup()
			}

			out := &bytes.Buffer{}
			err := decrypt(out)

			if (err != nil) != tt.wantErr {
				t.Fatalf("decrypt() error = %v, wantErr %v", err, tt.wantErr)
			}

			if !tt.wantErr && tt.wantMsg != "" {
				if out.String() != tt.wantMsg {
					t.Fatalf("expected message %q, got %q", tt.wantMsg, out.String())
				}
			}
		})
	}
}

func TestInitWithInvalidConfig(t *testing.T) {
	// Create a temporary invalid config file
	tempDir := t.TempDir()
	configFile := filepath.Join(tempDir, "defaults.json")

	// Write invalid JSON
	err := os.WriteFile(configFile, []byte("{invalid json}"), 0644)
	if err != nil {
		t.Fatal(err)
	}

	// Override HOME to use our temp directory
	oldHome := os.Getenv("HOME")
	defer os.Setenv("HOME", oldHome)

	configDir := filepath.Join(tempDir, ".config", "yopass")
	os.MkdirAll(configDir, 0755)
	os.Rename(configFile, filepath.Join(configDir, "defaults.json"))

	// This would normally call init() which would exit(3) on invalid config
	// We can't test init() directly, but we can test the config reading logic
	viper.Reset()
	viper.SetConfigName("defaults")
	viper.AddConfigPath(configDir)
	err = viper.ReadInConfig()

	if err == nil {
		t.Fatal("expected config error, got none")
	}
}

func pingDemoServer() bool {
	resp, err := http.Get(viper.GetString("url"))
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

func tempFile(s string) (*os.File, error) {
	f, err := os.CreateTemp("", "yopass-")
	if err != nil {
		return nil, err
	}
	if _, err := f.Write([]byte(s)); err != nil {
		return nil, err
	}
	if _, err := f.Seek(0, 0); err != nil {
		return nil, err
	}
	return f, nil
}
