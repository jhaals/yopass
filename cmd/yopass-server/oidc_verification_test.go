package main

import (
	"strings"
	"testing"
	"time"

	"github.com/jhaals/yopass/pkg/server"
	"github.com/spf13/pflag"
	"github.com/spf13/viper"
	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
	"go.uber.org/zap/zaptest/observer"
)

func TestOIDCVerificationConfiguration(t *testing.T) {
	const key = "oidc-require-verified-email"
	registered := pflag.CommandLine.Lookup(key)
	if registered == nil || registered.DefValue != "true" {
		t.Fatal("verification flag must be registered with default true")
	}
	if len(registered.Annotations[licenseAnnotationKey]) == 0 {
		t.Fatal("verification flag missing from authentication help")
	}
	for _, tc := range []struct {
		name string
		env  string
		args []string
		want bool
	}{
		{"default", "", nil, true},
		{"environment opt-out", "false", nil, false},
		{"environment required", "true", nil, true},
		{"flag opt-out", "", []string{"--" + key + "=false"}, false},
		{"flag overrides environment", "false", []string{"--" + key + "=true"}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("OIDC_REQUIRE_VERIFIED_EMAIL", tc.env)
			flags := pflag.NewFlagSet("test", pflag.ContinueOnError)
			flags.Bool(key, registered.DefValue == "true", registered.Usage)
			if err := flags.Parse(tc.args); err != nil {
				t.Fatal(err)
			}
			config := viper.New()
			config.AutomaticEnv()
			config.SetEnvKeyReplacer(strings.NewReplacer("-", "_"))
			if err := config.BindPFlags(flags); err != nil {
				t.Fatal(err)
			}
			if got := config.GetBool(key); got != tc.want {
				t.Fatalf("require verified email = %t, want %t", got, tc.want)
			}
		})
	}
}

func TestOIDCVerificationStartup(t *testing.T) {
	license := server.LicenseStatus{Valid: true, ExpiresAt: time.Now().Add(time.Hour)}
	for _, tc := range []struct {
		name    string
		issuer  string
		value   any
		domains []string
		warn    bool
		invalid bool
	}{
		{"required", "https://issuer.example", true, nil, false, false},
		{"opt-out", "https://issuer.example", false, nil, true, false},
		{"opt-out with domains", "https://issuer.example", false, []string{"example.com"}, true, false},
		{"OIDC disabled", "", false, nil, false, false},
		{"invalid boolean", "https://issuer.example", "treu", nil, false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			setFlag(t, "oidc-issuer", tc.issuer)
			setFlag(t, "oidc-require-verified-email", tc.value)
			setFlag(t, "oidc-allowed-domains", tc.domains)
			setFlag(t, "require-auth", false)
			core, logs := observer.New(zapcore.WarnLevel)
			err := validateFlags(license, zap.New(core))
			if tc.invalid {
				if err == nil || !strings.Contains(err.Error(), "oidc-require-verified-email") {
					t.Fatalf("expected invalid verification setting error, got %v", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			warnings := logs.FilterMessageSnippet("OIDC email verification disabled").All()
			if (len(warnings) == 1) != tc.warn {
				t.Fatalf("got %d verification warnings, want warning=%t", len(warnings), tc.warn)
			}
			if tc.warn && warnings[0].ContextMap()["email_domain_restrictions"] != (len(tc.domains) > 0) {
				t.Fatal("warning must indicate whether domain restrictions are configured")
			}
		})
	}
}
