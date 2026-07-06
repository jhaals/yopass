package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"strconv"
	"time"

	"github.com/gorilla/mux"
	"github.com/jhaals/yopass/pkg/yopass"
	"go.uber.org/zap"
)

const streamKeyPrefix = "stream:"

// streamUpload handles streaming file uploads.
// The encrypted binary data is streamed directly to the FileStore
// while metadata is stored in the Database.
func (y *Server) streamUpload(w http.ResponseWriter, r *http.Request) {
	session, _ := y.getSession(r)
	audit := y.newAuditor("file.uploaded", y.getRealClientIP(r), session)

	mediaType, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if mediaType != "application/octet-stream" {
		audit.failure("invalid content-type")
		jsonError(w, http.StatusBadRequest, "Content-Type must be application/octet-stream")
		return
	}

	// Parse headers
	expirationStr := r.Header.Get("X-Yopass-Expiration")
	if expirationStr == "" {
		audit.failure("missing expiration header")
		jsonError(w, http.StatusBadRequest, "X-Yopass-Expiration header required")
		return
	}
	expiration, err := strconv.ParseInt(expirationStr, 10, 32)
	if err != nil || !validExpiration(int32(expiration)) {
		audit.failure("invalid expiration")
		jsonError(w, http.StatusBadRequest, "Invalid expiration specified")
		return
	}

	if y.ForceExpiration != "" {
		forced := expirationInSeconds(y.ForceExpiration)
		if int32(expiration) != forced {
			audit.failure("expiration does not match forced value")
			jsonError(w, http.StatusBadRequest, "Expiration does not match server policy")
			return
		}
	}

	oneTime := r.Header.Get("X-Yopass-OneTime") == "true"
	if !oneTime && y.ForceOneTimeSecrets {
		audit.failure("one-time required by server policy")
		jsonError(w, http.StatusBadRequest, "Secret must be one time download")
		return
	}

	requireAuth := r.Header.Get("X-Yopass-RequireAuth") == "true"
	if requireAuth && y.OIDCProvider == nil {
		audit.failure("auth required but OIDC not configured")
		jsonError(w, http.StatusBadRequest, "Authentication not configured on this server")
		return
	}

	receipt := r.Header.Get("X-Yopass-Receipt") == "true"
	if receipt && !y.readReceiptsEnabled() {
		audit.failure("read receipts not enabled")
		jsonError(w, http.StatusBadRequest, "Read receipts are not enabled on this server")
		return
	}

	// Reject early if Content-Length exceeds limit
	if y.MaxFileSize > 0 && r.ContentLength > y.MaxFileSize {
		audit.failure("file too large")
		jsonError(w, http.StatusRequestEntityTooLarge, "File too large")
		return
	}

	// Enforce max length on actual bytes read (safety net for missing/lying Content-Length)
	var body io.Reader = r.Body
	if y.MaxFileSize > 0 {
		body = http.MaxBytesReader(w, r.Body, y.MaxFileSize)
	}

	// Validate that the stream starts with a valid OpenPGP packet
	var peek [1]byte
	if _, err := io.ReadFull(body, peek[:]); err != nil {
		audit.failure("not an OpenPGP message")
		jsonError(w, http.StatusBadRequest, "Invalid data: not an OpenPGP message")
		return
	}
	if !isOpenPGPBinary(peek[0]) {
		audit.failure("not an OpenPGP message")
		jsonError(w, http.StatusBadRequest, "Invalid data: not an OpenPGP message")
		return
	}
	body = io.MultiReader(bytes.NewReader(peek[:]), body)

	key, err := yopass.GenerateID()
	if err != nil {
		y.Logger.Error("Unable to generate ID", zap.Error(err))
		audit.failure("failed to generate ID")
		jsonError(w, http.StatusInternalServerError, "Unable to generate ID")
		return
	}
	audit.setSecretID(key)

	// Store the receipt before the file: if it fails the request aborts
	// without leaving a file that silently lacks its requested receipt.
	response := map[string]string{"message": key}
	if receipt {
		token, err := y.createReceipt(key, oneTime, int32(expiration))
		if err != nil {
			y.Logger.Error("Unable to store read receipt", zap.Error(err))
			audit.failure("failed to store receipt")
			jsonError(w, http.StatusInternalServerError, "Failed to store receipt in database")
			return
		}
		response["receipt_token"] = token
	}

	// Stream body to file store with expiration set atomically.
	contentLength := r.ContentLength // may be -1 if unknown
	ctx := r.Context()
	if err := y.FileStore.Save(ctx, key, body, contentLength, int32(expiration)); err != nil {
		y.Logger.Error("Failed to save streaming file", zap.Error(err))
		var maxBytesErr *http.MaxBytesError
		if errors.As(err, &maxBytesErr) {
			audit.failure("file too large")
			jsonError(w, http.StatusRequestEntityTooLarge, "File too large")
		} else {
			audit.failure("failed to store file")
			jsonError(w, http.StatusInternalServerError, "Failed to store file")
		}
		return
	}

	// Store metadata in database
	meta := yopass.Secret{
		Expiration:  int32(expiration),
		OneTime:     oneTime,
		RequireAuth: requireAuth,
	}
	if err := y.DB.Put(streamKeyPrefix+key, meta); err != nil {
		y.Logger.Error("Failed to store stream metadata", zap.Error(err))
		// Clean up the file since metadata storage failed
		if delErr := y.FileStore.Delete(ctx, key); delErr != nil {
			y.Logger.Error("Failed to delete file after metadata DB error", zap.Error(delErr))
		}
		audit.failure("failed to store metadata")
		jsonError(w, http.StatusInternalServerError, "Failed to store metadata")
		return
	}

	audit.success(withOneTime(oneTime), withExpiration(int32(expiration)), withRequireAuth(requireAuth))
	y.webhookCreated(key, WebhookKindFile, oneTime, int32(expiration))
	y.writeJSON(w, http.StatusOK, response)
}

