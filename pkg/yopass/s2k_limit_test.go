package yopass

import (
	"bytes"
	"errors"
	"io"
	"strings"
	"testing"
)

func TestArgon2CostLimit(t *testing.T) {
	for _, version := range []byte{4, 5, 6} {
		for _, exponent := range []byte{16, maxArgon2MemoryExp, maxArgon2MemoryExp + 1, 31} {
			body := []byte{version, 9}
			if version == 5 {
				body = []byte{5, 9, 3}
			}
			if version == 6 {
				body = []byte{6, 35, 9, 3, 20}
			}
			body = append(body, 4)
			body = append(body, make([]byte, 16)...)
			body = append(body, 1, 1, exponent)
			if version >= 5 {
				body = append(body, make([]byte, 60)...)
			}
			raw := append([]byte{0xc3, byte(len(body))}, body...)
			raw = append(raw, 0xd2, 1, 1)
			_, err := boundedS2KReader(bytes.NewReader(raw))
			if version != 5 && exponent <= maxArgon2MemoryExp && err != nil {
				t.Fatalf("version=%d exponent=%d: %v", version, exponent, err)
			}
			if exponent > maxArgon2MemoryExp {
				if !errors.Is(err, ErrInvalidMessage) {
					t.Fatalf("accepted costly version=%d exponent=%d", version, exponent)
				}
				if _, _, err := Decrypt(bytes.NewReader(raw), "key"); !errors.Is(err, ErrInvalidMessage) {
					t.Fatal("decryption did not reject costly header")
				}
			}
		}
	}
}
func TestS2KPrefixLeavesCiphertextStreaming(t *testing.T) {
	input := append([]byte{0xd2, 255, 0, 16, 0, 0, 1}, bytes.Repeat([]byte{'x'}, 1<<20)...)
	reader := bytes.NewReader(input)
	checked, err := boundedS2KReader(reader)
	if err != nil {
		t.Fatal(err)
	}
	if reader.Len() < len(input)-4096 {
		t.Fatal("ciphertext was eagerly buffered")
	}
	got, err := io.ReadAll(checked)
	if err != nil || !bytes.Equal(got, input) {
		t.Fatal("ciphertext changed")
	}
	// A huge unknown/key prefix is rejected without buffering the full packet.
	oversized := append([]byte{0xc3, 255, 0, 16, 0, 0}, []byte(strings.Repeat("x", 128<<10))...)
	if _, err := boundedS2KReader(bytes.NewReader(oversized)); err == nil {
		t.Fatal("unbounded key prefix accepted")
	}
}

func TestS2KRejectsParserBoundaryMismatches(t *testing.T) {
	costly := []byte{0xc3, 22, 4, 9, 4}
	costly = append(costly, make([]byte, 16)...)
	costly = append(costly, 1, 1, 31)
	marker := append([]byte{0xca, byte(3 + len(costly))}, []byte("PGP")...)
	marker = append(marker, costly...)
	for _, prefix := range [][]byte{
		{0xc4, 4, 0, 0, 0, 0},
		marker,
		{0xd2, 1, 99},
	} {
		data := append(append([]byte{}, prefix...), costly...)
		data = append(data, 0xd2, 1, 1)
		if _, err := boundedS2KReader(bytes.NewReader(data)); !errors.Is(err, ErrInvalidMessage) {
			t.Fatalf("unsafe prefix accepted: %x", prefix)
		}
		if _, _, err := Decrypt(bytes.NewReader(data), "key"); !errors.Is(err, ErrInvalidMessage) {
			t.Fatal("unsafe prefix reached decryption")
		}
	}
}

func TestS2KMalformedEncryptedHeaderDoesNotDrainCiphertext(t *testing.T) {
	data := append([]byte{0xd2, 255, 0, 16, 0, 0, 99}, bytes.Repeat([]byte{'x'}, 128<<10)...)
	input := bytes.NewReader(data)
	if _, err := boundedS2KReader(input); !errors.Is(err, ErrInvalidMessage) {
		t.Fatal("malformed encrypted header accepted")
	}
	if input.Len() < len(data)-(68<<10) {
		t.Fatal("malformed header drained ciphertext beyond prefix budget")
	}
}
