package server

import (
	"io"
	"net"
	"net/http"
	"strings"

	"github.com/gorilla/handlers"
	"go.uber.org/zap"
)

// getRealClientIP returns the real client IP address. When the request comes
// from a trusted proxy the first IP in X-Forwarded-For is used; otherwise
// RemoteAddr is used directly to prevent spoofing.
func (s *Server) getRealClientIP(req *http.Request) string {
	remoteIP, _, err := net.SplitHostPort(req.RemoteAddr)
	if err != nil {
		remoteIP = req.RemoteAddr
	}

	if len(s.TrustedProxies) == 0 || !s.isTrustedProxy(remoteIP) {
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
func (s *Server) isTrustedProxy(remoteIP string) bool {
	for _, proxy := range s.TrustedProxies {
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

// httpLogFormatter returns a logging formatter that uses the real client IP,
// resolving X-Forwarded-For only when the request comes from a trusted proxy.
func (s *Server) httpLogFormatter() func(io.Writer, handlers.LogFormatterParams) {
	logger := s.Logger
	if logger == nil {
		logger = zap.NewNop()
	}

	return func(_ io.Writer, params handlers.LogFormatterParams) {
		req := params.Request
		if req == nil {
			logger.Error("Unable to log request: no request in params",
				zap.Reflect("LogFormatterParams", params),
			)
			return
		}

		uri := req.RequestURI
		// HTTP/2 CONNECT uses the authority field instead of a request URI.
		if req.ProtoMajor == 2 && req.Method == "CONNECT" {
			uri = req.Host
		}
		if uri == "" {
			uri = params.URL.RequestURI()
		}

		logger.Info("Request handled",
			zap.String("host", s.getRealClientIP(req)),
			zap.Time("timestamp", params.TimeStamp),
			zap.String("method", req.Method),
			zap.String("uri", uri),
			zap.String("protocol", req.Proto),
			zap.Int("responseStatus", params.StatusCode),
			zap.Int("responseSize", params.Size),
		)
	}
}
