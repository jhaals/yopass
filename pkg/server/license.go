package server

import (
	"context"
	"crypto/ecdsa"
	"crypto/x509"
	_ "embed"
	"encoding/pem"
	"errors"
	"fmt"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"go.uber.org/zap"
)

//go:embed license_public.pem
var licensePublicKeyPEM []byte

// LicenseStatus holds the result of license key verification. Valid is the
// verification outcome at startup; long-running servers must call
// CurrentlyValid instead, which also accounts for the license expiring while
// the process is running.
type LicenseStatus struct {
	Valid     bool
	ExpiresAt time.Time
	Licensee  string
}

// CurrentlyValid reports whether the license is valid at this moment: the key
// verified at startup and its expiry timestamp has not yet passed. Business
// feature gates use this so an expired license degrades the server to
// non-business behavior without a restart. Verification guarantees ExpiresAt
// is set whenever Valid is true.
func (l LicenseStatus) CurrentlyValid() bool {
	return l.Valid && time.Now().Before(l.ExpiresAt)
}

// Expired reports whether a license key was provided and its signature
// verified but the expiry timestamp has passed. An expired license degrades
// gracefully (business features off, security features stay); a key that
// failed verification entirely (wrong signature, corrupt) is not considered
// expired — it is treated as absent.
func (l LicenseStatus) Expired() bool {
	return l.Licensee != "" && !l.ExpiresAt.IsZero() && !time.Now().Before(l.ExpiresAt)
}

// DaysUntilExpiry returns the number of days until the license expires.
// Returns a negative value if already expired, 0 if no license was provided.
func (l LicenseStatus) DaysUntilExpiry() float64 {
	if l.ExpiresAt.IsZero() {
		return 0
	}
	return time.Until(l.ExpiresAt).Hours() / 24
}

// VerifyLicense parses and verifies a JWT license key against the embedded
// public key. It never fails hard — on any error a warning is logged and a
// zero LicenseStatus (Valid: false) is returned.
func VerifyLicense(keyString string, logger *zap.Logger) LicenseStatus {
	return verifyLicenseWithKey(keyString, licensePublicKeyPEM, logger)
}

func verifyLicenseWithKey(keyString string, publicKeyPEM []byte, logger *zap.Logger) LicenseStatus {
	if keyString == "" {
		return LicenseStatus{}
	}

	block, _ := pem.Decode(publicKeyPEM)
	if block == nil {
		logger.Warn("license: failed to decode public key PEM")
		return LicenseStatus{}
	}

	pub, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		logger.Warn("license: failed to parse public key", zap.Error(err))
		return LicenseStatus{}
	}

	ecPub, ok := pub.(*ecdsa.PublicKey)
	if !ok {
		logger.Warn("license: public key is not an ECDSA key")
		return LicenseStatus{}
	}

	type licenseClaims struct {
		jwt.RegisteredClaims
		Company string `json:"cn"`
	}

	licensee := func(c licenseClaims) string {
		if c.Company != "" {
			return c.Company
		}
		return c.Subject
	}

	var claims licenseClaims
	token, err := jwt.ParseWithClaims(keyString, &claims, func(t *jwt.Token) (interface{}, error) {
		if _, ok := t.Method.(*jwt.SigningMethodECDSA); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
		}
		return ecPub, nil
	})

	if err != nil {
		if errors.Is(err, jwt.ErrTokenExpired) {
			expAt := time.Time{}
			if claims.ExpiresAt != nil {
				expAt = claims.ExpiresAt.Time
			}
			logger.Warn("license: key has expired",
				zap.String("licensee", licensee(claims)),
				zap.Time("expired_at", expAt),
			)
			return LicenseStatus{
				Valid:     false,
				ExpiresAt: expAt,
				Licensee:  licensee(claims),
			}
		}
		logger.Warn("license: key verification failed", zap.Error(err))
		return LicenseStatus{}
	}

	if !token.Valid {
		logger.Warn("license: key is not valid")
		return LicenseStatus{}
	}

	if claims.ExpiresAt == nil {
		logger.Warn("license: key has no expiry, rejecting")
		return LicenseStatus{}
	}

	return LicenseStatus{
		Valid:     true,
		ExpiresAt: claims.ExpiresAt.Time,
		Licensee:  licensee(claims),
	}
}

// licenseWarnWindow is how long before expiry the monitor starts warning, and
// licenseWarnInterval how often it repeats the warning.
const (
	licenseWarnWindow   = 30 * 24 * time.Hour
	licenseWarnInterval = 24 * time.Hour
)

// StartLicenseExpiryMonitor periodically re-checks the license expiry of a
// running server, warning daily during the last 30 days and logging an error
// once the license expires. The feature gates read the clock directly through
// LicenseStatus.CurrentlyValid, so this goroutine exists purely for operator
// visibility. It returns when the expiry has been logged or ctx is cancelled.
func StartLicenseExpiryMonitor(ctx context.Context, license LicenseStatus, interval time.Duration, logger *zap.Logger) {
	if !license.Valid {
		return
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	var lastWarn time.Time
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if !license.CurrentlyValid() {
				logger.Error("license has expired — business features are disabled; provide a renewed license key and restart",
					zap.String("licensee", license.Licensee),
					zap.Time("expired_at", license.ExpiresAt),
				)
				return
			}
			if time.Until(license.ExpiresAt) <= licenseWarnWindow && time.Since(lastWarn) >= licenseWarnInterval {
				logger.Warn("license expires soon — business features will be disabled at expiry",
					zap.String("licensee", license.Licensee),
					zap.Time("expires_at", license.ExpiresAt),
					zap.Float64("days_until_expiry", license.DaysUntilExpiry()),
				)
				lastWarn = time.Now()
			}
		}
	}
}
