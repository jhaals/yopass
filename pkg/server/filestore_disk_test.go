package server

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/iotest"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestDiskFileStore_SaveLoadDelete(t *testing.T) {
	dir := t.TempDir()
	store, err := NewDiskFileStore(dir)
	require.NoError(t, err)

	key := "abcdef01-1234-5678-9abc-def012345678"
	content := []byte("hello encrypted world")

	// Save
	err = store.Save(context.Background(), key, bytes.NewReader(content), int64(len(content)), 3600)
	require.NoError(t, err)

	// Load
	rc, size, err := store.Load(context.Background(), key)
	require.NoError(t, err)
	assert.Equal(t, int64(len(content)), size)

	got, err := io.ReadAll(rc)
	rc.Close()
	require.NoError(t, err)
	assert.Equal(t, content, got)

	// Delete
	err = store.Delete(context.Background(), key)
	require.NoError(t, err)

	// Load after delete
	_, _, err = store.Load(context.Background(), key)
	assert.Error(t, err)
}

func TestDiskFileStore_SaveWritesMeta(t *testing.T) {
	dir := t.TempDir()
	store, err := NewDiskFileStore(dir)
	require.NoError(t, err)

	key := "abcdef01-1234-5678-9abc-def012345678"
	content := []byte("data")

	err = store.Save(context.Background(), key, bytes.NewReader(content), int64(len(content)), 3600)
	require.NoError(t, err)

	// Meta file should exist alongside the .bin file.
	_, err = os.Stat(store.metaPath(key))
	assert.NoError(t, err)

	// Delete should remove both.
	err = store.Delete(context.Background(), key)
	require.NoError(t, err)

	_, err = os.Stat(store.metaPath(key))
	assert.True(t, os.IsNotExist(err))
}

func TestDiskFileStore_LoadNonExistent(t *testing.T) {
	dir := t.TempDir()
	store, err := NewDiskFileStore(dir)
	require.NoError(t, err)

	_, _, err = store.Load(context.Background(), "nonexistent-key")
	assert.Error(t, err)
}

func TestDiskFileStore_Health(t *testing.T) {
	dir := t.TempDir()
	store, err := NewDiskFileStore(dir)
	require.NoError(t, err)

	err = store.Health(context.Background())
	assert.NoError(t, err)
}

func TestDiskFileStore_LargeFile(t *testing.T) {
	dir := t.TempDir()
	store, err := NewDiskFileStore(dir)
	require.NoError(t, err)

	key := "12345678-1234-5678-9abc-def012345678"
	// 1MB of data
	content := make([]byte, 1024*1024)
	for i := range content {
		content[i] = byte(i % 256)
	}

	err = store.Save(context.Background(), key, bytes.NewReader(content), int64(len(content)), 3600)
	require.NoError(t, err)

	rc, size, err := store.Load(context.Background(), key)
	require.NoError(t, err)
	assert.Equal(t, int64(len(content)), size)

	got, err := io.ReadAll(rc)
	rc.Close()
	require.NoError(t, err)
	assert.Equal(t, content, got)
}

func TestDiskFileStore_SaveReadFailureCleansUp(t *testing.T) {
	store, err := NewDiskFileStore(t.TempDir())
	require.NoError(t, err)
	readErr := errors.New("upload interrupted")
	// Fail after writing some bytes, so the test exercises partial-file cleanup.
	data := io.MultiReader(strings.NewReader("partial ciphertext"), iotest.ErrReader(readErr))
	err = store.Save(context.Background(), "abcdef", data, 100, 3600)
	require.ErrorIs(t, err, readErr)
	assert.NoFileExists(t, store.binPath("abcdef"))
	assert.NoFileExists(t, store.metaPath("abcdef"))
	entries, err := os.ReadDir(store.dir("abcdef"))
	require.NoError(t, err)
	assert.Empty(t, entries, "failed uploads must not leave temporary files")
}

