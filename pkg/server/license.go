package server

import (
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

// LicenseStatus holds the result of license key verification.
type LicenseStatus struct {
	Valid     bool
	ExpiresAt time.Time
	Licensee  string
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

	var claims jwt.RegisteredClaims
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
				zap.String("licensee", claims.Subject),
				zap.Time("expired_at", expAt),
			)
			return LicenseStatus{
				Valid:     false,
				ExpiresAt: expAt,
				Licensee:  claims.Subject,
			}
		}
		logger.Warn("license: key verification failed", zap.Error(err))
		return LicenseStatus{}
	}

	if !token.Valid {
		logger.Warn("license: key is not valid")
		return LicenseStatus{}
	}

	expAt := time.Time{}
	if claims.ExpiresAt != nil {
		expAt = claims.ExpiresAt.Time
	}

	return LicenseStatus{
		Valid:     true,
		ExpiresAt: expAt,
		Licensee:  claims.Subject,
	}
}
