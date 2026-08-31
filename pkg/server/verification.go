package server

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"net/mail"
	"strings"
	"time"

	"github.com/gorilla/mux"
	"github.com/jhaals/yopass/pkg/yopass"
	"go.uber.org/zap"
)

// verifyKeyPrefix namespaces recipient verification records in the database
// so they can never be read or deleted through the regular /secret/{key}
// endpoints (the key route pattern cannot match the embedded slash).
const verifyKeyPrefix = "verify/"

// verificationTokenHeader carries the short-lived token proving the caller
// completed recipient verification for a secret.
const verificationTokenHeader = "X-Yopass-Verification-Token"

// recipientsHeader carries the comma-separated recipient list on file uploads,
// mirroring the "recipients" field of the JSON create endpoint.
const recipientsHeader = "X-Yopass-Recipients"

const (
	// maxRecipients bounds the addresses a single secret may be bound to.
	maxRecipients = 10
	// maxRecipientLength is the RFC 5321 maximum forward-path length.
	maxRecipientLength = 254
	// verificationCodeTTL is how long a delivered code stays usable.
	verificationCodeTTL = 10 * time.Minute
	// verificationTokenTTL bounds the window between passing verification and
	// fetching the ciphertext. Long enough for a slow download to start.
	verificationTokenTTL = 5 * time.Minute
	// maxCodeAttempts is the number of wrong guesses that invalidate a code.
	maxCodeAttempts = 5
	// maxCodeSends caps codes issued per secret, bounding both brute force
	// (maxCodeAttempts * maxCodeSends guesses against 10^6) and the volume of
	// mail a single secret can generate.
	maxCodeSends = 3
)

// recipientVerification binds a secret to a set of recipient addresses.
//
// Addresses are never stored: only a salted HMAC of each normalised address
// is kept, and the code is delivered to the address the recipient supplies
// once it matches. A database dump therefore reveals no sender-to-recipient
// graph, and the server cannot be driven to mail an address nobody proved.
// This is data minimisation, not secrecy — an attacker who already guesses
// the recipient can confirm the guess by using it.
type recipientVerification struct {
	Salt string `json:"salt"`
	// EmailHashes and States are parallel: States[i] tracks the recipient
	// whose address hashes to EmailHashes[i]. State is per recipient rather
	// than per secret because a secret may be bound to several addresses, and
	// a shared slot lets one recipient invalidate another's live code or
	// retrieval token simply by verifying at the wrong moment.
	EmailHashes []string         `json:"email_hashes"`
	States      []recipientState `json:"states"`

	CreatedAt int64 `json:"created_at"`
	ExpiresAt int64 `json:"expires_at"`
}

// recipientState is one bound recipient's progress through verification. Each
// recipient gets their own code, attempt and send budgets, and retrieval
// token, so co-recipients cannot interfere with each other.
type recipientState struct {
	CodeHash      string `json:"code_hash,omitempty"`
	CodeExpiresAt int64  `json:"code_expires_at,omitempty"`
	Attempts      int    `json:"attempts"`
	Sends         int    `json:"sends"`

	TokenHash      string `json:"token_hash,omitempty"`
	TokenExpiresAt int64  `json:"token_expires_at,omitempty"`
}

// tokenValid reports whether the presented token is this recipient's live
// retrieval token.
func (s recipientState) tokenValid(token string) bool {
	return s.TokenHash != "" && secondsUntil(s.TokenExpiresAt) > 0 &&
		tokenMatchesHash(token, s.TokenHash)
}

// remainingTTL returns the number of seconds until the record expires, or 0
// if it already has.
func (v recipientVerification) remainingTTL() int32 {
	return secondsUntil(v.ExpiresAt)
}

// wellFormed reports whether a decoded record is usable: it must bind at
// least one recipient and carry exactly one state per recipient, since every
// lookup indexes States by the position of the matching hash.
func (v recipientVerification) wellFormed() bool {
	return len(v.EmailHashes) > 0 && len(v.States) == len(v.EmailHashes)
}

