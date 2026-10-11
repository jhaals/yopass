package server

import (
	"fmt"
	"time"

	"github.com/jhaals/yopass/pkg/yopass"
)

const (
	DefaultMinExpiration int32 = 60
	DefaultMaxExpiration int32 = 90 * 86400
)

func (y *Server) expirationBounds() (int32, int32) {
	min, max := y.MinExpiration, y.MaxExpiration
	if min == 0 {
		min = DefaultMinExpiration
	}
	if max == 0 {
		max = DefaultMaxExpiration
	}
	return min, max
}

func (y *Server) acceptsExpiration(seconds int32) bool {
	if !y.AllowCustomExpiration {
		return validExpiration(seconds)
	}
	min, max := y.expirationBounds()
	return seconds > 0 && seconds >= min && seconds <= max
}

// ValidateExpirationSettings checks duration syntax, policy consistency, and
// the Memcached client's signed 32-bit absolute timestamp limit at startup.
func ValidateExpirationSettings(allow bool, min, max, defaultExpiry, forced, database string) error {
	if min == "" {
		min = "1m"
	}
	if max == "" {
		max = "90d"
	}
	if defaultExpiry == "" {
		defaultExpiry = "1h"
	}
	minSeconds, ok := yopass.ParseExpirationDuration(min)
	if !ok {
		return fmt.Errorf("invalid --min-expiration %q: use a positive integer duration (e.g. 1m)", min)
	}
	maxSeconds, ok := yopass.ParseExpirationDuration(max)
	if !ok {
		return fmt.Errorf("invalid --max-expiration %q: use a positive integer duration (e.g. 90d)", max)
	}
	if minSeconds > maxSeconds {
		return fmt.Errorf("--min-expiration must not exceed --max-expiration")
	}
	policy := Server{AllowCustomExpiration: allow, MinExpiration: minSeconds, MaxExpiration: maxSeconds}
	for _, setting := range []struct{ name, value string }{
		{"default-expiry", defaultExpiry}, {"force-expiration", forced},
	} {
		if setting.value == "" {
			continue
		}
		seconds, valid := yopass.ParseExpirationDuration(setting.value)
		if !valid || !policy.acceptsExpiration(seconds) || (!allow && !ValidExpiryString(setting.value)) {
			if !allow {
				return fmt.Errorf("invalid --%s value %q, expected one of: 1h, 1d, 1w", setting.name, setting.value)
			}
			return fmt.Errorf("--%s must be a positive duration between --min-expiration and --max-expiration", setting.name)
		}
	}
	if allow && (database == "memcached" || database == "") {
		if _, err := memcachedExpiration(maxSeconds, time.Now().Unix()); err != nil {
			return fmt.Errorf("--max-expiration exceeds Memcached's timestamp limit: %w", err)
		}
	}
	return nil
}
