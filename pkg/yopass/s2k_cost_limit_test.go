package yopass

import (
	"bytes"
	"errors"
	"testing"
)

// skeskPrefix renders n v4 SKESK packets (tag 3) carrying an Argon2 S2K
// specifier with the given cost, followed by an encrypted-data packet marker
// that ends the prefix scan.
func skeskPrefix(n int, passes, parallelism, exponent byte) []byte {
	var raw []byte
	for i := 0; i < n; i++ {
		body := []byte{4, 9, 4} // v4, AES256, Argon2 S2K
		body = append(body, make([]byte, 16)...)
		body = append(body, passes, parallelism, exponent)
		body = append(body, make([]byte, 33)...) // wrapped session key, opaque
		raw = append(raw, 0xc3, byte(len(body)))
		raw = append(raw, body...)
	}
	return append(raw, 0xd2, 1, 1)
}

func TestArgon2PassesAndParallelismLimit(t *testing.T) {
	for _, tc := range []struct {
		name                     string
		passes, parallelism, exp byte
		reject                   bool
	}{
		{name: "stock", passes: 3, parallelism: 4, exp: 16},
		{name: "at_limit", passes: maxArgon2Passes, parallelism: maxArgon2Parallelism, exp: maxArgon2MemoryExp},
		{name: "passes_over", passes: maxArgon2Passes + 1, parallelism: 4, exp: 16, reject: true},
		{name: "passes_max_field", passes: 255, parallelism: 4, exp: 16, reject: true},
		{name: "parallelism_over", passes: 3, parallelism: maxArgon2Parallelism + 1, exp: 16, reject: true},
		{name: "memory_over", passes: 3, parallelism: 4, exp: maxArgon2MemoryExp + 1, reject: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			raw := skeskPrefix(1, tc.passes, tc.parallelism, tc.exp)
			_, err := boundedS2KReader(bytes.NewReader(raw))
			if !tc.reject {
				if err != nil {
					t.Fatalf("cost accepted by the Rust client was refused: %v", err)
				}
				return
			}
			if !errors.Is(err, ErrInvalidMessage) {
				t.Fatalf("accepted costly SKESK: %v", err)
			}
			if _, _, err := Decrypt(bytes.NewReader(raw), "key"); !errors.Is(err, ErrInvalidMessage) {
				t.Fatal("costly header reached decryption")
			}
		})
	}
}

func TestSKESKPacketCountLimit(t *testing.T) {
	if _, err := boundedS2KReader(bytes.NewReader(skeskPrefix(maxSKESKPackets, 3, 4, 16))); err != nil {
		t.Fatalf("%d SKESK packets were refused: %v", maxSKESKPackets, err)
	}
	over := skeskPrefix(maxSKESKPackets+1, 3, 4, 16)
	if _, err := boundedS2KReader(bytes.NewReader(over)); !errors.Is(err, ErrInvalidMessage) {
		t.Fatalf("%d SKESK packets were accepted: %v", maxSKESKPackets+1, err)
	}
	if _, _, err := Decrypt(bytes.NewReader(over), "key"); !errors.Is(err, ErrInvalidMessage) {
		t.Fatal("multi-packet header reached decryption")
	}
}
