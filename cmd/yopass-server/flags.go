package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"strings"

	"github.com/jhaals/yopass/pkg/server"
	"github.com/spf13/pflag"
	"github.com/spf13/viper"
	"go.uber.org/zap/zapcore"
)

var logLevel zapcore.Level

// version is set at build time via ldflags.
var version string

const licenseAnnotationKey = "yopass-license-group"

// licenseFlagSections groups the business-license flags for annotation and
// the usage printer. Order determines how the sections appear in --help.
var licenseFlagSections = []struct {
	title string
	group string
	flags []string
}{
	{"Authentication / OIDC", "oidc", []string{
		"oidc-issuer", "oidc-client-id", "oidc-client-secret", "oidc-redirect-url",
		"require-auth", "oidc-session-key", "oidc-allowed-domains", "frontend-url",
		"api-token",
	}},
	{"Branding & Theming", "branding", []string{
		"license-key", "app-name", "logo-url",
		"theme-light", "theme-dark", "theme-custom-light", "theme-custom-dark",
		"max-file-size",
	}},
	{"Audit Logging", "audit", []string{
		"audit-log", "audit-log-file",
	}},
	{"Secret Requests", "requests", []string{
		"disable-secret-requests",
	}},
	{"Webhooks & Read Receipts", "notifications", []string{
		"webhook-url", "webhook-secret", "disable-read-receipts",
	}},
}

// flagSectionFiltered returns a temporary FlagSet containing only the flags
// from pflag.CommandLine that satisfy the filter predicate.
func flagSectionFiltered(filter func(*pflag.Flag) bool) *pflag.FlagSet {
	fs := pflag.NewFlagSet("", pflag.ContinueOnError)
	pflag.CommandLine.VisitAll(func(f *pflag.Flag) {
		if !f.Hidden && filter(f) {
			fs.AddFlag(f)
		}
	})
	return fs
}

