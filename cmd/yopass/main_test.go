package main

import (
	"bytes"
	"fmt"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/jhaals/yopass/pkg/server"
	"github.com/jhaals/yopass/pkg/yopass"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/spf13/viper"
	"go.uber.org/zap/zaptest"
)

func TestCLI(t *testing.T) {
	ts, cleanup := newTestServer(t)
	defer cleanup()

	viper.Set("api", ts.URL)
	viper.Set("url", ts.URL)
	t.Cleanup(func() {
		viper.Set("api", defaultAPI)
		viper.Set("url", defaultURL)
	})

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
	ts, cleanup := newTestServer(t)
	defer cleanup()

	viper.Set("api", ts.URL)
	viper.Set("url", ts.URL)
	t.Cleanup(func() {
		viper.Set("api", defaultAPI)
		viper.Set("url", defaultURL)
	})

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
	viper.Set("decrypt", "https://yopass.se/#/c/21701b28-fb3f-451d-8a52-3e6c9094e7ea")
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
	ts, cleanup := newTestServer(t)
	defer cleanup()

	viper.Set("api", ts.URL)
	viper.Set("url", ts.URL)
	t.Cleanup(func() {
		viper.Set("api", defaultAPI)
		viper.Set("url", defaultURL)
		viper.Set("key", "")
	})

	viper.Set("decrypt", ts.URL+"/#/c/21701b28-fb3f-451d-8a52-3e6c9094e701")
	viper.Set("key", "woo")
	err := decrypt(nil)
	if err == nil {
		t.Fatal("expected error, got none")
	}
	want := `Failed to fetch secret: yopass server error: unexpected response 404 Not Found: Secret not found`
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

func newTestServer(t *testing.T) (*httptest.Server, func()) {
	db := &testDB{data: make(map[string]yopass.Secret)}
	y := server.Server{
		DB:                  db,
		MaxLength:           10000,
		Registry:            prometheus.NewRegistry(),
		ForceOneTimeSecrets: false,
		Logger:              zaptest.NewLogger(t),
	}
	ts := httptest.NewServer(y.HTTPHandler())
	return ts, func() { ts.Close() }
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

type testDB struct {
	data map[string]yopass.Secret
}

func (db *testDB) Exists(key string) (bool, error) {
	_, ok := db.data[key]
	return ok, nil
}

func (db *testDB) Get(key string) (yopass.Secret, error) {
	secret, ok := db.data[key]
	if !ok {
		return yopass.Secret{}, fmt.Errorf("secret not found")
	}
	return secret, nil
}

func (db *testDB) Put(key string, secret yopass.Secret) error {
	db.data[key] = secret
	return nil
}

func (db *testDB) Delete(key string) (bool, error) {
	delete(db.data, key)
	return true, nil
}

func (db *testDB) Status(key string) (bool, error) {
	return false, nil
}
