package yopass

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type mockDB struct{}

func (db *mockDB) Get(key string) (string, error) {
	return "***ENCRYPTED***", nil
}
func (db *mockDB) Put(key, value string, expiration int32) error {
	return nil
}
func (db *mockDB) Delete(key string) error {
	return nil
}

type mockBrokenDB struct{}

func (db *mockBrokenDB) Get(key string) (string, error) {
	return "", fmt.Errorf("Some error")
}
func (db *mockBrokenDB) Put(key, value string, expiration int32) error {
	return fmt.Errorf("Some error")
}
func (db *mockBrokenDB) Delete(key string) error {
	return fmt.Errorf("Some error")
}

type mockBrokenDB2 struct{}

func (db *mockBrokenDB2) Get(key string) (string, error) {
	return "", nil
}
func (db *mockBrokenDB2) Put(key, value string, expiration int32) error {
	return fmt.Errorf("Some error")
}
func (db *mockBrokenDB2) Delete(key string) error {
	return fmt.Errorf("Some error")
}

var (
	db1                  = new(mockDB)
	brokenDB             = new(mockBrokenDB)
	brokenDBfailedDelete = new(mockBrokenDB2)
	response             struct {
		Message string `json:"message"`
	}
)

func TestCreateSecret(t *testing.T) {
	tt := []struct {
		name       string
		statusCode int
		body       io.Reader
		output     string
		db         Database
	}{
		{
			name:       "validRequest",
			statusCode: 200,
			body:       strings.NewReader(`{"secret": "hello world", "expiration": 3600}`),
			output:     "",
			db:         db1,
		},
		{
			name:       "invalid json",
			statusCode: 400,
			body:       strings.NewReader(`{fooo`),
			output:     "Unable to parse json",
			db:         db1,
		},
		{
			name:       "message too long",
			statusCode: 400,
			body:       strings.NewReader(`{"expiration": 3600, "secret": "` + strings.Join(make([]string, 12000), "x") + `"}`),
			output:     "Message is too long",
			db:         db1,
		},
		{
			name:       "invalid expiration",
			statusCode: 400,
			body:       strings.NewReader(`{"expiration": 10, "secret": "foo"}`),
			output:     "Invalid expiration specified",
			db:         db1,
		},
		{
			name:       "broken database",
			statusCode: 500,
			body:       strings.NewReader(`{"expiration": 3600, "secret": "foo"}`),
			output:     "Failed to store secret in database",
			db:         brokenDB,
		},
	}

	for _, tc := range tt {
		t.Run(fmt.Sprintf(tc.name), func(t *testing.T) {
			req, _ := http.NewRequest("POST", "/secret", tc.body)
			rr := httptest.NewRecorder()
			CreateSecret(rr, req, tc.db)
			json.Unmarshal(rr.Body.Bytes(), &response)
			if tc.output != "" {
				if response.Message != tc.output {
					t.Fatalf(`Expected body "%s"; got "%s"`, tc.output, response.Message)
				}
			}
			if rr.Code != tc.statusCode {
				t.Fatalf(`Expected status code %d; got "%d"`, tc.statusCode, rr.Code)
			}
		})
	}
}

func TestGetSecret(t *testing.T) {
	tt := []struct {
		name       string
		statusCode int
		output     string
		db         Database
	}{
		{
			name:       "Get Secret",
			statusCode: 200,
			output:     "***ENCRYPTED***",
			db:         db1,
		},
		{
			name:       "Secret not found",
			statusCode: 404,
			output:     "Secret not found",
			db:         brokenDB,
		},
		{
			name:       "Failed to clear secret",
			statusCode: 500,
			output:     "Failed to clear secret",
			db:         brokenDBfailedDelete,
		},
	}

	for _, tc := range tt {
		t.Run(fmt.Sprintf(tc.name), func(t *testing.T) {
			req, err := http.NewRequest("GET", "/secret/foo", nil)
			if err != nil {
				t.Fatal(err)
			}
			rr := httptest.NewRecorder()
			GetSecret(rr, req, tc.db)

			json.Unmarshal(rr.Body.Bytes(), &response)
			if response.Message != tc.output {
				t.Fatalf(`Expected body "%s"; got "%s"`, tc.output, response.Message)
			}
			if rr.Code != tc.statusCode {
				t.Fatalf(`Expected status code %d; got "%d"`, tc.statusCode, rr.Code)
			}
		})
	}
}
