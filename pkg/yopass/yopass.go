package yopass

import (
	"bufio"
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
	pgperrors "github.com/ProtonMail/go-crypto/openpgp/errors"
	"github.com/ProtonMail/go-crypto/openpgp/packet"
	"github.com/ProtonMail/go-crypto/openpgp/s2k"
)

// ErrEmptyKey is returned when no encryption key is provided.
var ErrEmptyKey = errors.New("empty encryption key")

// ErrInvalidKey is returned when a given decryption key is invalid.
var ErrInvalidKey = errors.New("invalid decryption key")

// ErrInvalidMessage is returned when a given message is invalid.
var ErrInvalidMessage = errors.New("invalid message")

var maxDecompressedMessageSize int64 = 1 << 20

var pgpConfig = &packet.Config{
	DefaultHash:                crypto.SHA256,
	DefaultCipher:              packet.CipherAES256,
	DefaultCompressionAlgo:     packet.CompressionNone,
	MaxDecompressedMessageSize: &maxDecompressedMessageSize,
	AEADConfig:                 &packet.AEADConfig{DefaultMode: packet.AEADModeGCM},
}

var pgpHeader = map[string]string{
	"Comment": "https://yopass.se",
}

// pgpConfigArgon2 mirrors pgpConfig with S2K key derivation switched from
// the default iterated SHA-256 to memory-hard Argon2id. It is a separate
// config so the Argon2 choice is made per encryption call and never leaks
// into unrelated encryption in the same process.
var pgpConfigArgon2 = func() *packet.Config {
	cfg := *pgpConfig
	cfg.S2KConfig = &s2k.Config{S2KMode: s2k.Argon2S2K}
	return &cfg
}()

// Default clients use 64 MiB and 3 passes. Cap the sender-controlled Argon2
// cost and SKESK count at the limits the Rust CLI enforces (see docs/cli.md).
const (
	maxArgon2MemoryExp   = 17
	maxArgon2Passes      = 16
	maxArgon2Parallelism = 16
	maxSKESKPackets      = 8
)

// boundedS2KReader checks only the packet prefix, without buffering file ciphertext.
func boundedS2KReader(r io.Reader) (io.Reader, error) {
	source := bufio.NewReader(r)
	var prefix bytes.Buffer
	packets := packet.NewOpaqueReader(io.LimitReader(io.TeeReader(source, &prefix), 64<<10))
	skeskPackets := 0
	for {
		tag, err := peekTag(source)
		if err != nil {
			return nil, ErrInvalidMessage
		}
		switch tag {
		case 9, 18, 20:
			if _, err := packet.Read(io.LimitReader(io.TeeReader(source, &prefix), int64(64<<10-prefix.Len()))); err != nil || prefix.Len() > 64<<10 {
				return nil, ErrInvalidMessage
			}
			return io.MultiReader(bytes.NewReader(prefix.Bytes()), source), nil
		case 1, 3, 10, 21:
			// Session keys, marker and padding.
		default:
			// Nothing else belongs here, and parsing a secret key packet
			// validates the key, at a cost the sender chooses.
			return nil, ErrInvalidMessage
		}
		start := prefix.Len()
		p, err := packets.Next()
		if err != nil {
			return nil, ErrInvalidMessage
		}
		// Semantic parsing must consume the same bytes as opaque framing. Check
		// the packet as received, not re-serialized: go-crypto skips nothing of
		// a Padding packet sent with partial lengths.
		semantic := bytes.NewReader(prefix.Bytes()[start:])
		if _, err := packet.Read(semantic); err != nil || semantic.Len() != 0 {
			return nil, ErrInvalidMessage
		}
		if p.Tag != 3 || len(p.Contents) == 0 {
			continue
		}
		if skeskPackets++; skeskPackets > maxSKESKPackets {
			return nil, ErrInvalidMessage
		}
		var offset int
		switch p.Contents[0] {
		case 4:
			offset = 2
		case 5:
			offset = 3
		case 6:
			offset = 5
		default:
			continue
		}
		const (
			passesOffset      = 1 + s2k.Argon2SaltSize
			parallelismOffset = passesOffset + 1
			memoryOffset      = passesOffset + 2
		)
		if len(p.Contents) > offset+memoryOffset && p.Contents[offset] == byte(s2k.Argon2S2K) &&
			(p.Contents[offset+memoryOffset] > maxArgon2MemoryExp ||
				p.Contents[offset+passesOffset] > maxArgon2Passes ||
				p.Contents[offset+parallelismOffset] > maxArgon2Parallelism) {
			return nil, ErrInvalidMessage
		}
	}
}

