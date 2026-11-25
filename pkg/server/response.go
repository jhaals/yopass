package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"go.uber.org/zap"
)

// jsonError writes a {"message": ...} error body with the given status code
// and a correct application/json content type.
func jsonError(w http.ResponseWriter, code int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	if err := json.NewEncoder(w).Encode(map[string]string{"message": message}); err != nil {
		zap.L().Error("Failed to write error response", zap.Error(err))
	}
}

// jsonBodyLimit returns the request body cap for a JSON endpoint carrying an
// armored message of up to n bytes. Armor wraps at 64 characters and JSON
// escapes every newline as two bytes, so the envelope grows with the message
// rather than by a constant; the fixed slack covers the surrounding fields.
func jsonBodyLimit(n int64) int64 {
	return n + n/64 + 4096
}

// maxJSONBodyDepth bounds how deeply arrays and objects may nest in a JSON
// request body. Every body the API defines is a flat object.
const maxJSONBodyDepth = 32

var errJSONBodyTooDeep = errors.New("json body nested too deeply")

// decodeJSONBody reads a request body of at most limit bytes and decodes it
// into v; an oversized body is reported as *http.MaxBytesError. encoding/json
// recurses per nesting level (up to 10000) and, decoding from the connection,
// keeps that stack while the client withholds the rest. So the body is read
// in full first and nesting no request needs is refused unparsed.
func decodeJSONBody(w http.ResponseWriter, r *http.Request, limit int64, v any) error {
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, limit))
	if err != nil {
		return err
	}
	if jsonNestedDeeperThan(data, maxJSONBodyDepth) {
		return errJSONBodyTooDeep
	}
	// A Decoder, unlike Unmarshal, keeps ignoring data after the value.
	return json.NewDecoder(bytes.NewReader(data)).Decode(v)
}

// jsonNestedDeeperThan reports whether data opens more than limit arrays and
// objects inside one another. It only tells brackets from string contents;
// everything else is left to the parser.
func jsonNestedDeeperThan(data []byte, limit int) bool {
	depth, inString := 0, false
	for i := 0; i < len(data); i++ {
		switch c := data[i]; {
		case inString && c == '\\':
			i++ // skip the escaped character, which may be a quote
		case c == '"':
			inString = !inString
		case inString:
		case c == '{' || c == '[':
			if depth++; depth > limit {
				return true
			}
		case c == '}' || c == ']':
			depth--
		}
	}
	return false
}

// tooLarge answers a request whose body exceeded its cap. It first discards
// part of the unread remainder: Go closes the connection when a handler
// returns while the client is still uploading, which the client sees as a
// reset instead of this response. Discarding is O(1) memory, and the bound
// stops an endless upload from being read forever. The 1MB bound is fixed;
// revisit it if legitimate bodies get near it.
func tooLarge(w http.ResponseWriter, body io.Reader) {
	_, _ = io.CopyN(io.Discard, body, 1<<20)
	jsonError(w, http.StatusRequestEntityTooLarge, "Request body too large")
}

// writeJSON writes v as a JSON response body with the given status code and
// a correct application/json content type, logging encode failures.
func (y *Server) writeJSON(w http.ResponseWriter, code int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		y.Logger.Error("Failed to write response", zap.Error(err))
	}
}
