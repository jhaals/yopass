package server

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"go.uber.org/zap/zaptest"
)

// fakeS3 is a minimal in-memory S3-compatible HTTP server for unit testing.
// Like Cloudflare R2, it rejects requests carrying object tagging headers with
// 501 NotImplemented, so any regression reintroducing tagging fails the tests.
type fakeS3 struct {
	mu         sync.Mutex
	objects    map[string][]byte
	expires    map[string]string // raw Expires header value per key
	failHead   map[string]bool   // keys whose HeadObject returns an error
	failDelete map[string]bool   // keys whose DeleteObject returns an error
	server     *httptest.Server
}

func newFakeS3(t *testing.T) *fakeS3 {
	t.Helper()
	f := &fakeS3{
		objects:    make(map[string][]byte),
		expires:    make(map[string]string),
		failHead:   make(map[string]bool),
		failDelete: make(map[string]bool),
	}
	f.server = httptest.NewServer(http.HandlerFunc(f.handle))
	t.Cleanup(f.server.Close)
	return f
}

func writeS3XMLError(w http.ResponseWriter, code, message string, status int) {
	w.Header().Set("Content-Type", "application/xml")
	w.WriteHeader(status)
	fmt.Fprintf(w, `<?xml version="1.0" encoding="UTF-8"?><Error><Code>%s</Code><Message>%s</Message><RequestId>test</RequestId><HostId>test</HostId></Error>`, code, message)
}

