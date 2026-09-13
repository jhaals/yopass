package server

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/mux"
	"github.com/jhaals/yopass/pkg/yopass"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Status succeeds, but another request wins the claim or the database fails.
type failedClaimDB struct {
	Database
	err        error
	deleteKeys []string
}

func (db *failedClaimDB) Delete(key string) (bool, error) {
	db.deleteKeys = append(db.deleteKeys, key)
	return false, db.err
}

func TestOneTimeDownloadClaimFailure(t *testing.T) {
	for _, kind := range []string{"secret", "file"} {
		for _, tc := range []struct {
			name    string
			err     error
			status  int
			message string
			outcome AuditOutcome
			reason  string
		}{
			{"database error", errors.New("database unavailable"), http.StatusInternalServerError, "Failed to process secret", OutcomeFailure, "failed to claim one-time secret"},
			{"concurrent claim", nil, http.StatusNotFound, "Secret not found", OutcomeDenied, "claimed by concurrent request"},
		} {
			t.Run(kind+"/"+tc.name, func(t *testing.T) {
				const key = "abcdef01-1234-5678-9abc-def012345678"
				const content = "encrypted content must not be served"
				backing := newTestDB()
				dbKey := key
				eventName := "secret.accessed"
				if kind == "file" {
					dbKey = streamKeyPrefix + key
					eventName = "file.downloaded"
				}
				require.NoError(t, backing.Put(dbKey, yopass.Secret{Message: content, OneTime: true}))
				db := &failedClaimDB{Database: backing, err: tc.err}
				srv := newTestServer(t, db, 10000, false)
				audit := &capturingAuditLogger{}
				srv.Audit = audit
				srv.License = LicenseStatus{Valid: true, ExpiresAt: time.Now().Add(time.Hour)}
				store, err := NewDiskFileStore(t.TempDir())
				require.NoError(t, err)
				srv.FileStore = store
				if kind == "file" {
					require.NoError(t, store.Save(context.Background(), key, strings.NewReader(content), int64(len(content)), 3600))
				}

				req := mux.SetURLVars(httptest.NewRequest(http.MethodGet, "/"+kind+"/"+key, nil), map[string]string{"key": key})
				w := httptest.NewRecorder()
				if kind == "file" {
					srv.streamDownload(w, req)
				} else {
					srv.getSecret(w, req)
				}

				assert.Equal(t, tc.status, w.Code)
				assert.Contains(t, w.Body.String(), tc.message)
				assert.NotContains(t, w.Body.String(), content)
				assert.NotContains(t, w.Body.String(), "database unavailable")
				assert.Equal(t, []string{dbKey}, db.deleteKeys)
				require.Len(t, audit.events, 1)
				event := audit.events[0]
				assert.Equal(t, eventName, event.Event)
				assert.Equal(t, tc.outcome, event.Outcome)
				assert.Equal(t, tc.reason, event.Error)
				require.NotNil(t, event.OneTime)
				assert.True(t, *event.OneTime)
				assert.Equal(t, redactSecretID(key), event.SecretID)
				if kind == "file" {
					assert.FileExists(t, store.binPath(key), "a failed claim must not delete the winner's file")
				}
			})
		}
	}
}
