package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

const originList = "https://share.urlx.net,https://demo.urlx.net"

func TestAllowedOrigin(t *testing.T) {
	matchers, err := parseAllowedOrigins(originList)
	if err != nil {
		t.Fatalf("parseAllowedOrigins: %v", err)
	}

	tests := []struct {
		origin  string
		allowed bool
	}{
		{"https://share.urlx.net", true},
		{"https://demo.urlx.net", true},
		{"http://share.urlx.net", false},
		{"https://urlx.net", false},
		{"https://evil.example.com", false},
		{"https://share.urlx.net.evil.com", false},
		{"", false},
	}
	for _, tc := range tests {
		got := allowedOrigin(matchers, tc.origin)
		want := ""
		if tc.allowed {
			want = tc.origin
		}
		if got != want {
			t.Errorf("allowedOrigin(%q) = %q, want %q", tc.origin, got, want)
		}
	}
}

func TestWithCORS(t *testing.T) {
	matchers, err := parseAllowedOrigins(originList)
	if err != nil {
		t.Fatalf("parseAllowedOrigins: %v", err)
	}

	// Inner handler mimics the server's CORS middleware which sets a static
	// header during request handling; withCORS must override it.
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "")
		w.WriteHeader(http.StatusOK)
		if _, err := w.Write([]byte("ok")); err != nil {
			t.Errorf("write: %v", err)
		}
	})
	handler := withCORS(matchers, inner)

	t.Run("allowed origin is echoed", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/config", nil)
		req.Header.Set("Origin", "https://share.urlx.net")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "https://share.urlx.net" {
			t.Errorf("Access-Control-Allow-Origin = %q, want %q", got, "https://share.urlx.net")
		}
		if got := rec.Header().Get("Vary"); got != "Origin" {
			t.Errorf("Vary = %q, want %q", got, "Origin")
		}
	})

	t.Run("disallowed origin gets no header", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/config", nil)
		req.Header.Set("Origin", "https://evil.example.com")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		if _, ok := rec.Header()["Access-Control-Allow-Origin"]; ok {
			t.Errorf("Access-Control-Allow-Origin present, want absent")
		}
	})

	t.Run("preflight handler that never writes", func(t *testing.T) {
		// Mirrors the server's corsPreflight OPTIONS handlers, which set
		// headers and return without calling Write or WriteHeader.
		preflight := withCORS(matchers, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Access-Control-Allow-Origin", "")
			w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
		}))
		req := httptest.NewRequest(http.MethodOptions, "/secret/abc/receipt", nil)
		req.Header.Set("Origin", "https://share.urlx.net")
		rec := httptest.NewRecorder()
		preflight.ServeHTTP(rec, req)

		if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "https://share.urlx.net" {
			t.Errorf("Access-Control-Allow-Origin = %q, want %q", got, "https://share.urlx.net")
		}
		if got := rec.Header().Get("Access-Control-Allow-Methods"); got != "GET, OPTIONS" {
			t.Errorf("Access-Control-Allow-Methods = %q, want %q", got, "GET, OPTIONS")
		}
	})

	t.Run("preflight from disallowed origin gets no header", func(t *testing.T) {
		preflight := withCORS(matchers, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Access-Control-Allow-Origin", "")
		}))
		req := httptest.NewRequest(http.MethodOptions, "/secret/abc/receipt", nil)
		req.Header.Set("Origin", "https://evil.example.com")
		rec := httptest.NewRecorder()
		preflight.ServeHTTP(rec, req)

		if _, ok := rec.Header()["Access-Control-Allow-Origin"]; ok {
			t.Errorf("Access-Control-Allow-Origin present, want absent")
		}
	})

	t.Run("implicit WriteHeader via Write", func(t *testing.T) {
		plain := withCORS(matchers, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if _, err := w.Write([]byte("ok")); err != nil {
				t.Errorf("write: %v", err)
			}
		}))
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.Header.Set("Origin", "https://demo.urlx.net")
		rec := httptest.NewRecorder()
		plain.ServeHTTP(rec, req)

		if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "https://demo.urlx.net" {
			t.Errorf("Access-Control-Allow-Origin = %q, want %q", got, "https://demo.urlx.net")
		}
	})
}
