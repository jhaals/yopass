package yopass_test

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"
	"testing"

	"github.com/jhaals/yopass/pkg/yopass"
	"golang.org/x/crypto/openpgp"
	"golang.org/x/crypto/openpgp/armor"
)

func TestSecretJSON(t *testing.T) {
	got, err := (&yopass.Secret{Expiration: 3600, Message: "msg", OneTime: true}).ToJSON()
	if err != nil {
		t.Fatal(err)
	}
	want := []byte(`{"expiration":3600,"message":"msg","one_time":true}`)
	if bytes.Compare(want, got) != 0 {
		t.Errorf("expected JSON %q, got %q", want, got)
	}
}

func TestDecrypt(t *testing.T) {
	tests := []struct {
		name     string
		msg      string
		key      string
		content  string
		filename string
		err      error
	}{
		{
			name: "text",
			msg: `-----BEGIN PGP MESSAGE-----
Version: OpenPGP.js v4.10.8
Comment: https://openpgpjs.org

wy4ECQMIRthQ3aO85NvgAfASIX3dTwsFVt0gshPu7n1tN05e8rpqxOk6PYNm
xtt90k4BqHuTCLNlFRJjuiuE8zdIc+j5zTN5zihxUReVqokeqULLOx2FBMHZ
sbfqaG/iDbp+qDOc98IagMyPrEqKDxnhVVOraXy5dD9RDsntLso=
=0vwU
-----END PGP MESSAGE-----`,
			key:     "4VGynYHxNGcurRgVEQ7RHX",
			content: "example secret message",
		},
		{
			name: "file",
			msg: `-----BEGIN PGP MESSAGE-----
Version: OpenPGP.js v4.10.8
Comment: https://openpgpjs.org

wy4ECQMIHCI4BfNkxELgEICJXDZCq2zf0+DkWHGLBNoM3SzySpFzTF9dGItJ
wCE50lQBbdoYiYZPT1+O/KCiDpC9P5ixWODZZXjUe/ZGxBvUlUrp0tx1VHWC
dhgGsvKwXJm0kEwGwqj6mJq/j28FSFoP9Et/LtRuEe3Ct06WOrrHQ4v9DC4=
=mja3
-----END PGP MESSAGE-----`,
			key:      "zQKcZ5jzbxeUI7Ylsu0bej",
			content:  "example secret file\n",
			filename: "file-upload.txt",
		},
		{
			name: "cli encrypted",
			msg: `-----BEGIN PGP MESSAGE-----
Comment: https://yopass.se

wy4ECQMILuOKAclPM2xgmtofvmWNo5/cfU8W54adSd82wxlrx9dHqfqpvPZnoaWF
0uAB5FihFdqjbxKcLB3vS5UGETHhL1Hgi+Aj4biL4HPiNPEFqOBC5GYbD5oD7xUW
Q5FI66ugslngweHlYODQ5IWLpbwMHdiymG7uoIKUusHi1lHUv+Gx0AA=
=YaUx
-----END PGP MESSAGE-----`,
			key:     "gHDiWDzjhgx8Lg7Wnwn90M",
			content: "cli secret message",
		},
		{
			name: "garbage message",
			msg:  "----- PGP MESSAGE -----",
			err:  yopass.ErrInvalidMessage,
		},
		{
			name: "wrong decryption key",
			msg: `-----BEGIN PGP MESSAGE-----
Version: OpenPGP.js v4.10.8
Comment: https://openpgpjs.org

wy4ECQMIRthQ3aO85NvgAfASIX3dTwsFVt0gshPu7n1tN05e8rpqxOk6PYNm
xtt90k4BqHuTCLNlFRJjuiuE8zdIc+j5zTN5zihxUReVqokeqULLOx2FBMHZ
sbfqaG/iDbp+qDOc98IagMyPrEqKDxnhVVOraXy5dD9RDsntLso=
=0vwU
-----END PGP MESSAGE-----`,
			key: "wrong",
			err: yopass.ErrInvalidKey,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, name, err := yopass.Decrypt(strings.NewReader(test.msg), test.key)
			if want := test.err; !errors.Is(err, want) {
				t.Fatalf("expected error %v, got %v", want, err)
			}
			if got != test.content {
				t.Errorf("expected plaintext %q, got %q", test.content, got)
			}
			if name != test.filename {
				t.Errorf("expected filename %q, got %q", test.filename, name)
			}
		})
	}
}

