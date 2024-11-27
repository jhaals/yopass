package server

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gofrs/uuid"
	"github.com/gorilla/handlers"
	"github.com/gorilla/mux"
	"github.com/jhaals/yopass/pkg/yopass"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/spf13/viper"
	"go.uber.org/zap"
)

// Server struct holding database and settings.
// This should be created with server.New
type Server struct {
	DB                  Database
	MaxLength           int
	Registry            *prometheus.Registry
	ForceOneTimeSecrets bool
	AssetPath           string
	Logger              *zap.Logger
}

// createSecret creates secret
func (y *Server) createSecret(w http.ResponseWriter, request *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", viper.GetString("cors-allow-origin"))

	decoder := json.NewDecoder(request.Body)
	var s yopass.Secret
	if err := decoder.Decode(&s); err != nil {
		y.Logger.Debug("Unable to decode request", zap.Error(err))
		http.Error(w, `{"message": "Unable to parse json"}`, http.StatusBadRequest)
		return
	}

	if !validExpiration(s.Expiration) {
		http.Error(w, `{"message": "Invalid expiration specified"}`, http.StatusBadRequest)
		return
	}

	if !s.OneTime && y.ForceOneTimeSecrets {
		http.Error(w, `{"message": "Secret must be one time download"}`, http.StatusBadRequest)
		return
	}

	if len(s.Message) > y.MaxLength {
		http.Error(w, `{"message": "The encrypted message is too long"}`, http.StatusBadRequest)
		return
	}

	// Generate new UUID
	uuidVal, err := uuid.NewV4()
	if err != nil {
		y.Logger.Error("Unable to generate UUID", zap.Error(err))
		http.Error(w, `{"message": "Unable to generate UUID"}`, http.StatusInternalServerError)
		return
	}
	key := uuidVal.String()

	// store secret in memcache with specified expiration.
	if err := y.DB.Put(key, s); err != nil {
		y.Logger.Error("Unable to store secret", zap.Error(err))
		http.Error(w, `{"message": "Failed to store secret in database"}`, http.StatusInternalServerError)
		return
	}

	resp := map[string]string{"message": key}
	jsonData, err := json.Marshal(resp)
	if err != nil {
		y.Logger.Error("Failed to marshal create secret response", zap.Error(err), zap.String("key", key))
	}

	if _, err = w.Write(jsonData); err != nil {
		y.Logger.Error("Failed to write response", zap.Error(err), zap.String("key", key))
	}
}

// getSecret from database
func (y *Server) getSecret(w http.ResponseWriter, request *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", viper.GetString("cors-allow-origin"))
	w.Header().Set("Cache-Control", "private, no-cache")

	secretKey := mux.Vars(request)["key"]
	secret, err := y.DB.Get(secretKey)
	if err != nil {
		y.Logger.Debug("Secret not found", zap.Error(err), zap.String("key", secretKey))
		http.Error(w, `{"message": "Secret not found"}`, http.StatusNotFound)
		return
	}

	data, err := secret.ToJSON()
	if err != nil {
		y.Logger.Error("Failed to encode request", zap.Error(err), zap.String("key", secretKey))
		http.Error(w, `{"message": "Failed to encode secret"}`, http.StatusInternalServerError)
		return
	}

	if _, err := w.Write(data); err != nil {
		y.Logger.Error("Failed to write response", zap.Error(err), zap.String("key", secretKey))
	}
}

// deleteSecret from database
func (y *Server) deleteSecret(w http.ResponseWriter, request *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", viper.GetString("cors-allow-origin"))

	deleted, err := y.DB.Delete(mux.Vars(request)["key"])
	if err != nil {
		http.Error(w, `{"message": "Failed to delete secret"}`, http.StatusInternalServerError)
		return
	}

	if !deleted {
		http.Error(w, `{"message": "Secret not found"}`, http.StatusNotFound)
		return
	}

	w.WriteHeader(204)
}

// optionsSecret handle the Options http method by returning the correct CORS headers
func (y *Server) optionsSecret(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", viper.GetString("cors-allow-origin"))
	w.Header().Set("Access-Control-Allow-Methods", "*")
	w.Header().Set("Access-Control-Allow-Headers", "content-type")
}

func (y *Server) configHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", viper.GetString("cors-allow-origin"))
	w.Header().Set("Access-Control-Allow-Headers", "content-type")
	w.Header().Set("Content-Type", "application/json")

	config := map[string]bool{
		"DISABLE_UPLOAD": viper.GetBool("disable-upload"),
	}

	json.NewEncoder(w).Encode(config)
}

