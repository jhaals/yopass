package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/bradfitz/gomemcache/memcache"
)

func TestValidExpiration(t *testing.T) {

	if !validExpiration(3600) {
		t.Errorf("3600 should be valid")
	}
	if validExpiration(1337) {
		t.Errorf("1337 seconds lifetime should not be valid")
	}
}

type apiResponse struct {
	Message string
}

func TestMessageNotFoundInMemcached(t *testing.T) {
	request, _ := http.NewRequest("GET", "/secret/73a6d946-2ee2-11e5-b8f9-0242ac110006", nil)
	response := httptest.NewRecorder()

	getHandler(response, request, memcache.New("TODO"))

	if response.Code != http.StatusInternalServerError {
		t.Fatalf("Response code is %v, should be 500", response.Code)
	}
	resp := apiResponse{}
	json.Unmarshal(response.Body.Bytes(), &resp)
	expected := "Unable to receive secret from database"
	if resp.Message != expected {
		t.Fatalf("Response is %s should be '%s'", response.Body, expected)
	}
}
