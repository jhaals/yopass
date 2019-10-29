package yopass

import (
	"os"
	"testing"
)

func TestMemcached(t *testing.T) {
	redisURL := os.Getenv("MEMCACHED")
	if redisURL == "" {
		t.Skip("Specify MEMCACHED env variable to test memcached database")
	}

	m := NewMemcached(redisURL)

	key := "f9fa5704-3ed2-4e60-b441-c426d3f9f3c1"
	val := "my value"

	err := m.Put(key, val, 123)
	if err != nil {
		t.Fatalf("error in Put(): %v", err)
	}

	storedVal, err := m.Get(key)
	if err != nil {
		t.Fatalf("error in Get(): %v", err)
	}

	if storedVal != val {
		t.Fatalf("expected value %s, got %s", val, storedVal)
	}

	err = m.Delete(key)
	if err != nil {
		t.Fatalf("error in Delete(): %v", err)
	}

	_, err = m.Get(key)
	if err == nil {
		t.Fatal("expected error from Get() after Delete()")
	}
}
