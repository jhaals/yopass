package main

import (
	"context"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/gorilla/securecookie"
	"github.com/jhaals/yopass/pkg/server"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/spf13/pflag"
	"github.com/spf13/viper"
	"github.com/zitadel/oidc/v3/pkg/client/rp"
	"go.uber.org/zap"
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
	pflag.Bool("hide-oneclick-link", false, "hide the one-click reveal link on the result page, requiring the recipient to manually confirm before viewing the secret")
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

func main() {
	logger := configureZapLogger()

	// Handle health check mode
	if viper.GetBool("health-check") {
		db, err := setupDatabase(logger)
		if err != nil {
			logger.Error("Failed to setup database", zap.Error(err))
			os.Exit(1)
		}
		if err := performHealthCheck(logger, db); err != nil {
			logger.Error("Health check failed", zap.Error(err))
			os.Exit(1)
		}
		logger.Info("Health check passed")
		os.Exit(0)
	}

	registry := setupRegistry()
	licenseStatus := setupLicense(logger, registry)

	if err := validateFlags(licenseStatus.Valid); err != nil {
		logger.Fatal(err.Error(), zap.Error(err))
	}

	oidcProvider, cookieCodec, err := setupOIDC(logger, licenseStatus.Valid)
	if err != nil {
		logger.Fatal("failed to initialize OIDC provider", zap.Error(err))
	}

	apiTokens, err := resolveAPITokens()
	if err != nil {
		logger.Fatal(err.Error(), zap.Error(err))
	}
	if len(apiTokens) > 0 {
		names := make([]string, len(apiTokens))
		for i, t := range apiTokens {
			names[i] = t.Name
		}
		logger.Info("API token authentication enabled", zap.Strings("tokens", names))
	}

	auditLogger, err := setupAuditLogger(logger)
	if err != nil {
		logger.Fatal("failed to initialize audit logger", zap.Error(err))
	}

	webhooks, err := setupWebhooks(logger, registry)
	if err != nil {
		logger.Fatal("failed to initialize webhook notifier", zap.Error(err))
	}

	maxFileSize, err := resolveMaxFileSize(logger, licenseStatus.Valid)
	if err != nil {
		logger.Fatal(err.Error(), zap.Error(err))
	}

	db, err := setupDatabase(logger)
	if err != nil {
		logger.Fatal("failed to setup database", zap.Error(err))
	}
	var fileStore server.FileStore
	if !viper.GetBool("disable-upload") {
		fileStore, err = setupFileStore(logger, db)
		if err != nil {
			logger.Fatal("failed to setup file store", zap.Error(err))
		}

		// Warn if max-length exceeds DB backend limits without a dedicated file store
		if _, isDBStore := fileStore.(*server.DatabaseFileStore); isDBStore {
			const memcachedLimit int64 = 1 * 1024 * 1024 // 1MB default memcached item limit
			if maxFileSize > memcachedLimit {
				logger.Warn("max-file-size exceeds typical database backend limits without a file store configured",
					zap.String("max-file-size", server.FormatSize(maxFileSize)),
					zap.String("db-limit", server.FormatSize(memcachedLimit)),
					zap.String("hint", "consider using --file-store disk or --file-store s3 for large file support"),
				)
			}
		}
	}

	cert := viper.GetString("tls-cert")
	key := viper.GetString("tls-key")
	quit := make(chan os.Signal, 1)

	y := server.Server{
		DB:                  db,
		FileStore:           fileStore,
		MaxLength:           viper.GetInt("max-length"),
		MaxFileSize:         maxFileSize,
		Registry:            registry,
		ForceOneTimeSecrets: viper.GetBool("force-onetime-secrets"),
		HideOneClickLink:    viper.GetBool("hide-oneclick-link"),
		AssetPath:           viper.GetString("asset-path"),
		Logger:              logger,
		TrustedProxies:      getStringSliceCSV("trusted-proxies"),
		Version:             version,
		License:             licenseStatus,
		OIDCProvider:        oidcProvider,
		CookieCodec:         cookieCodec,
		Audit:               auditLogger,
		Webhooks:            webhooks,

		Argon2:                viper.GetBool("argon2"),
		ReadOnly:              viper.GetBool("read-only"),
		DisableUpload:         viper.GetBool("disable-upload"),
		PrefetchSecret:        viper.GetBool("prefetch-secret"),
		DisableFeatures:       viper.GetBool("disable-features"),
		NoLanguageSwitcher:    viper.GetBool("no-language-switcher"),
		DisableSecretRequests: viper.GetBool("disable-secret-requests"),
		DisableReadReceipts:   viper.GetBool("disable-read-receipts"),

		RequireAuth:         viper.GetBool("require-auth"),
		AllowedEmailDomains: getStringSliceCSV("oidc-allowed-domains"),
		APITokens:           apiTokens,

		CORSAllowOrigin:  viper.GetString("cors-allow-origin"),
		FrontendURL:      viper.GetString("frontend-url"),
		PrivacyNoticeURL: viper.GetString("privacy-notice-url"),
		ImprintURL:       viper.GetString("imprint-url"),
		PublicURL:        viper.GetString("public-url"),
		LogoURL:          viper.GetString("logo-url"),

		AppName:          viper.GetString("app-name"),
		ThemeLight:       viper.GetString("theme-light"),
		ThemeDark:        viper.GetString("theme-dark"),
		ThemeCustomLight: viper.GetString("theme-custom-light"),
		ThemeCustomDark:  viper.GetString("theme-custom-dark"),

		DefaultExpiry: viper.GetString("default-expiry"),
	}
	// Start cleanup goroutine for file store (disk or S3)
	cleanupCtx, cleanupCancel := context.WithCancel(context.Background())
	defer cleanupCancel()
	if fileStore != nil && !viper.GetBool("disable-file-cleanup") {
		if ds, ok := fileStore.(*server.DiskFileStore); ok {
			interval := time.Duration(viper.GetInt("cleanup-interval")) * time.Second
			logger.Info("Starting disk file store cleanup", zap.Duration("interval", interval))
			go server.StartDiskCleanup(cleanupCtx, ds, interval, logger)
		} else if s3s, ok := fileStore.(*server.S3FileStore); ok {
			interval := time.Duration(viper.GetInt("cleanup-interval")) * time.Second
			logger.Info("Starting S3 file store cleanup", zap.Duration("interval", interval))
			go server.StartS3Cleanup(cleanupCtx, s3s, interval, logger)
		}
	}

	yopassSrv := &http.Server{
		Addr:      fmt.Sprintf("%s:%d", viper.GetString("address"), viper.GetInt("port")),
		Handler:   y.HTTPHandler(),
		TLSConfig: &tls.Config{MinVersion: tls.VersionTLS12},
	}
	go func() {
		logger.Info("Starting yopass server", zap.String("address", yopassSrv.Addr))
		logger.Info("Loading assets from: ", zap.String("asset-path", y.AssetPath))
		err := listenAndServe(yopassSrv, cert, key)
		if !errors.Is(err, http.ErrServerClosed) {
			logger.Fatal("yopass stopped unexpectedly", zap.Error(err))
		}
	}()

	metricsServer := &http.Server{
		Addr:    fmt.Sprintf("%s:%d", viper.GetString("address"), viper.GetInt("metrics-port")),
		Handler: metricsHandler(registry),
	}
	if port := viper.GetInt("metrics-port"); port > 0 {
		go func() {
			logger.Info("Starting yopass metrics server", zap.String("address", metricsServer.Addr))
			err := listenAndServe(metricsServer, cert, key)
			if !errors.Is(err, http.ErrServerClosed) {
				logger.Fatal("metrics server stopped unexpectedly", zap.Error(err))
			}
		}()
	}

	signal.Notify(quit, os.Interrupt, syscall.SIGINT, syscall.SIGTERM)
	sig := <-quit
	logger.Info("Shutting down HTTP server", zap.String("signal", sig.String()))
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := yopassSrv.Shutdown(ctx); err != nil {
		logger.Fatal("shutdown error: %s", zap.Error(err))
	}
	if port := viper.GetInt("metrics-port"); port > 0 {
		if err := metricsServer.Shutdown(ctx); err != nil {
			logger.Fatal("shutdown error: %s", zap.Error(err))
		}
	}
	if webhooks != nil {
		webhooks.Stop()
	}
	if err := auditLogger.Sync(); err != nil {
		logger.Error("failed to flush audit log on shutdown", zap.Error(err))
	}
	logger.Info("Server shut down")
}

// validateFlags checks flag values and cross-flag requirements that need no
// constructed dependencies, returning an error describing the first problem
// found. licenseValid reports whether a valid --license-key was provided,
// which gates the business features.
func validateFlags(licenseValid bool) error {
	if v := viper.GetString("default-expiry"); v != "" && !server.ValidExpiryString(v) {
		return fmt.Errorf("invalid --default-expiry value %q, expected one of: 1h, 1d, 1w", v)
	}

	switch v := viper.GetString("force-expiration"); v {
	case "", "1h", "1d", "1w":
		// valid
	default:
		return fmt.Errorf("invalid --force-expiration value %q, expected one of: 1h, 1d, 1w", v)
	}

	for _, flagName := range []string{"theme-light", "theme-dark"} {
		val := viper.GetString(flagName)
		if val == "custom-light" || val == "custom-dark" {
			return fmt.Errorf("--%s must not be set to the reserved name %q", flagName, val)
		}
	}

	for _, flagName := range []string{"theme-custom-light", "theme-custom-dark"} {
		raw := viper.GetString(flagName)
		if raw == "" {
			continue
		}
		var vars map[string]string
		if err := json.Unmarshal([]byte(raw), &vars); err != nil {
			return fmt.Errorf("invalid JSON for --%s: %w", flagName, err)
		}
		for k := range vars {
			if !strings.HasPrefix(k, "--color-") {
				return fmt.Errorf("--%s contains invalid CSS variable key %q (must start with --color-)", flagName, k)
			}
		}
	}

	if viper.GetString("oidc-issuer") != "" && !licenseValid {
		return errors.New("--oidc-issuer is configured but no valid license key was provided — refusing to start without authentication (provide --license-key or remove --oidc-issuer)")
	}

	if viper.GetBool("require-auth") && (viper.GetString("oidc-issuer") == "" || !licenseValid) {
		return errors.New("--require-auth is set but OIDC is not configured (check --oidc-issuer and --license-key)")
	}

	if key := viper.GetString("oidc-session-key"); len(key) == 128 {
		if _, err := hex.DecodeString(key); err != nil {
			return errors.New("--oidc-session-key is 128 characters but not valid hex; generate with: openssl rand -hex 64")
		}
	}

	if viper.GetBool("audit-log") && !licenseValid {
		return errors.New("--audit-log requires a valid license key")
	}

	if viper.GetString("webhook-url") != "" && !licenseValid {
		return errors.New("--webhook-url requires a valid license key")
	}
	if viper.GetString("webhook-secret") != "" && viper.GetString("webhook-url") == "" {
		return errors.New("--webhook-secret is set but --webhook-url is not")
	}

	return nil
}

// setupLicense verifies --license-key when provided and registers the
// license expiry gauge on the registry.
func setupLicense(logger *zap.Logger, registry *prometheus.Registry) server.LicenseStatus {
	licenseStatus := server.LicenseStatus{}
	if licenseKey := viper.GetString("license-key"); licenseKey != "" {
		licenseStatus = server.VerifyLicense(licenseKey, logger)
		if licenseStatus.Valid {
			logger.Info("license key verified",
				zap.String("licensee", licenseStatus.Licensee),
				zap.Time("expires_at", licenseStatus.ExpiresAt),
				zap.Float64("days_until_expiry", licenseStatus.DaysUntilExpiry()),
			)
		}
		daysGauge := prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "yopass_license_days_until_expiry",
			Help: "Number of days until the license key expires; negative if expired",
		})
		registry.MustRegister(daysGauge)
		daysGauge.Set(licenseStatus.DaysUntilExpiry())
	}
	return licenseStatus
}

