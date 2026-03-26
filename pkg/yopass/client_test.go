package yopass_test

import (
	"errors"
	"fmt"
	"net/http/httptest"
	"testing"

	"go.uber.org/zap/zaptest"

	"github.com/jhaals/yopass/pkg/server"
	"github.com/jhaals/yopass/pkg/yopass"
	"github.com/prometheus/client_golang/prometheus"
)

func newTestServer(t *testing.T, db server.Database) (*httptest.Server, func()) {
	y := server.Server{
		DB:                  db,
		FileStore:           server.NewDatabaseFileStore(db),
		MaxLength:           10000,
		MaxFileSize:         10 * 1024 * 1024,
		Registry:            prometheus.NewRegistry(),
		ForceOneTimeSecrets: false,
		Logger:              zaptest.NewLogger(t),
	}
	ts := httptest.NewServer(y.HTTPHandler())
	return ts, func() { ts.Close() }
}

func TestFetch(t *testing.T) {
	db := testDB(map[string]string{})
	ts, cleanup := newTestServer(t, &db)
	defer cleanup()

	key := "4b9502b0-112a-40f5-a872-956250e81f6c"
	msg := `-----BEGIN PGP MESSAGE-----
Version: OpenPGP.js v4.10.8
Comment: https://openpgpjs.org

wy4ECQMIRthQ3aO85NvgAfASIX3dTwsFVt0gshPu7n1tN05e8rpqxOk6PYNm
xtt90k4BqHuTCLNlFRJjuiuE8zdIc+j5zTN5zihxUReVqokeqULLOx2FBMHZ
sbfqaG/iDbp+qDOc98IagMyPrEqKDxnhVVOraXy5dD9RDsntLso=
=0vwU
-----END PGP MESSAGE-----`
	if err := db.Put(key, yopass.Secret{Message: msg}); err != nil {
		t.Fatal(err)
	}

	got, err := yopass.Fetch(ts.URL, key)
	if err != nil {
		t.Fatal(err)
	}
	if msg != got {
		t.Errorf("expected fetched message to be %q, got %q", msg, got)
	}

	_, err = yopass.Fetch(ts.URL, "4b9502b0-112a-40f5-a872-000000000000")
	if want := new(yopass.ServerError); !errors.As(err, &want) {
		t.Errorf("expected a ServerError, got %v", err)
	}
}

func TestFetchInvalidServer(t *testing.T) {
	_, err := yopass.Fetch("127.0.0.1:9999/invalid", "1337")
	if err == nil {
		t.Error("expected error, got none")
	}
}

func TestStore(t *testing.T) {
	db := testDB(map[string]string{})
	ts, cleanup := newTestServer(t, &db)
	defer cleanup()

	msg := `-----BEGIN PGP MESSAGE-----
Version: OpenPGP.js v4.10.8
Comment: https://openpgpjs.org

wy4ECQMIRthQ3aO85NvgAfASIX3dTwsFVt0gshPu7n1tN05e8rpqxOk6PYNm
xtt90k4BqHuTCLNlFRJjuiuE8zdIc+j5zTN5zihxUReVqokeqULLOx2FBMHZ
sbfqaG/iDbp+qDOc98IagMyPrEqKDxnhVVOraXy5dD9RDsntLso=
=0vwU
-----END PGP MESSAGE-----`
	id, err := yopass.Store(ts.URL, yopass.Secret{Expiration: 3600, Message: msg})
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

func (db *testDB) Get(key string) (yopass.Secret, error) {
	msg, ok := (map[string]string(*db))[key]
	if !ok {
		return yopass.Secret{}, fmt.Errorf("secret not found")
	}
	return yopass.Secret{Message: msg}, nil
}

func (db *testDB) Put(key string, secret yopass.Secret) error {
	(map[string]string(*db))[key] = secret.Message
	return nil
}

func (db *testDB) Delete(key string) (bool, error) {
	delete((map[string]string(*db)), key)
	return true, nil
}

func (db *testDB) Status(key string) (bool, error) {
	return false, nil
}

func (db *testDB) Health() error {
	return nil
}

func TestServerError(t *testing.T) {
	_, storeErr := yopass.StoreFile("http://127.0.0.1:1/invalid", []byte("x"), 3600, true, "f")
	var se *yopass.ServerError
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
	ts, cleanup := newTestServer(t, &db)
	defer cleanup()

	id, err := yopass.StoreFile(ts.URL, []byte("encrypted-binary-data"), 3600, true, "secret.bin")
	if err != nil {
		t.Fatalf("StoreFile failed: %v", err)
	}
	if id == "" {
		t.Fatal("expected non-empty ID")
	}
}

func TestFetchFile(t *testing.T) {
	db := testDB(map[string]string{})
	ts, cleanup := newTestServer(t, &db)
	defer cleanup()

	// Upload first
	id, err := yopass.StoreFile(ts.URL, []byte("encrypted-data"), 3600, false, "test.txt")
	if err != nil {
		t.Fatalf("StoreFile failed: %v", err)
	}

	// Download
	body, filename, err := yopass.FetchFile(ts.URL, id)
	if err != nil {
		t.Fatalf("FetchFile failed: %v", err)
	}
	if string(body) != "encrypted-data" {
		t.Errorf("expected encrypted-data, got %s", string(body))
	}
	if filename != "test.txt" {
		t.Errorf("expected test.txt, got %s", filename)
	}
}

func TestFetchFileNotFound(t *testing.T) {
	db := testDB(map[string]string{})
	ts, cleanup := newTestServer(t, &db)
	defer cleanup()

	_, _, err := yopass.FetchFile(ts.URL, "00000000-0000-0000-0000-000000000000")
	if err == nil {
		t.Fatal("expected error for nonexistent file")
	}
	var serverErr *yopass.ServerError
	if !errors.As(err, &serverErr) {
		t.Fatalf("expected ServerError, got %T: %v", err, err)
	}
	// Test Unwrap
	if serverErr.Unwrap() == nil {
		t.Error("expected non-nil unwrapped error")
	}
}

func TestStoreFileServerError(t *testing.T) {
	_, err := yopass.StoreFile("http://127.0.0.1:1/invalid", []byte("data"), 3600, true, "test.bin")
	if err == nil {
		t.Fatal("expected error")
	}
	var serverErr *yopass.ServerError
	if !errors.As(err, &serverErr) {
		t.Fatalf("expected ServerError, got %T", err)
	}
}

func TestFetchFileServerError(t *testing.T) {
	_, _, err := yopass.FetchFile("http://127.0.0.1:1/invalid", "test-id")
	if err == nil {
		t.Fatal("expected error")
	}
	var serverErr *yopass.ServerError
	if !errors.As(err, &serverErr) {
		t.Fatalf("expected ServerError, got %T", err)
	}
}
