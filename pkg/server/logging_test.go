package server

import (
	"net"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gorilla/handlers"
	"github.com/stretchr/testify/assert"
	"go.uber.org/zap"
	"go.uber.org/zap/zaptest/observer"
)

func TestHTTPLogFormatter(t *testing.T) {
	t.Run("Log request", func(t *testing.T) {
		ts := time.Now()
		request := httptest.NewRequest("GET", "https://yopass.se/", nil)
		host, _, _ := net.SplitHostPort(request.RemoteAddr)

		loggerCore, logs := observer.New(zap.DebugLevel)
		logger := zap.New(loggerCore)

		formatter := httpLogFormatter(logger)
		formatter(nil, handlers.LogFormatterParams{
			Request:    request,
			TimeStamp:  ts,
			StatusCode: 200,
			Size:       50,
		})

		if logs.Len() != 1 {
			t.Fatalf("Expected 1 log entry got %d", logs.Len())
		}
		infoLogs := logs.FilterLevelExact(zap.InfoLevel).All()
		if len(infoLogs) != 1 {
			t.Fatalf("Expected 1 info level log but got %d", len(infoLogs))
		}

		fields := infoLogs[0].Context
		for _, f := range fields {
			switch f.Key {
			case "host":
				assert.Equal(t, host, f.String)
			case "timestamp":
				assert.Equal(t, ts.UnixNano(), f.Integer)
			case "method":
				assert.Equal(t, "GET", f.String)
			case "uri":
				assert.Equal(t, "https://yopass.se/", f.String)
			case "protocol":
				assert.Equal(t, "HTTP/1.1", f.String)
			case "responseStatus":
				assert.Equal(t, int64(200), f.Integer)
			case "responseSize":
				assert.Equal(t, int64(50), f.Integer)
			default:
				t.Fatalf("Unexpected fields %s", f.Key)
			}
		}

		if len(fields) != 7 {
			t.Fatalf("Expected 7 fields but got %d", len(fields))
		}
	})

	t.Run("No request", func(t *testing.T) {
		loggerCore, logs := observer.New(zap.DebugLevel)
		logger := zap.New(loggerCore)

		formatter := httpLogFormatter(logger)
		formatter(nil, handlers.LogFormatterParams{})

		if err := logger.Sync(); err != nil {
			t.Fatalf("Unexpected error from logger.Sync %v", err)
		}

		if logs.Len() != 1 {
			t.Fatalf("Expected 1 log entry got %d", logs.Len())
		}
		errorLogs := logs.FilterLevelExact(zap.ErrorLevel).All()
		if len(errorLogs) != 1 {
			t.Fatalf("Expected 1 error level because no request was provided but got %d", len(errorLogs))
		}
	})
}
