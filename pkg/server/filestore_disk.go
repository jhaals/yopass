package server

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"
)

// DiskFileStore stores encrypted files on the local filesystem. Everything below
// BasePath is accessed through an os.Root, so a symlink planted in the store cannot
// make the server read, write or delete files outside of it.
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

// openRoot opens BasePath for operations that must not escape it.
func (d *DiskFileStore) openRoot() (*os.Root, error) {
	root, err := os.OpenRoot(d.BasePath)
	if err != nil {
		return nil, fmt.Errorf("could not open file store directory: %w", err)
	}
	return root, nil
}

// dir, binPath and metaPath are relative to BasePath.
func (d *DiskFileStore) dir(key string) string {
	if len(key) >= 2 {
		return key[:2]
	}
	return "_"
}

func (d *DiskFileStore) binPath(key string) string {
	return filepath.Join(d.dir(key), key+".bin")
}

func (d *DiskFileStore) metaPath(key string) string {
	return filepath.Join(d.dir(key), key+".meta")
}

// Save writes data to disk atomically and writes a sidecar metadata file for TTL cleanup.
// The .meta file is written first so the cleanup goroutine can find and remove it even if
// the subsequent .bin rename fails.
func (d *DiskFileStore) Save(_ context.Context, key string, data io.Reader, contentLength int64, expiration int32) error {
	root, err := d.openRoot()
	if err != nil {
		return err
	}
	defer root.Close()

	dir := d.dir(key)
	if err := root.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("could not create directory: %w", err)
	}

	// Write .meta first so the cleanup goroutine can handle orphaned .meta files.
	metaBytes, err := json.Marshal(fileMeta{ExpirationUnix: time.Now().Unix() + int64(expiration)})
	if err != nil {
		return fmt.Errorf("could not marshal metadata: %w", err)
	}
	if err := root.WriteFile(d.metaPath(key), metaBytes, 0o600); err != nil {
		return fmt.Errorf("could not write metadata: %w", err)
	}

	// Write to temp file then rename for atomicity.
	tmpName := filepath.Join(dir, key+".tmp."+rand.Text())
	tmp, err := root.OpenFile(tmpName, os.O_RDWR|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		root.Remove(d.metaPath(key))
		return fmt.Errorf("could not create temp file: %w", err)
	}
	defer func() {
		// Clean up temp file on error.
		root.Remove(tmpName)
	}()

	if _, err := io.Copy(tmp, data); err != nil {
		tmp.Close()
		root.Remove(d.metaPath(key))
		return fmt.Errorf("could not write file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		root.Remove(d.metaPath(key))
		return fmt.Errorf("could not close temp file: %w", err)
	}

	if err := root.Rename(tmpName, d.binPath(key)); err != nil {
		root.Remove(d.metaPath(key))
		return fmt.Errorf("could not rename temp file: %w", err)
	}

	return nil
}

// Load returns a reader for the stored file and its size. Only regular files
// inside BasePath are served; a symlink leading out of the store is refused.
func (d *DiskFileStore) Load(_ context.Context, key string) (io.ReadCloser, int64, error) {
	root, err := d.openRoot()
	if err != nil {
		return nil, 0, err
	}
	defer root.Close()

	f, err := root.Open(d.binPath(key))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, 0, fmt.Errorf("could not open file: %v: %w", err, ErrKeyNotFound)
		}
		return nil, 0, fmt.Errorf("could not open file: %w", err)
	}
	stat, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, 0, fmt.Errorf("could not stat file: %w", err)
	}
	if !stat.Mode().IsRegular() {
		f.Close()
		return nil, 0, fmt.Errorf("could not open file: not a regular file")
	}
	return f, stat.Size(), nil
}

// Delete removes the file and its metadata sidecar.
func (d *DiskFileStore) Delete(_ context.Context, key string) error {
	root, err := d.openRoot()
	if err != nil {
		return err
	}
	defer root.Close()

	if err := root.Remove(d.binPath(key)); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("could not delete file: %w", err)
	}
	// Retain metadata if blob deletion fails so the expiry sweeper can retry.
	if err := root.Remove(d.metaPath(key)); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("could not delete metadata: %w", err)
	}
	return nil
}

// Health checks that the base directory is accessible.
func (d *DiskFileStore) Health(_ context.Context) error {
	tmp, err := os.CreateTemp(d.BasePath, ".health-check-*")
	if err != nil {
		return fmt.Errorf("disk file store not writable: %w", err)
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.WriteString("ok"); err != nil {
		tmp.Close()
		return fmt.Errorf("disk file store not writable: %w", err)
	}
	return tmp.Close()
}