func init() {
	pflag.String("address", "", "listen address (default 0.0.0.0)")
	pflag.Int("port", 1337, "listen port")
	pflag.String("database", "memcached", "database backend ('memcached' or 'redis')")
	pflag.String("asset-path", "public", "path to the assets folder")
	pflag.Int("max-length", 10000, "max length of encrypted secret")
	pflag.String("max-file-size", "512KB", "max file upload size (e.g. 10KB, 512KB, 1MB); capped at 1MB without a license key")
	pflag.String("memcached", "localhost:11211", "memcached address")
	pflag.Int("metrics-port", -1, "metrics server listen port")
	pflag.String("redis", "redis://localhost:6379/0", "Redis URL")
	pflag.String("tls-cert", "", "path to TLS certificate")
	pflag.String("tls-key", "", "path to TLS key")
	pflag.Bool("force-onetime-secrets", false, "reject non onetime secrets from being created")
	pflag.Bool("argon2", false, "use Argon2 for password key derivation (adds 'wasm-unsafe-eval' to the CSP script-src directive)")
	pflag.String("cors-allow-origin", "*", "Access-Control-Allow-Origin")
	pflag.Bool("disable-upload", false, "disable the /file upload endpoints")
	pflag.Bool("read-only", false, "disable all secret creation endpoints (retrieval-only mode)")
	pflag.Bool("prefetch-secret", true, "Display information that the secret might be one time use")
	pflag.Bool("disable-features", false, "disable features")
	pflag.Bool("no-language-switcher", false, "disable the language switcher in the UI")
	pflag.StringSlice("trusted-proxies", []string{}, "trusted proxy IP addresses or CIDR blocks for X-Forwarded-For header validation")
	pflag.String("privacy-notice-url", "", "URL to privacy notice page")
	pflag.String("imprint-url", "", "URL to imprint/legal notice page")
	pflag.String("public-url", "", "base URL of the public/read-only instance used in generated secret links (e.g. https://secrets.example.com)")
	pflag.String("default-expiry", "1h", "default expiry time for secrets [1h, 1d, 1w]")
	pflag.String("force-expiration", "", "force all secrets to use this expiration time [1h, 1d, 1w]")
	pflag.String("theme-light", server.DefaultThemeLight, "DaisyUI theme name for light mode")
	pflag.String("theme-dark", server.DefaultThemeDark, "DaisyUI theme name for dark mode")
	pflag.String("theme-custom-light", "", "JSON object of CSS variables for a custom light theme (e.g. '{\"--color-primary\":\"oklch(...)\"}')")
	pflag.String("theme-custom-dark", "", "JSON object of CSS variables for a custom dark theme (e.g. '{\"--color-primary\":\"oklch(...)\"}')")
	pflag.String("app-name", "", "Custom application name shown in the UI (default: Yopass)")
	pflag.String("logo-url", "", "URL to a logo image (e.g. /mylogo.svg for a file in the public directory)")
	pflag.String("license-key", "", "JWT license key for premium features (theming, custom branding)")
	pflag.String("file-store", "", "file store backend for large files ('disk' or 's3'), defaults to database storage")
	pflag.String("file-store-path", "/tmp/yopass-files", "base path for disk file store")
	pflag.String("file-store-s3-bucket", "", "S3 bucket name for file store")
	pflag.String("file-store-s3-prefix", "yopass/", "S3 key prefix for file store")
	pflag.String("file-store-s3-endpoint", "", "S3 endpoint URL (for MinIO/compatible)")
	pflag.String("file-store-s3-region", "us-east-1", "S3 region")
	pflag.Int("cleanup-interval", 60, "file cleanup interval in seconds")
	pflag.Bool("disable-file-cleanup", false, "disable the file store cleanup goroutine (use when S3 lifecycle rules handle expiration)")
	pflag.Bool("health-check", false, "Perform health check and exit")
	pflag.String("oidc-issuer", "", "OIDC issuer URL (e.g. https://accounts.google.com)")
	pflag.String("oidc-client-id", "", "OIDC OAuth2 client ID")
	pflag.String("oidc-client-secret", "", "OIDC OAuth2 client secret")
	pflag.String("oidc-redirect-url", "", "OIDC callback URL (e.g. https://yopass.example.com/auth/callback)")
	pflag.Bool("require-auth", false, "require authentication to create secrets (needs --oidc-issuer and a valid license)")
	pflag.String("oidc-session-key", "", "64-byte hex-encoded session key for multi-instance deployments (generate with: openssl rand -hex 64)")
	pflag.StringSlice("oidc-allowed-domains", []string{}, "restrict secret creation to users whose email matches one of these domains (comma-separated, e.g. corp.example.com,example.com)")
	pflag.StringSlice("api-token", []string{}, "static bearer token granting machine clients access to the --require-auth gated creation endpoints, formatted as name:secret (comma-separated for multiple; generate secrets with: openssl rand -hex 32)")
	pflag.String("frontend-url", "", "frontend base URL for post-login redirect in split deployments (e.g. http://localhost:3000)")
	pflag.Bool("audit-log", false, "enable structured audit logging to NDJSON (requires valid license)")
	pflag.String("audit-log-file", "", "file path for audit log output (default: stdout)")
	pflag.Bool("disable-secret-requests", false, "disable the secret request feature (enabled by default with a valid license)")
	pflag.String("webhook-url", "", "URL receiving webhook notifications for secret and request lifecycle events (created, viewed, fulfilled, expired); requires a valid license")
	pflag.String("webhook-secret", "", "HMAC-SHA256 key used to sign webhook payloads (X-Yopass-Signature header)")
	pflag.Bool("disable-read-receipts", false, "disable the read receipt feature (enabled by default with a valid license)")
	pflag.CommandLine.AddGoFlag(&flag.Flag{Name: "log-level", Usage: "Log level", Value: &logLevel})

	for _, section := range licenseFlagSections {
		for _, name := range section.flags {
			if err := pflag.CommandLine.SetAnnotation(name, licenseAnnotationKey, []string{section.group}); err != nil {
				log.Fatalf("failed to annotate flag %q: %v", name, err)
			}
		}
	}

	pflag.Usage = func() {
		fmt.Fprintf(os.Stderr, "Usage: yopass-server [flags]\n\nFlags:\n")
		flagSectionFiltered(func(f *pflag.Flag) bool {
			_, ok := f.Annotations[licenseAnnotationKey]
			return !ok
		}).PrintDefaults()

		for _, section := range licenseFlagSections {
			group := section.group
			fmt.Fprintf(os.Stderr, "\nBusiness License — %s (requires --license-key):\n", section.title)
			flagSectionFiltered(func(f *pflag.Flag) bool {
				vals := f.Annotations[licenseAnnotationKey]
				return len(vals) > 0 && vals[0] == group
			}).PrintDefaults()
		}
	}

	viper.AutomaticEnv()
	viper.SetEnvKeyReplacer(strings.NewReplacer("-", "_"))
	if err := viper.BindPFlags(pflag.CommandLine); err != nil {
		log.Fatalf("Unable to bind flags: %v", err)
	}

	pflag.Parse()
}
