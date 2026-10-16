package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/synctest"
	"time"

	"github.com/jhaals/yopass/pkg/yopass"
)

// createSecretWithReceipt posts a secret with receipt:true and returns the
// secret ID and receipt token.
func createSecretWithReceipt(t *testing.T, handler http.Handler, oneTime bool) (id, token string) {
	t.Helper()
	encrypted, err := yopass.Encrypt(strings.NewReader("hunter2"), "key")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(map[string]interface{}{
		"message":    encrypted,
		"expiration": 3600,
		"one_time":   oneTime,
		"receipt":    true,
	})
	req, _ := http.NewRequest("POST", "/create/secret", bytes.NewReader(body))
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("create secret with receipt: status %d body %s", rr.Code, rr.Body.String())
	}
	var resp struct {
		Message      string `json:"message"`
		ReceiptToken string `json:"receipt_token"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Message == "" || resp.ReceiptToken == "" {
		t.Fatalf("incomplete create response: %+v", resp)
	}
	return resp.Message, resp.ReceiptToken
}

// getReceipt fetches the receipt state with the given token.
func getReceipt(t *testing.T, handler http.Handler, id, token string) (status int, receipt map[string]interface{}) {
	t.Helper()
	req, _ := http.NewRequest("GET", "/secret/"+id+"/receipt", nil)
	if token != "" {
		req.Header.Set(receiptTokenHeader, token)
	}
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	receipt = map[string]interface{}{}
	if rr.Code == http.StatusOK {
		if err := json.Unmarshal(rr.Body.Bytes(), &receipt); err != nil {
			t.Fatal(err)
		}
	}
	return rr.Code, receipt
}

func TestReadReceiptLifecycle(t *testing.T) {
	db := newMemoryDB()
	y := newRequestTestServer(t, db, true)
	handler := y.HTTPHandler()

	id, token := createSecretWithReceipt(t, handler, true)

	// Pending before the secret is opened.
	status, receipt := getReceipt(t, handler, id, token)
	if status != http.StatusOK {
		t.Fatalf("get receipt: status %d", status)
	}
	if receipt["state"] != ReceiptStatePending {
		t.Fatalf("expected pending receipt, got %v", receipt["state"])
	}
	if receipt["one_time"] != true {
		t.Errorf("expected one_time true, got %v", receipt["one_time"])
	}
	if _, ok := receipt["viewed_at"]; ok {
		t.Error("pending receipt must not have viewed_at")
	}

	// The receipt record itself must not be retrievable as a secret.
	if _, err := db.Get(id); err != nil {
		t.Fatal("secret should exist in database")
	}

	// Open the secret.
	req, _ := http.NewRequest("GET", "/secret/"+id, nil)
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("get secret: status %d", rr.Code)
	}

	// The receipt flips to viewed and survives consumption of the one-time secret.
	status, receipt = getReceipt(t, handler, id, token)
	if status != http.StatusOK {
		t.Fatalf("get receipt after view: status %d", status)
	}
	if receipt["state"] != ReceiptStateViewed {
		t.Fatalf("expected viewed receipt, got %v", receipt["state"])
	}
	viewedAt, ok := receipt["viewed_at"].(float64)
	if !ok || int64(viewedAt) > time.Now().Unix() || int64(viewedAt) == 0 {
		t.Errorf("unexpected viewed_at: %v", receipt["viewed_at"])
	}

	// Receipts stay checkable repeatedly.
	status, _ = getReceipt(t, handler, id, token)
	if status != http.StatusOK {
		t.Fatalf("receipt should remain readable: status %d", status)
	}
}

func TestReadReceiptTokenRequired(t *testing.T) {
	y := newRequestTestServer(t, newMemoryDB(), true)
	handler := y.HTTPHandler()
	id, _ := createSecretWithReceipt(t, handler, false)

	if status, _ := getReceipt(t, handler, id, ""); status != http.StatusNotFound {
		t.Errorf("receipt without token: expected 404, got %d", status)
	}
	if status, _ := getReceipt(t, handler, id, "wrong-token"); status != http.StatusNotFound {
		t.Errorf("receipt with wrong token: expected 404, got %d", status)
	}
}

// Without a valid token the response must not depend on whether a receipt
// exists: the secret ID alone must not reveal that the sender is tracking the
// secret, neither before nor after a one-time secret has been consumed.
func TestReadReceiptNoExistenceOracle(t *testing.T) {
	y := newRequestTestServer(t, newMemoryDB(), true)
	handler := y.HTTPHandler()
	tracked, _ := createSecretWithReceipt(t, handler, true)

	encrypted, err := yopass.Encrypt(strings.NewReader("hunter2"), "key")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(map[string]interface{}{
		"message":    encrypted,
		"expiration": 3600,
		"one_time":   true,
	})
	req, _ := http.NewRequest("POST", "/create/secret", bytes.NewReader(body))
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("create secret without receipt: status %d body %s", rr.Code, rr.Body.String())
	}
	var created struct {
		Message string `json:"message"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	untracked := created.Message

	probe := func(id, token string) (int, string) {
		req, _ := http.NewRequest("GET", "/secret/"+id+"/receipt", nil)
		if token != "" {
			req.Header.Set(receiptTokenHeader, token)
		}
		rr := httptest.NewRecorder()
		handler.ServeHTTP(rr, req)
		return rr.Code, rr.Body.String()
	}
	wantStatus, wantBody := probe(untracked, "")
	for _, token := range []string{"", "wrong-token"} {
		if status, body := probe(tracked, token); status != wantStatus || body != wantBody {
			t.Errorf("token %q distinguishes a tracked secret: %d %q vs %d %q",
				token, status, body, wantStatus, wantBody)
		}
	}

	// The receipt outlives the consumed one-time secret; the probe must not
	// reveal that either.
	rr = httptest.NewRecorder()
	handler.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/secret/"+tracked, nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("consume one-time secret: status %d", rr.Code)
	}
	if status, body := probe(tracked, ""); status != wantStatus || body != wantBody {
		t.Errorf("token-less probe distinguishes a consumed tracked secret: %d %q vs %d %q",
			status, body, wantStatus, wantBody)
	}
}