// normalizeEmail folds an address to the form used for hashing. Case folding
// and trimming only: provider-specific rules such as Gmail's dot and plus
// handling are deliberately not applied, because silently matching an address
// the creator did not type would be surprising.
func normalizeEmail(addr string) string {
	return strings.ToLower(strings.TrimSpace(addr))
}

// validRecipient reports whether an address is well formed enough to bind a
// secret to and to hand to an SMTP relay.
func validRecipient(addr string) bool {
	addr = normalizeEmail(addr)
	if addr == "" || len(addr) > maxRecipientLength || !headerSafe(addr) {
		return false
	}
	// net/smtp does not negotiate SMTPUTF8, so a non-ASCII envelope
	// recipient may be rejected by an otherwise standards-compliant relay.
	// Internationalised domains remain usable in their ASCII IDNA form.
	for i := 0; i < len(addr); i++ {
		if addr[i] > 0x7f {
			return false
		}
	}
	parsed, err := mail.ParseAddress(addr)
	// Reject display-name forms ("Name <a@b>"): the stored hash must match
	// exactly what the recipient later types.
	return err == nil && parsed.Address == addr
}

// hashRecipient computes the salted HMAC of a normalised address.
func hashRecipient(saltHex, addr string) (string, error) {
	salt, err := hex.DecodeString(saltHex)
	if err != nil {
		return "", err
	}
	m := hmac.New(sha256.New, salt)
	m.Write([]byte(normalizeEmail(addr)))
	return hex.EncodeToString(m.Sum(nil)), nil
}

// recipientIndex returns the index of the bound recipient matching addr, or
// -1 if there is none. Every stored hash is compared, without an early
// return, so the work does not depend on which entry matched.
func (v recipientVerification) recipientIndex(addr string) int {
	want, err := hashRecipient(v.Salt, addr)
	if err != nil {
		return -1
	}
	idx := -1
	for i, h := range v.EmailHashes {
		eq := subtle.ConstantTimeCompare([]byte(h), []byte(want))
		idx = subtle.ConstantTimeSelect(eq, i, idx)
	}
	return idx
}

// generateVerificationCode returns a uniformly random six-digit code.
func generateVerificationCode() (string, error) {
	n, err := rand.Int(rand.Reader, big.NewInt(1000000))
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%06d", n.Int64()), nil
}

// hashCode returns the storage hash of a verification code, in the same hex
// SHA-256 form that tokenMatchesHash compares against.
func hashCode(code string) string {
	h := sha256.Sum256([]byte(code))
	return hex.EncodeToString(h[:])
}

// errVerificationNotFound aborts an updateVerification callback when the
// stored record is missing, malformed or expired.
var errVerificationNotFound = errors.New("recipient verification not found")

// verificationCanBeCompleted reports whether this instance can run the
// verification exchange, which requires a mail transport to deliver codes. It
// gates route registration only — never enforcement. Enforcement follows the
// flag on the secret (see authorizeRecipient), so an instance in a shared
// fleet that lacks SMTP refuses bound secrets rather than serving them.
//
// Deliberately not gated on the license either: if it were, an expired key
// would turn every existing bound secret into a freely retrievable one.
func (y *Server) verificationCanBeCompleted() bool {
	return y.Mailer != nil
}

// recipientVerificationEnabled reports whether new secrets may be bound to
// recipients: a business feature requiring a currently valid license and a
// configured mail transport. Checked per creation, so it degrades as soon as
// the license expires while existing bound secrets stay protected.
func (y *Server) recipientVerificationEnabled() bool {
	return y.License.CurrentlyValid() && y.Mailer != nil && !y.DisableRecipientVerification
}

// loadVerification fetches and decodes a verification record.
func (y *Server) loadVerification(id string) (recipientVerification, bool) {
	s, err := y.DB.Status(verifyKeyPrefix + id)
	if err != nil {
		return recipientVerification{}, false
	}
	var v recipientVerification
	if err := json.Unmarshal([]byte(s.Message), &v); err != nil || len(v.EmailHashes) == 0 {
		return recipientVerification{}, false
	}
	if v.remainingTTL() == 0 {
		return recipientVerification{}, false
	}
	return v, true
}