// peekTag returns the type of the packet that r is positioned at.
func peekTag(r *bufio.Reader) (byte, error) {
	first, err := r.Peek(1)
	if err != nil {
		return 0, err
	}
	if first[0]&0x40 == 0 {
		return (first[0] >> 2) & 0x0f, nil
	}
	return first[0] & 0x3f, nil
}

// decryptSession tries key on the session key packets of a message that has
// passed boundedS2KReader and returns the packets inside the ciphertext. The
// caller must read them to the end and then check the result of Close.
func decryptSession(r io.Reader, key string) (io.ReadCloser, error) {
	packets := packet.NewReader(r)
	var sessionKeys []*packet.SymmetricKeyEncrypted
	for {
		p, err := packets.Next()
		if err != nil {
			return nil, ErrInvalidMessage
		}
		switch p := p.(type) {
		case *packet.SymmetricKeyEncrypted:
			sessionKeys = append(sessionKeys, p)
		case packet.EncryptedDataPacket:
			if data, ok := p.(*packet.SymmetricallyEncrypted); ok && !data.IntegrityProtected {
				return nil, ErrInvalidMessage
			}
			if len(sessionKeys) == 0 {
				return nil, ErrInvalidMessage
			}
			for _, s := range sessionKeys {
				sessionKey, cipher, err := s.Decrypt([]byte(key))
				if err != nil {
					continue
				}
				decrypted, err := p.Decrypt(cipher, sessionKey)
				if err != nil {
					return nil, ErrInvalidMessage
				}
				return decrypted, nil
			}
			return nil, fmt.Errorf("could not decrypt: %w", ErrInvalidKey)
		}
	}
}

// maxCompressionNesting is the number of compressed packets a literal packet
// may be wrapped in, as in the Rust CLI.
const maxCompressionNesting = 32

// findLiteral returns the literal packet of a decrypted message, which may be
// inside compressed packets. openpgp.ReadMessage would parse every packet it
// comes across on the way, secret keys included. Here only compressed and
// literal packets are parsed; signatures are stepped over, as they were never
// verified.
func findLiteral(r io.Reader) (*packet.LiteralData, error) {
	source := bufio.NewReader(r)
	nesting := 0
	for {
		tag, err := peekTag(source)
		if err != nil {
			return nil, ErrInvalidMessage
		}
		switch {
		case tag == 8 || tag == 11:
			p, err := packet.Read(source)
			if err != nil {
				return nil, ErrInvalidMessage
			}
			switch p := p.(type) {
			case *packet.LiteralData:
				return p, nil
			case *packet.Compressed:
				if nesting++; nesting > maxCompressionNesting {
					return nil, ErrInvalidMessage
				}
				source = bufio.NewReader(p.LimitedBodyReader(pgpConfig.DecompressedMessageSizeLimit()))
			}
		case tag == 2 || tag == 4 || tag == 10 || tag == 21 || tag >= 40:
			// Signatures, marker, padding and unknown packets that are to be ignored.
			if _, err := packet.NewOpaqueReader(source).Next(); err != nil {
				return nil, ErrInvalidMessage
			}
		default:
			return nil, ErrInvalidMessage
		}
	}
}

// expirations is the single source of truth for the supported secret
// lifetimes, mapping the human-readable form to seconds. pkg/server and the
// CLI both derive their validation from it.
var expirations = map[string]int32{
	"1h": 3600,
	"1d": 86400,
	"1w": 604800,
}

