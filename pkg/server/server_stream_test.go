package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"testing/iotest"
	"time"

	"github.com/jhaals/yopass/pkg/yopass"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
	"go.uber.org/zap/zaptest"
	"go.uber.org/zap/zaptest/observer"
)

type deadlineRecorder struct {
	*httptest.ResponseRecorder
	readDeadline  time.Time
	writeDeadline time.Time
	readErr       error
	writeErr      error
}

func (w *deadlineRecorder) SetReadDeadline(deadline time.Time) error {
	w.readDeadline = deadline
	return w.readErr
}

func (w *deadlineRecorder) SetWriteDeadline(deadline time.Time) error {
	w.writeDeadline = deadline
	return w.writeErr
}

func newStreamTestServer(t *testing.T, db *testDB) Server {
	t.Helper()
	return Server{
		DB:                  db,
		PrefetchSecret:      true,
		FileStore:           NewDatabaseFileStore(db),
		MaxLength:           10000,
		MaxFileSize:         1024 * 1024, // 1MB
		Registry:            prometheus.NewRegistry(),
		ForceOneTimeSecrets: false,
		Logger:              zaptest.NewLogger(t),
	}
}

// pgpBody prepends an SKESK new-format tag byte (0xC3) to arbitrary test data
// so that the OpenPGP packet validation in streamUpload accepts it.
func pgpBody(data string) string {
	return "\xc3" + data
}

func streamUploadRequest(body string, expiration string, oneTime string, filename string) *http.Request {
	req := httptest.NewRequest("POST", "/create/file", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/octet-stream")
	if expiration != "" {
		req.Header.Set("X-Yopass-Expiration", expiration)
	}
	if oneTime != "" {
		req.Header.Set("X-Yopass-OneTime", oneTime)
	}
	if filename != "" {
		req.Header.Set("X-Yopass-Filename", filename)
	}
	return req
}

// doStreamUpload uploads a file and returns the UUID key.
func doStreamUpload(t *testing.T, handler http.Handler) string {
	t.Helper()
	req := streamUploadRequest(pgpBody("encrypted-test-data"), "3600", "false", "test.bin")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("upload failed: %d %s", w.Code, w.Body.String())
	}
	var resp map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("invalid response JSON: %v", err)
	}
	msg, ok := resp["message"]
	if !ok || msg == "" {
		t.Fatal("expected UUID in response")
	}
	return msg
}

func TestStreamUpload(t *testing.T) {
	db := newTestDB()
	srv := newStreamTestServer(t, db)
	handler := srv.HTTPHandler()

	req := streamUploadRequest(pgpBody("encrypted-data"), "3600", "true", "secret.bin")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != 200 {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("invalid response JSON: %v", err)
	}
	if resp["message"] == "" {
		t.Fatal("expected UUID in response")
	}
}

func TestStreamTransferDeadlines(t *testing.T) {
	srv := newStreamTestServer(t, newTestDB())
	srv.FileTransferTimeout = time.Minute
	handler := srv.HTTPHandler()

	uploadWriter := &deadlineRecorder{ResponseRecorder: httptest.NewRecorder()}
	handler.ServeHTTP(uploadWriter, httptest.NewRequest(http.MethodPost, "/create/file", nil))
	if uploadWriter.readDeadline.IsZero() {
		t.Fatal("streaming upload did not set a read deadline")
	}
	if uploadWriter.writeDeadline.IsZero() {
		t.Fatal("streaming upload did not extend the response write deadline")
	}

	downloadWriter := &deadlineRecorder{ResponseRecorder: httptest.NewRecorder()}
	handler.ServeHTTP(downloadWriter, httptest.NewRequest(http.MethodGet, "/file/00000000-0000-0000-0000-000000000000", nil))
	if downloadWriter.writeDeadline.IsZero() {
		t.Fatal("streaming download did not set a write deadline")
	}
}