// storeVerification persists a verification record with the given TTL.
func (y *Server) storeVerification(id string, v recipientVerification, ttl int32) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return y.DB.Put(verifyKeyPrefix+id, yopass.Secret{
		Message:    string(data),
		Expiration: ttl,
	})
}

// updateVerification atomically mutates a stored record via Database.Update so
// the attempt and send counters stay correct across instances sharing one
// backend. fn may return an error to abort; it is returned unchanged.
func (y *Server) updateVerification(id string, fn func(*recipientVerification) error) error {
	return y.DB.Update(verifyKeyPrefix+id, func(s yopass.Secret) (yopass.Secret, error) {
		var v recipientVerification
		if err := json.Unmarshal([]byte(s.Message), &v); err != nil || !v.wellFormed() {
			return s, errVerificationNotFound
		}
		// Compute the TTL once: a second call could return 0 after the
		// validation, and a zero expiration means "never expire" to the
		// backends, which would persist the record indefinitely.
		ttl := v.remainingTTL()
		if ttl == 0 {
			return s, errVerificationNotFound
		}
		if err := fn(&v); err != nil {
			return s, err
		}
		data, err := json.Marshal(v)
		if err != nil {
			return s, err
		}
		return yopass.Secret{Message: string(data), Expiration: ttl}, nil
	})
}

// clearVerification removes a record whose secret is gone. Best effort: the
// record carries the secret's TTL and expires on its own regardless.
func (y *Server) clearVerification(id string) {
	if _, err := y.DB.Delete(verifyKeyPrefix + id); err != nil {
		y.Logger.Debug("Failed to delete verification record", zap.Error(err))
	}
}

// createVerification binds a secret to the given recipients, storing only a
// salted HMAC of each address. The plaintext addresses are discarded here and
// never persisted.
func (y *Server) createVerification(id string, recipients []string, expiration int32) error {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return err
	}
	saltHex := hex.EncodeToString(salt)

	hashes := make([]string, 0, len(recipients))
	for _, r := range recipients {
		h, err := hashRecipient(saltHex, r)
		if err != nil {
			return err
		}
		hashes = append(hashes, h)
	}

	now := time.Now().UTC()
	return y.storeVerification(id, recipientVerification{
		Salt:        saltHex,
		EmailHashes: hashes,
		States:      make([]recipientState, len(hashes)),
		CreatedAt:   now.Unix(),
		ExpiresAt:   now.Unix() + int64(expiration),
	}, expiration)
}

// authorizeRecipient enforces recipient verification for secret and file
// retrieval. It is called after authorizeSecretAccess and before the one-time
// claim, so an unverified request never burns the secret. It writes the error
// response and audit event itself and reports whether the request may proceed.
//
// The gate keys off the flag on the secret, not off local configuration or
// the presence of the verification record. Both alternatives fail open: an
// instance without a mail transport would serve every bound secret in a
// shared database ungated, and an evicted or unreadable verification record
// would silently drop the gate on a secret that still exists.
func (y *Server) authorizeRecipient(w http.ResponseWriter, id string, secret yopass.Secret, r *http.Request, audit *auditor) bool {
	if !secret.RecipientBound {
		return true
	}
	v, ok := y.loadVerification(id)
	if !ok {
		// The secret says it is bound but the binding is unreadable — evicted
		// under memory pressure, corrupt, or the backend is briefly unhappy.
		// Refuse: the alternative is handing over a secret whose creator asked
		// for it to be restricted.
		y.Logger.Warn("Verification record missing for a bound secret; refusing retrieval",
			zap.String("secret_id", redactSecretID(id)))
		audit.denied("verification record unavailable")
		y.writeJSON(w, http.StatusForbidden, map[string]interface{}{
			"message":               "Recipient verification required",
			"verification_required": true,
		})
		return false
	}
	// Any bound recipient's live token opens the secret; each holds their own.
	token := r.Header.Get(verificationTokenHeader)
	for _, s := range v.States {
		if s.tokenValid(token) {
			return true
		}
	}
	audit.denied("recipient verification required")
	y.writeJSON(w, http.StatusForbidden, map[string]interface{}{
		"message":               "Recipient verification required",
		"verification_required": true,
	})
	return false
}