// setupOIDC creates the OIDC relying party and session cookie codec when
// --oidc-issuer is configured. validateFlags has already rejected an issuer
// without a valid license, so a nil provider simply means OIDC is off.
func setupOIDC(logger *zap.Logger, licenseValid bool) (rp.RelyingParty, *securecookie.SecureCookie, error) {
	if !licenseValid || viper.GetString("oidc-issuer") == "" {
		return nil, nil, nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	provider, err := server.NewOIDCProvider(ctx, logger, server.OIDCConfig{
		Issuer:       viper.GetString("oidc-issuer"),
		ClientID:     viper.GetString("oidc-client-id"),
		ClientSecret: viper.GetString("oidc-client-secret"),
		RedirectURL:  viper.GetString("oidc-redirect-url"),
		SessionKey:   viper.GetString("oidc-session-key"),
	})
	if err != nil {
		return nil, nil, err
	}
	logger.Info("OIDC authentication enabled",
		zap.String("issuer", viper.GetString("oidc-issuer")),
		zap.Bool("require_auth", viper.GetBool("require-auth")),
	)

	sessionKey := viper.GetString("oidc-session-key")
	if sessionKey != "" && len(sessionKey) != 128 {
		// NewCookieCodec silently falls back to random per-instance keys
		// for any other length, which breaks sessions across instances
		// and restarts — surface the misconfiguration loudly. The
		// 128-characters-but-not-hex case is rejected by validateFlags.
		logger.Warn("--oidc-session-key is set but not 128 hex characters; falling back to random per-instance session keys — sessions will not survive restarts or work across multiple instances (generate with: openssl rand -hex 64)",
			zap.Int("length", len(sessionKey)))
	}
	return provider, server.NewCookieCodec(sessionKey), nil
}

// resolveAPITokens parses --api-token and enforces that tokens are only
// used together with --require-auth.
func resolveAPITokens() ([]server.APIToken, error) {
	tokens, err := server.ParseAPITokens(getStringSliceCSV("api-token"))
	if err != nil {
		return nil, fmt.Errorf("invalid --api-token: %w", err)
	}
	if len(tokens) > 0 && !viper.GetBool("require-auth") {
		return nil, errors.New("--api-token is set but --require-auth is not — API tokens only apply when creation requires authentication")
	}
	return tokens, nil
}

// setupAuditLogger builds the audit logger, or the no-op implementation when
// --audit-log is not set. The license requirement is checked by validateFlags.
func setupAuditLogger(logger *zap.Logger) (server.AuditLogger, error) {
	if !viper.GetBool("audit-log") {
		return server.NewNoopAuditLogger(), nil
	}
	auditLogger, err := server.NewAuditLogger(viper.GetString("audit-log-file"))
	if err != nil {
		return nil, err
	}
	output := viper.GetString("audit-log-file")
	if output == "" {
		output = "stdout"
	}
	logger.Info("audit logging enabled", zap.String("output", output))
	return auditLogger, nil
}

// setupWebhooks builds the webhook notifier when --webhook-url is set. The
// license requirement and the secret-without-url case are checked by
// validateFlags.
func setupWebhooks(logger *zap.Logger, registry *prometheus.Registry) (*server.WebhookNotifier, error) {
	webhookURL := viper.GetString("webhook-url")
	if webhookURL == "" {
		return nil, nil
	}
	webhooks, err := server.NewWebhookNotifier(server.WebhookConfig{
		URL:    webhookURL,
		Secret: viper.GetString("webhook-secret"),
	}, logger, registry)
	if err != nil {
		return nil, err
	}
	logger.Info("webhook notifications enabled",
		zap.String("url", webhookURL),
		zap.Bool("signed", viper.GetString("webhook-secret") != ""),
	)
	return webhooks, nil
}

// resolveMaxFileSize parses --max-file-size and applies the 1MB cap for
// unlicensed servers.
func resolveMaxFileSize(logger *zap.Logger, licenseValid bool) (int64, error) {
	maxFileSize, err := server.ParseSize(viper.GetString("max-file-size"))
	if err != nil {
		return 0, fmt.Errorf("invalid --max-file-size value %q: %w", viper.GetString("max-file-size"), err)
	}
	const maxFileSizeCap int64 = 1 * 1024 * 1024 // 1MB
	if !licenseValid && maxFileSize > maxFileSizeCap {
		logger.Warn("--max-file-size exceeds 1MB cap, capping to 1MB (a valid license removes this limit)",
			zap.String("requested", viper.GetString("max-file-size")))
		maxFileSize = maxFileSizeCap
	}
	return maxFileSize, nil
}

// listenAndServe starts a HTTP server on the given addr. It uses TLS if both
// certFile and keyFile are not empty.
func listenAndServe(srv *http.Server, certFile string, keyFile string) error {
	if certFile == "" || keyFile == "" {
		return srv.ListenAndServe()
	}
	return srv.ListenAndServeTLS(certFile, keyFile)
}

// metricsHandler builds a handler to serve Prometheus metrics
func metricsHandler(r *prometheus.Registry) http.Handler {
	mx := http.NewServeMux()
	mx.Handle("/metrics", promhttp.HandlerFor(r, promhttp.HandlerOpts{EnableOpenMetrics: true}))
	return mx
}

// getStringSliceCSV resolves a StringSlice setting consistently across flags,
// environment variables, and config files. viper only splits command-line flag
// values on commas; values coming from AutomaticEnv are returned as a single
// raw string (and cast splits on whitespace, not commas). This helper splits
// every element on commas and trims whitespace so that, for example,
// TRUSTED_PROXIES=192.168.1.0/24,10.0.0.0/8 yields two entries.
func getStringSliceCSV(key string) []string {
	var out []string
	for _, v := range viper.GetStringSlice(key) {
		for _, part := range strings.Split(v, ",") {
			if part = strings.TrimSpace(part); part != "" {
				out = append(out, part)
			}
		}
	}
	return out
}

func setupRegistry() *prometheus.Registry {
	registry := prometheus.NewRegistry()
	registry.MustRegister(collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}))
	registry.MustRegister(collectors.NewGoCollector())
	return registry
}

