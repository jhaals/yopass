package server

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"time"
)

// Helpers shared by the token-protected, TTL-bounded records stored in the
// database: secret requests and read receipts.

// secondsUntil returns the number of seconds until the unix timestamp
// expiresAt, or 0 if it has already passed.
func secondsUntil(expiresAt int64) int32 {
	ttl := expiresAt - time.Now().Unix()
	if ttl <= 0 {
		return 0
	}
	return int32(ttl)
}

// tokenMatchesHash compares a presented token against a stored SHA-256 hex
// hash in constant time.
func tokenMatchesHash(token, hash string) bool {
	if token == "" || hash == "" {
		return false
	}
	h := sha256.Sum256([]byte(token))
	return subtle.ConstantTimeCompare([]byte(hex.EncodeToString(h[:])), []byte(hash)) == 1
}

// generateToken creates a new access token and its storage hash.
func generateToken() (token, hash string, err error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", "", err
	}
	token = base64.RawURLEncoding.EncodeToString(b)
	h := sha256.Sum256([]byte(token))
	return token, hex.EncodeToString(h[:]), nil
}
