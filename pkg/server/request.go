package server

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/ProtonMail/go-crypto/openpgp"
	"github.com/gorilla/mux"
	"github.com/jhaals/yopass/pkg/yopass"
	"go.uber.org/zap"
)

// Secret request lifecycle states. Expiry and revocation are represented by
// the record disappearing from the database (TTL or explicit delete).
const (
	RequestStatePending   = "pending"
	RequestStateFulfilled = "fulfilled"
)

// requestKeyPrefix namespaces secret requests in the database so they can
// never be read or deleted through the regular /secret/{key} endpoints.
const requestKeyPrefix = "request/"

// requestTokenHeader carries the management token that authorizes the
// requester to retrieve, revoke or rotate the key of a secret request.
const requestTokenHeader = "X-Yopass-Request-Token"

const (
	maxRequestLabelLength = 100
	maxPublicKeyLength    = 16 * 1024
)

// SecretRequest is the stored representation of a secret request. Only the
// public key ever reaches the server; the private key and management token
// stay with the requester.
type SecretRequest struct {
	PublicKey string `json:"public_key"`
	Label     string `json:"label,omitempty"`
	TokenHash string `json:"token_hash"`
	State     string `json:"state"`
	Secret    string `json:"secret,omitempty"`
	CreatedAt int64  `json:"created_at"`
	ExpiresAt int64  `json:"expires_at"`
}

// remainingTTL returns the number of seconds until the request expires,
// or 0 if it already has.
func (r SecretRequest) remainingTTL() int32 {
	ttl := r.ExpiresAt - time.Now().Unix()
	if ttl <= 0 {
		return 0
	}
	return int32(ttl)
}

// tokenValid compares the given management token against the stored hash in
// constant time.
func (r SecretRequest) tokenValid(token string) bool {
	if token == "" || r.TokenHash == "" {
		return false
	}
	h := sha256.Sum256([]byte(token))
	return subtle.ConstantTimeCompare([]byte(hex.EncodeToString(h[:])), []byte(r.TokenHash)) == 1
}

// generateRequestToken creates a new management token and its storage hash.
func generateRequestToken() (token, hash string, err error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", "", err
	}
	token = base64.RawURLEncoding.EncodeToString(b)
	h := sha256.Sum256([]byte(token))
	return token, hex.EncodeToString(h[:]), nil
}

// isPGPPublicKey verifies that the provided content is an armored PGP public key.
func isPGPPublicKey(content string) bool {
	if content == "" || len(content) > maxPublicKeyLength {
		return false
	}
	ring, err := openpgp.ReadArmoredKeyRing(strings.NewReader(content))
	return err == nil && len(ring) > 0
}

// loadRequest fetches and decodes a secret request from the database.
func (y *Server) loadRequest(id string) (SecretRequest, bool) {
	s, err := y.DB.Status(requestKeyPrefix + id)
	if err != nil {
		return SecretRequest{}, false
	}
	var r SecretRequest
	if err := json.Unmarshal([]byte(s.Message), &r); err != nil || r.TokenHash == "" {
		return SecretRequest{}, false
	}
	if r.remainingTTL() == 0 {
		return SecretRequest{}, false
	}
	return r, true
}

// storeRequest persists a secret request with the given TTL.
func (y *Server) storeRequest(id string, r SecretRequest, ttl int32) error {
	data, err := json.Marshal(r)
	if err != nil {
		return err
	}
	return y.DB.Put(requestKeyPrefix+id, yopass.Secret{
		Message:    string(data),
		Expiration: ttl,
	})
}

