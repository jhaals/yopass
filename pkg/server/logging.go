package server

import (
	"github.com/gorilla/handlers"
	"go.uber.org/zap"
	"io"
	"net"
	"net/http"
	"strings"
)

// getRealClientIP returns the real client IP address by checking X-Forwarded-For
// header only if the request comes from a trusted proxy, otherwise returns RemoteAddr
func (s *Server) getRealClientIP(req *http.Request) string {
	remoteAddr := req.RemoteAddr
	
	// Extract IP from RemoteAddr (removes port if present)
	remoteIP, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		remoteIP = remoteAddr
	}
	
	// If no trusted proxies configured, always use RemoteAddr
	if len(s.TrustedProxies) == 0 {
		return remoteIP
	}
	
	// Check if the request comes from a trusted proxy
	isTrusted := false
	for _, trustedProxy := range s.TrustedProxies {
		// Parse CIDR or single IP
		_, cidr, err := net.ParseCIDR(trustedProxy)
		if err != nil {
			// Not a CIDR, try as single IP
			if remoteIP == trustedProxy {
				isTrusted = true
				break
			}
		} else {
			// Check if remoteIP is in the CIDR range
			if cidr.Contains(net.ParseIP(remoteIP)) {
				isTrusted = true
				break
			}
		}
	}
	
	// If not from trusted proxy, use RemoteAddr to prevent spoofing
	if !isTrusted {
		return remoteIP
	}
	
	// Extract the first IP from X-Forwarded-For header
	xForwardedFor := req.Header.Get("X-Forwarded-For")
	if xForwardedFor != "" {
		// X-Forwarded-For can contain multiple IPs separated by commas
		// The first IP is the original client IP
		ips := strings.Split(xForwardedFor, ",")
		if len(ips) > 0 {
			clientIP := strings.TrimSpace(ips[0])
			if net.ParseIP(clientIP) != nil {
				return clientIP
			}
		}
	}
	
	// Fallback to RemoteAddr if X-Forwarded-For is invalid or empty
	return remoteIP
}

// httpLogFormatter returns a logging formatter that properly handles X-Forwarded-For
// headers only when requests come from trusted proxies
func (s *Server) httpLogFormatter() func(io.Writer, handlers.LogFormatterParams) {
	logger := s.Logger
	if logger == nil {
		logger = zap.NewNop()
	}

	return func(_ io.Writer, params handlers.LogFormatterParams) {
		var req = params.Request
		if req == nil {
			logger.Error(
				"Unable to log request handled because no request exists",
				zap.Reflect("LogFormatterParams", params),
			)
			return
		}

		host := s.getRealClientIP(req)
		uri := req.RequestURI

		// Requests using the CONNECT method over HTTP/2.0 must use
		// the authority field (aka r.Host) to identify the target.
		// Refer: https://httpwg.github.io/specs/rfc7540.html#CONNECT
		if req.ProtoMajor == 2 && req.Method == "CONNECT" {
			uri = req.Host
		}
		if uri == "" {
			uri = params.URL.RequestURI()
		}

		logger.Info(
			"Request handled",
			zap.String("host", host),
			zap.Time("timestamp", params.TimeStamp),
			zap.String("method", req.Method),
			zap.String("uri", uri),
			zap.String("protocol", req.Proto),
			zap.Int("responseStatus", params.StatusCode),
			zap.Int("responseSize", params.Size),
		)
	}
}
