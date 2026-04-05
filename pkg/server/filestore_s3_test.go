package server

import (
	"bytes"
	"context"
	"encoding/xml"
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
type fakeS3 struct {
	mu      sync.Mutex
	objects map[string][]byte
	tags    map[string]map[string]string
	server  *httptest.Server
}

func newFakeS3(t *testing.T) *fakeS3 {
	t.Helper()
	f := &fakeS3{
		objects: make(map[string][]byte),
		tags:    make(map[string]map[string]string),
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

	// ListObjectsV2: GET /{bucket}?list-type=2
	case r.Method == http.MethodGet && key == "" && q.Get("list-type") == "2":
		f.handleList(w, r)

	// PutObjectTagging: PUT /{bucket}/{key}?tagging
	case r.Method == http.MethodPut && q.Has("tagging"):
		f.handlePutTagging(w, r, key)

	// GetObjectTagging: GET /{bucket}/{key}?tagging
	case r.Method == http.MethodGet && q.Has("tagging"):
		f.handleGetTagging(w, r, key)

	// CopyObject: PUT /{bucket}/{key} with x-amz-copy-source header
	case r.Method == http.MethodPut && r.Header.Get("x-amz-copy-source") != "":
		w.Header().Set("Content-Type", "application/xml")
		fmt.Fprintf(w, `<?xml version="1.0" encoding="UTF-8"?><CopyObjectResult><ETag>"abc"</ETag><LastModified>%s</LastModified></CopyObjectResult>`,
			time.Now().UTC().Format(time.RFC3339))

	// PutObject: PUT /{bucket}/{key}
	case r.Method == http.MethodPut:
		body, _ := io.ReadAll(r.Body)
		f.mu.Lock()
		f.objects[key] = body
		// Parse URL-encoded tags from x-amz-tagging header (e.g. "yopass-expires=1234567890").
		if tagStr := r.Header.Get("x-amz-tagging"); tagStr != "" {
			if f.tags[key] == nil {
				f.tags[key] = make(map[string]string)
			}
			for _, pair := range strings.Split(tagStr, "&") {
				kv := strings.SplitN(pair, "=", 2)
				if len(kv) == 2 {
					f.tags[key][kv[0]] = kv[1]
				}
			}
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
		delete(f.objects, key)
		f.mu.Unlock()
		w.WriteHeader(http.StatusNoContent)

	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func (f *fakeS3) handlePutTagging(w http.ResponseWriter, r *http.Request, key string) {
	type xmlTag struct {
		Key   string `xml:"Key"`
		Value string `xml:"Value"`
	}
	type xmlTagging struct {
		XMLName xml.Name `xml:"Tagging"`
		TagSet  []xmlTag `xml:"TagSet>Tag"`
	}
	var tagging xmlTagging
	body, _ := io.ReadAll(r.Body)
	if err := xml.Unmarshal(body, &tagging); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	f.mu.Lock()
	if f.tags[key] == nil {
		f.tags[key] = make(map[string]string)
	}
	for _, tag := range tagging.TagSet {
		f.tags[key][tag.Key] = tag.Value
	}
	f.mu.Unlock()
	w.WriteHeader(http.StatusOK)
}

func (f *fakeS3) handleGetTagging(w http.ResponseWriter, r *http.Request, key string) {
	f.mu.Lock()
	keyTags := f.tags[key]
	f.mu.Unlock()

	w.Header().Set("Content-Type", "application/xml")
	fmt.Fprintf(w, `<?xml version="1.0" encoding="UTF-8"?><Tagging><TagSet>`)
	for k, v := range keyTags {
		fmt.Fprintf(w, `<Tag><Key>%s</Key><Value>%s</Value></Tag>`, k, v)
	}
	fmt.Fprintf(w, `</TagSet></Tagging>`)
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
	cfg, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion("us-east-1"))
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

func TestS3FileStoreSaveSetsMeta(t *testing.T) {
	fake := newFakeS3(t)
	store := newTestS3FileStore(t, fake, "testbucket", "")
	ctx := context.Background()

	data := []byte("meta test data")
	const expirationSeconds = int32(3600)
	if err := store.Save(ctx, "metakey", bytes.NewReader(data), int64(len(data)), expirationSeconds); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	// Verify the yopass-expires tag was set with a sensible future timestamp.
	fake.mu.Lock()
	tagValue, ok := fake.tags["metakey"]["yopass-expires"]
	fake.mu.Unlock()
	if !ok {
		t.Fatal("expected yopass-expires tag to be set")
	}
	expiresUnix, err := strconv.ParseInt(tagValue, 10, 64)
	if err != nil {
		t.Fatalf("yopass-expires tag is not a valid unix timestamp: %s", tagValue)
	}
	now := time.Now().Unix()
	if expiresUnix < now {
		t.Errorf("expected expiry in the future, got %d (now %d)", expiresUnix, now)
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
	// Tag with a past expiry.
	fake.mu.Lock()
	fake.tags[expiredKey] = map[string]string{"yopass-expires": strconv.FormatInt(time.Now().Unix()-100, 10)}
	fake.mu.Unlock()

	// Save a non-expired object.
	validKey := "valid-obj"
	if err := store.Save(ctx, validKey, bytes.NewReader(data), int64(len(data)), 3600); err != nil {
		t.Fatalf("Save failed: %v", err)
	}
	// Tag with a future expiry.
	fake.mu.Lock()
	fake.tags[validKey] = map[string]string{"yopass-expires": strconv.FormatInt(time.Now().Unix()+3600, 10)}
	fake.mu.Unlock()

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

func TestCleanupExpiredS3UntaggedObject(t *testing.T) {
	fake := newFakeS3(t)
	store := newTestS3FileStore(t, fake, "testbucket", "")
	ctx := context.Background()
	logger := zaptest.NewLogger(t)

	// Inject an object directly without going through Save() to simulate an
	// object that has no yopass-expires tag (e.g. uploaded externally or by an
	// older version). The cleanup goroutine must leave it alone.
	fake.mu.Lock()
	fake.objects["untagged-obj"] = []byte("untagged data")
	fake.mu.Unlock()

	cleanupExpiredS3(ctx, store, logger)

	fake.mu.Lock()
	_, stillPresent := fake.objects["untagged-obj"]
	fake.mu.Unlock()
	if !stillPresent {
		t.Error("expected untagged object to remain after cleanup")
	}
}

func TestCleanupExpiredS3InvalidExpiresTag(t *testing.T) {
	fake := newFakeS3(t)
	store := newTestS3FileStore(t, fake, "testbucket", "")
	ctx := context.Background()
	logger := zaptest.NewLogger(t)

	// Save an object with a non-numeric expires tag — should be skipped, not deleted.
	data := []byte("bad tag data")
	if err := store.Save(ctx, "badtag-obj", bytes.NewReader(data), int64(len(data)), 3600); err != nil {
		t.Fatalf("Save failed: %v", err)
	}
	fake.mu.Lock()
	fake.tags["badtag-obj"] = map[string]string{"yopass-expires": "not-a-number"}
	fake.mu.Unlock()

	cleanupExpiredS3(ctx, store, logger)

	fake.mu.Lock()
	_, stillPresent := fake.objects["badtag-obj"]
	fake.mu.Unlock()
	if !stillPresent {
		t.Error("expected object with invalid tag to remain after cleanup")
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
