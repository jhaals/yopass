package server

import (
	"net/http"
	"path/filepath"

	"go.uber.org/zap"
)

// logoHandler serves the built-in yopass.svg logo.
func (y *Server) logoHandler(w http.ResponseWriter, r *http.Request) {
	http.ServeFile(w, r, filepath.Join(y.AssetPath, "yopass.svg"))
}

// versionHandler returns the server version
func (y *Server) versionHandler(w http.ResponseWriter, r *http.Request) {
	version := y.Version
	if version == "" {
		version = "unknown"
	}
	y.writeJSON(w, http.StatusOK, map[string]string{"version": version})
}

// healthHandler performs liveness check (shallow check - process is alive)
func (y *Server) healthHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
	y.writeJSON(w, http.StatusOK, map[string]string{"status": "healthy"})
}

// readyHandler performs readiness check (deep check - can handle traffic)
func (y *Server) readyHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")

	notReady := func(logMsg, reason string, err error) {
		y.Logger.Debug(logMsg, zap.Error(err))
		y.writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"status": "not ready",
			"error":  reason,
		})
	}

	if y.DB == nil {
		y.Logger.Warn("Readiness check failed: database is nil")
		y.writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"status": "not ready",
			"error":  "database not configured",
		})
		return
	}

	if err := y.DB.Health(); err != nil {
		notReady("Readiness check failed", "database connectivity failed", err)
		return
	}

	if y.FileStore != nil {
		if err := y.FileStore.Health(r.Context()); err != nil {
			notReady("Readiness check failed: file store", "file store connectivity failed", err)
			return
		}
	}

	y.writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
}
