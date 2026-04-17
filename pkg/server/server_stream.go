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
	clientIP := y.getRealClientIP(r)

	mediaType, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if mediaType != "application/octet-stream" {
		y.audit().Log(AuditEvent{
			Timestamp: time.Now().UTC(), Event: "file.uploaded", Outcome: OutcomeFailure,
			ClientIP: clientIP, UserEmail: sessionEmail(session), UserSubject: sessionSub(session),
			Error: "invalid content-type",
		})
		http.Error(w, `{"message": "Content-Type must be application/octet-stream"}`, http.StatusBadRequest)
		return
	}

	// Parse headers
	expirationStr := r.Header.Get("X-Yopass-Expiration")
	if expirationStr == "" {
		y.audit().Log(AuditEvent{
			Timestamp: time.Now().UTC(), Event: "file.uploaded", Outcome: OutcomeFailure,
			ClientIP: clientIP, UserEmail: sessionEmail(session), UserSubject: sessionSub(session),
			Error: "missing expiration header",
		})
		http.Error(w, `{"message": "X-Yopass-Expiration header required"}`, http.StatusBadRequest)
		return
	}
	expiration, err := strconv.ParseInt(expirationStr, 10, 32)
	if err != nil || !validExpiration(int32(expiration)) {
		y.audit().Log(AuditEvent{
			Timestamp: time.Now().UTC(), Event: "file.uploaded", Outcome: OutcomeFailure,
			ClientIP: clientIP, UserEmail: sessionEmail(session), UserSubject: sessionSub(session),
			Error: "invalid expiration",
		})
		http.Error(w, `{"message": "Invalid expiration specified"}`, http.StatusBadRequest)
		return
	}

	oneTimeStr := r.Header.Get("X-Yopass-OneTime")
	oneTime := oneTimeStr == "true"

	if !oneTime && y.ForceOneTimeSecrets {
		y.audit().Log(AuditEvent{
			Timestamp: time.Now().UTC(), Event: "file.uploaded", Outcome: OutcomeFailure,
			ClientIP: clientIP, UserEmail: sessionEmail(session), UserSubject: sessionSub(session),
			Error: "one-time required by server policy",
		})
		http.Error(w, `{"message": "Secret must be one time download"}`, http.StatusBadRequest)
		return
	}

	requireAuth := r.Header.Get("X-Yopass-RequireAuth") == "true"
	if requireAuth && y.OIDCProvider == nil {
		y.audit().Log(AuditEvent{
			Timestamp: time.Now().UTC(), Event: "file.uploaded", Outcome: OutcomeFailure,
			ClientIP: clientIP, UserEmail: sessionEmail(session), UserSubject: sessionSub(session),
			Error: "auth required but OIDC not configured",
		})
		http.Error(w, `{"message": "Authentication not configured on this server"}`, http.StatusBadRequest)
		return
	}

	// Reject early if Content-Length exceeds limit
	if y.MaxFileSize > 0 && r.ContentLength > y.MaxFileSize {
		y.audit().Log(AuditEvent{
			Timestamp: time.Now().UTC(), Event: "file.uploaded", Outcome: OutcomeFailure,
			ClientIP: clientIP, UserEmail: sessionEmail(session), UserSubject: sessionSub(session),
			Error: "file too large",
		})
		http.Error(w, `{"message": "File too large"}`, http.StatusRequestEntityTooLarge)
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
		y.audit().Log(AuditEvent{
			Timestamp: time.Now().UTC(), Event: "file.uploaded", Outcome: OutcomeFailure,
			ClientIP: clientIP, UserEmail: sessionEmail(session), UserSubject: sessionSub(session),
			Error: "not an OpenPGP message",
		})
		http.Error(w, `{"message": "Invalid data: not an OpenPGP message"}`, http.StatusBadRequest)
		return
	}
	if !isOpenPGPBinary(peek[0]) {
		y.audit().Log(AuditEvent{
			Timestamp: time.Now().UTC(), Event: "file.uploaded", Outcome: OutcomeFailure,
			ClientIP: clientIP, UserEmail: sessionEmail(session), UserSubject: sessionSub(session),
			Error: "not an OpenPGP message",
		})
		http.Error(w, `{"message": "Invalid data: not an OpenPGP message"}`, http.StatusBadRequest)
		return
	}
	body = io.MultiReader(bytes.NewReader(peek[:]), body)

	// Generate secret ID
	key, err := yopass.GenerateID()
	if err != nil {
		y.Logger.Error("Unable to generate ID", zap.Error(err))
		y.audit().Log(AuditEvent{
			Timestamp: time.Now().UTC(), Event: "file.uploaded", Outcome: OutcomeFailure,
			ClientIP: clientIP, UserEmail: sessionEmail(session), UserSubject: sessionSub(session),
			Error: "failed to generate ID",
		})
		http.Error(w, `{"message": "Unable to generate ID"}`, http.StatusInternalServerError)
		return
	}

	// Stream body to file store with expiration set atomically.
	contentLength := r.ContentLength // may be -1 if unknown
	ctx := r.Context()
	if err := y.FileStore.Save(ctx, key, body, contentLength, int32(expiration)); err != nil {
		y.Logger.Error("Failed to save streaming file", zap.Error(err))
		var maxBytesErr *http.MaxBytesError
		if errors.As(err, &maxBytesErr) {
			y.audit().Log(AuditEvent{
				Timestamp: time.Now().UTC(), Event: "file.uploaded", Outcome: OutcomeFailure,
				ClientIP: clientIP, SecretID: key,
				UserEmail: sessionEmail(session), UserSubject: sessionSub(session),
				Error: "file too large",
			})
			http.Error(w, `{"message": "File too large"}`, http.StatusRequestEntityTooLarge)
		} else {
			y.audit().Log(AuditEvent{
				Timestamp: time.Now().UTC(), Event: "file.uploaded", Outcome: OutcomeFailure,
				ClientIP: clientIP, SecretID: key,
				UserEmail: sessionEmail(session), UserSubject: sessionSub(session),
				Error: "failed to store file",
			})
			http.Error(w, `{"message": "Failed to store file"}`, http.StatusInternalServerError)
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
		y.audit().Log(AuditEvent{
			Timestamp: time.Now().UTC(), Event: "file.uploaded", Outcome: OutcomeFailure,
			ClientIP: clientIP, SecretID: key,
			UserEmail: sessionEmail(session), UserSubject: sessionSub(session),
			Error: "failed to store metadata",
		})
		http.Error(w, `{"message": "Failed to store metadata"}`, http.StatusInternalServerError)
		return
	}

	y.audit().Log(AuditEvent{
		Timestamp: time.Now().UTC(), Event: "file.uploaded", Outcome: OutcomeSuccess,
		ClientIP: clientIP, SecretID: key,
		OneTime: boolPtr(oneTime), ExpirationSeconds: int32Ptr(int32(expiration)), RequireAuth: boolPtr(requireAuth),
		UserEmail: sessionEmail(session), UserSubject: sessionSub(session),
	})
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(map[string]string{"message": key}); err != nil {
		y.Logger.Error("Failed to write response", zap.Error(err))
	}
}