// createSecretRequest creates a new secret request from a requester-supplied
// public key.
func (y *Server) createSecretRequest(w http.ResponseWriter, request *http.Request) {
	session, _ := y.getSession(request)
	clientIP := y.getRealClientIP(request)

	auditFailure := func(reason string) {
		y.audit().Log(AuditEvent{
			Timestamp: time.Now().UTC(), Event: "request.created", Outcome: OutcomeFailure,
			ClientIP: clientIP, UserEmail: sessionEmail(session), UserSubject: sessionSub(session),
			Error: reason,
		})
	}

	var body struct {
		PublicKey  string `json:"public_key"`
		Label      string `json:"label"`
		Expiration int32  `json:"expiration"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, request.Body, maxPublicKeyLength+4096)).Decode(&body); err != nil {
		auditFailure("unable to parse json")
		http.Error(w, `{"message": "Unable to parse json"}`, http.StatusBadRequest)
		return
	}

	if !isPGPPublicKey(body.PublicKey) {
		auditFailure("invalid public key")
		http.Error(w, `{"message": "A valid PGP public key is required"}`, http.StatusBadRequest)
		return
	}

	if !validExpiration(body.Expiration) {
		auditFailure("invalid expiration")
		http.Error(w, `{"message": "Invalid expiration specified"}`, http.StatusBadRequest)
		return
	}

	if len(body.Label) > maxRequestLabelLength {
		auditFailure("label too long")
		http.Error(w, `{"message": "Label is too long"}`, http.StatusBadRequest)
		return
	}

	id, err := yopass.GenerateID()
	if err != nil {
		y.Logger.Error("Unable to generate ID", zap.Error(err))
		auditFailure("failed to generate ID")
		http.Error(w, `{"message": "Unable to generate ID"}`, http.StatusInternalServerError)
		return
	}

	token, tokenHash, err := generateRequestToken()
	if err != nil {
		y.Logger.Error("Unable to generate request token", zap.Error(err))
		auditFailure("failed to generate token")
		http.Error(w, `{"message": "Unable to generate token"}`, http.StatusInternalServerError)
		return
	}

	now := time.Now().UTC()
	req := SecretRequest{
		PublicKey: body.PublicKey,
		Label:     body.Label,
		TokenHash: tokenHash,
		State:     RequestStatePending,
		CreatedAt: now.Unix(),
		ExpiresAt: now.Unix() + int64(body.Expiration),
	}
	if err := y.storeRequest(id, req, body.Expiration); err != nil {
		y.Logger.Error("Unable to store secret request", zap.Error(err))
		auditFailure("database error")
		http.Error(w, `{"message": "Failed to store request in database"}`, http.StatusInternalServerError)
		return
	}

	y.audit().Log(AuditEvent{
		Timestamp: time.Now().UTC(), Event: "request.created", Outcome: OutcomeSuccess,
		ClientIP: clientIP, SecretID: id, ExpirationSeconds: int32Ptr(body.Expiration),
		UserEmail: sessionEmail(session), UserSubject: sessionSub(session),
	})
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(map[string]interface{}{
		"id":         id,
		"token":      token,
		"expires_at": req.ExpiresAt,
	}); err != nil {
		y.Logger.Error("Failed to write response", zap.Error(err))
	}
}

// getSecretRequest returns the public information about a request: the public
// key for the responder to encrypt against, plus label and state. The
// encrypted secret and token hash are never exposed here.
func (y *Server) getSecretRequest(w http.ResponseWriter, request *http.Request) {
	w.Header().Set("Cache-Control", "private, no-cache")
	w.Header().Set("Content-Type", "application/json")
	id := mux.Vars(request)["key"]
	clientIP := y.getRealClientIP(request)

	req, ok := y.loadRequest(id)
	if !ok {
		y.audit().Log(AuditEvent{
			Timestamp: time.Now().UTC(), Event: "request.viewed", Outcome: OutcomeFailure,
			ClientIP: clientIP, SecretID: id, Error: "not found",
		})
		http.Error(w, `{"message": "Secret request not found"}`, http.StatusNotFound)
		return
	}

	y.audit().Log(AuditEvent{
		Timestamp: time.Now().UTC(), Event: "request.viewed", Outcome: OutcomeSuccess,
		ClientIP: clientIP, SecretID: id,
	})
	if err := json.NewEncoder(w).Encode(map[string]interface{}{
		"public_key": req.PublicKey,
		"label":      req.Label,
		"state":      req.State,
		"expires_at": req.ExpiresAt,
	}); err != nil {
		y.Logger.Error("Failed to write response", zap.Error(err))
	}
}

// fulfillSecretRequest stores the responder's encrypted secret on a pending
// request and marks it fulfilled.
func (y *Server) fulfillSecretRequest(w http.ResponseWriter, request *http.Request) {
	id := mux.Vars(request)["key"]
	clientIP := y.getRealClientIP(request)

	auditEvent := func(outcome AuditOutcome, reason string) {
		y.audit().Log(AuditEvent{
			Timestamp: time.Now().UTC(), Event: "request.fulfilled", Outcome: outcome,
			ClientIP: clientIP, SecretID: id, Error: reason,
		})
	}

	var body struct {
		Message string `json:"message"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, request.Body, int64(y.MaxLength)+4096)).Decode(&body); err != nil {
		auditEvent(OutcomeFailure, "unable to parse json")
		http.Error(w, `{"message": "Unable to parse json"}`, http.StatusBadRequest)
		return
	}

	if !isPGPEncrypted(body.Message) {
		auditEvent(OutcomeFailure, "message not PGP encrypted")
		http.Error(w, `{"message": "Message must be PGP encrypted"}`, http.StatusBadRequest)
		return
	}

	if len(body.Message) > y.MaxLength {
		auditEvent(OutcomeFailure, "message too long")
		http.Error(w, `{"message": "The encrypted message is too long"}`, http.StatusBadRequest)
		return
	}

	req, ok := y.loadRequest(id)
	if !ok {
		auditEvent(OutcomeFailure, "not found")
		http.Error(w, `{"message": "Secret request not found"}`, http.StatusNotFound)
		return
	}

	if req.State == RequestStateFulfilled {
		auditEvent(OutcomeDenied, "already fulfilled")
		writeJSONError(w, `{"message": "A secret has already been provided for this request"}`, http.StatusConflict)
		return
	}

	req.State = RequestStateFulfilled
	req.Secret = body.Message
	if err := y.storeRequest(id, req, req.remainingTTL()); err != nil {
		y.Logger.Error("Unable to store fulfilled request", zap.Error(err))
		auditEvent(OutcomeFailure, "database error")
		http.Error(w, `{"message": "Failed to store secret in database"}`, http.StatusInternalServerError)
		return
	}

	auditEvent(OutcomeSuccess, "")
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(map[string]string{"message": "secret provided"}); err != nil {
		y.Logger.Error("Failed to write response", zap.Error(err))
	}
}

