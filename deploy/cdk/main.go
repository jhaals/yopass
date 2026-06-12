package main

import (
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/akrylysov/algnhsa"
	"github.com/aws/aws-sdk-go/aws"
	"github.com/aws/aws-sdk-go/aws/session"
	"github.com/aws/aws-sdk-go/service/dynamodb"
	"github.com/jhaals/yopass/pkg/server"
	"github.com/jhaals/yopass/pkg/yopass"
	"github.com/prometheus/client_golang/prometheus"
	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
)

// envOr returns the value of the environment variable or the fallback when unset.
func envOr(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}

func main() {
	logger := configureZapLogger(zapcore.InfoLevel)

	maxLength, err := strconv.Atoi(envOr("MAX_LENGTH", "10000"))
	if err != nil {
		log.Fatalf("invalid MAX_LENGTH: %v", err)
	}

	maxFileSize, err := server.ParseSize(envOr("MAX_FILE_SIZE", "128KB"))
	if err != nil {
		log.Fatalf("invalid MAX_FILE_SIZE: %v", err)
	}

	licenseStatus := server.LicenseStatus{}
	if licenseKey := os.Getenv("LICENSE_KEY"); licenseKey != "" {
		licenseStatus = server.VerifyLicense(licenseKey, logger)
		if licenseStatus.Valid {
			logger.Info("license key verified",
				zap.String("licensee", licenseStatus.Licensee),
				zap.Time("expires_at", licenseStatus.ExpiresAt),
			)
		}
	}

	allowedOrigins, err := parseAllowedOrigins(os.Getenv("CORS_ALLOWED_ORIGINS"))
	if err != nil {
		log.Fatalf("invalid CORS_ALLOWED_ORIGINS: %v", err)
	}

	db := NewDynamo(os.Getenv("TABLE_NAME"))
	registry := prometheus.NewRegistry()
	y := &server.Server{
		DB:             db,
		FileStore:      server.NewDatabaseFileStore(db),
		MaxLength:      maxLength,
		MaxFileSize:    maxFileSize,
		Registry:       registry,
		Logger:         logger,
		License:        licenseStatus,
		PrefetchSecret: true,
		DefaultExpiry:  "1h",
		// CORSAllowOrigin is left empty; withCORS below owns the header.
	}

	algnhsa.ListenAndServe(
		withCORS(allowedOrigins, y.HTTPHandler()),
		&algnhsa.Options{
			BinaryContentTypes: []string{"application/octet-stream"},
		})
}

// originMatcher matches request origins against an allowlist entry.
type originMatcher struct {
	exact   string
	pattern *regexp.Regexp
}

func (m originMatcher) matches(origin string) bool {
	if m.pattern != nil {
		return m.pattern.MatchString(origin)
	}
	return m.exact == origin
}

// parseAllowedOrigins parses a comma-separated list of origins. Entries may
// contain `*` wildcards which match any characters except `.` and `/`, so a
// wildcard can never span a domain boundary.
func parseAllowedOrigins(list string) ([]originMatcher, error) {
	var matchers []originMatcher
	for _, entry := range strings.Split(list, ",") {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		if !strings.Contains(entry, "*") {
			matchers = append(matchers, originMatcher{exact: entry})
			continue
		}
		expr := "^" + strings.ReplaceAll(regexp.QuoteMeta(entry), `\*`, `[^./]*`) + "$"
		pattern, err := regexp.Compile(expr)
		if err != nil {
			return nil, fmt.Errorf("origin pattern %q: %w", entry, err)
		}
		matchers = append(matchers, originMatcher{pattern: pattern})
	}
	return matchers, nil
}

func allowedOrigin(matchers []originMatcher, origin string) string {
	if origin == "" {
		return ""
	}
	for _, m := range matchers {
		if m.matches(origin) {
			return origin
		}
	}
	return ""
}

// withCORS restricts Access-Control-Allow-Origin to the allowlist. The inner
// server middleware sets the header during request handling, so a corsWriter
// overrides it at write time: allowed origins are echoed back, everything
// else gets no CORS header and is rejected by the browser.
func withCORS(matchers []originMatcher, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cw := &corsWriter{
			ResponseWriter: w,
			origin:         allowedOrigin(matchers, r.Header.Get("Origin")),
		}
		next.ServeHTTP(cw, r)
		// Handlers that only set headers and return (e.g. the OPTIONS
		// preflight handlers) never trigger WriteHeader, so fix the origin
		// header here before the server finalizes the response.
		if !cw.wroteHeader {
			cw.setOriginHeaders()
		}
	})
}

type corsWriter struct {
	http.ResponseWriter
	origin      string
	wroteHeader bool
}

func (c *corsWriter) setOriginHeaders() {
	if c.origin != "" {
		c.Header().Set("Access-Control-Allow-Origin", c.origin)
	} else {
		c.Header().Del("Access-Control-Allow-Origin")
	}
	c.Header().Add("Vary", "Origin")
}