func TestEncrypt(t *testing.T) {
	p := "example secret message"
	k := "4VGynYHxNGcurRgVEQ7RHX"

	c, err := yopass.Encrypt(strings.NewReader(p), k)
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}

	prompt := func(keys []openpgp.Key, symmetric bool) ([]byte, error) {
		return []byte(k), nil
	}
	buf := bytes.NewBuffer([]byte(c))
	armorBlock, err := armor.Decode(buf)
	if err != nil {
		t.Fatal(err)
	}
	md, err := openpgp.ReadMessage(armorBlock.Body, nil, prompt, nil)
	if err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(md.UnverifiedBody)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != p {
		t.Fatalf("expected cyphertext to be %q, got %q", p, got)
	}

	_, err = yopass.Encrypt(strings.NewReader(p), "")
	if want := yopass.ErrEmptyKey; !errors.Is(err, want) {
		t.Errorf("expected error %v, got %v", want, err)
	}
}

type invalidFile struct{}

func (invalidFile) Read(p []byte) (n int, err error) { return 0, fmt.Errorf("Broken I/O") }

func TestEncryptWithInvalidFile(t *testing.T) {
	_, err := yopass.Encrypt(invalidFile{}, "somekey")
	if err == nil {
		t.Fatal("expected error, got none")
	}
	want := "could not copy data: Broken I/O"
	if err.Error() != want {
		t.Fatalf("expected %s, got %v", want, err)
	}
}

func TestGenerateKey(t *testing.T) {
	format := regexp.MustCompile("^[a-zA-Z0-9-_]{22}$")

	tests := make(map[string]struct{})
	for i := 0; i < 10_000; i++ {
		key, err := yopass.GenerateKey()
		if err != nil {
			t.Fatalf("expected no error, got %v", err)
		}
		if !format.MatchString(key) {
			t.Errorf("expected key format %q, got key %q", format.String(), key)
		}
		if _, ok := tests[key]; ok {
			t.Errorf("expected key to be random, got key %q more than once", key)
		}
		tests[key] = struct{}{}
	}
}

func TestSecretURL(t *testing.T) {
	tests := []struct {
		name string
		url  string
		id   string
		key  string
		fOpt bool
		kOpt bool
		want string
	}{
		{
			name: "regular",
			url:  "https://yopass.se",
			id:   "b961103f-5a54-4aae-94b8-dccb903802bc",
			key:  "X9eSZdgUOXSJ3ft0TXAfWT",
			want: "https://yopass.se/#/s/b961103f-5a54-4aae-94b8-dccb903802bc/X9eSZdgUOXSJ3ft0TXAfWT",
		},
		{
			name: "trailing slash",
			url:  "https://yopass.se/",
			id:   "b961103f-5a54-4aae-94b8-dccb903802bc",
			key:  "X9eSZdgUOXSJ3ft0TXAfWT",
			want: "https://yopass.se/#/s/b961103f-5a54-4aae-94b8-dccb903802bc/X9eSZdgUOXSJ3ft0TXAfWT",
		},
		{
			name: "different URL",
			url:  "https://yopass.company.org",
			id:   "b961103f-5a54-4aae-94b8-dccb903802bc",
			key:  "X9eSZdgUOXSJ3ft0TXAfWT",
			want: "https://yopass.company.org/#/s/b961103f-5a54-4aae-94b8-dccb903802bc/X9eSZdgUOXSJ3ft0TXAfWT",
		},
		{
			name: "manual key",
			url:  "https://yopass.se",
			id:   "6cb3b277-dadd-47c5-b118-d49824b40e15",
			key:  "manual-key",
			kOpt: true,
			want: "https://yopass.se/#/s/6cb3b277-dadd-47c5-b118-d49824b40e15",
		},
		{
			name: "file upload",
			url:  "https://yopass.se",
			id:   "c680736d-32ff-4e1a-a18f-3a20e6774616",
			key:  "ZMprbkA78FkEWAbrXKK06y",
			fOpt: true,
			want: "https://yopass.se/#/f/c680736d-32ff-4e1a-a18f-3a20e6774616/ZMprbkA78FkEWAbrXKK06y",
		},
		{
			name: "file upload with manual key",
			url:  "https://yopass.se",
			id:   "7a43c54c-6dad-4f98-b422-589021d1ac87",
			key:  "manual-key",
			fOpt: true,
			kOpt: true,
			want: "https://yopass.se/#/f/7a43c54c-6dad-4f98-b422-589021d1ac87",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			have := yopass.SecretURL(tt.url, tt.id, tt.key, tt.fOpt, tt.kOpt)
			if tt.want != have {
				t.Errorf("expected %q, got %q", tt.want, have)
			}
		})
	}
}

