package server

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"io"

	"github.com/jhaals/yopass/pkg/yopass"
)

const fileDataKeyPrefix = "filedata:"

// DatabaseFileStore stores file data in the same database backend (Memcached/Redis)
// used for secret metadata. Suitable for small-to-medium files within DB size limits.
type DatabaseFileStore struct {
	DB Database
}

// NewDatabaseFileStore creates a FileStore backed by the given Database.
func NewDatabaseFileStore(db Database) *DatabaseFileStore {
	return &DatabaseFileStore{DB: db}
}

// Save reads all data from the reader, base64-encodes it, and stores it in the database.
func (d *DatabaseFileStore) Save(key string, data io.Reader, contentLength int64) error {
	buf, err := io.ReadAll(data)
	if err != nil {
		return fmt.Errorf("failed to read file data: %w", err)
	}
	encoded := base64.StdEncoding.EncodeToString(buf)
	secret := yopass.Secret{
		Message: encoded,
	}
	return d.DB.Put(fileDataKeyPrefix+key, secret)
}

// SaveMeta stores expiration metadata for the file data entry.
func (d *DatabaseFileStore) SaveMeta(key string, expiration int32) error {
	existing, err := d.DB.Get(fileDataKeyPrefix + key)
	if err != nil {
		return fmt.Errorf("failed to read file data for meta update: %w", err)
	}
	existing.Expiration = expiration
	return d.DB.Put(fileDataKeyPrefix+key, existing)
}

// Load retrieves file data from the database, base64-decodes it, and returns a reader.
func (d *DatabaseFileStore) Load(key string) (io.ReadCloser, int64, error) {
	secret, err := d.DB.Get(fileDataKeyPrefix + key)
	if err != nil {
		return nil, 0, fmt.Errorf("file data not found: %w", err)
	}
	decoded, err := base64.StdEncoding.DecodeString(secret.Message)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to decode file data: %w", err)
	}
	return io.NopCloser(bytes.NewReader(decoded)), int64(len(decoded)), nil
}

// Delete removes the file data entry from the database.
func (d *DatabaseFileStore) Delete(key string) error {
	_, err := d.DB.Delete(fileDataKeyPrefix + key)
	return err
}

// Health delegates to the underlying database health check.
func (d *DatabaseFileStore) Health() error {
	return d.DB.Health()
}

var _ FileStore = (*DatabaseFileStore)(nil)

// FormatSize formats bytes into a human-readable string (e.g. "1MB", "1.5GB").
func FormatSize(b int64) string {
	const (
		kb = 1024
		mb = 1024 * 1024
		gb = 1024 * 1024 * 1024
	)
	switch {
	case b >= gb:
		v := float64(b) / float64(gb)
		if v == float64(int64(v)) {
			return fmt.Sprintf("%dGB", int64(v))
		}
		return fmt.Sprintf("%.1fGB", v)
	case b >= mb:
		v := float64(b) / float64(mb)
		if v == float64(int64(v)) {
			return fmt.Sprintf("%dMB", int64(v))
		}
		return fmt.Sprintf("%.1fMB", v)
	case b >= kb:
		v := float64(b) / float64(kb)
		if v == float64(int64(v)) {
			return fmt.Sprintf("%dKB", int64(v))
		}
		return fmt.Sprintf("%.1fKB", v)
	default:
		return fmt.Sprintf("%d bytes", b)
	}
}
