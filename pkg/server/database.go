package server

import (
	"errors"

	"github.com/jhaals/yopass/pkg/yopass"
)

// ErrKeyNotFound is returned by Update when the key does not exist or is
// deleted before the write commits.
var ErrKeyNotFound = errors.New("key not found")

// Database interface
type Database interface {
	Get(key string) (yopass.Secret, error)
	Put(key string, secret yopass.Secret) error
	Delete(key string) (bool, error)
	Status(key string) (yopass.Secret, error)
	// Update atomically applies fn to the current value at key and stores the
	// result with the returned secret's expiration. The read-modify-write is
	// atomic across processes sharing the backend; implementations retry
	// internally on contention. If fn returns an error the update is aborted
	// and that error is returned unchanged.
	Update(key string, fn func(yopass.Secret) (yopass.Secret, error)) error
	Health() error
}