// streamDownload serves the encrypted file as a binary stream.
func (y *Server) streamDownload(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-cache")

	key := mux.Vars(r)["key"]
	session, sessionErr := y.getSession(r)
	audit := y.newAuditor("file.downloaded", y.getRealClientIP(r), session)
	audit.setSecretID(key)

	// Read metadata without consuming it (Status never deletes).
	secret, err := y.DB.Status(streamKeyPrefix + key)
	if err != nil {
		y.Logger.Debug("Stream secret not found", zap.Error(err))
		audit.failure("not found")
		jsonError(w, http.StatusNotFound, "Secret not found")
		return
	}

	if !y.authorizeSecretAccess(w, secret, session, sessionErr, audit) {
		return
	}

	isOneTime := secret.OneTime

	// For one-time secrets: atomically claim ownership by deleting the metadata
	// key BEFORE loading the file.
	if isOneTime && !y.claimOneTimeSecret(w, streamKeyPrefix+key, audit) {
		return
	}

	// Load file from store
	ctx := r.Context()
	reader, size, err := y.FileStore.Load(ctx, key)
	if err != nil {
		y.Logger.Error("Failed to load streaming file", zap.Error(err))
		// DB metadata exists but the file is gone — clean up the stale DB entry.
		if !isOneTime {
			if _, delErr := y.DB.Delete(streamKeyPrefix + key); delErr != nil {
				y.Logger.Error("Failed to clean up stale stream metadata", zap.Error(delErr))
			}
		}
		audit.failure("file not found in store")
		jsonError(w, http.StatusNotFound, "File not found")
		return
	}
	defer reader.Close()

	// Set response headers
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Access-Control-Expose-Headers", "Content-Length")
	if size > 0 {
		w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
	}

	// Stream the file
	if _, err := io.Copy(w, reader); err != nil {
		y.Logger.Error("Failed to stream file", zap.Error(err))
		return
	}

	audit.success(withOneTime(isOneTime), withRequireAuth(secret.RequireAuth))
	y.markReceiptViewed(key)
	y.webhookViewed(key, WebhookKindFile, isOneTime)

	// Delete the file after streaming for one-time secrets.
	// Metadata was already deleted above (before file load) to prevent replay.
	if isOneTime {
		delCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := y.FileStore.Delete(delCtx, key); err != nil {
			y.Logger.Error("Failed to delete one-time streaming file", zap.Error(err))
			audit.withEvent("file.cleanup_failed").failure("failed to delete file from store after delivery")
		}
	}
}

