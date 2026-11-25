package yopass

import (
	"bytes"
	"compress/zlib"
	"errors"
	"math/big"
	"testing"

	"github.com/ProtonMail/go-crypto/openpgp/packet"
)

// rsaSecretKeyPacket returns an unencrypted RSA secret key packet that passes
// go-crypto's validation. 2^127-1 and 2^2203-1 are prime.
func rsaSecretKeyPacket() []byte {
	one := big.NewInt(1)
	p := new(big.Int).Sub(new(big.Int).Lsh(one, 127), one)
	q := new(big.Int).Sub(new(big.Int).Lsh(one, 2203), one)
	e := big.NewInt(65537)
	phi := new(big.Int).Mul(new(big.Int).Sub(p, one), new(big.Int).Sub(q, one))
	mpi := func(n *big.Int) []byte {
		return append([]byte{byte(n.BitLen() >> 8), byte(n.BitLen())}, n.Bytes()...)
	}
	secret := bytes.Join([][]byte{mpi(new(big.Int).ModInverse(e, phi)), mpi(p), mpi(q)}, nil)
	sum := 0
	for _, b := range secret {
		sum += int(b)
	}
	body := bytes.Join([][]byte{{4, 0, 0, 0, 0, 1}, mpi(new(big.Int).Mul(p, q)), mpi(e), {0}, secret, {byte(sum >> 8), byte(sum)}}, nil)
	return append([]byte{0xc5, 0xff, 0, 0, byte(len(body) >> 8), byte(len(body))}, body...)
}

// go-crypto validates the key while parsing a secret key packet, at a cost
// that grows with the cube of the key size. Decrypt must refuse such a packet
// without parsing it, and still read the packets a message may consist of.
func TestDecryptPacketTypes(t *testing.T) {
	key := rsaSecretKeyPacket()
	if _, err := packet.Read(bytes.NewReader(key)); err != nil {
		t.Fatalf("fixture is not a valid secret key packet: %v", err)
	}
	literal := []byte{0xcb, 10, 'u', 0, 0, 0, 0, 0, 't', 'e', 'x', 't'}
	onePassSignature := []byte{0xc4, 13, 3, 0, 8, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1}
	padding := []byte{0xd5, 4, 0, 0, 0, 0}
	unknown := []byte{0xfc, 1, 0}
	compress := func(packets []byte) []byte {
		var z bytes.Buffer
		w := zlib.NewWriter(&z)
		_, _ = w.Write(packets)
		_ = w.Close()
		return append([]byte{0xc8, 0xff, 0, 0, byte((z.Len() + 1) >> 8), byte(z.Len() + 1), 2}, z.Bytes()...)
	}
	nested := func(depth int) []byte {
		packets := literal
		for range depth {
			packets = compress(packets)
		}
		return packets
	}
	// Padding sent as a partial chunk of 1024 bytes and a final chunk of none.
	// go-crypto skips no bytes of such a packet and reads the chunk as packets.
	hidden := append([]byte{0xd5, 0xea}, key...)
	hidden = append(hidden, make([]byte, 1024-len(key)+1)...)

	for name, prefix := range map[string][]byte{
		"secret key before the ciphertext":            key,
		"secret key in padding before the ciphertext": hidden,
	} {
		t.Run(name, func(t *testing.T) {
			message := append(bytes.Clone(prefix), 0xd2, 1, 1)
			if _, err := boundedS2KReader(bytes.NewReader(message)); !errors.Is(err, ErrInvalidMessage) {
				t.Fatalf("accepted: %v", err)
			}
		})
	}

	for _, test := range []struct {
		name    string
		prefix  []byte
		packets []byte
		reject  bool
	}{
		{"literal only", nil, literal, false},
		{"compressed literal", nil, compress(literal), false},
		{"ignored packets", padding, bytes.Join([][]byte{padding, onePassSignature, unknown, literal}, nil), false},
		{"deepest compression", nil, nested(maxCompressionNesting), false},
		{"too deep compression", nil, nested(maxCompressionNesting + 1), true},
		{"secret key before the literal", nil, append(bytes.Clone(key), literal...), true},
		{"secret key in a compressed packet", nil, compress(append(bytes.Clone(key), literal...)), true},
	} {
		t.Run(test.name, func(t *testing.T) {
			var message bytes.Buffer
			sessionKey, err := packet.SerializeSymmetricKeyEncrypted(&message, []byte("key"), nil)
			if err != nil {
				t.Fatal(err)
			}
			message.Write(test.prefix)
			w, err := packet.SerializeSymmetricallyEncrypted(&message, packet.CipherAES128, false, packet.CipherSuite{}, sessionKey, nil)
			if err != nil {
				t.Fatal(err)
			}
			_, _ = w.Write(test.packets)
			if err := w.Close(); err != nil {
				t.Fatal(err)
			}
			got, _, err := Decrypt(&message, "key")
			if test.reject && !errors.Is(err, ErrInvalidMessage) {
				t.Fatalf("accepted, got %q, %v", got, err)
			}
			if !test.reject && (err != nil || got != "text") {
				t.Fatalf("got %q, %v", got, err)
			}
		})
	}
}

// Decrypt no longer uses openpgp.ReadMessage, so it must still refuse
// unauthenticated and tampered ciphertext, also when packets follow the literal.
func TestDecryptIntegrity(t *testing.T) {
	literal := []byte{0xcb, 10, 'u', 0, 0, 0, 0, 0, 't', 'e', 'x', 't'}
	packets := append(literal, rsaSecretKeyPacket()...)
	for _, aead := range []bool{false, true} {
		var message bytes.Buffer
		sessionKey, err := packet.SerializeSymmetricKeyEncrypted(&message, []byte("key"), nil)
		if err != nil {
			t.Fatal(err)
		}
		suite := packet.CipherSuite{Cipher: packet.CipherAES128, Mode: packet.AEADModeGCM}
		w, err := packet.SerializeSymmetricallyEncrypted(&message, packet.CipherAES128, aead, suite, sessionKey, pgpConfig)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = w.Write(packets)
		if err := w.Close(); err != nil {
			t.Fatal(err)
		}
		if got, _, err := Decrypt(bytes.NewReader(message.Bytes()), "key"); err != nil || got != "text" {
			t.Fatalf("aead %v: got %q, %v", aead, got, err)
		}
		tampered := bytes.Clone(message.Bytes())
		tampered[len(tampered)-1] ^= 1
		if _, _, err := Decrypt(bytes.NewReader(tampered), "key"); err == nil {
			t.Fatalf("aead %v: tampered ciphertext accepted", aead)
		}
	}

	var message bytes.Buffer
	if _, err := packet.SerializeSymmetricKeyEncrypted(&message, []byte("key"), nil); err != nil {
		t.Fatal(err)
	}
	message.Write(append([]byte{0xc9, 32}, make([]byte, 32)...))
	if _, _, err := Decrypt(&message, "key"); !errors.Is(err, ErrInvalidMessage) {
		t.Fatalf("unauthenticated ciphertext: %v", err)
	}
}
