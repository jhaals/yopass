package server

import (
	"errors"

	"github.com/jhaals/yopass/pkg/yopass"
)

// ErrKeyNotFound means a key does not exist or was claimed by another caller.
var ErrKeyNotFound = errors.New("key not found")

// Database interface
type Database interface {
	Get(key string) (yopass.Secret, error)
	// GetAuthorized authorizes the snapshot before consuming it. A one-time
	// claim must fail if any write replaces that snapshot, even with identical
	// content. Authorization errors leave the value intact and are returned
	// unchanged. The callback runs at most once; callers can retry a lost claim.
	GetAuthorized(key string, authorize func(yopass.Secret) error) (yopass.Secret, error)
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

// updateRetries bounds the number of attempts an Update makes when it loses a
// compare-and-swap race before giving up.
const updateRetries = 5
