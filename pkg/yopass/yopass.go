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

type secret struct {
	Expiration int32  `json:"expiration,omitempty"`
	Message    string `json:"message"`
	OneTime    bool   `json:"one_time,omitempty"`
}

// createSecret creates secret
func (y *Yopass) createSecret(w http.ResponseWriter, request *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")

	decoder := json.NewDecoder(request.Body)
	var s secret
	if err := decoder.Decode(&s); err != nil {
		http.Error(w, `{"message": "Unable to parse json"}`, http.StatusBadRequest)
		return
	}

	if !validExpiration(s.Expiration) {
		http.Error(w, `{"message": "Invalid expiration specified"}`, http.StatusBadRequest)
		return
	}

	if len(s.Message) > y.maxLength {
		http.Error(w, `{"message": "The encrypted message is too long"}`, http.StatusBadRequest)
		return
	}

	// Generate new UUID and store secret in memcache with specified expiration.
	key := uuid.NewV4().String()
	// Store secret json in database.
	se, err := json.Marshal(s)
	if err != nil {
		http.Error(w, `{"message": "Failed to encode secret"}`, http.StatusBadRequest)
		return
	}

	if err := y.db.Put(key, string(se), s.Expiration); err != nil {
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

	data, err := y.db.Get(mux.Vars(request)["key"])
	if err != nil {
		http.Error(w, `{"message": "Secret not found"}`, http.StatusNotFound)
		return
	}

	var s secret
	if err := json.Unmarshal([]byte(data), &s); err != nil {
		http.Error(w, `{"message": "Failed to decode secret"}`, http.StatusNotFound)
		return
	}

	if s.OneTime {
		if err := y.db.Delete(mux.Vars(request)["key"]); err != nil {
			http.Error(w, `{"message": "Failed to clear secret"}`, http.StatusInternalServerError)
			return
		}
	}

	resp, err := json.Marshal(s)
	if err != nil {
		http.Error(w, `{"message": "Failed to encode secret"}`, http.StatusBadRequest)
		return
	}
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
