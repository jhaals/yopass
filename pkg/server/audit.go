package server

import (
	"crypto/sha256"
	"encoding/hex"
	"time"

	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
)

// AuditOutcome classifies the result of an auditable action.
type AuditOutcome string

const (
	OutcomeSuccess AuditOutcome = "success"
	OutcomeFailure AuditOutcome = "failure"
	OutcomeDenied  AuditOutcome = "denied"
)

// AuditEvent is the structured payload written for every auditable action.
// Secret message content is never included — only IDs and metadata.
type AuditEvent struct {
	Timestamp         time.Time    `json:"timestamp"`
	Event             string       `json:"event"`
	Outcome           AuditOutcome `json:"outcome"`
	ClientIP          string       `json:"client_ip"`
	SecretID          string       `json:"secret_id,omitempty"`
	UserEmail         string       `json:"user_email,omitempty"`
	UserSubject       string       `json:"user_subject,omitempty"`
	OneTime           *bool        `json:"one_time,omitempty"`
	ExpirationSeconds *int32       `json:"expiration_seconds,omitempty"`
	RequireAuth       *bool        `json:"require_auth,omitempty"`
	Error             string       `json:"error,omitempty"`
}

// AuditLogger is satisfied by both the real logger and the no-op.
type AuditLogger interface {
	Log(e AuditEvent)
	Sync() error
}

// noopAuditLogger silently discards events when audit logging is disabled.
// It is always safe to call — no nil checks needed at call sites.
type noopAuditLogger struct{}

func (noopAuditLogger) Log(AuditEvent) {}
func (noopAuditLogger) Sync() error    { return nil }

// NewNoopAuditLogger returns the no-op implementation.
func NewNoopAuditLogger() AuditLogger { return noopAuditLogger{} }

// NewAuditLogger builds a zap-backed NDJSON audit logger.
// An empty path writes to stdout; otherwise output goes to the given file path.
func NewAuditLogger(path string) (AuditLogger, error) {
	cfg := zap.NewProductionConfig()
	cfg.Encoding = "json"
	cfg.EncoderConfig = zapcore.EncoderConfig{
		TimeKey:        "",  // suppressed — timestamp is written explicitly as a named field
		MessageKey:     "",  // suppressed — all data lives in named fields
		LevelKey:       "",  // suppressed — every audit record is informational
		LineEnding:     zapcore.DefaultLineEnding,
		EncodeDuration: zapcore.SecondsDurationEncoder,
	}
	if path != "" {
		cfg.OutputPaths = []string{path}
	} else {
		cfg.OutputPaths = []string{"stdout"}
	}
	cfg.ErrorOutputPaths = []string{"stderr"}

	l, err := cfg.Build(zap.WithCaller(false))
	if err != nil {
		return nil, err
	}
	return &zapAuditLogger{l}, nil
}

type zapAuditLogger struct{ logger *zap.Logger }

func (a *zapAuditLogger) Sync() error { return a.logger.Sync() }

func (a *zapAuditLogger) Log(e AuditEvent) {
	fields := []zap.Field{
		zap.Time("timestamp", e.Timestamp.UTC()),
		zap.String("event", e.Event),
		zap.String("outcome", string(e.Outcome)),
		zap.String("client_ip", e.ClientIP),
	}
	if e.SecretID != "" {
		fields = append(fields, zap.String("secret_id", redactSecretID(e.SecretID)))
	}
	if e.UserEmail != "" {
		fields = append(fields, zap.String("user_email", e.UserEmail))
	}
	if e.UserSubject != "" {
		fields = append(fields, zap.String("user_subject", e.UserSubject))
	}
	if e.OneTime != nil {
		fields = append(fields, zap.Bool("one_time", *e.OneTime))
	}
	if e.ExpirationSeconds != nil {
		fields = append(fields, zap.Int32("expiration_seconds", *e.ExpirationSeconds))
	}
	if e.RequireAuth != nil {
		fields = append(fields, zap.Bool("require_auth", *e.RequireAuth))
	}
	if e.Error != "" {
		fields = append(fields, zap.String("error", e.Error))
	}
	a.logger.Info("", fields...)
}

// audit returns the server's AuditLogger, falling back to the noop if nil.
// This makes every call site nil-safe without requiring HTTPHandler to have run first.
func (y *Server) audit() AuditLogger {
	if y.Audit == nil {
		return noopAuditLogger{}
	}
	return y.Audit
}

// redactSecretID hashes the raw secret key to a short fingerprint so audit
// logs can correlate events without exposing a token that could be used to
// retrieve the secret.
func redactSecretID(secretID string) string {
	if secretID == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(secretID))
	return hex.EncodeToString(sum[:])[:12]
}

// boolPtr returns a pointer to b for use in optional *bool AuditEvent fields.
func boolPtr(b bool) *bool { return &b }

// int32Ptr returns a pointer to v for use in optional *int32 AuditEvent fields.
func int32Ptr(v int32) *int32 { return &v }

// sessionEmail returns the email from a session or "" if session is nil.
func sessionEmail(s *sessionData) string {
	if s == nil {
		return ""
	}
	return s.Email
}

// sessionSub returns the subject from a session or "" if session is nil.
func sessionSub(s *sessionData) string {
	if s == nil {
		return ""
	}
	return s.Sub
}
