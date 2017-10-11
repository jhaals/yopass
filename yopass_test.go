package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
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

type stubFailDB struct {
	Database
}

func (stubFailDB) Get(key string) (string, error) {
	return "", errors.New("terrible failure")
}

func (stubFailDB) Set(key string, value string, expiration int32) error {
	return errors.New("terrible failure")
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

func TestAPI(t *testing.T) {
	tt := []struct {
		name       string
		method     string
		url        string
		statusCode int
		message    string
		body       io.Reader
		database   Database
	}{
		// {
		// 	name:       "Get request to POST enpoint",
		// 	method:     "GET",
		// 	url:        "/secret",
		// 	statusCode: 400,
		// 	message:    "Bad Request, see https://github.com/jhaals/yopass for more info",
		// 	database:   new(stubDB)},
		{
			name:       "Message",
			method:     "GET",
			url:        "/secret/73a6d946-2ee2-11e5-b8f9-0242ac110006",
			statusCode: 200,
			message:    "OK",
			database:   new(stubDB)},
		{
			name:       "Message not found in memcached",
			method:     "GET",
			url:        "/secret/73a6d946-2ee2-11e5-b8f9-0242ac110006",
			statusCode: 404,
			message:    "Secret not found",
			database:   new(stubNotFoundDB)},
		{
			name:       "Failing database",
			method:     "GET",
			url:        "/secret/73a6d946-2ee2-11e5-b8f9-0242ac110006",
			statusCode: 500,
			message:    "Unable to receive secret from database",
			database:   new(stubFailDB)},
		{
			name:       "Store Secret",
			method:     "POST",
			url:        "/secret",
			statusCode: 200,
			body:       strings.NewReader(`{"expiration": 3600, "secret": "so secret"}`),
			message:    "secret stored",
			database:   new(stubDB)},
		{
			name:       "invalid JSON",
			method:     "POST",
			url:        "/secret",
			statusCode: 400,
			body:       strings.NewReader(`{invalid json}`),
			message:    "Unable to parse json",
			database:   new(stubDB)},
		{
			name:       "invalid expiration",
			method:     "POST",
			url:        "/secret",
			statusCode: 400,
			body:       strings.NewReader(`{"expiration": 1337, "secret": "so secret"}`),
			message:    "Invalid expiration specified",
			database:   new(stubDB)},
		{
			name:       "message too large",
			method:     "POST",
			url:        "/secret",
			statusCode: 400,
			body:       strings.NewReader(`{"expiration": 3600, "secret": "` + strings.Join(make([]string, 12000), "x") + `"}`),
			message:    "Message is too long",
			database:   new(stubDB)},
		{
			name:       "failed to save",
			method:     "POST",
			url:        "/secret",
			statusCode: 500,
			body:       strings.NewReader(`{"expiration": 3600, "secret": "fo"}`),
			message:    "Failed to store secret in database",
			database:   new(stubFailDB)},
		{
			name:       "message status",
			method:     "HEAD",
			url:        "/secret/73a6d946-2ee2-11e5-b8f9-0242ac110006",
			statusCode: 200,
			message:    "",
			database:   new(stubDB)},
		{
			name:       "message not found",
			method:     "HEAD",
			url:        "/secret/73a6d946-2ee2-11e5-b8f9-0242ac110006",
			statusCode: 404,
			message:    "",
			database:   new(stubNotFoundDB)},
		{
			name:       "check methods",
			method:     "OPTIONS",
			url:        "/secret",
			statusCode: 200,
			message:    "OK",
			database:   new(stubDB)},
	}

	for _, tc := range tt {
		t.Run(fmt.Sprintf("%s_%s", tc.method, tc.name), func(t *testing.T) {
			request, _ := http.NewRequest(tc.method, tc.url, tc.body)
			response := httptest.NewRecorder()
			switch tc.method {
			case "GET":
				getHandler(response, request, tc.database)
			case "POST":
				saveHandler(response, request, tc.database)
			case "OPTIONS":
				saveHandler(response, request, tc.database)
			case "HEAD":
				messageStatus(response, request, tc.database)
			}
			if response.Code != tc.statusCode {
				t.Errorf("Expected response code %d, got %v", tc.statusCode, response.Code)
			}
			if tc.message != "" {
				resp := apiResponse{}
				json.Unmarshal(response.Body.Bytes(), &resp)
				if resp.Message != tc.message {
					t.Errorf("Response is %s; expected %s", response.Body, tc.message)
				}
			}
		})
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
