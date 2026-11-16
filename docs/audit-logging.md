---
title: Audit Logging
sidebar_position: 6
description: Emit NDJSON audit logs for SOC 2, ISO 27001, and GDPR compliance. License required.
---

# Audit Logging

Yopass can emit a structured audit log recording every security-relevant event — secret creation, access, deletion, and authentication — without ever logging encrypted content. The log is designed for compliance requirements such as SOC 2, ISO 27001, and GDPR data-access accountability.

> **Requires a valid license.** Audit logging is a premium feature gated behind `--license-key`.

---

## Enabling audit logging

```bash
yopass-server \
  --license-key "your-license-key" \
  --audit-log
```

By default, audit records are written to **stdout** as NDJSON (one JSON object per line), separate from the regular application log. To write to a dedicated file instead:

```bash
yopass-server \
  --license-key    "your-license-key" \
  --audit-log \
  --audit-log-file /var/log/yopass/audit.log
```

---

## Flags

| Flag | Env var | Default | Description |
|------|---------|---------|-------------|
| `--audit-log` | `AUDIT_LOG` | `false` | Enable audit logging (requires valid license) |
| `--audit-log-file` | `AUDIT_LOG_FILE` | — | Write audit log to this file path. When unset, records go to stdout. |

---

## Log format

Each event is a single JSON object terminated by a newline (NDJSON). Fields are only emitted when they are relevant to the event — optional fields are omitted rather than set to null or empty.

### Fields

