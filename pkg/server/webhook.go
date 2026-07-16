package server

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sync"
	"time"

	"github.com/jhaals/yopass/pkg/yopass"
	"github.com/prometheus/client_golang/prometheus"
	"go.uber.org/zap"
)

// Webhook event names. A delivery's event name is also carried in the
// X-Yopass-Event header so receivers can route without parsing the body.
const (
	WebhookEventSecretCreated = "secret.created"
	WebhookEventSecretViewed  = "secret.viewed"
	WebhookEventSecretExpired = "secret.expired"

	WebhookEventRequestCreated   = "request.created"
	WebhookEventRequestFulfilled = "request.fulfilled"
	WebhookEventRequestExpired   = "request.expired"
)

// Webhook kinds distinguish text secrets, file uploads and secret requests.
const (
	WebhookKindSecret  = "secret"
	WebhookKindFile    = "file"
	WebhookKindRequest = "request"
)

// webhookSignatureHeader carries the hex-encoded HMAC-SHA256 of the request
// body, prefixed with "sha256=", when a signing secret is configured.
const webhookSignatureHeader = "X-Yopass-Signature"

// WebhookEvent is the JSON payload POSTed to the configured webhook URL.
// The secret ID is the same SHA-256 fingerprint used in audit logs — the raw
// retrieval key is never sent, so a compromised webhook endpoint cannot be
// used to fetch secrets.
type WebhookEvent struct {
	Event             string    `json:"event"`
	Timestamp         time.Time `json:"timestamp"`
	SecretID          string    `json:"secret_id"`
	Kind              string    `json:"kind"`
	OneTime           bool      `json:"one_time"`
	ExpirationSeconds int32     `json:"expiration_seconds,omitempty"`
}

// WebhookConfig configures the notifier. URL is required; everything else has
// a sensible default applied by NewWebhookNotifier.
type WebhookConfig struct {
	// URL receives a POST request per event.
	URL string
	// Secret, when non-empty, is used to sign each payload with HMAC-SHA256.
	Secret string
	// MaxAttempts is the number of delivery attempts per event (default 3).
	MaxAttempts int
	// Timeout is the per-request HTTP timeout (default 10s).
	Timeout time.Duration
	// Backoff is the wait before the first retry; it doubles per attempt
	// (default 2s).
	Backoff time.Duration
	// QueueSize is the event buffer size; events are dropped with a log entry
	// when the buffer is full (default 256).
	QueueSize int
	// ExpiryInterval is how often the expiry watcher scans for elapsed
	// secrets (default 5s).
	ExpiryInterval time.Duration
}

// WebhookNotifier delivers secret lifecycle events to a single operator
// configured URL. Deliveries happen on a background goroutine so request
// handlers never block on the receiver.
//
// Expired events come from an in-memory watcher: every created secret is
// tracked until it is consumed, deleted or its lifetime elapses. The watcher
// state is per-instance and not persisted — after a restart, or for secrets
// created on another instance, no secret.expired events are emitted.
type WebhookNotifier struct {
	cfg        WebhookConfig
	client     *http.Client
	logger     *zap.Logger
	queue      chan WebhookEvent
	stop       chan struct{}
	wg         sync.WaitGroup
	deliveries *prometheus.CounterVec

	mu       sync.Mutex
	expiries map[string]webhookExpiry
}

// webhookExpiry tracks one live secret or request for the expiry watcher.
type webhookExpiry struct {
	kind         string
	oneTime      bool
	lifetime     int32
	deadline     time.Time
	expiredEvent string
}

// NewWebhookNotifier validates the configuration and starts the delivery
// worker and expiry watcher goroutines. Call Stop to shut them down.
// registry may be nil to disable metrics.
func NewWebhookNotifier(cfg WebhookConfig, logger *zap.Logger, registry prometheus.Registerer) (*WebhookNotifier, error) {
	u, err := url.Parse(cfg.URL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil, fmt.Errorf("webhook URL must be an absolute http(s) URL: %q", cfg.URL)
	}
	if cfg.MaxAttempts <= 0 {
		cfg.MaxAttempts = 3
	}
	if cfg.Timeout <= 0 {
		cfg.Timeout = 10 * time.Second
	}
	if cfg.Backoff <= 0 {
		cfg.Backoff = 2 * time.Second
	}
	if cfg.QueueSize <= 0 {
		cfg.QueueSize = 256
	}
	if cfg.ExpiryInterval <= 0 {
		cfg.ExpiryInterval = 5 * time.Second
	}

	n := &WebhookNotifier{
		cfg:      cfg,
		client:   &http.Client{Timeout: cfg.Timeout},
		logger:   logger,
		queue:    make(chan WebhookEvent, cfg.QueueSize),
		stop:     make(chan struct{}),
		expiries: map[string]webhookExpiry{},
	}

	if registry != nil {
		n.deliveries = prometheus.NewCounterVec(
			prometheus.CounterOpts{
				Name: "yopass_webhook_deliveries_total",
				Help: "Webhook delivery attempts by event name and outcome (delivered, failed, dropped).",
			},
			[]string{"event", "outcome"},
		)
		registry.MustRegister(n.deliveries)
	}

	n.wg.Add(2)
	go n.deliveryWorker()
	go n.expiryWatcher()
	return n, nil
}

