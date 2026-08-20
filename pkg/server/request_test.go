package server

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ProtonMail/go-crypto/openpgp"
	"github.com/ProtonMail/go-crypto/openpgp/armor"
	"github.com/ProtonMail/go-crypto/openpgp/packet"
	"github.com/jhaals/yopass/pkg/yopass"
	"github.com/prometheus/client_golang/prometheus"
	"go.uber.org/zap/zaptest"
)

// memoryDB is a stateful in-memory Database used to exercise the full secret
// request lifecycle.
type memoryDB struct {
	mu   sync.Mutex
	data map[string]yopass.Secret
}

func newMemoryDB() *memoryDB {
	return &memoryDB{data: map[string]yopass.Secret{}}
}

func (db *memoryDB) Get(key string) (yopass.Secret, error) {
	db.mu.Lock()
	defer db.mu.Unlock()
	s, ok := db.data[key]
	if !ok {
		return yopass.Secret{}, fmt.Errorf("not found")
	}
	return s, nil
}

func (db *memoryDB) Status(key string) (yopass.Secret, error) {
	return db.Get(key)
}

func (db *memoryDB) Put(key string, secret yopass.Secret) error {
	db.mu.Lock()
	defer db.mu.Unlock()
	db.data[key] = secret
	return nil
}

func (db *memoryDB) Delete(key string) (bool, error) {
	db.mu.Lock()
	defer db.mu.Unlock()
	if _, ok := db.data[key]; !ok {
		return false, nil
	}
	delete(db.data, key)
	return true, nil
}

func (db *memoryDB) Update(key string, fn func(yopass.Secret) (yopass.Secret, error)) error {
	db.mu.Lock()
	defer db.mu.Unlock()
	s, ok := db.data[key]
	if !ok {
		return ErrKeyNotFound
	}
	updated, err := fn(s)
	if err != nil {
		return err
	}
	db.data[key] = updated
	return nil
}

func (db *memoryDB) Health() error { return nil }

// testPublicKey generates a fresh armored PGP public key.
func testPublicKey(t *testing.T) string {
	t.Helper()
	cfg := &packet.Config{
		Algorithm: packet.PubKeyAlgoEdDSA,
		Curve:     packet.Curve25519,
	}
	entity, err := openpgp.NewEntity("yopass-test", "", "test@example.com", cfg)
	if err != nil {
		t.Fatalf("failed to generate key: %v", err)
	}
	var buf bytes.Buffer
	aw, err := armor.Encode(&buf, openpgp.PublicKeyType, nil)
	if err != nil {
		t.Fatalf("failed to create armor encoder: %v", err)
	}
	if err := entity.Serialize(aw); err != nil {
		t.Fatalf("failed to serialize public key: %v", err)
	}
	if err := aw.Close(); err != nil {
		t.Fatalf("failed to close armor encoder: %v", err)
	}
	return buf.String()
}

func newRequestTestServer(t *testing.T, db Database, licensed bool) Server {
	t.Helper()
	license := LicenseStatus{}
	if licensed {
		license = LicenseStatus{Valid: true, ExpiresAt: time.Now().Add(24 * time.Hour)}
	}
	return Server{
		DB:        db,
		MaxLength: 10000,
		Registry:  prometheus.NewRegistry(),
		Logger:    zaptest.NewLogger(t),
		License:   license,
	}
}

