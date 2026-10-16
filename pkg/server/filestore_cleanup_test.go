package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/synctest"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"go.uber.org/zap"
	"go.uber.org/zap/zaptest"
	"go.uber.org/zap/zaptest/observer"
)

type stalledCleanupBody struct{ ctx context.Context }

func (b stalledCleanupBody) Read([]byte) (int, error) {
	<-b.ctx.Done()
	return 0, b.ctx.Err()
}
func (stalledCleanupBody) Close() error { return nil }

func TestS3CleanupRecoversAfterStalledCall(t *testing.T) {
	for _, stall := range []string{"list", "list body", "head", "delete"} {
		t.Run(stall, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				stalled, deleted := false, false
				client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
					operation := "list"
					if r.Method == http.MethodHead {
						operation = "head"
					} else if r.Method == http.MethodDelete {
						operation = "delete"
					}
					response := &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("")), Request: r}
					if !stalled && (operation == stall || operation == "list" && stall == "list body") {
						stalled = true
						if stall == "list body" {
							response.Body = stalledCleanupBody{r.Context()}
							return response, nil
						}
						<-r.Context().Done()
						return nil, r.Context().Err()
					}
					switch operation {
					case "list":
						response.Body = io.NopCloser(strings.NewReader(`<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>expired-file</Key></Contents></ListBucketResult>`))
					case "head":
						response.Header.Set("Expires", time.Now().Add(-time.Hour).UTC().Format(http.TimeFormat))
					case "delete":
						deleted = true
					}
					return response, nil
				})}
				store := &S3FileStore{bucket: "test-bucket", client: s3.New(s3.Options{
					Region: "us-east-1", Credentials: aws.AnonymousCredentials{}, HTTPClient: client,
					BaseEndpoint: aws.String("https://s3.example.test"), UsePathStyle: true, RetryMaxAttempts: 1,
				})}
				start := time.Now()
				cleanupExpiredS3(context.Background(), store, zaptest.NewLogger(t))
				if !stalled || deleted || time.Since(start) != s3CleanupCallTimeout {
					t.Fatalf("stalled=%v deleted=%v elapsed=%v", stalled, deleted, time.Since(start))
				}
				cleanupExpiredS3(context.Background(), store, zaptest.NewLogger(t))
				if !deleted {
					t.Fatal("later sweep did not remove expired ciphertext")
				}
			})
		})
	}
}

func TestCleanupExpiredSymlinkedBasePath(t *testing.T) {
	target := t.TempDir()
	link := filepath.Join(t.TempDir(), "store")
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	store, err := NewDiskFileStore(link)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		key        string
		expiration int32
	}{{"expired-key", -100}, {"live-key", 3600}} {
		if err := store.Save(context.Background(), tc.key, strings.NewReader("data"), 4, tc.expiration); err != nil {
			t.Fatal(err)
		}
	}
	cleanupExpired(store, zaptest.NewLogger(t))
	for _, key := range []string{"expired-key", "live-key"} {
		for _, path := range []string{store.binPath(key), store.metaPath(key)} {
			_, err := os.Stat(filepath.Join(target, path))
			if key == "expired-key" && !os.IsNotExist(err) {
				t.Errorf("expired file remains at %s: %v", path, err)
			}
			if key == "live-key" && err != nil {
				t.Errorf("live file missing at %s: %v", path, err)
			}
		}
	}
}

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

func TestStartDiskCleanupContextCancel(t *testing.T) {
	dir := t.TempDir()
	store := &DiskFileStore{BasePath: dir}
	logger := zaptest.NewLogger(t)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		StartDiskCleanup(ctx, store, time.Hour, logger)
	}()

	cancel()

	select {
	case <-done:
		// goroutine exited as expected
	case <-time.After(2 * time.Second):
		t.Fatal("StartDiskCleanup did not exit after context cancellation")
	}
}

func TestCleanupRetriesFailedBlobDeletion(t *testing.T) {
	store, err := NewDiskFileStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	const key = "retry-cleanup"
	// A nonempty directory makes Remove fail even when the test runs as root.
	binPath := filepath.Join(store.BasePath, store.binPath(key))
	if err := os.MkdirAll(binPath, 0o700); err != nil {
		t.Fatal(err)
	}
	obstruction := filepath.Join(binPath, "child")
	if err := os.WriteFile(obstruction, []byte("blocked"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(store.BasePath, store.metaPath(key)), []byte(`{"expiration_unix":1}`), 0o600); err != nil {
		t.Fatal(err)
	}
	core, logs := observer.New(zap.DebugLevel)
	logger := zap.New(core)
	cleanupExpired(store, logger)
	if _, err := os.Stat(filepath.Join(store.BasePath, store.metaPath(key))); err != nil {
		t.Fatalf("lost metadata needed to retry cleanup: %v", err)
	}
	if err := os.Remove(obstruction); err != nil {
		t.Fatal(err)
	}
	cleanupExpired(store, logger)
	for _, path := range []string{binPath, filepath.Join(store.BasePath, store.metaPath(key))} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Errorf("cleanup did not retry %s: %v", path, err)
		}
	}
	if logs.FilterField(zap.String("secret_id", redactSecretID(key))).Len() != 2 {
		t.Fatal("cleanup logs missing fingerprints")
	}
	assertNoRawKey(t, logs, key)

}