// streamDownload serves the encrypted file as a binary stream.
func (y *Server) streamDownload(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-cache")

	key := mux.Vars(r)["key"]
	session, sessionErr := y.getSession(r)
	clientIP := y.getRealClientIP(r)

	// Read metadata without consuming it (Status never deletes).
	secret, err := y.DB.Status(streamKeyPrefix + key)
	if err != nil {
		y.Logger.Debug("Stream secret not found", zap.Error(err))
		y.audit().Log(AuditEvent{
			Timestamp: time.Now().UTC(), Event: "file.downloaded", Outcome: OutcomeFailure,
			ClientIP: clientIP, SecretID: key,
			UserEmail: sessionEmail(session), UserSubject: sessionSub(session),
			Error: "not found",
		})
		http.Error(w, `{"message": "Secret not found"}`, http.StatusNotFound)
		return
	}

	if secret.RequireAuth {
		w.Header().Set("Content-Type", "application/json")
		if sessionErr != nil || session == nil {
			y.audit().Log(AuditEvent{
				Timestamp: time.Now().UTC(), Event: "file.downloaded", Outcome: OutcomeDenied,
				ClientIP: clientIP, SecretID: key, RequireAuth: boolPtr(true),
				Error: "authentication required",
			})
			http.Error(w, `{"message": "authentication required"}`, http.StatusUnauthorized)
			return
		}
		if !emailAllowed(session.Email) {
			y.audit().Log(AuditEvent{
				Timestamp: time.Now().UTC(), Event: "file.downloaded", Outcome: OutcomeDenied,
				ClientIP: clientIP, SecretID: key, RequireAuth: boolPtr(true),
				UserEmail: session.Email, UserSubject: session.Sub,
				Error: "email domain not permitted",
			})
			http.Error(w, `{"message": "email domain not permitted"}`, http.StatusForbidden)
			return
		}
	}

	isOneTime := secret.OneTime

	// For one-time secrets: atomically claim ownership by deleting the metadata key
	// BEFORE loading the file. Delete returns false when the key is already gone,
	// meaning a concurrent request already claimed this secret.
	if isOneTime {
		deleted, err := y.DB.Delete(streamKeyPrefix + key)
		if err != nil {
			y.Logger.Error("Failed to claim one-time stream secret", zap.Error(err))
			y.audit().Log(AuditEvent{
				Timestamp: time.Now().UTC(), Event: "file.downloaded", Outcome: OutcomeFailure,
				ClientIP: clientIP, SecretID: key, OneTime: boolPtr(true),
				UserEmail: sessionEmail(session), UserSubject: sessionSub(session),
				Error: "failed to claim one-time secret",
			})
			http.Error(w, `{"message": "Failed to process secret"}`, http.StatusInternalServerError)
			return
		}
		if !deleted {
			y.audit().Log(AuditEvent{
				Timestamp: time.Now().UTC(), Event: "file.downloaded", Outcome: OutcomeDenied,
				ClientIP: clientIP, SecretID: key, OneTime: boolPtr(true),
				UserEmail: sessionEmail(session), UserSubject: sessionSub(session),
				Error: "claimed by concurrent request",
			})
			http.Error(w, `{"message": "Secret not found"}`, http.StatusNotFound)
			return
		}
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
		y.audit().Log(AuditEvent{
			Timestamp: time.Now().UTC(), Event: "file.downloaded", Outcome: OutcomeFailure,
			ClientIP: clientIP, SecretID: key,
			UserEmail: sessionEmail(session), UserSubject: sessionSub(session),
			Error: "file not found in store",
		})
		http.Error(w, `{"message": "File not found"}`, http.StatusNotFound)
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

	y.audit().Log(AuditEvent{
		Timestamp: time.Now().UTC(), Event: "file.downloaded", Outcome: OutcomeSuccess,
		ClientIP: clientIP, SecretID: key,
		OneTime: boolPtr(isOneTime), RequireAuth: boolPtr(secret.RequireAuth),
		UserEmail: sessionEmail(session), UserSubject: sessionSub(session),
	})

	// Delete the file after streaming for one-time secrets.
	// Metadata was already deleted above (before file load) to prevent replay.
	if isOneTime {
		delCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := y.FileStore.Delete(delCtx, key); err != nil {
			y.Logger.Error("Failed to delete one-time streaming file", zap.Error(err))
			y.audit().Log(AuditEvent{
				Timestamp: time.Now().UTC(), Event: "file.cleanup_failed", Outcome: OutcomeFailure,
				ClientIP: clientIP, SecretID: key,
				UserEmail: sessionEmail(session), UserSubject: sessionSub(session),
				Error: "failed to delete file from store after delivery",
			})
		}
	}
}

// deleteStreamSecret deletes both the metadata and the file.
func (y *Server) deleteStreamSecret(w http.ResponseWriter, r *http.Request) {
	key := mux.Vars(r)["key"]
	session, sessionErr := y.getSession(r)
	clientIP := y.getRealClientIP(r)

	// Check metadata first to enforce RequireAuth before allowing deletion.
	secret, err := y.DB.Status(streamKeyPrefix + key)
	if err != nil {
		y.audit().Log(AuditEvent{
			Timestamp: time.Now().UTC(), Event: "file.deleted", Outcome: OutcomeFailure,
			ClientIP: clientIP, SecretID: key,
			UserEmail: sessionEmail(session), UserSubject: sessionSub(session),
			Error: "not found",
		})
		http.Error(w, `{"message": "Secret not found"}`, http.StatusNotFound)
		return
	}

	if secret.RequireAuth {
		w.Header().Set("Content-Type", "application/json")
		if sessionErr != nil || session == nil {
			y.audit().Log(AuditEvent{
				Timestamp: time.Now().UTC(), Event: "file.deleted", Outcome: OutcomeDenied,
				ClientIP: clientIP, SecretID: key, RequireAuth: boolPtr(true),
				Error: "authentication required",
			})
			http.Error(w, `{"message": "authentication required"}`, http.StatusUnauthorized)
			return
		}
		if !emailAllowed(session.Email) {
			y.audit().Log(AuditEvent{
				Timestamp: time.Now().UTC(), Event: "file.deleted", Outcome: OutcomeDenied,
				ClientIP: clientIP, SecretID: key, RequireAuth: boolPtr(true),
				UserEmail: session.Email, UserSubject: session.Sub,
				Error: "email domain not permitted",
			})
			http.Error(w, `{"message": "email domain not permitted"}`, http.StatusForbidden)
			return
		}
	}

	deleted, err := y.DB.Delete(streamKeyPrefix + key)
	if err != nil {
		y.audit().Log(AuditEvent{
			Timestamp: time.Now().UTC(), Event: "file.deleted", Outcome: OutcomeFailure,
			ClientIP: clientIP, SecretID: key,
			UserEmail: sessionEmail(session), UserSubject: sessionSub(session),
			Error: "database error",
		})
		http.Error(w, `{"message": "Failed to delete secret"}`, http.StatusInternalServerError)
		return
	}
	if !deleted {
		y.audit().Log(AuditEvent{
			Timestamp: time.Now().UTC(), Event: "file.deleted", Outcome: OutcomeFailure,
			ClientIP: clientIP, SecretID: key,
			UserEmail: sessionEmail(session), UserSubject: sessionSub(session),
			Error: "not found",
		})
		http.Error(w, `{"message": "Secret not found"}`, http.StatusNotFound)
		return
	}

	if err := y.FileStore.Delete(r.Context(), key); err != nil {
		y.Logger.Error("Failed to delete streaming file", zap.Error(err))
		y.audit().Log(AuditEvent{
			Timestamp: time.Now().UTC(), Event: "file.deleted", Outcome: OutcomeFailure,
			ClientIP: clientIP, SecretID: key,
			UserEmail: sessionEmail(session), UserSubject: sessionSub(session),
			Error: "failed to delete file from store",
		})
		http.Error(w, `{"message": "Failed to delete secret file"}`, http.StatusInternalServerError)
		return
	}

	y.audit().Log(AuditEvent{
		Timestamp: time.Now().UTC(), Event: "file.deleted", Outcome: OutcomeSuccess,
		ClientIP: clientIP, SecretID: key,
		UserEmail: sessionEmail(session), UserSubject: sessionSub(session),
	})
	w.WriteHeader(http.StatusNoContent)
}

// getStreamSecretStatus returns status for a streaming secret.
func (y *Server) getStreamSecretStatus(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-cache")
	w.Header().Set("Content-Type", "application/json")

	key := mux.Vars(r)["key"]
	clientIP := y.getRealClientIP(r)
	session, _ := y.getSession(r)

	secret, err := y.DB.Status(streamKeyPrefix + key)
	if err != nil {
		y.Logger.Debug("Stream secret not found", zap.Error(err))
		y.audit().Log(AuditEvent{
			Timestamp: time.Now().UTC(), Event: "file.status_checked", Outcome: OutcomeFailure,
			ClientIP: clientIP, SecretID: key,
			UserEmail: sessionEmail(session), UserSubject: sessionSub(session),
			Error: "not found",
		})
		http.Error(w, `{"message": "Secret not found"}`, http.StatusNotFound)
		return
	}

	y.audit().Log(AuditEvent{
		Timestamp: time.Now().UTC(), Event: "file.status_checked", Outcome: OutcomeSuccess,
		ClientIP: clientIP, SecretID: key,
		OneTime: boolPtr(secret.OneTime), RequireAuth: boolPtr(secret.RequireAuth),
		UserEmail: sessionEmail(session), UserSubject: sessionSub(session),
	})
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

// streamOptions handles CORS preflight for streaming endpoints.
func (y *Server) streamOptions(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-Yopass-Expiration, X-Yopass-OneTime, X-Yopass-RequireAuth")
	w.Header().Set("Access-Control-Expose-Headers", "Content-Length")
}
