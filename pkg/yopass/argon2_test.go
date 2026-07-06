package yopass

import (
	"bytes"
	"io"
	"strings"
	"testing"

	"github.com/ProtonMail/go-crypto/openpgp/armor"
	"github.com/ProtonMail/go-crypto/openpgp/s2k"
)

// messageS2KMode extracts the S2K mode from the leading symmetric-key
// encrypted session key (SKESK) packet of an armored PGP message.
func messageS2KMode(t *testing.T, msg string) s2k.Mode {
	t.Helper()

	block, err := armor.Decode(strings.NewReader(msg))
	if err != nil {
		t.Fatalf("could not decode armor: %v", err)
	}
	raw, err := io.ReadAll(block.Body)
	if err != nil {
		t.Fatalf("could not read message body: %v", err)
	}
	if len(raw) < 8 {
		t.Fatalf("message too short: %d bytes", len(raw))
	}

	// New-format packet header, tag 3 is the SKESK packet. The packet is
	// small enough that a single length octet follows the tag.
	if raw[0] != 0xc3 {
		t.Fatalf("expected message to start with a SKESK packet, got header byte %#x", raw[0])
	}
	body := raw[2:]

	// The S2K specifier position depends on the SKESK version (RFC 9580
	// section 5.3). Version 4: cipher octet, then S2K. Version 6: octet
	// count, cipher, AEAD mode and S2K length octets, then S2K.
	var s2kBytes []byte
	switch version := body[0]; version {
	case 4:
		s2kBytes = body[2:]
	case 6:
		s2kBytes = body[5 : 5+int(body[4])]
	default:
		t.Fatalf("unexpected SKESK version %d", version)
	}

	params, err := s2k.ParseIntoParams(bytes.NewReader(s2kBytes))
	if err != nil {
		t.Fatalf("could not parse S2K params: %v", err)
	}
	return params.Mode()
}

func TestEnableArgon2(t *testing.T) {
	EnableArgon2()
	t.Cleanup(func() { pgpConfig.S2KConfig = nil })

	const secret = "argon2 secret"
	msg, err := Encrypt(strings.NewReader(secret), "test-key")
	if err != nil {
		t.Fatalf("expected no encryption error, got %v", err)
	}
	if mode := messageS2KMode(t, msg); mode != s2k.Argon2S2K {
		t.Errorf("expected S2K mode %d (Argon2), got %d", s2k.Argon2S2K, mode)
	}

	// Decryption reads the S2K type from the message and needs no
	// configuration.
	content, _, err := Decrypt(strings.NewReader(msg), "test-key")
	if err != nil {
		t.Fatalf("expected no decryption error, got %v", err)
	}
	if content != secret {
		t.Errorf("expected decrypted content %q, got %q", secret, content)
	}
}

func TestDefaultS2KModeIsIterated(t *testing.T) {
	msg, err := Encrypt(strings.NewReader("default secret"), "test-key")
	if err != nil {
		t.Fatalf("expected no encryption error, got %v", err)
	}
	if mode := messageS2KMode(t, msg); mode != s2k.IteratedSaltedS2K {
		t.Errorf("expected S2K mode %d (iterated and salted), got %d", s2k.IteratedSaltedS2K, mode)
	}
}
