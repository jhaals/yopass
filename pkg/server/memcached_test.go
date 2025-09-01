package server

import (
	"os"
	"testing"

	"github.com/bradfitz/gomemcache/memcache"
	"github.com/jhaals/yopass/pkg/yopass"
)

func TestMemcached(t *testing.T) {
	redisURL := os.Getenv("MEMCACHED")
	if redisURL == "" {
		t.Skip("Specify MEMCACHED env variable to test memcached database")
	}

	m := NewMemcached(redisURL)

	key := "f9fa5704-3ed2-4e60-b441-c426d3f9f3c1"
	secret := yopass.Secret{Message: "foo", OneTime: true}

	err := m.Put(key, secret)
	if err != nil {
		t.Fatalf("error in Put(): %v", err)
	}

	storedSecret, err := m.Get(key)
	if err != nil {
		t.Fatalf("error in Get(): %v", err)
	}

	if storedSecret.Message != secret.Message {
		t.Fatalf("expected value %s, got %s", secret.Message, storedSecret.Message)
	}

	_, err = m.Get(key)
	if err == nil {
		t.Fatal("expected error from Get() after Delete()")
	}
}

func TestMemcachedUnits(t *testing.T) {
	t.Run("NewMemcached creates correct instance", func(t *testing.T) {
		db := NewMemcached("localhost:11211")
		m, ok := db.(*Memcached)
		if !ok {
			t.Fatal("NewMemcached should return *Memcached")
		}
		if m.Client == nil {
			t.Fatal("Client should be initialized")
		}
	})
}

func TestMemcachedStatus(t *testing.T) {
	memcachedURL := os.Getenv("MEMCACHED")
	if memcachedURL == "" {
		t.Skip("Specify MEMCACHED env variable to test memcached database")
	}

	m := NewMemcached(memcachedURL)

	t.Run("Status returns correct OneTime value for existing secret", func(t *testing.T) {
		key := "test-status-onetime"
		secret := yopass.Secret{Message: "test message", OneTime: true, Expiration: 3600}

		// Put the secret
		err := m.Put(key, secret)
		if err != nil {
			t.Fatalf("error in Put(): %v", err)
		}

		// Check status
		oneTime, err := m.Status(key)
		if err != nil {
			t.Fatalf("error in Status(): %v", err)
		}

		if oneTime != true {
			t.Fatalf("expected OneTime to be true, got %v", oneTime)
		}

		// Clean up
		m.Delete(key)
	})

	t.Run("Status returns correct OneTime value for non-onetime secret", func(t *testing.T) {
		key := "test-status-multi"
		secret := yopass.Secret{Message: "test message", OneTime: false, Expiration: 3600}

		// Put the secret
		err := m.Put(key, secret)
		if err != nil {
			t.Fatalf("error in Put(): %v", err)
		}

		// Check status
		oneTime, err := m.Status(key)
		if err != nil {
			t.Fatalf("error in Status(): %v", err)
		}

		if oneTime != false {
			t.Fatalf("expected OneTime to be false, got %v", oneTime)
		}

		// Clean up
		m.Delete(key)
	})

	t.Run("Status returns error for non-existent key", func(t *testing.T) {
		key := "non-existent-key"

		// Check status for non-existent key
		_, err := m.Status(key)
		if err == nil {
			t.Fatal("expected error for non-existent key")
		}

		// Should return memcache.ErrCacheMiss
		if err.Error() != "memcache: cache miss" {
			t.Fatalf("expected cache miss error, got: %v", err)
		}
	})

	t.Run("Status works after secret is deleted by Get (OneTime)", func(t *testing.T) {
		key := "test-status-deleted"
		secret := yopass.Secret{Message: "test message", OneTime: true, Expiration: 3600}

		// Put the secret
		err := m.Put(key, secret)
		if err != nil {
			t.Fatalf("error in Put(): %v", err)
		}

		// Verify status before Get
		oneTime, err := m.Status(key)
		if err != nil {
			t.Fatalf("error in Status(): %v", err)
		}
		if oneTime != true {
			t.Fatalf("expected OneTime to be true, got %v", oneTime)
		}

		// Get the secret (should delete it since OneTime=true)
		_, err = m.Get(key)
		if err != nil {
			t.Fatalf("error in Get(): %v", err)
		}

		// Status should now return error since secret was deleted
		_, err = m.Status(key)
		if err == nil {
			t.Fatal("expected error for deleted secret")
		}
	})

	t.Run("Status preserves secret for non-onetime access", func(t *testing.T) {
		key := "test-status-preserved"
		secret := yopass.Secret{Message: "test message", OneTime: false, Expiration: 3600}

		// Put the secret
		err := m.Put(key, secret)
		if err != nil {
			t.Fatalf("error in Put(): %v", err)
		}

		// Check status multiple times
		for i := 0; i < 3; i++ {
			oneTime, err := m.Status(key)
			if err != nil {
				t.Fatalf("error in Status() on iteration %d: %v", i, err)
			}
			if oneTime != false {
				t.Fatalf("expected OneTime to be false on iteration %d, got %v", i, oneTime)
			}
		}

		// Clean up
		m.Delete(key)
	})

	t.Run("Status handles malformed JSON data", func(t *testing.T) {
		// This test directly puts malformed data to test error handling
		memcachedClient := m.(*Memcached).Client
		key := "test-status-malformed"

		// Put malformed JSON directly using memcache client
		item := &memcache.Item{
			Key:        key,
			Value:      []byte("invalid-json"),
			Expiration: 3600,
		}
		err := memcachedClient.Set(item)
		if err != nil {
			t.Fatalf("error setting malformed data: %v", err)
		}

		// Status should return JSON unmarshal error
		_, err = m.Status(key)
		if err == nil {
			t.Fatal("expected error for malformed JSON")
		}

		// Clean up
		m.Delete(key)
	})
}
