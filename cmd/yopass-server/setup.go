package main

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/gorilla/securecookie"
	"github.com/jhaals/yopass/pkg/server"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/spf13/viper"
	"github.com/zitadel/oidc/v3/pkg/client/rp"
	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
)

// unsafeCSSVarChars mirrors the frontend's theme-variable sanitization so invalid theme-custom
// entries fail fast at startup instead of being silently dropped in the UI.
var unsafeCSSVarChars = regexp.MustCompile(`[;{}<>]`)

// validateFlags checks flag values and cross-flag requirements that need no
// constructed dependencies, returning an error describing the first problem
// found. An expired license (verified signature but past expiry) degrades
// gracefully — business features are disabled while security features (OIDC,
// audit, webhooks) remain active. Only a completely absent or invalid key
// produces a fatal error when business flags are configured.
func validateFlags(license server.LicenseStatus, logger *zap.Logger) error {
	licenseValid := license.CurrentlyValid()
	// noLicense is true when no usable key was ever provided (absent or
	// failed verification). An expired key is still "provided" and the
	// server degrades instead of refusing to start.
	noLicense := !licenseValid && !license.Expired()
	if value := viper.Get("oidc-require-verified-email"); value != nil {
		if _, err := strconv.ParseBool(fmt.Sprint(value)); err != nil {
			return errors.New("invalid --oidc-require-verified-email: expected true or false")
		}
	}
	for _, flagName := range []string{"request-timeout", "file-transfer-timeout"} {
		value := viper.Get(flagName)
		if value == nil {
			continue
		}
		raw := fmt.Sprint(value)
		timeout, err := time.ParseDuration(raw)
		if err != nil {
			return fmt.Errorf("invalid --%s value %q: use a duration with a unit (e.g. 30s, 5m, or 1h), or 0: %w", flagName, raw, err)
		}
		if timeout < 0 {
			return fmt.Errorf("--%s must not be negative", flagName)
		}
	}
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
		for k, v := range vars {
			if !strings.HasPrefix(k, "--") {
				return fmt.Errorf("--%s contains invalid CSS variable key %q (must start with --)", flagName, k)
			}
			if unsafeCSSVarChars.MatchString(k) || unsafeCSSVarChars.MatchString(v) {
				return fmt.Errorf("--%s contains invalid CSS variable %q (keys and values must not contain ; { } < >)", flagName, k)
			}
		}
	}

	if viper.GetString("oidc-issuer") != "" && noLicense {
		return errors.New("--oidc-issuer is configured but no valid license key was provided — refusing to start without authentication (provide --license-key or remove --oidc-issuer)")
	}

	if viper.GetBool("require-auth") && (viper.GetString("oidc-issuer") == "" || noLicense) {
		return errors.New("--require-auth is set but OIDC is not configured (check --oidc-issuer and --license-key)")
	}

	if key := viper.GetString("oidc-session-key"); len(key) == 128 {
		if _, err := hex.DecodeString(key); err != nil {
			return errors.New("--oidc-session-key is 128 characters but not valid hex; generate with: openssl rand -hex 64")
		}
	}

	if viper.GetBool("audit-log") && noLicense {
		return errors.New("--audit-log requires a valid license key")
	}

	if viper.GetString("webhook-url") != "" && noLicense {
		return errors.New("--webhook-url requires a valid license key")
	}
	if viper.GetString("webhook-secret") != "" && viper.GetString("webhook-url") == "" {
		return errors.New("--webhook-secret is set but --webhook-url is not")
	}
	if viper.GetString("oidc-issuer") != "" && !viper.GetBool("oidc-require-verified-email") {
		logger.Warn("OIDC email verification disabled: trusting provider email assertions without verification; restrict provider application access and ensure email attributes are trustworthy",
			zap.Bool("email_domain_restrictions", len(getStringSliceCSV("oidc-allowed-domains")) > 0))
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
		// GaugeFunc recomputes on every scrape so the metric keeps counting
		// down (and goes negative) while the server runs.
		daysGauge := prometheus.NewGaugeFunc(prometheus.GaugeOpts{
			Name: "yopass_license_days_until_expiry",
			Help: "Number of days until the license key expires; negative if expired",
		}, licenseStatus.DaysUntilExpiry)
		registry.MustRegister(daysGauge)
	}
	return licenseStatus
}

// setupOIDC creates the OIDC relying party and session cookie codec when
// --oidc-issuer is configured. OIDC is set up for both valid and expired
// licenses — authentication is security infrastructure that an expiring
// license must not weaken. validateFlags has already rejected an issuer
// without any license, so a nil provider simply means OIDC is off.
func setupOIDC(logger *zap.Logger, license server.LicenseStatus) (rp.RelyingParty, *securecookie.SecureCookie, error) {
	licenseProvided := license.CurrentlyValid() || license.Expired()
	if !licenseProvided || viper.GetString("oidc-issuer") == "" {
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
	const maxFileSizeCap = server.UnlicensedMaxFileSize // 1MB
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
