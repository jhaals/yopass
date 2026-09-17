package server

import (
	"io"
	"strings"

	"github.com/ProtonMail/go-crypto/openpgp/armor"
	"github.com/jhaals/yopass/pkg/yopass"
)

// pgpMessageType is the only armor block type yopass accepts; go-crypto
// exports constants for key and signature blocks but not for messages.
const pgpMessageType = "PGP MESSAGE"

// The supported secret lifetimes live in pkg/yopass so the server and the
// CLI client share one table; these helpers adapt it to this package's needs.

// ValidExpiryString reports whether s is a supported human-readable expiry
// duration ("1h", "1d" or "1w").
func ValidExpiryString(s string) bool {
	_, ok := yopass.ExpirationSeconds(s)
	return ok
}

// validExpiration reports whether expiration matches one of the supported
// lifetimes in seconds.
func validExpiration(expiration int32) bool {
	return yopass.ValidExpirationSeconds(expiration)
}

// expirationInSeconds converts a human-readable expiry duration string
// [1h, 1d, 1w] to its equivalent in seconds, defaulting to one hour.
func expirationInSeconds(s string) int32 {
	if ttl, ok := yopass.ExpirationSeconds(s); ok {
		return ttl
	}
	oneHour, _ := yopass.ExpirationSeconds("1h")
	return oneHour
}

// isPGPEncrypted verifies that the provided content is a well formed armored
// PGP message.
//
// armor.Decode only parses the BEGIN header line; the base64 body and the END
// marker are validated lazily as Block.Body is read, so the body must be
// consumed to completion for the check to mean anything. The block type is
// checked explicitly, otherwise any "-----BEGIN <anything>-----" line passes.
//
// The END marker is checked separately because go-crypto's line reader
// reports a plain io.EOF for both "block ended" and "input ran out", so
// reading the body cannot on its own tell a complete message from a
// truncated one. It has to be a suffix check rather than a search: Decode
// skips everything before the BEGIN line and armor headers are free text, so
// an END marker planted above or inside the header block would otherwise
// vouch for a body that was never terminated. The CRC24 checksum is not
// verified at all: go-crypto stopped checking it once RFC 9580 made it
// optional.
//
// This is input hygiene, not a security boundary: armor says nothing about
// whether the payload is really encrypted, and only the client can guarantee
// that. It rejects truncated or mistyped ciphertext at submission time,
// before the sender shares a link to a secret nobody can decrypt.
func isPGPEncrypted(content string) bool {
	if content == "" {
		return false
	}

	block, err := armor.Decode(strings.NewReader(content))
	if err != nil || block.Type != pgpMessageType {
		return false
	}

	// An empty payload is well formed armor around nothing, which is still a
	// secret nobody can decrypt.
	if n, err := io.Copy(io.Discard, block.Body); err != nil || n == 0 {
		return false
	}

	return strings.HasSuffix(strings.TrimRight(content, " \t\r\n"), "-----END "+pgpMessageType+"-----")
}