func createRequest(t *testing.T, handler http.Handler, publicKey, label string, expiration int32) (id, token string) {
	t.Helper()
	body, _ := json.Marshal(map[string]interface{}{
		"public_key": publicKey,
		"label":      label,
		"expiration": expiration,
	})
	req, _ := http.NewRequest("POST", "/request", bytes.NewReader(body))
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("create request failed: status %d body %s", rr.Code, rr.Body.String())
	}
	var resp struct {
		ID        string `json:"id"`
		Token     string `json:"token"`
		ExpiresAt int64  `json:"expires_at"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to decode create response: %v", err)
	}
	if resp.ID == "" || resp.Token == "" || resp.ExpiresAt <= time.Now().Unix() {
		t.Fatalf("incomplete create response: %+v", resp)
	}
	return resp.ID, resp.Token
}

func TestSecretRequestLifecycle(t *testing.T) {
	db := newMemoryDB()
	y := newRequestTestServer(t, db, true)
	handler := y.HTTPHandler()
	publicKey := testPublicKey(t)

	id, token := createRequest(t, handler, publicKey, "prod db password", 3600)

	// Responder fetches the request info
	req, _ := http.NewRequest("GET", "/request/"+id, nil)
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("get request: status %d", rr.Code)
	}
	var info struct {
		PublicKey string `json:"public_key"`
		Label     string `json:"label"`
		State     string `json:"state"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &info); err != nil {
		t.Fatal(err)
	}
	if info.PublicKey != publicKey || info.Label != "prod db password" || info.State != RequestStatePending {
		t.Fatalf("unexpected request info: %+v", info)
	}

	// The stored request must not be reachable through the secret endpoints
	req, _ = http.NewRequest("GET", "/secret/"+id, nil)
	rr = httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusNotFound {
		t.Fatalf("request must not be readable via /secret: status %d", rr.Code)
	}

	// Responder provides the secret
	encrypted, err := yopass.Encrypt(strings.NewReader("hunter2"), "decryptionkey")
	if err != nil {
		t.Fatal(err)
	}
	fulfillBody, _ := json.Marshal(map[string]string{"message": encrypted})
	req, _ = http.NewRequest("POST", "/request/"+id+"/secret", bytes.NewReader(fulfillBody))
	rr = httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("fulfill: status %d body %s", rr.Code, rr.Body.String())
	}

	// Fulfilling twice is rejected
	req, _ = http.NewRequest("POST", "/request/"+id+"/secret", bytes.NewReader(fulfillBody))
	rr = httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusConflict {
		t.Fatalf("second fulfill should conflict: status %d", rr.Code)
	}

	// Requester sees the fulfilled state
	req, _ = http.NewRequest("GET", "/request/"+id, nil)
	rr = httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if err := json.Unmarshal(rr.Body.Bytes(), &info); err != nil {
		t.Fatal(err)
	}
	if info.State != RequestStateFulfilled {
		t.Fatalf("expected fulfilled state, got %q", info.State)
	}

	// Fetching the secret without or with a wrong token is denied
	req, _ = http.NewRequest("GET", "/request/"+id+"/secret", nil)
	rr = httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("fetch without token: status %d", rr.Code)
	}
	req, _ = http.NewRequest("GET", "/request/"+id+"/secret", nil)
	req.Header.Set(requestTokenHeader, "wrong-token")
	rr = httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("fetch with wrong token: status %d", rr.Code)
	}

	// Fetching with the management token returns the ciphertext once
	req, _ = http.NewRequest("GET", "/request/"+id+"/secret", nil)
	req.Header.Set(requestTokenHeader, token)
	rr = httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("fetch secret: status %d body %s", rr.Code, rr.Body.String())
	}
	var secretResp struct {
		Message string `json:"message"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &secretResp); err != nil {
		t.Fatal(err)
	}
	if secretResp.Message != encrypted {
		t.Fatal("retrieved ciphertext does not match")
	}

	// The request is deleted after retrieval
	req, _ = http.NewRequest("GET", "/request/"+id, nil)
	rr = httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusNotFound {
		t.Fatalf("request should be gone after secret retrieval: status %d", rr.Code)
	}
}

// TestSecretRequestLicenseExpiresAtRuntime covers a license expiring while
// the server runs: the routes were registered at startup, so creating new
// requests must be rejected per request, while already-issued requests stay
// fully usable (viewed, fulfilled and fetched) until their TTL drains them.
func TestSecretRequestLicenseExpiresAtRuntime(t *testing.T) {
	y := newRequestTestServer(t, newMemoryDB(), true)
	handler := y.HTTPHandler()

	// Issued while the license is valid.
	id, token := createRequest(t, handler, testPublicKey(t), "prod db password", 3600)

	// The license expires mid-run.
	y.License = LicenseStatus{Valid: true, Licensee: "acme", ExpiresAt: time.Now().Add(-time.Minute)}

	// Creating a new request is now rejected.
	body, _ := json.Marshal(map[string]interface{}{
		"public_key": testPublicKey(t),
		"expiration": 3600,
	})
	req, _ := http.NewRequest("POST", "/request", bytes.NewReader(body))
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusForbidden {
		t.Fatalf("create after expiry: expected 403, got %d body %s", rr.Code, rr.Body.String())
	}

	// The existing request can still be viewed by the responder...
	req, _ = http.NewRequest("GET", "/request/"+id, nil)
	rr = httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("get after expiry: expected 200, got %d", rr.Code)
	}

	// ...fulfilled...
	encrypted, err := yopass.Encrypt(strings.NewReader("hunter2"), "decryptionkey")
	if err != nil {
		t.Fatal(err)
	}
	fulfillBody, _ := json.Marshal(map[string]string{"message": encrypted})
	req, _ = http.NewRequest("POST", "/request/"+id+"/secret", bytes.NewReader(fulfillBody))
	rr = httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("fulfill after expiry: expected 200, got %d body %s", rr.Code, rr.Body.String())
	}

	// ...and fetched by the requester.
	req, _ = http.NewRequest("GET", "/request/"+id+"/secret", nil)
	req.Header.Set(requestTokenHeader, token)
	rr = httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("fetch after expiry: expected 200, got %d body %s", rr.Code, rr.Body.String())
	}
}

func TestSecretRequestFetchBeforeFulfillment(t *testing.T) {
	y := newRequestTestServer(t, newMemoryDB(), true)
	handler := y.HTTPHandler()
	id, token := createRequest(t, handler, testPublicKey(t), "", 3600)

	req, _ := http.NewRequest("GET", "/request/"+id+"/secret", nil)
	req.Header.Set(requestTokenHeader, token)
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusConflict {
		t.Fatalf("fetch before fulfillment should conflict: status %d", rr.Code)
	}
}

func TestSecretRequestRevoke(t *testing.T) {
	y := newRequestTestServer(t, newMemoryDB(), true)
	handler := y.HTTPHandler()
	id, token := createRequest(t, handler, testPublicKey(t), "", 3600)

	// Revoking without the token is denied
	req, _ := http.NewRequest("DELETE", "/request/"+id, nil)
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("revoke without token: status %d", rr.Code)
	}

	req, _ = http.NewRequest("DELETE", "/request/"+id, nil)
	req.Header.Set(requestTokenHeader, token)
	rr = httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusNoContent {
		t.Fatalf("revoke: status %d", rr.Code)
	}

	req, _ = http.NewRequest("GET", "/request/"+id, nil)
	rr = httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusNotFound {
		t.Fatalf("request should be gone after revoke: status %d", rr.Code)
	}
}

func TestSecretRequestRotateKey(t *testing.T) {
	y := newRequestTestServer(t, newMemoryDB(), true)
	handler := y.HTTPHandler()
	id, token := createRequest(t, handler, testPublicKey(t), "", 3600)
	newKey := testPublicKey(t)

	rotateBody, _ := json.Marshal(map[string]string{"public_key": newKey})

	// Rotation without the token is denied
	req, _ := http.NewRequest("PUT", "/request/"+id+"/key", bytes.NewReader(rotateBody))
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("rotate without token: status %d", rr.Code)
	}

	req, _ = http.NewRequest("PUT", "/request/"+id+"/key", bytes.NewReader(rotateBody))
	req.Header.Set(requestTokenHeader, token)
	rr = httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("rotate: status %d body %s", rr.Code, rr.Body.String())
	}

	// The responder now sees the new public key
	req, _ = http.NewRequest("GET", "/request/"+id, nil)
	rr = httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	var info struct {
		PublicKey string `json:"public_key"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &info); err != nil {
		t.Fatal(err)
	}
	if info.PublicKey != newKey {
		t.Fatal("public key was not rotated")
	}

	// Rotation after fulfillment is rejected
	encrypted, err := yopass.Encrypt(strings.NewReader("hunter2"), "key")
	if err != nil {
		t.Fatal(err)
	}
	fulfillBody, _ := json.Marshal(map[string]string{"message": encrypted})
	req, _ = http.NewRequest("POST", "/request/"+id+"/secret", bytes.NewReader(fulfillBody))
	rr = httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("fulfill: status %d", rr.Code)
	}
	req, _ = http.NewRequest("PUT", "/request/"+id+"/key", bytes.NewReader(rotateBody))
	req.Header.Set(requestTokenHeader, token)
	rr = httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusConflict {
		t.Fatalf("rotate after fulfillment should conflict: status %d", rr.Code)
	}
}

