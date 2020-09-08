package main

import (
	"crypto/tls"
	"fmt"
	"log"
	"net/http"
	"strings"

	"github.com/jhaals/yopass/pkg/server"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/spf13/pflag"
	"github.com/spf13/viper"
)

func init() {
	pflag.String("address", "", "listen address (default 0.0.0.0)")
	pflag.Int("port", 1337, "listen port")
	pflag.String("database", "memcached", "database backend ('memcached' or 'redis')")
	pflag.Int("max-length", 10000, "max length of encrypted secret")
	pflag.String("memcached", "localhost:11211", "Memcached address")
	pflag.Int("metrics-port", -1, "metrics server listen port")
	pflag.String("redis", "redis://localhost:6379/0", "Redis URL")
	pflag.String("tls-cert", "", "path to TLS certificate")
	pflag.String("tls-key", "", "path to TLS key")

	viper.AutomaticEnv()
	viper.SetEnvKeyReplacer(strings.NewReplacer("-", "_"))
	pflag.Parse()
	viper.BindPFlags(pflag.CommandLine)
}

func main() {
	var (
		db    server.Database
		dbLog string
	)
	switch database := viper.GetString("database"); database {
	case "memcached":
		memcached := viper.GetString("memcached")
		db = server.NewMemcached(memcached)
		dbLog = fmt.Sprintf("configured Memcached address: %s", memcached)
	case "redis":
		redis := viper.GetString("redis")
		var err error
		db, err = server.NewRedis(redis)
		if err != nil {
			log.Fatalf("invalid Redis URL: %v", err)
		}
		dbLog = fmt.Sprintf("configured Redis URL: %s", redis)
	default:
		log.Fatalf("unsupported database: %q, expected 'memcached' or 'redis'", database)
	}

	registry := prometheus.NewRegistry()
	registry.MustRegister(prometheus.NewProcessCollector(prometheus.ProcessCollectorOpts{}))
	registry.MustRegister(prometheus.NewGoCollector())

	cert := viper.GetString("tls-cert")
	key := viper.GetString("tls-key")
	errc := make(chan error)

	go func() {
		addr := fmt.Sprintf("%s:%d", viper.GetString("address"), viper.GetInt("port"))
		log.Printf("Starting yopass server on %s, %s", addr, dbLog)
		y := server.New(db, viper.GetInt("max-length"), registry)
		errc <- listenAndServe(addr, y.HTTPHandler(), cert, key)
	}()

	if port := viper.GetInt("metrics-port"); port > 0 {
		go func() {
			addr := fmt.Sprintf("%s:%d", viper.GetString("address"), port)
			log.Printf("Starting yopass metrics server on %s", addr)
			errc <- listenAndServe(addr, metricsHandler(registry), cert, key)
		}()
	}

	log.Fatal(<-errc)
}

// listenAndServe starts a HTTP server on the given addr. It uses TLS if both
// certFile and keyFile are not empty.
func listenAndServe(addr string, h http.Handler, certFile, keyFile string) error {
	server := &http.Server{
		Addr:      addr,
		Handler:   h,
		TLSConfig: &tls.Config{MinVersion: tls.VersionTLS12},
	}
	if certFile == "" || keyFile == "" {
		return server.ListenAndServe()
	}
	return server.ListenAndServeTLS(certFile, keyFile)
}

// metricsHandler builds a handler to serve Prometheus metrics
func metricsHandler(r *prometheus.Registry) http.Handler {
	mx := http.NewServeMux()
	mx.Handle("/metrics", promhttp.HandlerFor(r, promhttp.HandlerOpts{EnableOpenMetrics: true}))
	return mx
}
