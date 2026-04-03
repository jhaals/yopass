package server

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jhaals/yopass/pkg/yopass"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/spf13/viper"
	"go.uber.org/zap/zaptest"
)

func newBundleTestServer(t *testing.T, db *testDB) Server {
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
		MaxFileSize:         1024 * 1024,
		Registry:            prometheus.NewRegistry(),
		ForceOneTimeSecrets: false,
		Logger:              zaptest.NewLogger(t),
	}
}

func TestCreateBundle(t *testing.T) {
	db := newTestDB()
	srv := newBundleTestServer(t, db)
	handler := srv.HTTPHandler()

	// Upload two files first
	key1 := doStreamUpload(t, handler)
	key2 := doStreamUpload(t, handler)

	// Create bundle
	body := `{"file_keys":["` + key1 + `","` + key2 + `"],"filenames":["a.txt","b.txt"],"sizes":[100,200],"expiration":3600,"one_time":false}`
	req := httptest.NewRequest("POST", "/create/bundle", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
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
		t.Fatal("expected message in response")
	}
}

func TestCreateBundleEmptyFileKeys(t *testing.T) {
	db := newTestDB()
	srv := newBundleTestServer(t, db)
	handler := srv.HTTPHandler()

	body := `{"file_keys":[],"filenames":[],"sizes":[],"expiration":3600,"one_time":false}`
	req := httptest.NewRequest("POST", "/create/bundle", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != 400 {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestCreateBundleMismatchedArrays(t *testing.T) {
	db := newTestDB()
	srv := newBundleTestServer(t, db)
	handler := srv.HTTPHandler()

	body := `{"file_keys":["abc"],"filenames":["a.txt","b.txt"],"sizes":[100],"expiration":3600,"one_time":false}`
	req := httptest.NewRequest("POST", "/create/bundle", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != 400 {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestCreateBundleInvalidExpiration(t *testing.T) {
	db := newTestDB()
	srv := newBundleTestServer(t, db)
	handler := srv.HTTPHandler()

	body := `{"file_keys":["abc"],"filenames":["a.txt"],"sizes":[100],"expiration":9999,"one_time":false}`
	req := httptest.NewRequest("POST", "/create/bundle", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != 400 {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestCreateBundleNonExistentFile(t *testing.T) {
	db := newTestDB()
	srv := newBundleTestServer(t, db)
	handler := srv.HTTPHandler()

	body := `{"file_keys":["nonexistent"],"filenames":["a.txt"],"sizes":[100],"expiration":3600,"one_time":false}`
	req := httptest.NewRequest("POST", "/create/bundle", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != 400 {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestGetBundle(t *testing.T) {
	db := newTestDB()
	srv := newBundleTestServer(t, db)
	handler := srv.HTTPHandler()

	// Upload files and create bundle
	key1 := doStreamUpload(t, handler)
	key2 := doStreamUpload(t, handler)

	body := `{"file_keys":["` + key1 + `","` + key2 + `"],"filenames":["a.txt","b.txt"],"sizes":[100,200],"expiration":3600,"one_time":false}`
	req := httptest.NewRequest("POST", "/create/bundle", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("create bundle failed: %d %s", w.Code, w.Body.String())
	}
	var createResp map[string]string
	json.Unmarshal(w.Body.Bytes(), &createResp)
	bundleKey := createResp["message"]

	// Get bundle
	req = httptest.NewRequest("GET", "/bundle/"+bundleKey, nil)
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != 200 {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var getResp struct {
		Files      []yopass.BundleFile `json:"files"`
		OneTime    bool                `json:"one_time"`
		Expiration int32               `json:"expiration"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &getResp); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if len(getResp.Files) != 2 {
		t.Fatalf("expected 2 files, got %d", len(getResp.Files))
	}
	if getResp.Files[0].Filename != "a.txt" {
		t.Errorf("expected filename a.txt, got %s", getResp.Files[0].Filename)
	}
	if getResp.Files[1].Size != 200 {
		t.Errorf("expected size 200, got %d", getResp.Files[1].Size)
	}
	if getResp.Expiration != 3600 {
		t.Errorf("expected expiration 3600, got %d", getResp.Expiration)
	}
}

func TestGetBundleNotFound(t *testing.T) {
	db := newTestDB()
	srv := newBundleTestServer(t, db)
	handler := srv.HTTPHandler()

	req := httptest.NewRequest("GET", "/bundle/00000000-0000-0000-0000-000000000000", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != 404 {
		t.Fatalf("expected 404, got %d", w.Code)
	}
}

func TestGetBundleOneTime(t *testing.T) {
	db := newTestDB()
	srv := newBundleTestServer(t, db)
	handler := srv.HTTPHandler()

	// Upload file and create one-time bundle
	key1 := doStreamUpload(t, handler)

	body := `{"file_keys":["` + key1 + `"],"filenames":["a.txt"],"sizes":[100],"expiration":3600,"one_time":true}`
	req := httptest.NewRequest("POST", "/create/bundle", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("create bundle failed: %d", w.Code)
	}
	var createResp map[string]string
	json.Unmarshal(w.Body.Bytes(), &createResp)
	bundleKey := createResp["message"]

	// First GET should work
	req = httptest.NewRequest("GET", "/bundle/"+bundleKey, nil)
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("first get failed: %d", w.Code)
	}

	// Second GET should return 404 (one-time bundle was deleted)
	req = httptest.NewRequest("GET", "/bundle/"+bundleKey, nil)
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	if w.Code != 404 {
		t.Fatalf("expected 404 on second get, got %d", w.Code)
	}

	// The referenced file should also be deleted
	req = httptest.NewRequest("GET", "/file/"+key1, nil)
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	if w.Code != 404 {
		t.Fatalf("expected 404 for deleted file, got %d", w.Code)
	}
}

func TestDeleteBundle(t *testing.T) {
	db := newTestDB()
	srv := newBundleTestServer(t, db)
	handler := srv.HTTPHandler()

	key1 := doStreamUpload(t, handler)

	body := `{"file_keys":["` + key1 + `"],"filenames":["a.txt"],"sizes":[100],"expiration":3600,"one_time":false}`
	req := httptest.NewRequest("POST", "/create/bundle", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("create bundle failed: %d", w.Code)
	}
	var createResp map[string]string
	json.Unmarshal(w.Body.Bytes(), &createResp)
	bundleKey := createResp["message"]

	// Delete bundle
	req = httptest.NewRequest("DELETE", "/bundle/"+bundleKey, nil)
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	if w.Code != 204 {
		t.Fatalf("expected 204, got %d: %s", w.Code, w.Body.String())
	}

	// Bundle should be gone
	req = httptest.NewRequest("GET", "/bundle/"+bundleKey, nil)
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	if w.Code != 404 {
		t.Fatalf("expected 404, got %d", w.Code)
	}

	// File should also be gone
	req = httptest.NewRequest("GET", "/file/"+key1, nil)
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	if w.Code != 404 {
		t.Fatalf("expected 404 for file, got %d", w.Code)
	}
}

func TestDeleteBundleNotFound(t *testing.T) {
	db := newTestDB()
	srv := newBundleTestServer(t, db)
	handler := srv.HTTPHandler()

	req := httptest.NewRequest("DELETE", "/bundle/00000000-0000-0000-0000-000000000000", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != 404 {
		t.Fatalf("expected 404, got %d", w.Code)
	}
}

func TestCreateBundleForceOneTime(t *testing.T) {
	db := newTestDB()
	srv := newBundleTestServer(t, db)
	handler := srv.HTTPHandler()

	// Upload a file first (before enabling ForceOneTimeSecrets)
	key1 := doStreamUpload(t, handler)

	// Now create a new server with ForceOneTimeSecrets enabled and the same DB
	srv2 := newBundleTestServer(t, db)
	srv2.ForceOneTimeSecrets = true
	handler2 := srv2.HTTPHandler()

	body := `{"file_keys":["` + key1 + `"],"filenames":["a.txt"],"sizes":[100],"expiration":3600,"one_time":false}`
	req := httptest.NewRequest("POST", "/create/bundle", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler2.ServeHTTP(w, req)

	if w.Code != 400 {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}
