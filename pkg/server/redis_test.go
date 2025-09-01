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

func TestRedisUnits(t *testing.T) {
	t.Run("NewRedis with invalid URL", func(t *testing.T) {
		_, err := NewRedis("invalid-url")
		if err == nil {
			t.Fatal("Expected error for invalid Redis URL")
		}
	})

	t.Run("NewRedis with valid URL", func(t *testing.T) {
		db, err := NewRedis("redis://localhost:6379/0")
		if err != nil {
			t.Fatalf("Expected no error for valid Redis URL, got: %v", err)
		}
		r, ok := db.(*Redis)
		if !ok {
			t.Fatal("NewRedis should return *Redis")
		}
		if r.client == nil {
			t.Fatal("Client should be initialized")
		}
	})
}

func TestRedisStatus(t *testing.T) {
	redisURL := os.Getenv("REDIS_URL")
	if redisURL == "" {
		t.Skip("Specify REDIS_URL env variable to test Redis database")
	}

	r, err := NewRedis(redisURL)
	if err != nil {
		t.Fatalf("error in NewRedis(): %v", err)
	}

	t.Run("Status returns correct OneTime value for existing secret", func(t *testing.T) {
		key := "test-status-onetime"
		secret := yopass.Secret{Message: "test message", OneTime: true, Expiration: 3600}

		// Put the secret
		err := r.Put(key, secret)
		if err != nil {
			t.Fatalf("error in Put(): %v", err)
		}

		// Check status
		oneTime, err := r.Status(key)
		if err != nil {
			t.Fatalf("error in Status(): %v", err)
		}

		if oneTime != true {
			t.Fatalf("expected OneTime to be true, got %v", oneTime)
		}

		// Clean up
		r.Delete(key)
	})

	t.Run("Status returns correct OneTime value for non-onetime secret", func(t *testing.T) {
		key := "test-status-multi"
		secret := yopass.Secret{Message: "test message", OneTime: false, Expiration: 3600}

		// Put the secret
		err := r.Put(key, secret)
		if err != nil {
			t.Fatalf("error in Put(): %v", err)
		}

		// Check status
		oneTime, err := r.Status(key)
		if err != nil {
			t.Fatalf("error in Status(): %v", err)
		}

		if oneTime != false {
			t.Fatalf("expected OneTime to be false, got %v", oneTime)
		}

		// Clean up
		r.Delete(key)
	})

	t.Run("Status returns error for non-existent key", func(t *testing.T) {
		key := "non-existent-key"

		// Check status for non-existent key
		_, err := r.Status(key)
		if err == nil {
			t.Fatal("expected error for non-existent key")
		}

		// Should return redis.Nil
		if err.Error() != "redis: nil" {
			t.Fatalf("expected redis nil error, got: %v", err)
		}
	})

	t.Run("Status works after secret is deleted by Get (OneTime)", func(t *testing.T) {
		key := "test-status-deleted"
		secret := yopass.Secret{Message: "test message", OneTime: true, Expiration: 3600}

		// Put the secret
		err := r.Put(key, secret)
		if err != nil {
			t.Fatalf("error in Put(): %v", err)
		}

		// Verify status before Get
		oneTime, err := r.Status(key)
		if err != nil {
			t.Fatalf("error in Status(): %v", err)
		}
		if oneTime != true {
			t.Fatalf("expected OneTime to be true, got %v", oneTime)
		}

		// Get the secret (should delete it since OneTime=true)
		_, err = r.Get(key)
		if err != nil {
			t.Fatalf("error in Get(): %v", err)
		}

		// Status should now return error since secret was deleted
		_, err = r.Status(key)
		if err == nil {
			t.Fatal("expected error for deleted secret")
		}
	})

	t.Run("Status preserves secret for non-onetime access", func(t *testing.T) {
		key := "test-status-preserved"
		secret := yopass.Secret{Message: "test message", OneTime: false, Expiration: 3600}

		// Put the secret
		err := r.Put(key, secret)
		if err != nil {
			t.Fatalf("error in Put(): %v", err)
		}

		// Check status multiple times
		for i := 0; i < 3; i++ {
			oneTime, err := r.Status(key)
			if err != nil {
				t.Fatalf("error in Status() on iteration %d: %v", i, err)
			}
			if oneTime != false {
				t.Fatalf("expected OneTime to be false on iteration %d, got %v", i, oneTime)
			}
		}

		// Clean up
		r.Delete(key)
	})

	t.Run("Status handles malformed JSON data", func(t *testing.T) {
		// This test directly puts malformed data to test error handling
		redisClient := r.(*Redis).client
		key := "test-status-malformed"

		// Put malformed JSON directly
		err := redisClient.Set(key, "invalid-json", 0).Err()
		if err != nil {
			t.Fatalf("error setting malformed data: %v", err)
		}

		// Status should return JSON unmarshal error
		_, err = r.Status(key)
		if err == nil {
			t.Fatal("expected error for malformed JSON")
		}

		// Clean up
		r.Delete(key)
	})
}
