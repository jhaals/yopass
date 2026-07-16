package server

import (
	"bytes"
	"crypto/hmac"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jhaals/yopass/pkg/yopass"
	"github.com/prometheus/client_golang/prometheus"
	"go.uber.org/zap/zaptest"
)

// webhookSink is a test receiver collecting webhook deliveries.
type webhookSink struct {
	server   *httptest.Server
	events   chan capturedDelivery
	failures int32 // number of requests to reject with 500 before succeeding
}

type capturedDelivery struct {
	event     WebhookEvent
	body      []byte
	signature string
	eventName string
	delivery  string
}

func newWebhookSink(t *testing.T) *webhookSink {
	t.Helper()
	sink := &webhookSink{events: make(chan capturedDelivery, 16)}
	sink.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("failed to read webhook body: %v", err)
		}
		if atomic.AddInt32(&sink.failures, -1) >= 0 {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		var e WebhookEvent
		if err := json.Unmarshal(body, &e); err != nil {
			t.Errorf("invalid webhook payload %q: %v", body, err)
		}
		sink.events <- capturedDelivery{
			event:     e,
			body:      body,
			signature: r.Header.Get(webhookSignatureHeader),
			eventName: r.Header.Get("X-Yopass-Event"),
			delivery:  r.Header.Get("X-Yopass-Delivery"),
		}
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(sink.server.Close)
	return sink
}

// waitForEvent fails the test unless a delivery arrives within the deadline.
func (s *webhookSink) waitForEvent(t *testing.T) capturedDelivery {
	t.Helper()
	select {
	case d := <-s.events:
		return d
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for webhook delivery")
		return capturedDelivery{}
	}
}

// assertNoEvent fails the test if a delivery arrives within the window.
func (s *webhookSink) assertNoEvent(t *testing.T, window time.Duration) {
	t.Helper()
	select {
	case d := <-s.events:
		t.Fatalf("unexpected webhook delivery: %+v", d.event)
	case <-time.After(window):
	}
}

func newTestNotifier(t *testing.T, cfg WebhookConfig) *WebhookNotifier {
	t.Helper()
	if cfg.Backoff == 0 {
		cfg.Backoff = 10 * time.Millisecond
	}
	if cfg.ExpiryInterval == 0 {
		cfg.ExpiryInterval = 20 * time.Millisecond
	}
	n, err := NewWebhookNotifier(cfg, zaptest.NewLogger(t), nil)
	if err != nil {
		t.Fatalf("failed to create notifier: %v", err)
	}
	t.Cleanup(n.Stop)
	return n
}

func TestWebhookNotifierConfigValidation(t *testing.T) {
	for _, invalid := range []string{"", "not a url", "ftp://example.com/hook", "/relative"} {
		if _, err := NewWebhookNotifier(WebhookConfig{URL: invalid}, zaptest.NewLogger(t), nil); err == nil {
			t.Errorf("expected error for webhook URL %q", invalid)
		}
	}
}

