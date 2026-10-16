package server

import (
	"net/http"
	"net/url"
	"strings"
)

// normalizeOrigin parses a URL or Origin value and returns scheme://host with
// default ports stripped and the host lowercased, matching browser behavior.
// Uses url.URL.Hostname/Port instead of net.SplitHostPort so IPv6 brackets
// are preserved (e.g. https://[::1] stays valid).
func normalizeOrigin(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return strings.ToLower(raw)
	}
	host := strings.ToLower(u.Hostname())
	port := u.Port()
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	if port != "" && !((u.Scheme == "http" && port == "80") || (u.Scheme == "https" && port == "443")) {
		host += ":" + port
	}
	return u.Scheme + "://" + host
}

// Cookie authority belongs to the frontend, including for consuming GETs.
func (y *Server) fromForeignOrigin(r *http.Request) bool {
	if r.Method == http.MethodGet && r.Header.Get("Sec-Fetch-Mode") == "navigate" {
		return true
	}
	if origin := r.Header.Get("Origin"); origin != "" {
		allowed := y.FrontendURL
		if allowed == "" {
			scheme := "http"
			if y.isSecure(r) {
				scheme = "https"
			}
			allowed = scheme + "://" + r.Host
		}
		if normalizeOrigin(origin) != normalizeOrigin(allowed) {
			return true
		}
		if y.FrontendURL != "" {
			return false
		}
	}
	switch r.Header.Get("Sec-Fetch-Site") {
	case "", "same-origin", "none":
		return false
	default:
		return true
	}
}

// corsMiddleware returns a middleware which sets CORS headers on all responses
// and rejects cross-origin state-changing requests whose Origin does not match
// the configured frontend URL (CSRF protection for split-origin deployments).
func (y *Server) corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if y.FrontendURL != "" {
			// Browsers send Origin as scheme://host (no path), so normalize
			// to scheme://lowercase-host with default ports stripped.
			allowedOrigin := normalizeOrigin(y.FrontendURL)

			// Reject state-changing requests with a mismatched Origin header.
			// Cookie-based authority is separately checked in getSession, including
			// consuming GETs and requests without an Origin header.
			if origin := r.Header.Get("Origin"); origin != "" && r.Method != http.MethodGet && r.Method != http.MethodHead && r.Method != http.MethodOptions {
				if normalizeOrigin(origin) != allowedOrigin {
					http.Error(w, "origin not allowed", http.StatusForbidden)
					return
				}
			}

			w.Header().Set("Access-Control-Allow-Origin", allowedOrigin)
			w.Header().Set("Access-Control-Allow-Credentials", "true")
			w.Header().Add("Vary", "Origin")
		} else {
			w.Header().Set("Access-Control-Allow-Origin", y.CORSAllowOrigin)
		}
		next.ServeHTTP(w, r)
	})
}

// SecurityHeadersHandler returns a middleware which sets common security
// HTTP headers on the response to mitigate common web vulnerabilities.
// extraImgSrc extends the img-src CSP directive with additional allowed origins.
// WebAssembly compilation is required to decrypt existing Argon2 messages,
// regardless of the current encryption setting. The boolean argument is kept
// for caller compatibility; it does not control decryption capabilities.
func SecurityHeadersHandler(extraImgSrc []string, _ bool, next http.Handler) http.Handler {
	imgSrc := append([]string{"'self'", "data:"}, extraImgSrc...)
	scriptSrc := "script-src 'self' 'wasm-unsafe-eval'"
	csp := []string{
		"default-src 'self'",
		"font-src 'self' data:",
		"form-action 'self'",
		"frame-ancestors 'none'",
		"img-src " + strings.Join(imgSrc, " "),
		scriptSrc,
		"style-src 'self' 'unsafe-inline'",
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-security-policy", strings.Join(csp, "; "))
		w.Header().Set("referrer-policy", "no-referrer")
		w.Header().Set("x-content-type-options", "nosniff")
		w.Header().Set("x-frame-options", "DENY")
		w.Header().Set("x-xss-protection", "1; mode=block")
		if r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https" {
			w.Header().Set("strict-transport-security", "max-age=31536000")
		}
		next.ServeHTTP(w, r)
	})
}