// configureZapLogger resolves the log level through viper so that the
// `log-level` flag, the `LOG_LEVEL` environment variable, and config files are
// all honored, then sets and replaces the zap global logger.
func configureZapLogger() *zap.Logger {
	loggerCfg := zap.NewProductionConfig()
	if raw := viper.GetString("log-level"); raw != "" {
		level, err := zapcore.ParseLevel(raw)
		if err != nil {
			log.Fatalf("invalid log level %q: %v", raw, err)
		}
		loggerCfg.Level.SetLevel(level)
	} else {
		loggerCfg.Level.SetLevel(logLevel)
	}

	logger, err := loggerCfg.Build()
	if err != nil {
		log.Fatalf("Unable to build logger %v", err)
	}
	zap.ReplaceGlobals(logger)
	return logger
}

func setupDatabase(logger *zap.Logger) (server.Database, error) {
	var db server.Database
	switch database := viper.GetString("database"); database {
	case "memcached":
		memcached := viper.GetString("memcached")
		db = server.NewMemcached(memcached)
		logger.Debug("configured Memcached", zap.String("address", memcached))
	case "redis":
		redis := viper.GetString("redis")
		var err error
		db, err = server.NewRedis(redis)
		if err != nil {
			return nil, fmt.Errorf("invalid Redis URL: %w", err)
		}
		logger.Debug("configured Redis", zap.String("url", redis))
	default:
		return nil, fmt.Errorf("unsupported database, expected 'memcached' or 'redis' got '%s'", database)
	}
	return db, nil
}