func TestWebhookSecretLifecycleEvents(t *testing.T) {
	sink := newWebhookSink(t)
	notifier := newTestNotifier(t, WebhookConfig{URL: sink.server.URL, Secret: "signing-key"})

	db := newMemoryDB()
	y := Server{
		DB:        db,
		MaxLength: 10000,
		Registry:  prometheus.NewRegistry(),
		Logger:    zaptest.NewLogger(t),
		License:   LicenseStatus{Valid: true, ExpiresAt: time.Now().Add(24 * time.Hour)},
		Webhooks:  notifier,
	}
	handler := y.HTTPHandler()

	// Create a one-time secret through the API.
	encrypted, err := yopass.Encrypt(strings.NewReader("hunter2"), "key")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(map[string]interface{}{
		"message":    encrypted,
		"expiration": 3600,
		"one_time":   true,
	})
	req, _ := http.NewRequest("POST", "/create/secret", bytes.NewReader(body))
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("create secret: status %d body %s", rr.Code, rr.Body.String())
	}
	var created struct {
		Message string `json:"message"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}

	d := sink.waitForEvent(t)
	if d.event.Event != WebhookEventSecretCreated {
		t.Fatalf("expected %s, got %s", WebhookEventSecretCreated, d.event.Event)
	}
	if d.event.SecretID != redactSecretID(created.Message) {
		t.Errorf("created event must carry the redacted secret ID, got %q", d.event.SecretID)
	}
	if d.event.SecretID == created.Message {
		t.Error("webhook payload must never contain the raw secret key")
	}
	if d.event.Kind != WebhookKindSecret || !d.event.OneTime || d.event.ExpirationSeconds != 3600 {
		t.Errorf("unexpected created event fields: %+v", d.event)
	}
	if d.eventName != WebhookEventSecretCreated {
		t.Errorf("X-Yopass-Event header: got %q", d.eventName)
	}
	if d.delivery == "" {
		t.Error("X-Yopass-Delivery header missing")
	}
	if d.event.Timestamp.IsZero() {
		t.Error("event timestamp not set")
	}

	// Signature must be a valid HMAC of the exact body.
	want := "sha256=" + signWebhookBody("signing-key", d.body)
	if !hmac.Equal([]byte(d.signature), []byte(want)) {
		t.Errorf("signature mismatch: got %q want %q", d.signature, want)
	}

	// Viewing the secret emits a viewed event.
	req, _ = http.NewRequest("GET", "/secret/"+created.Message, nil)
	rr = httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("get secret: status %d", rr.Code)
	}
	d = sink.waitForEvent(t)
	if d.event.Event != WebhookEventSecretViewed {
		t.Fatalf("expected %s, got %s", WebhookEventSecretViewed, d.event.Event)
	}
	if d.event.SecretID != redactSecretID(created.Message) || d.event.Kind != WebhookKindSecret {
		t.Errorf("unexpected viewed event fields: %+v", d.event)
	}

	// The one-time view cancelled expiry tracking — no expired event fires
	// even when the deadline is forced into the past.
	notifier.mu.Lock()
	if len(notifier.expiries) != 0 {
		t.Errorf("expiry tracking should be empty after one-time view, got %d entries", len(notifier.expiries))
	}
	notifier.mu.Unlock()
	sink.assertNoEvent(t, 100*time.Millisecond)
}

func TestWebhookExpiredEvent(t *testing.T) {
	sink := newWebhookSink(t)
	notifier := newTestNotifier(t, WebhookConfig{URL: sink.server.URL})

	notifier.SecretCreated("expiring-id", WebhookKindSecret, false, 3600)
	d := sink.waitForEvent(t)
	if d.event.Event != WebhookEventSecretCreated {
		t.Fatalf("expected created event, got %s", d.event.Event)
	}

	// Force the deadline into the past; the watcher tick should pick it up.
	notifier.mu.Lock()
	exp := notifier.expiries["expiring-id"]
	exp.deadline = time.Now().Add(-time.Second)
	notifier.expiries["expiring-id"] = exp
	notifier.mu.Unlock()

	d = sink.waitForEvent(t)
	if d.event.Event != WebhookEventSecretExpired {
		t.Fatalf("expected %s, got %s", WebhookEventSecretExpired, d.event.Event)
	}
	if d.event.SecretID != redactSecretID("expiring-id") || d.event.ExpirationSeconds != 3600 {
		t.Errorf("unexpected expired event fields: %+v", d.event)
	}

	// Expired entries fire exactly once.
	sink.assertNoEvent(t, 100*time.Millisecond)
}

func TestWebhookDeleteCancelsExpiry(t *testing.T) {
	sink := newWebhookSink(t)
	notifier := newTestNotifier(t, WebhookConfig{URL: sink.server.URL})

	notifier.SecretCreated("deleted-id", WebhookKindSecret, false, 3600)
	sink.waitForEvent(t) // created

	notifier.SecretDeleted("deleted-id")
	notifier.mu.Lock()
	exp, tracked := notifier.expiries["deleted-id"]
	notifier.mu.Unlock()
	if tracked {
		t.Fatalf("expiry tracking should be cancelled after delete: %+v", exp)
	}
	sink.assertNoEvent(t, 100*time.Millisecond)
}

func TestWebhookNonOneTimeViewKeepsExpiryTracking(t *testing.T) {
	sink := newWebhookSink(t)
	notifier := newTestNotifier(t, WebhookConfig{URL: sink.server.URL})

	notifier.SecretCreated("multi-view-id", WebhookKindSecret, false, 3600)
	sink.waitForEvent(t) // created
	notifier.SecretViewed("multi-view-id", WebhookKindSecret, false)
	sink.waitForEvent(t) // viewed

	notifier.mu.Lock()
	_, tracked := notifier.expiries["multi-view-id"]
	notifier.mu.Unlock()
	if !tracked {
		t.Fatal("non-one-time secrets must stay tracked for expiry after a view")
	}
}

func TestWebhookRetriesOnFailure(t *testing.T) {
	sink := newWebhookSink(t)
	atomic.StoreInt32(&sink.failures, 2) // first two attempts get a 500
	notifier := newTestNotifier(t, WebhookConfig{URL: sink.server.URL, MaxAttempts: 3})

	notifier.SecretViewed("retry-id", WebhookKindSecret, true)
	d := sink.waitForEvent(t)
	if d.event.Event != WebhookEventSecretViewed {
		t.Fatalf("expected viewed event after retries, got %s", d.event.Event)
	}
}

func TestWebhookGivesUpAfterMaxAttempts(t *testing.T) {
	sink := newWebhookSink(t)
	atomic.StoreInt32(&sink.failures, 99)
	notifier := newTestNotifier(t, WebhookConfig{URL: sink.server.URL, MaxAttempts: 2})

	notifier.SecretViewed("failing-id", WebhookKindSecret, true)
	sink.assertNoEvent(t, 300*time.Millisecond)
	if remaining := atomic.LoadInt32(&sink.failures); remaining != 99-2 {
		t.Errorf("expected exactly 2 delivery attempts, sink saw %d", 99-remaining)
	}
}

func TestWebhookFileEvents(t *testing.T) {
	sink := newWebhookSink(t)
	notifier := newTestNotifier(t, WebhookConfig{URL: sink.server.URL})

	db := newMemoryDB()
	y := Server{
		DB:          db,
		MaxLength:   10000,
		MaxFileSize: 1024 * 1024,
		Registry:    prometheus.NewRegistry(),
		Logger:      zaptest.NewLogger(t),
		License:     LicenseStatus{Valid: true, ExpiresAt: time.Now().Add(24 * time.Hour)},
		Webhooks:    notifier,
	}
	handler := y.HTTPHandler()

	encrypted, err := yopass.EncryptBinary(strings.NewReader("file content"), "key", "file.txt")
	if err != nil {
		t.Fatal(err)
	}
	req, _ := http.NewRequest("POST", "/create/file", bytes.NewReader(encrypted))
	req.Header.Set("Content-Type", "application/octet-stream")
	req.Header.Set("X-Yopass-Expiration", "3600")
	req.Header.Set("X-Yopass-OneTime", "true")
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("upload: status %d body %s", rr.Code, rr.Body.String())
	}
	var created struct {
		Message string `json:"message"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}

	d := sink.waitForEvent(t)
	if d.event.Event != WebhookEventSecretCreated || d.event.Kind != WebhookKindFile {
		t.Fatalf("expected created file event, got %+v", d.event)
	}

	req, _ = http.NewRequest("GET", "/file/"+created.Message, nil)
	rr = httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("download: status %d", rr.Code)
	}
	d = sink.waitForEvent(t)
	if d.event.Event != WebhookEventSecretViewed || d.event.Kind != WebhookKindFile {
		t.Fatalf("expected viewed file event, got %+v", d.event)
	}
}