func TestSecretRequestValidation(t *testing.T) {
	y := newRequestTestServer(t, newMemoryDB(), true)
	handler := y.HTTPHandler()
	publicKey := testPublicKey(t)

	cases := []struct {
		name string
		body map[string]interface{}
	}{
		{"missing public key", map[string]interface{}{"expiration": 3600}},
		{"invalid public key", map[string]interface{}{"public_key": "not a key", "expiration": 3600}},
		{"invalid expiration", map[string]interface{}{"public_key": publicKey, "expiration": 1234}},
		{"label too long", map[string]interface{}{"public_key": publicKey, "expiration": 3600, "label": strings.Repeat("a", maxRequestLabelLength+1)}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			body, _ := json.Marshal(tc.body)
			req, _ := http.NewRequest("POST", "/request", bytes.NewReader(body))
			rr := httptest.NewRecorder()
			handler.ServeHTTP(rr, req)
			if rr.Code != http.StatusBadRequest {
				t.Fatalf("expected 400, got %d: %s", rr.Code, rr.Body.String())
			}
		})
	}

	// Fulfillment requires a PGP encrypted message
	id, _ := createRequest(t, handler, publicKey, "", 3600)
	fulfillBody, _ := json.Marshal(map[string]string{"message": "plaintext"})
	req, _ := http.NewRequest("POST", "/request/"+id+"/secret", bytes.NewReader(fulfillBody))
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("plaintext fulfillment should be rejected: status %d", rr.Code)
	}
}

