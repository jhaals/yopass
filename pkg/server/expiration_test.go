package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jhaals/yopass/pkg/yopass"
	"go.uber.org/zap/zaptest"
)

func TestCustomExpirationEndpoints(t *testing.T) {
	encrypted, err := yopass.Encrypt(strings.NewReader("secret"), "password")
	if err != nil {
		t.Fatal(err)
	}
	publicKey := testPublicKey(t)
	for _, endpoint := range []string{"/create/secret", "/create/file", "/request"} {
		for _, enabled := range []bool{false, true} {
			for _, ttl := range []int32{-1, 0, 59, 60, 61, 3600, 30 * 86400, 30*86400 + 1, DefaultMaxExpiration, DefaultMaxExpiration + 1} {
				t.Run(fmt.Sprintf("%s/enabled=%v/ttl=%d", endpoint, enabled, ttl), func(t *testing.T) {
					db := newMemoryDB()
					y := newTestServer(t, db, 10000, false)
					y.MaxFileSize = 1024
					y.AllowCustomExpiration = enabled
					if endpoint == "/request" {
						y.License = validLicense()
					}
					var req *http.Request
					if endpoint == "/create/file" {
						req = streamUploadRequest(pgpBody("data"), fmt.Sprint(ttl), "true", "")
					} else {
						body, _ := json.Marshal(map[string]interface{}{"expiration": ttl, "message": encrypted, "public_key": publicKey})
						req = httptest.NewRequest("POST", endpoint, bytes.NewReader(body))
					}
					rr := httptest.NewRecorder()
					y.HTTPHandler().ServeHTTP(rr, req)
					want := http.StatusBadRequest
					if enabled && ttl >= 60 && ttl <= DefaultMaxExpiration || !enabled && validExpiration(ttl) {
						want = http.StatusOK
					}
					if rr.Code != want {
						t.Fatalf("got %d, want %d: %s", rr.Code, want, rr.Body.String())
					}
					if want != http.StatusOK && len(db.data) != 0 {
						t.Fatal("rejected creation stored data")
					}
					if want == http.StatusOK {
						for _, stored := range db.data {
							if stored.Expiration != ttl {
								t.Fatalf("stored TTL %d, want %d", stored.Expiration, ttl)
							}
						}
					}
				})
			}
		}
	}
}

func TestCustomExpirationSettings(t *testing.T) {
	for _, tc := range []struct {
		name                     string
		allow                    bool
		min, max, def, force, db string
		valid                    bool
	}{
		{"defaults", false, "", "", "", "", "", true},
		{"enabled", true, "1m", "90d", "1h", "", "memcached", true},
		{"custom default", true, "1m", "90d", "1d12h", "", "memcached", true},
		{"custom forced", true, "1m", "90d", "1h", "90d", "redis", true},
		{"disabled default", false, "1m", "90d", "90d", "", "redis", false},
		{"disabled forced", false, "1m", "90d", "1h", "90d", "redis", false},
		{"bad min", true, "0s", "90d", "1h", "", "redis", false},
		{"bad max", true, "1m", "1.5d", "1h", "", "redis", false},
		{"reversed", true, "90d", "1m", "1h", "", "redis", false},
		{"default outside", true, "1d", "90d", "1h", "", "redis", false},
		{"forced outside", true, "1m", "90d", "1h", "91d", "redis", false},
		{"memcached overflow", true, "1m", "2147483647s", "1h", "", "memcached", false},
		{"redis large", true, "1m", "2147483647s", "1h", "", "redis", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidateExpirationSettings(tc.allow, tc.min, tc.max, tc.def, tc.force, tc.db)
			if (err == nil) != tc.valid {
				t.Fatalf("valid=%v, error=%v", tc.valid, err)
			}
		})
	}
}

