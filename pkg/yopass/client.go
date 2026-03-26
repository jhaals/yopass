package yopass

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
)

var unsafeFilenameChars = regexp.MustCompile(`[\x00-\x1f\x7f/\\]`)

// sanitizeFilename strips control characters and path separators from a filename.
func sanitizeFilename(name string) string {
	name = unsafeFilenameChars.ReplaceAllString(name, "")
	if name == "" {
		return "download"
	}
	return name
}

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

// StoreFile uploads encrypted file data to the streaming endpoint and returns the file ID.
func StoreFile(server string, data []byte, expiration int32, oneTime bool, filename string) (string, error) {
	server = strings.TrimSuffix(server, "/")

	req, err := http.NewRequest("POST", server+"/create/file", bytes.NewReader(data))
	if err != nil {
		return "", fmt.Errorf("could not create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/octet-stream")
	req.Header.Set("X-Yopass-Expiration", fmt.Sprintf("%d", expiration))
	req.Header.Set("X-Yopass-OneTime", fmt.Sprintf("%t", oneTime))
	req.Header.Set("X-Yopass-Filename", sanitizeFilename(filename))

	resp, err := HTTPClient.Do(req)
	if err != nil {
		return "", &ServerError{err: err}
	}
	return handleServerResponse(resp)
}

// FetchFile retrieves a streaming file by its ID and returns the body and filename.
func FetchFile(server string, id string) ([]byte, string, error) {
	server = strings.TrimSuffix(server, "/")

	req, err := http.NewRequest("GET", server+"/file/"+id, nil)
	if err != nil {
		return nil, "", fmt.Errorf("could not create request: %w", err)
	}
	req.Header.Set("Accept", "application/octet-stream")

	resp, err := HTTPClient.Do(req)
	if err != nil {
		return nil, "", &ServerError{err: err}
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(resp.Body)
		return nil, "", &ServerError{err: fmt.Errorf("unexpected response %s: %s", resp.Status, string(msg))}
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, "", fmt.Errorf("could not read response: %w", err)
	}

	filename := resp.Header.Get("X-Yopass-Filename")
	return body, filename, nil
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
