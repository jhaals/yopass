package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/ProtonMail/go-crypto/openpgp/armor"
	"github.com/ProtonMail/go-crypto/openpgp/s2k"
	"github.com/jhaals/yopass/pkg/server"
	"github.com/jhaals/yopass/pkg/yopass"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/spf13/viper"
	"go.uber.org/zap/zaptest"
)

// resetViper wipes all viper state, including keys a test has set that
// cannot be unset individually (e.g. "key", "file", "decrypt"), and restores
// the defaults from init() so tests stay independent of execution order.
func resetViper() {
	viper.Reset()
	viper.SetDefault("api", defaultAPI)
	viper.SetDefault("api-token", "")
	viper.SetDefault("url", defaultURL)
	viper.SetDefault("one-time", true)
	viper.SetDefault("expiration", "1h")
}

func TestCLI(t *testing.T) {
	resetViper()
	ts := newTestServer(t)

	viper.Set("api", ts.URL)
	viper.Set("url", ts.URL)
	t.Cleanup(resetViper)

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

	id, _, _, _, err := yopass.ParseURL(out.String())
	if err != nil {
		t.Fatal(err)
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
	response, err := ts.Client().Get(ts.URL + "/secret/" + id)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusNotFound {
		t.Fatalf("one-time secret remains retrievable: HTTP %d", response.StatusCode)
	}
	out.Reset()
	if err := decrypt(&out); err == nil || out.Len() != 0 {
		t.Fatalf("second decryption returned content or succeeded: %v", err)
	}
}

func TestCLIUsesAPIToken(t *testing.T) {
	const wantAuth = "Bearer test-token"
	var mu sync.Mutex
	var storedCiphertext string
	ts := useHTTPTestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != wantAuth {
			t.Errorf("%s %s: expected Authorization header %q, got %q", r.Method, r.URL.Path, wantAuth, got)
		}
		switch r.URL.Path {
		case "/config":
			_ = json.NewEncoder(w).Encode(map[string]bool{"ARGON2": false})
		case "/create/secret":
			body, err := io.ReadAll(r.Body)
			if err != nil {
				t.Errorf("reading body: %v", err)
				http.Error(w, "bad request", http.StatusBadRequest)
				return
			}
			var payload yopass.Secret
			if err := json.Unmarshal(body, &payload); err != nil {
				t.Errorf("decoding payload: %v", err)
				http.Error(w, "bad request", http.StatusBadRequest)
				return
			}
			mu.Lock()
			storedCiphertext = payload.Message
			mu.Unlock()
			_ = json.NewEncoder(w).Encode(map[string]string{"message": "test-id"})
		case "/secret/test-id":
			mu.Lock()
			ct := storedCiphertext
			mu.Unlock()
			_ = json.NewEncoder(w).Encode(map[string]string{"message": ct})
		default:
			t.Errorf("unexpected request path %s", r.URL.Path)
			http.Error(w, "not found", http.StatusNotFound)
		}
	}))
	resetViper()
	viper.Set("api", ts.URL)
	viper.Set("api-token", "test-token")
	viper.Set("url", ts.URL)
	t.Cleanup(resetViper)

	msg := "yopass CLI token auth test"
	stdin, err := tempFile(msg)
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(stdin.Name())
	defer stdin.Close()

	var out bytes.Buffer
	if err := encryptStdinOrFile(stdin, &out); err != nil {
		t.Fatalf("expected no encryption error, got %q", err)
	}
	if !strings.HasPrefix(out.String(), ts.URL) {
		t.Fatalf("expected encrypt to return secret URL, got %q", out.String())
	}

	viper.Set("decrypt", out.String())
	out.Reset()
	if err := decrypt(&out); err != nil {
		t.Fatalf("expected no decryption error, got %q", err)
	}
	if out.String() != msg {
		t.Fatalf("expected decrypted secret %q, got %q", msg, out.String())
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
	t.Cleanup(resetViper)
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
	ts := newTestServer(t)

	viper.Set("api", ts.URL)
	viper.Set("url", ts.URL)
	t.Cleanup(resetViper)

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
	ts := newTestServer(t)

	viper.Set("api", ts.URL)
	viper.Set("url", ts.URL)
	t.Cleanup(resetViper)

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

func newTestServer(t *testing.T) *httptest.Server {
	db := &testDB{data: make(map[string]yopass.Secret)}
	y := server.Server{
		DB:                  db,
		FileStore:           server.NewDatabaseFileStore(db),
		MaxLength:           10000,
		MaxFileSize:         10 * 1024 * 1024,
		Registry:            prometheus.NewRegistry(),
		ForceOneTimeSecrets: false,
		Logger:              zaptest.NewLogger(t),
	}
	return useHTTPTestServer(t, y.HTTPHandler())
}

func useHTTPTestServer(t *testing.T, handler http.Handler) *httptest.Server {
	t.Helper()
	ts := httptest.NewTestServer(t, handler)
	previousClient := yopass.HTTPClient
	yopass.HTTPClient = ts.Client()
	t.Cleanup(func() { yopass.HTTPClient = previousClient })
	return ts
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

// testDB models atomic claims with revisions, including identical replacements.
type testDB struct {
	mu       sync.Mutex
	data     map[string]yopass.Secret
	versions map[string]uint64
}

func (db *testDB) snapshot(key string) (yopass.Secret, uint64, error) {
	db.mu.Lock()
	defer db.mu.Unlock()
	s, ok := db.data[key]
	if !ok {
		return yopass.Secret{}, 0, server.ErrKeyNotFound
	}
	return s, db.versions[key], nil
}
func (db *testDB) Exists(key string) (bool, error) {
	_, _, err := db.snapshot(key)
	return err == nil, nil
}
func (db *testDB) Get(key string) (yopass.Secret, error) {
	return db.GetAuthorized(key, func(yopass.Secret) error { return nil })
}
func (db *testDB) Put(key string, s yopass.Secret) error {
	db.mu.Lock()
	defer db.mu.Unlock()
	if db.data == nil {
		db.data = make(map[string]yopass.Secret)
	}
	if db.versions == nil {
		db.versions = make(map[string]uint64)
	}
	db.data[key] = s
	db.versions[key]++
	return nil
}
func (db *testDB) Delete(key string) (bool, error) {
	db.mu.Lock()
	defer db.mu.Unlock()
	_, exists := db.data[key]
	if exists {
		delete(db.data, key)
		db.versions[key]++
	}
	return exists, nil
}
func (db *testDB) Status(key string) (yopass.Secret, error) {
	s, _, err := db.snapshot(key)
	return s, err
}
func (db *testDB) Update(key string, fn func(yopass.Secret) (yopass.Secret, error)) error {
	for range 5 {
		s, version, err := db.snapshot(key)
		if err != nil {
			return err
		}
		updated, err := fn(s)
		if err != nil {
			return err
		}
		db.mu.Lock()
		_, exists := db.data[key]
		if exists && db.versions[key] == version {
			db.data[key] = updated
			db.versions[key]++
			db.mu.Unlock()
			return nil
		}
		db.mu.Unlock()
	}
	return errors.New("update contention")
}
func (db *testDB) Health() error { return nil }

// TestCLIArgon2 verifies that the CLI reads the server /config endpoint and
// encrypts with Argon2 key derivation when the server has it enabled. The
// Argon2 choice is made per encryption call and never alters process-wide
// state, so this test is independent of test execution order.
func TestCLIArgon2(t *testing.T) {
	db := &testDB{data: make(map[string]yopass.Secret)}
	y := server.Server{
		DB:          db,
		FileStore:   server.NewDatabaseFileStore(db),
		MaxLength:   10000,
		MaxFileSize: 10 * 1024 * 1024,
		Registry:    prometheus.NewRegistry(),
		Logger:      zaptest.NewLogger(t),
		Argon2:      true,
	}
	ts := useHTTPTestServer(t, y.HTTPHandler())

	// Clear keys possibly left behind by earlier tests before setting up.
	resetViper()
	viper.Set("api", ts.URL)
	viper.Set("url", ts.URL)
	t.Cleanup(resetViper)

	msg := "yopass CLI argon2 test message"
	stdin, err := tempFile(msg)
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(stdin.Name())
	defer stdin.Close()

	out := bytes.Buffer{}
	if err := encryptStdinOrFile(stdin, &out); err != nil {
		t.Fatalf("expected no encryption error, got %q", err)
	}

	// The stored ciphertext must use Argon2 key derivation.
	db.mu.Lock()
	stored := make(map[string]yopass.Secret, len(db.data))
	for id, secret := range db.data {
		stored[id] = secret
	}
	db.mu.Unlock()
	if len(stored) != 1 {
		t.Fatalf("expected one stored secret, got %d", len(stored))
	}
	for _, secret := range stored {
		if mode := messageS2KMode(t, secret.Message); mode != s2k.Argon2S2K {
			t.Errorf("expected S2K mode %d (Argon2), got %d", s2k.Argon2S2K, mode)
		}
	}

	viper.Set("decrypt", out.String())
	out.Reset()
	if err := decrypt(&out); err != nil {
		t.Fatalf("expected no decryption error, got %q", err)
	}
	if out.String() != msg {
		t.Fatalf("expected secret to match original %q, got %q", msg, out.String())
	}
}

// messageS2KMode extracts the S2K mode from the leading symmetric-key
// encrypted session key (SKESK) packet of an armored PGP message.
func messageS2KMode(t *testing.T, msg string) s2k.Mode {
	t.Helper()

	block, err := armor.Decode(strings.NewReader(msg))
	if err != nil {
		t.Fatalf("could not decode armor: %v", err)
	}
	raw, err := io.ReadAll(block.Body)
	if err != nil {
		t.Fatalf("could not read message body: %v", err)
	}
	if len(raw) < 8 {
		t.Fatalf("message too short: %d bytes", len(raw))
	}

	// New-format packet header, tag 3 is the SKESK packet. The packet is
	// small enough that a single length octet follows the tag.
	if raw[0] != 0xc3 {
		t.Fatalf("expected message to start with a SKESK packet, got header byte %#x", raw[0])
	}
	body := raw[2:]

	// The S2K specifier position depends on the SKESK version (RFC 9580
	// section 5.3). Version 4: cipher octet, then S2K. Version 6: octet
	// count, cipher, AEAD mode and S2K length octets, then S2K.
	var s2kBytes []byte
	switch version := body[0]; version {
	case 4:
		s2kBytes = body[2:]
	case 6:
		s2kBytes = body[5 : 5+int(body[4])]
	default:
		t.Fatalf("unexpected SKESK version %d", version)
	}

	params, err := s2k.ParseIntoParams(bytes.NewReader(s2kBytes))
	if err != nil {
		t.Fatalf("could not parse S2K params: %v", err)
	}
	return params.Mode()
}

func TestMatchesPublicURL(t *testing.T) {
	for _, tc := range []struct {
		link, base string
		want       bool
	}{
		{"https://yopass.se/#/s/id/key", "https://yopass.se", true},
		{"https://YOPASS.se/app/#/s/id/key", "https://yopass.se/app/", true},
		{"https://yopass.se.evil.example/#/s/id/key", "https://yopass.se", false},
		{"https://yopass.se@evil.example/#/s/id/key", "https://yopass.se", false},
		{"https://yopass.se/application/#/s/id/key", "https://yopass.se/app", false},
		{"http://yopass.se/#/s/id/key", "https://yopass.se", false},
		{"https://yopass.se/#/s/id/key", "", false},
	} {
		if got := matchesPublicURL(tc.link, tc.base); got != tc.want {
			t.Errorf("matchesPublicURL(%q, %q) = %v", tc.link, tc.base, got)
		}
	}
}

func (db *testDB) GetAuthorized(key string, authorize func(yopass.Secret) error) (yopass.Secret, error) {
	return db.readAuthorized(key, authorize, false)
}
func (db *testDB) DeleteAuthorized(key string, authorize func(yopass.Secret) error) (bool, error) {
	_, err := db.readAuthorized(key, authorize, true)
	return err == nil, err
}
func (db *testDB) readAuthorized(key string, authorize func(yopass.Secret) error, remove bool) (yopass.Secret, error) {
	s, version, err := db.snapshot(key)
	if err != nil {
		return yopass.Secret{}, err
	}
	if err := authorize(s); err != nil {
		return yopass.Secret{}, err
	}
	if s.OneTime || remove {
		db.mu.Lock()
		defer db.mu.Unlock()
		_, exists := db.data[key]
		if !exists || db.versions[key] != version {
			return yopass.Secret{}, server.ErrKeyNotFound
		}
		delete(db.data, key)
		db.versions[key]++
	}
	return s, nil
}

func TestCLIDatabaseClaims(t *testing.T) {
	for _, remove := range []bool{false, true} {
		name := "get"
		if remove {
			name = "delete"
		}
		t.Run(name, func(t *testing.T) {
			db := &testDB{}
			original := yopass.Secret{Message: "ciphertext", OneTime: !remove}
			if err := db.Put("key", original); err != nil {
				t.Fatal(err)
			}
			claim := func(authorize func(yopass.Secret) error) error {
				if remove {
					deleted, err := db.DeleteAuthorized("key", authorize)
					if err != nil && deleted {
						t.Error("failed delete reported success")
					}
					return err
				}
				got, err := db.GetAuthorized("key", authorize)
				if err != nil && got != (yopass.Secret{}) {
					t.Error("failed claim leaked ciphertext")
				}
				return err
			}
			denied := errors.New("denied")
			if err := claim(func(yopass.Secret) error { return denied }); !errors.Is(err, denied) {
				t.Fatalf("denied claim: %v", err)
			}
			if err := claim(func(yopass.Secret) error { return db.Put("key", original) }); !errors.Is(err, server.ErrKeyNotFound) {
				t.Fatalf("identical replacement claim: %v", err)
			}
			if got, err := db.Status("key"); err != nil || got != original {
				t.Fatalf("replacement lost: %+v, %v", got, err)
			}
			if err := claim(func(yopass.Secret) error { return nil }); err != nil {
				t.Fatal(err)
			}
			if _, err := db.Status("key"); !errors.Is(err, server.ErrKeyNotFound) {
				t.Fatalf("claimed key remains: %v", err)
			}
		})
	}
}

func TestCLIDatabaseConcurrentOneTimeGet(t *testing.T) {
	db := &testDB{}
	if err := db.Put("key", yopass.Secret{Message: "ciphertext", OneTime: true}); err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	results := make(chan error, 20)
	var workers sync.WaitGroup
	for range 20 {
		workers.Go(func() { <-start; _, err := db.Get("key"); results <- err })
	}
	close(start)
	workers.Wait()
	close(results)
	successes := 0
	for err := range results {
		if err == nil {
			successes++
		} else if !errors.Is(err, server.ErrKeyNotFound) {
			t.Errorf("unexpected claim error: %v", err)
		}
	}
	if successes != 1 {
		t.Fatalf("successful claims: %d, want 1", successes)
	}
}
