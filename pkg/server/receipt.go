package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/gorilla/mux"
	"github.com/jhaals/yopass/pkg/yopass"
	"go.uber.org/zap"
)

// Read receipt lifecycle states. Expiry is represented by the record
// disappearing from the database (TTL).
const (
	ReceiptStatePending = "pending"
	ReceiptStateViewed  = "viewed"
)

// receiptKeyPrefix namespaces read receipts in the database so they can never
// be read or deleted through the regular /secret/{key} endpoints (the key
// route pattern cannot match the embedded slash).
const receiptKeyPrefix = "receipt/"

// receiptTokenHeader carries the receipt token that authorizes the secret
// creator to check whether the secret has been opened.
const receiptTokenHeader = "X-Yopass-Receipt-Token"

// secretReceipt is the stored representation of a read receipt. It lives for
// the same lifetime as the secret it belongs to and never contains secret
// content — only access metadata.
type secretReceipt struct {
	TokenHash string `json:"token_hash"`
	State     string `json:"state"`
	OneTime   bool   `json:"one_time"`
	CreatedAt int64  `json:"created_at"`
	ViewedAt  int64  `json:"viewed_at,omitempty"`
	ExpiresAt int64  `json:"expires_at"`
}

// remainingTTL returns the number of seconds until the receipt expires,
// or 0 if it already has.
func (r secretReceipt) remainingTTL() int32 {
	return secondsUntil(r.ExpiresAt)
}

// tokenValid compares the given receipt token against the stored hash in
// constant time.
func (r secretReceipt) tokenValid(token string) bool {
	return tokenMatchesHash(token, r.TokenHash)
}

// readReceiptsEnabled reports whether new secrets may be created with a read
// receipt: a business feature requiring a currently valid license. Checked
// per creation, so it degrades as soon as the license expires; receipts that
// already exist stay checkable through the always-registered receipt routes.
func (y *Server) readReceiptsEnabled() bool {
	return y.License.CurrentlyValid() && !y.DisableReadReceipts
}

// createReceipt stores a pending read receipt for the secret with the given
// key and returns the receipt token. The receipt shares the secret's TTL.
func (y *Server) createReceipt(id string, oneTime bool, expiration int32) (string, error) {
	token, tokenHash, err := generateToken()
	if err != nil {
		return "", err
	}
	now := time.Now().UTC()
	r := secretReceipt{
		TokenHash: tokenHash,
		State:     ReceiptStatePending,
		OneTime:   oneTime,
		CreatedAt: now.Unix(),
		ExpiresAt: now.Unix() + int64(expiration),
	}
	data, err := json.Marshal(r)
	if err != nil {
		return "", err
	}
	err = y.DB.Put(receiptKeyPrefix+id, yopass.Secret{
		Message:    string(data),
		Expiration: expiration,
	})
	if err != nil {
		return "", err
	}
	return token, nil
}

// loadReceipt fetches and decodes a read receipt from the database.
func (y *Server) loadReceipt(id string) (secretReceipt, bool) {
	s, err := y.DB.Status(receiptKeyPrefix + id)
	if err != nil {
		return secretReceipt{}, false
	}
	var r secretReceipt
	if err := json.Unmarshal([]byte(s.Message), &r); err != nil || r.TokenHash == "" {
		return secretReceipt{}, false
	}
	if r.remainingTTL() == 0 {
		return secretReceipt{}, false
	}
	return r, true
}

// errReceiptUnchanged aborts a markReceiptViewed update that has nothing to
// change (missing, invalid, expired or already viewed receipt).
var errReceiptUnchanged = errors.New("receipt unchanged")

// markReceiptViewed flags a pending receipt as viewed. It is best-effort and
// runs on every successful secret access regardless of feature gating so that
// receipts work in split deployments where retrieval happens on a read-only
// instance: errors are logged but never fail secret delivery. The update uses
// Database.Update so the transition is atomic across instances sharing one
// backend, mirroring the secret request lifecycle.
func (y *Server) markReceiptViewed(id string) {
	err := y.DB.Update(receiptKeyPrefix+id, func(s yopass.Secret) (yopass.Secret, error) {
		var r secretReceipt
		if err := json.Unmarshal([]byte(s.Message), &r); err != nil || r.TokenHash == "" {
			return s, errReceiptUnchanged
		}
		// Compute the TTL once: a zero expiration means "never expire" to the
		// backends, which would persist an expired receipt indefinitely.
		ttl := r.remainingTTL()
		if ttl == 0 || r.State == ReceiptStateViewed {
			return s, errReceiptUnchanged
		}
		r.State = ReceiptStateViewed
		r.ViewedAt = time.Now().Unix()
		data, err := json.Marshal(r)
		if err != nil {
			return s, err
		}
		return yopass.Secret{
			Message:    string(data),
			Expiration: ttl,
		}, nil
	})
	if err != nil && !errors.Is(err, errReceiptUnchanged) && !errors.Is(err, ErrKeyNotFound) {
		y.Logger.Error("Unable to store viewed read receipt", zap.Error(err))
	}
}

// getSecretReceipt returns the read receipt state for a secret. Requires the
// receipt token returned at secret creation time.
func (y *Server) getSecretReceipt(w http.ResponseWriter, request *http.Request) {
	w.Header().Set("Cache-Control", "private, no-cache")
	id := mux.Vars(request)["key"]
	audit := y.newAuditor("secret.receipt_checked", y.getRealClientIP(request), nil)
	audit.setSecretID(id)

	r, ok := y.loadReceipt(id)
	if !ok {
		audit.failure("not found")
		jsonError(w, http.StatusNotFound, "Receipt not found")
		return
	}

	if !r.tokenValid(request.Header.Get(receiptTokenHeader)) {
		audit.denied("invalid receipt token")
		jsonError(w, http.StatusUnauthorized, "Invalid receipt token")
		return
	}

	audit.success()
	resp := map[string]interface{}{
		"state":      r.State,
		"one_time":   r.OneTime,
		"created_at": r.CreatedAt,
		"expires_at": r.ExpiresAt,
	}
	if r.ViewedAt != 0 {
		resp["viewed_at"] = r.ViewedAt
	}
	y.writeJSON(w, http.StatusOK, resp)
}
