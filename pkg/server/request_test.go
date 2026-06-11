package server

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
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
	data map[string]yopass.Secret
}

func newMemoryDB() *memoryDB {
	return &memoryDB{data: map[string]yopass.Secret{}}
}

func (db *memoryDB) Get(key string) (yopass.Secret, error) {
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
	db.data[key] = secret
	return nil
}

func (db *memoryDB) Delete(key string) (bool, error) {
	if _, ok := db.data[key]; !ok {
		return false, nil
	}
	delete(db.data, key)
	return true, nil
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
}
