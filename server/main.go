package main

import (
	"crypto/tls"
	"log"
	"net/http"
	"os"

	"github.com/jhaals/yopass"
)

func main() {
	if os.Getenv("MEMCACHED") == "" {
		log.Println("MEMCACHED environment variable must be specified")
		os.Exit(1)
	}
	db := yopass.NewMemcached(os.Getenv("MEMCACHED"))

	log.Println("Starting yopass. Listening on port 1337")
	if os.Getenv("TLS_CERT") != "" && os.Getenv("TLS_KEY") != "" {
		server := &http.Server{
			Addr:      ":1337",
			Handler:   yopass.HTTPHandler(db),
			TLSConfig: &tls.Config{MinVersion: tls.VersionTLS12}}
		log.Fatal(server.ListenAndServeTLS(os.Getenv("TLS_CERT"), os.Getenv("TLS_KEY")))
	} else {
		log.Fatal(http.ListenAndServe(":1337", yopass.HTTPHandler(db)))
	}
}
