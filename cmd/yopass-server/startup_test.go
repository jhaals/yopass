package main

import (
	"strings"
	"testing"
	"time"

	"github.com/jhaals/yopass/pkg/server"
	"github.com/spf13/viper"
	"go.uber.org/zap/zaptest"
)

// setFlag overrides a viper key for the duration of the test, restoring the
// previous value afterwards so tests stay independent of execution order.
func setFlag(t *testing.T, key string, value interface{}) {
	t.Helper()
	prev := viper.Get(key)
	viper.Set(key, value)
	t.Cleanup(func() { viper.Set(key, prev) })
}

// A syntactically valid 128-hex-character session key (64 bytes).
var validSessionKey = strings.Repeat("0123456789abcdef", 8)

func TestValidateFlags(t *testing.T) {
	validLicense := server.LicenseStatus{Valid: true, Licensee: "acme", ExpiresAt: time.Now().Add(24 * time.Hour)}
	expiredLicense := server.LicenseStatus{Valid: false, Licensee: "acme", ExpiresAt: time.Now().Add(-time.Minute)}
	noLicense := server.LicenseStatus{}

	tests := []struct {
		name    string
		flags   map[string]interface{}
		license server.LicenseStatus
		wantErr string // substring; empty means no error
	}{
		{
			name: "defaults are valid",
		},
		{
			name:    "invalid default-expiry",
			flags:   map[string]interface{}{"default-expiry": "2h"},
			wantErr: "--default-expiry",
		},
		{
			name:    "invalid force-expiration",
			flags:   map[string]interface{}{"force-expiration": "30m"},
			wantErr: "--force-expiration",
		},
		{
			name:  "valid force-expiration",
			flags: map[string]interface{}{"force-expiration": "1d"},
		},
		{
			name:    "reserved theme name",
			flags:   map[string]interface{}{"theme-light": "custom-light"},
			wantErr: "reserved name",
		},
		{
			name:    "custom theme invalid JSON",
			flags:   map[string]interface{}{"theme-custom-light": "{not json"},
			wantErr: "invalid JSON for --theme-custom-light",
		},
		{
			name:    "custom theme non-color variable",
			flags:   map[string]interface{}{"theme-custom-dark": `{"--font-size":"12px"}`},
			wantErr: "must start with --color-",
		},
		{
			name:  "custom theme valid",
			flags: map[string]interface{}{"theme-custom-dark": `{"--color-primary":"red"}`},
		},
		{
			name:    "oidc-issuer requires license",
			flags:   map[string]interface{}{"oidc-issuer": "https://accounts.example.com"},
			wantErr: "--oidc-issuer is configured but no valid license key",
		},
		{
			name:         "oidc-issuer with license",
			flags:        map[string]interface{}{"oidc-issuer": "https://accounts.example.com"},
			license: validLicense,
		},
		{
			name:         "require-auth without oidc-issuer",
			flags:        map[string]interface{}{"require-auth": true},
			license: validLicense,
			wantErr:      "--require-auth is set but OIDC is not configured",
		},
		{
			name: "require-auth without license",
			flags: map[string]interface{}{
				"require-auth": true,
				"oidc-issuer":  "https://accounts.example.com",
			},
			wantErr: "no valid license key",
		},
		{
			name: "session key 128 chars but not hex",
			flags: map[string]interface{}{
				"oidc-session-key": strings.Repeat("zz", 64),
			},
			wantErr: "--oidc-session-key is 128 characters but not valid hex",
		},
		{
			name: "session key valid hex",
			flags: map[string]interface{}{
				"oidc-session-key": validSessionKey,
			},
		},
		{
			name: "session key short is accepted (warned about at startup)",
			flags: map[string]interface{}{
				"oidc-session-key": "tooshort",
			},
		},
		{
			name:    "audit-log requires license",
			flags:   map[string]interface{}{"audit-log": true},
			wantErr: "--audit-log requires a valid license key",
		},
		{
			name:         "audit-log with license",
			flags:        map[string]interface{}{"audit-log": true},
			license: validLicense,
		},
		{
			name:    "webhook-url requires license",
			flags:   map[string]interface{}{"webhook-url": "https://hooks.example.com"},
			wantErr: "--webhook-url requires a valid license key",
		},
		{
			name:    "webhook-secret without webhook-url",
			flags:   map[string]interface{}{"webhook-secret": "hmac-key"},
			wantErr: "--webhook-secret is set but --webhook-url is not",
		},
		{
			name: "webhook fully configured",
			flags: map[string]interface{}{
				"webhook-url":    "https://hooks.example.com",
				"webhook-secret": "hmac-key",
			},
			license: validLicense,
		},
		// Expired licenses degrade gracefully — business flags are allowed.
		{
			name:    "expired license with oidc-issuer degrades gracefully",
			flags:   map[string]interface{}{"oidc-issuer": "https://accounts.example.com"},
			license: expiredLicense,
		},
		{
			name: "expired license with require-auth degrades gracefully",
			flags: map[string]interface{}{
				"require-auth": true,
				"oidc-issuer":  "https://accounts.example.com",
			},
			license: expiredLicense,
		},
		{
			name:    "expired license with audit-log degrades gracefully",
			flags:   map[string]interface{}{"audit-log": true},
			license: expiredLicense,
		},
		{
			name: "expired license with webhooks degrades gracefully",
			flags: map[string]interface{}{
				"webhook-url":    "https://hooks.example.com",
				"webhook-secret": "hmac-key",
			},
			license: expiredLicense,
		},
		// No license at all is still a hard error.
		{
			name:    "no license with oidc-issuer still errors",
			flags:   map[string]interface{}{"oidc-issuer": "https://accounts.example.com"},
			license: noLicense,
			wantErr: "--oidc-issuer is configured but no valid license key",
		},
		{
			name:    "no license with audit-log still errors",
			flags:   map[string]interface{}{"audit-log": true},
			license: noLicense,
			wantErr: "--audit-log requires a valid license key",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			for k, v := range tc.flags {
				setFlag(t, k, v)
			}
			err := validateFlags(tc.license, zaptest.NewLogger(t))
			if tc.wantErr == "" {
				if err != nil {
					t.Fatalf("expected no error, got %q", err)
				}
				return
			}
			if err == nil {
				t.Fatalf("expected error containing %q, got nil", tc.wantErr)
			}
			if !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("expected error containing %q, got %q", tc.wantErr, err)
			}
		})
	}
}