func TestStreamTransferRejectsUnsupportedDeadlines(t *testing.T) {
	srv := newStreamTestServer(t, newTestDB())
	srv.FileTransferTimeout = time.Minute

	tests := []struct {
		name   string
		writer *deadlineRecorder
		handle func(http.ResponseWriter, *http.Request)
		method string
		path   string
	}{
		{
			name:   "upload read deadline",
			writer: &deadlineRecorder{ResponseRecorder: httptest.NewRecorder(), readErr: http.ErrNotSupported},
			handle: srv.streamUpload,
			method: http.MethodPost,
			path:   "/create/file",
		},
		{
			name:   "upload write deadline",
			writer: &deadlineRecorder{ResponseRecorder: httptest.NewRecorder(), writeErr: http.ErrNotSupported},
			handle: srv.streamUpload,
			method: http.MethodPost,
			path:   "/create/file",
		},
		{
			name:   "download write deadline",
			writer: &deadlineRecorder{ResponseRecorder: httptest.NewRecorder(), writeErr: http.ErrNotSupported},
			handle: srv.streamDownload,
			method: http.MethodGet,
			path:   "/file/00000000-0000-0000-0000-000000000000",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tt.handle(tt.writer, httptest.NewRequest(tt.method, tt.path, nil))
			if tt.writer.Code != http.StatusInternalServerError {
				t.Fatalf("expected unsupported deadline to fail closed, got %d", tt.writer.Code)
			}
		})
	}
}

func TestHTTP2ResponseControllerDeadlines(t *testing.T) {
	deadlineErr := make(chan error, 1)
	ts := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		controller := http.NewResponseController(w)
		if err := controller.SetReadDeadline(time.Now().Add(time.Minute)); err != nil {
			deadlineErr <- err
			return
		}
		deadlineErr <- controller.SetWriteDeadline(time.Now().Add(time.Minute))
	}))
	ts.EnableHTTP2 = true
	ts.StartTLS()
	defer ts.Close()

	res, err := ts.Client().Get(ts.URL)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.ProtoMajor != 2 {
		t.Fatalf("expected HTTP/2, got %s", res.Proto)
	}
	if err := <-deadlineErr; err != nil {
		t.Fatalf("HTTP/2 response controller deadline failed: %v", err)
	}
}

