package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
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

	if status, _ := getReceipt(t, handler, id, ""); status != http.StatusUnauthorized {
		t.Errorf("receipt without token: expected 401, got %d", status)
	}
	if status, _ := getReceipt(t, handler, id, "wrong-token"); status != http.StatusUnauthorized {
		t.Errorf("receipt with wrong token: expected 401, got %d", status)
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
