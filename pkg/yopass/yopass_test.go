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
	return `{"message": "***ENCRYPTED***"}`, nil
}
func (db *mockDB) Put(key, value string, expiration int32) error {
	return nil
}
func (db *mockDB) Delete(key string) error {
	return nil
}

type brokenDB struct{}

func (db *brokenDB) Get(key string) (string, error) {
	return "", fmt.Errorf("Some error")
}
func (db *brokenDB) Put(key, value string, expiration int32) error {
	return fmt.Errorf("Some error")
}
func (db *brokenDB) Delete(key string) error {
	return fmt.Errorf("Some error")
}

type mockBrokenDB2 struct{}

func (db *mockBrokenDB2) Get(key string) (string, error) {
	return `{"one_time": true, "message": "encrypted"}`, nil
}
func (db *mockBrokenDB2) Put(key, value string, expiration int32) error {
	return fmt.Errorf("Some error")
}
func (db *mockBrokenDB2) Delete(key string) error {
	return fmt.Errorf("Some error")
}

func TestCreateSecret(t *testing.T) {
	tt := []struct {
		name       string
		statusCode int
		body       io.Reader
		output     string
		db         Database
		maxLength  int
	}{
		{
			name:       "validRequest",
			statusCode: 200,
			body:       strings.NewReader(`{"message": "hello world", "expiration": 3600}`),
			output:     "",
			db:         &mockDB{},
			maxLength:  100,
		},
		{
			name:       "invalid json",
			statusCode: 400,
			body:       strings.NewReader(`{fooo`),
			output:     "Unable to parse json",
			db:         &mockDB{},
		},
		{
			name:       "message too long",
			statusCode: 400,
			body:       strings.NewReader(`{"expiration": 3600, "message": "wooop"}`),
			output:     "The encrypted message is too long",
			db:         &mockDB{},
			maxLength:  1,
		},
		{
			name:       "invalid expiration",
			statusCode: 400,
			body:       strings.NewReader(`{"expiration": 10, "message": "foo"}`),
			output:     "Invalid expiration specified",
			db:         &mockDB{},
		},
		{
			name:       "broken database",
			statusCode: 500,
			body:       strings.NewReader(`{"expiration": 3600, "message": "foo"}`),
			output:     "Failed to store secret in database",
			db:         &brokenDB{},
			maxLength:  100,
		},
	}

	for _, tc := range tt {
		t.Run(fmt.Sprintf(tc.name), func(t *testing.T) {
			req, _ := http.NewRequest("POST", "/secret", tc.body)
			rr := httptest.NewRecorder()
			y := New(tc.db, tc.maxLength)
			y.createSecret(rr, req)
			var s secret
			json.Unmarshal(rr.Body.Bytes(), &s)
			if tc.output != "" {
				if s.Message != tc.output {
					t.Fatalf(`Expected body "%s"; got "%s"`, tc.output, s.Message)
				}
			}
			if rr.Code != tc.statusCode {
				t.Fatalf(`Expected status code %d; got "%d"`, tc.statusCode, rr.Code)
			}
		})
	}
}

type deleteDB struct{}

func (db *deleteDB) Get(key string) (string, error) {
	return `{"one_time": true, "message": "encrypted"}`, nil
}
func (db *deleteDB) Put(key, value string, expiration int32) error {
	return nil
}
func (db *deleteDB) Delete(key string) error {
	return fmt.Errorf("Some error")
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
			db:         &mockDB{},
		},
		{
			name:       "Secret not found",
			statusCode: 404,
			output:     "Secret not found",
			db:         &brokenDB{},
		},
		{
			name:       "Failed to clear secret",
			statusCode: 500,
			output:     "Failed to clear secret",
			db:         &mockBrokenDB2{},
		},
		{
			name:       "Onetime",
			statusCode: 500,
			output:     "Failed to clear secret",
			db:         &deleteDB{},
		},
	}

	for _, tc := range tt {
		t.Run(fmt.Sprintf(tc.name), func(t *testing.T) {
			req, err := http.NewRequest("GET", "/secret/foo", nil)
			if err != nil {
				t.Fatal(err)
			}
			rr := httptest.NewRecorder()
			y := New(tc.db, 1)
			y.getSecret(rr, req)
			var s secret
			json.Unmarshal(rr.Body.Bytes(), &s)
			if s.Message != tc.output {
				t.Fatalf(`Expected body "%s"; got "%s"`, tc.output, s.Message)
			}
			if rr.Code != tc.statusCode {
				t.Fatalf(`Expected status code %d; got "%d"`, tc.statusCode, rr.Code)
			}
		})
	}
}
