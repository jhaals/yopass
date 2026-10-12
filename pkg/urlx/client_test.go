package urlx_test

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"go.uber.org/zap/zaptest"

	"github.com/mehrabiyan/urlx/pkg/server"
	"github.com/mehrabiyan/urlx/pkg/urlx"
	"github.com/prometheus/client_golang/prometheus"
)

func newTestServer(t *testing.T, db server.Database) *httptest.Server {
	y := server.Server{
		DB:                  db,
		FileStore:           server.NewDatabaseFileStore(db),
		MaxLength:           10000,
		MaxFileSize:         10 * 1024 * 1024,
		Registry:            prometheus.NewRegistry(),
		ForceOneTimeSecrets: false,
		Logger:              zaptest.NewLogger(t),
	}
	return useTestServer(t, y.HTTPHandler())
}

func useTestServer(t *testing.T, handler http.Handler) *httptest.Server {
	t.Helper()
	ts := httptest.NewTestServer(t, handler)
	previousClient := urlx.HTTPClient
	urlx.HTTPClient = ts.Client()
	t.Cleanup(func() { urlx.HTTPClient = previousClient })
	return ts
}

func TestFetch(t *testing.T) {
	db := testDB(map[string]string{})
	ts := newTestServer(t, &db)

	key := "4b9502b0-112a-40f5-a872-956250e81f6c"
	msg := `-----BEGIN PGP MESSAGE-----
Version: OpenPGP.js v4.10.8
Comment: https://openpgpjs.org

wy4ECQMIRthQ3aO85NvgAfASIX3dTwsFVt0gshPu7n1tN05e8rpqxOk6PYNm
xtt90k4BqHuTCLNlFRJjuiuE8zdIc+j5zTN5zihxUReVqokeqULLOx2FBMHZ
sbfqaG/iDbp+qDOc98IagMyPrEqKDxnhVVOraXy5dD9RDsntLso=
=0vwU
-----END PGP MESSAGE-----`
	if err := db.Put(key, urlx.Secret{Message: msg}); err != nil {
		t.Fatal(err)
	}

	got, err := urlx.Fetch(ts.URL, key)
	if err != nil {
		t.Fatal(err)
	}
	if msg != got {
		t.Errorf("expected fetched message to be %q, got %q", msg, got)
	}

	_, err = urlx.Fetch(ts.URL, "4b9502b0-112a-40f5-a872-000000000000")
	if want := new(urlx.ServerError); !errors.As(err, &want) {
		t.Errorf("expected a ServerError, got %v", err)
	}
}

func TestFetchInvalidServer(t *testing.T) {
	_, err := urlx.Fetch("127.0.0.1:9999/invalid", "1337")
	if err == nil {
		t.Error("expected error, got none")
	}
}

func TestStore(t *testing.T) {
	db := testDB(map[string]string{})
	ts := newTestServer(t, &db)

	msg := `-----BEGIN PGP MESSAGE-----
Version: OpenPGP.js v4.10.8
Comment: https://openpgpjs.org

wy4ECQMIRthQ3aO85NvgAfASIX3dTwsFVt0gshPu7n1tN05e8rpqxOk6PYNm
xtt90k4BqHuTCLNlFRJjuiuE8zdIc+j5zTN5zihxUReVqokeqULLOx2FBMHZ
sbfqaG/iDbp+qDOc98IagMyPrEqKDxnhVVOraXy5dD9RDsntLso=
=0vwU
-----END PGP MESSAGE-----`
	id, err := urlx.Store(ts.URL, urlx.Secret{Expiration: 3600, Message: msg})
	if err != nil {
		t.Fatal(err)
	}

	got, err := db.Get(id)
	if err != nil {
		t.Fatal(err)
	}
	if msg != got.Message {
		t.Errorf("expected stored message to be %q, got %q", msg, got.Message)
	}
}

type testDB map[string]string

func (db *testDB) Exists(key string) (bool, error) {
	_, ok := (map[string]string(*db))[key]
	return ok, nil
}

func (db *testDB) Get(key string) (urlx.Secret, error) {
	msg, ok := (map[string]string(*db))[key]
	if !ok {
		return urlx.Secret{}, fmt.Errorf("secret not found")
	}
	return urlx.Secret{Message: msg}, nil
}

func (db *testDB) Put(key string, secret urlx.Secret) error {
	(map[string]string(*db))[key] = secret.Message
	return nil
}

