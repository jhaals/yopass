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
		MaxLength:           1024,
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
	msg := "test secret message"
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

	msg := "--- ciphertext ---"
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
