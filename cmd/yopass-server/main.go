package main

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jhaals/yopass/pkg/server"
	"github.com/spf13/viper"
	"go.uber.org/zap"
)

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

	if err := validateFlags(licenseStatus, logger); err != nil {
		logger.Fatal(err.Error(), zap.Error(err))
	}

	oidcProvider, cookieCodec, err := setupOIDC(logger, licenseStatus)
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

	maxFileSize, err := resolveMaxFileSize(logger, licenseStatus.CurrentlyValid())
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

		DefaultExpiry:   viper.GetString("default-expiry"),
		ForceExpiration: viper.GetString("force-expiration"),
	}
	// Start cleanup goroutine for file store (disk or S3)
	cleanupCtx, cleanupCancel := context.WithCancel(context.Background())
	defer cleanupCancel()
	// Business feature gates re-check the expiry timestamp on every request,
	// so an expired license degrades the server without a restart; this
	// monitor only makes that visible in the logs.
	if licenseStatus.Valid {
		go server.StartLicenseExpiryMonitor(cleanupCtx, licenseStatus, time.Hour, logger)
	}
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

	// ReadTimeout and WriteTimeout are deliberately unset: file upload and
	// download stream bodies of arbitrary size, and a whole-request deadline
	// would abort slow but legitimate transfers. Body size is bounded by
	// MaxBytesReader in the handlers instead. A slow client can still trickle
	// a size-capped body; per-request deadlines via http.ResponseController
	// would be the fix if that becomes a problem.
	yopassSrv := &http.Server{
		Addr:              fmt.Sprintf("%s:%d", viper.GetString("address"), viper.GetInt("port")),
		Handler:           y.HTTPHandler(),
		TLSConfig:         &tls.Config{MinVersion: tls.VersionTLS12},
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
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
		Addr:              fmt.Sprintf("%s:%d", viper.GetString("address"), viper.GetInt("metrics-port")),
		Handler:           metricsHandler(registry),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       120 * time.Second,
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