func (db *testDB) Delete(key string) (bool, error) {
	delete((map[string]string(*db)), key)
	return true, nil
}

func (db *testDB) Status(key string) (urlx.Secret, error) {
	msg, ok := (map[string]string(*db))[key]
	if !ok {
		return urlx.Secret{}, fmt.Errorf("secret not found")
	}
	return urlx.Secret{Message: msg}, nil
}

func (db *testDB) Update(key string, fn func(urlx.Secret) (urlx.Secret, error)) error {
	s, err := db.Get(key)
	if err != nil {
		return server.ErrKeyNotFound
	}
	updated, err := fn(s)
	if err != nil {
		return err
	}
	return db.Put(key, updated)
}

func (db *testDB) Health() error {
	return nil
}

func TestServerError(t *testing.T) {
	_, storeErr := urlx.StoreFile("http://127.0.0.1:1/invalid", []byte("x"), 3600, true)
	var se *urlx.ServerError
	if !errors.As(storeErr, &se) {
		t.Fatalf("expected ServerError, got %T: %v", storeErr, storeErr)
	}
	if se.Error() == "" {
		t.Error("expected non-empty error message")
	}
	if se.Unwrap() == nil {
		t.Error("expected non-nil unwrapped error")
	}
}

func TestStoreFile(t *testing.T) {
	db := testDB(map[string]string{})
	ts := newTestServer(t, &db)

	id, err := urlx.StoreFile(ts.URL, append([]byte{0xC3}, []byte("encrypted-binary-data")...), 3600, true)
	if err != nil {
		t.Fatalf("StoreFile failed: %v", err)
	}
	if id == "" {
		t.Fatal("expected non-empty ID")
	}
}

func TestFetchFile(t *testing.T) {
	db := testDB(map[string]string{})
	ts := newTestServer(t, &db)

	// Upload first (prefix with 0xC3 SKESK tag for OpenPGP validation)
	payload := append([]byte{0xC3}, []byte("encrypted-data")...)
	id, err := urlx.StoreFile(ts.URL, payload, 3600, false)
	if err != nil {
		t.Fatalf("StoreFile failed: %v", err)
	}

	// Download; filename is embedded in OpenPGP metadata and obtained via Decrypt()
	body, err := urlx.FetchFile(ts.URL, id)
	if err != nil {
		t.Fatalf("FetchFile failed: %v", err)
	}
	if string(body) != string(payload) {
		t.Errorf("expected payload back, got %x", body)
	}
}

func TestFetchFileNotFound(t *testing.T) {
	db := testDB(map[string]string{})
	ts := newTestServer(t, &db)

	_, err := urlx.FetchFile(ts.URL, "00000000-0000-0000-0000-000000000000")
	if err == nil {
		t.Fatal("expected error for nonexistent file")
	}
	var serverErr *urlx.ServerError
	if !errors.As(err, &serverErr) {
		t.Fatalf("expected ServerError, got %T: %v", err, err)
	}
	// Test Unwrap
	if serverErr.Unwrap() == nil {
		t.Error("expected non-nil unwrapped error")
	}
}

func TestFetchServerConfig(t *testing.T) {
	for _, argon2 := range []bool{false, true} {
		db := testDB(map[string]string{})
		y := server.Server{
			DB:        &db,
			FileStore: server.NewDatabaseFileStore(&db),
			MaxLength: 10000,
			Registry:  prometheus.NewRegistry(),
			Logger:    zaptest.NewLogger(t),
			Argon2:    argon2,
		}
		ts := useTestServer(t, y.HTTPHandler())

		config, err := urlx.FetchServerConfig(ts.URL)
		if err != nil {
			t.Fatalf("expected no error, got %v", err)
		}
		if config.Argon2 != argon2 {
			t.Errorf("expected Argon2 to be %v, got %v", argon2, config.Argon2)
		}
	}
}

func TestFetchServerConfigError(t *testing.T) {
	_, err := urlx.FetchServerConfig("http://127.0.0.1:1/invalid")
	if err == nil {
		t.Fatal("expected error")
	}
	var serverErr *urlx.ServerError
	if !errors.As(err, &serverErr) {
		t.Fatalf("expected ServerError, got %T", err)
	}
}

