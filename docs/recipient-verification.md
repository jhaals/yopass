---
title: Recipient Verification
sidebar_position: 6.7
description: Bind a secret to specific email addresses, confirmed by a one-time code. License required.
---

# Recipient Verification

By default, whoever holds a Yopass link can open the secret. Recipient verification changes that: the creator names the email addresses allowed to open a secret, and the recipient must confirm a one-time code before the server releases anything.

> **Requires a valid license and an SMTP relay.** Recipient verification is a business feature gated behind `--license-key`, and it is only available once `--smtp-host` is configured. Yopass sends no other mail.

---

## What this does and does not protect against

Be clear-eyed about this before you rely on it.

**It genuinely helps against:**

- **Misdirected links** — a link sent to the wrong person or pasted into the wrong channel cannot be opened.
- **Onward forwarding** — a recipient cannot pass the link to a colleague and have it work.
- **Links leaking into systems** — tickets, chat history, browser history on a shared machine, screenshots.
- **Link prefetchers burning one-time secrets** — mail scanners, Slack unfurls and antivirus URL checkers follow links. Verification means the one-time burn only happens after a human proves intent, not when a scanner touches the URL.

**It does not help when:**

- **The link and the code go to the same mailbox.** Anyone who has compromised that mailbox has both. In that setup this is an *audit* control, not a second factor.
- **Someone with the link wants to destroy the secret rather than read it.** `DELETE /secret/{id}` is deliberately *not* gated on verification, because in Yopass holding the URL is what gives the creator the power to revoke — gating it would strip that from any creator who is not also a bound recipient. So a misdirected link cannot be *opened* by the wrong person, but it can be *deleted* by them, forcing you to re-share. This is denial of service, not disclosure.
- **An observer can time the responses.** Requesting a code returns `204` for matching and non-matching addresses alike, but the matching path also waits on the SMTP relay, so it is measurably slower. Someone holding the link can therefore test a list of candidate addresses and spot the bound one by latency. Treat recipient identity as metadata that a determined link-holder can recover, not as a secret.

To get a real second factor, deliver the link on a different channel from the verified address — send the link over chat or SMS and verify against the corporate email address, or the other way round. Yopass cannot enforce this; it is a matter of how you share the link.

This is complementary to [OpenID Connect](openid-connect.md), not a replacement. `--require-auth` gates on your identity provider and suits internal users; recipient verification suits external clients who will never have an account with you.

---

## How it works

1. **Create the secret with recipients.** Enter one or more addresses in *Restrict to recipients* (or pass `"recipients": [...]` to the API). Up to 10 addresses per secret. File uploads support it too.
2. **Share the link as usual.** The link format does not change.
3. **The recipient confirms their address.** Opening the link shows a verification form instead of the secret. They enter their email address; if it matches, a six-digit code is mailed to them.
4. **The code releases the ciphertext.** Once accepted, the browser downloads the encrypted secret and decrypts it locally. For a one-time secret, this is the moment it burns.

The zero-knowledge model is untouched. The decryption key stays in the URL fragment and never reaches the server; verification gates the **ciphertext download**, not the key. A Yopass operator still cannot read the secret.

## What is stored

**Recipient addresses are never stored.** Yopass keeps only a salted HMAC of each normalised address. When a recipient types their address, it is hashed and compared; the code is then mailed to the address they just supplied. Consequences worth knowing:

- A database dump reveals no sender-to-recipient graph, only opaque hashes.
- Yopass will not mail an address that nobody has supplied, so the endpoint cannot be used as an open relay to arbitrary addresses. It is not, however, protection against someone who already knows an address and wants it flooded: creating secrets is unauthenticated by default, so `--smtp-max-per-hour` (default 500) caps how much mail the instance will send in total. Lower it if your relay is shared or your reputation is precious.
- This is **data minimisation, not secrecy**. Email addresses are guessable, so an attacker who already suspects the recipient can confirm it by trying. The code, not the address, is the control.

The verification record shares the secret's lifetime and disappears with it. A consumed one-time secret has its record deleted immediately.

## Limits

| Limit | Value |
|-------|-------|
| Recipients per secret | 10 |
| Code length | 6 digits |
| Code lifetime | 10 minutes |
| Wrong guesses per code | 5, then the code is dead |
| Codes per recipient | 3 |
| Retrieval window after verifying | 5 minutes |

