package yopass

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// HTTPClient allows modifying the underlying http.Client.
var HTTPClient = http.DefaultClient

// ServerError represents a yopass server error.
type ServerError struct {
	err error
}

func (e *ServerError) Error() string {
	return fmt.Sprintf("yopass server error: %s", e.err)
}

func (e *ServerError) Unwrap() error {
	return e.err
}

type serverResponse struct {
	Message string `json:"message"`
}

// ServerConfig holds the subset of the server /config response relevant to
// the CLI client. Unknown fields are ignored so older servers remain
// compatible.
type ServerConfig struct {
	Argon2 bool `json:"ARGON2"`
}

// FetchServerConfig retrieves the public configuration from the specified
// server's /config endpoint.
func FetchServerConfig(server string) (ServerConfig, error) {
	return FetchServerConfigWithToken(server, "")
}

// FetchServerConfigWithToken retrieves the public configuration from the
// specified server's /config endpoint using the provided Bearer token.
func FetchServerConfigWithToken(server, token string) (ServerConfig, error) {
	server = strings.TrimSuffix(server, "/")

	var config ServerConfig
	req, err := http.NewRequest(http.MethodGet, server+"/config", nil)
	if err != nil {
		return config, fmt.Errorf("could not create request: %w", err)
	}
	setAuthorization(req, token)

	resp, err := HTTPClient.Do(req)
	if err != nil {
		return config, &ServerError{err: err}
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return config, &ServerError{err: fmt.Errorf("unexpected response %s", resp.Status)}
	}
	if err := json.NewDecoder(resp.Body).Decode(&config); err != nil {
		return config, fmt.Errorf("could not decode server config: %w", err)
	}
	return config, nil
}

// Fetch retrieves a secret by its ID from the specified server.
func Fetch(server string, id string) (string, error) {
	return FetchWithToken(server, id, "")
}

// FetchWithToken retrieves a secret by its ID from the specified server using
// the provided Bearer token.
func FetchWithToken(server string, id string, token string) (string, error) {
	server = strings.TrimSuffix(server, "/")

	req, err := http.NewRequest(http.MethodGet, server+"/secret/"+id, nil)
	if err != nil {
		return "", fmt.Errorf("could not create request: %w", err)
	}
	setAuthorization(req, token)

	resp, err := HTTPClient.Do(req)
	if err != nil {
		return "", &ServerError{err: err}
	}
	return handleServerResponse(resp)
}

// Store sends the secret to the specified server and returns the secret ID.
func Store(server string, s Secret) (string, error) {
	return StoreWithToken(server, s, "")
}

// StoreWithToken sends the secret to the specified server and returns the
// secret ID using the provided Bearer token.
func StoreWithToken(server string, s Secret, token string) (string, error) {
	server = strings.TrimSuffix(server, "/")

	var j bytes.Buffer
	if err := (json.NewEncoder(&j)).Encode(&s); err != nil {
		return "", fmt.Errorf("could not encode request: %w", err)
	}
	req, err := http.NewRequest(http.MethodPost, server+"/create/secret", &j)
	if err != nil {
		return "", fmt.Errorf("could not create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	setAuthorization(req, token)

	resp, err := HTTPClient.Do(req)
	if err != nil {
		return "", &ServerError{err: err}
	}
	return handleServerResponse(resp)
}

// StoreFile uploads encrypted file data to the streaming endpoint and returns the file ID.
// The filename is embedded in the OpenPGP metadata by the caller via EncryptBinary.
func StoreFile(server string, data []byte, expiration int32, oneTime bool) (string, error) {
	return StoreFileWithToken(server, data, expiration, oneTime, "")
}

// StoreFileWithToken uploads encrypted file data to the streaming endpoint and
// returns the file ID using the provided Bearer token.
func StoreFileWithToken(server string, data []byte, expiration int32, oneTime bool, token string) (string, error) {
	server = strings.TrimSuffix(server, "/")

	req, err := http.NewRequest(http.MethodPost, server+"/create/file", bytes.NewReader(data))
	if err != nil {
		return "", fmt.Errorf("could not create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/octet-stream")
	req.Header.Set("X-Yopass-Expiration", fmt.Sprintf("%d", expiration))
	req.Header.Set("X-Yopass-OneTime", fmt.Sprintf("%t", oneTime))
	setAuthorization(req, token)

	resp, err := HTTPClient.Do(req)
	if err != nil {
		return "", &ServerError{err: err}
	}
	return handleServerResponse(resp)
}

// FetchFile retrieves a streaming file by its ID and returns the encrypted body.
// The filename is embedded in the OpenPGP metadata; call Decrypt() to obtain it.
func FetchFile(server string, id string) ([]byte, error) {
	return FetchFileWithToken(server, id, "")
}

// FetchFileWithToken retrieves a streaming file by its ID and returns the
// encrypted body using the provided Bearer token.
func FetchFileWithToken(server string, id string, token string) ([]byte, error) {
	server = strings.TrimSuffix(server, "/")

	req, err := http.NewRequest(http.MethodGet, server+"/file/"+id, nil)
	if err != nil {
		return nil, fmt.Errorf("could not create request: %w", err)
	}
	req.Header.Set("Accept", "application/octet-stream")
	setAuthorization(req, token)

	resp, err := HTTPClient.Do(req)
	if err != nil {
		return nil, &ServerError{err: err}
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(resp.Body)
		return nil, &ServerError{err: fmt.Errorf("unexpected response %s: %s", resp.Status, string(msg))}
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("could not read response: %w", err)
	}

	return body, nil
}

func setAuthorization(req *http.Request, token string) {
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
}

func handleServerResponse(resp *http.Response) (string, error) {
	defer resp.Body.Close()

	var r serverResponse
	if resp.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(resp.Body)
		if err := json.Unmarshal(msg, &r); err == nil {
			msg = []byte(r.Message)
		}
		err := fmt.Errorf("unexpected response %s: %s", resp.Status, string(msg))
		return "", &ServerError{err: err}
	}

	if err := (json.NewDecoder(resp.Body)).Decode(&r); err != nil {
		return "", fmt.Errorf("could not decode server response: %w", err)
	}

	return r.Message, nil
}
