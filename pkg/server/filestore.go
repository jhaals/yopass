package server

import "io"

// FileStore interface for storing large encrypted file blobs.
// Metadata (expiration, filename, one_time) is stored separately in the Database.
type FileStore interface {
	Save(key string, data io.Reader, contentLength int64) error
	Load(key string) (io.ReadCloser, int64, error)
	Delete(key string) error
	Health() error
}
