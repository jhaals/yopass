package main

import (
	"crypto/tls"
	"fmt"
	"log"
	"net/http"
	"strings"

	"github.com/jhaals/yopass/pkg/yopass"
	"github.com/spf13/pflag"
	"github.com/spf13/viper"
)

var (
	address   = pflag.String("address", "", "listen address (default 0.0.0.0)")
	database  = pflag.String("database", "memcached", "database backend ('memcached' or 'redis')")
	maxLength = pflag.Int("max-length", 10000, "max length of encrypted secret")
	memcached = pflag.String("memcached", "localhost:11211", "Memcached address")
	port      = pflag.Int("port", 1337, "listen port")
	redis     = pflag.String("redis", "redis://localhost:6379/0", "Redis URL")
	tlsCert   = pflag.String("tls-cert", "", "path to TLS certificate")
	tlsKey    = pflag.String("tls-key", "", "path to TLS key")
)

func main() {
	viper.AutomaticEnv()
	viper.SetEnvKeyReplacer(strings.NewReplacer("-", "_"))
	pflag.Parse()
	viper.BindPFlags(pflag.CommandLine)

	addr := fmt.Sprintf("%s:%d", viper.GetString("address"), viper.GetInt("port"))

	var (
		db    yopass.Database
		dbLog string
	)
	switch viper.GetString("database") {
	case "memcached":
		memcached := viper.GetString("memcached")
		db = yopass.NewMemcached(memcached)
		dbLog = fmt.Sprintf("configured Memcached address: %s", memcached)
	case "redis":
		redis := viper.GetString("redis")
		var err error
		db, err = yopass.NewRedis(redis)
		if err != nil {
			log.Fatalf("invalid Redis URL: %v", err)
		}
		dbLog = fmt.Sprintf("configured Redis URL: %s", redis)
	default:
		log.Fatalf("unsupported database: %q, expected 'memcached' or 'redis'", database)
	}

	log.Printf("Starting yopass on %s, %s", addr, dbLog)
	y := yopass.New(db, viper.GetInt("max-length"))
	if viper.GetString("tls-cert") != "" && viper.GetString("tls-key") != "" {
		server := &http.Server{
			Addr:      addr,
			Handler:   y.HTTPHandler(),
			TLSConfig: &tls.Config{MinVersion: tls.VersionTLS12}}
		log.Fatal(server.ListenAndServeTLS(viper.GetString("tls-cert"), viper.GetString("tls-key")))
	} else {
		log.Fatal(http.ListenAndServe(addr, y.HTTPHandler()))
	}
}
