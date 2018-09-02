package yopass

import "github.com/bradfitz/gomemcache/memcache"

// NewMemcached returns a new memcached database client
func NewMemcached(server string) Database {
	return Memcached{memcache.New(server)}
}

// Memcached client
type Memcached struct {
	Client *memcache.Client
}

// Get key in memcached
func (m Memcached) Get(key string) (string, error) {
	r, err := m.Client.Get(key)
	if err != nil {
		return "", err
	}
	return string(r.Value), nil
}

// Put key in Memcached
func (m Memcached) Put(key, value string, expiration int32) error {
	return m.Client.Set(&memcache.Item{
		Key:        key,
		Value:      []byte(value),
		Expiration: expiration})
}

// Delete key from memcached
func (m Memcached) Delete(key string) error {
	return m.Client.Delete(key)
}