func TestParseURL(t *testing.T) {
	tests := []struct {
		name    string
		url     string
		id      string
		key     string
		fileOpt bool
		keyOpt  bool
		fail    bool
	}{
		{
			name: "regular",
			url:  "https://yopass.se/#/s/45d405ef-5c52-46c1-86d2-2d270c5b1b19/sLYp6skAIhkUnfUMimVU5O",
			id:   "45d405ef-5c52-46c1-86d2-2d270c5b1b19",
			key:  "sLYp6skAIhkUnfUMimVU5O",
		},
		{
			name: "trailing newline",
			url:  "https://yopass.se/#/s/45d405ef-5c52-46c1-86d2-2d270c5b1b19/sLYp6skAIhkUnfUMimVU5O\n",
			id:   "45d405ef-5c52-46c1-86d2-2d270c5b1b19",
			key:  "sLYp6skAIhkUnfUMimVU5O",
		},
		{
			name:   "manual key",
			url:    "https://yopass.se/#/c/2c625fd2-84b5-4a02-a6bf-23a2939eea4f",
			id:     "2c625fd2-84b5-4a02-a6bf-23a2939eea4f",
			keyOpt: true,
		},
		{
			name:    "file upload",
			url:     "https://yopass.se/#/f/c680736d-32ff-4e1a-a18f-3a20e6774616/ZMprbkA78FkEWAbrXKK06y",
			id:      "c680736d-32ff-4e1a-a18f-3a20e6774616",
			key:     "ZMprbkA78FkEWAbrXKK06y",
			fileOpt: true,
		},
		{
			name:    "file upload with manual key",
			url:     "https://yopass.se/#/d/7a43c54c-6dad-4f98-b422-589021d1ac87",
			id:      "7a43c54c-6dad-4f98-b422-589021d1ac87",
			fileOpt: true,
			keyOpt:  true,
		},
		{
			name: "invalid URL",
			url:  "invalid://yopass:se/#/d/7a43c54c-6dad-4f98-b422-589021d1ac87",
			fail: true,
		},
		{
			name: "missing fragment",
			url:  "https://yopass.se/",
			fail: true,
		},
		{
			name: "invalid yopass type",
			url:  "https://yopass.se/#/z/7a43c54c-6dad-4f98-b422-589021d1ac87",
			fail: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			id, key, fileOpt, keyOpt, err := yopass.ParseURL(tt.url)
			if tt.fail && err == nil {
				t.Fatalf("expected error, got nothing")
			}
			if !tt.fail && err != nil {
				t.Fatalf("expected no error, got %v", err)
			}
			if tt.id != id {
				t.Errorf("expected secret id %q, got %q", tt.id, id)
			}
			if tt.key != key {
				t.Errorf("expected secret key %q, got %q", tt.key, key)
			}
			if tt.fileOpt != fileOpt {
				t.Errorf("expected secret file option %t, got %t", tt.fileOpt, fileOpt)
			}
			if tt.keyOpt != keyOpt {
				t.Errorf("expected secret key option %t, got %t", tt.keyOpt, keyOpt)
			}
		})
	}
}
