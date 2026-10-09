package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestConfigCheckboxDefaults(t *testing.T) {
	for _, oneTime := range []*bool{nil, boolPointer(false), boolPointer(true)} {
		for _, receipt := range []bool{false, true} {
			y := newTestServer(t, newMockDB(), 1000, false)
			y.DefaultOneTimeSecrets = oneTime
			y.DefaultReadReceipt = receipt
			w := httptest.NewRecorder()
			y.configHandler(w, httptest.NewRequest(http.MethodGet, "/config", nil))
			var config map[string]interface{}
			if err := json.Unmarshal(w.Body.Bytes(), &config); err != nil {
				t.Fatal(err)
			}
			if config["DEFAULT_ONETIME_SECRETS"] != (oneTime == nil || *oneTime) || config["DEFAULT_READ_RECEIPT"] != receipt {
				t.Fatalf("checkbox defaults not preserved: %v", config)
			}
			if config["READ_RECEIPTS"] != false || config["FORCE_ONETIME_SECRETS"] != false {
				t.Fatalf("checkbox defaults must not enable features or enforce policy: %v", config)
			}
		}
	}
}

func boolPointer(value bool) *bool { return &value }
