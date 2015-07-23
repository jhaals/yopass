package main

import (
	"crypto/tls"
	"encoding/json"
	"log"
	"net/http"
	"os"

	"code.google.com/p/go-uuid/uuid"
	"github.com/bradfitz/gomemcache/memcache"
	"github.com/gorilla/handlers"
	"github.com/gorilla/mux"
)

type secret struct {
	Secret     string `json:"secret"`
	Expiration int32  `json:"expiration"`
}

func validExpiration(expiration int32) bool {
	for _, ttl := range []int32{3600, 86400, 604800} {
		if ttl == expiration {
			return true
		}
	}
	return false
}

func saveHandler(response http.ResponseWriter, request *http.Request,
	memcached *memcache.Client) {
	response.Header().Set("Content-type", "application/json")

	if request.Method != "POST" {
		http.Error(response,
			`{"message": "Bad Request, see https://github.com/jhaals/yopass for more info"}`,
			http.StatusBadRequest)
		return
	}

	decoder := json.NewDecoder(request.Body)
	var s secret
	err := decoder.Decode(&s)
	if err != nil {
		http.Error(response, `{"message": "Unable to parse json"}`, http.StatusBadRequest)
		return
	}

	if validExpiration(s.Expiration) == false {
		http.Error(response, `{"message": "Invalid expiration specified"}`, http.StatusBadRequest)
		return
	}

	if len(s.Secret) > 10000 {
		http.Error(response, `{"message": "Message is too long"}`, http.StatusBadRequest)
		return
	}

	uuid := uuid.NewUUID()
	err = memcached.Set(&memcache.Item{
		Key:        uuid.String(),
		Value:      []byte(s.Secret),
		Expiration: s.Expiration})
	if err != nil {
		http.Error(response, `{"message": "Failed to store secret in database"}`, http.StatusInternalServerError)
		return
	}

	resp := map[string]string{"key": uuid.String(), "message": "secret stored"}
	jsonData, _ := json.Marshal(resp)
	response.Write(jsonData)
}

func getHandler(response http.ResponseWriter, request *http.Request, memcached *memcache.Client) {
	response.Header().Set("Content-type", "application/json")

	secret, err := memcached.Get(mux.Vars(request)["uuid"])
	if err != nil {
		if err.Error() == "memcache: cache miss" {
			http.Error(response, `{"message": "Secret not found"}`, http.StatusNotFound)
			return
		}
		log.Println(err)
		http.Error(response, `{"message": "Unable to receive secret from database"}`, http.StatusInternalServerError)
		return
	}

	// Delete secret from memcached
	memcached.Delete(mux.Vars(request)["uuid"])

	resp := map[string]string{"secret": string(secret.Value), "message": "OK"}
	jsonData, _ := json.Marshal(resp)
	response.Write(jsonData)
}

func main() {
	if os.Getenv("MEMCACHED") == "" {
		log.Println("MEMCACHED environment variable must be specified")
		os.Exit(1)
	}
	mc := memcache.New(os.Getenv("MEMCACHED"))

	mx := mux.NewRouter()
	mx.HandleFunc("/v1/secret/{uuid:([0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12})}",
		func(response http.ResponseWriter, request *http.Request) {
			getHandler(response, request, mc)
		}).Methods("GET")
	mx.HandleFunc("/v1/secret", func(response http.ResponseWriter, request *http.Request) {
		saveHandler(response, request, mc)
	}).Methods("POST")
	mx.PathPrefix("/").Handler(http.FileServer(http.Dir("public")))

	log.Println("Starting yopass. Listening on port 1337")
	if os.Getenv("TLS_CERT") != "" && os.Getenv("TLS_KEY") != "" {
		config := &tls.Config{MinVersion: tls.VersionTLS12,
			PreferServerCipherSuites: true,
			CipherSuites: []uint16{
				tls.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
				tls.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
				tls.TLS_ECDHE_ECDSA_WITH_AES_128_CBC_SHA,
				tls.TLS_ECDHE_ECDSA_WITH_AES_256_CBC_SHA,
				tls.TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA,
				tls.TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA,
				tls.TLS_RSA_WITH_AES_128_CBC_SHA,
				tls.TLS_RSA_WITH_AES_256_CBC_SHA,
				tls.TLS_ECDHE_RSA_WITH_3DES_EDE_CBC_SHA,
				tls.TLS_RSA_WITH_3DES_EDE_CBC_SHA,
			}}
		server := &http.Server{Addr: ":1337",
			Handler: handlers.LoggingHandler(os.Stdout, mx), TLSConfig: config}
		log.Fatal(server.ListenAndServeTLS(os.Getenv("TLS_CERT"), os.Getenv("TLS_KEY")))
	} else {
		log.Fatal(http.ListenAndServe(":1337", handlers.LoggingHandler(os.Stdout, mx)))
	}
}
