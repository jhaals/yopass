package server

import (
	"encoding/json"

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
	r, err := m.Client.Get(key)
	if err == memcache.ErrCacheMiss {
		return s, memcache.ErrCacheMiss
	}
	if err != nil {
		return s, err
	}
	if err := json.Unmarshal(r.Value, &s); err != nil {
		return s, err
	}
	return s, nil
}

// Get key in memcached
func (m *Memcached) Get(key string) (yopass.Secret, error) {
	var s yopass.Secret

	r, err := m.Client.Get(key)
	if err != nil {
		return s, err
	}

	if err := json.Unmarshal(r.Value, &s); err != nil {
		return s, err
	}

	if s.OneTime {
		if err := m.Client.Delete(key); err != nil {
			return s, err
		}
	}

	return s, nil
}

// Put key in Memcached
func (m *Memcached) Put(key string, secret yopass.Secret) error {
	data, err := secret.ToJSON()
	if err != nil {
		return err
	}

	return m.Client.Set(&memcache.Item{
		Key:        key,
		Value:      data,
		Expiration: secret.Expiration})
}

// Update atomically applies fn to the value at key using memcached CAS
// tokens, retrying on contention.
func (m *Memcached) Update(key string, fn func(yopass.Secret) (yopass.Secret, error)) error {
	var lastErr error
	for i := 0; i < updateRetries; i++ {
		item, err := m.Client.Get(key)
		if err == memcache.ErrCacheMiss {
			return ErrKeyNotFound
		}
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
		item.Expiration = updated.Expiration
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
