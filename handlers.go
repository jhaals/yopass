package yopass

import (
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/gorilla/mux"
	uuid "github.com/satori/go.uuid"
)

// validExpiration validates that expiration is either
// 3600(1hour), 86400(1day) or 604800(1week)
func validExpiration(expiration int32) bool {
	for _, ttl := range []int32{3600, 86400, 604800} {
		if ttl == expiration {
			return true
		}
	}
	return false
}

// CreateSecret creates secret
func CreateSecret(w http.ResponseWriter, request *http.Request, db Database) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	decoder := json.NewDecoder(request.Body)
	var secret struct {
		Message    string `json:"secret"`
		Expiration int32  `json:"expiration"`
	}
	err := decoder.Decode(&secret)
	if err != nil {
		http.Error(w, `{"message": "Unable to parse json"}`, http.StatusBadRequest)
		return
	}

	if !validExpiration(secret.Expiration) {
		http.Error(w, `{"message": "Invalid expiration specified"}`, http.StatusBadRequest)
		return
	}

	if len(secret.Message) > 10000 {
		http.Error(w, `{"message": "Message is too long"}`, http.StatusBadRequest)
		return
	}

	// Generate new UUID and store secret in memcache with specified expiration
	key := uuid.NewV4().String()
	err = db.Put(key, secret.Message, secret.Expiration)
	if err != nil {
		fmt.Println(err)
		http.Error(w, `{"message": "Failed to store secret in database"}`, http.StatusInternalServerError)
		return
	}
	resp := map[string]string{"message": key}
	jsonData, _ := json.Marshal(resp)
	w.Write(jsonData)
}

// GetSecret from database
func GetSecret(w http.ResponseWriter, request *http.Request, db Database) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	secret, err := db.Get(mux.Vars(request)["key"])
	if err != nil {
		fmt.Println(err)
		http.Error(w, `{"message": "Secret not found"}`, http.StatusNotFound)
		return
	}
	err = db.Delete(mux.Vars(request)["key"])
	if err != nil {
		fmt.Println(err)
		http.Error(w, `{"message": "Failed to clear secret"}`, http.StatusInternalServerError)
		return
	}
	resp, _ := json.Marshal(map[string]string{"message": string(secret)})
	w.Write(resp)
}
