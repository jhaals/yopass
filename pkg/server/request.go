package server

import (
	"encoding/json"
	"errors"
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
	return secondsUntil(r.ExpiresAt)
}

// tokenValid compares the given management token against the stored hash in
// constant time.
func (r SecretRequest) tokenValid(token string) bool {
	return tokenMatchesHash(token, r.TokenHash)
}

// isPGPPublicKey verifies that the provided content is an armored PGP public key.
func isPGPPublicKey(content string) bool {
	if content == "" || len(content) > maxPublicKeyLength {
		return false
	}
	ring, err := openpgp.ReadArmoredKeyRing(strings.NewReader(content))
	return err == nil && len(ring) > 0
}

// Sentinel errors used by updateRequest mutation callbacks to signal why a
// lifecycle transition was aborted.
var (
	errRequestNotFound  = errors.New("secret request not found")
	errAlreadyFulfilled = errors.New("secret request already fulfilled")
	errInvalidToken     = errors.New("invalid request token")
)

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

// updateRequest atomically mutates a stored secret request via Database.Update
// so lifecycle transitions are safe across multiple instances sharing one
// backend. fn may return an error to abort the update; it is returned
// unchanged. Records that fail validation (bad JSON, missing token hash,
// expired) abort with errRequestNotFound.
func (y *Server) updateRequest(id string, fn func(*SecretRequest) error) error {
	return y.DB.Update(requestKeyPrefix+id, func(s yopass.Secret) (yopass.Secret, error) {
		var r SecretRequest
		if err := json.Unmarshal([]byte(s.Message), &r); err != nil || r.TokenHash == "" {
			return s, errRequestNotFound
		}
		// Compute the TTL once: a second call could return 0 after the
		// validation, and a zero expiration means "never expire" to the
		// backends, which would persist an expired request indefinitely.
		ttl := r.remainingTTL()
		if ttl == 0 {
			return s, errRequestNotFound
		}
		if err := fn(&r); err != nil {
			return s, err
		}
		data, err := json.Marshal(r)
		if err != nil {
			return s, err
		}
		return yopass.Secret{
			Message:    string(data),
			Expiration: ttl,
		}, nil
	})
}