Together this allows at most 15 guesses against a million possibilities. Budgets and retrieval tokens are tracked **per recipient**, so co-recipients of the same secret cannot exhaust each other's codes or invalidate each other's retrieval window. When one recipient's code budget is spent, that recipient can no longer open the secret and needs it re-shared — the same outcome as a one-time secret opened by accident.

## Configuration

```bash
yopass \
  --license-key "$YOPASS_LICENSE" \
  --smtp-host smtp.example.com \
  --smtp-port 587 \
  --smtp-username yopass \
  --smtp-password "$SMTP_PASSWORD" \
  --smtp-from "yopass@example.com"
```

| Flag | Default | Description |
|------|---------|-------------|
| `--smtp-host` | — | SMTP relay host. Setting it enables the feature. |
| `--smtp-port` | `587` | Relay port. |
| `--smtp-username` | — | Omit for relays that need no authentication. |
| `--smtp-password` | — | Password for the above. |
| `--smtp-from` | — | Envelope and header `From`. Required with `--smtp-host`. |
| `--smtp-tls` | `starttls` | `starttls`, `tls` (implicit, usually port 465), or `none`. |
| `--smtp-timeout` | `10s` | Bounds the whole SMTP exchange. |
| `--smtp-max-per-hour` | `500` | Instance-wide ceiling on verification emails per hour; `0` disables it. |
| `--disable-recipient-verification` | `false` | Turn the feature off while keeping SMTP configured. |

Any provider with an SMTP endpoint works — Amazon SES, SendGrid, Postmark, Mailgun, Microsoft 365, Google Workspace — as does an internal relay. Yopass does not talk to provider APIs directly.

Credentials are only sent over an encrypted connection: with `--smtp-tls none` authentication is refused unless the host is localhost.

### Deliverability

Codes arrive while the recipient waits, so this is the one part of Yopass with a hard dependency on someone else's infrastructure. Use a relay with SPF and DKIM configured for your `--smtp-from` domain, and test with an external address before rolling out — a code sitting in a spam folder looks to the recipient like the feature is broken.

## API

Create a bound secret:

```bash
curl -X POST https://yopass.example.com/create/secret \
  -H 'Content-Type: application/json' \
  -d '{
    "message": "-----BEGIN PGP MESSAGE----- ...",
    "expiration": 3600,
    "one_time": true,
    "recipients": ["alice@example.com"]
  }'
```

For file uploads, pass the addresses as a comma-separated `X-Yopass-Recipients` header.

Fetching a bound secret without a token returns `403`:

```json
{ "message": "Recipient verification required", "verification_required": true }
```

Request a code. This returns `204` whether or not the address matches, so the *response* reveals nothing — see the timing caveat above for what it does not cover. Two exceptions worth knowing: a `502` when the relay is failing does reveal that the address matched (surfacing the outage is worth more than closing an oracle a working deployment never opens), and a failed send is refunded rather than counting against the recipient's three.

```bash
curl -X POST https://yopass.example.com/secret/{id}/verify \
  -H 'Content-Type: application/json' \
  -d '{"email": "alice@example.com"}'
```

Redeem it for a retrieval token:

```bash
curl -X POST https://yopass.example.com/secret/{id}/verify \
  -H 'Content-Type: application/json' \
  -d '{"email": "alice@example.com", "code": "123456"}'
# => {"token": "..."}
```

Then fetch the secret with `X-Yopass-Verification-Token: <token>`. Files use `/file/{id}/verify` and the same header on `GET /file/{id}`.

## Behaviour on license expiry

Enforcement is deliberately **not** tied to the license being currently valid — otherwise a lapsed key would silently turn every existing bound secret into a freely readable one. Instead:

- Already-bound secrets stay gated, and the verification endpoints keep working, for as long as SMTP is configured.
- Creating **new** bound secrets stops as soon as the license expires, and the option disappears from the UI.

Every instance sharing the database must have `--smtp-host` configured. An instance without it cannot run the verification exchange, so it **refuses** bound secrets rather than serving them ungated — safe, but it means a misconfigured replica makes those secrets unopenable rather than public. The same applies if the verification record is lost while the secret survives (independent eviction under memcached or Redis LRU pressure): retrieval is refused, not waved through.

## Audit events

With [audit logging](audit-logging.md) enabled:

| Event | Meaning |
|-------|---------|
| `secret.verification_requested` / `file.verification_requested` | A code was requested. `denied` means the address did not match or the send budget was spent. |
| `secret.verification_completed` / `file.verification_completed` | A code was redeemed. `denied` means it was wrong or expired. |

No email address or code is ever written to the audit log — only the usual redacted secret ID and client IP.
