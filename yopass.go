package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"regexp"

	"code.google.com/p/go-uuid/uuid"
	"github.com/bradfitz/gomemcache/memcache"
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
	mcAddress string) {
	response.Header().Set("Content-type", "application/json")

	if request.Method != "POST" {
		http.Error(response,
			`{"message": "Bad Request, see https://github.com/jhaals/yopass for more info"}`,
			400)
		return
	}

	decoder := json.NewDecoder(request.Body)
	var s secret
	err := decoder.Decode(&s)
	if err != nil {
		http.Error(response, `{"message": "Unable to parse json"}`, 400)
		return
	}

	if validExpiration(s.Expiration) == false {
		http.Error(response, `{"message": "Invalid expiration specified"}`, 400)
		return
	}

	if len(s.Secret) > 10000 {
		http.Error(response, `{"message": "Message is too long"}`, 400)
		return
	}

	mc := memcache.New(mcAddress)
	uuid := uuid.NewUUID()
	err = mc.Set(&memcache.Item{
		Key:        uuid.String(),
		Value:      []byte(s.Secret),
		Expiration: s.Expiration})
	if err != nil {
		http.Error(response, `{"message": "Failed to store secret in database"}`, 500)
		return
	}

	resp := map[string]string{"key": uuid.String(), "message": "secret stored"}
	jsonData, _ := json.Marshal(resp)
	response.Write(jsonData)
}

func getHandler(response http.ResponseWriter, request *http.Request, mcAddress string) {
	response.Header().Set("Content-type", "application/json")

	// Make sure the request contains a valid UUID
	var URL = regexp.MustCompile(`^/v1/secret/([0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12})$`)
	var UUIDMatches = URL.FindStringSubmatch(request.URL.Path)
	if len(UUIDMatches) <= 0 {
		http.Error(response, `{"message": "Bad URL"}`, 400)
		return
	}

	mc := memcache.New(mcAddress)
	secret, err := mc.Get(UUIDMatches[1])
	if err != nil {
		http.Error(response, `{"message": "Unable to receive secret from database"}`, 500)
		return
	}
	// Allow more downloads of this message
	mc.Delete(UUIDMatches[1])

	resp := map[string]string{"secret": string(secret.Value), "message": "OK"}
	jsonData, _ := json.Marshal(resp)
	response.Write(jsonData)
}

func main() {
	mcAddress := os.Getenv("MEMCACHED")
	if mcAddress == "" {
		log.Println("MEMCACHED environment variable must be specified")
		os.Exit(1)
	}

	// serve UI
	fs := http.FileServer(http.Dir("public"))
	http.Handle("/", fs)

	http.HandleFunc("/v1/secret", func(response http.ResponseWriter, request *http.Request) {
		saveHandler(response, request, mcAddress)
	})
	http.HandleFunc("/v1/secret/", func(response http.ResponseWriter, request *http.Request) {
		getHandler(response, request, mcAddress)
	})

	log.Fatal(http.ListenAndServe(":8080", nil))
}
