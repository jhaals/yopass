package server

import (
	"bytes"
	"context"
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
func (d *DatabaseFileStore) Load(_ context.Context, key string) (io.ReadCloser, int64, error) {
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
func (d *DatabaseFileStore) Delete(_ context.Context, key string) error {
	_, err := d.DB.Delete(fileDataKeyPrefix + key)
	return err
}

// Health delegates to the underlying database health check.
func (d *DatabaseFileStore) Health(_ context.Context) error {
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
		if b%gb == 0 {
			return fmt.Sprintf("%dGB", b/gb)
		}
		return fmt.Sprintf("%.1fGB", float64(b)/gb)
	case b >= mb:
		if b%mb == 0 {
			return fmt.Sprintf("%dMB", b/mb)
		}
		return fmt.Sprintf("%.1fMB", float64(b)/mb)
	case b >= kb:
		if b%kb == 0 {
			return fmt.Sprintf("%dKB", b/kb)
		}
		return fmt.Sprintf("%.1fKB", float64(b)/kb)
	default:
		return fmt.Sprintf("%d", b)
	}
}
