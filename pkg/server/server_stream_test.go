package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/spf13/viper"
	"go.uber.org/zap/zaptest"
)

func newStreamTestServer(t *testing.T, db *testDB) Server {
	t.Helper()
	prevPrefetchSecret := viper.Get("prefetch-secret")
	prevDisableUpload := viper.Get("disable-upload")
	t.Cleanup(func() {
		viper.Set("prefetch-secret", prevPrefetchSecret)
		viper.Set("disable-upload", prevDisableUpload)
	})
	viper.Set("prefetch-secret", true)
	viper.Set("disable-upload", false)
	return Server{
		DB:                  db,
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

func TestStreamUploadDBError(t *testing.T) {
	db := newTestDB()
	_ = newStreamTestServer(t, db)

	// Upload succeeds but simulate DB error by using brokenDB for metadata storage
	brokeSrv := Server{
		DB:          &brokenDB{},
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
