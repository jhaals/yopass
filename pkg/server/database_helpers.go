package server

import (
	"encoding/json"

	"github.com/jhaals/yopass/pkg/yopass"
)

// unmarshalSecret converts JSON data to a Secret struct
func unmarshalSecret(data []byte) (yopass.Secret, error) {
	var s yopass.Secret
	if err := json.Unmarshal(data, &s); err != nil {
		return s, err
	}
	return s, nil
}

// extractOneTimeStatus unmarshals the secret and returns only the OneTime status
func extractOneTimeStatus(data []byte) (bool, error) {
	s, err := unmarshalSecret(data)
	if err != nil {
		return false, err
	}
	return s.OneTime, nil
}

// handleOneTimeSecret deletes the key if the secret is one-time
// This should be called after successfully retrieving a secret
func handleOneTimeSecret(db Database, key string, secret yopass.Secret) error {
	if secret.OneTime {
		_, err := db.Delete(key)
		return err
	}
	return nil
}