// mustEncrypt symmetrically encrypts plaintext for tests that only need a
// valid armored PGP message of a certain size.
func mustEncrypt(plaintext string) string {
	encrypted, err := yopass.Encrypt(strings.NewReader(plaintext), "key")
	if err != nil {
		panic(err)
	}
	return encrypted
}

// fulfill posts a fulfillment body and returns the response recorder.
func fulfill(handler http.Handler, id string, body map[string]string) *httptest.ResponseRecorder {
	data, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", "/request/"+id+"/secret", bytes.NewReader(data))
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	return rr
}

// fetchSecret retrieves the provided secret with the management token and
// returns the response recorder.
func fetchSecret(handler http.Handler, id, token string) *httptest.ResponseRecorder {
	req, _ := http.NewRequest("GET", "/request/"+id+"/secret", nil)
	req.Header.Set(requestTokenHeader, token)
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	return rr
}

// TestSecretRequestFulfillWithFile covers the file response flow: a file
// fulfillment larger than the text limit is accepted (bounded by
// max-file-size instead), and the kind is returned to the requester.
func TestSecretRequestFulfillWithFile(t *testing.T) {
	y := newRequestTestServer(t, newMemoryDB(), true)
	y.MaxLength = 100
	y.MaxFileSize = 1024 * 1024
	handler := y.HTTPHandler()

	id, token := createRequest(t, handler, testPublicKey(t), "", 3600)

	// Encrypted "file" content well above the 100 byte text limit
	encrypted, err := yopass.Encrypt(strings.NewReader(strings.Repeat("f", 5000)), "key")
	if err != nil {
		t.Fatal(err)
	}
	if len(encrypted) <= y.MaxLength {
		t.Fatalf("test message too short to be meaningful: %d", len(encrypted))
	}

	rr := fulfill(handler, id, map[string]string{"message": encrypted, "kind": "file"})
	if rr.Code != http.StatusOK {
		t.Fatalf("file fulfill: status %d body %s", rr.Code, rr.Body.String())
	}

	rr = fetchSecret(handler, id, token)
	if rr.Code != http.StatusOK {
		t.Fatalf("fetch: status %d body %s", rr.Code, rr.Body.String())
	}
	var resp struct {
		Message string `json:"message"`
		Kind    string `json:"kind"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Message != encrypted {
		t.Fatal("retrieved ciphertext does not match")
	}
	if resp.Kind != RequestSecretKindFile {
		t.Fatalf("expected kind %q, got %q", RequestSecretKindFile, resp.Kind)
	}
}

// TestSecretRequestFulfillKindPolicy exercises the server-side policy around
// the fulfillment kind: validation, per-kind size limits, the upload toggle,
// and backward compatibility for bodies without a kind.
func TestSecretRequestFulfillKindPolicy(t *testing.T) {
	shortMessage, err := yopass.Encrypt(strings.NewReader("hunter2"), "key")
	if err != nil {
		t.Fatal(err)
	}
	longMessage, err := yopass.Encrypt(strings.NewReader(strings.Repeat("x", 5000)), "key")
	if err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name       string
		configure  func(*Server)
		body       map[string]string
		wantStatus int
	}{
		{
			name:       "explicit text kind accepted",
			body:       map[string]string{"message": shortMessage, "kind": "text"},
			wantStatus: http.StatusOK,
		},
		{
			name:       "invalid kind rejected",
			body:       map[string]string{"message": shortMessage, "kind": "carrier-pigeon"},
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "text kind bounded by MaxLength",
			configure:  func(y *Server) { y.MaxLength = 100 },
			body:       map[string]string{"message": longMessage, "kind": "text"},
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "missing kind means text and is bounded by MaxLength",
			configure:  func(y *Server) { y.MaxLength = 100 },
			body:       map[string]string{"message": longMessage},
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "file kind rejected when uploads are disabled",
			configure:  func(y *Server) { y.DisableUpload = true },
			body:       map[string]string{"message": shortMessage, "kind": "file"},
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "file kind bounded by max-file-size when below the cap",
			configure:  func(y *Server) { y.MaxFileSize = 512 },
			body:       map[string]string{"message": longMessage, "kind": "file"},
			wantStatus: http.StatusRequestEntityTooLarge,
		},
		{
			name:       "file kind within limits accepted",
			configure:  func(y *Server) { y.MaxLength = 100; y.MaxFileSize = 1024 * 1024 },
			body:       map[string]string{"message": longMessage, "kind": "file"},
			wantStatus: http.StatusOK,
		},
		{
			name:      "file cap applies even when max-file-size is larger",
			configure: func(y *Server) { y.MaxFileSize = 100 * 1024 * 1024 },
			body: map[string]string{
				"message": mustEncrypt(strings.Repeat("x", 600*1024)),
				"kind":    "file",
			},
			wantStatus: http.StatusRequestEntityTooLarge,
		},
		{
			name:      "file cap applies when max-file-size is unlimited",
			configure: func(y *Server) { y.MaxFileSize = 0 },
			body: map[string]string{
				"message": mustEncrypt(strings.Repeat("x", 600*1024)),
				"kind":    "file",
			},
			wantStatus: http.StatusRequestEntityTooLarge,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			y := newRequestTestServer(t, newMemoryDB(), true)
			if tc.configure != nil {
				tc.configure(&y)
			}
			handler := y.HTTPHandler()
			id, _ := createRequest(t, handler, testPublicKey(t), "", 3600)
			rr := fulfill(handler, id, tc.body)
			if rr.Code != tc.wantStatus {
				t.Fatalf("expected %d, got %d: %s", tc.wantStatus, rr.Code, rr.Body.String())
			}
		})
	}
}

// TestSecretRequestFetchKindDefaultsToText pins backward compatibility for
// records fulfilled before file responses existed: without a stored kind the
// fetch response reports "text".
func TestSecretRequestFetchKindDefaultsToText(t *testing.T) {
	db := newMemoryDB()
	y := newRequestTestServer(t, db, true)
	handler := y.HTTPHandler()
	id, token := createRequest(t, handler, testPublicKey(t), "", 3600)

	encrypted, err := yopass.Encrypt(strings.NewReader("hunter2"), "key")
	if err != nil {
		t.Fatal(err)
	}
	if rr := fulfill(handler, id, map[string]string{"message": encrypted}); rr.Code != http.StatusOK {
		t.Fatalf("fulfill: status %d", rr.Code)
	}

	// Strip the stored kind to simulate a record written by an older version.
	stored := db.data[requestKeyPrefix+id]
	var r SecretRequest
	if err := json.Unmarshal([]byte(stored.Message), &r); err != nil {
		t.Fatal(err)
	}
	r.Kind = ""
	data, _ := json.Marshal(r)
	stored.Message = string(data)
	db.data[requestKeyPrefix+id] = stored

	rr := fetchSecret(handler, id, token)
	if rr.Code != http.StatusOK {
		t.Fatalf("fetch: status %d body %s", rr.Code, rr.Body.String())
	}
	var resp struct {
		Kind string `json:"kind"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Kind != RequestSecretKindText {
		t.Fatalf("expected kind %q, got %q", RequestSecretKindText, resp.Kind)
	}
}

func TestSecretRequestExpired(t *testing.T) {
	db := newMemoryDB()
	y := newRequestTestServer(t, db, true)
	handler := y.HTTPHandler()
	id, _ := createRequest(t, handler, testPublicKey(t), "", 3600)

	// Simulate TTL expiry by rewriting the stored record with a past ExpiresAt
	stored := db.data[requestKeyPrefix+id]
	var r SecretRequest
	if err := json.Unmarshal([]byte(stored.Message), &r); err != nil {
		t.Fatal(err)
	}
	r.ExpiresAt = time.Now().Unix() - 1
	data, _ := json.Marshal(r)
	db.data[requestKeyPrefix+id] = yopass.Secret{Message: string(data)}

	req, _ := http.NewRequest("GET", "/request/"+id, nil)
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusNotFound {
		t.Fatalf("expired request should return 404: status %d", rr.Code)
	}
}

func TestSecretRequestsRequireLicense(t *testing.T) {
	y := newRequestTestServer(t, newMemoryDB(), false)
	handler := y.HTTPHandler()

	body, _ := json.Marshal(map[string]interface{}{
		"public_key": testPublicKey(t),
		"expiration": 3600,
	})
	req, _ := http.NewRequest("POST", "/request", bytes.NewReader(body))
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusNotFound {
		t.Fatalf("unlicensed /request should be 404: status %d", rr.Code)
	}

	// Config must report the feature as disabled
	req, _ = http.NewRequest("GET", "/config", nil)
	rr = httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	var config map[string]interface{}
	if err := json.Unmarshal(rr.Body.Bytes(), &config); err != nil {
		t.Fatal(err)
	}
	if config["SECRET_REQUESTS"] != false {
		t.Fatalf("SECRET_REQUESTS should be false without license: %v", config["SECRET_REQUESTS"])
	}
}

func TestSecretRequestsDisabledInReadOnly(t *testing.T) {
	y := newRequestTestServer(t, newMemoryDB(), true)
	y.ReadOnly = true
	handler := y.HTTPHandler()

	body, _ := json.Marshal(map[string]interface{}{
		"public_key": testPublicKey(t),
		"expiration": 3600,
	})
	req, _ := http.NewRequest("POST", "/request", bytes.NewReader(body))
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusNotFound {
		t.Fatalf("read-only /request should be 404: status %d", rr.Code)
	}
}

// capturingAuditLogger records events so tests can assert audit coverage.
type capturingAuditLogger struct {
	events []AuditEvent
}

func (l *capturingAuditLogger) Log(e AuditEvent) { l.events = append(l.events, e) }
func (l *capturingAuditLogger) Sync() error      { return nil }

// TestSecretRequestAuditTrail verifies every interaction with a secret
// request emits an audit event.
func TestSecretRequestAuditTrail(t *testing.T) {
	y := newRequestTestServer(t, newMemoryDB(), true)
	audit := &capturingAuditLogger{}
	y.Audit = audit
	handler := y.HTTPHandler()

	// create → rotate key → responder views → fulfill → fetch secret
	id, token := createRequest(t, handler, testPublicKey(t), "audit", 3600)

	rotateBody, _ := json.Marshal(map[string]string{"public_key": testPublicKey(t)})
	req, _ := http.NewRequest("PUT", "/request/"+id+"/key", bytes.NewReader(rotateBody))
	req.Header.Set(requestTokenHeader, token)
	handler.ServeHTTP(httptest.NewRecorder(), req)

	req, _ = http.NewRequest("GET", "/request/"+id, nil)
	handler.ServeHTTP(httptest.NewRecorder(), req)

	encrypted, err := yopass.Encrypt(strings.NewReader("hunter2"), "key")
	if err != nil {
		t.Fatal(err)
	}
	fulfillBody, _ := json.Marshal(map[string]string{"message": encrypted})
	req, _ = http.NewRequest("POST", "/request/"+id+"/secret", bytes.NewReader(fulfillBody))
	handler.ServeHTTP(httptest.NewRecorder(), req)

	req, _ = http.NewRequest("GET", "/request/"+id+"/secret", nil)
	req.Header.Set(requestTokenHeader, token)
	handler.ServeHTTP(httptest.NewRecorder(), req)

	// revoke on a second request
	id2, token2 := createRequest(t, handler, testPublicKey(t), "audit2", 3600)
	req, _ = http.NewRequest("DELETE", "/request/"+id2, nil)
	req.Header.Set(requestTokenHeader, token2)
	handler.ServeHTTP(httptest.NewRecorder(), req)

	// denied access must be audited too
	req, _ = http.NewRequest("GET", "/request/"+id2+"/secret", nil)
	req.Header.Set(requestTokenHeader, "wrong")
	handler.ServeHTTP(httptest.NewRecorder(), req)

	expected := []struct {
		event   string
		outcome AuditOutcome
		id      string
	}{
		{"request.created", OutcomeSuccess, redactSecretID(id)},
		{"request.key_rotated", OutcomeSuccess, redactSecretID(id)},
		{"request.viewed", OutcomeSuccess, redactSecretID(id)},
		{"request.fulfilled", OutcomeSuccess, redactSecretID(id)},
		{"request.secret_accessed", OutcomeSuccess, redactSecretID(id)},
		{"request.created", OutcomeSuccess, redactSecretID(id2)},
		{"request.revoked", OutcomeSuccess, redactSecretID(id2)},
		{"request.secret_accessed", OutcomeFailure, redactSecretID(id2)},
	}
	if len(audit.events) != len(expected) {
		t.Fatalf("expected %d audit events, got %d: %+v", len(expected), len(audit.events), audit.events)
	}
	for i, want := range expected {
		got := audit.events[i]
		if got.Event != want.event || got.Outcome != want.outcome || got.SecretID != want.id {
			t.Errorf("event %d: got {%s %s %s}, want {%s %s %s}",
				i, got.Event, got.Outcome, got.SecretID, want.event, want.outcome, want.id)
		}
	}
}

func TestSecretRequestsConfigEnabled(t *testing.T) {
	y := newRequestTestServer(t, newMemoryDB(), true)
	handler := y.HTTPHandler()

	req, _ := http.NewRequest("GET", "/config", nil)
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	var config map[string]interface{}
	if err := json.Unmarshal(rr.Body.Bytes(), &config); err != nil {
		t.Fatal(err)
	}
	if config["SECRET_REQUESTS"] != true {
		t.Fatalf("SECRET_REQUESTS should be true with license: %v", config["SECRET_REQUESTS"])
	}
	if config["MAX_REQUEST_FILE_SIZE"] != "512KB" {
		t.Fatalf("MAX_REQUEST_FILE_SIZE should default to the 512KB cap: %v", config["MAX_REQUEST_FILE_SIZE"])
	}
}

// TestSecretRequestFileSizeConfig covers how the request file limit reported
// in /config follows --max-file-size below the cap and --disable-upload.
func TestSecretRequestFileSizeConfig(t *testing.T) {
	getConfig := func(configure func(*Server)) map[string]interface{} {
		y := newRequestTestServer(t, newMemoryDB(), true)
		configure(&y)
		req, _ := http.NewRequest("GET", "/config", nil)
		rr := httptest.NewRecorder()
		y.HTTPHandler().ServeHTTP(rr, req)
		var config map[string]interface{}
		if err := json.Unmarshal(rr.Body.Bytes(), &config); err != nil {
			t.Fatal(err)
		}
		return config
	}

	config := getConfig(func(y *Server) { y.MaxFileSize = 100 * 1024 })
	if config["MAX_REQUEST_FILE_SIZE"] != "100KB" {
		t.Fatalf("a max-file-size below the cap should lower the limit: %v", config["MAX_REQUEST_FILE_SIZE"])
	}

	config = getConfig(func(y *Server) { y.MaxFileSize = 100 * 1024 * 1024 })
	if config["MAX_REQUEST_FILE_SIZE"] != "512KB" {
		t.Fatalf("a max-file-size above the cap must not raise the limit: %v", config["MAX_REQUEST_FILE_SIZE"])
	}

	config = getConfig(func(y *Server) { y.DisableUpload = true })
	if _, ok := config["MAX_REQUEST_FILE_SIZE"]; ok {
		t.Fatalf("MAX_REQUEST_FILE_SIZE should be absent with uploads disabled: %v", config["MAX_REQUEST_FILE_SIZE"])
	}
}

// TestSecretRequestConcurrentFulfill runs concurrent fulfillments through two
// Server instances sharing one database, as in a multi-instance deployment.
// Exactly one responder may win; the stored ciphertext must belong to the
// winner (regression test for the cross-instance last-write-wins overwrite).
func TestSecretRequestConcurrentFulfill(t *testing.T) {
	db := newMemoryDB()
	serverA := newRequestTestServer(t, db, true)
	serverB := newRequestTestServer(t, db, true)
	handlers := []http.Handler{serverA.HTTPHandler(), serverB.HTTPHandler()}

	id, token := createRequest(t, handlers[0], testPublicKey(t), "", 3600)

	const responders = 8
	messages := make([]string, responders)
	for i := range messages {
		encrypted, err := yopass.Encrypt(strings.NewReader(fmt.Sprintf("secret-%d", i)), "key")
		if err != nil {
			t.Fatal(err)
		}
		messages[i] = encrypted
	}

	codes := make([]int, responders)
	var wg sync.WaitGroup
	var start sync.WaitGroup
	start.Add(1)
	for i := 0; i < responders; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			body, _ := json.Marshal(map[string]string{"message": messages[i]})
			req, _ := http.NewRequest("POST", "/request/"+id+"/secret", bytes.NewReader(body))
			rr := httptest.NewRecorder()
			start.Wait()
			handlers[i%len(handlers)].ServeHTTP(rr, req)
			codes[i] = rr.Code
		}(i)
	}
	start.Done()
	wg.Wait()

	winner := -1
	for i, code := range codes {
		switch code {
		case http.StatusOK:
			if winner != -1 {
				t.Fatalf("both responder %d and %d got 200; codes: %v", winner, i, codes)
			}
			winner = i
		case http.StatusConflict:
		default:
			t.Fatalf("responder %d: unexpected status %d; codes: %v", i, code, codes)
		}
	}
	if winner == -1 {
		t.Fatalf("no responder succeeded; codes: %v", codes)
	}

	req, _ := http.NewRequest("GET", "/request/"+id+"/secret", nil)
	req.Header.Set(requestTokenHeader, token)
	rr := httptest.NewRecorder()
	handlers[1].ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("fetch: status %d body %s", rr.Code, rr.Body.String())
	}
	var resp struct {
		Message string `json:"message"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Message != messages[winner] {
		t.Fatal("stored ciphertext does not match the winning responder's message")
	}
}

// TestSecretRequestFulfillAfterRevoke verifies that fulfilling a revoked
// request fails and never re-creates the record (regression test for the
// revoke-vs-fulfill resurrection: fulfill must go through an atomic update
// that fails on a missing key, not a blind put).
func TestSecretRequestFulfillAfterRevoke(t *testing.T) {
	db := newMemoryDB()
	serverA := newRequestTestServer(t, db, true)
	serverB := newRequestTestServer(t, db, true)
	handlerA, handlerB := serverA.HTTPHandler(), serverB.HTTPHandler()

	id, token := createRequest(t, handlerA, testPublicKey(t), "", 3600)

	req, _ := http.NewRequest("DELETE", "/request/"+id, nil)
	req.Header.Set(requestTokenHeader, token)
	rr := httptest.NewRecorder()
	handlerB.ServeHTTP(rr, req)
	if rr.Code != http.StatusNoContent {
		t.Fatalf("revoke: status %d", rr.Code)
	}

	encrypted, err := yopass.Encrypt(strings.NewReader("hunter2"), "key")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(map[string]string{"message": encrypted})
	req, _ = http.NewRequest("POST", "/request/"+id+"/secret", bytes.NewReader(body))
	rr = httptest.NewRecorder()
	handlerA.ServeHTTP(rr, req)
	if rr.Code != http.StatusNotFound {
		t.Fatalf("fulfill after revoke should be 404: status %d body %s", rr.Code, rr.Body.String())
	}

	db.mu.Lock()
	_, resurrected := db.data[requestKeyPrefix+id]
	db.mu.Unlock()
	if resurrected {
		t.Fatal("revoked request was re-created by fulfill")
	}
}

// claimRaceDB simulates the request disappearing between the fetch handler's
// load and its delete-as-claim, as when a concurrent fetch or revoke on
// another instance wins the claim.
type claimRaceDB struct{ *memoryDB }

func (db *claimRaceDB) Delete(key string) (bool, error) { return false, nil }

func TestSecretRequestFetchAlreadyClaimed(t *testing.T) {
	db := newMemoryDB()
	y := newRequestTestServer(t, &claimRaceDB{db}, true)
	handler := y.HTTPHandler()

	id, token := createRequest(t, handler, testPublicKey(t), "", 3600)

	encrypted, err := yopass.Encrypt(strings.NewReader("hunter2"), "key")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(map[string]string{"message": encrypted})
	req, _ := http.NewRequest("POST", "/request/"+id+"/secret", bytes.NewReader(body))
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("fulfill: status %d", rr.Code)
	}

	req, _ = http.NewRequest("GET", "/request/"+id+"/secret", nil)
	req.Header.Set(requestTokenHeader, token)
	rr = httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusNotFound {
		t.Fatalf("fetch of a concurrently claimed request should be 404: status %d body %s", rr.Code, rr.Body.String())
	}
}