func TestCleanupIgnoresSymlinkedMeta(t *testing.T) {
	store, err := NewDiskFileStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	const key = "symlinked-meta"
	outside := filepath.Join(t.TempDir(), "outside")
	if err := os.WriteFile(outside, []byte(`{"expiration_unix":1}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(store.BasePath, store.dir(key)), 0o700); err != nil {
		t.Fatal(err)
	}
	binPath := filepath.Join(store.BasePath, store.binPath(key))
	if err := os.WriteFile(binPath, []byte("data"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(store.BasePath, store.metaPath(key))); err != nil {
		t.Fatal(err)
	}

	cleanupExpired(store, zaptest.NewLogger(t))

	if _, err := os.Stat(binPath); err != nil {
		t.Errorf("cleanup acted on metadata read from outside the store: %v", err)
	}
}

func TestCleanupRemovesInterruptedUploadTempFile(t *testing.T) {
	store, err := NewDiskFileStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	// What Save leaves behind when the process exits mid-upload.
	const key = "interrupted-upload"
	if err := os.MkdirAll(filepath.Join(store.BasePath, store.dir(key)), 0o700); err != nil {
		t.Fatal(err)
	}
	tmpPath := filepath.Join(filepath.Join(store.BasePath, store.dir(key)), key+".tmp.123456")
	if err := os.WriteFile(tmpPath, []byte("partial ciphertext"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(store.BasePath, store.metaPath(key)), []byte(`{"expiration_unix":1}`), 0o600); err != nil {
		t.Fatal(err)
	}
	// An upload in the same directory that has not expired is left alone.
	const activeKey = "in-progress-upload"
	activeTmpPath := filepath.Join(filepath.Join(store.BasePath, store.dir(activeKey)), activeKey+".tmp.123456")
	if err := os.WriteFile(activeTmpPath, []byte("partial ciphertext"), 0o600); err != nil {
		t.Fatal(err)
	}
	activeMeta, _ := json.Marshal(fileMeta{ExpirationUnix: time.Now().Unix() + 3600})
	if err := os.WriteFile(filepath.Join(store.BasePath, store.metaPath(activeKey)), activeMeta, 0o600); err != nil {
		t.Fatal(err)
	}

	cleanupExpired(store, zaptest.NewLogger(t))
	for _, path := range []string{tmpPath, filepath.Join(store.BasePath, store.metaPath(key))} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Errorf("cleanup left %s behind: %v", path, err)
		}
	}
	for _, path := range []string{activeTmpPath, filepath.Join(store.BasePath, store.metaPath(activeKey))} {
		if _, err := os.Stat(path); err != nil {
			t.Errorf("cleanup removed %s of an unexpired upload: %v", path, err)
		}
	}
}

// expireDuringUpload is an upload body that outlasts its expiration and is
// swept before it completes.
type expireDuringUpload struct {
	sweep func()
	done  bool
}

func (r *expireDuringUpload) Read(p []byte) (int, error) {
	if r.done {
		return 0, io.EOF
	}
	r.done = true
	time.Sleep(2 * time.Hour)
	r.sweep()
	return copy(p, "ciphertext"), nil
}

func TestUploadOutlastingExpirationLeavesNothingBehind(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		store, err := NewDiskFileStore(t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		const key = "slow-upload"
		body := &expireDuringUpload{sweep: func() { cleanupExpired(store, zaptest.NewLogger(t)) }}
		if err := store.Save(context.Background(), key, body, -1, 3600); err == nil {
			t.Error("expected Save to fail once the key expired")
		}
		entries, err := os.ReadDir(filepath.Join(store.BasePath, store.dir(key)))
		if err != nil {
			t.Fatal(err)
		}
		if len(entries) != 0 {
			t.Errorf("untracked files left behind: %v", entries)
		}
	})
}

func TestCleanupTempDeletionErrorsRedactKey(t *testing.T) {
	store, err := NewDiskFileStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	const key = "0123456789abcdefghijkl"
	dir := filepath.Join(store.BasePath, store.dir(key))
	tmp := filepath.Join(dir, key+".tmp.obstruction")
	if err := os.MkdirAll(tmp, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tmp, "child"), []byte("data"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(store.BasePath, store.metaPath(key)), []byte(`{"expiration_unix":1}`), 0600); err != nil {
		t.Fatal(err)
	}
	core, logs := observer.New(zap.DebugLevel)
	cleanupExpired(store, zap.New(core))
	if logs.FilterField(zap.String("secret_id", redactSecretID(key))).Len() != 1 {
		t.Fatal("temporary cleanup error lacks fingerprint")
	}
	assertNoRawKey(t, logs, key)
	if _, err := os.Stat(filepath.Join(store.BasePath, store.metaPath(key))); err != nil {
		t.Fatal("retry metadata lost")
	}
}