// createSecretRequest creates a new secret request from a requester-supplied
// public key.
func (y *Server) createSecretRequest(w http.ResponseWriter, request *http.Request) {
	session, _ := y.getSession(request)
	audit := y.newAuditor("request.created", y.getRealClientIP(request), session)

	var body struct {
		PublicKey  string `json:"public_key"`
		Label      string `json:"label"`
		Expiration int32  `json:"expiration"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, request.Body, maxPublicKeyLength+4096)).Decode(&body); err != nil {
		audit.failure("unable to parse json")
		jsonError(w, http.StatusBadRequest, "Unable to parse json")
		return
	}

	if !isPGPPublicKey(body.PublicKey) {
		audit.failure("invalid public key")
		jsonError(w, http.StatusBadRequest, "A valid PGP public key is required")
		return
	}

	if !validExpiration(body.Expiration) {
		audit.failure("invalid expiration")
		jsonError(w, http.StatusBadRequest, "Invalid expiration specified")
		return
	}

	if len(body.Label) > maxRequestLabelLength {
		audit.failure("label too long")
		jsonError(w, http.StatusBadRequest, "Label is too long")
		return
	}

	id, err := yopass.GenerateID()
	if err != nil {
		y.Logger.Error("Unable to generate ID", zap.Error(err))
		audit.failure("failed to generate ID")
		jsonError(w, http.StatusInternalServerError, "Unable to generate ID")
		return
	}
	audit.setSecretID(id)

	token, tokenHash, err := generateToken()
	if err != nil {
		y.Logger.Error("Unable to generate request token", zap.Error(err))
		audit.failure("failed to generate token")
		jsonError(w, http.StatusInternalServerError, "Unable to generate token")
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
		audit.failure("database error")
		jsonError(w, http.StatusInternalServerError, "Failed to store request in database")
		return
	}

	audit.success(withExpiration(body.Expiration))
	y.webhookRequestCreated(id, body.Expiration)
	y.writeJSON(w, http.StatusOK, map[string]interface{}{
		"id":         id,
		"token":      token,
		"expires_at": req.ExpiresAt,
	})
}

// getSecretRequest returns the public information about a request: the public
// key for the responder to encrypt against, plus label and state. The
// encrypted secret and token hash are never exposed here.
func (y *Server) getSecretRequest(w http.ResponseWriter, request *http.Request) {
	w.Header().Set("Cache-Control", "private, no-cache")
	id := mux.Vars(request)["key"]
	audit := y.newAuditor("request.viewed", y.getRealClientIP(request), nil)
	audit.setSecretID(id)

	req, ok := y.loadRequest(id)
	if !ok {
		audit.failure("not found")
		jsonError(w, http.StatusNotFound, "Secret request not found")
		return
	}

	audit.success()
	y.writeJSON(w, http.StatusOK, map[string]interface{}{
		"public_key": req.PublicKey,
		"label":      req.Label,
		"state":      req.State,
		"expires_at": req.ExpiresAt,
	})
}

// fulfillSecretRequest stores the responder's encrypted secret on a pending
// request and marks it fulfilled.
func (y *Server) fulfillSecretRequest(w http.ResponseWriter, request *http.Request) {
	id := mux.Vars(request)["key"]
	audit := y.newAuditor("request.fulfilled", y.getRealClientIP(request), nil)
	audit.setSecretID(id)

	var body struct {
		Message string `json:"message"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, request.Body, int64(y.MaxLength)+4096)).Decode(&body); err != nil {
		audit.failure("unable to parse json")
		jsonError(w, http.StatusBadRequest, "Unable to parse json")
		return
	}

	if !isPGPEncrypted(body.Message) {
		audit.failure("message not PGP encrypted")
		jsonError(w, http.StatusBadRequest, "Message must be PGP encrypted")
		return
	}

	if len(body.Message) > y.MaxLength {
		audit.failure("message too long")
		jsonError(w, http.StatusBadRequest, "The encrypted message is too long")
		return
	}

	err := y.updateRequest(id, func(req *SecretRequest) error {
		if req.State == RequestStateFulfilled {
			return errAlreadyFulfilled
		}
		req.State = RequestStateFulfilled
		req.Secret = body.Message
		return nil
	})
	switch {
	case errors.Is(err, ErrKeyNotFound) || errors.Is(err, errRequestNotFound):
		audit.failure("not found")
		jsonError(w, http.StatusNotFound, "Secret request not found")
		return
	case errors.Is(err, errAlreadyFulfilled):
		audit.denied("already fulfilled")
		jsonError(w, http.StatusConflict, "A secret has already been provided for this request")
		return
	case err != nil:
		y.Logger.Error("Unable to store fulfilled request", zap.Error(err))
		audit.failure("database error")
		jsonError(w, http.StatusInternalServerError, "Failed to store secret in database")
		return
	}

	audit.success()
	y.webhookRequestFulfilled(id)
	y.writeJSON(w, http.StatusOK, map[string]string{"message": "secret provided"})
}

