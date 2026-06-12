---
title: Webhooks
sidebar_position: 6.7
description: Push secret lifecycle events (created, viewed, expired) to your own systems. License required.
---

# Webhooks

Webhooks push secret lifecycle events to an HTTP endpoint you control, in real time. They are the integration point for everything that wants to *react* to secret activity — SIEM pipelines, chat notifications, ticket automation, compliance evidence — without polling and without parsing logs.

> **Requires a valid license.** Webhooks are a business feature gated behind `--license-key`. For a per-secret "was it opened?" check available to the secret *creator*, see [Read Receipts](read-receipts).

---

## Events

| Event | Fired when |
|-------|-----------|
| `secret.created` | A secret or file was stored (`POST /create/secret`, `POST /create/file`) |
| `secret.viewed` | A secret or file was retrieved (`GET /secret/{key}`, `GET /file/{key}`) |
| `secret.expired` | A secret's lifetime elapsed without it being viewed (one-time) or deleted |
| `request.created` | A [secret request](secret-requests) was registered (`POST /request`) |
| `request.fulfilled` | A responder provided the secret for a request (`POST /request/{id}/secret`) |
| `request.expired` | A request's lifetime elapsed without the secret being collected or the request revoked |

Notes on semantics:

- A **one-time** secret that is viewed never produces `secret.expired` — it ceased to exist at view time.
- A **non-one-time** secret produces `secret.viewed` for *every* retrieval, and still produces `secret.expired` when its lifetime ends.
- An explicit `DELETE` produces no event and cancels the pending `secret.expired`.
- A **fulfilled request** stays tracked: if the requester never collects the secret, `request.expired` still fires — a useful signal that a provided secret is going stale.
- **Collecting** the secret or **revoking** the request produces no event and cancels the pending `request.expired`, mirroring secret deletion. A responder merely *opening* the request link emits nothing (that is recorded as `request.viewed` in the [audit log](audit-logging)).

---

## Payload

Each event is delivered as an HTTP `POST` with a JSON body:

```json
{
  "event": "secret.viewed",
  "timestamp": "2026-06-11T13:37:00.000000042Z",
  "secret_id": "a1b2c3d4e5f6",
  "kind": "secret",
  "one_time": true,
  "expiration_seconds": 3600
}
```

| Field | Description |
|-------|-------------|
| `event` | One of the event names above |
| `timestamp` | When the event occurred (UTC, RFC 3339) |
| `secret_id` | A short SHA-256 fingerprint of the secret or request ID — the same identifier used in [audit logs](audit-logging), so events and log lines correlate directly |
| `kind` | `secret` (text), `file` (upload), or `request` (secret request) |
| `one_time` | Whether the secret was one-time (always `false` for requests) |
| `expiration_seconds` | The secret's or request's lifetime (`created` and `expired` events) |

**The payload never contains secret content, decryption keys, or the raw secret ID.** A compromised webhook endpoint learns that *something* was created or viewed, but gains nothing that could retrieve a secret.

### Correlating events with your secrets

The fingerprint is deterministic, so anyone who knows a secret's raw ID (the path segment of the share link, returned by `POST /create/secret`) can map incoming webhooks to it — while the webhook receiver alone can never go the other way:

```
secret_id = first 12 hex characters of SHA-256(raw secret ID)
```

```bash
printf '%s' '8GjMyrJDkLwmnvKg9N1bzS' | sha256sum | cut -c1-12
```

```python
import hashlib
fingerprint = hashlib.sha256(raw_id.encode()).hexdigest()[:12]
```

A typical integration computes the fingerprint at creation time, stores it next to its own reference (ticket number, run ID), and looks it up when `secret.viewed` or `request.fulfilled` arrives. Audit log entries use the same fingerprint, so all three sources line up. Note that the *decryption key* plays no role here — it never reaches the server and is not part of any event.

The same scheme applies to secret requests: `request.*` events carry the fingerprint of the request ID returned by `POST /request`, so an integration that created a request can match its fulfillment without polling. The management token plays no role in events.

### Request headers

| Header | Description |
|--------|-------------|
| `Content-Type` | `application/json` |
| `User-Agent` | `yopass-webhook` |
| `X-Yopass-Event` | The event name, for routing without parsing the body |
| `X-Yopass-Delivery` | A unique ID per event, repeated across retries — use it to deduplicate |
| `X-Yopass-Signature` | `sha256=<hex HMAC>` of the body (only when `--webhook-secret` is set) |

---

## Verifying signatures

Set `--webhook-secret` so receivers can authenticate deliveries. The signature is an HMAC-SHA256 of the raw request body, hex-encoded and prefixed with `sha256=`:

```python
import hashlib, hmac

def verify(secret: str, body: bytes, signature_header: str) -> bool:
    expected = "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature_header)
```

```js
const crypto = require('crypto');

function verify(secret, body, signatureHeader) {
  const expected =
    'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
  return crypto.timingSafeEqual(
    Buffer.from(expected),
    Buffer.from(signatureHeader),
  );
}
```

Always compare with a constant-time function and compute the HMAC over the **raw** body bytes, before any JSON parsing.

---

## Delivery and retries

- Deliveries happen asynchronously — a slow or unreachable receiver never delays secret creation or retrieval.
- A delivery is considered successful on any `2xx` response.
- Failed deliveries are retried up to **3 attempts** with exponential backoff (2s, then 4s). Retries reuse the same `X-Yopass-Delivery` ID.
- Permanently failed and dropped events are logged and counted in the `yopass_webhook_deliveries_total` Prometheus metric (labels: `event`, `outcome` = `delivered` / `failed` / `dropped`). See [Metrics](metrics).

### Limitations

- **Expired events are tracked in memory.** Expiry timers live in the server process: after a restart, secrets and requests created before the restart will not produce `secret.expired` / `request.expired` events (all other events are unaffected — they fire inline with the request). In multi-instance deployments the expired event is emitted by the instance that created the secret or request.
- One webhook URL per server. Fan-out to multiple consumers is a job for the receiving end (or a queue).
- Events are delivered in order per instance under normal operation, but ordering is not guaranteed across retries — use `timestamp` for sequencing.

---

## Enabling webhooks

```bash
yopass-server \
  --license-key "your-license-key" \
  --webhook-url "https://hooks.example.com/yopass" \
  --webhook-secret "$(openssl rand -hex 32)"
```

| Flag | Env var | Default | Description |
|------|---------|---------|-------------|
| `--webhook-url` | `WEBHOOK_URL` | — | Endpoint receiving event POSTs; must be an absolute `http(s)` URL |
| `--webhook-secret` | `WEBHOOK_SECRET` | — | HMAC-SHA256 signing key for the `X-Yopass-Signature` header |

The server refuses to start when `--webhook-url` is set without a valid license key.

---

## Integration patterns

- **Compliance / proof of retrieval:** forward `secret.viewed` events into your SIEM next to the audit log. The shared `secret_id` fingerprint ties the webhook event, the audit record, and (via the creator's own knowledge of the raw ID) the original secret together.
- **Chat notifications:** a tiny receiver that posts "🔓 a secret was just opened" to a channel when `secret.viewed` arrives.
- **Hygiene monitoring:** alert on `secret.expired` — secrets that expire unread often mean a link never arrived, or a process is sending secrets nobody picks up.