| Field | Type | Always present | Description |
|-------|------|---------------|-------------|
| `timestamp` | string (RFC3339Nano, UTC) | yes | When the event occurred |
| `event` | string | yes | Event type (see [Events](#events)) |
| `outcome` | string | yes | `success`, `failure`, or `denied` |
| `client_ip` | string | yes | Real client IP, respecting `--trusted-proxies` |
| `secret_id` | string | no | First 12 hexadecimal characters of the SHA-256 hash of the secret or file ID |
| `user_email` | string | no | Authenticated user's email (OIDC sessions only) |
| `user_subject` | string | no | Authenticated user's OIDC subject claim |
| `one_time` | bool | no | Whether the secret was configured for one-time access |
| `expiration_seconds` | number | no | TTL in seconds at creation time |
| `require_auth` | bool | no | Whether the secret requires OIDC authentication to access |
| `error` | string | no | Human-readable reason for `failure` or `denied` outcomes |

> **Privacy note:** Encrypted secret content is never written to the audit log — only a hashed ID and metadata are recorded.

### Example records

Successful secret creation:
```json
{"timestamp":"2026-04-09T12:00:01.123456789Z","event":"secret.created","outcome":"success","client_ip":"203.0.113.42","secret_id":"3a128f193823","one_time":true,"expiration_seconds":3600,"require_auth":false,"user_email":"alice@corp.example","user_subject":"auth0|abc123"}
```

Access denied (unauthenticated):
```json
{"timestamp":"2026-04-09T12:01:00.000000001Z","event":"secret.accessed","outcome":"denied","client_ip":"198.51.100.7","secret_id":"3a128f193823","require_auth":true,"error":"authentication required"}
```

Successful login:
```json
{"timestamp":"2026-04-09T12:00:00.500000000Z","event":"auth.callback_success","outcome":"success","client_ip":"203.0.113.42","user_email":"alice@corp.example","user_subject":"auth0|abc123"}
```

---

## Events

### Secret events

| Event | Triggered by | Outcomes |
|-------|-------------|---------|
| `secret.created` | `POST /create/secret` | `success`, `failure`, `denied` |
| `secret.accessed` | `GET /secret/{key}` | `success`, `failure`, `denied` |
| `secret.deleted` | `DELETE /secret/{key}` | `success`, `failure`, `denied` |
| `secret.status_checked` | `GET /secret/{key}/status` (the one-time warning page) | `success`, `failure`, `denied` (with `--require-auth-all`) |
| `secret.receipt_checked` | `GET /secret/{key}/receipt` (see [Read Receipts](read-receipts)) | `success`, `failure`, `denied` |

### File events

| Event | Triggered by | Outcomes |
|-------|-------------|---------|
| `file.uploaded` | `POST /create/file` | `success`, `failure`, `denied` |
| `file.downloaded` | `GET /file/{key}` | `success`, `failure`, `denied` |
| `file.deleted` | `DELETE /file/{key}` | `success`, `failure`, `denied` |
| `file.status_checked` | `GET /file/{key}/status` | `success`, `failure`, `denied` (with `--require-auth-all`) |
| `file.cleanup_failed` | The download link was revoked or consumed but the stored ciphertext could not be removed (see [File Storage](file-storage#expiration-and-cleanup)) | `failure` |

### Secret request events

| Event | Triggered by |
|-------|-------------|
| `request.created` | `POST /request` |
| `request.viewed` | `GET /request/{key}` (a responder opening the link) |
| `request.fulfilled` | `POST /request/{key}/secret` |
| `request.secret_accessed` | `GET /request/{key}/secret` |
| `request.revoked` | `DELETE /request/{key}` |
| `request.key_rotated` | `PUT /request/{key}/key` |

See [Secret Requests](secret-requests) for the flow behind these events.

### Auth events

| Event | Triggered by | Outcomes |
|-------|-------------|---------|
| `auth.callback_success` | OIDC callback (successful login) | `success` |
| `auth.callback_failed` | OIDC callback (rejected login, including state/code exchange failures) | `failure`, `denied` |
| `auth.logout` | `POST /auth/logout` | `success`, `denied` |

**Outcomes:**
- `success` — operation completed normally
- `failure` — operation failed (validation error, database error, not found)
- `denied` — operation was refused: missing or insufficient authentication, a wrong token, or a state that no longer allows it (for example fulfilling a request that was already fulfilled)

---

## HTTP access logs

Regular HTTP access logs are redacted regardless of whether licensed audit
logging is enabled. The `uri` field contains the route template, such as
`/secret/{key}/status`. Only routes with a `{key}` parameter include `secret_id`,
which contains the same truncated SHA-256 hash used by audit logs. Routes such as
`/config` and `/auth/callback` omit that field.

Raw identifiers and URL query strings are omitted, including
OIDC callback codes and state parameters. Requests that match no API route,
including those served by the static-file fallback, log `/` without the
requested filename.

File store errors and cleanup messages in the application log follow the same
rule: an identifier inside an S3 request URL or a disk path is replaced with its
`secret_id` hash.

Apply equivalent redaction to reverse proxies, API Gateway access logs, and log
collectors: application redaction cannot remove URLs recorded by those systems.
Existing logs may still contain usable identifiers until the associated secrets
expire or are consumed; restrict access and handle those logs under your
credential-exposure policy.

---

## Log rotation

When writing to a file (`--audit-log-file`), Yopass does not rotate logs itself. Use your platform's standard tooling:

**logrotate** (`/etc/logrotate.d/yopass-audit`):
```
/var/log/yopass/audit.log {
    daily
    rotate 90
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
}
```

The `copytruncate` directive truncates the file in place so no SIGHUP or file descriptor hand-off is needed.

**systemd**: leave `--audit-log-file` unset and let journald capture and rotate stdout. journald drops messages from a service that exceeds its rate limit (`RateLimitBurst=` within `RateLimitIntervalSec=`), so raise those limits for high-volume deployments or write to a file instead.

---

## Docker Compose example

```yaml
services:
  yopass:
    image: jhaals/yopass:latest
    ports:
      - "1337:1337"
    environment:
      MEMCACHED: memcached:11211
      LICENSE_KEY: your-license-key
      AUDIT_LOG: "true"
      AUDIT_LOG_FILE: /var/log/yopass/audit.log
    volumes:
      - ./logs:/var/log/yopass   # must be writable by UID 1000, the user the image runs as
    depends_on:
      - memcached

  memcached:
    image: memcached
```

To write to stdout (and let your log collector handle it):

```yaml
environment:
  AUDIT_LOG: "true"
  # no AUDIT_LOG_FILE — records go to stdout alongside application logs
```

> **Tip:** When writing to stdout in a containerized environment, have your log shipper select lines containing `"event":` to separate audit records from regular application log lines.

---

## Combining with OIDC

Audit logging is most valuable when combined with [OpenID Connect](openid-connect.md). With OIDC configured, every audit record that involves an authenticated session includes `user_email` and `user_subject`, giving you a full identity trail for compliance reviews.

```bash
yopass-server \
  --license-key        "your-license-key" \
  --audit-log \
  --oidc-issuer        "https://accounts.google.com" \
  --oidc-client-id     "123456789-abc.apps.googleusercontent.com" \
  --oidc-client-secret "GOCSPX-…" \
  --oidc-redirect-url  "https://yopass.example.com/auth/callback"
```

Without OIDC, `user_email` and `user_subject` are omitted from all audit records.
