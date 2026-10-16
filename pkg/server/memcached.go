package server

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"time"

	"github.com/bradfitz/gomemcache/memcache"
	"github.com/jhaals/yopass/pkg/yopass"
)

// NewMemcached returns a new memcached database client
func NewMemcached(server string) *Memcached {
	return &Memcached{memcache.New(server)}
}

// Memcached client
type Memcached struct {
	Client *memcache.Client
}

// Status returns secret metadata without deleting it (safe for one-time secrets).
func (m *Memcached) Status(key string) (yopass.Secret, error) {
	var s yopass.Secret
	r, err := m.get(key)
	if err != nil {
		return s, err
	}
	if err := json.Unmarshal(r.Value, &s); err != nil {
		return s, err
	}
	return s, nil
}

// Get returns a secret, atomically claiming one-time values before delivery.
func (m *Memcached) Get(key string) (yopass.Secret, error) {
	return m.GetAuthorized(key, func(yopass.Secret) error { return nil })
}

func (m *Memcached) GetAuthorized(key string, authorize func(yopass.Secret) error) (yopass.Secret, error) {
	return m.readAuthorized(key, authorize, false)
}

func (m *Memcached) DeleteAuthorized(key string, authorize func(yopass.Secret) error) (bool, error) {
	_, err := m.readAuthorized(key, authorize, true)
	return err == nil, err
}

func (m *Memcached) readAuthorized(key string, authorize func(yopass.Secret) error, deleteValue bool) (yopass.Secret, error) {
	item, err := m.get(key)
	if err != nil {
		return yopass.Secret{}, err
	}
	var secret yopass.Secret
	if err := json.Unmarshal(item.Value, &secret); err != nil {
		return yopass.Secret{}, err
	}
	if err := authorize(secret); err != nil {
		return yopass.Secret{}, err
	}
	if secret.OneTime || deleteValue {
		if err := m.claim(item); err != nil {
			return yopass.Secret{}, err
		}
	}
	return secret, nil
}

// A flagged marker holds only the random claim ID, never ciphertext.
const memcachedClaimFlag uint32 = 1 << 31

func (m *Memcached) get(key string) (*memcache.Item, error) {
	item, err := m.Client.Get(key)
	if err == memcache.ErrCacheMiss || (err == nil && item.Flags&memcachedClaimFlag != 0) {
		return nil, ErrKeyNotFound
	}
	return item, err
}

// A CAS claim leaves a recognizable marker so a lost STORED reply can be
// recovered. Never follow it with Delete, which could remove a replacement.
func (m *Memcached) claim(item *memcache.Item) error {
	id, err := yopass.GenerateID()
	if err != nil {
		return err
	}
	item.Value = []byte(id)
	item.Flags = memcachedClaimFlag
	item.Expiration = claimRecordTTL
	var casErr error
	for range 3 {
		casErr = m.Client.CompareAndSwap(item)
		if casErr == nil {
			return nil
		}
		current, readErr := m.Client.Get(item.Key)
		if readErr == memcache.ErrCacheMiss {
			return ErrKeyNotFound
		}
		if readErr != nil {
			continue
		}
		if current.Flags&memcachedClaimFlag != 0 && bytes.Equal(current.Value, item.Value) {
			return nil
		}
		if current.CasID != item.CasID {
			return ErrKeyNotFound
		}
		// The original version is still present. Retrying the same CAS cannot
		// claim a replacement, even if the first command arrives late.
	}
	return casErr
}

// memcachedExpiration converts durations above 30 days to absolute timestamps.
// The stored JSON retains the relative duration expected by other backends.
func memcachedExpiration(seconds int32, now int64) (int32, error) {
	if seconds <= 30*86400 {
		return seconds, nil
	}
	if now < 0 || now > math.MaxInt32-int64(seconds) {
		return 0, fmt.Errorf("expiration cannot be represented by the Memcached client")
	}
	return int32(now + int64(seconds)), nil
}

// Put key in Memcached
func (m *Memcached) Put(key string, secret yopass.Secret) error {
	data, err := secret.ToJSON()
	if err != nil {
		return err
	}

	expiration, err := memcachedExpiration(secret.Expiration, time.Now().Unix())
	if err != nil {
		return err
	}
	return m.Client.Set(&memcache.Item{
		Key:        key,
		Value:      data,
		Expiration: expiration})
}

// Update atomically applies fn to the value at key using memcached CAS
// tokens, retrying on contention.
func (m *Memcached) Update(key string, fn func(yopass.Secret) (yopass.Secret, error)) error {
	var lastErr error
	for i := 0; i < updateRetries; i++ {
		item, err := m.get(key)
		if err != nil {
			return err
		}
		var s yopass.Secret
		if err := json.Unmarshal(item.Value, &s); err != nil {
			return err
		}
		updated, err := fn(s)
		if err != nil {
			return err
		}
		data, err := updated.ToJSON()
		if err != nil {
			return err
		}
		item.Value = data
		item.Expiration, err = memcachedExpiration(updated.Expiration, time.Now().Unix())
		if err != nil {
			return err
		}
		switch err := m.Client.CompareAndSwap(item); err {
		case nil:
			return nil
		case memcache.ErrCacheMiss, memcache.ErrNotStored:
			// Deleted or evicted since the read.
			return ErrKeyNotFound
		case memcache.ErrCASConflict:
			// Modified since the read: reload and retry.
			lastErr = err
		default:
			return err
		}
	}
	return lastErr
}

// Delete key from memcached
func (m *Memcached) Delete(key string) (bool, error) {
	if err := m.Client.Delete(key); err != nil {
		if err == memcache.ErrCacheMiss {
			return false, nil
		}
		return false, err
	}
	return true, nil
}

// Health checks Memcached connectivity by attempting to get a non-existent key
func (m *Memcached) Health() error {
	_, err := m.Client.Get("__yopass_health_check__")
	// ErrCacheMiss means memcached is working (key doesn't exist, which is expected)
	if err == memcache.ErrCacheMiss {
		return nil
	}
	// Any other error (connection refused, timeout, etc.) means unhealthy
	return err
}
