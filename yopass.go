package main

import (
	"encoding/json"
	"log"
	"net/http"
	"regexp"

	"code.google.com/p/go-uuid/uuid"
	"github.com/bradfitz/gomemcache/memcache"
)

type secret struct {
	Secret   string `json:"secret"`
	Lifetime string `json:"lifetime"`
}

func validTTL(ttl string) bool {
	return false
}

func saveHandler(response http.ResponseWriter, request *http.Request) {
	response.Header().Set("Content-type", "application/json")

	if request.Method != "POST" {
		http.Error(response, `{"message": "Bad Request, see https://github.com/jhaals/yopass for more info"}`, 400)
		return
	}

	decoder := json.NewDecoder(request.Body)
	var s secret

	err := decoder.Decode(&s)
	if err != nil {
		http.Error(response, `{"message": "Unable to parse json"}`, 400)
		return
	}

	mc := memcache.New("127.0.0.1:11211")
	uuid := uuid.NewUUID()
	err = mc.Set(&memcache.Item{Key: uuid.String(), Value: []byte(s.Secret)})
	if err != nil {
		http.Error(response, `{"message": "Failed to store secret in database"}`, 500)
		return
	}

	resp := map[string]string{"key": uuid.String(), "message": "secret stored"}
	jsonData, _ := json.Marshal(resp)
	response.Write(jsonData)
}
func getHandler(response http.ResponseWriter, request *http.Request) {
	response.Header().Set("Content-type", "application/json")

	// Make sure the request contains a valid UUID
	var URL = regexp.MustCompile(`^/v1/secret/([0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12})$`)
	var UUIDMatches = URL.FindStringSubmatch(request.URL.Path)
	if len(UUIDMatches) <= 0 {
		http.Error(response, `{"message": "Bad URL"}`, 400)
		return
	}

	mc := memcache.New("127.0.0.1:11211")
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
	// serve UI
	fs := http.FileServer(http.Dir("public"))
	http.Handle("/", fs)

	http.HandleFunc("/v1/secret", saveHandler)
	http.HandleFunc("/v1/secret/", getHandler)

	log.Fatal(http.ListenAndServe(":8080", nil))
}
