package main

import (
	"crypto/tls"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"

	"github.com/3lvia/hn-config-lib-go/vault"
	"github.com/3lvia/onetime-yopass/pkg/server"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/spf13/pflag"
	"github.com/spf13/viper"
	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
)

var logLevel zapcore.Level

func init() {
	pflag.String("address", "", "listen address (default 0.0.0.0)")
	pflag.Int("port", 1337, "listen port")
	pflag.Int("max-length", 10000, "max length of encrypted secret")
	pflag.Int("metrics-port", -1, "metrics server listen port")
	pflag.String("tls-cert", "", "path to TLS certificate")
	pflag.String("tls-key", "", "path to TLS key")
	pflag.Bool("force-onetime-secrets", false, "reject non onetime secrets from being created")
	pflag.CommandLine.AddGoFlag(&flag.Flag{Name: "log-level", Usage: "Log level", Value: &logLevel})

	viper.AutomaticEnv()
	viper.SetEnvKeyReplacer(strings.NewReplacer("-", "_"))
	_ = viper.BindPFlags(pflag.CommandLine)

	pflag.Parse()
	viper.BindPFlags(pflag.CommandLine)
	// Example:
	// ONETIME_ELVID_BASE_URL="https://elvid.test-elvia.io" go run ./cmd/yopass-server/
	viper.SetEnvPrefix("onetime")
	log.Println("viper.Get(\"ELVID_BASE_URL\"):", viper.Get("ELVID_BASE_URL"))
	os.Setenv("ELVID_BASE_URL", viper.GetString("ELVID_BASE_URL"))
	log.Println("os.Getenv(\"ELVID_BASE_URL\"):", os.Getenv("ELVID_BASE_URL"))
}

func main() {
	var (
		db    server.Database
		dbLog string
	)
	vault, err := vault.New()
	if err != nil {
		log.Fatal(err)
	}
	secret, err := vault.GetSecret("onetime/kv/data/azurerm-redis-cache/onetime")
	if err != nil {
		log.Fatal(err)
	}
	d := secret.GetData()
	redisHostname := d["hostname"].(string) + ":6380"
	redisPassword := d["primary-access-key"].(string)
	db, err = server.NewRedis(redisHostname, redisPassword)
	if err != nil {
		log.Fatalf("invalid Redis URL: %v", err)
	}
	dbLog = fmt.Sprintf("configured Redis URL: %s", redisHostname)

	registry := prometheus.NewRegistry()
	registry.MustRegister(prometheus.NewProcessCollector(prometheus.ProcessCollectorOpts{}))
	registry.MustRegister(prometheus.NewGoCollector())

	cert := viper.GetString("tls-cert")
	key := viper.GetString("tls-key")
	errc := make(chan error)

	go func() {
		addr := fmt.Sprintf("%s:%d", viper.GetString("address"), viper.GetInt("port"))
		logger.Info("Starting yopass server", zap.String("address", addr))
		y := server.New(db, viper.GetInt("max-length"), registry, viper.GetBool("force-onetime-secrets"), logger)
		errc <- listenAndServe(addr, y.HTTPHandler(), cert, key)
	}()

	if port := viper.GetInt("metrics-port"); port > 0 {
		go func() {
			addr := fmt.Sprintf("%s:%d", viper.GetString("address"), port)
			logger.Info("Starting yopass metrics server", zap.String("address", addr))
			errc <- listenAndServe(addr, metricsHandler(registry), cert, key)
		}()
	}

	err := <-errc
	logger.Fatal("yopass stopped unexpectedly", zap.Error(err))
}

// listenAndServe starts a HTTP server on the given addr. It uses TLS if both
// certFile and keyFile are not empty.
func listenAndServe(addr string, h http.Handler, certFile, keyFile string) error {
	srv := &http.Server{
		Addr:      addr,
		Handler:   h,
		TLSConfig: &tls.Config{MinVersion: tls.VersionTLS12},
	}
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

// configureZapLogger uses the `log-level` command line argument to set and replace the zap global logger.
func configureZapLogger() *zap.Logger {
	loggerCfg := zap.NewProductionConfig()
	loggerCfg.Level.SetLevel(logLevel)

	logger, err := loggerCfg.Build()
	if err != nil {
		log.Fatalf("Unable to build logger %v", err)
	}
	zap.ReplaceGlobals(logger)
	return logger
}
