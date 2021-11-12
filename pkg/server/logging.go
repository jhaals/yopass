package server

import (
	"github.com/gorilla/handlers"
	"go.uber.org/zap"
	"io"
	"net"
)

func httpLogFormatter(logger *zap.Logger) func(io.Writer, handlers.LogFormatterParams) {
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

		host, _, err := net.SplitHostPort(req.RemoteAddr)
		if err != nil {
			host = req.RemoteAddr
		}

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
