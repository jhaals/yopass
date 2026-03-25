package server

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"
)

// DiskFileStore stores encrypted files on the local filesystem.
type DiskFileStore struct {
	BasePath string
}

type fileMeta struct {
	ExpirationUnix int64 `json:"expiration_unix"`
}

// NewDiskFileStore creates a DiskFileStore, ensuring the base directory exists.
func NewDiskFileStore(basePath string) (*DiskFileStore, error) {
	if err := os.MkdirAll(basePath, 0o700); err != nil {
		return nil, fmt.Errorf("could not create file store directory: %w", err)
	}
	return &DiskFileStore{BasePath: basePath}, nil
}

func (d *DiskFileStore) dir(key string) string {
	if len(key) >= 2 {
		return filepath.Join(d.BasePath, key[:2])
	}
	return filepath.Join(d.BasePath, "_")
}

func (d *DiskFileStore) binPath(key string) string {
	return filepath.Join(d.dir(key), key+".bin")
}

func (d *DiskFileStore) metaPath(key string) string {
	return filepath.Join(d.dir(key), key+".meta")
}

// Save writes data to disk atomically and writes a sidecar metadata file for TTL cleanup.
func (d *DiskFileStore) Save(key string, data io.Reader, contentLength int64) error {
	dir := d.dir(key)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("could not create directory: %w", err)
	}

	// Write to temp file then rename for atomicity
	tmp, err := os.CreateTemp(dir, key+".tmp.*")
	if err != nil {
		return fmt.Errorf("could not create temp file: %w", err)
	}
	tmpName := tmp.Name()
	defer func() {
		// Clean up temp file on error
		os.Remove(tmpName)
	}()

	if _, err := io.Copy(tmp, data); err != nil {
		tmp.Close()
		return fmt.Errorf("could not write file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("could not close temp file: %w", err)
	}

	if err := os.Rename(tmpName, d.binPath(key)); err != nil {
		return fmt.Errorf("could not rename temp file: %w", err)
	}

	return nil
}

// SaveMeta writes a sidecar metadata file used by the cleanup goroutine.
func (d *DiskFileStore) SaveMeta(key string, expirationSeconds int32) error {
	meta := fileMeta{
		ExpirationUnix: time.Now().Unix() + int64(expirationSeconds),
	}
	data, err := json.Marshal(meta)
	if err != nil {
		return err
	}
	return os.WriteFile(d.metaPath(key), data, 0o600)
}

// Load returns a reader for the stored file and its size.
func (d *DiskFileStore) Load(key string) (io.ReadCloser, int64, error) {
	f, err := os.Open(d.binPath(key))
	if err != nil {
		return nil, 0, fmt.Errorf("could not open file: %w", err)
	}
	stat, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, 0, fmt.Errorf("could not stat file: %w", err)
	}
	return f, stat.Size(), nil
}

// Delete removes the file and its metadata sidecar.
func (d *DiskFileStore) Delete(key string) error {
	os.Remove(d.metaPath(key))
	if err := os.Remove(d.binPath(key)); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("could not delete file: %w", err)
	}
	return nil
}

// Health checks that the base directory is accessible.
func (d *DiskFileStore) Health() error {
	tmp := filepath.Join(d.BasePath, ".health_check")
	if err := os.WriteFile(tmp, []byte("ok"), 0o600); err != nil {
		return fmt.Errorf("disk file store not writable: %w", err)
	}
	os.Remove(tmp)
	return nil
}
