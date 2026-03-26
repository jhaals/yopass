package server

import (
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"strings"
	"testing"

	"github.com/jhaals/yopass/pkg/yopass"
)

// testDB is a simple in-memory database for testing DatabaseFileStore.
type testDB struct {
	store map[string]yopass.Secret
}

func newTestDB() *testDB {
	return &testDB{store: make(map[string]yopass.Secret)}
}

func (db *testDB) Get(key string) (yopass.Secret, error) {
	s, ok := db.store[key]
	if !ok {
		return yopass.Secret{}, fmt.Errorf("not found")
	}
	return s, nil
}

func (db *testDB) Put(key string, secret yopass.Secret) error {
	db.store[key] = secret
	return nil
}

func (db *testDB) Delete(key string) (bool, error) {
	if _, ok := db.store[key]; !ok {
		return false, nil
	}
	delete(db.store, key)
	return true, nil
}

func (db *testDB) Status(key string) (bool, error) {
	s, ok := db.store[key]
	if !ok {
		return false, fmt.Errorf("not found")
	}
	return s.OneTime, nil
}

func (db *testDB) Exists(key string) (bool, error) {
	_, ok := db.store[key]
	return ok, nil
}

func (db *testDB) Health() error {
	return nil
}

func TestDatabaseFileStore_SaveLoadDelete(t *testing.T) {
	db := newTestDB()
	fs := NewDatabaseFileStore(db)

	data := "hello encrypted world"
	key := "test-key-123"

	// Save
	if err := fs.Save(context.Background(), key, strings.NewReader(data), int64(len(data))); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	// Verify data is base64-encoded in DB
	stored, err := db.Get(fileDataKeyPrefix + key)
	if err != nil {
		t.Fatalf("data not in DB: %v", err)
	}
	decoded, _ := base64.StdEncoding.DecodeString(stored.Message)
	if string(decoded) != data {
		t.Fatalf("stored data mismatch: got %q, want %q", string(decoded), data)
	}

	// Load
	reader, size, err := fs.Load(context.Background(), key)
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}
	defer reader.Close()
	if size != int64(len(data)) {
		t.Fatalf("size mismatch: got %d, want %d", size, len(data))
	}
	loaded, _ := io.ReadAll(reader)
	if string(loaded) != data {
		t.Fatalf("loaded data mismatch: got %q, want %q", string(loaded), data)
	}

	// Delete
	if err := fs.Delete(context.Background(), key); err != nil {
		t.Fatalf("Delete failed: %v", err)
	}

	// Verify deleted
	_, _, err = fs.Load(context.Background(), key)
	if err == nil {
		t.Fatal("expected error loading deleted key")
	}
}

func TestDatabaseFileStore_SaveMeta(t *testing.T) {
	db := newTestDB()
	fs := NewDatabaseFileStore(db)

	key := "meta-key"
	data := "test data"

	if err := fs.Save(context.Background(), key, strings.NewReader(data), int64(len(data))); err != nil {
		t.Fatalf("Save failed: %v", err)
	}
	if err := fs.SaveMeta(context.Background(), key, 3600); err != nil {
		t.Fatalf("SaveMeta failed: %v", err)
	}

	stored, err := db.Get(fileDataKeyPrefix + key)
	if err != nil {
		t.Fatalf("data not in DB: %v", err)
	}
	if stored.Expiration != 3600 {
		t.Fatalf("expiration mismatch: got %d, want 3600", stored.Expiration)
	}
}

func TestDatabaseFileStore_LoadNonExistent(t *testing.T) {
	db := newTestDB()
	fs := NewDatabaseFileStore(db)

	_, _, err := fs.Load(context.Background(), "nonexistent")
	if err == nil {
		t.Fatal("expected error for nonexistent key")
	}
}

func TestDatabaseFileStore_Health(t *testing.T) {
	db := newTestDB()
	fs := NewDatabaseFileStore(db)

	if err := fs.Health(context.Background()); err != nil {
		t.Fatalf("Health failed: %v", err)
	}
}

func TestFormatSize(t *testing.T) {
	tests := []struct {
		bytes int64
		want  string
	}{
		{0, "0"},
		{512, "512"},
		{1023, "1023"},
		{1024, "1KB"},
		{1536, "1.5KB"},
		{2048, "2KB"},
		{1048576, "1MB"},
		{1572864, "1.5MB"},
		{1073741824, "1GB"},
		{1610612736, "1.5GB"},
	}
	for _, tc := range tests {
		got := FormatSize(tc.bytes)
		if got != tc.want {
			t.Errorf("FormatSize(%d) = %q, want %q", tc.bytes, got, tc.want)
		}
	}
}

func TestDatabaseFileStore_BinaryData(t *testing.T) {
	db := newTestDB()
	fs := NewDatabaseFileStore(db)

	// Test with binary data (non-UTF8)
	data := []byte{0x00, 0x01, 0xFF, 0xFE, 0x80, 0x90}
	key := "binary-key"

	if err := fs.Save(context.Background(), key, strings.NewReader(string(data)), int64(len(data))); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	reader, size, err := fs.Load(context.Background(), key)
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}
	defer reader.Close()
	if size != int64(len(data)) {
		t.Fatalf("size mismatch: got %d, want %d", size, len(data))
	}
	loaded, _ := io.ReadAll(reader)
	if len(loaded) != len(data) {
		t.Fatalf("length mismatch: got %d, want %d", len(loaded), len(data))
	}
	for i := range data {
		if loaded[i] != data[i] {
			t.Fatalf("byte %d mismatch: got %02x, want %02x", i, loaded[i], data[i])
		}
	}
}