func (f *fakeS3) handle(w http.ResponseWriter, r *http.Request) {
	// Path-style: /{bucket}/{key...}
	path := strings.TrimPrefix(r.URL.Path, "/")
	parts := strings.SplitN(path, "/", 2)
	key := ""
	if len(parts) == 2 {
		key = parts[1]
	}
	q := r.URL.Query()

	switch {
	// HeadBucket: HEAD /{bucket}
	case r.Method == http.MethodHead && key == "":
		w.WriteHeader(http.StatusOK)

	// HeadObject: HEAD /{bucket}/{key}
	case r.Method == http.MethodHead:
		f.mu.Lock()
		data, ok := f.objects[key]
		expires := f.expires[key]
		fail := f.failHead[key]
		f.mu.Unlock()
		if fail {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if expires != "" {
			w.Header().Set("Expires", expires)
		}
		w.Header().Set("Content-Length", strconv.Itoa(len(data)))
		w.Header().Set("ETag", `"abc123"`)
		w.WriteHeader(http.StatusOK)

	// ListObjectsV2: GET /{bucket}?list-type=2
	case r.Method == http.MethodGet && key == "" && q.Get("list-type") == "2":
		f.handleList(w, r)

	// Object tagging operations are not implemented, mirroring Cloudflare R2.
	case q.Has("tagging"):
		writeS3XMLError(w, "NotImplemented", "GetObjectTagging not implemented", http.StatusNotImplemented)

	// PutObject: PUT /{bucket}/{key}
	case r.Method == http.MethodPut:
		// R2 rejects the whole request when tagging is present rather than
		// ignoring the header.
		if r.Header.Get("x-amz-tagging") != "" {
			writeS3XMLError(w, "NotImplemented", "Header 'x-amz-tagging' with value set not implemented", http.StatusNotImplemented)
			return
		}
		body, _ := io.ReadAll(r.Body)
		f.mu.Lock()
		f.objects[key] = body
		if expires := r.Header.Get("Expires"); expires != "" {
			f.expires[key] = expires
		}
		f.mu.Unlock()
		w.Header().Set("ETag", `"abc123"`)
		w.WriteHeader(http.StatusOK)

	// GetObject: GET /{bucket}/{key}
	case r.Method == http.MethodGet:
		f.mu.Lock()
		data, ok := f.objects[key]
		f.mu.Unlock()
		if !ok {
			writeS3XMLError(w, "NoSuchKey", "The specified key does not exist.", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Length", strconv.Itoa(len(data)))
		w.Header().Set("ETag", `"abc123"`)
		w.WriteHeader(http.StatusOK)
		w.Write(data)

	// DeleteObject: DELETE /{bucket}/{key}
	case r.Method == http.MethodDelete:
		f.mu.Lock()
		fail := f.failDelete[key]
		if !fail {
			delete(f.objects, key)
			delete(f.expires, key)
		}
		f.mu.Unlock()
		if fail {
			writeS3XMLError(w, "InternalError", "We encountered an internal error.", http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)

	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func (f *fakeS3) handleList(w http.ResponseWriter, r *http.Request) {
	prefix := r.URL.Query().Get("prefix")
	f.mu.Lock()
	var keys []string
	for k := range f.objects {
		if strings.HasPrefix(k, prefix) {
			keys = append(keys, k)
		}
	}
	f.mu.Unlock()

	w.Header().Set("Content-Type", "application/xml")
	fmt.Fprintf(w, `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>bucket</Name><IsTruncated>false</IsTruncated>`)
	for _, k := range keys {
		fmt.Fprintf(w, `<Contents><Key>%s</Key></Contents>`, k)
	}
	fmt.Fprintf(w, `</ListBucketResult>`)
}

// newTestS3FileStore builds an S3FileStore pointed at the given fake S3 server.
func newTestS3FileStore(t *testing.T, fake *fakeS3, bucket, prefix string) *S3FileStore {
	t.Helper()
	// Provide fake credentials so the SDK does not try to discover them.
	t.Setenv("AWS_ACCESS_KEY_ID", "test")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "test")
	t.Setenv("AWS_REGION", "us-east-1")

	ctx := context.Background()
	// Disable retries so tests exercising 5xx responses fail fast.
	cfg, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion("us-east-1"), awsconfig.WithRetryMaxAttempts(1))
	if err != nil {
		t.Fatalf("failed to load AWS config: %v", err)
	}
	client := s3.NewFromConfig(cfg, func(o *s3.Options) {
		o.BaseEndpoint = aws.String(fake.server.URL)
		o.UsePathStyle = true
	})
	return &S3FileStore{client: client, bucket: bucket, prefix: prefix}
}

func TestS3FileStoreObjectKey(t *testing.T) {
	store := &S3FileStore{prefix: "yopass/"}
	if got := store.objectKey("abc123"); got != "yopass/abc123" {
		t.Fatalf("expected yopass/abc123, got %s", got)
	}
	store.prefix = ""
	if got := store.objectKey("abc123"); got != "abc123" {
		t.Fatalf("expected abc123, got %s", got)
	}
}

func TestS3FileStoreHealth(t *testing.T) {
	fake := newFakeS3(t)
	store := newTestS3FileStore(t, fake, "testbucket", "")

	if err := store.Health(context.Background()); err != nil {
		t.Fatalf("expected healthy, got: %v", err)
	}
}

func TestS3FileStoreSaveAndLoad(t *testing.T) {
	fake := newFakeS3(t)
	store := newTestS3FileStore(t, fake, "testbucket", "")
	ctx := context.Background()

	data := []byte("hello encrypted world")
	if err := store.Save(ctx, "mykey", bytes.NewReader(data), int64(len(data)), 3600); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	rc, size, err := store.Load(ctx, "mykey")
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}
	defer rc.Close()

	if size != int64(len(data)) {
		t.Errorf("expected size %d, got %d", len(data), size)
	}

	got, _ := io.ReadAll(rc)
	if !bytes.Equal(got, data) {
		t.Errorf("expected %q, got %q", data, got)
	}
}

func TestS3FileStoreSaveWithNoContentLength(t *testing.T) {
	fake := newFakeS3(t)
	store := newTestS3FileStore(t, fake, "testbucket", "")
	ctx := context.Background()

	data := []byte("no content length")
	// ContentLength 0 means unspecified per the Save implementation.
	if err := store.Save(ctx, "key2", bytes.NewReader(data), 0, 3600); err != nil {
		t.Fatalf("Save with zero content-length failed: %v", err)
	}

	rc, _, err := store.Load(ctx, "key2")
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}
	defer rc.Close()
	got, _ := io.ReadAll(rc)
	if !bytes.Equal(got, data) {
		t.Errorf("expected %q, got %q", data, got)
	}
}

func TestS3FileStoreLoadNotFound(t *testing.T) {
	fake := newFakeS3(t)
	store := newTestS3FileStore(t, fake, "testbucket", "")

	_, _, err := store.Load(context.Background(), "nonexistent")
	if err == nil {
		t.Fatal("expected error for nonexistent key, got nil")
	}
}

func TestS3FileStoreDelete(t *testing.T) {
	fake := newFakeS3(t)
	store := newTestS3FileStore(t, fake, "testbucket", "")
	ctx := context.Background()

	data := []byte("to be deleted")
	if err := store.Save(ctx, "delkey", bytes.NewReader(data), int64(len(data)), 3600); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	if err := store.Delete(ctx, "delkey"); err != nil {
		t.Fatalf("Delete failed: %v", err)
	}

	// After deletion the object should not be found.
	if _, _, err := store.Load(ctx, "delkey"); err == nil {
		t.Fatal("expected error after deletion, got nil")
	}
}

func TestS3FileStoreSaveSetsExpires(t *testing.T) {
	fake := newFakeS3(t)
	store := newTestS3FileStore(t, fake, "testbucket", "")
	ctx := context.Background()

	data := []byte("meta test data")
	const expirationSeconds = int32(3600)
	if err := store.Save(ctx, "metakey", bytes.NewReader(data), int64(len(data)), expirationSeconds); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	// Verify the Expires header was set with a sensible future timestamp.
	fake.mu.Lock()
	expiresHeader, ok := fake.expires["metakey"]
	fake.mu.Unlock()
	if !ok {
		t.Fatal("expected Expires header to be set")
	}
	expires, err := http.ParseTime(expiresHeader)
	if err != nil {
		t.Fatalf("Expires header is not a valid HTTP date: %s", expiresHeader)
	}
	if expires.Before(time.Now()) {
		t.Errorf("expected expiry in the future, got %s", expires)
	}
}

func TestS3FileStoreWithPrefix(t *testing.T) {
	fake := newFakeS3(t)
	store := newTestS3FileStore(t, fake, "testbucket", "secrets/")
	ctx := context.Background()

	data := []byte("prefixed content")
	if err := store.Save(ctx, "abc", bytes.NewReader(data), int64(len(data)), 3600); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	// The fake S3 should have stored the key with the prefix.
	fake.mu.Lock()
	_, stored := fake.objects["secrets/abc"]
	fake.mu.Unlock()
	if !stored {
		t.Fatal("expected object to be stored under prefix secrets/abc")
	}

	// Load should transparently use the prefix.
	rc, _, err := store.Load(ctx, "abc")
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}
	defer rc.Close()
	got, _ := io.ReadAll(rc)
	if !bytes.Equal(got, data) {
		t.Errorf("expected %q, got %q", data, got)
	}
}

func TestCleanupExpiredS3(t *testing.T) {
	fake := newFakeS3(t)
	store := newTestS3FileStore(t, fake, "testbucket", "")
	ctx := context.Background()
	logger := zaptest.NewLogger(t)

	// Save an expired object.
	expiredKey := "expired-obj"
	data := []byte("expired data")
	if err := store.Save(ctx, expiredKey, bytes.NewReader(data), int64(len(data)), 3600); err != nil {
		t.Fatalf("Save failed: %v", err)
	}
	// Rewrite the Expires header to a past timestamp.
	fake.mu.Lock()
	fake.expires[expiredKey] = time.Now().Add(-100 * time.Second).UTC().Format(http.TimeFormat)
	fake.mu.Unlock()

	// Save a non-expired object (Save sets a future Expires header).
	validKey := "valid-obj"
	if err := store.Save(ctx, validKey, bytes.NewReader(data), int64(len(data)), 3600); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	cleanupExpiredS3(ctx, store, logger)

	// Expired object must be gone.
	fake.mu.Lock()
	_, stillPresent := fake.objects[expiredKey]
	fake.mu.Unlock()
	if stillPresent {
		t.Error("expected expired S3 object to be deleted")
	}

	// Valid object must remain.
	fake.mu.Lock()
	_, stillPresent = fake.objects[validKey]
	fake.mu.Unlock()
	if !stillPresent {
		t.Error("expected non-expired S3 object to remain")
	}
}

func TestCleanupExpiredS3NoExpiresHeader(t *testing.T) {
	fake := newFakeS3(t)
	store := newTestS3FileStore(t, fake, "testbucket", "")
	ctx := context.Background()
	logger := zaptest.NewLogger(t)

	// Inject an object directly without going through Save() to simulate an
	// object that has no Expires header (e.g. uploaded externally). The
	// cleanup goroutine must leave it alone.
	fake.mu.Lock()
	fake.objects["no-expires-obj"] = []byte("data without expiry")
	fake.mu.Unlock()

	cleanupExpiredS3(ctx, store, logger)

	fake.mu.Lock()
	_, stillPresent := fake.objects["no-expires-obj"]
	fake.mu.Unlock()
	if !stillPresent {
		t.Error("expected object without Expires header to remain after cleanup")
	}
}

func TestCleanupExpiredS3InvalidExpiresHeader(t *testing.T) {
	fake := newFakeS3(t)
	store := newTestS3FileStore(t, fake, "testbucket", "")
	ctx := context.Background()
	logger := zaptest.NewLogger(t)

	// An object with an unparsable Expires header should be skipped, not deleted.
	data := []byte("bad expires data")
	if err := store.Save(ctx, "badexpires-obj", bytes.NewReader(data), int64(len(data)), 3600); err != nil {
		t.Fatalf("Save failed: %v", err)
	}
	fake.mu.Lock()
	fake.expires["badexpires-obj"] = "not-a-date"
	fake.mu.Unlock()

	cleanupExpiredS3(ctx, store, logger)

	fake.mu.Lock()
	_, stillPresent := fake.objects["badexpires-obj"]
	fake.mu.Unlock()
	if !stillPresent {
		t.Error("expected object with invalid Expires header to remain after cleanup")
	}
}

func TestCleanupExpiredS3HeadObjectError(t *testing.T) {
	fake := newFakeS3(t)
	store := newTestS3FileStore(t, fake, "testbucket", "")
	ctx := context.Background()
	logger := zaptest.NewLogger(t)

	// An object whose HeadObject call fails should be skipped, not deleted.
	data := []byte("head error data")
	if err := store.Save(ctx, "headfail-obj", bytes.NewReader(data), int64(len(data)), 3600); err != nil {
		t.Fatalf("Save failed: %v", err)
	}
	fake.mu.Lock()
	fake.failHead["headfail-obj"] = true
	fake.mu.Unlock()

	cleanupExpiredS3(ctx, store, logger)

	fake.mu.Lock()
	_, stillPresent := fake.objects["headfail-obj"]
	fake.mu.Unlock()
	if !stillPresent {
		t.Error("expected object to remain when HeadObject fails")
	}
}

func TestCleanupExpiredS3DeleteObjectError(t *testing.T) {
	fake := newFakeS3(t)
	store := newTestS3FileStore(t, fake, "testbucket", "")
	ctx := context.Background()
	logger := zaptest.NewLogger(t)

	// An expired object whose DeleteObject call fails must not crash the sweep.
	data := []byte("delete error data")
	if err := store.Save(ctx, "delfail-obj", bytes.NewReader(data), int64(len(data)), 3600); err != nil {
		t.Fatalf("Save failed: %v", err)
	}
	fake.mu.Lock()
	fake.expires["delfail-obj"] = time.Now().Add(-100 * time.Second).UTC().Format(http.TimeFormat)
	fake.failDelete["delfail-obj"] = true
	fake.mu.Unlock()

	cleanupExpiredS3(ctx, store, logger)

	fake.mu.Lock()
	_, stillPresent := fake.objects["delfail-obj"]
	fake.mu.Unlock()
	if !stillPresent {
		t.Error("expected object to remain when DeleteObject fails")
	}
}

func TestStartS3CleanupContextCancel(t *testing.T) {
	fake := newFakeS3(t)
	store := newTestS3FileStore(t, fake, "testbucket", "")
	logger := zaptest.NewLogger(t)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		StartS3Cleanup(ctx, store, time.Hour, logger)
	}()

	cancel()

	select {
	case <-done:
		// goroutine exited as expected
	case <-time.After(2 * time.Second):
		t.Fatal("StartS3Cleanup did not exit after context cancellation")
	}
}