// fetchRequestSecret returns the encrypted secret to the requester and
// deletes the request. Requires the management token.
func (y *Server) fetchRequestSecret(w http.ResponseWriter, request *http.Request) {
	w.Header().Set("Cache-Control", "private, no-cache")
	id := mux.Vars(request)["key"]
	clientIP := y.getRealClientIP(request)

	auditEvent := func(outcome AuditOutcome, reason string) {
		y.audit().Log(AuditEvent{
			Timestamp: time.Now().UTC(), Event: "request.secret_accessed", Outcome: outcome,
			ClientIP: clientIP, SecretID: id, Error: reason,
		})
	}

	req, ok := y.loadRequest(id)
	if !ok {
		auditEvent(OutcomeFailure, "not found")
		http.Error(w, `{"message": "Secret request not found"}`, http.StatusNotFound)
		return
	}

	if !req.tokenValid(request.Header.Get(requestTokenHeader)) {
		auditEvent(OutcomeDenied, "invalid management token")
		writeJSONError(w, `{"message": "Invalid request token"}`, http.StatusUnauthorized)
		return
	}

	if req.State != RequestStateFulfilled {
		auditEvent(OutcomeFailure, "no secret provided yet")
		writeJSONError(w, `{"message": "No secret has been provided yet"}`, http.StatusConflict)
		return
	}

	// The secret can only be retrieved once: delete before responding so a
	// failed delete never results in a secret that can be fetched twice.
	deleted, err := y.DB.Delete(requestKeyPrefix + id)
	if err != nil || !deleted {
		y.Logger.Error("Failed to delete fulfilled request", zap.Error(err))
		auditEvent(OutcomeFailure, "failed to claim secret")
		http.Error(w, `{"message": "Failed to process secret"}`, http.StatusInternalServerError)
		return
	}

	auditEvent(OutcomeSuccess, "")
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(map[string]string{"message": req.Secret}); err != nil {
		y.Logger.Error("Failed to write response", zap.Error(err))
	}
}