// ExpirationSeconds converts a human-readable expiry duration ("1h", "1d" or
// "1w") to its equivalent in seconds. ok is false for unsupported values.
func ExpirationSeconds(s string) (seconds int32, ok bool) {
	seconds, ok = expirations[s]
	return seconds, ok
}

// ValidExpirationSeconds reports whether seconds matches one of the
// supported secret lifetimes.
func ValidExpirationSeconds(seconds int32) bool {
	for _, ttl := range expirations {
		if ttl == seconds {
			return true
		}
	}
	return false
}

// Secret holds the encrypted message
type Secret struct {
	Expiration  int32  `json:"expiration,omitempty"`
	Message     string `json:"message"`
	OneTime     bool   `json:"one_time,omitempty"`
	RequireAuth bool   `json:"require_auth,omitempty"`
}

// ToJSON converts a Secret to json
func (s *Secret) ToJSON() ([]byte, error) {
	return json.Marshal(s)
}

// Decrypt reads the provided ciphertext and returns the plaintext decrypted
// with the given key. It auto-detects armored vs binary PGP format.
func Decrypt(r io.Reader, key string) (content, filename string, err error) {
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

	checked, err := boundedS2KReader(msgReader)
	if err != nil {
		return "", "", err
	}
	decrypted, err := decryptSession(checked, key)
	if err != nil {
		return "", "", err
	}
	literal, err := findLiteral(decrypted)
	if err != nil {
		return "", "", err
	}
	p, err := io.ReadAll(literal.Body)
	if err == nil {
		// The integrity check covers the ciphertext up to its end.
		_, err = io.Copy(io.Discard, decrypted)
	}
	if err != nil {
		return "", "", fmt.Errorf("could not read plaintext: %w", pgperrors.HandleSensitiveParsingError(err, true))
	}
	if err := decrypted.Close(); err != nil {
		return "", "", fmt.Errorf("could not read plaintext: %w", err)
	}
	if literal.IsBinary {
		filename = literal.FileName
	}
	return string(p), filename, nil
}

const armorHeader = "-----BEGIN PGP MESSAGE-----"

// EncryptBinary encrypts the data from r as binary PGP (no ASCII armor).
// This format is used for streaming file uploads.
func EncryptBinary(r io.Reader, key string, filename string) ([]byte, error) {
	return encryptBinary(r, key, filename, pgpConfig)
}

// EncryptBinaryWithArgon2 is EncryptBinary with memory-hard Argon2id key
// derivation instead of the default iterated SHA-256. Only use it against
// servers that advertise Argon2 support (see FetchServerConfig). Decryption
// needs no counterpart as the S2K type is stored in the PGP message itself.
func EncryptBinaryWithArgon2(r io.Reader, key string, filename string) ([]byte, error) {
	return encryptBinary(r, key, filename, pgpConfigArgon2)
}

func encryptBinary(r io.Reader, key string, filename string, config *packet.Config) ([]byte, error) {
	if key == "" {
		return nil, ErrEmptyKey
	}

	hints := &openpgp.FileHints{
		IsBinary: true,
		FileName: filename,
	}

	buf := new(bytes.Buffer)
	w, err := openpgp.SymmetricallyEncrypt(buf, []byte(key), hints, config)
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
	return encrypt(r, key, pgpConfig)
}

// EncryptWithArgon2 is Encrypt with memory-hard Argon2id key derivation
// instead of the default iterated SHA-256. Only use it against servers that
// advertise Argon2 support (see FetchServerConfig). Decryption needs no
// counterpart as the S2K type is stored in the PGP message itself.
func EncryptWithArgon2(r io.Reader, key string) (string, error) {
	return encrypt(r, key, pgpConfigArgon2)
}

func encrypt(r io.Reader, key string, config *packet.Config) (string, error) {
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
	w, err := openpgp.SymmetricallyEncrypt(a, []byte(key), hints, config)
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
