package server

import (
	"errors"
	"sync"

	"github.com/mehrabiyan/urlx/pkg/urlx"
)

// handlerDB seeds previously unseen keys with a fixture value, but all later
// writes, claims, and deletions have real state and monotonically increasing
// versions. A deleted key is retained as a tombstone, never re-seeded.
type handlerDB struct {
	mu                                      sync.Mutex
	records                                 map[string]handlerRecord
	initial                                 urlx.Secret
	initiallyPresent                        bool
	readErr, writeErr, deleteErr, healthErr error
}

type handlerRecord struct {
	secret  urlx.Secret
	version uint64
	present bool
}

func newHandlerDB(initial urlx.Secret, present bool) *handlerDB {
	return &handlerDB{records: make(map[string]handlerRecord), initial: initial, initiallyPresent: present}
}
func newMockDB() *handlerDB { return newHandlerDB(urlx.Secret{Message: "***ENCRYPTED***"}, true) }
func newBrokenDB() *handlerDB {
	db := newHandlerDB(urlx.Secret{}, false)
	failure := errors.New("database unavailable")
	db.readErr, db.writeErr, db.deleteErr, db.healthErr = failure, failure, failure, failure
	return db
}
func newBrokenDeleteDB() *handlerDB {
	db := newHandlerDB(urlx.Secret{}, true)
	db.deleteErr = errors.New("delete failed")
	return db
}
func newMockBrokenDB2() *handlerDB { return newHandlerDB(urlx.Secret{}, false) }
func newMockHealthDB(healthy bool) *handlerDB {
	db := newHandlerDB(urlx.Secret{}, true)
	if !healthy {
		db.healthErr = errors.New("database unhealthy")
	}
	return db
}

// record is only called while holding mu.
func (db *handlerDB) record(key string) handlerRecord {
	r, ok := db.records[key]
	if !ok {
		r = handlerRecord{secret: db.initial, present: db.initiallyPresent, version: 1}
		db.records[key] = r
	}
	return r
}
func (db *handlerDB) snapshot(key string) (handlerRecord, error) {
	db.mu.Lock()
	defer db.mu.Unlock()
	if db.readErr != nil {
		return handlerRecord{}, db.readErr
	}
	r := db.record(key)
	if !r.present {
		return handlerRecord{}, ErrKeyNotFound
	}
	return r, nil
}
func (db *handlerDB) Status(key string) (urlx.Secret, error) {
	r, err := db.snapshot(key)
	return r.secret, err
}
func (db *handlerDB) Put(key string, secret urlx.Secret) error {
	db.mu.Lock()
	defer db.mu.Unlock()
	if db.writeErr != nil {
		return db.writeErr
	}
	r := db.record(key)
	db.records[key] = handlerRecord{secret: secret, version: r.version + 1, present: true}
	return nil
}
func (db *handlerDB) Delete(key string) (bool, error) {
	db.mu.Lock()
	defer db.mu.Unlock()
	if db.deleteErr != nil {
		return false, db.deleteErr
	}
	r := db.record(key)
	if !r.present {
		return false, nil
	}
	db.records[key] = handlerRecord{version: r.version + 1}
	return true, nil
}
func (db *handlerDB) Get(key string) (urlx.Secret, error) {
	return db.GetAuthorized(key, func(urlx.Secret) error { return nil })
}
func (db *handlerDB) GetAuthorized(key string, authorize func(urlx.Secret) error) (urlx.Secret, error) {
	return db.readAuthorized(key, authorize, false)
}
func (db *handlerDB) DeleteAuthorized(key string, authorize func(urlx.Secret) error) (bool, error) {
	_, err := db.readAuthorized(key, authorize, true)
	return err == nil, err
}
func (db *handlerDB) readAuthorized(key string, authorize func(urlx.Secret) error, remove bool) (urlx.Secret, error) {
	r, err := db.snapshot(key)
	if err != nil {
		return urlx.Secret{}, err
	}
	if err := authorize(r.secret); err != nil {
		return urlx.Secret{}, err
	}
	if r.secret.OneTime || remove {
		db.mu.Lock()
		defer db.mu.Unlock()
		if db.deleteErr != nil {
			return urlx.Secret{}, db.deleteErr
		}
		current := db.record(key)
		if !current.present || current.version != r.version {
			return urlx.Secret{}, ErrKeyNotFound
		}
		db.records[key] = handlerRecord{version: current.version + 1}
	}
	return r.secret, nil
}
func (db *handlerDB) Update(key string, fn func(urlx.Secret) (urlx.Secret, error)) error {
	for range updateRetries {
		r, err := db.snapshot(key)
		if err != nil {
			return err
		}
		s, err := fn(r.secret)
		if err != nil {
			return err
		}
		db.mu.Lock()
		if db.writeErr != nil {
			db.mu.Unlock()
			return db.writeErr
		}
		current := db.record(key)
		if current.present && current.version == r.version {
			db.records[key] = handlerRecord{secret: s, version: r.version + 1, present: true}
			db.mu.Unlock()
			return nil
		}
		db.mu.Unlock()
	}
	return errors.New("update contention")
}
func (db *handlerDB) Health() error { return db.healthErr }
