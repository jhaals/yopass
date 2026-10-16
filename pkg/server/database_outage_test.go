package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jhaals/yopass/pkg/yopass"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
	"go.uber.org/zap/zaptest/observer"
)

type statusOutageDB struct {
	Database
	err error
}

func (db *statusOutageDB) Status(key string) (yopass.Secret, error) {
	if db.err != nil {
		return yopass.Secret{}, db.err
	}
	return db.Database.Status(key)
}

func TestRequestAndReceiptDatabaseOutage(t *testing.T) {
	for _, backend := range []string{"handler-fake", "redis", "memcached"} {
		t.Run(backend, func(t *testing.T) {
			backing := openContractDatabase(t, backend)
			db := &statusOutageDB{Database: backing}
			y := newRequestTestServer(t, db, true)
			y.FileStore = NewDatabaseFileStore(db)
			audit := &capturingAuditLogger{}
			y.Audit = audit
			core, logs := observer.New(zap.ErrorLevel)
			y.Logger = zap.New(core)
			handler := y.HTTPHandler()
			id, token := createRequest(t, handler, testPublicKey(t), "", 3600)
			require.NoError(t, y.updateRequest(id, func(r *SecretRequest) error {
				r.State, r.Secret = RequestStateFulfilled, "stored ciphertext"
				return nil
			}))
			receiptToken, err := y.createReceipt(id, true, 3600)
			require.NoError(t, err)
			t.Cleanup(func() { backing.Delete(requestKeyPrefix + id); backing.Delete(receiptKeyPrefix + id) })
			original, err := backing.Status(requestKeyPrefix + id)
			require.NoError(t, err)
			db.err = fmt.Errorf("database transport failure for %s", id)
			for _, endpoint := range []struct{ method, path, header, token string }{
				{http.MethodGet, "/request/" + id, "", ""},
				{http.MethodGet, "/request/" + id + "/secret", requestTokenHeader, token},
				{http.MethodDelete, "/request/" + id, requestTokenHeader, token},
				{http.MethodGet, "/secret/" + id + "/receipt", receiptTokenHeader, receiptToken},
				{http.MethodGet, "/file/" + id + "/receipt", receiptTokenHeader, receiptToken},
			} {
				r := httptest.NewRequest(endpoint.method, endpoint.path, nil)
				r.Header.Set(endpoint.header, endpoint.token)
				w := httptest.NewRecorder()
				handler.ServeHTTP(w, r)
				require.Equal(t, http.StatusServiceUnavailable, w.Code, "%s %s: %s", endpoint.method, endpoint.path, w.Body.String())
				require.NotContains(t, w.Body.String(), id)
				event := audit.events[len(audit.events)-1]
				require.Equal(t, OutcomeFailure, event.Outcome)
				require.Equal(t, "database error", event.Error)
			}
			require.Equal(t, 5, logs.Len())
			assertNoRawKey(t, logs, id)
			db.err = nil
			retained, err := backing.Status(requestKeyPrefix + id)
			require.NoError(t, err)
			require.Equal(t, original, retained)
			for _, path := range []string{"/request/" + id, "/secret/" + id + "/receipt"} {
				r := httptest.NewRequest(http.MethodGet, path, nil)
				r.Header.Set(receiptTokenHeader, receiptToken)
				w := httptest.NewRecorder()
				handler.ServeHTTP(w, r)
				require.Equal(t, http.StatusOK, w.Code, w.Body.String())
			}
			r := httptest.NewRequest(http.MethodDelete, "/request/"+id, nil)
			r.Header.Set(requestTokenHeader, token)
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, r)
			require.Equal(t, http.StatusNoContent, w.Code)
		})
	}
}

func TestInvalidRequestAndReceiptRemainNotFound(t *testing.T) {
	for _, record := range []string{"missing", "malformed", "expired"} {
		t.Run(record, func(t *testing.T) {
			db := newMemoryDB()
			y := newRequestTestServer(t, db, true)
			const id = "test-id"
			if record != "missing" {
				message := "invalid JSON"
				if record == "expired" {
					data, err := json.Marshal(SecretRequest{TokenHash: "hash", ExpiresAt: time.Now().Add(-time.Hour).Unix()})
					require.NoError(t, err)
					message = string(data)
				}
				for _, prefix := range []string{requestKeyPrefix, receiptKeyPrefix} {
					require.NoError(t, db.Put(prefix+id, yopass.Secret{Message: message, Expiration: 3600}))
				}
			}
			handler := y.HTTPHandler()
			for _, path := range []string{"/request/" + id, "/secret/" + id + "/receipt"} {
				w := httptest.NewRecorder()
				handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
				require.Equal(t, http.StatusNotFound, w.Code)
			}
		})
	}
}
