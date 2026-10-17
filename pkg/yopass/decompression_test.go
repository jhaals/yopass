package yopass

import (
	"bytes"
	"github.com/ProtonMail/go-crypto/openpgp/packet"
	"strings"
	"testing"
)

func TestDecryptDecompressionLimit(t *testing.T) {
	for _, test := range []struct {
		name       string
		size       int
		compressed bool
		reject     bool
	}{
		{"small compressed", 32 << 10, true, false},
		{"oversized compressed", 2 << 20, true, true},
		{"large uncompressed", 2 << 20, false, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			cfg := *pgpConfig
			if test.compressed {
				cfg.DefaultCompressionAlgo = packet.CompressionZLIB
			}
			plain := strings.Repeat("x", test.size)
			encrypted, err := encryptBinary(strings.NewReader(plain), "key", "file.txt", &cfg)
			if err != nil {
				t.Fatal(err)
			}
			if test.compressed && len(encrypted) > 16<<10 {
				t.Fatal("fixture did not compress")
			}
			got, filename, err := Decrypt(bytes.NewReader(encrypted), "key")
			if test.reject {
				if err == nil || got != "" {
					t.Fatal("oversized decompression released plaintext")
				}
			} else if err != nil || got != plain || filename != "file.txt" {
				t.Fatalf("round trip failed: %v", err)
			}
		})
	}
}
