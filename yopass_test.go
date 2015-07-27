package main

import (
	"encoding/json"
	"errors"
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
	Secret  string
}

type stubNotFoundDB struct {
	Database
}

func (stubNotFoundDB) Get(key string) (string, error) {
	return "", errors.New("memcache: cache miss")
}

func TestMessageNotFoundInMemcached(t *testing.T) {
	request, _ := http.NewRequest("GET", "/secret/73a6d946-2ee2-11e5-b8f9-0242ac110006", nil)
	response := httptest.NewRecorder()

	getHandler(response, request, new(stubNotFoundDB))

	if response.Code != http.StatusNotFound {
		t.Fatalf("Response code is %v, should be 404", response.Code)
	}
	resp := apiResponse{}
	json.Unmarshal(response.Body.Bytes(), &resp)
	expected := "Secret not found"
	if resp.Message != expected {
		t.Fatalf("Response is %s should be '%s'", response.Body, expected)
	}
}

type stubFailDB struct {
	Database
}

func (stubFailDB) Get(key string) (string, error) {
	return "", errors.New("terrible failure")
}

func TestGetFailure(t *testing.T) {
	request, _ := http.NewRequest("GET", "/secret/73a6d946-2ee2-11e5-b8f9-0242ac110006", nil)
	response := httptest.NewRecorder()

	getHandler(response, request, new(stubFailDB))

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

type stubDB struct {
	Database
}

func (stubDB) Get(key string) (string, error) {
	return `=AKJF7\sKJFVUA==`, nil
}
func (stubDB) Delete(key string) error {
	return nil
}

func TestGetSuccess(t *testing.T) {
	request, _ := http.NewRequest("GET", "/secret/73a6d946-2ee2-11e5-b8f9-0242ac110006", nil)
	response := httptest.NewRecorder()

	getHandler(response, request, new(stubDB))

	if response.Code != http.StatusOK {
		t.Fatalf("Response code is %v, should be 200", response.Code)
	}
	resp := apiResponse{}
	json.Unmarshal(response.Body.Bytes(), &resp)
	expected := "OK"
	if resp.Message != expected {
		t.Fatalf("message is %s should be '%s'", response.Body, expected)
	}
	expectedSecret := `=AKJF7\sKJFVUA==`
	if resp.Secret != expectedSecret {
		t.Fatalf("secret is %s should be '%s'", resp.Secret, expectedSecret)
	}
}
