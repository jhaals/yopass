package server

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"go.uber.org/zap/zaptest"
)

func TestCleanupExpired(t *testing.T) {
	dir := t.TempDir()
	store := &DiskFileStore{BasePath: dir}
	logger := zaptest.NewLogger(t)

	// Create an expired file
	expiredKey := "expired-key"
	subdir := filepath.Join(dir, expiredKey[:2])
	os.MkdirAll(subdir, 0o700)
	os.WriteFile(filepath.Join(subdir, expiredKey+".bin"), []byte("data"), 0o600)
	meta := fileMeta{ExpirationUnix: time.Now().Unix() - 100}
	metaData, _ := json.Marshal(meta)
	os.WriteFile(filepath.Join(subdir, expiredKey+".meta"), metaData, 0o600)

	// Create a non-expired file
	validKey := "valid-key00"
	subdir2 := filepath.Join(dir, validKey[:2])
	os.MkdirAll(subdir2, 0o700)
	os.WriteFile(filepath.Join(subdir2, validKey+".bin"), []byte("data"), 0o600)
	meta2 := fileMeta{ExpirationUnix: time.Now().Unix() + 3600}
	metaData2, _ := json.Marshal(meta2)
	os.WriteFile(filepath.Join(subdir2, validKey+".meta"), metaData2, 0o600)

	cleanupExpired(store, logger)

	// Expired file should be gone
	if _, err := os.Stat(filepath.Join(dir, expiredKey[:2], expiredKey+".bin")); !os.IsNotExist(err) {
		t.Error("expected expired .bin to be deleted")
	}
	if _, err := os.Stat(filepath.Join(dir, expiredKey[:2], expiredKey+".meta")); !os.IsNotExist(err) {
		t.Error("expected expired .meta to be deleted")
	}

	// Valid file should remain
	if _, err := os.Stat(filepath.Join(dir, validKey[:2], validKey+".bin")); err != nil {
		t.Error("expected valid .bin to remain")
	}
	if _, err := os.Stat(filepath.Join(dir, validKey[:2], validKey+".meta")); err != nil {
		t.Error("expected valid .meta to remain")
	}
}

func TestCleanupExpiredInvalidMeta(t *testing.T) {
	dir := t.TempDir()
	store := &DiskFileStore{BasePath: dir}
	logger := zaptest.NewLogger(t)

	// Create file with invalid meta JSON — should be skipped, not crash
	key := "bad-meta-k"
	subdir := filepath.Join(dir, key[:2])
	os.MkdirAll(subdir, 0o700)
	os.WriteFile(filepath.Join(subdir, key+".bin"), []byte("data"), 0o600)
	os.WriteFile(filepath.Join(subdir, key+".meta"), []byte("not json"), 0o600)

	cleanupExpired(store, logger)

	// Files should still exist (invalid meta is skipped)
	if _, err := os.Stat(filepath.Join(subdir, key+".bin")); err != nil {
		t.Error("expected .bin to remain when meta is invalid")
	}
}
