package main

import (
	"crypto/tls"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"

	"github.com/jhaals/yopass/pkg/yopass"
	"github.com/spf13/pflag"
	"github.com/spf13/viper"
)

var (
	address   = pflag.String("address", "", "listen address (default 0.0.0.0)")
	maxLength = pflag.Int("max-length", 10000, "max length of encrypted secret")
	memcached = pflag.String("memcached", "", "Memcached address (e.g. localhost:11211)")
	redis     = pflag.String("redis", "", "Redis URL (e.g. redis://localhost:6379/0)")
	port      = pflag.Int("port", 1337, "listen port")
	tlsCert   = pflag.String("tls-cert", "", "path to TLS certificate")
	tlsKey    = pflag.String("tls-key", "", "path to TLS key")
)

func main() {
	viper.AutomaticEnv()
	viper.SetEnvKeyReplacer(strings.NewReplacer("-", "_"))
	pflag.Parse()
	viper.BindPFlags(pflag.CommandLine)

	addr := fmt.Sprintf("%s:%d", viper.GetString("address"), viper.GetInt("port"))
	memcached := viper.GetString("memcached")
	redis := viper.GetString("redis")

	var (
		db yopass.Database
		dbLog string
		err error
	)
	if memcached != "" {
		db = yopass.NewMemcached(memcached)
		dbLog = fmt.Sprintf("configured Memcached address: %s", memcached)
	} else if redis != "" {
		db, err = yopass.NewRedis(redis)
		if err != nil {
			log.Fatalf("invalid Redis URL: %v", err)
		}
		dbLog = fmt.Sprintf("configured Redis URL: %s", redis)
	} else {
		fmt.Fprintf(os.Stderr, "Either Memcached address or Redis URL must be specified:\n")
		pflag.Usage()
		os.Exit(1)
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
