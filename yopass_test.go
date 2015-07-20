package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
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

func TestBadURL(t *testing.T) {
	request, _ := http.NewRequest("GET", "/v1/secret/", nil)
	response := httptest.NewRecorder()

	getHandler(response, request, "127.0.0.1")

	if response.Code != http.StatusBadRequest {
		t.Fatalf("Response code is %v, should be 400", response.Code)
	}

	resp := apiResponse{}
	json.Unmarshal(response.Body.Bytes(), &resp)
	expected := "Bad URL"
	if resp.Message != expected {
		t.Fatalf("Response is %s should be '%s'", response.Body, expected)
	}
}

func TestMessageNotFoundInMemcached(t *testing.T) {
	request, _ := http.NewRequest("GET", "/v1/secret/73a6d946-2ee2-11e5-b8f9-0242ac110006", nil)
	response := httptest.NewRecorder()

	getHandler(response, request, "127.0.0.1")

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
