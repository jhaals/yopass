package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"io"
	"sync"

	"github.com/jhaals/yopass/pkg/yopass"
)

const fileDataKeyPrefix = "filedata:"

// maxDatabaseFileLoads bounds how many loads read a record at once. Each holds
// private copies of the whole record until it reaches the shared buffer, so
// unbounded, a burst of downloads costs memory per request, not per file.
const maxDatabaseFileLoads = 4

// DatabaseFileStore stores file data in the same database backend (Memcached/Redis)
// used for secret metadata. Suitable for small-to-medium files within DB size limits.
type DatabaseFileStore struct {
	DB       Database
	mu       sync.Mutex
	inflight map[databaseFileKey]*databaseFileBuffer
	loads    chan struct{}
}

type databaseFileKey struct {
	key    string
	digest [sha256.Size]byte
}

type databaseFileBuffer struct {
	key     databaseFileKey
	data    []byte
	readers int
}

type databaseFileReader struct {
	*bytes.Reader
	store *DatabaseFileStore
	file  *databaseFileBuffer
	once  sync.Once
}

func (r *databaseFileReader) Close() error {
	r.once.Do(func() {
		r.store.mu.Lock()
		defer r.store.mu.Unlock()
		r.file.readers--
		if r.file.readers == 0 {
			delete(r.store.inflight, r.file.key)
		}
	})
	return nil
}

// NewDatabaseFileStore creates a FileStore backed by the given Database.
func NewDatabaseFileStore(db Database) *DatabaseFileStore {
	return &DatabaseFileStore{DB: db}
}

// Save reads all data from the reader, base64-encodes it, and stores it in the database
// with the given expiration so data and TTL are written atomically in a single Put.
func (d *DatabaseFileStore) Save(_ context.Context, key string, data io.Reader, contentLength int64, expiration int32) error {
	buf, err := io.ReadAll(data)
	if err != nil {
		return fmt.Errorf("failed to read file data: %w", err)
	}
	encoded := base64.StdEncoding.EncodeToString(buf)
	return d.DB.Put(fileDataKeyPrefix+key, yopass.Secret{
		Message:    encoded,
		Expiration: expiration,
	})
}

// Load retrieves file data from the database, base64-decodes it, and returns a reader.
func (d *DatabaseFileStore) Load(ctx context.Context, key string) (io.ReadCloser, int64, error) {
	// Held only while reading and decoding, never while a client is served.
	release, err := d.acquireLoad(ctx)
	if err != nil {
		return nil, 0, fmt.Errorf("gave up waiting to load file data: %w", err)
	}
	defer release()
	secret, err := d.DB.Get(fileDataKeyPrefix + key)
	if err != nil {
		return nil, 0, fmt.Errorf("file data not found: %w", err)
	}
	// Recheck the DB on every load, but share decoded data while readers are active.
	fileKey := databaseFileKey{key: key, digest: messageDigest(secret.Message)}
	d.mu.Lock()
	defer d.mu.Unlock()
	file := d.inflight[fileKey]
	if file == nil {
		decoded, err := base64.StdEncoding.DecodeString(secret.Message)
		if err != nil {
			return nil, 0, fmt.Errorf("failed to decode file data: %w", err)
		}
		file = &databaseFileBuffer{key: fileKey, data: decoded}
		if d.inflight == nil {
			d.inflight = make(map[databaseFileKey]*databaseFileBuffer)
		}
		d.inflight[fileKey] = file
	}
	file.readers++
	return &databaseFileReader{Reader: bytes.NewReader(file.data), store: d, file: file}, int64(len(file.data)), nil
}

// acquireLoad waits for one of the load slots and returns the function that
// frees it. A request whose context ends stops waiting.
func (d *DatabaseFileStore) acquireLoad(ctx context.Context) (func(), error) {
	d.mu.Lock()
	if d.loads == nil {
		d.loads = make(chan struct{}, maxDatabaseFileLoads)
	}
	loads := d.loads
	d.mu.Unlock()
	select {
	case loads <- struct{}{}:
		return func() { <-loads }, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// messageDigest hashes the message in pieces; []byte(message) would copy all of it.
func messageDigest(message string) (digest [sha256.Size]byte) {
	hash := sha256.New()
	var piece [4096]byte
	for len(message) > 0 {
		n := copy(piece[:], message)
		hash.Write(piece[:n])
		message = message[n:]
	}
	hash.Sum(digest[:0])
	return digest
}

// Delete removes the file data entry from the database.
func (d *DatabaseFileStore) Delete(_ context.Context, key string) error {
	_, err := d.DB.Delete(fileDataKeyPrefix + key)
	return err
}

// Health delegates to the underlying database health check.
func (d *DatabaseFileStore) Health(_ context.Context) error {
	return d.DB.Health()
}

var _ FileStore = (*DatabaseFileStore)(nil)
