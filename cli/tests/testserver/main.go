// Command testserver runs the real yopass HTTP handler on an in-memory database
// so the Rust CLI's integration tests exercise actual server behavior.
package main

import (
	"errors"
	"flag"
	"fmt"
	"net"
	"net/http"
	"sync"

	"github.com/jhaals/yopass/pkg/server"
	"github.com/jhaals/yopass/pkg/yopass"
	"github.com/prometheus/client_golang/prometheus"
	"go.uber.org/zap"
)

type memoryDB struct {
	mu   sync.Mutex
	data map[string]yopass.Secret
}

func (db *memoryDB) GetAuthorized(key string, authorize func(yopass.Secret) error) (yopass.Secret, error) {
	db.mu.Lock()
	defer db.mu.Unlock()
	s, ok := db.data[key]
	if !ok {
		return yopass.Secret{}, server.ErrKeyNotFound
	}
	if err := authorize(s); err != nil {
		return yopass.Secret{}, err
	}
	if s.OneTime {
		delete(db.data, key)
	}
	return s, nil
}

func (db *memoryDB) DeleteAuthorized(key string, authorize func(yopass.Secret) error) (bool, error) {
	db.mu.Lock()
	defer db.mu.Unlock()
	s, ok := db.data[key]
	if !ok {
		return false, server.ErrKeyNotFound
	}
	if err := authorize(s); err != nil {
		return false, err
	}
	delete(db.data, key)
	return true, nil
}

func (db *memoryDB) Get(key string) (yopass.Secret, error) {
	return db.GetAuthorized(key, func(yopass.Secret) error { return nil })
}

func (db *memoryDB) Put(key string, s yopass.Secret) error {
	db.mu.Lock()
	defer db.mu.Unlock()
	db.data[key] = s
	return nil
}

func (db *memoryDB) Delete(key string) (bool, error) {
	db.mu.Lock()
	defer db.mu.Unlock()
	_, ok := db.data[key]
	delete(db.data, key)
	return ok, nil
}

func (db *memoryDB) Status(key string) (yopass.Secret, error) {
	db.mu.Lock()
	defer db.mu.Unlock()
	s, ok := db.data[key]
	if !ok {
		return yopass.Secret{}, server.ErrKeyNotFound
	}
	return s, nil
}

func (db *memoryDB) Exists(key string) (bool, error) {
	_, err := db.Status(key)
	return err == nil, nil
}

func (db *memoryDB) Update(key string, fn func(yopass.Secret) (yopass.Secret, error)) error {
	db.mu.Lock()
	defer db.mu.Unlock()
	s, ok := db.data[key]
	if !ok {
		return server.ErrKeyNotFound
	}
	updated, err := fn(s)
	if err != nil {
		return err
	}
	db.data[key] = updated
	return nil
}

func (db *memoryDB) Health() error { return nil }

func main() {
	argon2 := flag.Bool("argon2", false, "advertise Argon2")
	flag.Parse()

	db := &memoryDB{data: map[string]yopass.Secret{}}
	y := server.Server{
		DB:          db,
		FileStore:   server.NewDatabaseFileStore(db),
		MaxLength:   10 << 20,
		MaxFileSize: 10 << 20,
		Registry:    prometheus.NewRegistry(),
		Logger:      zap.NewNop(),
		Argon2:      *argon2,
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		panic(err)
	}
	fmt.Println(listener.Addr().String())
	if err := http.Serve(listener, y.HTTPHandler()); !errors.Is(err, http.ErrServerClosed) {
		panic(err)
	}
}
