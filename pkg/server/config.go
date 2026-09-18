package server

import (
	"encoding/json"
	"net/http"
)

// DefaultThemeLight and DefaultThemeDark are the built-in DaisyUI themes used
// when no valid license overrides them. cmd/yopass-server uses them as the
// defaults for the --theme-light and --theme-dark flags.
const (
	DefaultThemeLight = "emerald"
	DefaultThemeDark  = "dim"
)

func (y *Server) configHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Headers", "content-type")
	w.Header().Set("Content-Type", "application/json")

	config := map[string]interface{}{
		"DISABLE_UPLOAD":        y.DisableUpload,
		"READ_ONLY":             y.ReadOnly,
		"PREFETCH_SECRET":       y.PrefetchSecret,
		"DISABLE_FEATURES":      y.DisableFeatures,
		"NO_LANGUAGE_SWITCHER":  y.NoLanguageSwitcher,
		"FORCE_ONETIME_SECRETS": y.ForceOneTimeSecrets,
		"DEFAULT_EXPIRY":        expirationInSeconds(y.DefaultExpiry),
		"ARGON2":                y.Argon2,
	}
	if y.ForceExpiration != "" {
		config["FORCE_EXPIRATION"] = expirationInSeconds(y.ForceExpiration)
	}
	if maxFileSize := y.effectiveMaxFileSize(); maxFileSize > 0 {
		config["MAX_FILE_SIZE"] = FormatSize(maxFileSize)
	}

	// Add optional string URLs only if they are provided
	if y.PrivacyNoticeURL != "" {
		config["PRIVACY_NOTICE_URL"] = y.PrivacyNoticeURL
	}
	if y.ImprintURL != "" {
		config["IMPRINT_URL"] = y.ImprintURL
	}
	if y.PublicURL != "" {
		config["PUBLIC_URL"] = y.PublicURL
	}
	if y.License.CurrentlyValid() && y.LogoURL != "" {
		config["LOGO_URL"] = y.LogoURL
	}

	config["OIDC_ENABLED"] = y.oidcEnabled()
	config["REQUIRE_AUTH"] = y.oidcEnabled() && y.RequireAuth
	config["SECRET_REQUESTS"] = y.secretRequestsEnabled()
	// File responses to secret requests have their own, stricter size limit
	// (they are stored in the database backend, not the file store).
	if y.secretRequestsEnabled() && !y.DisableUpload {
		config["MAX_REQUEST_FILE_SIZE"] = FormatSize(y.effectiveRequestFileSize())
	}
	// The toggle is only useful where secrets can be created, so read-only
	// instances report false even with a valid license.
	config["READ_RECEIPTS"] = y.readReceiptsEnabled() && !y.ReadOnly

	if y.License.CurrentlyValid() {
		config["THEME_LIGHT"] = y.ThemeLight
		config["THEME_DARK"] = y.ThemeDark

		if y.ThemeCustomLight != "" {
			var vars map[string]string
			if err := json.Unmarshal([]byte(y.ThemeCustomLight), &vars); err == nil {
				config["THEME_CUSTOM_LIGHT"] = vars
			}
		}
		if y.ThemeCustomDark != "" {
			var vars map[string]string
			if err := json.Unmarshal([]byte(y.ThemeCustomDark), &vars); err == nil {
				config["THEME_CUSTOM_DARK"] = vars
			}
		}

		if y.AppName != "" {
			config["APP_NAME"] = y.AppName
		}
	} else {
		config["THEME_LIGHT"] = DefaultThemeLight
		config["THEME_DARK"] = DefaultThemeDark
	}

	y.writeJSON(w, http.StatusOK, config)
}
