package server

import (
	"net/http"

	"github.com/jhaals/yopass/pkg/yopass"
	"go.uber.org/zap"
)

// oidcEnabled reports whether OIDC authentication is configured. Deliberately
// not gated on the license expiring at runtime: authentication is security
// infrastructure, so dropping it mid-run would strip protection from — and
// strand access to — secrets created with RequireAuth. The hard license gate
// for OIDC applies at startup (cmd/yopass-server validateFlags).
func (y *Server) oidcEnabled() bool {
	return y.OIDCProvider != nil
}

// UnlicensedMaxFileSize is the upload size cap for servers without a
// currently valid license. cmd/yopass-server applies it at startup;
// effectiveMaxFileSize re-applies it when a license expires at runtime.
const UnlicensedMaxFileSize int64 = 1 * 1024 * 1024

// effectiveMaxFileSize returns the upload size limit honoring runtime license
// expiry: a limit that was only permitted by a license (>1MB) falls back to
// the unlicensed cap once the license is no longer valid.
func (y *Server) effectiveMaxFileSize() int64 {
	if y.MaxFileSize > UnlicensedMaxFileSize && !y.License.CurrentlyValid() {
		return UnlicensedMaxFileSize
	}
	return y.MaxFileSize
}

// authorizeSecretAccess enforces RequireAuth for secret retrieval and
// deletion. It writes the error response and audit event itself and reports
// whether the request may proceed.
func (y *Server) authorizeSecretAccess(w http.ResponseWriter, secret yopass.Secret, session *sessionData, sessionErr error, audit *auditor) bool {
	if !secret.RequireAuth {
		return true
	}
	if sessionErr != nil || session == nil {
		audit.denied("authentication required", withRequireAuth(true))
		jsonError(w, http.StatusUnauthorized, "authentication required")
		return false
	}
	if !y.emailAllowed(session.Email) {
		audit.denied("email domain not permitted", withRequireAuth(true))
		jsonError(w, http.StatusForbidden, "email domain not permitted")
		return false
	}
	return true
}

// claimOneTimeSecret atomically claims a one-time secret by deleting its
// database key before the content is served. Delete returns false when the
// key is already gone, meaning a concurrent request claimed the secret first.
// It writes the error response and audit event itself and reports whether the
// caller now owns the secret.
func (y *Server) claimOneTimeSecret(w http.ResponseWriter, dbKey string, audit *auditor) bool {
	deleted, err := y.DB.Delete(dbKey)
	if err != nil {
		y.Logger.Error("Failed to claim one-time secret", zap.Error(err))
		audit.failure("failed to claim one-time secret", withOneTime(true))
		jsonError(w, http.StatusInternalServerError, "Failed to process secret")
		return false
	}
	if !deleted {
		audit.denied("claimed by concurrent request", withOneTime(true))
		jsonError(w, http.StatusNotFound, "Secret not found")
		return false
	}
	return true
}

// creationPolicy holds the client-requested attributes common to text secret
// and file creation, validated against server policy by checkCreationPolicy.
type creationPolicy struct {
	expiration  int32
	oneTime     bool
	requireAuth bool
	receipt     bool
}

// checkCreationPolicy enforces the server-side creation policy shared by
// /create/secret and /create/file. It writes the error response and audit
// event itself and reports whether the request may proceed.
func (y *Server) checkCreationPolicy(w http.ResponseWriter, p creationPolicy, audit *auditor) bool {
	if p.receipt && !y.readReceiptsEnabled() {
		audit.failure("read receipts not enabled")
		jsonError(w, http.StatusBadRequest, "Read receipts are not enabled on this server")
		return false
	}
	if !y.checkExpirationPolicy(w, p.expiration, audit) {
		return false
	}
	if p.requireAuth && !y.oidcEnabled() {
		audit.failure("auth required but OIDC not configured")
		jsonError(w, http.StatusBadRequest, "Authentication not configured on this server")
		return false
	}
	if !p.oneTime && y.ForceOneTimeSecrets {
		audit.failure("one-time required by server policy")
		jsonError(w, http.StatusBadRequest, "Secret must be one time download")
		return false
	}
	return true
}

// checkExpirationPolicy validates the lifetime for secrets, files, and secret requests.
func (y *Server) checkExpirationPolicy(w http.ResponseWriter, expiration int32, audit *auditor) bool {
	if !validExpiration(expiration) {
		audit.failure("invalid expiration")
		jsonError(w, http.StatusBadRequest, "Invalid expiration specified")
		return false
	}
	if y.ForceExpiration != "" && expiration != expirationInSeconds(y.ForceExpiration) {
		audit.failure("expiration does not match forced value")
		jsonError(w, http.StatusBadRequest, "Expiration does not match server policy")
		return false
	}
	return true
}

// secretRequestsEnabled reports whether the secret request feature is active:
// it requires a currently valid license and is unavailable in read-only mode.
// Checked both at route registration and per request, so creating new
// requests stops as soon as the license expires.
func (y *Server) secretRequestsEnabled() bool {
	return y.License.CurrentlyValid() && !y.ReadOnly && !y.DisableSecretRequests
}

// maybeRequireAuth wraps a handler with requireAuthMiddleware when OIDC is
// configured and the --require-auth flag is set. Otherwise it returns the
// handler as-is.
func (y *Server) maybeRequireAuth(h http.HandlerFunc) http.Handler {
	if y.oidcEnabled() && y.RequireAuth {
		return y.requireAuthMiddleware(h)
	}
	return h
}
