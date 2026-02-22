package server

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jhaals/yopass/pkg/yopass"
)

// mockDBWithCapture captures the secret that was stored
type mockDBWithCapture struct {
	capturedSecret yopass.Secret
}

func (db *mockDBWithCapture) Get(key string) (yopass.Secret, error) {
	return db.capturedSecret, nil
}

func (db *mockDBWithCapture) Put(key string, secret yopass.Secret) error {
	db.capturedSecret = secret
	return nil
}

func (db *mockDBWithCapture) Delete(key string) (bool, error) {
	return true, nil
}

func (db *mockDBWithCapture) Exists(key string) (bool, error) {
	return true, nil
}

func (db *mockDBWithCapture) Status(key string) (bool, error) {
	return db.capturedSecret.OneTime, nil
}

func TestForceExpiration(t *testing.T) {
	validPGPMessage := `-----BEGIN PGP MESSAGE-----
Version: OpenPGP.js v4.10.8
Comment: https://openpgpjs.org

wy4ECQMIRthQ3aO85NvgAfASIX3dTwsFVt0gshPu7n1tN05e8rpqxOk6PYNm
xtt90k4BqHuTCLNlFRJjuiuE8zdIc+j5zTN5zihxUReVqokeqULLOx2FBMHZ
sbfqaG/iDbp+qDOc98IagMyPrEqKDxnhVVOraXy5dD9RDsntLso=
=0vwU
-----END PGP MESSAGE-----`

	tt := []struct {
		name            string
		statusCode      int
		body            io.Reader
		output          string
		forceExpiration int32
		requestedExp    int32
		expectedExp     int32
	}{
		{
			name:            "client requests 1 day but max is 1 hour - rejected",
			statusCode:      400,
			body:            strings.NewReader(fmt.Sprintf(`{"message": "%s", "expiration": 86400}`, strings.ReplaceAll(validPGPMessage, "\n", "\\n"))),
			output:          "Expiration exceeds server maximum",
			forceExpiration: 3600,
			requestedExp:    86400,
			expectedExp:     0,
		},
		{
			name:            "client requests 1 hour with max 1 day - allowed",
			statusCode:      200,
			body:            strings.NewReader(fmt.Sprintf(`{"message": "%s", "expiration": 3600}`, strings.ReplaceAll(validPGPMessage, "\n", "\\n"))),
			output:          "",
			forceExpiration: 86400,
			requestedExp:    3600,
			expectedExp:     3600,
		},
		{
			name:            "client requests 1 day with max 1 day - allowed",
			statusCode:      200,
			body:            strings.NewReader(fmt.Sprintf(`{"message": "%s", "expiration": 86400}`, strings.ReplaceAll(validPGPMessage, "\n", "\\n"))),
			output:          "",
			forceExpiration: 86400,
			requestedExp:    86400,
			expectedExp:     86400,
		},
		{
			name:            "client requests 1 hour with max 1 week - allowed",
			statusCode:      200,
			body:            strings.NewReader(fmt.Sprintf(`{"message": "%s", "expiration": 3600}`, strings.ReplaceAll(validPGPMessage, "\n", "\\n"))),
			output:          "",
			forceExpiration: 604800,
			requestedExp:    3600,
			expectedExp:     3600,
		},
		{
			name:            "no force expiration - client value 1 hour preserved",
			statusCode:      200,
			body:            strings.NewReader(fmt.Sprintf(`{"message": "%s", "expiration": 3600}`, strings.ReplaceAll(validPGPMessage, "\n", "\\n"))),
			output:          "",
			forceExpiration: 0,
			requestedExp:    3600,
			expectedExp:     3600,
		},
		{
			name:            "no force expiration - client value 1 day preserved",
			statusCode:      200,
			body:            strings.NewReader(fmt.Sprintf(`{"message": "%s", "expiration": 86400}`, strings.ReplaceAll(validPGPMessage, "\n", "\\n"))),
			output:          "",
			forceExpiration: 0,
			requestedExp:    86400,
			expectedExp:     86400,
		},
		{
			name:            "no force expiration - client value 1 week preserved",
			statusCode:      200,
			body:            strings.NewReader(fmt.Sprintf(`{"message": "%s", "expiration": 604800}`, strings.ReplaceAll(validPGPMessage, "\n", "\\n"))),
			output:          "",
			forceExpiration: 0,
			requestedExp:    604800,
			expectedExp:     604800,
		},
		{
			name:            "invalid force expiration value",
			statusCode:      500,
			body:            strings.NewReader(fmt.Sprintf(`{"message": "%s", "expiration": 3600}`, strings.ReplaceAll(validPGPMessage, "\n", "\\n"))),
			output:          "Server misconfiguration",
			forceExpiration: 999,
			requestedExp:    3600,
			expectedExp:     0,
		},
	}

	for _, tc := range tt {
		t.Run(tc.name, func(t *testing.T) {
			db := &mockDBWithCapture{}

			req, _ := http.NewRequest("POST", "/secret", tc.body)
			rr := httptest.NewRecorder()
			y := newTestServerWithExpiration(t, db, 10000, false, tc.forceExpiration)
			y.createSecret(rr, req)

			if rr.Code != tc.statusCode {
				t.Fatalf(`Expected status code %d; got %d`, tc.statusCode, rr.Code)
			}

			if tc.output != "" {
				var response struct {
					Message string `json:"message"`
				}
				json.Unmarshal(rr.Body.Bytes(), &response)
				if response.Message != tc.output {
					t.Fatalf(`Expected error message "%s"; got "%s"`, tc.output, response.Message)
				}
			}

			// Verify that the expiration is respected based on the maximum
			if tc.statusCode == 200 {
				if db.capturedSecret.Expiration != tc.expectedExp {
					t.Fatalf(`Expected expiration to be %d; got %d`, tc.expectedExp, db.capturedSecret.Expiration)
				}
			}
		})
	}
}

func TestConfigEndpointWithForceExpiration(t *testing.T) {
	tt := []struct {
		name            string
		forceExpiration int32
		expectInConfig  bool
	}{
		{
			name:            "force expiration is set to 3600",
			forceExpiration: 3600,
			expectInConfig:  true,
		},
		{
			name:            "force expiration is set to 86400",
			forceExpiration: 86400,
			expectInConfig:  true,
		},
		{
			name:            "force expiration is not set",
			forceExpiration: 0,
			expectInConfig:  false,
		},
	}

	for _, tc := range tt {
		t.Run(tc.name, func(t *testing.T) {
			req, _ := http.NewRequest("GET", "/config", nil)
			rr := httptest.NewRecorder()
			y := newTestServerWithExpiration(t, &mockDB{}, 10000, false, tc.forceExpiration)
			y.configHandler(rr, req)

			if rr.Code != 200 {
				t.Fatalf(`Expected status code 200; got %d`, rr.Code)
			}

			var config map[string]interface{}
			json.Unmarshal(rr.Body.Bytes(), &config)

			if tc.expectInConfig {
				val, exists := config["FORCE_EXPIRATION"]
				if !exists {
					t.Fatal("Expected FORCE_EXPIRATION to be in config, but it was not found")
				}
				// JSON unmarshaling converts int32 to float64
				if int32(val.(float64)) != tc.forceExpiration {
					t.Fatalf(`Expected FORCE_EXPIRATION to be %d; got %v`, tc.forceExpiration, val)
				}
			} else {
				_, exists := config["FORCE_EXPIRATION"]
				if exists {
					t.Fatal("Expected FORCE_EXPIRATION to not be in config, but it was found")
				}
			}
		})
	}
}
