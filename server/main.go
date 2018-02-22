package main

import (
	"crypto/tls"
	"log"
	"net/http"
	"os"
  "strconv"

	"github.com/jhaals/yopass"
)

func main() {
	if os.Getenv("MEMCACHED") == "" {
		log.Println("MEMCACHED environment variable must be specified")
		os.Exit(1)
	}

  if os.Getenv("YOPASS_SECRET_MAXLEN") != "" {
    secret_maxlen, err := strconv.Atoi(os.Getenv("SECRET_MAXLEN"))
    if err != nil {
      log.Println("YOPASS_SECRET_MAXLEN is not an integer")
      os.Exit(1)
    }

    if secret_maxlen <= 0 {
      log.Println("YOPASS_SECRET_MAXLEN is not a postive integer")
      os.Exit(1)
    }
  }
  else {
    secret_maxlen := 10000
  }

	db := yopass.NewMemcached(os.Getenv("MEMCACHED"))

  conf := yopass.Config{Db: db, MaxLength: secret_maxlen}

	log.Println("Starting yopass. Listening on port 1337")
	if os.Getenv("TLS_CERT") != "" && os.Getenv("TLS_KEY") != "" {
    handler, err := yopass.HTTPHandler(conf)
    if err != nil {
      log.Println(err)
      os.Exit(1)
    }

		server := &http.Server{
			Addr:      ":1337",
			Handler:   handler,
			TLSConfig: &tls.Config{MinVersion: tls.VersionTLS12}}
		log.Fatal(server.ListenAndServeTLS(os.Getenv("TLS_CERT"), os.Getenv("TLS_KEY")))
	} else {
		log.Fatal(http.ListenAndServe(":1337", yopass.HTTPHandler(db)))
	}
}
