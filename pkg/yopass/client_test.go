package yopass_test

import (
	"context"
	"errors"
	"fmt"
	"net/http/httptest"
	"testing"

	"github.com/3lvia/onetime-yopass/pkg/server"
	"github.com/3lvia/onetime-yopass/pkg/yopass"
	"github.com/prometheus/client_golang/prometheus"
)

func TestFetch(t *testing.T) {
	db := testDB(map[string]string{})
	y := server.New(&db, 1024, prometheus.NewRegistry(), false)
	ts := httptest.NewServer(y.HTTPHandler())
	defer ts.Close()

	key := "4b9502b0-112a-40f5-a872-956250e81f6c"
	msg := "test secret message"
	if err := db.Put(context.Background(), key, yopass.Secret{Message: msg}); err != nil {
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
func ToDoFixTestStore(t *testing.T) {
	db := testDB(map[string]string{})
	y := server.New(&db, 1024, prometheus.NewRegistry(), false)
	ts := httptest.NewServer(y.HTTPHandler())
	defer ts.Close()

	//TODO: Fix test without ElvID access token.
	// msg := "--- ciphertext ---"
	// id, err := yopass.Store(ts.URL, yopass.Secret{Expiration: 3600, Message: msg})
	// if err != nil {
	// 	t.Fatal(err)
	// }

	// got, err := db.Get(context.Background(), id)
	// if err != nil {
	// 	t.Fatal(err)
	// }
	// if msg != got.Message {
	// 	t.Errorf("expected stored message to be %q, got %q", msg, got.Message)
	// }
}

type testDB map[string]string

func (db *testDB) Get(context context.Context, key string) (yopass.Secret, error) {
	msg, ok := (map[string]string(*db))[key]
	if !ok {
		return yopass.Secret{}, fmt.Errorf("secret not found")
	}
	return yopass.Secret{Message: msg}, nil
}

func (db *testDB) Put(context context.Context, key string, secret yopass.Secret) error {
	(map[string]string(*db))[key] = secret.Message
	return nil
}

func (db *testDB) Delete(context context.Context, key string) error {
	delete((map[string]string(*db)), key)
	return nil
}
