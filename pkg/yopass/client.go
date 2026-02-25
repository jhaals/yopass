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

// Fetch retrieves a secret by its ID from the specified server.
func Fetch(server string, id string) (string, error) {
	server = strings.TrimSuffix(server, "/")

	resp, err := HTTPClient.Get(server + "/secret/" + id)
	if err != nil {
		return "", &ServerError{err: err}
	}
	return handleServerResponse(resp)
}

// Store sends the secret to the specified server and returns the secret ID.
func Store(server string, s Secret) (string, error) {
	server = strings.TrimSuffix(server, "/")

	var j bytes.Buffer
	if err := (json.NewEncoder(&j)).Encode(&s); err != nil {
		return "", fmt.Errorf("could not encode request: %w", err)
	}
	resp, err := HTTPClient.Post(server+"/create/secret", "application/json", &j)
	if err != nil {
		return "", &ServerError{err: err}
	}
	return handleServerResponse(resp)
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