// fetchRequestSecret returns the encrypted secret to the requester and
// deletes the request. Requires the management token.
func (y *Server) fetchRequestSecret(w http.ResponseWriter, request *http.Request) {
	w.Header().Set("Cache-Control", "private, no-cache")
	id := mux.Vars(request)["key"]
	audit := y.newAuditor("request.secret_accessed", y.getRealClientIP(request), nil)
	audit.setSecretID(id)

	req, ok := y.loadRequest(id)
	if !ok {
		audit.failure("not found")
		jsonError(w, http.StatusNotFound, "Secret request not found")
		return
	}

	if !req.tokenValid(request.Header.Get(requestTokenHeader)) {
		audit.denied("invalid management token")
		jsonError(w, http.StatusUnauthorized, "Invalid request token")
		return
	}

	if req.State != RequestStateFulfilled {
		audit.failure("no secret provided yet")
		jsonError(w, http.StatusConflict, "No secret has been provided yet")
		return
	}

	// The secret can only be retrieved once: delete before responding so a
	// failed delete never results in a secret that can be fetched twice.
	// Delete reporting whether a key was removed makes this a single-winner
	// claim; fulfilled records are immutable (fulfill and rotate refuse to
	// touch them) so the secret read above cannot be stale.
	deleted, err := y.DB.Delete(requestKeyPrefix + id)
	if err != nil {
		y.Logger.Error("Failed to delete fulfilled request", zap.Error(err))
		audit.failure("failed to claim secret")
		jsonError(w, http.StatusInternalServerError, "Failed to process secret")
		return
	}
	if !deleted {
		// A concurrent fetch or revoke claimed the request between the load
		// and the delete; it is gone, not broken.
		audit.failure("already claimed")
		jsonError(w, http.StatusNotFound, "Secret request not found")
		return
	}

	audit.success()
	y.webhookRequestClosed(id)
	y.writeJSON(w, http.StatusOK, map[string]string{"message": req.Secret})
}

// revokeSecretRequest deletes a request. Requires the management token.
func (y *Server) revokeSecretRequest(w http.ResponseWriter, request *http.Request) {
	id := mux.Vars(request)["key"]
	audit := y.newAuditor("request.revoked", y.getRealClientIP(request), nil)
	audit.setSecretID(id)

	req, ok := y.loadRequest(id)
	if !ok {
		audit.failure("not found")
		jsonError(w, http.StatusNotFound, "Secret request not found")
		return
	}

	if !req.tokenValid(request.Header.Get(requestTokenHeader)) {
		audit.denied("invalid management token")
		jsonError(w, http.StatusUnauthorized, "Invalid request token")
		return
	}

	if _, err := y.DB.Delete(requestKeyPrefix + id); err != nil {
		audit.failure("database error")
		jsonError(w, http.StatusInternalServerError, "Failed to revoke request")
		return
	}

	audit.success()
	y.webhookRequestClosed(id)
	w.WriteHeader(http.StatusNoContent)
}

// rotateRequestKey replaces the public key of a pending request, allowing the
// requester to regenerate a key pair (for example on a different browser).
// Requires the management token.
func (y *Server) rotateRequestKey(w http.ResponseWriter, request *http.Request) {
	id := mux.Vars(request)["key"]
	audit := y.newAuditor("request.key_rotated", y.getRealClientIP(request), nil)
	audit.setSecretID(id)

	var body struct {
		PublicKey string `json:"public_key"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, request.Body, maxPublicKeyLength+4096)).Decode(&body); err != nil {
		audit.failure("unable to parse json")
		jsonError(w, http.StatusBadRequest, "Unable to parse json")
		return
	}

	if !isPGPPublicKey(body.PublicKey) {
		audit.failure("invalid public key")
		jsonError(w, http.StatusBadRequest, "A valid PGP public key is required")
		return
	}

	token := request.Header.Get(requestTokenHeader)
	err := y.updateRequest(id, func(req *SecretRequest) error {
		if !req.tokenValid(token) {
			return errInvalidToken
		}
		if req.State == RequestStateFulfilled {
			return errAlreadyFulfilled
		}
		req.PublicKey = body.PublicKey
		return nil
	})
	switch {
	case errors.Is(err, ErrKeyNotFound) || errors.Is(err, errRequestNotFound):
		audit.failure("not found")
		jsonError(w, http.StatusNotFound, "Secret request not found")
		return
	case errors.Is(err, errInvalidToken):
		audit.denied("invalid management token")
		jsonError(w, http.StatusUnauthorized, "Invalid request token")
		return
	case errors.Is(err, errAlreadyFulfilled):
		audit.denied("already fulfilled")
		jsonError(w, http.StatusConflict, "A secret has already been provided for this request")
		return
	case err != nil:
		y.Logger.Error("Unable to store rotated request", zap.Error(err))
		audit.failure("database error")
		jsonError(w, http.StatusInternalServerError, "Failed to update request")
		return
	}

	audit.success()
	y.writeJSON(w, http.StatusOK, map[string]string{"message": "public key updated"})
}
