package server

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/gorilla/mux"
	"github.com/jhaals/yopass/pkg/yopass"
	"go.uber.org/zap"
)

// createSecret validates and stores a new PGP-encrypted secret, responding
// with the generated secret ID.
func (y *Server) createSecret(w http.ResponseWriter, request *http.Request) {
	session, _ := y.getSession(request)
	audit := y.newAuditor("secret.created", y.getRealClientIP(request), session)

	// Cap the body so an oversized message is rejected before it is buffered,
	// rather than after, by the MaxLength check below.
	reader := http.MaxBytesReader(w, request.Body, jsonBodyLimit(int64(y.MaxLength)))
	var body struct {
		yopass.Secret
		Receipt bool `json:"receipt"`
	}
	if err := json.NewDecoder(reader).Decode(&body); err != nil {
		var maxBytesErr *http.MaxBytesError
		if errors.As(err, &maxBytesErr) {
			audit.failure("request body too large")
			tooLarge(w, request.Body)
			return
		}
		y.Logger.Debug("Unable to decode request", zap.Error(err))
		jsonError(w, http.StatusBadRequest, "Unable to parse json")
		return
	}
	s := body.Secret

	if !y.checkCreationPolicy(w, creationPolicy{
		expiration:  s.Expiration,
		oneTime:     s.OneTime,
		requireAuth: s.RequireAuth,
		receipt:     body.Receipt,
	}, audit) {
		return
	}

	if len(s.Message) > y.MaxLength {
		audit.failure("message too long")
		jsonError(w, http.StatusBadRequest, "The encrypted message is too long")
		return
	}

	if !isPGPEncrypted(s.Message) {
		audit.failure("message not PGP encrypted")
		jsonError(w, http.StatusBadRequest, "Message must be PGP encrypted")
		return
	}

	key, err := yopass.GenerateID()
	if err != nil {
		y.Logger.Error("Unable to generate ID", zap.Error(err))
		audit.failure("failed to generate ID")
		jsonError(w, http.StatusInternalServerError, "Unable to generate ID")
		return
	}
	audit.setSecretID(key)

	// Store the receipt before the secret: if it fails the request aborts
	// without leaving a secret that silently lacks its requested receipt.
	response := map[string]string{"message": key}
	if body.Receipt {
		token, err := y.createReceipt(key, s.OneTime, s.Expiration)
		if err != nil {
			y.Logger.Error("Unable to store read receipt", zap.Error(err))
			audit.failure("failed to store receipt")
			jsonError(w, http.StatusInternalServerError, "Failed to store receipt in database")
			return
		}
		response["receipt_token"] = token
	}

	// store secret in database with specified expiration.
	if err := y.DB.Put(key, s); err != nil {
		y.Logger.Error("Unable to store secret", zap.Error(err))
		audit.failure("database error")
		jsonError(w, http.StatusInternalServerError, "Failed to store secret in database")
		return
	}

	audit.success(withOneTime(s.OneTime), withExpiration(s.Expiration), withRequireAuth(s.RequireAuth))
	y.webhookCreated(key, WebhookKindSecret, s.OneTime, s.Expiration)
	y.writeJSON(w, http.StatusOK, response)
}

// getSecret returns a secret, consuming it when it is one-time.
func (y *Server) getSecret(w http.ResponseWriter, request *http.Request) {
	w.Header().Set("Cache-Control", "private, no-cache")

	secretKey := mux.Vars(request)["key"]
	session, sessionErr := y.getSession(request)
	audit := y.newAuditor("secret.accessed", y.getRealClientIP(request), session)
	audit.setSecretID(secretKey)

	secret, ok := y.readAuthorizedSecret(w, secretKey, session, sessionErr, audit)
	if !ok {
		return
	}

	// Log success before writing: for one-time secrets the secret has already
	// been deleted, so the meaningful outcome (consumed) is already determined.
	// Logging after a write failure would record the wrong outcome.
	audit.success(withOneTime(secret.OneTime), withRequireAuth(secret.RequireAuth))
	y.markReceiptViewed(secretKey)
	y.webhookViewed(secretKey, WebhookKindSecret, secret.OneTime)
	y.writeJSON(w, http.StatusOK, secret)
}

// secretStatusHandler returns the handler for the non-destructive status
// endpoint. Text secrets and files share it; they differ only in database
// key prefix and audit event name.
func (y *Server) secretStatusHandler(keyPrefix, auditEvent string) http.HandlerFunc {
	return func(w http.ResponseWriter, request *http.Request) {
		w.Header().Set("Cache-Control", "private, no-cache")

		key := mux.Vars(request)["key"]
		session, _ := y.getSession(request)
		audit := y.newAuditor(auditEvent, y.getRealClientIP(request), session)
		audit.setSecretID(key)

		secret, err := y.DB.Status(keyPrefix + key)
		if err != nil {
			y.Logger.Debug("Secret not found", zap.Error(err))
			audit.failure("not found")
			jsonError(w, http.StatusNotFound, "Secret not found")
			return
		}

		audit.success(withOneTime(secret.OneTime), withRequireAuth(secret.RequireAuth))
		y.writeJSON(w, http.StatusOK, map[string]bool{
			"oneTime":     secret.OneTime,
			"requireAuth": secret.RequireAuth,
		})
	}
}

// deleteSecretHandler returns the handler removing a secret ahead of its
// expiration, enforcing RequireAuth before the deletion is allowed. Text
// secrets and files share it; files additionally remove the stored blob
// (deleteBlob) after the metadata key is gone.
func (y *Server) deleteSecretHandler(keyPrefix, auditEvent string, deleteBlob bool) http.HandlerFunc {
	return func(w http.ResponseWriter, request *http.Request) {
		key := mux.Vars(request)["key"]
		session, sessionErr := y.getSession(request)
		audit := y.newAuditor(auditEvent, y.getRealClientIP(request), session)
		audit.setSecretID(key)

		authorized := false
		deleted, err := y.DB.DeleteAuthorized(keyPrefix+key, func(secret yopass.Secret) error {
			if !y.authorizeSecretAccess(w, secret, session, sessionErr, audit) {
				return errSecretAccessDenied
			}
			authorized = true
			return nil
		})
		if errors.Is(err, errSecretAccessDenied) {
			return
		}
		if err != nil && authorized && !errors.Is(err, ErrKeyNotFound) {
			audit.failure("database error")
			jsonError(w, http.StatusInternalServerError, "Failed to delete secret")
			return
		}
		if err != nil || !deleted {
			audit.failure("not found")
			jsonError(w, http.StatusNotFound, "Secret not found")
			return
		}

		if deleteBlob {
			if err := y.FileStore.Delete(request.Context(), key); err != nil {
				y.Logger.Error("Failed to delete streaming file", zap.Error(err))
				audit.failure("failed to delete file from store")
				jsonError(w, http.StatusInternalServerError, "Failed to delete secret file")
				return
			}
		}

		audit.success()
		y.webhookDeleted(key)
		w.WriteHeader(http.StatusNoContent)
	}
}