// deleteStreamSecret deletes both the metadata and the file.
func (y *Server) deleteStreamSecret(w http.ResponseWriter, r *http.Request) {
	key := mux.Vars(r)["key"]
	session, sessionErr := y.getSession(r)
	audit := y.newAuditor("file.deleted", y.getRealClientIP(r), session)
	audit.setSecretID(key)

	// Check metadata first to enforce RequireAuth before allowing deletion.
	secret, err := y.DB.Status(streamKeyPrefix + key)
	if err != nil {
		audit.failure("not found")
		jsonError(w, http.StatusNotFound, "Secret not found")
		return
	}

	if !y.authorizeSecretAccess(w, secret, session, sessionErr, audit) {
		return
	}

	deleted, err := y.DB.Delete(streamKeyPrefix + key)
	if err != nil {
		audit.failure("database error")
		jsonError(w, http.StatusInternalServerError, "Failed to delete secret")
		return
	}
	if !deleted {
		audit.failure("not found")
		jsonError(w, http.StatusNotFound, "Secret not found")
		return
	}

	if err := y.FileStore.Delete(r.Context(), key); err != nil {
		y.Logger.Error("Failed to delete streaming file", zap.Error(err))
		audit.failure("failed to delete file from store")
		jsonError(w, http.StatusInternalServerError, "Failed to delete secret file")
		return
	}

	audit.success()
	y.webhookDeleted(key)
	w.WriteHeader(http.StatusNoContent)
}

// getStreamSecretStatus returns status for a streaming secret.
func (y *Server) getStreamSecretStatus(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-cache")
	w.Header().Set("Content-Type", "application/json")

	key := mux.Vars(r)["key"]
	session, _ := y.getSession(r)
	audit := y.newAuditor("file.status_checked", y.getRealClientIP(r), session)
	audit.setSecretID(key)

	secret, err := y.DB.Status(streamKeyPrefix + key)
	if err != nil {
		y.Logger.Debug("Stream secret not found", zap.Error(err))
		audit.failure("not found")
		jsonError(w, http.StatusNotFound, "Secret not found")
		return
	}

	audit.success(withOneTime(secret.OneTime), withRequireAuth(secret.RequireAuth))
	resp := map[string]bool{"oneTime": secret.OneTime, "requireAuth": secret.RequireAuth}
	if err := json.NewEncoder(w).Encode(resp); err != nil {
		y.Logger.Error("Failed to write status response", zap.Error(err))
	}
}

// isOpenPGPBinary reports whether b is a valid OpenPGP packet tag byte
// for the start of an encrypted message (PKESK tag 1 or SKESK tag 3).
func isOpenPGPBinary(b byte) bool {
	if b&0x80 == 0 {
		return false
	}
	var tag int
	if b&0x40 != 0 {
		// New format: tag is bits 5-0
		tag = int(b & 0x3F)
	} else {
		// Old format: tag is bits 5-2
		tag = int((b & 0x3C) >> 2)
	}
	return tag == 1 || tag == 3
}

// streamOptions handles CORS preflight for streaming endpoints, which also
// expose Content-Length so browsers can track download progress.
func (y *Server) streamOptions(w http.ResponseWriter, r *http.Request) {
	corsPreflight("POST, GET, DELETE, OPTIONS", "Content-Type, X-Yopass-Expiration, X-Yopass-OneTime, X-Yopass-RequireAuth, X-Yopass-Receipt")(w, r)
	w.Header().Set("Access-Control-Expose-Headers", "Content-Length")
}