func (c *corsWriter) WriteHeader(code int) {
	if !c.wroteHeader {
		c.wroteHeader = true
		c.setOriginHeaders()
	}
	c.ResponseWriter.WriteHeader(code)
}

func (c *corsWriter) Write(b []byte) (int, error) {
	if !c.wroteHeader {
		c.WriteHeader(http.StatusOK)
	}
	return c.ResponseWriter.Write(b)
}

// Flush keeps the streaming file handlers working through the wrapper.
func (c *corsWriter) Flush() {
	if !c.wroteHeader {
		c.WriteHeader(http.StatusOK)
	}
	if f, ok := c.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// Dynamo Database implementation
type Dynamo struct {
	tableName string
	svc       *dynamodb.DynamoDB
}

// NewDynamo returns a database client
func NewDynamo(tableName string) server.Database {
	sess, _ := session.NewSession()
	return &Dynamo{tableName: tableName, svc: dynamodb.New(sess)}
}

// Get item from dynamo
func (d *Dynamo) Get(key string) (yopass.Secret, error) {
	var s yopass.Secret
	input := &dynamodb.GetItemInput{
		Key: map[string]*dynamodb.AttributeValue{
			"id": {
				S: aws.String(key),
			},
		},
		TableName: aws.String(d.tableName),
	}
	result, err := d.svc.GetItem(input)
	if err != nil {
		return s, err
	}
	if len(result.Item) == 0 {
		return s, fmt.Errorf("Key not found in database")
	}

	if *result.Item["one_time"].BOOL {
		if err := d.deleteItem(key); err != nil {
			return s, err
		}
	}
	s.Message = *result.Item["secret"].S
	s.OneTime = *result.Item["one_time"].BOOL
	if v, ok := result.Item["require_auth"]; ok && v.BOOL != nil {
		s.RequireAuth = *v.BOOL
	}
	return s, nil
}

// Delete item
func (d *Dynamo) Delete(key string) (bool, error) {
	err := d.deleteItem(key)

	if errors.Is(err, &dynamodb.ResourceNotFoundException{}) {
		return false, nil
	}

	return err == nil, err
}

func (d *Dynamo) deleteItem(key string) error {
	input := &dynamodb.DeleteItemInput{
		Key: map[string]*dynamodb.AttributeValue{
			"id": {
				S: aws.String(key),
			},
		},
		TableName:    aws.String(d.tableName),
		ReturnValues: aws.String("ALL_OLD"),
	}

	_, err := d.svc.DeleteItem(input)
	return err
}

// Put item in Dynamo
func (d *Dynamo) Put(key string, secret yopass.Secret) error {
	input := &dynamodb.PutItemInput{
		// TABLE GENERATED NAME
		Item: map[string]*dynamodb.AttributeValue{
			"id": {
				S: aws.String(key),
			},
			"secret": {
				S: aws.String(secret.Message),
			},
			"one_time": {
				BOOL: aws.Bool(secret.OneTime),
			},
			"require_auth": {
				BOOL: aws.Bool(secret.RequireAuth),
			},
			"ttl": {
				N: aws.String(
					fmt.Sprintf(
						"%d", time.Now().Unix()+int64(secret.Expiration))),
			},
		},
		TableName: aws.String(d.tableName),
	}
	_, err := d.svc.PutItem(input)
	return err
}

// Status returns the secret without deleting it (safe for one-time secrets).
// It must include the stored message: secret requests and read receipts load
// their full JSON records through Status.
func (d *Dynamo) Status(key string) (yopass.Secret, error) {
	input := &dynamodb.GetItemInput{
		Key: map[string]*dynamodb.AttributeValue{
			"id": {
				S: aws.String(key),
			},
		},
		TableName: aws.String(d.tableName),
	}
	result, err := d.svc.GetItem(input)
	if err != nil {
		return yopass.Secret{}, err
	}
	if len(result.Item) == 0 {
		return yopass.Secret{}, fmt.Errorf("Key not found in database")
	}

	var s yopass.Secret
	if v, ok := result.Item["secret"]; ok && v.S != nil {
		s.Message = *v.S
	}
	if v, ok := result.Item["one_time"]; ok && v.BOOL != nil {
		s.OneTime = *v.BOOL
	}
	if v, ok := result.Item["require_auth"]; ok && v.BOOL != nil {
		s.RequireAuth = *v.BOOL
	}
	return s, nil
}

// Dummy health check
func (d *Dynamo) Health() error {
    return nil
}

func configureZapLogger(logLevel zapcore.Level) *zap.Logger {
	loggerCfg := zap.NewProductionConfig()
	loggerCfg.Level.SetLevel(logLevel)
	logger, err := loggerCfg.Build()
	if err != nil {
		log.Fatalf("Unable to build logger %v", err)
	}
	zap.ReplaceGlobals(logger)
	return logger
}
