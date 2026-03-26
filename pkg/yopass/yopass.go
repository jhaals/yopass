package yopass

import (
	"bytes"
	"crypto"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/url"
	"os"
	"strings"

	"github.com/ProtonMail/go-crypto/openpgp"
	"github.com/ProtonMail/go-crypto/openpgp/armor"
	"github.com/ProtonMail/go-crypto/openpgp/packet"
)

// ErrEmptyKey is returned when no encryption key is provided.
var ErrEmptyKey = errors.New("empty encryption key")

// ErrInvalidKey is returned when a given decryption key is invalid.
var ErrInvalidKey = errors.New("invalid decryption key")

// ErrInvalidMessage is returned when a given message is invalid.
var ErrInvalidMessage = errors.New("invalid message")

var pgpConfig = &packet.Config{
	DefaultHash:            crypto.SHA256,
	DefaultCipher:          packet.CipherAES256,
	DefaultCompressionAlgo: packet.CompressionNone,
	AEADConfig:             &packet.AEADConfig{DefaultMode: packet.AEADModeGCM},
}

var pgpHeader = map[string]string{
	"Comment": "https://yopass.se",
}

// Secret holds the encrypted message
type Secret struct {
	Expiration int32  `json:"expiration,omitempty"`
	Message    string `json:"message"`
	OneTime    bool   `json:"one_time,omitempty"`
}

// ToJSON converts a Secret to json
func (s *Secret) ToJSON() ([]byte, error) {
	return json.Marshal(&s)
}

// Decrypt reads the provided ciphertext and returns the plaintext decrypted
// with the given key. It auto-detects armored vs binary PGP format.
func Decrypt(r io.Reader, key string) (content, filename string, err error) {
	tried := false
	prompt := func([]openpgp.Key, bool) ([]byte, error) {
		if tried {
			return nil, ErrInvalidKey
		}
		tried = true
		return []byte(key), nil
	}

	// Buffer enough to detect the format
	buf := make([]byte, len(armorHeader))
	n, readErr := io.ReadFull(r, buf)
	// Reconstruct a reader with the peeked bytes
	combined := io.MultiReader(bytes.NewReader(buf[:n]), r)

	var msgReader io.Reader
	if readErr == nil && string(buf) == armorHeader {
		// Armored PGP
		a, err := armor.Decode(combined)
		if err != nil {
			return "", "", ErrInvalidMessage
		}
		msgReader = a.Body
	} else {
		// Binary PGP
		msgReader = combined
	}

	m, err := openpgp.ReadMessage(msgReader, nil, prompt, pgpConfig)
	if err != nil {
		if errors.Is(err, ErrInvalidKey) {
			return "", "", fmt.Errorf("could not decrypt: %w", err)
		}
		return "", "", ErrInvalidMessage
	}
	p, err := io.ReadAll(m.UnverifiedBody)
	if err != nil {
		return "", "", fmt.Errorf("could not read plaintext: %w", err)
	}
	if m.LiteralData.IsBinary {
		filename = m.LiteralData.FileName
	}
	return string(p), filename, nil
}

const armorHeader = "-----BEGIN PGP MESSAGE-----"

// EncryptBinary encrypts the data from r as binary PGP (no ASCII armor).
// This format is used for streaming file uploads.
func EncryptBinary(r io.Reader, key string, filename string) ([]byte, error) {
	if key == "" {
		return nil, ErrEmptyKey
	}

	hints := &openpgp.FileHints{
		IsBinary: true,
		FileName: filename,
	}

	buf := new(bytes.Buffer)
	w, err := openpgp.SymmetricallyEncrypt(buf, []byte(key), hints, pgpConfig)
	if err != nil {
		return nil, fmt.Errorf("could not encrypt: %w", err)
	}
	if _, err := io.Copy(w, r); err != nil {
		return nil, fmt.Errorf("could not copy data: %w", err)
	}
	if err := w.Close(); err != nil {
		return nil, fmt.Errorf("could not close writer: %w", err)
	}

	return buf.Bytes(), nil
}

// Encrypt reads the provided plaintext and returns a ciphertext encrypted with
// the given key. No assumptions about the ciphertext format should be made, the
// encryption method might change in future versions.
func Encrypt(r io.Reader, key string) (string, error) {
	if key == "" {
		return "", ErrEmptyKey
	}

	var hints *openpgp.FileHints
	if f, ok := r.(*os.File); ok && r != os.Stdin {
		stat, err := f.Stat()
		if err != nil {
			return "", fmt.Errorf("could not get file info: %w", err)
		}
		hints = &openpgp.FileHints{
			IsBinary: true,
			FileName: stat.Name(),
			ModTime:  stat.ModTime(),
		}
	}

	buf := new(bytes.Buffer)
	a, err := armor.Encode(buf, "PGP MESSAGE", pgpHeader)
	if err != nil {
		return "", fmt.Errorf("could not create armor encoder: %w", err)
	}
	w, err := openpgp.SymmetricallyEncrypt(a, []byte(key), hints, pgpConfig)
	if err != nil {
		return "", fmt.Errorf("could not encrypt: %w", err)
	}
	if _, err := io.Copy(w, r); err != nil {
		return "", fmt.Errorf("could not copy data: %w", err)
	}
	if err := w.Close(); err != nil {
		return "", fmt.Errorf("could not close writer: %w", err)
	}
	if err := a.Close(); err != nil {
		return "", fmt.Errorf("could not close armor: %w", err)
	}

	return buf.String(), nil
}

// GenerateID creates a new secret identifier from 16 cryptographically secure
// random bytes encoded as a 22-character base62 string (~128 bits of entropy).
func GenerateID() (string, error) {
	const charset = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	n := new(big.Int).SetBytes(b)
	result := make([]byte, 22)
	base := big.NewInt(62)
	mod := new(big.Int)
	for i := 21; i >= 0; i-- {
		n.DivMod(n, base, mod)
		result[i] = charset[mod.Int64()]
	}
	return string(result), nil
}

// GenerateKey creates a new encryption key from a cryptographically secure
// random number generator. The format matches the Javascript implementation.
func GenerateKey() (string, error) {
	const length = 22

	b := make([]byte, length)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.URLEncoding.EncodeToString(b)[:length], nil
}

// SecretURL returns a URL which decryts the specified secret in the browser.
func SecretURL(url, id, key string, fileOpt, manualKeyOpt bool) string {
	prefix := "s"
	if fileOpt {
		prefix = "f"
	}
	path := id
	if !manualKeyOpt {
		path += "/" + key
	}
	return fmt.Sprintf("%s/#/%s/%s", strings.TrimSuffix(url, "/"), prefix, path)
}

// ParseURL returns secret ID and key from a regular yopass URL.
func ParseURL(s string) (id, key string, fileOpt, keyOpt bool, err error) {
	u, err := url.Parse(strings.TrimSpace(s))
	if err != nil {
		return "", "", false, false, fmt.Errorf("invalid URL: %w", err)
	}

	f := strings.Split(u.Fragment, "/")
	if len(f) < 3 || len(f) > 4 || f[0] != "" {
		return "", "", false, false, fmt.Errorf("unexpected URL: %q", s)
	}

	switch f[1] {
	case "s":
	case "c":
		keyOpt = true
	case "f":
		fileOpt = true
	case "d":
		fileOpt = true
		keyOpt = true
	default:
		return "", "", false, false, fmt.Errorf("unexpected URL: %q", s)
	}

	id = f[2]
	if len(f) == 4 {
		key = f[3]
	}
	return id, key, fileOpt, keyOpt, nil
}
