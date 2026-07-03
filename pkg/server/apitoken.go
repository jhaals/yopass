package server

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"fmt"
	"net/http"
	"strings"
)

// APIToken is a named static bearer token that lets machine clients
// (internal services, automation) create secrets when --require-auth is
// enabled, without going through the interactive OIDC browser flow.
// Requests authenticate with "Authorization: Bearer <secret>" and are
// attributed in audit logs as "service:<name>".
type APIToken struct {
	Name   string
	Secret string
}

// minAPITokenLength is the minimum accepted secret length; shorter tokens
// are too easy to brute-force for a credential that never expires.
const minAPITokenLength = 16

// ParseAPITokens parses --api-token values of the form "name:secret".
// Error messages never include the secret so misconfigured values cannot
// leak into logs.
func ParseAPITokens(entries []string) ([]APIToken, error) {
	seen := make(map[string]bool, len(entries))
	tokens := make([]APIToken, 0, len(entries))
	for _, entry := range entries {
		name, secret, ok := strings.Cut(entry, ":")
		if !ok || name == "" || secret == "" {
			return nil, fmt.Errorf("invalid api-token entry: expected format name:secret")
		}
		if len(secret) < minAPITokenLength {
			return nil, fmt.Errorf("api-token %q: secret must be at least %d characters", name, minAPITokenLength)
		}
		if seen[name] {
			return nil, fmt.Errorf("duplicate api-token name %q", name)
		}
		seen[name] = true
		tokens = append(tokens, APIToken{Name: name, Secret: secret})
	}
	return tokens, nil
}

// bearerToken extracts the credential from an "Authorization: Bearer ..."
// header, or returns "" when no bearer credential is present.
func bearerToken(r *http.Request) string {
	auth := r.Header.Get("Authorization")
	const prefix = "Bearer "
	if len(auth) > len(prefix) && strings.EqualFold(auth[:len(prefix)], prefix) {
		return strings.TrimSpace(auth[len(prefix):])
	}
	return ""
}

// apiTokenSession returns a synthetic session for a request carrying a
// valid API bearer token, or nil when no configured token matches.
// Comparison is constant-time over SHA-256 digests so neither the token
// length nor a partial match is observable through timing.
func (y *Server) apiTokenSession(r *http.Request) *sessionData {
	if len(y.APITokens) == 0 {
		return nil
	}
	presented := bearerToken(r)
	if presented == "" {
		return nil
	}
	presentedSum := sha256.Sum256([]byte(presented))
	for _, t := range y.APITokens {
		expectedSum := sha256.Sum256([]byte(t.Secret))
		if hmac.Equal(presentedSum[:], expectedSum[:]) {
			return &sessionData{
				Sub:   "api-token:" + t.Name,
				Email: "service:" + t.Name,
				Name:  t.Name,
			}
		}
	}
	return nil
}

// sessionContextKey carries an already-authenticated session on the request
// context, set by requireAuthMiddleware for API token requests.
type sessionContextKey struct{}

// withSession returns a copy of ctx carrying s as the authenticated session.
func withSession(ctx context.Context, s *sessionData) context.Context {
	return context.WithValue(ctx, sessionContextKey{}, s)
}

// sessionFromContext returns the session stored by withSession, or nil.
func sessionFromContext(ctx context.Context) *sessionData {
	s, _ := ctx.Value(sessionContextKey{}).(*sessionData)
	return s
}
