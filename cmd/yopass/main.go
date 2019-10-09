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
	maxLength = pflag.Int("max-length", 10000, "max length of encrypted secret")
	memcached = pflag.String("memcached", "localhost:11211", "memcached address")
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
	memcache := viper.GetString("memcached")
	log.Printf("Starting yopass on %s, configured memcached address: %s", addr, memcache)

	y := yopass.New(yopass.NewMemcached(memcache), viper.GetInt("max-length"))
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