// verifyRecipientHandler returns the handler for the verification endpoint.
// Text secrets and files share it: records are keyed by the raw ID, so only
// the audit event prefix differs.
//
// The endpoint has two modes. Without a code it requests one; with a code it
// exchanges it for a retrieval token.
func (y *Server) verifyRecipientHandler(eventPrefix string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "private, no-cache")

		id := mux.Vars(r)["key"]
		audit := y.newAuditor(eventPrefix+".verification_requested", y.getRealClientIP(r), nil)
		audit.setSecretID(id)

		var body struct {
			Email string `json:"email"`
			Code  string `json:"code"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil {
			audit.failure("unable to parse json")
			jsonError(w, http.StatusBadRequest, "Unable to parse json")
			return
		}

		if !validRecipient(body.Email) {
			audit.failure("invalid email address")
			jsonError(w, http.StatusBadRequest, "A valid email address is required")
			return
		}

		if _, ok := y.loadVerification(id); !ok {
			audit.failure("not found")
			jsonError(w, http.StatusNotFound, "Secret not found")
			return
		}

		if body.Code == "" {
			y.requestVerificationCode(w, id, body.Email, audit)
			return
		}
		y.redeemVerificationCode(w, id, body.Email, body.Code, audit.withEvent(eventPrefix+".verification_completed"))
	}
}

// requestVerificationCode issues and delivers a code when the supplied address
// is one of the bound recipients.
//
// It always answers 204, whether or not the address matched, so the response
// itself reveals nothing about who the secret is addressed to. The cost is
// that a mistyped address is indistinguishable from a wrong one — the same
// trade every password-reset flow makes.
//
// This closes the response channel, not the timing one: the matching path
// also waits on the SMTP relay and is measurably slower, so a link-holder can
// still identify the bound recipient by latency. Closing that would mean
// either sending asynchronously (losing the delivery-failure signal and the
// send refund below) or padding every non-match to the SMTP timeout. Neither
// is worth it for metadata the docs already treat as recoverable; the
// limitation is documented rather than papered over.
func (y *Server) requestVerificationCode(w http.ResponseWriter, id, email string, audit *auditor) {
	var code string
	var idx int
	err := y.updateVerification(id, func(v *recipientVerification) error {
		// Reset per attempt: Database.Update may replay this callback after a
		// CAS conflict.
		code = ""
		idx = v.recipientIndex(email)
		if idx < 0 || v.States[idx].Sends >= maxCodeSends {
			return nil
		}
		c, err := generateVerificationCode()
		if err != nil {
			return err
		}
		code = c
		s := &v.States[idx]
		s.CodeHash = hashCode(c)
		s.CodeExpiresAt = time.Now().UTC().Add(verificationCodeTTL).Unix()
		s.Attempts = 0
		s.Sends++
		return nil
	})
	if err != nil {
		// A co-recipient consuming a one-time secret deletes the record from
		// under us. That is an ordinary race, not a backend fault. The backend
		// reports the miss as ErrKeyNotFound when the key is already gone at
		// read time, and the callback returns errVerificationNotFound when the
		// record it read is unusable; both mean the same thing here.
		if errors.Is(err, errVerificationNotFound) || errors.Is(err, ErrKeyNotFound) {
			audit.failure("not found")
			jsonError(w, http.StatusNotFound, "Secret not found")
			return
		}
		y.Logger.Error("Failed to update verification record", zap.Error(err))
		audit.failure("database error")
		jsonError(w, http.StatusInternalServerError, "Failed to process verification")
		return
	}

	if code == "" {
		// No match, or the send budget is spent. Report neither.
		audit.denied("no matching recipient or send limit reached")
		w.WriteHeader(http.StatusNoContent)
		return
	}

	// Recorded before sending: a code that reached the recipient but was never
	// stored would be unusable. The reverse — stored but not sent — is
	// recoverable, so refund the send on failure. Without the refund a relay
	// that is briefly down would silently spend the recipient's three attempts
	// and lock them out of a secret permanently.
	if err := y.Mailer.Send(email, y.verificationSubject(), y.verificationBody(code)); err != nil {
		y.Logger.Error("Failed to send verification code", zap.Error(err))
		// Compare-and-swap on the code hash: a concurrent request for the same
		// recipient may already have replaced it, and clearing that one would
		// invalidate a code the recipient has actually received.
		undelivered := hashCode(code)
		if rbErr := y.updateVerification(id, func(v *recipientVerification) error {
			if idx < 0 || idx >= len(v.States) {
				return nil
			}
			s := &v.States[idx]
			if s.CodeHash != undelivered {
				return nil
			}
			if s.Sends > 0 {
				s.Sends--
			}
			s.CodeHash = ""
			s.CodeExpiresAt = 0
			return nil
		}); rbErr != nil {
			y.Logger.Error("Failed to refund verification send", zap.Error(rbErr))
		}
		audit.failure("mail delivery failed")
		// Reveals that the address matched, but only while mail is broken.
		// Reporting the outage is worth more than closing an oracle that a
		// working deployment never opens.
		jsonError(w, http.StatusBadGateway, "Failed to send verification code")
		return
	}

	audit.success()
	w.WriteHeader(http.StatusNoContent)
}

// redeemVerificationCode exchanges a correct code for a short-lived retrieval
// token. Unlike the request step this does report success or failure: the
// secret being checked is the code, not the recipient's identity.
func (y *Server) redeemVerificationCode(w http.ResponseWriter, id, email, code string, audit *auditor) {
	var token string
	err := y.updateVerification(id, func(v *recipientVerification) error {
		token = ""
		idx := v.recipientIndex(email)
		if idx < 0 {
			return nil
		}
		s := &v.States[idx]
		if s.CodeHash == "" || secondsUntil(s.CodeExpiresAt) == 0 {
			return nil
		}
		if s.Attempts >= maxCodeAttempts {
			return nil
		}
		if !tokenMatchesHash(code, s.CodeHash) {
			s.Attempts++
			return nil
		}
		t, hash, err := generateToken()
		if err != nil {
			return err
		}
		token = t
		s.TokenHash = hash
		s.TokenExpiresAt = time.Now().UTC().Add(verificationTokenTTL).Unix()
		// Burn the code: the token is now the credential.
		s.CodeHash = ""
		s.CodeExpiresAt = 0
		s.Attempts = 0
		return nil
	})
	if err != nil {
		// A co-recipient consuming a one-time secret deletes the record from
		// under us. That is an ordinary race, not a backend fault. The backend
		// reports the miss as ErrKeyNotFound when the key is already gone at
		// read time, and the callback returns errVerificationNotFound when the
		// record it read is unusable; both mean the same thing here.
		if errors.Is(err, errVerificationNotFound) || errors.Is(err, ErrKeyNotFound) {
			audit.failure("not found")
			jsonError(w, http.StatusNotFound, "Secret not found")
			return
		}
		y.Logger.Error("Failed to update verification record", zap.Error(err))
		audit.failure("database error")
		jsonError(w, http.StatusInternalServerError, "Failed to process verification")
		return
	}

	if token == "" {
		audit.denied("invalid verification code")
		jsonError(w, http.StatusForbidden, "Invalid or expired verification code")
		return
	}

	audit.success()
	y.writeJSON(w, http.StatusOK, map[string]string{"token": token})
}

// verificationSubject returns the subject line, branded when --app-name is set.
func (y *Server) verificationSubject() string {
	if y.License.CurrentlyValid() && y.AppName != "" {
		return y.AppName + " verification code"
	}
	return "Yopass verification code"
}

// verificationBody renders the message. It carries the code and nothing else:
// no link, no sender identity, and no description of the secret.
func (y *Server) verificationBody(code string) string {
	minutes := int(verificationCodeTTL.Minutes())
	return fmt.Sprintf(
		"Someone shared an encrypted secret with this address and requested a verification code.\n\n"+
			"Your code is: %s\n\n"+
			"It expires in %d minutes and can be used once.\n\n"+
			"If you were not expecting this, you can ignore this message. "+
			"Nobody can open the secret without the code.\n",
		code, minutes)
}

// parseRecipients splits the comma-separated recipient header used by file
// uploads, dropping empty entries.
func parseRecipients(header string) []string {
	if strings.TrimSpace(header) == "" {
		return nil
	}
	parts := strings.Split(header, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}