// performHealthCheck performs a health check on the provided database
func performHealthCheck(logger *zap.Logger, db server.Database) error {
	if err := db.Health(); err != nil {
		if logger != nil {
			logger.Error("database health check failed", zap.Error(err))
		}
		return fmt.Errorf("database health check failed: %w", err)
	}
	return nil
}

func setupFileStore(logger *zap.Logger, db server.Database) (server.FileStore, error) {
	switch viper.GetString("file-store") {
	case "":
		logger.Info("no file store configured, using database for file storage")
		return server.NewDatabaseFileStore(db), nil
	case "disk":
		path := viper.GetString("file-store-path")
		logger.Info("configured disk file store", zap.String("path", path))
		return server.NewDiskFileStore(path)
	case "s3":
		bucket := viper.GetString("file-store-s3-bucket")
		if bucket == "" {
			return nil, fmt.Errorf("file-store-s3-bucket is required when file-store=s3")
		}
		logger.Info("configured S3 file store",
			zap.String("bucket", bucket),
			zap.String("prefix", viper.GetString("file-store-s3-prefix")),
			zap.String("region", viper.GetString("file-store-s3-region")),
		)
		return server.NewS3FileStore(
			bucket,
			viper.GetString("file-store-s3-prefix"),
			viper.GetString("file-store-s3-endpoint"),
			viper.GetString("file-store-s3-region"),
		)
	default:
		return nil, fmt.Errorf("unsupported file-store backend: %s (expected 'disk' or 's3')", viper.GetString("file-store"))
	}
}