func TestTokenAuthHeaders(t *testing.T) {
	const wantAuth = "Bearer test-token"
	ts := useTestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != wantAuth {
			t.Errorf("%s %s: expected Authorization header %q, got %q", r.Method, r.URL.Path, wantAuth, got)
		}
		switch r.URL.Path {
		case "/config":
			_, _ = io.WriteString(w, `{"ARGON2":false}`)
		case "/secret/test-secret":
			_, _ = io.WriteString(w, `{"message":"secret"}`)
		case "/create/secret":
			if _, err := io.ReadAll(r.Body); err != nil {
				t.Errorf("reading body: %v", err)
				http.Error(w, "bad request", http.StatusBadRequest)
				return
			}
			_, _ = io.WriteString(w, `{"message":"test-secret"}`)
		case "/create/file":
			_, _ = io.WriteString(w, `{"message":"test-file"}`)
		case "/file/test-file":
			_, _ = io.WriteString(w, `encrypted-file-data`)
		default:
			t.Errorf("unexpected request path %s", r.URL.Path)
			http.Error(w, "not found", http.StatusNotFound)
		}
	}))
	if _, err := urlx.FetchServerConfigWithToken(ts.URL, "test-token"); err != nil {
		t.Fatalf("FetchServerConfigWithToken failed: %v", err)
	}
	if _, err := urlx.FetchWithToken(ts.URL, "test-secret", "test-token"); err != nil {
		t.Fatalf("FetchWithToken failed: %v", err)
	}
	if _, err := urlx.StoreWithToken(ts.URL, urlx.Secret{Expiration: 3600, Message: "hello"}, "test-token"); err != nil {
		t.Fatalf("StoreWithToken failed: %v", err)
	}
	if _, err := urlx.StoreFileWithToken(ts.URL, []byte("file-data"), 3600, true, "test-token"); err != nil {
		t.Fatalf("StoreFileWithToken failed: %v", err)
	}
	if _, err := urlx.FetchFileWithToken(ts.URL, "test-file", "test-token"); err != nil {
		t.Fatalf("FetchFileWithToken failed: %v", err)
	}
}

func TestTokenNormalization(t *testing.T) {
	tests := []struct {
		name     string
		token    string
		wantAuth string
	}{
		{"raw token", "my-token", "Bearer my-token"},
		{"bearer prefix", "Bearer my-token", "Bearer my-token"},
		{"lowercase bearer", "bearer my-token", "Bearer my-token"},
		{"mixed case bearer", "BEARER my-token", "Bearer my-token"},
		{"extra whitespace after prefix", "Bearer   my-token", "Bearer my-token"},
		{"surrounding whitespace", "  my-token  ", "Bearer my-token"},
		{"empty token", "", ""},
		{"whitespace only", "   ", ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var gotAuth string
			ts := useTestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				gotAuth = r.Header.Get("Authorization")
				_, _ = io.WriteString(w, `{"ARGON2":false}`)
			}))
			_, _ = urlx.FetchServerConfigWithToken(ts.URL, tc.token)
			if gotAuth != tc.wantAuth {
				t.Errorf("token %q: got Authorization %q, want %q", tc.token, gotAuth, tc.wantAuth)
			}
		})
	}
}

func TestStoreFileServerError(t *testing.T) {
	_, err := urlx.StoreFile("http://127.0.0.1:1/invalid", []byte("data"), 3600, true)
	if err == nil {
		t.Fatal("expected error")
	}
	var serverErr *urlx.ServerError
	if !errors.As(err, &serverErr) {
		t.Fatalf("expected ServerError, got %T", err)
	}
}

func TestFetchFileServerError(t *testing.T) {
	_, err := urlx.FetchFile("http://127.0.0.1:1/invalid", "test-id")
	if err == nil {
		t.Fatal("expected error")
	}
	var serverErr *urlx.ServerError
	if !errors.As(err, &serverErr) {
		t.Fatalf("expected ServerError, got %T", err)
	}
}

func (db *testDB) GetAuthorized(key string, authorize func(urlx.Secret) error) (urlx.Secret, error) {
	s, err := db.Status(key)
	if err != nil {
		return urlx.Secret{}, err
	}
	if err := authorize(s); err != nil {
		return urlx.Secret{}, err
	}
	return db.Get(key)
}

func (db *testDB) DeleteAuthorized(key string, authorize func(urlx.Secret) error) (bool, error) {
	s, err := db.Status(key)
	if err != nil {
		return false, err
	}
	if err := authorize(s); err != nil {
		return false, err
	}
	return db.Delete(key)
}