func TestDiskFileStore_SaveFilesystemFailures(t *testing.T) {
	for _, stage := range []string{"directory", "metadata", "rename"} {
		t.Run(stage, func(t *testing.T) {
			store, err := NewDiskFileStore(t.TempDir())
			require.NoError(t, err)
			const key = "abcdef"
			var wantError string
			switch stage {
			case "directory":
				require.NoError(t, os.WriteFile(store.dir(key), []byte("obstruction"), 0o600))
				wantError = "could not create directory"
			case "metadata":
				require.NoError(t, os.MkdirAll(store.metaPath(key), 0o700))
				wantError = "could not write metadata"
			case "rename":
				require.NoError(t, os.MkdirAll(store.binPath(key), 0o700))
				wantError = "could not rename temp file"
			}

			err = store.Save(context.Background(), key, strings.NewReader("ciphertext"), 10, 3600)
			require.ErrorContains(t, err, wantError)
			if stage == "directory" {
				return
			}
			entries, err := os.ReadDir(store.dir(key))
			require.NoError(t, err)
			require.Len(t, entries, 1, "only the deliberately created obstruction should remain")
			assert.True(t, entries[0].IsDir())
			if stage == "rename" {
				assert.Equal(t, key+".bin", entries[0].Name())
			} else {
				assert.Equal(t, key+".meta", entries[0].Name())
			}
		})
	}
}

func TestDiskFileStore_UnavailableBaseDirectory(t *testing.T) {
	base := filepath.Join(t.TempDir(), "file")
	require.NoError(t, os.WriteFile(base, []byte("not a directory"), 0o600))
	store, err := NewDiskFileStore(base)
	require.ErrorContains(t, err, "could not create file store directory")
	assert.Nil(t, store)

	store = &DiskFileStore{BasePath: base}
	assert.ErrorContains(t, store.Health(context.Background()), "disk file store not writable")
}

func TestDiskFileStore_DeleteFailure(t *testing.T) {
	store, err := NewDiskFileStore(t.TempDir())
	require.NoError(t, err)
	const key = "abcdef"
	require.NoError(t, os.MkdirAll(store.binPath(key), 0o700))
	child := filepath.Join(store.binPath(key), "child")
	require.NoError(t, os.WriteFile(child, []byte("keep"), 0o600))
	require.ErrorContains(t, store.Delete(context.Background(), key), "could not delete file")
	assert.FileExists(t, child)
}

func TestDiskFileStore_ShortKeyAndRepeatedDelete(t *testing.T) {
	store, err := NewDiskFileStore(t.TempDir())
	require.NoError(t, err)
	ctx := context.Background()
	require.NoError(t, store.Save(ctx, "a", strings.NewReader("ciphertext"), 10, 3600))
	assert.FileExists(t, filepath.Join(store.BasePath, "_", "a.bin"))
	r, size, err := store.Load(ctx, "a")
	require.NoError(t, err)
	data, err := io.ReadAll(r)
	require.NoError(t, r.Close())
	require.NoError(t, err)
	assert.Equal(t, int64(10), size)
	assert.Equal(t, "ciphertext", string(data))
	require.NoError(t, store.Delete(ctx, "a"))
	require.NoError(t, store.Delete(ctx, "a"))
	_, _, err = store.Load(ctx, "a")
	assert.ErrorIs(t, err, ErrKeyNotFound)
}

func TestDiskFileStore_DeleteKeepsMetadataOnFailure(t *testing.T) {
	store, err := NewDiskFileStore(t.TempDir())
	require.NoError(t, err)
	const key = "retain-metadata"
	require.NoError(t, os.MkdirAll(store.binPath(key), 0o700))
	require.NoError(t, os.WriteFile(filepath.Join(store.binPath(key), "child"), []byte("blocked"), 0o600))
	require.NoError(t, os.WriteFile(store.metaPath(key), []byte(`{"expiration_unix":1}`), 0o600))
	require.Error(t, store.Delete(context.Background(), key))
	assert.FileExists(t, store.metaPath(key))
}