func TestResolveAPITokens(t *testing.T) {
	t.Run("no tokens", func(t *testing.T) {
		tokens, err := resolveAPITokens()
		if err != nil {
			t.Fatalf("expected no error, got %q", err)
		}
		if len(tokens) != 0 {
			t.Fatalf("expected no tokens, got %d", len(tokens))
		}
	})

	t.Run("token without require-auth", func(t *testing.T) {
		setFlag(t, "api-token", []string{"ci:0123456789abcdef"})
		_, err := resolveAPITokens()
		if err == nil || !strings.Contains(err.Error(), "--require-auth") {
			t.Fatalf("expected require-auth interlock error, got %v", err)
		}
	})

	t.Run("token with require-auth", func(t *testing.T) {
		setFlag(t, "api-token", []string{"ci:0123456789abcdef"})
		setFlag(t, "require-auth", true)
		tokens, err := resolveAPITokens()
		if err != nil {
			t.Fatalf("expected no error, got %q", err)
		}
		if len(tokens) != 1 || tokens[0].Name != "ci" {
			t.Fatalf("expected one token named ci, got %+v", tokens)
		}
	})

	t.Run("malformed token", func(t *testing.T) {
		setFlag(t, "api-token", []string{"missing-separator"})
		setFlag(t, "require-auth", true)
		_, err := resolveAPITokens()
		if err == nil || !strings.Contains(err.Error(), "invalid --api-token") {
			t.Fatalf("expected parse error, got %v", err)
		}
	})
}

func TestResolveMaxFileSize(t *testing.T) {
	logger := zaptest.NewLogger(t)

	t.Run("invalid value", func(t *testing.T) {
		setFlag(t, "max-file-size", "not-a-size")
		if _, err := resolveMaxFileSize(logger, false); err == nil {
			t.Fatal("expected error for invalid size")
		}
	})

	t.Run("unlicensed within cap", func(t *testing.T) {
		setFlag(t, "max-file-size", "512KB")
		size, err := resolveMaxFileSize(logger, false)
		if err != nil {
			t.Fatalf("expected no error, got %q", err)
		}
		if size != 512*1024 {
			t.Fatalf("expected 512KB, got %d", size)
		}
	})

	t.Run("unlicensed capped at 1MB", func(t *testing.T) {
		setFlag(t, "max-file-size", "5MB")
		size, err := resolveMaxFileSize(logger, false)
		if err != nil {
			t.Fatalf("expected no error, got %q", err)
		}
		if size != 1024*1024 {
			t.Fatalf("expected 1MB cap, got %d", size)
		}
	})

	t.Run("licensed uncapped", func(t *testing.T) {
		setFlag(t, "max-file-size", "5MB")
		size, err := resolveMaxFileSize(logger, true)
		if err != nil {
			t.Fatalf("expected no error, got %q", err)
		}
		if size != 5*1024*1024 {
			t.Fatalf("expected 5MB, got %d", size)
		}
	})
}
