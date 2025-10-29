package server

import (
	"testing"

	"github.com/jhaals/yopass/pkg/yopass"
	"github.com/stretchr/testify/assert"
)

func TestUnmarshalSecret(t *testing.T) {
	tests := []struct {
		name      string
		data      []byte
		wantError bool
	}{
		{
			name:      "valid JSON",
			data:      []byte(`{"message":"test","expiration":3600,"one_time":true}`),
			wantError: false,
		},
		{
			name:      "invalid JSON",
			data:      []byte(`{invalid}`),
			wantError: true,
		},
		{
			name:      "empty JSON",
			data:      []byte(`{}`),
			wantError: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := unmarshalSecret(tt.data)
			if tt.wantError {
				assert.Error(t, err)
			} else {
				assert.NoError(t, err)
			}
		})
	}
}

func TestExtractOneTimeStatus(t *testing.T) {
	tests := []struct {
		name      string
		data      []byte
		want      bool
		wantError bool
	}{
		{
			name:      "one-time secret",
			data:      []byte(`{"message":"test","expiration":3600,"one_time":true}`),
			want:      true,
			wantError: false,
		},
		{
			name:      "non one-time secret",
			data:      []byte(`{"message":"test","expiration":3600,"one_time":false}`),
			want:      false,
			wantError: false,
		},
		{
			name:      "invalid JSON",
			data:      []byte(`{invalid}`),
			want:      false,
			wantError: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := extractOneTimeStatus(tt.data)
			if tt.wantError {
				assert.Error(t, err)
			} else {
				assert.NoError(t, err)
				assert.Equal(t, tt.want, got)
			}
		})
	}
}

func TestHandleOneTimeSecret(t *testing.T) {
	tests := []struct {
		name    string
		secret  yopass.Secret
		wantErr bool
	}{
		{
			name: "one-time secret",
			secret: yopass.Secret{
				Message:    "test",
				Expiration: 3600,
				OneTime:    true,
			},
			wantErr: false,
		},
		{
			name: "non one-time secret",
			secret: yopass.Secret{
				Message:    "test",
				Expiration: 3600,
				OneTime:    false,
			},
			wantErr: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			db := &mockDatabase{
				deleteFunc: func(key string) (bool, error) {
					return true, nil
				},
			}
			err := handleOneTimeSecret(db, "test-key", tt.secret)
			if tt.wantErr {
				assert.Error(t, err)
			} else {
				assert.NoError(t, err)
			}
		})
	}
}

// mockDatabase is a simple mock implementation for testing
type mockDatabase struct {
	getFunc    func(key string) (yopass.Secret, error)
	putFunc    func(key string, secret yopass.Secret) error
	deleteFunc func(key string) (bool, error)
	statusFunc func(key string) (bool, error)
}

func (m *mockDatabase) Get(key string) (yopass.Secret, error) {
	if m.getFunc != nil {
		return m.getFunc(key)
	}
	return yopass.Secret{}, nil
}

func (m *mockDatabase) Put(key string, secret yopass.Secret) error {
	if m.putFunc != nil {
		return m.putFunc(key, secret)
	}
	return nil
}

func (m *mockDatabase) Delete(key string) (bool, error) {
	if m.deleteFunc != nil {
		return m.deleteFunc(key)
	}
	return true, nil
}

func (m *mockDatabase) Status(key string) (bool, error) {
	if m.statusFunc != nil {
		return m.statusFunc(key)
	}
	return false, nil
}
