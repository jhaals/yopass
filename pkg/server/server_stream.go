package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"regexp"
	"strconv"

	"github.com/gofrs/uuid"
	"github.com/gorilla/mux"
	"github.com/jhaals/yopass/pkg/yopass"
	"go.uber.org/zap"
)

var unsafeFilenameChars = regexp.MustCompile(`[\x00-\x1f\x7f/\\]`)

const streamKeyPrefix = "stream:"

// streamUpload handles streaming file uploads.
// The encrypted binary data is streamed directly to the FileStore
// while metadata is stored in the Database.
func (y *Server) streamUpload(w http.ResponseWriter, r *http.Request) {
	mediaType, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if mediaType != "application/octet-stream" {
		http.Error(w, `{"message": "Content-Type must be application/octet-stream"}`, http.StatusBadRequest)
		return
	}

	// Parse headers
	expirationStr := r.Header.Get("X-Yopass-Expiration")
	if expirationStr == "" {
		http.Error(w, `{"message": "X-Yopass-Expiration header required"}`, http.StatusBadRequest)
		return
	}
	expiration, err := strconv.ParseInt(expirationStr, 10, 32)
	if err != nil || !validExpiration(int32(expiration)) {
		http.Error(w, `{"message": "Invalid expiration specified"}`, http.StatusBadRequest)
		return
	}

	oneTimeStr := r.Header.Get("X-Yopass-OneTime")
	oneTime := oneTimeStr == "true"

	if !oneTime && y.ForceOneTimeSecrets {
		http.Error(w, `{"message": "Secret must be one time download"}`, http.StatusBadRequest)
		return
	}

	filename := sanitizeFilename(r.Header.Get("X-Yopass-Filename"))

	// Reject early if Content-Length exceeds limit
	if y.MaxFileSize > 0 && r.ContentLength > y.MaxFileSize {
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
		http.Error(w, `{"message": "Invalid data: not an OpenPGP message"}`, http.StatusBadRequest)
		return
	}
	if !isOpenPGPBinary(peek[0]) {
		http.Error(w, `{"message": "Invalid data: not an OpenPGP message"}`, http.StatusBadRequest)
		return
	}
	body = io.MultiReader(bytes.NewReader(peek[:]), body)

	// Generate UUID
	uuidVal, err := uuid.NewV4()
	if err != nil {
		y.Logger.Error("Unable to generate UUID", zap.Error(err))
		http.Error(w, `{"message": "Unable to generate UUID"}`, http.StatusInternalServerError)
		return
	}
	key := uuidVal.String()

	// Stream body to file store
	contentLength := r.ContentLength // may be -1 if unknown
	ctx := r.Context()
	if err := y.FileStore.Save(ctx, key, body, contentLength); err != nil {
		y.Logger.Error("Failed to save streaming file", zap.Error(err))
		var maxBytesErr *http.MaxBytesError
		if errors.As(err, &maxBytesErr) {
			http.Error(w, `{"message": "File too large"}`, http.StatusRequestEntityTooLarge)
		} else {
			http.Error(w, `{"message": "Failed to store file"}`, http.StatusInternalServerError)
		}
		return
	}

	// Write sidecar meta for cleanup (if supported by the store)
	type metaSaver interface {
		SaveMeta(ctx context.Context, key string, expiration int32) error
	}
	if ms, ok := y.FileStore.(metaSaver); ok {
		if err := ms.SaveMeta(ctx, key, int32(expiration)); err != nil {
			y.Logger.Error("Failed to save file metadata", zap.Error(err))
			if delErr := y.FileStore.Delete(ctx, key); delErr != nil {
				y.Logger.Error("Failed to delete file after metadata save error", zap.Error(delErr))
			}
			http.Error(w, `{"message": "Failed to store file metadata"}`, http.StatusInternalServerError)
			return
		}
	}

	// Store metadata in database
	meta := yopass.Secret{
		Expiration: int32(expiration),
		Message:    filename,
		OneTime:    oneTime,
	}
	if err := y.DB.Put(streamKeyPrefix+key, meta); err != nil {
		y.Logger.Error("Failed to store stream metadata", zap.Error(err))
		// Clean up the file since metadata storage failed
		y.FileStore.Delete(ctx, key)
		http.Error(w, `{"message": "Failed to store metadata"}`, http.StatusInternalServerError)
		return
	}

	resp := map[string]string{"message": key}
	jsonData, err := json.Marshal(resp)
	if err != nil {
		y.Logger.Error("Failed to marshal response", zap.Error(err))
	}
	if _, err = w.Write(jsonData); err != nil {
		y.Logger.Error("Failed to write response", zap.Error(err))
	}
}