func TestCustomExpirationForcedPolicy(t *testing.T) {
	y := newTestServer(t, newMemoryDB(), 10000, false)
	y.AllowCustomExpiration = true
	y.ForceExpiration = "90d"
	handler := y.HTTPHandler()
	for _, seconds := range []int32{3600, DefaultMaxExpiration} {
		rr := httptest.NewRecorder()
		// Exercise the shared policy through the public creation endpoint.
		encrypted, err := yopass.Encrypt(strings.NewReader("secret"), "password")
		if err != nil {
			t.Fatal(err)
		}
		body, _ := json.Marshal(yopass.Secret{Expiration: seconds, Message: encrypted})
		handler.ServeHTTP(rr, httptest.NewRequest("POST", "/create/secret", bytes.NewReader(body)))
		want := 400
		if seconds == DefaultMaxExpiration {
			want = 200
		}
		if rr.Code != want {
			t.Fatalf("got %d: %s", rr.Code, rr.Body.String())
		}
	}
}

func TestMemcachedExpirationConversion(t *testing.T) {
	const now = int64(1800000000)
	for _, tc := range []struct {
		ttl  int32
		now  int64
		want int32
		fail bool
	}{
		{3600, now, 3600, false}, {30 * 86400, now, 30 * 86400, false},
		{30*86400 + 1, now, int32(now + 30*86400 + 1), false},
		{DefaultMaxExpiration, now, int32(now) + DefaultMaxExpiration, false},
		{DefaultMaxExpiration, math.MaxInt32 - int64(DefaultMaxExpiration), math.MaxInt32, false},
		{DefaultMaxExpiration, math.MaxInt32 - int64(DefaultMaxExpiration) + 1, 0, true},
	} {
		got, err := memcachedExpiration(tc.ttl, tc.now)
		if got != tc.want || (err != nil) != tc.fail {
			t.Fatalf("ttl %d: got %d, %v", tc.ttl, got, err)
		}
	}
}

func TestLongExpirationBackends(t *testing.T) {
	backends := map[string]Database{}
	if address := os.Getenv("MEMCACHED"); address != "" {
		backends["memcached"] = NewMemcached(address)
	}
	if address := os.Getenv("REDIS_URL"); address != "" {
		db, err := NewRedis(address)
		if err != nil {
			t.Fatal(err)
		}
		backends["redis"] = db
	}
	if len(backends) == 0 {
		t.Skip("set MEMCACHED or REDIS_URL for backend tests")
	}
	for name, db := range backends {
		t.Run(name, func(t *testing.T) {
			for _, ttl := range []int32{30 * 86400, 30*86400 + 1, DefaultMaxExpiration} {
				key := fmt.Sprintf("custom-expiry-%s-%d", name, ttl)
				t.Cleanup(func() { db.Delete(key) })
				if err := db.Put(key, yopass.Secret{Message: "original", Expiration: ttl}); err != nil {
					t.Fatal(err)
				}
				if _, err := db.Status(key); err != nil {
					t.Fatalf("long TTL expired immediately: %v", err)
				}
				if err := db.Update(key, func(s yopass.Secret) (yopass.Secret, error) { s.Message = "updated"; s.Expiration -= 60; return s, nil }); err != nil {
					t.Fatal(err)
				}
				got, err := db.Status(key)
				if err != nil || got.Message != "updated" || got.Expiration != ttl-60 {
					t.Fatalf("after update: %+v, %v", got, err)
				}
				if redis, ok := db.(*Redis); ok {
					remaining, err := redis.client.TTL(context.Background(), key).Result()
					expected := time.Duration(ttl-60) * time.Second
					if err != nil || remaining > expected || remaining < expected-time.Second {
						t.Fatalf("TTL %v: %v", remaining, err)
					}
				}
			}
		})
	}
}

