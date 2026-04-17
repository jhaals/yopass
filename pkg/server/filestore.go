package server

import (
	"context"
	"io"
)

// FileStore interface for storing large encrypted file blobs.
// Metadata (expiration, filename, one_time) is stored separately in the Database.
type FileStore interface {
	Save(ctx context.Context, key string, data io.Reader, contentLength int64, expiration int32) error
	Load(ctx context.Context, key string) (io.ReadCloser, int64, error)
	Delete(ctx context.Context, key string) error
	Health(ctx context.Context) error
}
