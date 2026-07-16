package server

import (
	"context"
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
	"go.uber.org/zap/zaptest/observer"
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

func TestVerifyLicense_CompanyNameClaim(t *testing.T) {
	// License server issues tokens with "cn" (company name) not "sub".
	priv, pubPEM := generateTestKeyPair(t)
	logger := zap.NewNop()

	type cnClaims struct {
		jwt.RegisteredClaims
		Company string `json:"cn"`
	}
	expiry := time.Now().Add(30 * 24 * time.Hour)
	token := jwt.NewWithClaims(jwt.SigningMethodES256, cnClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    "yopass",
			ExpiresAt: jwt.NewNumericDate(expiry),
		},
		Company: "Acme Corp",
	})
	signed, err := token.SignedString(priv)
	require.NoError(t, err)

	status := verifyLicenseWithKey(signed, pubPEM, logger)
	assert.True(t, status.Valid)
	assert.Equal(t, "Acme Corp", status.Licensee)
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

func TestLicenseStatus_Expired(t *testing.T) {
	assert.False(t, LicenseStatus{}.Expired(), "zero status")
	assert.False(t, LicenseStatus{Valid: true, Licensee: "acme", ExpiresAt: time.Now().Add(time.Hour)}.Expired(), "valid and not expired")
	assert.True(t, LicenseStatus{Valid: true, Licensee: "acme", ExpiresAt: time.Now().Add(-time.Minute)}.Expired(), "valid at startup, now expired")
	assert.True(t, LicenseStatus{Valid: false, Licensee: "acme", ExpiresAt: time.Now().Add(-time.Minute)}.Expired(), "expired at parse time")
	assert.False(t, LicenseStatus{Valid: false}.Expired(), "invalid key with no details is not expired, just absent")
}

func TestLicenseStatus_CurrentlyValid(t *testing.T) {
	assert.False(t, LicenseStatus{}.CurrentlyValid(), "zero status")
	assert.True(t, LicenseStatus{Valid: true, ExpiresAt: time.Now().Add(time.Hour)}.CurrentlyValid(), "valid with future expiry")
	// A license that verified at startup degrades once its expiry passes.
	assert.False(t, LicenseStatus{Valid: true, ExpiresAt: time.Now().Add(-time.Minute)}.CurrentlyValid(), "valid at startup but now expired")
	// A key that failed verification is never resurrected by its timestamp.
	assert.False(t, LicenseStatus{Valid: false, ExpiresAt: time.Now().Add(time.Hour)}.CurrentlyValid(), "invalid with future expiry")
}

func TestStartLicenseExpiryMonitor_LogsExpiryAndExits(t *testing.T) {
	core, logs := observer.New(zap.WarnLevel)
	license := LicenseStatus{Valid: true, Licensee: "acme", ExpiresAt: time.Now().Add(-time.Minute)}

	done := make(chan struct{})
	go func() {
		StartLicenseExpiryMonitor(context.Background(), license, time.Millisecond, zap.New(core))
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("monitor did not exit after logging the expiry")
	}
	require.Equal(t, 1, logs.FilterLevelExact(zap.ErrorLevel).Len(), "expected exactly one expiry error log")
}

func TestStartLicenseExpiryMonitor_WarnsBeforeExpiry(t *testing.T) {
	core, logs := observer.New(zap.WarnLevel)
	license := LicenseStatus{Valid: true, Licensee: "acme", ExpiresAt: time.Now().Add(time.Hour)}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		StartLicenseExpiryMonitor(ctx, license, time.Millisecond, zap.New(core))
		close(done)
	}()

	deadline := time.Now().Add(5 * time.Second)
	for logs.FilterLevelExact(zap.WarnLevel).Len() == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	cancel()
	<-done

	// The warning fires inside the 30-day window but is throttled to once per
	// day, so many ticks still produce a single warning and no expiry error.
	assert.Equal(t, 1, logs.FilterLevelExact(zap.WarnLevel).Len())
	assert.Equal(t, 0, logs.FilterLevelExact(zap.ErrorLevel).Len())
}

func TestStartLicenseExpiryMonitor_InvalidLicenseReturnsImmediately(t *testing.T) {
	done := make(chan struct{})
	go func() {
		StartLicenseExpiryMonitor(context.Background(), LicenseStatus{}, time.Millisecond, zap.NewNop())
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("monitor should return immediately without a valid license")
	}
}

// TestVerifyLicense_PublicWrapper exercises the public VerifyLicense entry
// point that delegates to verifyLicenseWithKey against the embedded public key.
// Garbage input must produce a zero LicenseStatus without panicking.
func TestVerifyLicense_PublicWrapper(t *testing.T) {
	logger := zap.NewNop()

	assert.False(t, VerifyLicense("", logger).Valid)
	assert.False(t, VerifyLicense("not-a-jwt", logger).Valid)
}
