package main

import (
	"crypto/tls"
	"flag"
	"fmt"
	"log"
	"net/http"

	"github.com/jhaals/yopass/pkg/yopass"
)

var (
	memcached = flag.String("memcached", "localhost:11211", "memcached address")
	address   = flag.String("address", "", "yopass server address (default 0.0.0.0)")
	port      = flag.Int("port", 1337, "yopass server port")
	tlsCert   = flag.String("tls.cert", "", "path to TLS certificate")
	tlsKey    = flag.String("tls.key", "", "path to TLS key")
)

func main() {
	flag.Parse()
	addr := fmt.Sprintf("%s:%d", *address, *port)
	log.Printf("Starting yopass on %s, configured memcached address: %s", addr, *memcached)
	db := yopass.NewMemcached(*memcached)
	if *tlsCert != "" && *tlsKey != "" {
		server := &http.Server{
			Addr:      addr,
			Handler:   yopass.HTTPHandler(db),
			TLSConfig: &tls.Config{MinVersion: tls.VersionTLS12}}
		log.Fatal(server.ListenAndServeTLS(*tlsCert, *tlsKey))
	} else {
		log.Fatal(http.ListenAndServe(addr, yopass.HTTPHandler(db)))
	}
}
