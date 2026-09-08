package server

import (
	"io"
	"net"
	"net/http"
	"strings"

	"github.com/gorilla/handlers"
	"github.com/gorilla/mux"
	"go.uber.org/zap"
)

// getRealClientIP returns the real client IP address. When the request comes
// from a trusted proxy the first IP in X-Forwarded-For is used; otherwise
// RemoteAddr is used directly to prevent spoofing.
func (y *Server) getRealClientIP(req *http.Request) string {
	remoteIP, _, err := net.SplitHostPort(req.RemoteAddr)
	if err != nil {
		remoteIP = req.RemoteAddr
	}

	if len(y.TrustedProxies) == 0 || !y.isTrustedProxy(remoteIP) {
		return remoteIP
	}

	if xff := req.Header.Get("X-Forwarded-For"); xff != "" {
		ip, _, _ := strings.Cut(xff, ",")
		if ip = strings.TrimSpace(ip); net.ParseIP(ip) != nil {
			return ip
		}
	}
	return remoteIP
}

// isTrustedProxy reports whether remoteIP matches any entry in TrustedProxies.
func (y *Server) isTrustedProxy(remoteIP string) bool {
	for _, proxy := range y.TrustedProxies {
		if _, cidr, err := net.ParseCIDR(proxy); err == nil {
			if cidr.Contains(net.ParseIP(remoteIP)) {
				return true
			}
		} else if remoteIP == proxy {
			return true
		}
	}
	return false
}

// httpLogFormatter records route templates rather than request URLs: path keys
// are bearer capabilities and query strings may contain OIDC codes. Matching
// again is necessary because mux attaches route metadata to a request copy that
// the outer logging handler cannot see. Never fall back to the raw URL.
func (y *Server) httpLogFormatter(router *mux.Router) func(io.Writer, handlers.LogFormatterParams) {
	logger := y.Logger
	if logger == nil {
		logger = zap.NewNop()
	}

	return func(_ io.Writer, params handlers.LogFormatterParams) {
		req := params.Request
		if req == nil {
			logger.Error("Unable to log request: no request in params")
			return
		}

		uri := "unmatched"
		var secretID string
		var match mux.RouteMatch
		if router != nil && req.URL != nil && router.Match(req, &match) && match.Route != nil {
			if template, err := match.Route.GetPathTemplate(); err == nil {
				uri = strings.ReplaceAll(template, keyParameter, "{key}")
			}
			if key := match.Vars["key"]; key != "" {
				secretID = redactSecretID(key)
			}
		}

		fields := []zap.Field{
			zap.String("host", y.getRealClientIP(req)),
			zap.Time("timestamp", params.TimeStamp),
			zap.String("method", req.Method),
			zap.String("uri", uri),
			zap.String("protocol", req.Proto),
			zap.Int("responseStatus", params.StatusCode),
			zap.Int("responseSize", params.Size),
		}
		if secretID != "" {
			fields = append(fields, zap.String("secret_id", secretID))
		}
		logger.Info("Request handled", fields...)
	}
}
