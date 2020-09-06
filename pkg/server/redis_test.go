package server

import (
	"os"
	"testing"

	"github.com/jhaals/yopass/pkg/yopass"
)

func TestRedis(t *testing.T) {
	redisURL := os.Getenv("REDIS_URL")
	if redisURL == "" {
		t.Skip("Specify REDIS_URL env variable to test Redis database")
	}

	r, err := NewRedis(redisURL)
	if err != nil {
		t.Fatalf("error in NewRedis(): %v", err)
	}

	key := "f9fa5704-3ed2-4e60-b441-c426d3f9f3c1"
	secret := yopass.Secret{Message: "foo", OneTime: true}

	err = r.Put(key, secret)
	if err != nil {
		t.Fatalf("error in Put(): %v", err)
	}

	storedVal, err := r.Get(key)
	if err != nil {
		t.Fatalf("error in Get(): %v", err)
	}

	if storedVal.Message != secret.Message {
		t.Fatalf("expected value %s, got %s", secret.Message, storedVal.Message)
	}

	_, err = r.Get(key)
	if err == nil {
		t.Fatal("expected error from Get() after Delete()")
	}
}