// streamDownload serves the encrypted file as a binary stream.
func (y *Server) streamDownload(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-cache")

	key := mux.Vars(r)["key"]

	// Get metadata from database
	secret, err := y.DB.Get(streamKeyPrefix + key)
	if err != nil {
		y.Logger.Debug("Stream secret not found", zap.Error(err))
		http.Error(w, `{"message": "Secret not found"}`, http.StatusNotFound)
		return
	}

	filename := sanitizeFilename(secret.Message)
	isOneTime := secret.OneTime

	// Load file from store
	ctx := r.Context()
	reader, size, err := y.FileStore.Load(ctx, key)
	if err != nil {
		y.Logger.Error("Failed to load streaming file", zap.Error(err))
		http.Error(w, `{"message": "File not found"}`, http.StatusNotFound)
		return
	}
	defer reader.Close()

	// Set response headers
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("X-Yopass-Filename", filename)
	w.Header().Set("Access-Control-Expose-Headers", "X-Yopass-Filename, Content-Length")
	if size > 0 {
		w.Header().Set("Content-Length", fmt.Sprintf("%d", size))
	}

	// Stream the file
	if _, err := io.Copy(w, reader); err != nil {
		y.Logger.Error("Failed to stream file", zap.Error(err))
		return
	}

	// Delete file and metadata after successful streaming for one-time secrets
	if isOneTime {
		if err := y.FileStore.Delete(context.Background(), key); err != nil {
			y.Logger.Error("Failed to delete one-time streaming file", zap.Error(err))
		}
		if _, err := y.DB.Delete(streamKeyPrefix + key); err != nil {
			y.Logger.Error("Failed to delete one-time streaming metadata", zap.Error(err))
		}
	}
}

// deleteStreamSecret deletes both the metadata and the file.
func (y *Server) deleteStreamSecret(w http.ResponseWriter, r *http.Request) {
	key := mux.Vars(r)["key"]

	deleted, err := y.DB.Delete(streamKeyPrefix + key)
	if err != nil {
		http.Error(w, `{"message": "Failed to delete secret"}`, http.StatusInternalServerError)
		return
	}
	if !deleted {
		http.Error(w, `{"message": "Secret not found"}`, http.StatusNotFound)
		return
	}

	if err := y.FileStore.Delete(r.Context(), key); err != nil {
		y.Logger.Error("Failed to delete streaming file", zap.Error(err))
		http.Error(w, `{"message": "Failed to delete secret file"}`, http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// getStreamSecretStatus returns status for a streaming secret.
func (y *Server) getStreamSecretStatus(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-cache")
	w.Header().Set("Content-Type", "application/json")

	key := mux.Vars(r)["key"]
	oneTime, err := y.DB.Status(streamKeyPrefix + key)
	if err != nil {
		y.Logger.Debug("Stream secret not found", zap.Error(err))
		http.Error(w, `{"message": "Secret not found"}`, http.StatusNotFound)
		return
	}

	resp := map[string]bool{"oneTime": oneTime}
	if err := json.NewEncoder(w).Encode(resp); err != nil {
		y.Logger.Error("Failed to write status response", zap.Error(err))
	}
}

// sanitizeFilename removes control characters, path separators, and trims
// the result. Returns "download" if the result is empty.
func sanitizeFilename(name string) string {
	name = unsafeFilenameChars.ReplaceAllString(name, "")
	if name == "" {
		return "download"
	}
	return name
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
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-Yopass-Expiration, X-Yopass-OneTime, X-Yopass-Filename")
	w.Header().Set("Access-Control-Expose-Headers", "X-Yopass-Filename, Content-Length")
}