func TestReadReceiptNotFound(t *testing.T) {
	y := newRequestTestServer(t, newMemoryDB(), true)
	handler := y.HTTPHandler()

	// A secret created without a receipt has none.
	encrypted, err := yopass.Encrypt(strings.NewReader("hunter2"), "key")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(map[string]interface{}{
		"message":    encrypted,
		"expiration": 3600,
	})
	req, _ := http.NewRequest("POST", "/create/secret", bytes.NewReader(body))
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	var created struct {
		Message      string `json:"message"`
		ReceiptToken string `json:"receipt_token"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if created.ReceiptToken != "" {
		t.Fatal("receipt token must not be issued unless requested")
	}
	if status, _ := getReceipt(t, handler, created.Message, "any"); status != http.StatusNotFound {
		t.Errorf("receipt for secret without one: expected 404, got %d", status)
	}
}

func TestReadReceiptRequiresLicense(t *testing.T) {
	y := newRequestTestServer(t, newMemoryDB(), false)
	handler := y.HTTPHandler()

	encrypted, err := yopass.Encrypt(strings.NewReader("hunter2"), "key")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(map[string]interface{}{
		"message":    encrypted,
		"expiration": 3600,
		"receipt":    true,
	})
	req, _ := http.NewRequest("POST", "/create/secret", bytes.NewReader(body))
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("unlicensed receipt creation should be 400: status %d body %s", rr.Code, rr.Body.String())
	}

	// Creating without a receipt still works.
	body, _ = json.Marshal(map[string]interface{}{
		"message":    encrypted,
		"expiration": 3600,
	})
	req, _ = http.NewRequest("POST", "/create/secret", bytes.NewReader(body))
	rr = httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("plain secret creation should still work: status %d", rr.Code)
	}

	// Config must report the feature as disabled.
	req, _ = http.NewRequest("GET", "/config", nil)
	rr = httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	var config map[string]interface{}
	if err := json.Unmarshal(rr.Body.Bytes(), &config); err != nil {
		t.Fatal(err)
	}
	if config["READ_RECEIPTS"] != false {
		t.Fatalf("READ_RECEIPTS should be false without license: %v", config["READ_RECEIPTS"])
	}
}

func TestReadReceiptDisableFlag(t *testing.T) {
	y := newRequestTestServer(t, newMemoryDB(), true)
	y.DisableReadReceipts = true
	handler := y.HTTPHandler()

	encrypted, err := yopass.Encrypt(strings.NewReader("hunter2"), "key")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(map[string]interface{}{
		"message":    encrypted,
		"expiration": 3600,
		"receipt":    true,
	})
	req, _ := http.NewRequest("POST", "/create/secret", bytes.NewReader(body))
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("disabled receipt creation should be 400: status %d", rr.Code)
	}

	req, _ = http.NewRequest("GET", "/config", nil)
	rr = httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	var config map[string]interface{}
	if err := json.Unmarshal(rr.Body.Bytes(), &config); err != nil {
		t.Fatal(err)
	}
	if config["READ_RECEIPTS"] != false {
		t.Fatalf("READ_RECEIPTS should be false when disabled: %v", config["READ_RECEIPTS"])
	}
}

func TestReadReceiptConfigEnabled(t *testing.T) {
	y := newRequestTestServer(t, newMemoryDB(), true)
	handler := y.HTTPHandler()

	req, _ := http.NewRequest("GET", "/config", nil)
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	var config map[string]interface{}
	if err := json.Unmarshal(rr.Body.Bytes(), &config); err != nil {
		t.Fatal(err)
	}
	if config["READ_RECEIPTS"] != true {
		t.Fatalf("READ_RECEIPTS should be true with license: %v", config["READ_RECEIPTS"])
	}

	// Read-only instances do not offer the creation toggle.
	y2 := newRequestTestServer(t, newMemoryDB(), true)
	y2.ReadOnly = true
	handler = y2.HTTPHandler()
	rr = httptest.NewRecorder()
	req, _ = http.NewRequest("GET", "/config", nil)
	handler.ServeHTTP(rr, req)
	if err := json.Unmarshal(rr.Body.Bytes(), &config); err != nil {
		t.Fatal(err)
	}
	if config["READ_RECEIPTS"] != false {
		t.Fatalf("READ_RECEIPTS should be false in read-only mode: %v", config["READ_RECEIPTS"])
	}
}

// TestReadReceiptCheckableOnReadOnlyInstance covers split deployments: the
// receipt endpoint and viewed-marking work on instances without a license.
func TestReadReceiptCheckableOnReadOnlyInstance(t *testing.T) {
	db := newMemoryDB()
	writer := newRequestTestServer(t, db, true)
	writerHandler := writer.HTTPHandler()
	id, token := createSecretWithReceipt(t, writerHandler, true)

	reader := newRequestTestServer(t, db, false)
	reader.ReadOnly = true
	readerHandler := reader.HTTPHandler()

	// The recipient opens the secret on the unlicensed read-only instance.
	req, _ := http.NewRequest("GET", "/secret/"+id, nil)
	rr := httptest.NewRecorder()
	readerHandler.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("get secret on read-only instance: status %d", rr.Code)
	}

	// The creator checks the receipt — on either instance.
	status, receipt := getReceipt(t, readerHandler, id, token)
	if status != http.StatusOK || receipt["state"] != ReceiptStateViewed {
		t.Fatalf("receipt on read-only instance: status %d state %v", status, receipt["state"])
	}
}

func TestReadReceiptExpired(t *testing.T) {
	db := newMemoryDB()
	y := newRequestTestServer(t, db, true)
	handler := y.HTTPHandler()
	id, token := createSecretWithReceipt(t, handler, false)

	// Simulate TTL expiry by rewriting the stored record with a past ExpiresAt.
	stored := db.data[receiptKeyPrefix+id]
	var r secretReceipt
	if err := json.Unmarshal([]byte(stored.Message), &r); err != nil {
		t.Fatal(err)
	}
	r.ExpiresAt = time.Now().Unix() - 1
	data, _ := json.Marshal(r)
	db.data[receiptKeyPrefix+id] = yopass.Secret{Message: string(data)}

	if status, _ := getReceipt(t, handler, id, token); status != http.StatusNotFound {
		t.Errorf("expired receipt should return 404, got %d", status)
	}
}

// uploadFileWithReceipt uploads a file with the receipt header and returns
// the file ID and receipt token.
func uploadFileWithReceipt(t *testing.T, handler http.Handler) (id, token string) {
	t.Helper()
	encrypted, err := yopass.EncryptBinary(strings.NewReader("file content"), "key", "file.txt")
	if err != nil {
		t.Fatal(err)
	}
	req, _ := http.NewRequest("POST", "/create/file", bytes.NewReader(encrypted))
	req.Header.Set("Content-Type", "application/octet-stream")
	req.Header.Set("X-Yopass-Expiration", "3600")
	req.Header.Set("X-Yopass-OneTime", "true")
	req.Header.Set("X-Yopass-Receipt", "true")
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("upload with receipt: status %d body %s", rr.Code, rr.Body.String())
	}
	var resp struct {
		Message      string `json:"message"`
		ReceiptToken string `json:"receipt_token"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Message == "" || resp.ReceiptToken == "" {
		t.Fatalf("incomplete upload response: %+v", resp)
	}
	return resp.Message, resp.ReceiptToken
}

func TestReadReceiptFileLifecycle(t *testing.T) {
	y := newRequestTestServer(t, newMemoryDB(), true)
	y.MaxFileSize = 1024 * 1024
	handler := y.HTTPHandler()

	id, token := uploadFileWithReceipt(t, handler)

	// Pending before download — checkable via both route forms.
	for _, path := range []string{"/secret/" + id + "/receipt", "/file/" + id + "/receipt"} {
		req, _ := http.NewRequest("GET", path, nil)
		req.Header.Set(receiptTokenHeader, token)
		rr := httptest.NewRecorder()
		handler.ServeHTTP(rr, req)
		if rr.Code != http.StatusOK {
			t.Fatalf("get receipt via %s: status %d", path, rr.Code)
		}
		var receipt map[string]interface{}
		if err := json.Unmarshal(rr.Body.Bytes(), &receipt); err != nil {
			t.Fatal(err)
		}
		if receipt["state"] != ReceiptStatePending {
			t.Fatalf("expected pending receipt via %s, got %v", path, receipt["state"])
		}
	}

	// Download the file.
	req, _ := http.NewRequest("GET", "/file/"+id, nil)
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("download: status %d", rr.Code)
	}

	// The receipt flips to viewed and survives one-time consumption.
	req, _ = http.NewRequest("GET", "/file/"+id+"/receipt", nil)
	req.Header.Set(receiptTokenHeader, token)
	rr = httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("get receipt after download: status %d", rr.Code)
	}
	var receipt map[string]interface{}
	if err := json.Unmarshal(rr.Body.Bytes(), &receipt); err != nil {
		t.Fatal(err)
	}
	if receipt["state"] != ReceiptStateViewed {
		t.Fatalf("expected viewed receipt, got %v", receipt["state"])
	}
}

