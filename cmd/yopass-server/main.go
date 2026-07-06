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
	pflag.String("theme-light", "emerald", "DaisyUI theme name for light mode")
	pflag.String("theme-dark", "dim", "DaisyUI theme name for dark mode")
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

	if v := viper.GetString("default-expiry"); v != "" && !server.ValidExpiryString(v) {
		logger.Fatal("invalid --default-expiry value, expected one of: 1h, 1d, 1w",
			zap.String("value", v))
	}

	switch viper.GetString("force-expiration") {
	case "", "1h", "1d", "1w":
		// valid
	default:
		logger.Fatal("invalid --force-expiration value, expected one of: 1h, 1d, 1w",
			zap.String("value", viper.GetString("force-expiration")))
	}

	for _, flagName := range []string{"theme-light", "theme-dark"} {
		val := viper.GetString(flagName)
		if val == "custom-light" || val == "custom-dark" {
			logger.Fatal(flagName+" must not be set to a reserved name",
				zap.String("value", val),
				zap.Strings("reserved", []string{"custom-light", "custom-dark"}))
		}
	}

	for _, flagName := range []string{"theme-custom-light", "theme-custom-dark"} {
		raw := viper.GetString(flagName)
		if raw == "" {
			continue
		}
		var vars map[string]string
		if err := json.Unmarshal([]byte(raw), &vars); err != nil {
			logger.Fatal("invalid JSON for "+flagName, zap.Error(err))
		}
		for k := range vars {
			if !strings.HasPrefix(k, "--color-") {
				logger.Fatal(flagName+" contains invalid CSS variable key (must start with --color-)",
					zap.String("key", k))
			}
		}
	}

	registry := setupRegistry()

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

	var oidcProvider rp.RelyingParty
	if licenseStatus.Valid && viper.GetString("oidc-issuer") != "" {
		oidcCtx, oidcCancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer oidcCancel()
		var oidcErr error
		oidcProvider, oidcErr = server.NewOIDCProvider(oidcCtx, logger, server.OIDCConfig{
			Issuer:       viper.GetString("oidc-issuer"),
			ClientID:     viper.GetString("oidc-client-id"),
			ClientSecret: viper.GetString("oidc-client-secret"),
			RedirectURL:  viper.GetString("oidc-redirect-url"),
			SessionKey:   viper.GetString("oidc-session-key"),
		})
		if oidcErr != nil {
			logger.Fatal("failed to initialize OIDC provider", zap.Error(oidcErr))
		}
		logger.Info("OIDC authentication enabled",
			zap.String("issuer", viper.GetString("oidc-issuer")),
			zap.Bool("require_auth", viper.GetBool("require-auth")),
		)
	} else if viper.GetString("oidc-issuer") != "" && !licenseStatus.Valid {
		logger.Fatal("--oidc-issuer is configured but no valid license key was provided — refusing to start without authentication (provide --license-key or remove --oidc-issuer)")
	}
	if viper.GetBool("require-auth") && oidcProvider == nil {
		logger.Fatal("--require-auth is set but OIDC is not configured (check --oidc-issuer and --license-key)")
	}

	apiTokens, err := server.ParseAPITokens(getStringSliceCSV("api-token"))
	if err != nil {
		logger.Fatal("invalid --api-token", zap.Error(err))
	}
	if len(apiTokens) > 0 {
		if !viper.GetBool("require-auth") {
			logger.Fatal("--api-token is set but --require-auth is not — API tokens only apply when creation requires authentication")
		}
		names := make([]string, len(apiTokens))
		for i, t := range apiTokens {
			names[i] = t.Name
		}
		logger.Info("API token authentication enabled", zap.Strings("tokens", names))
	}

	var cookieCodec *securecookie.SecureCookie
	if oidcProvider != nil {
		sessionKey := viper.GetString("oidc-session-key")
		if len(sessionKey) == 128 {
			if _, err := hex.DecodeString(sessionKey); err != nil {
				logger.Fatal("--oidc-session-key is 128 characters but not valid hex; generate with: openssl rand -hex 64")
			}
		}
		cookieCodec = server.NewCookieCodec(sessionKey)
	}

	var auditLogger server.AuditLogger = server.NewNoopAuditLogger()
	if viper.GetBool("audit-log") {
		if !licenseStatus.Valid {
			logger.Fatal("--audit-log requires a valid license key")
		}
		al, err := server.NewAuditLogger(viper.GetString("audit-log-file"))
		if err != nil {
			logger.Fatal("failed to initialize audit logger", zap.Error(err))
		}
		auditLogger = al
		output := viper.GetString("audit-log-file")
		if output == "" {
			output = "stdout"
		}
		logger.Info("audit logging enabled", zap.String("output", output))
	}

	var webhooks *server.WebhookNotifier
	if webhookURL := viper.GetString("webhook-url"); webhookURL != "" {
		if !licenseStatus.Valid {
			logger.Fatal("--webhook-url requires a valid license key")
		}
		var whErr error
		webhooks, whErr = server.NewWebhookNotifier(server.WebhookConfig{
			URL:    webhookURL,
			Secret: viper.GetString("webhook-secret"),
		}, logger, registry)
		if whErr != nil {
			logger.Fatal("failed to initialize webhook notifier", zap.Error(whErr))
		}
		logger.Info("webhook notifications enabled",
			zap.String("url", webhookURL),
			zap.Bool("signed", viper.GetString("webhook-secret") != ""),
		)
	} else if viper.GetString("webhook-secret") != "" {
		logger.Fatal("--webhook-secret is set but --webhook-url is not")
	}

	maxFileSize, err := server.ParseSize(viper.GetString("max-file-size"))
	if err != nil {
		logger.Fatal("invalid --max-file-size value", zap.String("value", viper.GetString("max-file-size")), zap.Error(err))
	}
	const maxFileSizeCap int64 = 1 * 1024 * 1024 // 1MB
	if !licenseStatus.Valid && maxFileSize > maxFileSizeCap {
		logger.Warn("--max-file-size exceeds 1MB cap, capping to 1MB (a valid license removes this limit)",
			zap.String("requested", viper.GetString("max-file-size")))
		maxFileSize = maxFileSizeCap
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
