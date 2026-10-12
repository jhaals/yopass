package server

import (
	"encoding/json"
	"fmt"
	"math"
	"time"

	"github.com/bradfitz/gomemcache/memcache"
	"github.com/mehrabiyan/urlx/pkg/urlx"
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
func (m *Memcached) Status(key string) (urlx.Secret, error) {
	var s urlx.Secret
	r, err := m.Client.Get(key)
	if err == memcache.ErrCacheMiss {
		return s, ErrKeyNotFound
	}
	if err != nil {
		return s, err
	}
	if err := json.Unmarshal(r.Value, &s); err != nil {
		return s, err
	}
	return s, nil
}

// Get returns a secret, atomically claiming one-time values before delivery.
func (m *Memcached) Get(key string) (urlx.Secret, error) {
	return m.GetAuthorized(key, func(urlx.Secret) error { return nil })
}

func (m *Memcached) GetAuthorized(key string, authorize func(urlx.Secret) error) (urlx.Secret, error) {
	return m.readAuthorized(key, authorize, false)
}

func (m *Memcached) DeleteAuthorized(key string, authorize func(urlx.Secret) error) (bool, error) {
	_, err := m.readAuthorized(key, authorize, true)
	return err == nil, err
}

func (m *Memcached) readAuthorized(key string, authorize func(urlx.Secret) error, deleteValue bool) (urlx.Secret, error) {
	item, err := m.Client.Get(key)
	if err == memcache.ErrCacheMiss {
		return urlx.Secret{}, ErrKeyNotFound
	}
	if err != nil {
		return urlx.Secret{}, err
	}
	var secret urlx.Secret
	if err := json.Unmarshal(item.Value, &secret); err != nil {
		return urlx.Secret{}, err
	}
	if err := authorize(secret); err != nil {
		return urlx.Secret{}, err
	}
	if secret.OneTime || deleteValue {
		if err := m.claim(item); err != nil {
			return urlx.Secret{}, err
		}
	}
	return secret, nil
}

// Memcached has no compare-and-delete command. CAS with a negative ASCII
// expiration atomically expires only the version we read. Do not follow this
// with Delete: that could delete a replacement written after the claim.
func (m *Memcached) claim(item *memcache.Item) error {
	item.Value = nil
	item.Expiration = -1
	switch err := m.Client.CompareAndSwap(item); err {
	case memcache.ErrCacheMiss, memcache.ErrNotStored, memcache.ErrCASConflict:
		return ErrKeyNotFound
	default:
		return err
	}
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
func (m *Memcached) Put(key string, secret urlx.Secret) error {
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
func (m *Memcached) Update(key string, fn func(urlx.Secret) (urlx.Secret, error)) error {
	var lastErr error
	for i := 0; i < updateRetries; i++ {
		item, err := m.Client.Get(key)
		if err == memcache.ErrCacheMiss {
			return ErrKeyNotFound
		}
		if err != nil {
			return err
		}
		var s urlx.Secret
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
	_, err := m.Client.Get("__urlx_health_check__")
	// ErrCacheMiss means memcached is working (key doesn't exist, which is expected)
	if err == memcache.ErrCacheMiss {
		return nil
	}
	// Any other error (connection refused, timeout, etc.) means unhealthy
	return err
}
