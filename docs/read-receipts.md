---
title: Read Receipts
sidebar_position: 6.6
description: Know exactly when a secret you shared was opened. License required.
---

# Read Receipts

"Did they get it?" is the question every secret sender asks. Read receipts answer it with proof: when you create a secret with a read receipt, you can check — and watch live in the UI — whether the secret has been opened, and exactly when.

> **Requires a valid license.** Read receipts are a business feature gated behind `--license-key`. For server-to-server notifications about secret activity, see [Webhooks](webhooks).

---

## How it works

1. **Create a secret with a read receipt.** Tick *Read receipt* in the web UI (or pass `"receipt": true` to the API). Along with the secret link, the server returns a **receipt token** that stays with you. File uploads support receipts the same way — the toggle appears on the upload form too.
2. **Share the link as usual.** Nothing changes for the recipient — they don't see or interact with the receipt.
3. **Watch the status.** The result page polls the receipt automatically and flips from *Not opened yet* to *Opened \<time\>* the moment the recipient decrypts the secret. The same status is available over the REST API using the receipt token.

The receipt lives exactly as long as the secret's chosen lifetime — even when a one-time secret is consumed earlier, the receipt stays checkable until the original expiration. After that the receipt is gone, like everything else in Yopass.

### The Receipts page

You don't have to keep the result page open. Every receipt created in the browser is kept in `localStorage` and listed on the **Receipts** page in the navigation bar, with live status:

- **Not opened** — the link is out there, nobody has used it yet (shows when the receipt expires).
- **Opened** — with the exact time. The browser caches this state locally, so the opened time remains visible even after the receipt itself has expired on the server.
- **Expired** — the secret's lifetime passed without it ever being opened.

Only the receipt token and timestamps are stored — **never the secret link or decryption key** — so the list cannot be used to retrieve any secret. Removing an entry (or *Clear all*) discards the token; after that the receipt can no longer be checked from anywhere.

### Receipt states

| State | Meaning |
|-------|---------|
| **pending** | The secret has not been opened yet |
| **viewed** | The secret was opened; `viewed_at` records when |
| *(404)* | The receipt expired — the secret's lifetime has passed |

A secret that expires before being opened simply takes its receipt with it: a `404` after creation means the secret was never read in time. The web UI shows this as *"The secret expired before it was opened"*.

---

## Security model

- **No secret content, ever.** The receipt stores only state and timestamps. It is kept under a namespaced database key that cannot be reached through the `/secret/{key}` endpoints.
- **Receipt token.** Checking a receipt requires a token returned once at creation time. The server stores only its SHA-256 hash and compares in constant time. The secret ID alone reveals nothing.
- **Local persistence is metadata-only.** The browser's Receipts page stores the receipt token, secret ID, and timestamps in `localStorage` — the secret link and decryption key are never persisted.
- **No recipient tracking.** The receipt records *that* and *when* the secret was opened — not who opened it or from where. (With [audit logging](audit-logging) enabled, the server operator separately records client IPs for all secret access.)
- **Prefetch-safe.** The "this secret can only be viewed once" warning page does not mark the receipt as viewed; only actual retrieval of the secret content does.
- **Split deployments.** Receipt status checking and viewed-marking work on [read-only](read-only-mode) replicas too, even without a license on the replica — the receipt is created on the licensed write instance.
- **Audit trail.** Receipt checks are recorded as `secret.receipt_checked` events, including denied attempts with a wrong token.

---

## Enabling read receipts

Read receipts are enabled automatically when a valid license key is configured:

```bash
yopass-server --license-key "your-license-key"
```

| Flag | Env var | Default | Description |
|------|---------|---------|-------------|
| `--disable-read-receipts` | `DISABLE_READ_RECEIPTS` | `false` | Turn the feature off even with a valid license |

The frontend discovers the feature through the `READ_RECEIPTS` field of the `/config` endpoint. Creating a secret with `"receipt": true` on a server without the feature returns `400`.

---

## REST API

### Create a secret with a read receipt

```bash
curl -X POST https://yopass.example.com/create/secret \
  -H 'Content-Type: application/json' \
  -d '{
    "message": "-----BEGIN PGP MESSAGE----- ...",
    "expiration": 86400,
    "one_time": true,
    "receipt": true
  }'
```

```json
{
  "message": "8GjMyrJDkLwmnvKg9N1bzS",
  "receipt_token": "wXg9…"
}
```

Keep the `receipt_token` — it is shown exactly once and authorizes status checks.

### Create a file upload with a read receipt

For streaming file uploads the receipt is requested with a header:

```bash
curl -X POST https://yopass.example.com/create/file \
  -H 'Content-Type: application/octet-stream' \
  -H 'X-Yopass-Expiration: 86400' \
  -H 'X-Yopass-OneTime: true' \
  -H 'X-Yopass-Receipt: true' \
  --data-binary @encrypted.bin
```

The response carries the same `receipt_token` field. File receipts are checkable via `GET /file/<id>/receipt` or `GET /secret/<id>/receipt` — the two routes are equivalent.

### Check the receipt

```bash
curl https://yopass.example.com/secret/<id>/receipt \
  -H 'X-Yopass-Receipt-Token: <receipt_token>'
```

Before the secret is opened:

```json
{
  "state": "pending",
  "one_time": true,
  "created_at": 1765379200,
  "expires_at": 1765465600
}
```

After it is opened:

```json
{
  "state": "viewed",
  "one_time": true,
  "created_at": 1765379200,
  "viewed_at": 1765380101,
  "expires_at": 1765465600
}
```

A wrong or missing token returns `401`. A receipt that never existed or has expired returns `404`. The receipt can be checked any number of times until it expires.

### Polling pattern

Receipts are pull-based: an integration that wants to act on retrieval ("close the ticket when the customer has picked up the credentials") polls `GET /secret/<id>/receipt` and reacts when `state` becomes `viewed`. If your integration controls the server, [webhooks](webhooks) push a `secret.viewed` event instead — no polling required.
