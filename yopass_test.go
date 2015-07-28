package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
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
	Key     string
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
		t.Errorf("Response code is %v, should be 404", response.Code)
	}
	resp := apiResponse{}
	json.Unmarshal(response.Body.Bytes(), &resp)
	expected := "Secret not found"
	if resp.Message != expected {
		t.Errorf("Response is %s should be '%s'", response.Body, expected)
	}
}

type stubFailDB struct {
	Database
}

func (stubFailDB) Get(key string) (string, error) {
	return "", errors.New("terrible failure")
}

func (stubFailDB) Set(key string, value string, expiration int32) error {
	return errors.New("terrible failure")
}

func TestGetFailure(t *testing.T) {
	request, _ := http.NewRequest("GET", "/secret/73a6d946-2ee2-11e5-b8f9-0242ac110006", nil)
	response := httptest.NewRecorder()

	getHandler(response, request, new(stubFailDB))

	if response.Code != http.StatusInternalServerError {
		t.Errorf("Response code is %v, should be 500", response.Code)
	}
	resp := apiResponse{}
	json.Unmarshal(response.Body.Bytes(), &resp)
	expected := "Unable to receive secret from database"
	if resp.Message != expected {
		t.Errorf("Response is %s should be '%s'", response.Body, expected)
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

func (stubDB) Set(key string, value string, expiration int32) error {
	return nil
}

func TestGetSuccess(t *testing.T) {
	request, _ := http.NewRequest("GET", "/secret/73a6d946-2ee2-11e5-b8f9-0242ac110006", nil)
	response := httptest.NewRecorder()

	getHandler(response, request, new(stubDB))

	if response.Code != http.StatusOK {
		t.Errorf("Response code is %v, should be 200", response.Code)
	}
	resp := apiResponse{}
	json.Unmarshal(response.Body.Bytes(), &resp)
	expected := "OK"
	if resp.Message != expected {
		t.Errorf("message is %s should be '%s'", response.Body, expected)
	}
	expectedSecret := `=AKJF7\sKJFVUA==`
	if resp.Secret != expectedSecret {
		t.Errorf("secret is %s should be '%s'", resp.Secret, expectedSecret)
	}
}

func TestPostSecret(t *testing.T) {
	body := strings.NewReader(`{"expiration": 3600, "secret": "so secret"}`)
	request, _ := http.NewRequest("POST", "/secret", body)
	response := httptest.NewRecorder()
	saveHandler(response, request, new(stubDB))

	if response.Code != http.StatusOK {
		t.Errorf("Response code is %v, should be 200", response.Code)
	}

	resp := apiResponse{}
	json.Unmarshal(response.Body.Bytes(), &resp)
	expected := "secret stored"
	if resp.Message != expected {
		t.Errorf("message is %s should be '%s'", response.Body, expected)
	}
}

func TestGetRequestToPostEndpoint(t *testing.T) {
	request, _ := http.NewRequest("GET", "/secret", nil)
	response := httptest.NewRecorder()
	saveHandler(response, request, new(stubDB))

	if response.Code != http.StatusBadRequest {
		t.Errorf("Response code is %v, should be 400", response.Code)
	}

	resp := apiResponse{}
	json.Unmarshal(response.Body.Bytes(), &resp)
	expected := "Bad Request, see https://github.com/jhaals/yopass for more info"
	if resp.Message != expected {
		t.Errorf("message is %s should be '%s'", response.Body, expected)
	}
}

func TestBadJSON(t *testing.T) {
	body := strings.NewReader(`{invalid json}`)
	request, _ := http.NewRequest("POST", "/secret", body)
	response := httptest.NewRecorder()
	saveHandler(response, request, new(stubDB))

	if response.Code != http.StatusBadRequest {
		t.Errorf("Response code is %v, should be 400", response.Code)
	}

	resp := apiResponse{}
	json.Unmarshal(response.Body.Bytes(), &resp)
	expected := "Unable to parse json"
	if resp.Message != expected {
		t.Errorf("message is %s should be '%s'", response.Body, expected)
	}
}

func TestInvalidExpiration(t *testing.T) {
	body := strings.NewReader(`{"expiration": 1337, "secret": "so secret"}`)
	request, _ := http.NewRequest("POST", "/secret", body)
	response := httptest.NewRecorder()
	saveHandler(response, request, new(stubDB))

	if response.Code != http.StatusBadRequest {
		t.Errorf("Response code is %v, should be 400", response.Code)
	}

	resp := apiResponse{}
	json.Unmarshal(response.Body.Bytes(), &resp)
	expected := "Invalid expiration specified"
	if resp.Message != expected {
		t.Errorf("message is %s should be '%s'", response.Body, expected)
	}
}

func TestTooLongMessage(t *testing.T) {
	body := strings.NewReader(`{"expiration": 3600, "secret": "` + strings.Join(make([]string, 12000), "x") + `"}`)
	request, _ := http.NewRequest("POST", "/secret", body)
	response := httptest.NewRecorder()
	saveHandler(response, request, new(stubDB))

	if response.Code != http.StatusBadRequest {
		t.Errorf("Response code is %v, should be 400", response.Code)
	}

	resp := apiResponse{}
	json.Unmarshal(response.Body.Bytes(), &resp)
	expected := "Message is too long"
	if resp.Message != expected {
		t.Errorf("message is %s should be '%s'", response.Body, expected)
	}
}

func TestFailToSave(t *testing.T) {
	body := strings.NewReader(`{"expiration": 3600, "secret": "fo"}`)
	request, _ := http.NewRequest("POST", "/secret", body)
	response := httptest.NewRecorder()
	saveHandler(response, request, new(stubFailDB))

	if response.Code != http.StatusInternalServerError {
		t.Errorf("Response code is %v, should be 500", response.Code)
	}

	resp := apiResponse{}
	json.Unmarshal(response.Body.Bytes(), &resp)
	expected := "Failed to store secret in database"
	if resp.Message != expected {
		t.Errorf("message is %s should be '%s'", response.Body, expected)
	}
}