func TestStreamUploadMissingContentType(t *testing.T) {
	db := newTestDB()
	srv := newStreamTestServer(t, db)
	handler := srv.HTTPHandler()

	req := httptest.NewRequest("POST", "/create/file", strings.NewReader("data"))
	req.Header.Set("X-Yopass-Expiration", "3600")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != 400 {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestStreamUploadMissingExpiration(t *testing.T) {
	db := newTestDB()
	srv := newStreamTestServer(t, db)
	handler := srv.HTTPHandler()

	req := httptest.NewRequest("POST", "/create/file", strings.NewReader("data"))
	req.Header.Set("Content-Type", "application/octet-stream")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != 400 {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestStreamUploadInvalidExpiration(t *testing.T) {
	db := newTestDB()
	srv := newStreamTestServer(t, db)
	handler := srv.HTTPHandler()

	req := streamUploadRequest("data", "999999", "false", "test.bin")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != 400 {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestStreamUploadForceExpiration(t *testing.T) {
	db := newTestDB()
	srv := newStreamTestServer(t, db)
	handler := srv.HTTPHandler()

	srv.ForceExpiration = "1h"

	t.Run("reject when expiration does not match forced value", func(t *testing.T) {
		req := streamUploadRequest(pgpBody("data"), "86400", "false", "test.bin")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)
		if w.Code != 400 {
			t.Fatalf("expected 400, got %d", w.Code)
		}
	})

	t.Run("accept when expiration matches forced value", func(t *testing.T) {
		req := streamUploadRequest(pgpBody("data"), "3600", "false", "test.bin")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)
		if w.Code != 200 {
			t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
		}
	})
}

func TestStreamUploadForceOneTime(t *testing.T) {
	db := newTestDB()
	srv := newStreamTestServer(t, db)
	srv.ForceOneTimeSecrets = true
	handler := srv.HTTPHandler()

	req := streamUploadRequest("data", "3600", "false", "test.bin")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != 400 {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestStreamUploadMaxFileSize(t *testing.T) {
	db := newTestDB()
	srv := newStreamTestServer(t, db)
	srv.MaxFileSize = 10 // 10 bytes
	handler := srv.HTTPHandler()

	req := streamUploadRequest("this-is-longer-than-ten-bytes", "3600", "false", "test.bin")
	req.ContentLength = 30
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != 413 {
		t.Fatalf("expected 413, got %d: %s", w.Code, w.Body.String())
	}
}

func TestStreamUploadNoFilenameInMetadata(t *testing.T) {
	db := newTestDB()
	srv := newStreamTestServer(t, db)
	handler := srv.HTTPHandler()

	req := streamUploadRequest(pgpBody("data"), "3600", "false", "sensitive-report.xlsx")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != 200 {
		t.Fatalf("expected 200, got %d", w.Code)
	}

	var resp map[string]string
	json.Unmarshal(w.Body.Bytes(), &resp)
	key := resp["message"]

	// The metadata must NOT store the filename
	meta, err := db.Get(streamKeyPrefix + key)
	if err != nil {
		t.Fatalf("metadata not found: %v", err)
	}
	if meta.Message != "" {
		t.Errorf("filename must not be stored in metadata, got %q", meta.Message)
	}
}

func TestStreamDownload(t *testing.T) {
	db := newTestDB()
	srv := newStreamTestServer(t, db)
	handler := srv.HTTPHandler()

	key := doStreamUpload(t, handler)

	// Download
	req := httptest.NewRequest("GET", "/file/"+key, nil)
	req.Header.Set("Accept", "application/octet-stream")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if cc := w.Result().Header.Get("Cache-Control"); cc != "no-store" {
		t.Fatalf("got Cache-Control %q, want no-store", cc)
	}

	if w.Code != 200 {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	if w.Header().Get("Content-Type") != "application/octet-stream" {
		t.Errorf("expected octet-stream content type, got %s", w.Header().Get("Content-Type"))
	}
	if w.Header().Get("X-Yopass-Filename") != "" {
		t.Errorf("filename must not be returned in response header, got %s", w.Header().Get("X-Yopass-Filename"))
	}
	body, _ := io.ReadAll(w.Body)
	if string(body) != pgpBody("encrypted-test-data") {
		t.Errorf("expected pgp-prefixed encrypted-test-data, got %x", body)
	}
}

func TestStreamDownloadNotFound(t *testing.T) {
	db := newTestDB()
	srv := newStreamTestServer(t, db)
	handler := srv.HTTPHandler()

	req := httptest.NewRequest("GET", "/file/00000000-0000-0000-0000-000000000000", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != 404 {
		t.Fatalf("expected 404, got %d", w.Code)
	}
}

func TestStreamDownloadOneTime(t *testing.T) {
	db := newTestDB()
	srv := newStreamTestServer(t, db)
	handler := srv.HTTPHandler()

	// Upload as one-time
	req := streamUploadRequest(pgpBody("one-time-data"), "3600", "true", "onetime.bin")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("upload failed: %d", w.Code)
	}
	var resp map[string]string
	json.Unmarshal(w.Body.Bytes(), &resp)
	key := resp["message"]

	// First download should work
	req = httptest.NewRequest("GET", "/file/"+key, nil)
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("first download failed: %d", w.Code)
	}

	// Second download should fail (one-time stream is deleted after first successful download)
	req = httptest.NewRequest("GET", "/file/"+key, nil)
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	// Both the stream metadata and the file data are deleted after the first one-time download
	if w.Code != 404 {
		t.Fatalf("expected 404 on second download, got %d", w.Code)
	}
}

func TestDeleteStreamSecret(t *testing.T) {
	db := newTestDB()
	srv := newStreamTestServer(t, db)
	handler := srv.HTTPHandler()

	key := doStreamUpload(t, handler)

	// Delete
	req := httptest.NewRequest("DELETE", "/file/"+key, nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != 204 {
		t.Fatalf("expected 204, got %d: %s", w.Code, w.Body.String())
	}

	// Verify gone
	req = httptest.NewRequest("GET", "/file/"+key, nil)
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	if w.Code != 404 {
		t.Fatalf("expected 404 after delete, got %d", w.Code)
	}
}

func TestDeleteStreamSecretNotFound(t *testing.T) {
	db := newTestDB()
	srv := newStreamTestServer(t, db)
	handler := srv.HTTPHandler()

	req := httptest.NewRequest("DELETE", "/file/00000000-0000-0000-0000-000000000000", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != 404 {
		t.Fatalf("expected 404, got %d", w.Code)
	}
}

func TestGetStreamSecretStatus(t *testing.T) {
	db := newTestDB()
	srv := newStreamTestServer(t, db)
	handler := srv.HTTPHandler()

	key := doStreamUpload(t, handler)

	req := httptest.NewRequest("GET", "/file/"+key+"/status", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != 200 {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp map[string]bool
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if resp["oneTime"] != false {
		t.Errorf("expected oneTime=false, got %v", resp["oneTime"])
	}
}

func TestGetStreamSecretStatusNotFound(t *testing.T) {
	db := newTestDB()
	srv := newStreamTestServer(t, db)
	handler := srv.HTTPHandler()

	req := httptest.NewRequest("GET", "/file/00000000-0000-0000-0000-000000000000/status", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != 404 {
		t.Fatalf("expected 404, got %d", w.Code)
	}
}

// flakyFileStore wraps a FileStore and fails Load with a transient error while
// down is set.
type flakyFileStore struct {
	FileStore
	down bool
}

func (f *flakyFileStore) Load(ctx context.Context, key string) (io.ReadCloser, int64, error) {
	if f.down {
		return nil, 0, errors.New("connection reset by peer")
	}
	return f.FileStore.Load(ctx, key)
}

// A transient store error must not destroy the secret: 503, metadata kept.
func TestGetStreamSecretTransientStoreError(t *testing.T) {
	db := newTestDB()
	srv := newStreamTestServer(t, db)
	store := &flakyFileStore{FileStore: srv.FileStore}
	srv.FileStore = store
	handler := srv.HTTPHandler()
	key := doStreamUpload(t, handler)

	store.down = true
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest("GET", "/file/"+key, nil))

	if w.Code != 503 {
		t.Fatalf("expected 503, got %d: %s", w.Code, w.Body.String())
	}
	if _, err := db.Status(streamKeyPrefix + key); err != nil {
		t.Fatalf("metadata was deleted on a transient error: %v", err)
	}

	// Once the store recovers the download works.
	store.down = false
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest("GET", "/file/"+key, nil))
	if w.Code != 200 {
		t.Fatalf("expected 200 after recovery, got %d: %s", w.Code, w.Body.String())
	}
}

// A definite not-found still cleans up the stale metadata and 404s.
func TestGetStreamSecretMissingFileCleansUp(t *testing.T) {
	db := newTestDB()
	srv := newStreamTestServer(t, db)
	handler := srv.HTTPHandler()
	key := doStreamUpload(t, handler)

	if err := srv.FileStore.Delete(context.Background(), key); err != nil {
		t.Fatalf("delete: %v", err)
	}

	w := httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest("GET", "/file/"+key, nil))
	if w.Code != 404 {
		t.Fatalf("expected 404, got %d: %s", w.Code, w.Body.String())
	}
	if _, err := db.Status(streamKeyPrefix + key); err == nil {
		t.Fatal("stale metadata was not cleaned up")
	}
}

func TestStreamUploadDBError(t *testing.T) {
	db := newTestDB()
	_ = newStreamTestServer(t, db)

	// Upload succeeds but simulate DB error by using brokenDB for metadata storage
	brokeSrv := Server{
		DB:          newBrokenDB(),
		FileStore:   NewDatabaseFileStore(db), // file store works, but DB for metadata fails
		MaxLength:   10000,
		MaxFileSize: 1024 * 1024,
		Registry:    prometheus.NewRegistry(),
		Logger:      zaptest.NewLogger(t),
	}
	brokeHandler := brokeSrv.HTTPHandler()

	req := streamUploadRequest(pgpBody("data"), "3600", "false", "test.bin")
	w := httptest.NewRecorder()
	brokeHandler.ServeHTTP(w, req)

	if w.Code != 500 {
		t.Fatalf("expected 500, got %d: %s", w.Code, w.Body.String())
	}
}

func TestStreamUploadRejectsNonPGP(t *testing.T) {
	db := newTestDB()
	srv := newStreamTestServer(t, db)
	handler := srv.HTTPHandler()

	// Plain text should be rejected
	req := streamUploadRequest("just plain text", "3600", "false", "test.bin")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != 400 {
		t.Fatalf("expected 400 for non-PGP data, got %d: %s", w.Code, w.Body.String())
	}
}

func TestStreamUploadRejectsEmptyBody(t *testing.T) {
	db := newTestDB()
	srv := newStreamTestServer(t, db)
	handler := srv.HTTPHandler()

	req := streamUploadRequest("", "3600", "false", "test.bin")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != 400 {
		t.Fatalf("expected 400 for empty body, got %d: %s", w.Code, w.Body.String())
	}
}

// TestStreamDownloadOneTimeConcurrent fires multiple simultaneous download
// requests for the same one-time file and asserts exactly one succeeds.
// This guards against the replay-attack race where two requests both read
// metadata before either deletes it.
func TestStreamDownloadOneTimeConcurrent(t *testing.T) {
	db := newTestDB()
	srv := newStreamTestServer(t, db)
	handler := srv.HTTPHandler()

	// Upload a one-time file
	req := streamUploadRequest(pgpBody("one-time-concurrent"), "3600", "true", "race.bin")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("upload failed: %d", w.Code)
	}
	var resp map[string]string
	json.Unmarshal(w.Body.Bytes(), &resp)
	key := resp["message"]

	const concurrency = 10
	var successes atomic.Int32
	var wg sync.WaitGroup

	// Start a barrier so all goroutines hit the download endpoint simultaneously.
	start := make(chan struct{})
	for i := 0; i < concurrency; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			r := httptest.NewRequest("GET", "/file/"+key, nil)
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, r)
			if w.Code == 200 {
				successes.Add(1)
			}
		}()
	}

	close(start) // release all goroutines at once
	wg.Wait()

	if n := successes.Load(); n != 1 {
		t.Errorf("expected exactly 1 successful download of one-time file, got %d", n)
	}
}

func TestIsOpenPGPBinary(t *testing.T) {
	tests := []struct {
		name string
		b    byte
		want bool
	}{
		{"SKESK new format (0xC3)", 0xC3, true},
		{"PKESK new format (0xC1)", 0xC1, true},
		{"SKESK old format (0x8C)", 0x8C, true},
		{"PKESK old format (0x84)", 0x84, true},
		{"plain ASCII 'H'", 'H', false},
		{"zero byte", 0x00, false},
		{"SED new format tag 9 (0xC9)", 0xC9, false},
		{"literal data tag 11 (0xCB)", 0xCB, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := isOpenPGPBinary(tt.b); got != tt.want {
				t.Errorf("isOpenPGPBinary(0x%02X) = %v, want %v", tt.b, got, tt.want)
			}
		})
	}
}

// A client disconnect must not leave a claimed one-time blob behind.
func TestStreamDownloadFailureCleansUpClaimedFile(t *testing.T) {
	db := newTestDB()
	srv := newStreamTestServer(t, db)
	key := "abcdefghijklmnopqrstuv"
	if err := db.Put(streamKeyPrefix+key, yopass.Secret{OneTime: true, Expiration: 3600}); err != nil {
		t.Fatal(err)
	}
	if err := srv.FileStore.Save(context.Background(), key, strings.NewReader("ciphertext"), 10, 3600); err != nil {
		t.Fatal(err)
	}
	srv.HTTPHandler().ServeHTTP(&disconnectedWriter{ResponseRecorder: httptest.NewRecorder()}, httptest.NewRequest(http.MethodGet, "/file/"+key, nil))
	if _, _, err := srv.FileStore.Load(context.Background(), key); !errors.Is(err, ErrKeyNotFound) {
		t.Fatalf("claimed blob still present: %v", err)
	}
}

type disconnectedWriter struct{ *httptest.ResponseRecorder }

func (w *disconnectedWriter) Write([]byte) (int, error) { return 0, errors.New("client disconnected") }

func TestStreamDownloadFailureIsRecorded(t *testing.T) {
	for _, oneTime := range []bool{true, false} {
		name := "multi-view"
		if oneTime {
			name = "one-time"
		}
		t.Run(name, func(t *testing.T) {
			db := newTestDB()
			srv := newServerWithOIDC(t, db)
			audit := &capturingAuditLogger{}
			srv.Audit = audit
			// Inspect the queue without starting a delivery worker or using a network.
			srv.Webhooks = &WebhookNotifier{queue: make(chan WebhookEvent, 2)}
			const key = "abcdefghijklmnopqrstuv"
			require.NoError(t, db.Put(streamKeyPrefix+key, yopass.Secret{
				OneTime: oneTime, RequireAuth: true, Expiration: 3600,
			}))
			require.NoError(t, srv.FileStore.Save(context.Background(), key, strings.NewReader("ciphertext"), 10, 3600))
			_, err := srv.createReceipt(key, oneTime, 3600)
			require.NoError(t, err)
			req := httptest.NewRequest(http.MethodGet, "/file/"+key, nil)
			for _, cookie := range sessionCookiesFor(t, &srv) {
				req.AddCookie(cookie)
			}
			srv.HTTPHandler().ServeHTTP(&disconnectedWriter{ResponseRecorder: httptest.NewRecorder()}, req)

			require.Len(t, audit.events, 1)
			event := audit.events[0]
			assert.Equal(t, "file.downloaded", event.Event)
			assert.Equal(t, OutcomeSuccess, event.Outcome)
			assert.Equal(t, redactSecretID(key), event.SecretID)
			assert.Equal(t, "user@example.com", event.UserEmail)
			assert.Equal(t, "u1", event.UserSubject)
			require.NotNil(t, event.OneTime)
			assert.Equal(t, oneTime, *event.OneTime)
			require.NotNil(t, event.RequireAuth)
			assert.True(t, *event.RequireAuth)
			receipt, loadErr := srv.loadReceipt(key)
			require.NoError(t, loadErr)
			assert.Equal(t, ReceiptStateViewed, receipt.State)
			assert.NotZero(t, receipt.ViewedAt)
			require.Len(t, srv.Webhooks.queue, 1)
			webhook := <-srv.Webhooks.queue
			assert.Equal(t, WebhookEventSecretViewed, webhook.Event)
			assert.Equal(t, WebhookKindFile, webhook.Kind)
			assert.Equal(t, redactSecretID(key), webhook.SecretID)
			assert.Equal(t, oneTime, webhook.OneTime)

			_, metaErr := db.Status(streamKeyPrefix + key)
			reader, _, fileErr := srv.FileStore.Load(context.Background(), key)
			if oneTime {
				assert.Error(t, metaErr)
				assert.ErrorIs(t, fileErr, ErrKeyNotFound)
			} else {
				assert.NoError(t, metaErr)
				require.NoError(t, fileErr)
				require.NoError(t, reader.Close())
			}
		})
	}
}

func TestStreamLoadFailureKeepsOneTimeFile(t *testing.T) {
	db := newTestDB()
	srv := newStreamTestServer(t, db)
	store := &flakyFileStore{FileStore: srv.FileStore}
	srv.FileStore = store
	handler := srv.HTTPHandler()
	key := "abcdefghijklmnopqrstuv"
	if err := db.Put(streamKeyPrefix+key, yopass.Secret{OneTime: true, Expiration: 3600}); err != nil {
		t.Fatal(err)
	}
	if err := store.Save(context.Background(), key, strings.NewReader("ciphertext"), 10, 3600); err != nil {
		t.Fatal(err)
	}
	store.down = true
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/file/"+key, nil))
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("status: %d", w.Code)
	}
	if _, err := db.Status(streamKeyPrefix + key); err != nil {
		t.Fatalf("transient error consumed metadata: %v", err)
	}
	store.down = false
	reader, _, err := store.Load(context.Background(), key)
	if err != nil {
		t.Fatalf("transient error removed blob: %v", err)
	}
	reader.Close()
	for _, want := range []int{http.StatusOK, http.StatusNotFound} {
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/file/"+key, nil))
		if w.Code != want {
			t.Fatalf("retrieval after recovery = %d, want %d", w.Code, want)
		}
		if want == http.StatusOK && w.Body.String() != "ciphertext" {
			t.Fatalf("wrong file: %q", w.Body.String())
		}
	}
	if _, _, err := store.Load(context.Background(), key); !errors.Is(err, ErrKeyNotFound) {
		t.Fatalf("consumed blob still present: %v", err)
	}
	if _, err := db.Status(streamKeyPrefix + key); err == nil {
		t.Fatal("consumed metadata still present")
	}
}

func TestStreamStoreErrorsRedactKey(t *testing.T) {
	const key = "0123456789abcdefghijkl"
	tests := []struct {
		name    string
		message string
		store   func(t *testing.T) FileStore
	}{
		{"s3 unreachable", "Failed to load streaming file", func(t *testing.T) FileStore {
			fake := newFakeS3(t)
			// Fail the SDK transport without binding or contacting a socket.
			fake.server.Client().Transport = roundTripFunc(func(*http.Request) (*http.Response, error) { return nil, errors.New("storage unavailable") })
			store := newTestS3FileStore(t, fake, "testbucket", "yopass/")
			return store
		}},
		{"disk file missing", "Failed to load streaming file", func(t *testing.T) FileStore {
			store, err := NewDiskFileStore(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			return store
		}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			db := newTestDB()
			srv := newStreamTestServer(t, db)
			core, logs := observer.New(zap.DebugLevel)
			srv.Logger = zap.New(core)
			srv.FileStore = tc.store(t)
			if err := db.Put(streamKeyPrefix+key, yopass.Secret{Expiration: 3600}); err != nil {
				t.Fatal(err)
			}

			srv.HTTPHandler().ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/file/"+key, nil))

			entries := logs.FilterMessage(tc.message).All()
			if len(entries) != 1 {
				t.Fatalf("expected one %q entry, got %d", tc.message, len(entries))
			}
			if msg, _ := entries[0].ContextMap()["error"].(string); !strings.Contains(msg, redactSecretID(key)) {
				t.Errorf("expected the key fingerprint in the logged error, got %q", msg)
			}
			assertNoRawKey(t, logs, key)
		})
	}
}

type fileLogErrorStore struct {
	FileStore
	key                            string
	failSave, failDelete, failRead bool
}

func (s *fileLogErrorStore) Save(ctx context.Context, key string, r io.Reader, size int64, expiration int32) error {
	s.key = key
	if s.failSave {
		return fmt.Errorf("fixture save failed for %s", key)
	}
	return s.FileStore.Save(ctx, key, r, size, expiration)
}
func (s *fileLogErrorStore) Delete(ctx context.Context, key string) error {
	if s.failDelete {
		return fmt.Errorf("fixture delete failed for %s", key)
	}
	return s.FileStore.Delete(ctx, key)
}
func (s *fileLogErrorStore) Load(ctx context.Context, key string) (io.ReadCloser, int64, error) {
	if s.failRead {
		return io.NopCloser(fileLogErrorReader{key}), -1, nil
	}
	return s.FileStore.Load(ctx, key)
}

type fileLogErrorReader struct{ key string }

func (r fileLogErrorReader) Read([]byte) (int, error) {
	return 0, fmt.Errorf("fixture read failed for %s", r.key)
}

type fileLogErrorDB struct {
	*memoryDB
	failMetadata, failReceipt bool
}

func (db *fileLogErrorDB) Put(key string, secret yopass.Secret) error {
	if (db.failMetadata && strings.HasPrefix(key, streamKeyPrefix)) || (db.failReceipt && strings.HasPrefix(key, receiptKeyPrefix)) {
		return errors.New("fixture database write failure")
	}
	return db.memoryDB.Put(key, secret)
}
func TestFileStoreErrorCallersRedactKeys(t *testing.T) {
	for _, tc := range []struct {
		name, message string
		upload        bool
		status        int
	}{
		{"upload", "Failed to save streaming file", true, 500},
		{"metadata rollback", "Failed to delete file after metadata DB error", true, 500},
		{"receipt rollback", "Failed to delete file after receipt error", true, 500},
		{"explicit delete", "Failed to delete streaming file", false, 204},
		{"one-time cleanup", "Failed to delete one-time streaming file", false, 200},
		{"stream copy", "Failed to stream file", false, 200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db := &fileLogErrorDB{memoryDB: newMemoryDB()}
			srv := newRequestTestServer(t, db, true)
			srv.MaxFileSize = 1024
			store := &fileLogErrorStore{FileStore: NewDatabaseFileStore(newMemoryDB()), key: "0123456789abcdefghijkl"}
			srv.FileStore = store
			core, logs := observer.New(zap.DebugLevel)
			srv.Logger = zap.New(core)
			db.failMetadata = tc.name == "metadata rollback"
			db.failReceipt = tc.name == "receipt rollback"
			store.failSave = tc.name == "upload"
			store.failRead = tc.name == "stream copy"
			store.failDelete = tc.name == "metadata rollback" || tc.name == "receipt rollback" || tc.name == "explicit delete" || tc.name == "one-time cleanup"
			var req *http.Request
			if tc.upload {
				req = httptest.NewRequest(http.MethodPost, "/create/file", strings.NewReader(pgpBody("data")))
				req.Header.Set("Content-Type", "application/octet-stream")
				req.Header.Set("X-Yopass-Expiration", "3600")
				if db.failReceipt {
					req.Header.Set("X-Yopass-Receipt", "true")
				}
			} else {
				if err := db.Put(streamKeyPrefix+store.key, yopass.Secret{Expiration: 3600, OneTime: tc.name == "one-time cleanup"}); err != nil {
					t.Fatal(err)
				}
				if err := store.FileStore.Save(context.Background(), store.key, strings.NewReader(pgpBody("data")), int64(len(pgpBody("data"))), 3600); err != nil {
					t.Fatal(err)
				}
				method := http.MethodGet
				if tc.name == "explicit delete" {
					method = http.MethodDelete
				}
				req = httptest.NewRequest(method, "/file/"+store.key, nil)
			}
			w := httptest.NewRecorder()
			srv.HTTPHandler().ServeHTTP(w, req)
			if w.Code != tc.status {
				t.Fatalf("status %d, want %d", w.Code, tc.status)
			}
			entries := logs.FilterMessage(tc.message).All()
			if len(entries) != 1 {
				t.Fatalf("expected one %q log entry, got %d", tc.message, len(entries))
			}
			text, _ := entries[0].ContextMap()["error"].(string)
			if !strings.Contains(text, redactSecretID(store.key)) || !strings.Contains(text, "fixture") {
				t.Fatalf("missing redacted diagnostic: %s", text)
			}
			assertNoRawKey(t, logs, store.key)
		})
	}
}

// ctxFileStore wraps a FileStore and honours context cancellation the way the
// S3 store does: a cancelled Delete never happens, while a cancelled Save only
// loses the response of a write that was already committed.
type ctxFileStore struct {
	FileStore
	saveErr error
}

func (c *ctxFileStore) Save(ctx context.Context, key string, data io.Reader, contentLength int64, expiration int32) error {
	if err := c.FileStore.Save(ctx, key, data, contentLength, expiration); err != nil {
		return err
	}
	if c.saveErr != nil {
		return c.saveErr
	}
	return ctx.Err()
}

func (c *ctxFileStore) Delete(ctx context.Context, key string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	return c.FileStore.Delete(ctx, key)
}

func disconnected(req *http.Request) *http.Request {
	ctx, cancel := context.WithCancel(req.Context())
	cancel()
	return req.WithContext(ctx)
}

func (db *testDB) keys() []string {
	db.mu.Lock()
	defer db.mu.Unlock()
	return slices.Collect(maps.Keys(db.store))
}

// A client that hangs up after its last byte must not turn a stored file into
// a failed upload without metadata.
func TestStreamUploadClientDisconnect(t *testing.T) {
	db := newTestDB()
	srv := newStreamTestServer(t, db)
	srv.FileStore = &ctxFileStore{FileStore: srv.FileStore}

	w := httptest.NewRecorder()
	srv.HTTPHandler().ServeHTTP(w, disconnected(streamUploadRequest(pgpBody("data"), "3600", "false", "")))

	if w.Code != 200 {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var resp map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("invalid response JSON: %v", err)
	}
	if _, err := db.Status(streamKeyPrefix + resp["message"]); err != nil {
		t.Fatalf("metadata missing: %v", err)
	}
	if _, err := db.Status(fileDataKeyPrefix + resp["message"]); err != nil {
		t.Fatalf("file missing: %v", err)
	}
}

// An error from Save does not prove that nothing was stored.
func TestStreamUploadSaveErrorCleansUpFile(t *testing.T) {
	db := newTestDB()
	srv := newStreamTestServer(t, db)
	srv.FileStore = &ctxFileStore{FileStore: srv.FileStore, saveErr: errors.New("connection reset by peer")}

	w := httptest.NewRecorder()
	srv.HTTPHandler().ServeHTTP(w, disconnected(streamUploadRequest(pgpBody("data"), "3600", "false", "")))

	if w.Code != 500 {
		t.Fatalf("expected 500, got %d: %s", w.Code, w.Body.String())
	}
	if keys := db.keys(); len(keys) != 0 {
		t.Fatalf("failed upload left data behind: %v", keys)
	}
}

func TestStreamUploadDBErrorCleansUpFileAfterDisconnect(t *testing.T) {
	db := newTestDB()
	srv := newStreamTestServer(t, db)
	srv.DB = newBrokenDB()
	srv.FileStore = &ctxFileStore{FileStore: srv.FileStore}

	w := httptest.NewRecorder()
	srv.HTTPHandler().ServeHTTP(w, disconnected(streamUploadRequest(pgpBody("data"), "3600", "false", "")))

	if w.Code != 500 {
		t.Fatalf("expected 500, got %d: %s", w.Code, w.Body.String())
	}
	if keys := db.keys(); len(keys) != 0 {
		t.Fatalf("failed upload left data behind: %v", keys)
	}
}

func TestDeleteStreamSecretClientDisconnect(t *testing.T) {
	db := newTestDB()
	srv := newStreamTestServer(t, db)
	srv.FileStore = &ctxFileStore{FileStore: srv.FileStore}
	handler := srv.HTTPHandler()
	key := doStreamUpload(t, handler)

	w := httptest.NewRecorder()
	handler.ServeHTTP(w, disconnected(httptest.NewRequest("DELETE", "/file/"+key, nil)))

	if w.Code != 204 {
		t.Fatalf("expected 204, got %d: %s", w.Code, w.Body.String())
	}
	if keys := db.keys(); len(keys) != 0 {
		t.Fatalf("deleted file left data behind: %v", keys)
	}
}

func TestStreamUploadInterruptedBodyCleansUp(t *testing.T) {
	db := newTestDB()
	srv := newStreamTestServer(t, db)
	srv.FileStore = &ctxFileStore{FileStore: srv.FileStore}
	r := streamUploadRequest(pgpBody("data"), "3600", "false", "")
	r.Body = io.NopCloser(io.MultiReader(strings.NewReader("\xc3"), iotest.ErrReader(io.ErrUnexpectedEOF)))
	r.ContentLength = -1
	w := httptest.NewRecorder()
	srv.HTTPHandler().ServeHTTP(w, r)
	if w.Code != http.StatusInternalServerError || len(db.keys()) != 0 {
		t.Fatalf("interrupted upload: status=%d, keys=%v", w.Code, db.keys())
	}
}