// Stop shuts down the background goroutines. Queued events that have not
// started delivery are discarded; an in-flight delivery finishes its current
// HTTP attempt.
func (n *WebhookNotifier) Stop() {
	close(n.stop)
	n.wg.Wait()
}

// trackExpiry registers an entry with the expiry watcher.
func (n *WebhookNotifier) trackExpiry(id string, exp webhookExpiry) {
	exp.deadline = time.Now().Add(time.Duration(exp.lifetime) * time.Second)
	n.mu.Lock()
	n.expiries[id] = exp
	n.mu.Unlock()
}

// SecretCreated enqueues a created event and starts expiry tracking.
// id is the raw secret key; it is fingerprinted before leaving the process.
func (n *WebhookNotifier) SecretCreated(id, kind string, oneTime bool, expiration int32) {
	n.trackExpiry(id, webhookExpiry{
		kind:         kind,
		oneTime:      oneTime,
		lifetime:     expiration,
		expiredEvent: WebhookEventSecretExpired,
	})
	n.enqueue(WebhookEvent{
		Event:             WebhookEventSecretCreated,
		SecretID:          redactSecretID(id),
		Kind:              kind,
		OneTime:           oneTime,
		ExpirationSeconds: expiration,
	})
}

// SecretViewed enqueues a viewed event. One-time secrets are deleted on view,
// so their expiry tracking is cancelled; other secrets keep their tracker and
// still produce an expired event when their lifetime elapses.
func (n *WebhookNotifier) SecretViewed(id, kind string, oneTime bool) {
	if oneTime {
		n.cancelExpiry(id)
	}
	n.enqueue(WebhookEvent{
		Event:    WebhookEventSecretViewed,
		SecretID: redactSecretID(id),
		Kind:     kind,
		OneTime:  oneTime,
	})
}

// SecretDeleted cancels expiry tracking for an explicitly deleted secret.
// Deletion ahead of expiry does not emit an event of its own.
func (n *WebhookNotifier) SecretDeleted(id string) {
	n.cancelExpiry(id)
}

// RequestCreated enqueues a created event for a secret request and starts
// expiry tracking.
func (n *WebhookNotifier) RequestCreated(id string, expiration int32) {
	n.trackExpiry(id, webhookExpiry{
		kind:         WebhookKindRequest,
		lifetime:     expiration,
		expiredEvent: WebhookEventRequestExpired,
	})
	n.enqueue(WebhookEvent{
		Event:             WebhookEventRequestCreated,
		SecretID:          redactSecretID(id),
		Kind:              WebhookKindRequest,
		ExpirationSeconds: expiration,
	})
}

// RequestFulfilled enqueues a fulfilled event: a responder provided the
// secret. The request stays tracked — a fulfilled request that is never
// collected still produces a request.expired event.
func (n *WebhookNotifier) RequestFulfilled(id string) {
	n.enqueue(WebhookEvent{
		Event:    WebhookEventRequestFulfilled,
		SecretID: redactSecretID(id),
		Kind:     WebhookKindRequest,
	})
}

// RequestClosed cancels expiry tracking for a request that ceased to exist
// before its lifetime ended: the requester collected the secret or revoked
// the request. Neither emits an event of its own, mirroring secret deletion.
func (n *WebhookNotifier) RequestClosed(id string) {
	n.cancelExpiry(id)
}

func (n *WebhookNotifier) cancelExpiry(id string) {
	n.mu.Lock()
	delete(n.expiries, id)
	n.mu.Unlock()
}

// enqueue hands an event to the delivery worker without blocking; when the
// buffer is full the event is dropped and logged.
func (n *WebhookNotifier) enqueue(e WebhookEvent) {
	e.Timestamp = time.Now().UTC()
	select {
	case n.queue <- e:
	default:
		n.logger.Warn("webhook: queue full, dropping event",
			zap.String("event", e.Event), zap.String("secret_id", e.SecretID))
		n.countDelivery(e.Event, "dropped")
	}
}

func (n *WebhookNotifier) countDelivery(event, outcome string) {
	if n.deliveries != nil {
		n.deliveries.WithLabelValues(event, outcome).Inc()
	}
}

func (n *WebhookNotifier) deliveryWorker() {
	defer n.wg.Done()
	for {
		select {
		case e := <-n.queue:
			n.deliver(e)
		case <-n.stop:
			return
		}
	}
}

