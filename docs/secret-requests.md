---
title: Secret Requests
sidebar_position: 6.5
description: Ask someone to send you a secret through an end-to-end encrypted request link. License required.
---

# Secret Requests

Sharing a secret is only half the story — often you need to **receive** one: a customer's API key, a database password from a colleague, credentials from a contractor. Secret requests turn the Yopass flow around while keeping the same end-to-end encryption guarantees.

Instead of asking someone to "just email it", you send them a request link. Whatever they type — or whatever file they upload — is encrypted **in their browser** with a public key that belongs to you, and can only be decrypted **in your browser** with a private key that never leaves it. The Yopass server only ever sees a public key and ciphertext. That includes the label and note you attach to a request: they are encrypted in your browser too.

> **Requires a valid license.** Secret requests are a business feature gated behind `--license-key`.

---

## How it works

1. **Create a request.** Your browser generates a fresh ECC key pair. The public key is registered on the server together with an optional label, an optional note and an expiration (1 hour, 1 day, or 1 week; custom durations when the server enables [`--allow-custom-expiration`](server-options#custom-expiration)). The label and note are encrypted in your browser with a random key before they are sent, so the server stores only their ciphertext. The private key, that label key and a management token are stored only in your browser.
2. **Share the link.** The request link (`https://yopass.example.com/#/r/<id>/<fingerprint>/<key>`) can be sent over any channel — chat, a support ticket, email. The fingerprint lets the responder's browser verify the encryption key it receives from the server, and the key decrypts the label and note. Both sit in the URL fragment, which is never sent to the server. A request with neither a label nor a note has no `<key>` part.
3. **The responder submits the secret.** They open the link and either type the secret or upload a file (a certificate, a key file, a kubeconfig). Either way it is encrypted with your public key before leaving their browser. No account, no app, nothing to install.
4. **You collect the secret.** The request list shows the state of every request. Once a secret is provided you decrypt it locally — a text secret is shown for copying, a file is offered for download under its original name — and the ciphertext is **deleted from the server the moment you retrieve it**.

### File responses

The responder can answer a request with a file instead of text. The file's content **and its filename** are placed inside the encrypted OpenPGP message, so the server never learns either — it only stores the ciphertext and the fact that a file (rather than text) was provided, which it uses for size-limit enforcement and the requester uses to choose text or file presentation.

- File responses are limited to **512&nbsp;KB**, or [`--max-file-size`](server-options) if that is lower. The limit is deliberately independent of large `--max-file-size` values: unlike regular uploads, file responses are always stored in the **database backend** (never the disk/S3 file store) because they ride on the request record, and the cap keeps the full armored record within Memcached's default 1&nbsp;MB item limit — no backend tuning required. The effective limit is exposed to the frontend as `MAX_REQUEST_FILE_SIZE` in `/config`.
- File responses are turned off together with regular uploads via `--disable-upload`; the responder then only sees the text input.
- Requests fulfilled by servers or clients predating this feature are treated as text — old and new versions interoperate.

### Request states

| State | Meaning |
|-------|---------|
| **Awaiting secret** | The link is live, nothing has been submitted yet |
| **Secret provided** | A secret is waiting — open it to decrypt and consume it |
| **Collected** | You retrieved the secret; it no longer exists on the server |
| **Expired** | The expiration passed before a secret was provided |
| **Revoked** | You cancelled the request; the link is dead |

### Managing requests

The **Requests** page in the web UI lists every request created in the browser, with live status:

![Secret requests list showing requests in different states](/img/secret-requests.png)

- **Copy link** — share a pending request again.
- **Revoke** — kill the link immediately. Any secret already provided is deleted from the server.
- **Replace key pair** — generate a new key pair and swap the public key on the server. Use this if you lost the private key (for example, the request was created in another browser) and the request is still pending. Previously shared links will fail their fingerprint check, so share the new link afterwards. The label and note keep their key.
- **Export / Import** — move a request (including its private key, label key and management token) to another browser as a JSON file. Treat the export as a secret. An import never replaces a request that is already in the list with a different private key or token; remove that entry from the list first if you want to replace it.
- **Clear collected** — remove all already-collected requests (and their private keys) from the browser. The secrets themselves were deleted from the server the moment they were viewed.
- **Purge all** — revoke every active request on the server in one go and wipe everything stored in the browser: links stop working, provided-but-uncollected secrets are deleted, and all private keys and tokens are removed. Requests whose revocation fails (for example a network error) stay in the list so their keys are not lost.

The **Requests** entry in the navigation bar shows a counter badge with the number of requests whose secret is waiting to be collected, so a provided secret is hard to miss.

---

## Security model

- **End-to-end encryption.** The secret is encrypted with OpenPGP public-key cryptography in the responder's browser. The server stores only the public key and the resulting ciphertext. For file responses the filename is inside the ciphertext too — the server sees neither the content nor the name of the file.
- **Private key never leaves the browser.** It is kept in `localStorage` and is included only in explicit exports made by the user.
- **Link integrity verification.** The link fragment carries the public key fingerprint. Since URL fragments are never sent to the server, a server that swapped the public key (to read secrets in transit) is detected by the responder's browser, which refuses to submit.
- **One-time retrieval.** Retrieving the provided secret deletes it from the server before the response is sent. Viewing it in the web UI is therefore a one-shot action — the UI asks for confirmation first, and once shown, the secret exists only in your browser until you copy or download it.
- **Labels and notes are encrypted in the browser.** The label tells the responder what to provide and the optional note gives longer instructions. Both are encrypted in the requester's browser as OpenPGP password-encrypted messages, with one random key that exists only in the link fragment and in the requester's browser. The server stores and returns ciphertext and rejects a label or note that is not an OpenPGP message. **Anyone who has the request link can read them**, so they are as private as the channel you send the link over: do not put credentials in them.
- **A link without its key is refused.** If the key is missing or wrong (a chat app that cut the link short, for example), the responder's browser shows no form and asks them to get the full link from the requester. With a key in the link, a label or note that does not decrypt with it is refused as well, so the server cannot replace them with text of its own.
- **Limits.** A label is at most 100 characters and a note at most `--max-request-note-length` characters (default `1000`, max `10000`; `0` disables notes). The web UI enforces these. The server cannot count encrypted characters, so it caps the size of the ciphertext instead, with room for that many characters. The note is cleared from the server once the request is fulfilled.
- **Requests created before an upgrade.** Requests made by an older version keep their plaintext label and note, and their shorter links, until they expire. Nothing is migrated.
- **Management token.** Retrieval, revocation, and key rotation require a token returned once at creation time and stored alongside the private key. A bare request ID grants no control over the request.
- **Atomic lifecycle transitions.** State changes (fulfill, key rotation) are applied with compare-and-swap operations in the storage backend, so concurrent attempts cannot overwrite each other's secret or resurrect a revoked request — including when multiple yopass instances share one Redis or Memcached backend.
- **Audit trail.** With [audit logging](audit-logging) enabled, every interaction is recorded — `request.created`, `request.viewed` (a responder opening the link), `request.fulfilled`, `request.secret_accessed`, `request.revoked`, and `request.key_rotated` — including denied and failed attempts, without ever logging secret content. A purge from the UI is recorded as one `request.revoked` event per active request.

---

## Enabling secret requests

Secret requests are enabled automatically when a valid license key is configured:

```bash
yopass-server --license-key "your-license-key"
```

| Flag | Env var | Default | Description |
|------|---------|---------|-------------|
| `--disable-secret-requests` | `DISABLE_SECRET_REQUESTS` | `false` | Turn the feature off even with a valid license |
| `--max-request-note-length` | `MAX_REQUEST_NOTE_LENGTH` | `1000` | Max characters in the optional note (`0` disables notes, max `10000`). The server sizes its cap on the encrypted note from this |

The feature is unavailable in [read-only mode](read-only-mode). The frontend discovers it through the `SECRET_REQUESTS` field of the `/config` endpoint.

---

## REST API

Everything the web UI does is available over plain HTTP, which makes it straightforward to wire secret requests into ticketing systems, chat bots, or onboarding automation. All bodies are JSON.

### Create a request

```bash
curl -X POST https://yopass.example.com/request \
  -H 'Content-Type: application/json' \
  -d '{
    "public_key": "-----BEGIN PGP PUBLIC KEY BLOCK----- ...",
    "label": "-----BEGIN PGP MESSAGE----- ...",
    "note": "-----BEGIN PGP MESSAGE----- ...",
    "expiration": 86400
  }'
```

```json
{
  "id": "5Hp2…",
  "token": "wXg9…",
  "expires_at": 1765465600
}
```

`expiration` is one of `3600`, `86400`, or `604800` seconds, or any whole number of seconds within the server's bounds when custom expiration is enabled. If the server sets `--force-expiration`, only that duration is accepted. Keep the `token` secret — it authorizes retrieval, revocation, and key rotation. The link to hand out is `https://yopass.example.com/#/r/<id>/<fingerprint>`, where `<fingerprint>` is the last 16 hex characters of the public key fingerprint. If you sent a label or note, append the key they are encrypted with: `.../#/r/<id>/<fingerprint>/<key>`.

The web UI only answers requests whose public key and subkeys use Curve25519 (Ed25519 with X25519, or their legacy OpenPGP forms), the kind of key it generates itself. For any other key, such as RSA, the responder sees "Key verification failed" instead of the form.

#### Encrypting the label and note

`label` and `note` are both optional. When you send one, it must be an ASCII-armored OpenPGP message encrypted with a password, and both must use the same password. The server answers `400` to plain text. Leave both out and nothing changes: no key, and the link keeps its two parts.

Pick a random key that is safe in a URL, encrypt each text with it, and put it at the end of the link. With GnuPG and `jq`:

```bash
KEY=$(openssl rand -hex 16)
seal() {
  printf '%s' "$1" |
    gpg --batch --pinentry-mode loopback --passphrase-fd 3 --symmetric --armor 3<<<"$KEY"
}

jq -n \
  --arg public_key "$(cat request-public-key.asc)" \
  --arg label "$(seal 'Production API key for ticket #4711')" \
  --arg note "$(seal 'The read-only key is enough.')" \
  '{public_key: $public_key, label: $label, note: $note, expiration: 86400}' |
  curl -X POST https://yopass.example.com/request \
    -H 'Content-Type: application/json' -d @-

# The link: https://yopass.example.com/#/r/<id>/<fingerprint>/$KEY
```

Any OpenPGP implementation works, within the limits the web UI applies before it decrypts a message from someone else: iterated-and-salted or Argon2 key derivation at ordinary cost (GnuPG's defaults fit), and at most 1&nbsp;MiB after decompression. Keep the label to 100 characters and the note to `MAX_REQUEST_NOTE_LENGTH` from `/config`; the web UI cuts a longer label off. The server caps the size of the ciphertext and rejects a larger one, or any note when `--max-request-note-length` is `0`, with `400`.

Hand out the complete link. A responder who opens it without the key, or with the wrong one, is told the link is incomplete and cannot submit.

### Check the state of a request

```bash
curl https://yopass.example.com/request/<id>
```

```json
{
  "public_key": "-----BEGIN PGP PUBLIC KEY BLOCK----- ...",
  "key_version": "b8c8d54f-640c-4c41-bda8-f2ed285dbe3d",
  "label": "-----BEGIN PGP MESSAGE----- ...",
  "note": "-----BEGIN PGP MESSAGE----- ...",
  "state": "pending",
  "expires_at": 1765465600
}
```

`state` is `pending` or `fulfilled`; an expired or revoked request returns `404`. Polling this endpoint is how an integration knows when to fetch.

### Submit a secret (responder side)

```bash
curl -X POST https://yopass.example.com/request/<id>/secret \
  -H 'Content-Type: application/json' \
  -d '{"message": "-----BEGIN PGP MESSAGE----- ...", "kind": "text", "key_version": "b8c8d54f-640c-4c41-bda8-f2ed285dbe3d"}'
```

The message must be PGP-encrypted with the request's public key. A request can be fulfilled exactly once; a second attempt returns `409`.

Echo the `key_version` from the same lookup that supplied the public key used for encryption. It is an empty string before the first key replacement. If the key changes before submission, the server returns `412` and leaves the request pending; ask the requester for the new verified link.

`kind` is optional and defaults to `text`. Use `kind: "file"` when the encrypted message carries a file: the message is then bounded by the file response limit (512&nbsp;KB, or `--max-file-size` if lower) instead of `--max-length`, and rejected when uploads are disabled (`--disable-upload`). For file responses the filename should be embedded in the OpenPGP literal data packet (as the web UI does), so it stays end-to-end encrypted. The Go server also caps the stored request record at 1&nbsp;MiB (or twice `--max-length` for text, if larger); a response that would exceed it is rejected with `413` for a file or `400` for text, and the request stays pending.

### Retrieve the secret (one-time)

```bash
curl https://yopass.example.com/request/<id>/secret \
  -H 'X-Yopass-Request-Token: <token>'
```

```json
{
  "message": "-----BEGIN PGP MESSAGE----- ...",
  "kind": "text"
}
```

Returns the ciphertext and deletes the request from the server. Decrypt with the private key locally. `kind` is `text` or `file` and determines presentation; older responses without it are treated as text. A filename inside a text response does not turn it into a file. For a file, the decrypted literal data packet carries the filename and the binary content.

### Revoke a request

```bash
curl -X DELETE https://yopass.example.com/request/<id> \
  -H 'X-Yopass-Request-Token: <token>'
```

### Replace the public key

```bash
curl -X PUT https://yopass.example.com/request/<id>/key \
  -H 'X-Yopass-Request-Token: <token>' \
  -H 'Content-Type: application/json' \
  -d '{"public_key": "-----BEGIN PGP PUBLIC KEY BLOCK----- ..."}'
```

Only allowed while the request is pending.

---

## Integration patterns

The API is deliberately small so secret requests can ride along in existing workflows:

- **Ticketing (Jira, ServiceNow, Zendesk):** when an agent needs credentials from a customer, an automation creates a request, posts the link as a ticket comment, and polls `GET /request/<id>` — when the state flips to `fulfilled`, it notifies the agent to collect the secret in their browser. The agent's key pair stays in the agent's browser; the automation only handles the link. With [webhooks](webhooks) configured, the `request.fulfilled` event replaces the polling entirely.
- **Onboarding automation:** generate request links as part of provisioning flows ("submit your signing certificate here") instead of accepting credentials over email.

In every pattern the integration works with **links and states, never with secrets** — the cryptography stays between the two browsers.

### Key rotation and API clients

Responder clients must send the `key_version` returned by `GET /request/{id}` with `POST /request/{id}/secret`. The version is checked atomically with fulfillment; a stale version returns `412` and leaves the request pending. Ask the requester for their new link instead of encrypting to a replacement key without verifying its fingerprint. Requests that have never had their key replaced still accept a missing or empty version for compatibility. Clients that omit the version cannot fulfill a request after key replacement.

Database lookup failures return `503 Database temporarily unavailable`, allowing clients to retry. A transient storage outage is not reported as a missing or expired record (`404`).
