package server

import (
	"context"
	"errors"
	"net"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jhaals/yopass/pkg/yopass"
	"github.com/redis/go-redis/v9"
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
		r, err := NewRedis("redis://localhost:6379/0")
		if err != nil {
			t.Fatalf("Expected no error for valid Redis URL, got: %v", err)
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
		s, err := r.Status(key)
		if err != nil {
			t.Fatalf("error in Status(): %v", err)
		}

		if s.OneTime != true {
			t.Fatalf("expected OneTime to be true, got %v", s.OneTime)
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
		s, err := r.Status(key)
		if err != nil {
			t.Fatalf("error in Status(): %v", err)
		}

		if s.OneTime != false {
			t.Fatalf("expected OneTime to be false, got %v", s.OneTime)
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

		// Missing keys use the shared database contract.
		if !errors.Is(err, ErrKeyNotFound) {
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
		s, err := r.Status(key)
		if err != nil {
			t.Fatalf("error in Status(): %v", err)
		}
		if s.OneTime != true {
			t.Fatalf("expected OneTime to be true, got %v", s.OneTime)
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
			s, err := r.Status(key)
			if err != nil {
				t.Fatalf("error in Status() on iteration %d: %v", i, err)
			}
			if s.OneTime != false {
				t.Fatalf("expected OneTime to be false on iteration %d, got %v", i, s.OneTime)
			}
		}

		// Clean up
		r.Delete(key)
	})

	t.Run("Status handles malformed JSON data", func(t *testing.T) {
		// This test directly puts malformed data to test error handling
		redisClient := r.client
		key := "test-status-malformed"

		// Put malformed JSON directly
		err := redisClient.Set(context.Background(), key, "invalid-json", 0).Err()
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

func TestRedisHealth(t *testing.T) {
	redisURL := os.Getenv("REDIS_URL")
	if redisURL == "" {
		t.Skip("Specify REDIS_URL env variable to test Redis database")
	}

	r, err := NewRedis(redisURL)
	if err != nil {
		t.Fatalf("error in NewRedis(): %v", err)
	}

	t.Run("Health returns nil when Redis is available", func(t *testing.T) {
		err := r.Health()
		if err != nil {
			t.Fatalf("expected Health() to succeed, got error: %v", err)
		}
	})

	t.Run("Health returns error when Redis is unavailable", func(t *testing.T) {
		badRedis, err := NewRedis("redis://invalid-host:9999/0")
		if err != nil {
			t.Fatalf("error creating Redis client: %v", err)
		}

		err = badRedis.Health()
		if err == nil {
			t.Fatal("expected Health() to fail with invalid Redis connection")
		}
	})
}

func TestRedisUpdate(t *testing.T) {
	redisURL := os.Getenv("REDIS_URL")
	if redisURL == "" {
		t.Skip("Specify REDIS_URL env variable to test Redis database")
	}

	r, err := NewRedis(redisURL)
	if err != nil {
		t.Fatalf("error in NewRedis(): %v", err)
	}

	key := "update-test-" + t.Name()
	defer func() { _, _ = r.Delete(key) }()

	// Update of a missing key reports ErrKeyNotFound
	if err := r.Update(key, func(s yopass.Secret) (yopass.Secret, error) {
		return s, nil
	}); err != ErrKeyNotFound {
		t.Fatalf("expected ErrKeyNotFound, got %v", err)
	}

	if err := r.Put(key, yopass.Secret{Message: "0", Expiration: 3600}); err != nil {
		t.Fatalf("error in Put(): %v", err)
	}

	// An error returned by fn aborts the update without writing
	abort := errors.New("abort")
	if err := r.Update(key, func(s yopass.Secret) (yopass.Secret, error) {
		s.Message = "must not be stored"
		return s, abort
	}); err != abort {
		t.Fatalf("expected abort error, got %v", err)
	}
	if s, err := r.Status(key); err != nil || s.Message != "0" {
		t.Fatalf("aborted update must not write: %v %v", s, err)
	}

	// Concurrent increments must all land exactly once
	const writers = 10
	var wg sync.WaitGroup
	for i := 0; i < writers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				err := r.Update(key, func(s yopass.Secret) (yopass.Secret, error) {
					n, err := strconv.Atoi(s.Message)
					if err != nil {
						return s, err
					}
					s.Message = strconv.Itoa(n + 1)
					return s, nil
				})
				if err == nil {
					return
				}
				// Retries are bounded per Update call; loop until this
				// writer's increment lands.
			}
		}()
	}
	wg.Wait()

	s, err := r.Status(key)
	if err != nil {
		t.Fatalf("error in Status(): %v", err)
	}
	if s.Message != strconv.Itoa(writers) {
		t.Fatalf("lost updates: expected %d, got %s", writers, s.Message)
	}
}

// setDelayingConn counts the SETs written to Redis and keeps the first one
// from arriving, as a network outage would, so that its reply never comes.
type setDelayingConn struct {
	net.Conn
	sets *atomic.Int32
}

func (c *setDelayingConn) Write(b []byte) (int, error) {
	if strings.Contains(string(b), "\r\nset\r\n") && c.sets.Add(1) == 1 {
		return len(b), nil
	}
	return c.Conn.Write(b)
}

func TestRedisPutIsNotSentAgainWhenReplyIsLate(t *testing.T) {
	redisURL := os.Getenv("REDIS_URL")
	if redisURL == "" {
		t.Skip("Specify REDIS_URL env variable to test Redis database")
	}

	options, err := redis.ParseURL(redisURL)
	if err != nil {
		t.Fatalf("error in ParseURL(): %v", err)
	}
	var sets atomic.Int32
	options.ReadTimeout = 100 * time.Millisecond
	dial := redis.NewDialer(options)
	options.Dialer = func(ctx context.Context, network, addr string) (net.Conn, error) {
		conn, err := dial(ctx, network, addr)
		if err != nil {
			return nil, err
		}
		return &setDelayingConn{Conn: conn, sets: &sets}, nil
	}
	r := &Redis{redis.NewClient(options)}
	defer r.client.Close()

	key := "put-retry-test-" + t.Name()
	defer func() { _, _ = r.Delete(key) }()

	// A SET whose reply is lost must not be written a second time: the first
	// copy can still arrive after the key was handed out and claimed.
	if err := r.Put(key, yopass.Secret{Message: "foo", OneTime: true, Expiration: 60}); err == nil {
		t.Error("Put() succeeded while its first SET can still arrive")
	}
	if n := sets.Load(); n != 1 {
		t.Errorf("SET was sent %d times, want 1", n)
	}
}

func TestRedisURLCredentialsNotInErrors(t *testing.T) {
	for _, password := range []string{"hunter2%", "hunter2/x", "hunter2?x", "1/hunter2", "1?hunter2"} {
		_, err := NewRedis("redis://:" + password + "@localhost:6379/0")
		if err == nil {
			t.Fatalf("expected malformed URL error")
		}
		if strings.Contains(err.Error(), "hunter2") {
			t.Fatal("credential leaked in error")
		}
	}
}
