package server

import (
	"context"
	"os"
	"testing"

	"github.com/3lvia/onetime-yopass/pkg/yopass"
)

func TestMemcached(t *testing.T) {
	redisURL := os.Getenv("MEMCACHED")
	if redisURL == "" {
		t.Skip("Specify MEMCACHED env variable to test memcached database")
	}

	m := NewMemcached(redisURL)

	key := "f9fa5704-3ed2-4e60-b441-c426d3f9f3c1"
	secret := yopass.Secret{Message: "foo", OneTime: true}

	backgroundContext := context.Background()
	err := m.Put(backgroundContext, key, secret)
	if err != nil {
		t.Fatalf("error in Put(): %v", err)
	}

	storedSecret, err := m.Get(backgroundContext, key)
	if err != nil {
		t.Fatalf("error in Get(): %v", err)
	}

	if storedSecret.Message != secret.Message {
		t.Fatalf("expected value %s, got %s", secret.Message, storedSecret.Message)
	}

	_, err = m.Get(backgroundContext, key)
	if err == nil {
		t.Fatal("expected error from Get() after Delete()")
	}
}
