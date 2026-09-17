package server

import (
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