func TestReadReceiptFileRequiresLicense(t *testing.T) {
	y := newRequestTestServer(t, newMemoryDB(), false)
	y.MaxFileSize = 1024 * 1024
	handler := y.HTTPHandler()

	encrypted, err := yopass.EncryptBinary(strings.NewReader("file content"), "key", "file.txt")
	if err != nil {
		t.Fatal(err)
	}
	req, _ := http.NewRequest("POST", "/create/file", bytes.NewReader(encrypted))
	req.Header.Set("Content-Type", "application/octet-stream")
	req.Header.Set("X-Yopass-Expiration", "3600")
	req.Header.Set("X-Yopass-Receipt", "true")
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("unlicensed file receipt should be 400: status %d", rr.Code)
	}

	// Upload without the receipt header still works and issues no token.
	req, _ = http.NewRequest("POST", "/create/file", bytes.NewReader(encrypted))
	req.Header.Set("Content-Type", "application/octet-stream")
	req.Header.Set("X-Yopass-Expiration", "3600")
	rr = httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("plain upload should work: status %d", rr.Code)
	}
	var resp struct {
		ReceiptToken string `json:"receipt_token"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.ReceiptToken != "" {
		t.Fatal("receipt token must not be issued unless requested")
	}
}

func TestReadReceiptAuditTrail(t *testing.T) {
	y := newRequestTestServer(t, newMemoryDB(), true)
	audit := &capturingAuditLogger{}
	y.Audit = audit
	handler := y.HTTPHandler()

	id, token := createSecretWithReceipt(t, handler, false)
	getReceipt(t, handler, id, token)
	getReceipt(t, handler, id, "wrong")

	expected := []struct {
		event   string
		outcome AuditOutcome
	}{
		{"secret.created", OutcomeSuccess},
		{"secret.receipt_checked", OutcomeSuccess},
		{"secret.receipt_checked", OutcomeDenied},
	}
	if len(audit.events) != len(expected) {
		t.Fatalf("expected %d audit events, got %d: %+v", len(expected), len(audit.events), audit.events)
	}
	for i, want := range expected {
		got := audit.events[i]
		if got.Event != want.event || got.Outcome != want.outcome || got.SecretID != redactSecretID(id) {
			t.Errorf("event %d: got {%s %s %s}, want {%s %s}", i, got.Event, got.Outcome, got.SecretID, want.event, want.outcome)
		}
	}
}

// deadlineDB records when the backend would expire each key it stores.
type deadlineDB struct {
	*memoryDB
	deadlines map[string]time.Time
}

func (db *deadlineDB) Put(key string, secret yopass.Secret) error {
	db.deadlines[key] = time.Now().Add(time.Duration(secret.Expiration) * time.Second)
	return db.memoryDB.Put(key, secret)
}

// pausingReader delivers its first byte at once and the rest after a pause.
type pausingReader struct {
	io.Reader
	pause time.Duration
	reads int
}

func (r *pausingReader) Read(p []byte) (int, error) {
	r.reads++
	if r.reads == 1 {
		return r.Reader.Read(p[:1])
	}
	if r.reads == 2 {
		time.Sleep(r.pause)
	}
	return r.Reader.Read(p)
}

// A retrieval is only recorded while the receipt is alive, so the receipt must
// not lapse before the secret or file it belongs to.
func TestReadReceiptOutlivesSecret(t *testing.T) {
	assertOutlives := func(t *testing.T, db *deadlineDB, handler http.Handler, secretKey, id, token string) {
		t.Helper()
		secretDeadline := db.deadlines[secretKey]
		if secretDeadline.IsZero() {
			t.Fatalf("no deadline recorded for %q", secretKey)
		}
		if receiptDeadline := db.deadlines[receiptKeyPrefix+id]; receiptDeadline.Before(secretDeadline) {
			t.Errorf("receipt record expires %v before the secret", secretDeadline.Sub(receiptDeadline))
		}
		_, receipt := getReceipt(t, handler, id, token)
		if expiresAt := time.Unix(int64(receipt["expires_at"].(float64)), 0); expiresAt.Before(secretDeadline) {
			t.Errorf("receipt expires_at is %v before the secret's deadline", secretDeadline.Sub(expiresAt))
		}
	}

	t.Run("text secret created late in a second", func(t *testing.T) {
		synctest.Test(t, func(t *testing.T) {
			db := &deadlineDB{newMemoryDB(), map[string]time.Time{}}
			y := newRequestTestServer(t, db, true)
			handler := y.HTTPHandler()
			time.Sleep(900 * time.Millisecond)
			id, token := createSecretWithReceipt(t, handler, true)
			assertOutlives(t, db, handler, id, id, token)
		})
	})

	t.Run("file uploaded slowly", func(t *testing.T) {
		synctest.Test(t, func(t *testing.T) {
			db := &deadlineDB{newMemoryDB(), map[string]time.Time{}}
			y := newRequestTestServer(t, db, true)
			y.MaxFileSize = 1024
			handler := y.HTTPHandler()

			body := &pausingReader{Reader: bytes.NewReader([]byte{0xC3, 0x01, 0x02, 0x03}), pause: 2 * time.Minute}
			req, _ := http.NewRequest("POST", "/create/file", body)
			req.Header.Set("Content-Type", "application/octet-stream")
			req.Header.Set("X-Yopass-Expiration", "3600")
			req.Header.Set("X-Yopass-OneTime", "true")
			req.Header.Set("X-Yopass-Receipt", "true")
			rr := httptest.NewRecorder()
			handler.ServeHTTP(rr, req)
			var resp struct {
				Message      string `json:"message"`
				ReceiptToken string `json:"receipt_token"`
			}
			if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil || resp.ReceiptToken == "" {
				t.Fatalf("upload with receipt: status %d body %s", rr.Code, rr.Body.String())
			}
			assertOutlives(t, db, handler, streamKeyPrefix+resp.Message, resp.Message, resp.ReceiptToken)
		})
	})
}

// pausingWriter takes a while to accept the response body.
type pausingWriter struct {
	*httptest.ResponseRecorder
	pause time.Duration
}

func (w *pausingWriter) Write(p []byte) (int, error) {
	time.Sleep(w.pause)
	return w.ResponseRecorder.Write(p)
}

// A download that starts while the file is alive is recorded even when the
// receipt lapses before the last byte is delivered.
func TestReadReceiptRecordsSlowDownload(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		db := newMemoryDB()
		y := newRequestTestServer(t, db, true)
		y.MaxFileSize = 1024 * 1024
		handler := y.HTTPHandler()
		id, _ := uploadFileWithReceipt(t, handler)

		time.Sleep(3599 * time.Second)
		req, _ := http.NewRequest("GET", "/file/"+id, nil)
		rr := &pausingWriter{httptest.NewRecorder(), 2 * time.Minute}
		handler.ServeHTTP(rr, req)
		if rr.Code != http.StatusOK {
			t.Fatalf("download: status %d", rr.Code)
		}

		var r secretReceipt
		if err := json.Unmarshal([]byte(db.data[receiptKeyPrefix+id].Message), &r); err != nil {
			t.Fatal(err)
		}
		if r.State != ReceiptStateViewed {
			t.Fatalf("expected viewed receipt, got %q", r.State)
		}
	})
}

// receiptFailingDB cannot store read receipts.
type receiptFailingDB struct {
	*memoryDB
}

func (db receiptFailingDB) Put(key string, secret yopass.Secret) error {
	if strings.HasPrefix(key, receiptKeyPrefix) {
		return errors.New("receipt write failed")
	}
	return db.memoryDB.Put(key, secret)
}

// A secret or file whose requested receipt cannot be stored is not kept.
func TestReadReceiptStoreFailureRemovesSecret(t *testing.T) {
	encrypted, err := yopass.Encrypt(strings.NewReader("hunter2"), "key")
	if err != nil {
		t.Fatal(err)
	}
	secret, _ := json.Marshal(map[string]interface{}{"message": encrypted, "expiration": 3600, "receipt": true})
	secretReq, _ := http.NewRequest("POST", "/create/secret", bytes.NewReader(secret))

	fileReq, _ := http.NewRequest("POST", "/create/file", bytes.NewReader([]byte{0xC3, 0x01, 0x02, 0x03}))
	fileReq.Header.Set("Content-Type", "application/octet-stream")
	fileReq.Header.Set("X-Yopass-Expiration", "3600")
	fileReq.Header.Set("X-Yopass-Receipt", "true")

	for _, req := range []*http.Request{secretReq, fileReq} {
		t.Run(req.URL.Path, func(t *testing.T) {
			db := receiptFailingDB{newMemoryDB()}
			y := newRequestTestServer(t, db, true)
			y.MaxFileSize = 1024
			rr := httptest.NewRecorder()
			y.HTTPHandler().ServeHTTP(rr, req)
			if rr.Code != http.StatusInternalServerError {
				t.Fatalf("expected 500, got %d body %s", rr.Code, rr.Body.String())
			}
			if len(db.data) != 0 {
				t.Fatalf("expected nothing to be stored, got %d records", len(db.data))
			}
		})
	}
}

func TestReadReceiptMaximumLifetime(t *testing.T) {
	db := newMemoryDB()
	y := newRequestTestServer(t, db, true)
	token, err := y.createReceipt("long-lived", true, math.MaxInt32)
	if err != nil {
		t.Fatal(err)
	}
	r, loadErr := y.loadReceipt("long-lived")
	if loadErr != nil || !r.tokenValid(token) || r.remainingTTL() != math.MaxInt32 {
		t.Fatalf("invalid maximum-lifetime receipt: %+v", r)
	}
	y.markReceiptViewed("long-lived")
	r, loadErr = y.loadReceipt("long-lived")
	if loadErr != nil || r.State != ReceiptStateViewed {
		t.Fatal("maximum-lifetime receipt cannot be marked viewed")
	}
}

type cancelingReceiptDB struct {
	*memoryDB
	cancel context.CancelFunc
}

func (db cancelingReceiptDB) Put(key string, secret yopass.Secret) error {
	if strings.HasPrefix(key, receiptKeyPrefix) {
		db.cancel()
		return errors.New("receipt write failed")
	}
	return db.memoryDB.Put(key, secret)
}

type rollbackContextStore struct {
	FileStore
	deleted bool
}

func (s *rollbackContextStore) Delete(ctx context.Context, key string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if _, ok := ctx.Deadline(); !ok {
		return errors.New("missing cleanup deadline")
	}
	s.deleted = true
	return s.FileStore.Delete(ctx, key)
}
func TestReadReceiptFailureCleansFileAfterDisconnect(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	db := cancelingReceiptDB{newMemoryDB(), cancel}
	y := newRequestTestServer(t, db, true)
	y.MaxFileSize = 1024
	y.FileStore = NewDatabaseFileStore(db)
	y.License = LicenseStatus{Valid: true, ExpiresAt: time.Now().Add(time.Hour)}
	store := &rollbackContextStore{FileStore: y.FileStore}
	y.FileStore = store
	req := httptest.NewRequest("POST", "/create/file", strings.NewReader(pgpBody("data"))).WithContext(ctx)
	req.Header.Set("Content-Type", "application/octet-stream")
	req.Header.Set("X-Yopass-Expiration", "3600")
	req.Header.Set("X-Yopass-Receipt", "true")
	w := httptest.NewRecorder()
	y.HTTPHandler().ServeHTTP(w, req)
	if w.Code != http.StatusInternalServerError || !store.deleted {
		t.Fatalf("status=%d, deleted=%v", w.Code, store.deleted)
	}
	if len(db.data) != 0 {
		t.Fatal("upload metadata or data survived rollback")
	}
}

// receiptUpdateRefusingDB refuses receipt updates while reads and claims keep
// working, like a Redis that has reached maxmemory.
type receiptUpdateRefusingDB struct {
	*memoryDB
	refuse bool
}

func (db *receiptUpdateRefusingDB) Update(key string, fn func(yopass.Secret) (yopass.Secret, error)) error {
	if db.refuse && strings.HasPrefix(key, receiptKeyPrefix) {
		return errors.New("update failed")
	}
	return db.memoryDB.Update(key, fn)
}

// A retrieval that cannot be recorded on the read receipt must be refused
// without consuming the secret, and must succeed once the receipt can be
// written again.
func TestReadReceiptUpdateFailureKeepsSecret(t *testing.T) {
	for name, create := range map[string]func(*testing.T, http.Handler) (path, id, token string){
		"one-time secret": func(t *testing.T, h http.Handler) (string, string, string) {
			id, token := createSecretWithReceipt(t, h, true)
			return "/secret/" + id, id, token
		},
		"reusable secret": func(t *testing.T, h http.Handler) (string, string, string) {
			id, token := createSecretWithReceipt(t, h, false)
			return "/secret/" + id, id, token
		},
		"one-time file": func(t *testing.T, h http.Handler) (string, string, string) {
			id, token := uploadFileWithReceipt(t, h)
			return "/file/" + id, id, token
		},
	} {
		t.Run(name, func(t *testing.T) {
			db := &receiptUpdateRefusingDB{memoryDB: newMemoryDB()}
			y := newRequestTestServer(t, db, true)
			y.MaxFileSize = 1024 * 1024
			handler := y.HTTPHandler()
			path, id, token := create(t, handler)

			db.refuse = true
			rr := httptest.NewRecorder()
			handler.ServeHTTP(rr, httptest.NewRequest("GET", path, nil))
			if rr.Code != http.StatusServiceUnavailable {
				t.Fatalf("released without a receipt: status %d", rr.Code)
			}
			if _, receipt := getReceipt(t, handler, id, token); receipt["state"] != ReceiptStatePending {
				t.Fatalf("expected pending receipt, got %v", receipt["state"])
			}

			db.refuse = false
			rr = httptest.NewRecorder()
			handler.ServeHTTP(rr, httptest.NewRequest("GET", path, nil))
			if rr.Code != http.StatusOK {
				t.Fatalf("retrieval after recovery: status %d body %s", rr.Code, rr.Body.String())
			}
			if _, receipt := getReceipt(t, handler, id, token); receipt["state"] != ReceiptStateViewed {
				t.Fatalf("expected viewed receipt, got %v", receipt["state"])
			}
		})
	}
}

// The receipt is written before the claim, but not before authorization: a
// denied retrieval leaves it pending.
func TestReadReceiptUnchangedByDeniedRetrieval(t *testing.T) {
	db := newMemoryDB()
	y := newRequestTestServer(t, db, true)
	handler := y.HTTPHandler()
	id, token := createSecretWithReceipt(t, handler, true)
	secret, err := db.Status(id)
	if err != nil {
		t.Fatal(err)
	}
	secret.RequireAuth = true
	if err := db.Put(id, secret); err != nil {
		t.Fatal(err)
	}

	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, httptest.NewRequest("GET", "/secret/"+id, nil))
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rr.Code)
	}
	if _, receipt := getReceipt(t, handler, id, token); receipt["state"] != ReceiptStatePending {
		t.Fatalf("expected pending receipt, got %v", receipt["state"])
	}
}
