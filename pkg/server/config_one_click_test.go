package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestConfigDisableOneClickLink(t *testing.T) {
	for _, disabled := range []bool{false, true} {
		s := newTestServer(t, newMockDB(), 1000, false)
		s.DisableOneClickLink = disabled
		w := httptest.NewRecorder()
		s.configHandler(w, httptest.NewRequest(http.MethodGet, "/config", nil))
		var config map[string]interface{}
		if err := json.Unmarshal(w.Body.Bytes(), &config); err != nil {
			t.Fatal(err)
		}
		if config["DISABLE_ONE_CLICK_LINK"] != disabled {
			t.Fatalf("DISABLE_ONE_CLICK_LINK: got %v, want %v", config["DISABLE_ONE_CLICK_LINK"], disabled)
		}
	}
}
