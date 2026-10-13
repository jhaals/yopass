package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestConfigHandler_HideAppName(t *testing.T) {
	for _, tc := range []struct {
		name    string
		license LicenseStatus
		hide    bool
		want    bool
	}{
		{"licensed enabled", LicenseStatus{Valid: true, ExpiresAt: time.Now().Add(time.Hour)}, true, true},
		{"licensed default", LicenseStatus{Valid: true, ExpiresAt: time.Now().Add(time.Hour)}, false, false},
		{"unlicensed", LicenseStatus{}, true, false},
		{"expired", LicenseStatus{Valid: true, ExpiresAt: time.Now().Add(-time.Hour)}, true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := newTestServer(t, newMockDB(), 1, false)
			s.License = tc.license
			s.HideAppName = tc.hide
			s.AppName = "Acme Secrets"
			s.LogoURL = "/custom.svg"
			w := httptest.NewRecorder()
			s.configHandler(w, httptest.NewRequest(http.MethodGet, "/config", nil))
			var cfg map[string]interface{}
			if err := json.NewDecoder(w.Result().Body).Decode(&cfg); err != nil {
				t.Fatal(err)
			}
			if tc.want {
				if cfg["HIDE_APP_NAME"] != true {
					t.Errorf("HIDE_APP_NAME: got %v, want true", cfg["HIDE_APP_NAME"])
				}
				if cfg["APP_NAME"] != s.AppName || cfg["LOGO_URL"] != s.LogoURL {
					t.Errorf("hiding the name must preserve branding: %v", cfg)
				}
			} else if _, ok := cfg["HIDE_APP_NAME"]; ok {
				t.Errorf("HIDE_APP_NAME should be absent: %v", cfg["HIDE_APP_NAME"])
			}
		})
	}
}

func TestConfigHandler_NoThemeSwitcher(t *testing.T) {
	for _, disabled := range []bool{false, true} {
		s := newTestServer(t, newMockDB(), 1, false)
		s.NoThemeSwitcher = disabled
		w := httptest.NewRecorder()
		s.configHandler(w, httptest.NewRequest(http.MethodGet, "/config", nil))
		var cfg map[string]interface{}
		if err := json.NewDecoder(w.Result().Body).Decode(&cfg); err != nil {
			t.Fatal(err)
		}
		if cfg["NO_THEME_SWITCHER"] != disabled {
			t.Errorf("NO_THEME_SWITCHER: got %v, want %v", cfg["NO_THEME_SWITCHER"], disabled)
		}
	}
}
