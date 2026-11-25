package yopass

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
)

// HTTPClient allows modifying the underlying http.Client.
//
// Redirects are not followed: one could send the token, secret ID or
// ciphertext somewhere else, or in cleartext. The API has no need for them, so
// a 3xx response is an error like any other unexpected status. A replacement
// client must set CheckRedirect itself to keep this.
//
// Compressed responses are neither requested nor inflated: the API returns
// ciphertext and short JSON, and transparent gzip would let a small response
// expand to about a thousand times its size in memory. A replacement client
// needs a Transport with DisableCompression to keep this.
var HTTPClient = &http.Client{
	CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	},
	Transport: uncompressedTransport(),
}

func uncompressedTransport() *http.Transport {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DisableCompression = true
	return transport
}

// ErrInvalidID is returned for a secret ID that no yopass server issues.
var ErrInvalidID = errors.New("invalid secret ID")

// validID matches the UUIDs and alphanumeric IDs that yopass servers issue.
// IDs reach the fetch calls from links, already percent-decoded; anything else
// ("?", "#", "%2F", "..") could point the request at a different endpoint.
// Escaping alone does not prevent that, since the server's router decodes and
// cleans the path and then redirects.
var validID = regexp.MustCompile(`^[a-zA-Z0-9-]+$`)

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

// withoutURL returns the cause of an error from net/http or net/url without
// the request URL those packages quote in front of it. For a fetch that URL
// ends in the secret ID, and errors end up in logs while the secret is still
// on the server. It can also hold credentials given with the server address.
func withoutURL(err error) error {
	var urlErr *url.Error
	if errors.As(err, &urlErr) {
		return urlErr.Err
	}
	return err
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
		return config, fmt.Errorf("could not create request: %w", withoutURL(err))
	}
	setAuthorization(req, token)

	resp, err := HTTPClient.Do(req)
	if err != nil {
		return config, &ServerError{err: withoutURL(err)}
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
	if !validID.MatchString(id) {
		return "", ErrInvalidID
	}
	server = strings.TrimSuffix(server, "/")

	req, err := http.NewRequest(http.MethodGet, server+"/secret/"+id, nil)
	if err != nil {
		return "", fmt.Errorf("could not create request: %w", withoutURL(err))
	}
	setAuthorization(req, token)

	resp, err := HTTPClient.Do(req)
	if err != nil {
		return "", &ServerError{err: withoutURL(err)}
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
		return "", fmt.Errorf("could not create request: %w", withoutURL(err))
	}
	req.Header.Set("Content-Type", "application/json")
	setAuthorization(req, token)

	resp, err := HTTPClient.Do(req)
	if err != nil {
		return "", &ServerError{err: withoutURL(err)}
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
		return "", fmt.Errorf("could not create request: %w", withoutURL(err))
	}
	req.Header.Set("Content-Type", "application/octet-stream")
	req.Header.Set("X-Yopass-Expiration", fmt.Sprintf("%d", expiration))
	req.Header.Set("X-Yopass-OneTime", fmt.Sprintf("%t", oneTime))
	setAuthorization(req, token)

	resp, err := HTTPClient.Do(req)
	if err != nil {
		return "", &ServerError{err: withoutURL(err)}
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
	if !validID.MatchString(id) {
		return nil, ErrInvalidID
	}
	server = strings.TrimSuffix(server, "/")

	req, err := http.NewRequest(http.MethodGet, server+"/file/"+id, nil)
	if err != nil {
		return nil, fmt.Errorf("could not create request: %w", withoutURL(err))
	}
	req.Header.Set("Accept", "application/octet-stream")
	setAuthorization(req, token)

	resp, err := HTTPClient.Do(req)
	if err != nil {
		return nil, &ServerError{err: withoutURL(err)}
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
	token = strings.TrimSpace(token)
	if token == "" {
		return
	}
	if strings.HasPrefix(strings.ToLower(token), "bearer ") {
		token = strings.TrimSpace(token[7:])
	}
	req.Header.Set("Authorization", "Bearer "+token)
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