// revokeSecretRequest deletes a request. Requires the management token.
func (y *Server) revokeSecretRequest(w http.ResponseWriter, request *http.Request) {
	id := mux.Vars(request)["key"]
	clientIP := y.getRealClientIP(request)

	auditEvent := func(outcome AuditOutcome, reason string) {
		y.audit().Log(AuditEvent{
			Timestamp: time.Now().UTC(), Event: "request.revoked", Outcome: outcome,
			ClientIP: clientIP, SecretID: id, Error: reason,
		})
	}

	req, ok := y.loadRequest(id)
	if !ok {
		auditEvent(OutcomeFailure, "not found")
		http.Error(w, `{"message": "Secret request not found"}`, http.StatusNotFound)
		return
	}

	if !req.tokenValid(request.Header.Get(requestTokenHeader)) {
		auditEvent(OutcomeDenied, "invalid management token")
		writeJSONError(w, `{"message": "Invalid request token"}`, http.StatusUnauthorized)
		return
	}

	if _, err := y.DB.Delete(requestKeyPrefix + id); err != nil {
		auditEvent(OutcomeFailure, "database error")
		http.Error(w, `{"message": "Failed to revoke request"}`, http.StatusInternalServerError)
		return
	}

	auditEvent(OutcomeSuccess, "")
	w.WriteHeader(http.StatusNoContent)
}

// rotateRequestKey replaces the public key of a pending request, allowing the
// requester to regenerate a key pair (for example on a different browser).
// Requires the management token.
func (y *Server) rotateRequestKey(w http.ResponseWriter, request *http.Request) {
	id := mux.Vars(request)["key"]
	clientIP := y.getRealClientIP(request)

	auditEvent := func(outcome AuditOutcome, reason string) {
		y.audit().Log(AuditEvent{
			Timestamp: time.Now().UTC(), Event: "request.key_rotated", Outcome: outcome,
			ClientIP: clientIP, SecretID: id, Error: reason,
		})
	}

	var body struct {
		PublicKey string `json:"public_key"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, request.Body, maxPublicKeyLength+4096)).Decode(&body); err != nil {
		auditEvent(OutcomeFailure, "unable to parse json")
		http.Error(w, `{"message": "Unable to parse json"}`, http.StatusBadRequest)
		return
	}

	if !isPGPPublicKey(body.PublicKey) {
		auditEvent(OutcomeFailure, "invalid public key")
		http.Error(w, `{"message": "A valid PGP public key is required"}`, http.StatusBadRequest)
		return
	}

	req, ok := y.loadRequest(id)
	if !ok {
		auditEvent(OutcomeFailure, "not found")
		http.Error(w, `{"message": "Secret request not found"}`, http.StatusNotFound)
		return
	}

	if !req.tokenValid(request.Header.Get(requestTokenHeader)) {
		auditEvent(OutcomeDenied, "invalid management token")
		writeJSONError(w, `{"message": "Invalid request token"}`, http.StatusUnauthorized)
		return
	}

	if req.State == RequestStateFulfilled {
		auditEvent(OutcomeDenied, "already fulfilled")
		writeJSONError(w, `{"message": "A secret has already been provided for this request"}`, http.StatusConflict)
		return
	}

	req.PublicKey = body.PublicKey
	if err := y.storeRequest(id, req, req.remainingTTL()); err != nil {
		y.Logger.Error("Unable to store rotated request", zap.Error(err))
		auditEvent(OutcomeFailure, "database error")
		http.Error(w, `{"message": "Failed to update request"}`, http.StatusInternalServerError)
		return
	}

	auditEvent(OutcomeSuccess, "")
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(map[string]string{"message": "public key updated"}); err != nil {
		y.Logger.Error("Failed to write response", zap.Error(err))
	}
}

// requestOptions handles CORS preflight for the secret request endpoints,
// which use the custom management token header.
func (y *Server) requestOptions(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "content-type, x-yopass-request-token")
}
