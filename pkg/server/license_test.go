package server

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/pem"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
)

// generateTestKeyPair returns a fresh ECDSA P-256 key pair and the PEM-encoded public key.
func generateTestKeyPair(t *testing.T) (*ecdsa.PrivateKey, []byte) {
	t.Helper()
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	require.NoError(t, err)

	pubBytes, err := x509.MarshalPKIXPublicKey(&priv.PublicKey)
	require.NoError(t, err)
	pubPEM := pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: pubBytes})
	return priv, pubPEM
}

// signLicense signs a JWT with the given private key and claims.
func signLicense(t *testing.T, priv *ecdsa.PrivateKey, claims jwt.RegisteredClaims) string {
	t.Helper()
	token := jwt.NewWithClaims(jwt.SigningMethodES256, claims)
	signed, err := token.SignedString(priv)
	require.NoError(t, err)
	return signed
}

func TestVerifyLicense_EmptyKey(t *testing.T) {
	logger := zap.NewNop()
	status := verifyLicenseWithKey("", licensePublicKeyPEM, logger)
	assert.False(t, status.Valid)
	assert.True(t, status.ExpiresAt.IsZero())
}

func TestVerifyLicense_ValidKey(t *testing.T) {
	priv, pubPEM := generateTestKeyPair(t)
	logger := zap.NewNop()

	expiry := time.Now().Add(30 * 24 * time.Hour)
	signed := signLicense(t, priv, jwt.RegisteredClaims{
		Subject:   "customer@example.com",
		ExpiresAt: jwt.NewNumericDate(expiry),
		IssuedAt:  jwt.NewNumericDate(time.Now()),
		Issuer:    "yopass-license",
	})

	status := verifyLicenseWithKey(signed, pubPEM, logger)
	assert.True(t, status.Valid)
	assert.Equal(t, "customer@example.com", status.Licensee)
	assert.WithinDuration(t, expiry, status.ExpiresAt, time.Second)
	assert.InDelta(t, 30.0, status.DaysUntilExpiry(), 0.1)
}

func TestVerifyLicense_ExpiredKey(t *testing.T) {
	priv, pubPEM := generateTestKeyPair(t)
	logger := zap.NewNop()

	expiry := time.Now().Add(-24 * time.Hour)
	signed := signLicense(t, priv, jwt.RegisteredClaims{
		Subject:   "expired@example.com",
		ExpiresAt: jwt.NewNumericDate(expiry),
		IssuedAt:  jwt.NewNumericDate(time.Now().Add(-48 * time.Hour)),
	})

	status := verifyLicenseWithKey(signed, pubPEM, logger)
	assert.False(t, status.Valid)
	assert.Equal(t, "expired@example.com", status.Licensee)
	assert.WithinDuration(t, expiry, status.ExpiresAt, time.Second)
	assert.Negative(t, status.DaysUntilExpiry())
}

func TestVerifyLicense_WrongKey(t *testing.T) {
	priv, _ := generateTestKeyPair(t)
	_, wrongPubPEM := generateTestKeyPair(t) // different key pair

	logger := zap.NewNop()

	signed := signLicense(t, priv, jwt.RegisteredClaims{
		Subject:   "test@example.com",
		ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour)),
	})

	status := verifyLicenseWithKey(signed, wrongPubPEM, logger)
	assert.False(t, status.Valid)
	assert.Empty(t, status.Licensee)
}

func TestVerifyLicense_InvalidJWT(t *testing.T) {
	_, pubPEM := generateTestKeyPair(t)
	logger := zap.NewNop()

	status := verifyLicenseWithKey("not.a.jwt", pubPEM, logger)
	assert.False(t, status.Valid)
}

func TestVerifyLicense_InvalidPEM(t *testing.T) {
	priv, _ := generateTestKeyPair(t)
	logger := zap.NewNop()

	signed := signLicense(t, priv, jwt.RegisteredClaims{
		Subject:   "test@example.com",
		ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour)),
	})

	status := verifyLicenseWithKey(signed, []byte("not-pem"), logger)
	assert.False(t, status.Valid)
}

func TestVerifyLicense_WrongSigningMethod(t *testing.T) {
	_, pubPEM := generateTestKeyPair(t)
	logger := zap.NewNop()

	// Sign with HMAC instead of ECDSA
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.RegisteredClaims{
		Subject:   "test@example.com",
		ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour)),
	})
	signed, err := token.SignedString([]byte("hmac-secret"))
	require.NoError(t, err)

	status := verifyLicenseWithKey(signed, pubPEM, logger)
	assert.False(t, status.Valid)
}

func TestLicenseStatus_DaysUntilExpiry_NoLicense(t *testing.T) {
	s := LicenseStatus{}
	assert.Equal(t, 0.0, s.DaysUntilExpiry())
}
