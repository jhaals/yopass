package server

import (
	"context"
	"encoding/base64"
	"io"
	"runtime"
	"strings"
	"sync"
	"testing"

	"github.com/jhaals/yopass/pkg/yopass"
	"github.com/stretchr/testify/require"
)

// testDB is a simple in-memory database for testing DatabaseFileStore.
type testDB struct {
	mu    sync.Mutex
	store map[string]yopass.Secret
}

func newTestDB() *testDB {
	return &testDB{store: make(map[string]yopass.Secret)}
}

func (db *testDB) Get(key string) (yopass.Secret, error) {
	db.mu.Lock()
	defer db.mu.Unlock()
	s, ok := db.store[key]
	if !ok {
		return yopass.Secret{}, ErrKeyNotFound
	}
	return s, nil
}

func (db *testDB) Put(key string, secret yopass.Secret) error {
	db.mu.Lock()
	defer db.mu.Unlock()
	db.store[key] = secret
	return nil
}

func (db *testDB) Delete(key string) (bool, error) {
	db.mu.Lock()
	defer db.mu.Unlock()
	if _, ok := db.store[key]; !ok {
		return false, nil
	}
	delete(db.store, key)
	return true, nil
}

func (db *testDB) Status(key string) (yopass.Secret, error) {
	db.mu.Lock()
	defer db.mu.Unlock()
	s, ok := db.store[key]
	if !ok {
		return yopass.Secret{}, ErrKeyNotFound
	}
	return s, nil
}
func (db *testDB) Update(key string, fn func(yopass.Secret) (yopass.Secret, error)) error {
	db.mu.Lock()
	defer db.mu.Unlock()
	s, ok := db.store[key]
	if !ok {
		return ErrKeyNotFound
	}
	updated, err := fn(s)
	if err != nil {
		return err
	}
	db.store[key] = updated
	return nil
}

func (db *testDB) Health() error { return nil }

func TestDatabaseFileStore_SaveLoadDelete(t *testing.T) {
	db := newTestDB()
	fs := NewDatabaseFileStore(db)

	data := "hello encrypted world"
	key := "test-key-123"

	// Save
	if err := fs.Save(context.Background(), key, strings.NewReader(data), int64(len(data)), 3600); err != nil {
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

func TestDatabaseFileStore_SaveSetsExpiration(t *testing.T) {
	db := newTestDB()
	fs := NewDatabaseFileStore(db)

	key := "meta-key"
	data := "test data"

	if err := fs.Save(context.Background(), key, strings.NewReader(data), int64(len(data)), 3600); err != nil {
		t.Fatalf("Save failed: %v", err)
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

func TestDatabaseFileStore_ActiveReadersShareMemory(t *testing.T) {
	store := NewDatabaseFileStore(newTestDB())
	const size = 512 << 10
	require.NoError(t, store.Save(context.Background(), "shared", strings.NewReader(strings.Repeat("a", size)), size, 3600))
	runtime.GC()
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	var readers []io.ReadCloser
	defer func() {
		for _, reader := range readers {
			reader.Close()
		}
	}()
	for range 8 {
		reader, _, err := store.Load(context.Background(), "shared")
		require.NoError(t, err)
		readers = append(readers, reader)
	}
	runtime.GC()
	runtime.ReadMemStats(&after)
	runtime.KeepAlive(readers)
	retained := int64(after.HeapAlloc) - int64(before.HeapAlloc)
	require.Less(t, retained, int64(3*size), "stalled readers must not each retain a full decoded copy")
	for _, reader := range readers {
		var prefix [2]byte
		_, err := io.ReadFull(reader, prefix[:])
		require.NoError(t, err)
		require.Equal(t, "aa", string(prefix[:]), "readers must have independent cursors")
	}
}

func TestDatabaseFileStore_ActiveReadersRespectChanges(t *testing.T) {
	store := NewDatabaseFileStore(newTestDB())
	ctx := context.Background()
	require.NoError(t, store.Save(ctx, "key", strings.NewReader("old"), 3, 3600))
	old, _, err := store.Load(ctx, "key")
	require.NoError(t, err)
	defer old.Close()
	second, _, err := store.Load(ctx, "key")
	require.NoError(t, err)
	require.NoError(t, second.Close())
	require.NoError(t, second.Close())
	require.Len(t, store.inflight, 1, "one reader still holds the buffer")

	require.NoError(t, store.Save(ctx, "key", strings.NewReader("new"), 3, 3600))
	current, _, err := store.Load(ctx, "key")
	require.NoError(t, err)
	defer current.Close()
	require.NoError(t, store.Save(ctx, "key", strings.NewReader("old"), 3, 3600))
	previous, _, err := store.Load(ctx, "key")
	require.NoError(t, err)
	defer previous.Close()
	require.Len(t, store.inflight, 2, "A to B to A must reuse the still-active A snapshot")
	require.Same(t, old.(*databaseFileReader).file, previous.(*databaseFileReader).file)
	require.NoError(t, previous.Close())
	data, err := io.ReadAll(old)
	require.NoError(t, err)
	require.Equal(t, "old", string(data))
	require.NoError(t, old.Close())
	require.Len(t, store.inflight, 1, "closing an old snapshot must not evict the replacement")
	data, err = io.ReadAll(current)
	require.NoError(t, err)
	require.Equal(t, "new", string(data))
	require.NoError(t, store.Delete(ctx, "key"))
	_, _, err = store.Load(ctx, "key")
	require.ErrorIs(t, err, ErrKeyNotFound, "an active reader must not bypass database expiry/deletion")
	require.NoError(t, current.Close())
	require.Empty(t, store.inflight, "buffers must not remain cached after the last close")
}

func TestDatabaseFileStore_ConcurrentReaders(t *testing.T) {
	store := NewDatabaseFileStore(newTestDB())
	ctx := context.Background()
	require.NoError(t, store.Save(ctx, "key", strings.NewReader("data"), 4, 3600))
	var wg sync.WaitGroup
	for range 16 {
		wg.Go(func() {
			for range 8 {
				reader, _, err := store.Load(ctx, "key")
				if err != nil {
					t.Error(err)
					return
				}
				data, readErr := io.ReadAll(reader)
				closeErr := reader.Close()
				if readErr != nil || closeErr != nil || string(data) != "data" {
					t.Errorf("read %q: read error %v, close error %v", data, readErr, closeErr)
					return
				}
			}
		})
	}
	wg.Wait()
	require.Empty(t, store.inflight)
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

	if err := fs.Save(context.Background(), key, strings.NewReader(string(data)), int64(len(data)), 3600); err != nil {
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

func (db *testDB) GetAuthorized(key string, authorize func(yopass.Secret) error) (yopass.Secret, error) {
	db.mu.Lock()
	defer db.mu.Unlock()
	secret, ok := db.store[key]
	if !ok {
		return yopass.Secret{}, ErrKeyNotFound
	}
	if err := authorize(secret); err != nil {
		return yopass.Secret{}, err
	}
	if secret.OneTime {
		delete(db.store, key)
	}
	return secret, nil
}

func (db *testDB) DeleteAuthorized(key string, authorize func(yopass.Secret) error) (bool, error) {
	db.mu.Lock()
	defer db.mu.Unlock()
	s, ok := db.store[key]
	if !ok {
		return false, ErrKeyNotFound
	}
	if err := authorize(s); err != nil {
		return false, err
	}
	delete(db.store, key)
	return true, nil
}