// TestWebhookRequestLifecycleEvents drives a full secret request through the
// API and verifies the emitted events: created, fulfilled, and no expired
// event once the secret has been collected.
func TestWebhookRequestLifecycleEvents(t *testing.T) {
	sink := newWebhookSink(t)
	notifier := newTestNotifier(t, WebhookConfig{URL: sink.server.URL})

	y := newRequestTestServer(t, newMemoryDB(), true)
	y.Webhooks = notifier
	handler := y.HTTPHandler()

	id, token := createRequest(t, handler, testPublicKey(t), "ticket #4711", 3600)

	d := sink.waitForEvent(t)
	if d.event.Event != WebhookEventRequestCreated {
		t.Fatalf("expected %s, got %s", WebhookEventRequestCreated, d.event.Event)
	}
	if d.event.SecretID != redactSecretID(id) || d.event.Kind != WebhookKindRequest {
		t.Errorf("unexpected created event fields: %+v", d.event)
	}
	if d.event.SecretID == id {
		t.Error("webhook payload must never contain the raw request ID")
	}
	if d.event.ExpirationSeconds != 3600 {
		t.Errorf("expected expiration 3600, got %d", d.event.ExpirationSeconds)
	}

	// Viewing the request info (responder opening the link) emits nothing.
	req, _ := http.NewRequest("GET", "/request/"+id, nil)
	handler.ServeHTTP(httptest.NewRecorder(), req)
	sink.assertNoEvent(t, 100*time.Millisecond)

	// Fulfillment emits request.fulfilled and keeps expiry tracking alive.
	encrypted, err := yopass.Encrypt(strings.NewReader("hunter2"), "key")
	if err != nil {
		t.Fatal(err)
	}
	fulfillBody, _ := json.Marshal(map[string]string{"message": encrypted})
	req, _ = http.NewRequest("POST", "/request/"+id+"/secret", bytes.NewReader(fulfillBody))
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("fulfill: status %d", rr.Code)
	}
	d = sink.waitForEvent(t)
	if d.event.Event != WebhookEventRequestFulfilled || d.event.Kind != WebhookKindRequest {
		t.Fatalf("expected fulfilled event, got %+v", d.event)
	}
	notifier.mu.Lock()
	_, tracked := notifier.expiries[id]
	notifier.mu.Unlock()
	if !tracked {
		t.Fatal("fulfilled requests must stay tracked until collected")
	}

	// Collecting the secret cancels expiry tracking without an event.
	req, _ = http.NewRequest("GET", "/request/"+id+"/secret", nil)
	req.Header.Set(requestTokenHeader, token)
	rr = httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("collect: status %d", rr.Code)
	}
	notifier.mu.Lock()
	_, tracked = notifier.expiries[id]
	notifier.mu.Unlock()
	if tracked {
		t.Fatal("collected requests must not stay expiry-tracked")
	}
	sink.assertNoEvent(t, 100*time.Millisecond)
}