// HTTPHandler containing all routes
func (y *Server) HTTPHandler() http.Handler {
	mx := mux.NewRouter()
	mx.Use(newMetricsMiddleware(y.Registry))

	mx.HandleFunc("/secret", y.createSecret).Methods(http.MethodPost)
	mx.HandleFunc("/secret", y.optionsSecret).Methods(http.MethodOptions)
	mx.HandleFunc("/secret/"+keyParameter, y.getSecret).Methods(http.MethodGet)
	mx.HandleFunc("/secret/"+keyParameter, y.deleteSecret).Methods(http.MethodDelete)

	mx.HandleFunc("/config", y.configHandler).Methods(http.MethodGet)
	mx.HandleFunc("/config", y.optionsSecret).Methods(http.MethodOptions)

	if !viper.GetBool("DISABLE_UPLOAD") {
		mx.HandleFunc("/file", y.createSecret).Methods(http.MethodPost)
		mx.HandleFunc("/file", y.optionsSecret).Methods(http.MethodOptions)
		mx.HandleFunc("/file/"+keyParameter, y.getSecret).Methods(http.MethodGet)
		mx.HandleFunc("/file/"+keyParameter, y.deleteSecret).Methods(http.MethodDelete)
	}

	mx.PathPrefix("/").Handler(http.FileServer(http.Dir(y.AssetPath)))
	return handlers.CustomLoggingHandler(nil, SecurityHeadersHandler(mx), httpLogFormatter(y.Logger))
}

const keyParameter = "{key:(?:[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})}"

// validExpiration validates that expiration is either
// 3600(1hour), 86400(1day) or 604800(1week)
func validExpiration(expiration int32) bool {
	for _, ttl := range []int32{3600, 86400, 604800} {
		if ttl == expiration {
			return true
		}
	}
	return false
}

// SecurityHeadersHandler returns a middleware which sets common security
// HTTP headers on the response to mitigate common web vulnerabilities.
func SecurityHeadersHandler(next http.Handler) http.Handler {
	csp := []string{
		"default-src 'self'",
		"font-src 'self' data:",
		"form-action 'self'",
		"frame-ancestors 'none'",
		"script-src 'self'",
		"style-src 'self' 'unsafe-inline'",
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-security-policy", strings.Join(csp, "; "))
		w.Header().Set("referrer-policy", "no-referrer")
		w.Header().Set("x-content-type-options", "nosniff")
		w.Header().Set("x-frame-options", "DENY")
		w.Header().Set("x-xss-protection", "1; mode=block")
		if r.URL.Scheme == "https" || r.Header.Get("X-Forwarded-Proto") == "https" {
			w.Header().Set("strict-transport-security", "max-age=31536000")
		}
		next.ServeHTTP(w, r)
	})
}

// newMetricsHandler creates a middleware handler recording all HTTP requests in
// the given Prometheus registry
func newMetricsMiddleware(reg prometheus.Registerer) func(http.Handler) http.Handler {
	requests := prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "yopass_http_requests_total",
			Help: "Total number of requests served by HTTP method, path and response code.",
		},
		[]string{"method", "path", "code"},
	)
	reg.MustRegister(requests)

	duration := prometheus.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "yopass_http_request_duration_seconds",
			Help:    "Histogram of HTTP request latencies by method and path.",
			Buckets: prometheus.DefBuckets,
		},
		[]string{"method", "path"},
	)
	reg.MustRegister(duration)

	return func(handler http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			rec := statusCodeRecorder{ResponseWriter: w, statusCode: http.StatusOK}
			handler.ServeHTTP(&rec, r)
			path := normalizedPath(r)
			requests.WithLabelValues(r.Method, path, strconv.Itoa(rec.statusCode)).Inc()
			duration.WithLabelValues(r.Method, path).Observe(time.Since(start).Seconds())
		})
	}
}

// normlizedPath returns a normalized mux path template representation
func normalizedPath(r *http.Request) string {
	if route := mux.CurrentRoute(r); route != nil {
		if tmpl, err := route.GetPathTemplate(); err == nil {
			return strings.ReplaceAll(tmpl, keyParameter, ":key")
		}
	}
	return "<other>"
}

// statusCodeRecorder is a HTTP ResponseWriter recording the response code
type statusCodeRecorder struct {
	http.ResponseWriter
	statusCode int
}

// WriteHeader implements http.ResponseWriter
func (rw *statusCodeRecorder) WriteHeader(code int) {
	rw.ResponseWriter.WriteHeader(code)
	rw.statusCode = code
}
