package server

import (
	"context"
	"errors"
	"os"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/jhaals/yopass/pkg/yopass"
)

func TestDatabaseOneTimeClaim(t *testing.T) {
	backends := map[string]func(*testing.T) Database{
		"redis": func(t *testing.T) Database {
			address := os.Getenv("REDIS_URL")
			if address == "" {
				t.Skip("Specify REDIS_URL to test Redis")
			}
			db, err := NewRedis(address)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { db.client.Close() })
			return db
		},
		"memcached": func(t *testing.T) Database {
			address := os.Getenv("MEMCACHED")
			if address == "" {
				t.Skip("Specify MEMCACHED to test Memcached")
			}
			db := NewMemcached(address)
			t.Cleanup(func() { db.Client.Close() })
			return db
		},
	}
	for name, open := range backends {
		t.Run(name, func(t *testing.T) {
			db := open(t)
			for attempt := 0; attempt < 10; attempt++ {
				key, err := yopass.GenerateID()
				if err != nil {
					t.Fatal(err)
				}
				if err := db.Put(key, yopass.Secret{Message: "encrypted", OneTime: true, Expiration: 60}); err != nil {
					t.Fatal(err)
				}
				var successes atomic.Int32
				var wg sync.WaitGroup
				start := make(chan struct{})
				for i := 0; i < 20; i++ {
					wg.Go(func() {
						<-start
						secret, err := db.Get(key)
						if err == nil {
							successes.Add(1)
							if secret.Message != "encrypted" {
								t.Errorf("unexpected secret: %+v", secret)
							}
						} else if !errors.Is(err, ErrKeyNotFound) {
							t.Errorf("unexpected claim error: %v", err)
						} else if secret.Message != "" {
							t.Error("failed claim returned secret content")
						}
					})
				}
				close(start)
				wg.Wait()
				if got := successes.Load(); got != 1 {
					t.Fatalf("got %d successful claims, want 1", got)
				}
				if _, err := db.Status(key); !errors.Is(err, ErrKeyNotFound) {
					t.Fatalf("Status after claim: %v", err)
				}
			}
		})
	}
}

// Capture the exact version read by a downloader, then replace it before its
// claim. These schedules must never consume the replacement or return stale data.
func TestDatabaseClaimRejectsReplacedValue(t *testing.T) {
	for _, backend := range []string{"redis", "memcached"} {
		for _, operation := range []string{"put", "update", "delete"} {
			t.Run(backend+"/"+operation, func(t *testing.T) {
				var db Database
				var snapshot func(string) func() error
				if backend == "redis" {
					if os.Getenv("REDIS_URL") == "" {
						t.Skip("Specify REDIS_URL to test Redis")
					}
					r, err := NewRedis(os.Getenv("REDIS_URL"))
					if err != nil {
						t.Fatal(err)
					}
					t.Cleanup(func() { r.client.Close() })
					db = r
					snapshot = func(key string) func() error {
						value, err := r.client.Get(context.Background(), key).Result()
						if err != nil {
							t.Fatal(err)
						}
						return func() error { return r.claim(key, value) }
					}
				} else {
					if os.Getenv("MEMCACHED") == "" {
						t.Skip("Specify MEMCACHED to test Memcached")
					}
					m := NewMemcached(os.Getenv("MEMCACHED"))
					t.Cleanup(func() { m.Client.Close() })
					db = m
					snapshot = func(key string) func() error {
						item, err := m.Client.Get(key)
						if err != nil {
							t.Fatal(err)
						}
						return func() error { return m.claim(item) }
					}
				}
				key, err := yopass.GenerateID()
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { db.Delete(key) })
				original := yopass.Secret{Message: "original", OneTime: true, Expiration: 60}
				if err := db.Put(key, original); err != nil {
					t.Fatal(err)
				}
				claim := snapshot(key)
				replacement := yopass.Secret{Message: "replacement", OneTime: false, Expiration: 60}
				switch operation {
				case "put":
					err = db.Put(key, replacement)
				case "update":
					err = db.Update(key, func(yopass.Secret) (yopass.Secret, error) { return replacement, nil })
				case "delete":
					_, err = db.Delete(key)
				}
				if err != nil {
					t.Fatal(err)
				}
				if err := claim(); !errors.Is(err, ErrKeyNotFound) {
					t.Fatalf("stale claim: %v", err)
				}
				if operation != "delete" {
					for i := 0; i < 2; i++ {
						got, err := db.Get(key)
						if err != nil || got.Message != replacement.Message || got.OneTime {
							t.Fatalf("replacement changed: %+v, %v", got, err)
						}
					}
				}
			})
		}
	}
}
