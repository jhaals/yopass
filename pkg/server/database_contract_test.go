package server

import (
	"errors"
	"fmt"
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

func openContractDatabase(t *testing.T, backend string) Database {
	t.Helper()
	if backend == "redis" {
		if os.Getenv("REDIS_URL") == "" {
			t.Skip("Specify REDIS_URL to test Redis")
		}
		db, err := NewRedis(os.Getenv("REDIS_URL"))
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { db.client.Close() })
		return db
	}
	if os.Getenv("MEMCACHED") == "" {
		t.Skip("Specify MEMCACHED to test Memcached")
	}
	db := NewMemcached(os.Getenv("MEMCACHED"))
	t.Cleanup(func() { db.Client.Close() })
	return db
}

func TestDatabaseClaimRejectsReplacedValue(t *testing.T) {
	for _, backend := range []string{"redis", "memcached"} {
		for _, operation := range []string{"put", "update", "delete", "identical-put", "identical-update", "delete-recreate"} {
			t.Run(backend+"/"+operation, func(t *testing.T) {
				db := openContractDatabase(t, backend)
				key, err := yopass.GenerateID()
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { db.Delete(key) })
				original := yopass.Secret{Message: "original", OneTime: true, Expiration: 60}
				if err := db.Put(key, original); err != nil {
					t.Fatal(err)
				}
				replacement := yopass.Secret{Message: "replacement", OneTime: false, RequireAuth: true, Expiration: 60}
				if operation == "identical-put" || operation == "identical-update" || operation == "delete-recreate" {
					replacement = original
				}
				calls := 0
				got, err := db.GetAuthorized(key, func(s yopass.Secret) error {
					calls++
					if s != original {
						t.Fatalf("authorized wrong snapshot: %+v", s)
					}
					switch operation {
					case "put", "identical-put":
						return db.Put(key, replacement)
					case "update", "identical-update":
						return db.Update(key, func(yopass.Secret) (yopass.Secret, error) { return replacement, nil })
					case "delete":
						_, err := db.Delete(key)
						return err
					case "delete-recreate":
						if _, err := db.Delete(key); err != nil {
							return err
						}
						return db.Put(key, replacement)
					}
					return nil
				})
				if calls != 1 {
					t.Fatalf("authorization called %d times", calls)
				}
				if !errors.Is(err, ErrKeyNotFound) || got != (yopass.Secret{}) {
					t.Fatalf("stale claim returned %+v, %v", got, err)
				}
				if operation != "delete" {
					got, err := db.Status(key)
					if err != nil || got != replacement {
						t.Fatalf("replacement changed: %+v, %v", got, err)
					}
				}
			})
		}
		t.Run(backend+"/denied", func(t *testing.T) {
			db := openContractDatabase(t, backend)
			key, _ := yopass.GenerateID()
			t.Cleanup(func() { db.Delete(key) })
			original := yopass.Secret{Message: "protected", OneTime: true, RequireAuth: true, Expiration: 60}
			if err := db.Put(key, original); err != nil {
				t.Fatal(err)
			}
			denied := errors.New("denied")
			got, err := db.GetAuthorized(key, func(yopass.Secret) error { return denied })
			if !errors.Is(err, denied) || got != (yopass.Secret{}) {
				t.Fatalf("denied retrieval: %+v, %v", got, err)
			}
			got, err = db.Status(key)
			if err != nil || got != original {
				t.Fatalf("denied retrieval consumed value: %+v, %v", got, err)
			}
		})
	}
}

func TestDatabaseAuthorizedDelete(t *testing.T) {
	for _, backend := range []string{"redis", "memcached"} {
		for _, oneTime := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/oneTime=%v", backend, oneTime), func(t *testing.T) {
				db := openContractDatabase(t, backend)
				key, err := yopass.GenerateID()
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { db.Delete(key) })
				original := yopass.Secret{Message: "encrypted", Expiration: 60, OneTime: oneTime}
				if err := db.Put(key, original); err != nil {
					t.Fatal(err)
				}
				denied := errors.New("denied")
				if deleted, err := db.DeleteAuthorized(key, func(yopass.Secret) error { return denied }); deleted || !errors.Is(err, denied) {
					t.Fatalf("denied delete: %v, %v", deleted, err)
				}
				if deleted, err := db.DeleteAuthorized(key, func(yopass.Secret) error { return db.Put(key, original) }); deleted || !errors.Is(err, ErrKeyNotFound) {
					t.Fatalf("identical replacement delete: %v, %v", deleted, err)
				}
				if got, err := db.Status(key); err != nil || got != original {
					t.Fatalf("replacement lost: %+v, %v", got, err)
				}
				if deleted, err := db.DeleteAuthorized(key, func(s yopass.Secret) error {
					if s != original {
						t.Fatalf("wrong snapshot: %+v", s)
					}
					return nil
				}); !deleted || err != nil {
					t.Fatalf("authorized delete: %v, %v", deleted, err)
				}
				if _, err := db.Status(key); !errors.Is(err, ErrKeyNotFound) {
					t.Fatalf("not deleted: %v", err)
				}
			})
		}
	}
}
