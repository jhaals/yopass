package yopass

import (
	"encoding/json"
	"net/http"
	"os"

	"github.com/gorilla/handlers"
	"github.com/gorilla/mux"
	uuid "github.com/satori/go.uuid"
)

// Yopass struct holding database and settings.
// This should be created with yopass.New
type Yopass struct {
	db        Database
	maxLength int
}

// New is the main way of creating the server.
func New(db Database, maxLength int) Yopass {
	return Yopass{
		db:        db,
		maxLength: maxLength,
	}
}

var secret struct {
	Expiration int32  `json:"expiration,omitempty"`
	Message    string `json:"secret,omitempty"`
}

// createSecret creates secret
func (y *Yopass) createSecret(w http.ResponseWriter, request *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	decoder := json.NewDecoder(request.Body)
	if err := decoder.Decode(&secret); err != nil {
		http.Error(w, `{"message": "Unable to parse json"}`, http.StatusBadRequest)
		return
	}

	if !validExpiration(secret.Expiration) {
		http.Error(w, `{"message": "Invalid expiration specified"}`, http.StatusBadRequest)
		return
	}

	if len(secret.Message) > y.maxLength {
		http.Error(w, `{"message": "Message is too long"}`, http.StatusBadRequest)
		return
	}

	// Generate new UUID and store secret in memcache with specified expiration
	key := uuid.NewV4().String()
	if err := y.db.Put(key, secret.Message, secret.Expiration); err != nil {
		http.Error(w, `{"message": "Failed to store secret in database"}`, http.StatusInternalServerError)
		return
	}
	resp := map[string]string{"message": key}
	jsonData, _ := json.Marshal(resp)
	w.Write(jsonData)
}

// getSecret from database
func (y *Yopass) getSecret(w http.ResponseWriter, request *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	secret, err := y.db.Get(mux.Vars(request)["key"])
	if err != nil {
		http.Error(w, `{"message": "Secret not found"}`, http.StatusNotFound)
		return
	}

	if err := y.db.Delete(mux.Vars(request)["key"]); err != nil {
		http.Error(w, `{"message": "Failed to clear secret"}`, http.StatusInternalServerError)
		return
	}
	resp, _ := json.Marshal(map[string]string{"message": secret})
	w.Write(resp)
}

// HTTPHandler containing all routes
func (y *Yopass) HTTPHandler() http.Handler {
	mx := mux.NewRouter()
	mx.HandleFunc("/secret/{key:(?:[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})}",
		y.getSecret)
	mx.HandleFunc("/secret", y.createSecret).Methods("POST")
	mx.HandleFunc("/file", y.createSecret).Methods("POST")
	mx.HandleFunc("/file/{key:(?:[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})}", y.getSecret)
	mx.PathPrefix("/").Handler(http.FileServer(http.Dir("public")))
	return handlers.LoggingHandler(os.Stdout, mx)
}

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