// expiryWatcher periodically emits expired events for tracked secrets whose
// lifetime has elapsed.
func (n *WebhookNotifier) expiryWatcher() {
	defer n.wg.Done()
	ticker := time.NewTicker(n.cfg.ExpiryInterval)
	defer ticker.Stop()
	for {
		select {
		case now := <-ticker.C:
			for id, exp := range n.takeExpired(now) {
				n.enqueue(WebhookEvent{
					Event:             exp.expiredEvent,
					SecretID:          redactSecretID(id),
					Kind:              exp.kind,
					OneTime:           exp.oneTime,
					ExpirationSeconds: exp.lifetime,
				})
			}
		case <-n.stop:
			return
		}
	}
}

// takeExpired removes and returns all tracked secrets whose deadline passed.
func (n *WebhookNotifier) takeExpired(now time.Time) map[string]webhookExpiry {
	n.mu.Lock()
	defer n.mu.Unlock()
	var due map[string]webhookExpiry
	for id, exp := range n.expiries {
		if exp.deadline.After(now) {
			continue
		}
		if due == nil {
			due = map[string]webhookExpiry{}
		}
		due[id] = exp
		delete(n.expiries, id)
	}
	return due
}

// deliver POSTs one event, retrying with exponential backoff on network
// errors and non-2xx responses.
func (n *WebhookNotifier) deliver(e WebhookEvent) {
	body, err := json.Marshal(e)
	if err != nil {
		n.logger.Error("webhook: failed to encode event", zap.Error(err))
		n.countDelivery(e.Event, "failed")
		return
	}

	// A delivery ID lets receivers deduplicate retries of the same event.
	deliveryID, err := yopass.GenerateID()
	if err != nil {
		deliveryID = ""
	}

	backoff := n.cfg.Backoff
	for attempt := 1; attempt <= n.cfg.MaxAttempts; attempt++ {
		if n.attempt(e.Event, deliveryID, body) {
			n.countDelivery(e.Event, "delivered")
			return
		}
		if attempt < n.cfg.MaxAttempts {
			select {
			case <-time.After(backoff):
				backoff *= 2
			case <-n.stop:
				n.countDelivery(e.Event, "failed")
				return
			}
		}
	}
	n.logger.Error("webhook: delivery failed permanently",
		zap.String("event", e.Event),
		zap.String("secret_id", e.SecretID),
		zap.Int("attempts", n.cfg.MaxAttempts),
	)
	n.countDelivery(e.Event, "failed")
}

// attempt performs a single delivery attempt and reports success.
func (n *WebhookNotifier) attempt(event, deliveryID string, body []byte) bool {
	ctx, cancel := context.WithTimeout(context.Background(), n.cfg.Timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, n.cfg.URL, bytes.NewReader(body))
	if err != nil {
		n.logger.Error("webhook: failed to build request", zap.Error(err))
		return false
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "yopass-webhook")
	req.Header.Set("X-Yopass-Event", event)
	if deliveryID != "" {
		req.Header.Set("X-Yopass-Delivery", deliveryID)
	}
	if n.cfg.Secret != "" {
		req.Header.Set(webhookSignatureHeader, "sha256="+signWebhookBody(n.cfg.Secret, body))
	}

	resp, err := n.client.Do(req)
	if err != nil {
		n.logger.Warn("webhook: delivery attempt failed", zap.String("event", event), zap.Error(err))
		return false
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		n.logger.Warn("webhook: receiver returned non-2xx status",
			zap.String("event", event), zap.Int("status", resp.StatusCode))
		return false
	}
	return true
}

// signWebhookBody returns the hex HMAC-SHA256 of body keyed with secret.
func signWebhookBody(secret string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}

// The Server wrappers below are nil-safe so handlers can call them
// unconditionally whether or not webhooks are configured.

func (y *Server) webhookCreated(id, kind string, oneTime bool, expiration int32) {
	if y.Webhooks != nil && y.License.CurrentlyValid() {
		y.Webhooks.SecretCreated(id, kind, oneTime, expiration)
	}
}

func (y *Server) webhookViewed(id, kind string, oneTime bool) {
	if y.Webhooks != nil && y.License.CurrentlyValid() {
		y.Webhooks.SecretViewed(id, kind, oneTime)
	}
}

func (y *Server) webhookDeleted(id string) {
	if y.Webhooks != nil && y.License.CurrentlyValid() {
		y.Webhooks.SecretDeleted(id)
	}
}

func (y *Server) webhookRequestCreated(id string, expiration int32) {
	if y.Webhooks != nil && y.License.CurrentlyValid() {
		y.Webhooks.RequestCreated(id, expiration)
	}
}

func (y *Server) webhookRequestFulfilled(id string) {
	if y.Webhooks != nil && y.License.CurrentlyValid() {
		y.Webhooks.RequestFulfilled(id)
	}
}

func (y *Server) webhookRequestClosed(id string) {
	if y.Webhooks != nil && y.License.CurrentlyValid() {
		y.Webhooks.RequestClosed(id)
	}
}