func TestCustomExpirationConfig(t *testing.T) {
	y := Server{AllowCustomExpiration: true, MinExpiration: 120, MaxExpiration: DefaultMaxExpiration, DefaultExpiry: "45d", ForceExpiration: "90d"}
	rr := httptest.NewRecorder()
	y.configHandler(rr, httptest.NewRequest("GET", "/config", nil))
	var config map[string]interface{}
	if err := json.Unmarshal(rr.Body.Bytes(), &config); err != nil {
		t.Fatal(err)
	}
	for key, want := range map[string]interface{}{"ALLOW_CUSTOM_EXPIRATION": true, "MIN_EXPIRATION": float64(120), "MAX_EXPIRATION": float64(DefaultMaxExpiration), "DEFAULT_EXPIRY": float64(45 * 86400), "FORCE_EXPIRATION": float64(DefaultMaxExpiration)} {
		if config[key] != want {
			t.Fatalf("%s: %v, want %v", key, config[key], want)
		}
	}
}

func TestLongExpirationDiskCleanup(t *testing.T) {
	store, err := NewDiskFileStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	const key = "long-expiration"
	before := time.Now().Unix()
	if err := store.Save(context.Background(), key, strings.NewReader("encrypted"), 9, DefaultMaxExpiration); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(store.BasePath, store.metaPath(key)))
	if err != nil {
		t.Fatal(err)
	}
	var meta fileMeta
	if err := json.Unmarshal(data, &meta); err != nil {
		t.Fatal(err)
	}
	if meta.ExpirationUnix < before+int64(DefaultMaxExpiration) || meta.ExpirationUnix > time.Now().Unix()+int64(DefaultMaxExpiration) {
		t.Fatalf("wrong deadline: %d", meta.ExpirationUnix)
	}
	cleanupExpired(store, zaptest.NewLogger(t))
	if _, err := os.Stat(filepath.Join(store.BasePath, store.binPath(key))); err != nil {
		t.Fatal("cleanup removed unexpired file")
	}
	meta.ExpirationUnix = time.Now().Unix() - 1
	data, _ = json.Marshal(meta)
	if err := os.WriteFile(filepath.Join(store.BasePath, store.metaPath(key)), data, 0600); err != nil {
		t.Fatal(err)
	}
	cleanupExpired(store, zaptest.NewLogger(t))
	if _, err := os.Stat(filepath.Join(store.BasePath, store.binPath(key))); !os.IsNotExist(err) {
		t.Fatal("cleanup did not remove expired file")
	}
}

func TestLongReceiptUpdatePreservesDeadline(t *testing.T) {
	db := newMemoryDB()
	y := newTestServer(t, db, 10000, false)
	if _, err := y.createReceipt("long-receipt", true, DefaultMaxExpiration); err != nil {
		t.Fatal(err)
	}
	original, loadErr := y.loadReceipt("long-receipt")
	if loadErr != nil {
		t.Fatal("receipt not found")
	}
	original.ExpiresAt -= 3600
	data, _ := json.Marshal(original)
	if err := db.Put(receiptKeyPrefix+"long-receipt", yopass.Secret{Message: string(data), Expiration: original.remainingTTL()}); err != nil {
		t.Fatal(err)
	}
	y.markReceiptViewed("long-receipt")
	updated, loadErr := y.loadReceipt("long-receipt")
	if loadErr != nil || updated.State != ReceiptStateViewed || updated.ExpiresAt != original.ExpiresAt {
		t.Fatalf("receipt deadline changed: %+v", updated)
	}
	stored, err := db.Status(receiptKeyPrefix + "long-receipt")
	if err != nil {
		t.Fatal(err)
	}
	remaining := original.remainingTTL()
	if stored.Expiration < remaining || stored.Expiration > remaining+1 {
		t.Fatalf("TTL extended: %d", stored.Expiration)
	}
}