func TestWebhookRequestRevokeCancelsExpiry(t *testing.T) {
	sink := newWebhookSink(t)
	notifier := newTestNotifier(t, WebhookConfig{URL: sink.server.URL})

	y := newRequestTestServer(t, newMemoryDB(), true)
	y.Webhooks = notifier
	handler := y.HTTPHandler()

	id, token := createRequest(t, handler, testPublicKey(t), "", 3600)
	sink.waitForEvent(t) // created

	req, _ := http.NewRequest("DELETE", "/request/"+id, nil)
	req.Header.Set(requestTokenHeader, token)
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusNoContent {
		t.Fatalf("revoke: status %d", rr.Code)
	}

	notifier.mu.Lock()
	_, tracked := notifier.expiries[id]
	notifier.mu.Unlock()
	if tracked {
		t.Fatal("revoked requests must not stay expiry-tracked")
	}
	sink.assertNoEvent(t, 100*time.Millisecond)
}

func TestWebhookRequestExpiredEvent(t *testing.T) {
	sink := newWebhookSink(t)
	notifier := newTestNotifier(t, WebhookConfig{URL: sink.server.URL})

	notifier.RequestCreated("expiring-request", 3600)
	d := sink.waitForEvent(t)
	if d.event.Event != WebhookEventRequestCreated {
		t.Fatalf("expected created event, got %s", d.event.Event)
	}

	// Force the deadline into the past; the watcher tick should pick it up.
	notifier.mu.Lock()
	exp := notifier.expiries["expiring-request"]
	exp.deadline = time.Now().Add(-time.Second)
	notifier.expiries["expiring-request"] = exp
	notifier.mu.Unlock()

	d = sink.waitForEvent(t)
	if d.event.Event != WebhookEventRequestExpired {
		t.Fatalf("expected %s, got %s", WebhookEventRequestExpired, d.event.Event)
	}
	if d.event.Kind != WebhookKindRequest || d.event.ExpirationSeconds != 3600 {
		t.Errorf("unexpected expired event fields: %+v", d.event)
	}
}

func TestWebhookUnsignedDeliveryHasNoSignature(t *testing.T) {
	sink := newWebhookSink(t)
	notifier := newTestNotifier(t, WebhookConfig{URL: sink.server.URL})

	notifier.SecretViewed("unsigned-id", WebhookKindSecret, true)
	d := sink.waitForEvent(t)
	if d.signature != "" {
		t.Errorf("expected no signature header without a secret, got %q", d.signature)
	}
}

// TestWebhookEnqueueDropsWhenQueueFull verifies enqueue never blocks request
// handling even when the receiver is unreachable and the buffer fills up.
func TestWebhookEnqueueDropsWhenQueueFull(t *testing.T) {
	// Point at a closed server so deliveries fail slowly via retries.
	closed := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	closed.Close()

	notifier := newTestNotifier(t, WebhookConfig{
		URL:         closed.URL,
		QueueSize:   1,
		MaxAttempts: 3,
		Backoff:     time.Second,
	})

	done := make(chan struct{})
	go func() {
		for i := 0; i < 50; i++ {
			notifier.SecretViewed(fmt.Sprintf("id-%d", i), WebhookKindSecret, true)
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("enqueue blocked with a full queue")
	}
}
