package server

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/stretchr/testify/require"
)

func TestMetricsRecordsCommittedStatus(t *testing.T) {
	for _, explicit := range []bool{false, true} {
		t.Run(map[bool]string{false: "implicit", true: "explicit"}[explicit], func(t *testing.T) {
			registry := prometheus.NewRegistry()
			handler := newMetricsMiddleware(registry)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if explicit {
					w.WriteHeader(http.StatusCreated)
				}
				_, _ = w.Write([]byte("body"))
				w.WriteHeader(http.StatusInternalServerError) // Too late to change the response.
			}))
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/", nil))
			want := "200"
			if explicit {
				want = "201"
			}
			families, err := registry.Gather()
			require.NoError(t, err)
			found := false
			for _, family := range families {
				if family.GetName() != "yopass_http_requests_total" {
					continue
				}
				for _, metric := range family.Metric {
					for _, label := range metric.Label {
						if label.GetName() == "code" {
							require.Equal(t, want, label.GetValue())
							found = true
						}
					}
				}
			}
			require.True(t, found, "response code metric missing")
		})
	}
}

// Middleware must preserve streaming capabilities used by ResponseController.
func TestMetricsPreservesResponseController(t *testing.T) {
	deadline := time.Now().Add(time.Second)
	writer := &deadlineResponseWriter{ResponseRecorder: httptest.NewRecorder()}
	handler := newMetricsMiddleware(prometheus.NewRegistry())(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		controller := http.NewResponseController(w)
		require.NoError(t, controller.SetWriteDeadline(deadline))
		require.NoError(t, controller.Flush())
	}))
	handler.ServeHTTP(writer, httptest.NewRequest(http.MethodGet, "/", nil))
	require.Equal(t, deadline, writer.deadline)
	require.True(t, writer.Flushed)
}

type deadlineResponseWriter struct {
	*httptest.ResponseRecorder
	deadline time.Time
}

func (w *deadlineResponseWriter) SetWriteDeadline(deadline time.Time) error {
	w.deadline = deadline
	return nil
}
