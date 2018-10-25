package main

import (
	"net/http"
	"os"
	"context"
	"time"

	"github.com/gorilla/handlers"
	"github.com/gorilla/mux"
	"github.com/jhaals/yopass/pkg/yopass"

	"google.golang.org/appengine/memcache"
	"google.golang.org/appengine"
)

// memcached client
type memcached struct {
	ctx context.Context
}

// Get key in memcached
func (m memcached) Get(key string) (string, error) {
	r, err := memcache.Get(m.ctx, key)
	if err != nil {
		return "", err
	}
	return string(r.Value), nil
}

// Put key in memcached
func (m memcached) Put(key, value string, expiration int32) error {
	return memcache.Set(m.ctx, &memcache.Item{
		Key:   key,
		Value: []byte(value),
		Expiration: time.Duration(expiration) * time.Second,
		})
}

// Delete key from memcached
func (m memcached) Delete(key string) error {
	return memcache.Delete(m.ctx, key)
}


func main() {
	mx := mux.NewRouter()
	mx.HandleFunc("/secret/{key:(?:[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})}",
		func(w http.ResponseWriter, r *http.Request) {
			yopass.GetSecret(w, r, memcached{appengine.NewContext(r)})
		}).Methods("GET")
	mx.HandleFunc("/secret", func(w http.ResponseWriter, r *http.Request) {
		yopass.CreateSecret(w, r, memcached{appengine.NewContext(r)})
	}).Methods("POST")
	mx.PathPrefix("/").Handler(http.FileServer(http.Dir("public")))
	
	http.Handle("/", handlers.LoggingHandler(os.Stdout, mx))
	appengine.Main()
}
