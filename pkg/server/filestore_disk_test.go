package server

import (
	"bytes"
	"context"
	"io"
	"os"
	"testing"

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
	err = store.Save(context.Background(), key, bytes.NewReader(content), int64(len(content)))
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

func TestDiskFileStore_SaveMeta(t *testing.T) {
	dir := t.TempDir()
	store, err := NewDiskFileStore(dir)
	require.NoError(t, err)

	key := "abcdef01-1234-5678-9abc-def012345678"
	content := []byte("data")

	err = store.Save(context.Background(), key, bytes.NewReader(content), int64(len(content)))
	require.NoError(t, err)

	err = store.SaveMeta(context.Background(), key, 3600)
	require.NoError(t, err)

	// Meta file should exist
	_, err = os.Stat(store.metaPath(key))
	assert.NoError(t, err)

	// Delete should remove both
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

	err = store.Save(context.Background(), key, bytes.NewReader(content), int64(len(content)))
	require.NoError(t, err)

	rc, size, err := store.Load(context.Background(), key)
	require.NoError(t, err)
	assert.Equal(t, int64(len(content)), size)

	got, err := io.ReadAll(rc)
	rc.Close()
	require.NoError(t, err)
	assert.Equal(t, content, got)
}
