package server

import (
	"bytes"
	"context"
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
	if y.FileTransferTimeout > 0 {
		controller := http.NewResponseController(w)
		deadline := time.Now().Add(y.FileTransferTimeout)
		if err := controller.SetReadDeadline(deadline); err != nil {
			y.Logger.Error("Failed to set file upload deadline", zap.Error(err))
			jsonError(w, http.StatusInternalServerError, "Failed to configure file transfer")
			return
		}
		// WriteTimeout starts when the headers are read, so extend it before a
		// long upload can exhaust the shorter ordinary-request deadline.
		if err := controller.SetWriteDeadline(deadline); err != nil {
			y.Logger.Error("Failed to set file upload response deadline", zap.Error(err))
			jsonError(w, http.StatusInternalServerError, "Failed to configure file transfer")
			return
		}
	}

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
	parsed, err := strconv.ParseInt(expirationStr, 10, 32)
	if err != nil {
		audit.failure("invalid expiration")
		jsonError(w, http.StatusBadRequest, "Invalid expiration specified")
		return
	}
	expiration := int32(parsed)

	oneTime := r.Header.Get("X-Yopass-OneTime") == "true"
	requireAuth := r.Header.Get("X-Yopass-RequireAuth") == "true"
	receipt := r.Header.Get("X-Yopass-Receipt") == "true"

	if !y.checkCreationPolicy(w, creationPolicy{
		expiration:  expiration,
		oneTime:     oneTime,
		requireAuth: requireAuth,
		receipt:     receipt,
	}, audit) {
		return
	}

	// Reject early if Content-Length exceeds limit
	maxFileSize := y.effectiveMaxFileSize()
	if maxFileSize > 0 && r.ContentLength > maxFileSize {
		audit.failure("file too large")
		jsonError(w, http.StatusRequestEntityTooLarge, "File too large")
		return
	}

	// Enforce max length on actual bytes read (safety net for missing/lying Content-Length)
	var body io.Reader = r.Body
	if maxFileSize > 0 {
		body = http.MaxBytesReader(w, r.Body, maxFileSize)
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

	// Stream body to file store with expiration set atomically.
	contentLength := r.ContentLength // may be -1 if unknown
	ctx := r.Context()
	if err := y.FileStore.Save(ctx, key, body, contentLength, expiration); err != nil {
		y.Logger.Error("Failed to save streaming file", redactedError(err, key))
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
		Expiration:  expiration,
		OneTime:     oneTime,
		RequireAuth: requireAuth,
	}
	if err := y.DB.Put(streamKeyPrefix+key, meta); err != nil {
		y.Logger.Error("Failed to store stream metadata", zap.Error(err))
		// Clean up the file since metadata storage failed
		if delErr := y.FileStore.Delete(ctx, key); delErr != nil {
			y.Logger.Error("Failed to delete file after metadata DB error", redactedError(delErr, key))
		}
		audit.failure("failed to store metadata")
		jsonError(w, http.StatusInternalServerError, "Failed to store metadata")
		return
	}

	// Start the receipt TTL after upload so it cannot expire before the file.
	response := map[string]string{"message": key}
	if receipt {
		token, err := y.createReceipt(key, oneTime, expiration)
		if err != nil {
			y.Logger.Error("Unable to store read receipt", zap.Error(err))
			if _, delErr := y.DB.Delete(streamKeyPrefix + key); delErr != nil {
				y.Logger.Error("Failed to delete stream metadata after receipt error", zap.Error(delErr))
			}
			delCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			if delErr := y.FileStore.Delete(delCtx, key); delErr != nil {
				y.Logger.Error("Failed to delete file after receipt error", redactedError(delErr, key))
			}
			audit.failure("failed to store receipt")
			jsonError(w, http.StatusInternalServerError, "Failed to store receipt in database")
			return
		}
		response["receipt_token"] = token
	}

	audit.success(withOneTime(oneTime), withExpiration(expiration), withRequireAuth(requireAuth))
	y.webhookCreated(key, WebhookKindFile, oneTime, expiration)
	y.writeJSON(w, http.StatusOK, response)
}

// streamDownload serves the encrypted file as a binary stream.
func (y *Server) streamDownload(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if y.FileTransferTimeout > 0 {
		if err := http.NewResponseController(w).SetWriteDeadline(time.Now().Add(y.FileTransferTimeout)); err != nil {
			y.Logger.Error("Failed to set file download deadline", zap.Error(err))
			jsonError(w, http.StatusInternalServerError, "Failed to configure file transfer")
			return
		}
	}

	key := mux.Vars(r)["key"]
	session, sessionErr := y.getSession(r)
	audit := y.newAuditor("file.downloaded", y.getRealClientIP(r), session)
	audit.setSecretID(key)

	secret, ok := y.readAuthorizedSecret(w, streamKeyPrefix+key, key, session, sessionErr, audit)
	if !ok {
		return
	}
	isOneTime := secret.OneTime

	// Delete claimed files even when delivery fails; they can no longer be retrieved.
	// Metadata was already deleted above (before file load) to prevent replay.
	if isOneTime {
		defer func() {
			delCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := y.FileStore.Delete(delCtx, key); err != nil {
				y.Logger.Error("Failed to delete one-time streaming file", redactedError(err, key))
				audit.withEvent("file.cleanup_failed").failure("failed to delete file from store after delivery")
			}
		}()
	}

	// Load file from store
	ctx := r.Context()
	reader, size, err := y.FileStore.Load(ctx, key)
	if err != nil {
		y.Logger.Error("Failed to load streaming file", redactedError(err, key))
		// Only a definite not-found means the file is gone. Anything else
		// (network blip, credentials, disk) is transient. A multi-view secret
		// keeps its metadata and is retrievable once the store recovers; a
		// one-time secret was already claimed above and is lost either way.
		if !errors.Is(err, ErrKeyNotFound) {
			audit.failure("file store unavailable")
			jsonError(w, http.StatusServiceUnavailable, "File store temporarily unavailable")
			return
		}
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

	// Record access before streaming: a disconnect must not hide a consumed file.
	audit.success(withOneTime(isOneTime), withRequireAuth(secret.RequireAuth))
	y.webhookViewed(key, WebhookKindFile, isOneTime)

	// Stream the file
	if _, err := io.Copy(w, reader); err != nil {
		y.Logger.Error("Failed to stream file", redactedError(err, key))
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