func TestCustomUploadRejectsMalformedAndOverflowingExpiration(t *testing.T) {
	for _, header := range []string{"2147483647", "2147483648", "9999999999999999999999999999", "-2147483649", "1.5", "3600junk"} {
		t.Run(header, func(t *testing.T) {
			db := newMemoryDB()
			y := newTestServer(t, db, 10000, false)
			y.AllowCustomExpiration = true
			y.MaxExpiration = math.MaxInt32
			y.MaxFileSize = 1024
			rr := httptest.NewRecorder()
			y.HTTPHandler().ServeHTTP(rr, streamUploadRequest(pgpBody("data"), header, "true", ""))
			want := http.StatusBadRequest
			if header == "2147483647" {
				want = http.StatusOK
			}
			if rr.Code != want {
				t.Fatalf("got %d, want %d: %s", rr.Code, want, rr.Body.String())
			}
			if want != http.StatusOK && len(db.data) != 0 {
				t.Fatal("invalid header stored data")
			}
		})
	}
}

func TestAdminExpirationBoundsAndForcedPolicy(t *testing.T) {
	encrypted, err := yopass.Encrypt(strings.NewReader("secret"), "password")
	if err != nil {
		t.Fatal(err)
	}
	publicKey := testPublicKey(t)
	for _, endpoint := range []string{"/create/secret", "/create/file", "/request"} {
		for _, forced := range []string{"", "45d"} {
			for _, ttl := range []int32{3600, 86400 - 1, 86400, 45 * 86400, 60 * 86400, 60*86400 + 1, 90 * 86400} {
				t.Run(fmt.Sprintf("%s/force=%s/ttl=%d", endpoint, forced, ttl), func(t *testing.T) {
					db := newMemoryDB()
					y := newTestServer(t, db, 10000, false)
					y.AllowCustomExpiration = true
					y.MinExpiration, y.MaxExpiration = 86400, 60*86400
					y.ForceExpiration = forced
					y.MaxFileSize = 1024
					if endpoint == "/request" {
						y.License = validLicense()
					}
					var req *http.Request
					if endpoint == "/create/file" {
						req = streamUploadRequest(pgpBody("data"), fmt.Sprint(ttl), "true", "")
					} else {
						body, _ := json.Marshal(map[string]interface{}{"expiration": ttl, "message": encrypted, "public_key": publicKey})
						req = httptest.NewRequest("POST", endpoint, bytes.NewReader(body))
					}
					rr := httptest.NewRecorder()
					y.HTTPHandler().ServeHTTP(rr, req)
					want := http.StatusBadRequest
					if ttl >= y.MinExpiration && ttl <= y.MaxExpiration && (forced == "" || ttl == 45*86400) {
						want = http.StatusOK
					}
					if rr.Code != want {
						t.Fatalf("got %d, want %d: %s", rr.Code, want, rr.Body.String())
					}
					if want != http.StatusOK && len(db.data) != 0 {
						t.Fatal("admin policy rejection stored data")
					}
				})
			}
		}
	}
}

func TestMemcachedRejectsExpirationOverflow(t *testing.T) {
	// Put rejects an unrepresentable timestamp before contacting Memcached.
	m := NewMemcached("127.0.0.1:1")
	if err := m.Put("overflow", yopass.Secret{Message: "secret", Expiration: math.MaxInt32}); err == nil || !strings.Contains(err.Error(), "cannot be represented") {
		t.Fatalf("expected timestamp overflow error, got %v", err)
	}
	address := os.Getenv("MEMCACHED")
	if address == "" {
		t.Skip("set MEMCACHED for the update overflow check")
	}
	m = NewMemcached(address)
	key := "overflow-update-" + t.Name()
	t.Cleanup(func() { m.Delete(key) })
	if err := m.Put(key, yopass.Secret{Message: "original", Expiration: 3600}); err != nil {
		t.Fatal(err)
	}
	err := m.Update(key, func(s yopass.Secret) (yopass.Secret, error) {
		s.Message, s.Expiration = "must not be stored", math.MaxInt32
		return s, nil
	})
	if err == nil || !strings.Contains(err.Error(), "cannot be represented") {
		t.Fatalf("expected timestamp overflow error, got %v", err)
	}
	stored, err := m.Status(key)
	if err != nil || stored.Message != "original" || stored.Expiration != 3600 {
		t.Fatalf("rejected update changed stored secret: %+v, %v", stored, err)
	}
}
