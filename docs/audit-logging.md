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
| `secret_id` | string | no | Key identifying the secret or file |
| `user_email` | string | no | Authenticated user's email (OIDC sessions only) |
| `user_subject` | string | no | Authenticated user's OIDC subject claim |
| `one_time` | bool | no | Whether the secret was configured for one-time access |
| `expiration_seconds` | number | no | TTL in seconds at creation time |
| `require_auth` | bool | no | Whether the secret requires OIDC authentication to access |
| `error` | string | no | Human-readable reason for `failure` or `denied` outcomes |

> **Privacy note:** Encrypted secret content is never written to the audit log — only the key (ID) and metadata are recorded.

### Example records

Successful secret creation:
```json
{"timestamp":"2026-04-09T12:00:01.123456789Z","event":"secret.created","outcome":"success","client_ip":"203.0.113.42","secret_id":"k9bXz3mQ2vR7nLpA4wEy5a","one_time":true,"expiration_seconds":3600,"require_auth":false,"user_email":"alice@corp.example","user_subject":"auth0|abc123"}
```

Access denied (unauthenticated):
```json
{"timestamp":"2026-04-09T12:01:00.000000001Z","event":"secret.accessed","outcome":"denied","client_ip":"198.51.100.7","secret_id":"k9bXz3mQ2vR7nLpA4wEy5a","require_auth":true,"error":"authentication required"}
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
| `secret.created` | `POST /create/secret` | `success`, `failure` |
| `secret.accessed` | `GET /secret/{key}` | `success`, `failure`, `denied` |
| `secret.deleted` | `DELETE /secret/{key}` | `success`, `failure` |

### File events

| Event | Triggered by | Outcomes |
|-------|-------------|---------|
| `file.uploaded` | `POST /create/file` | `success`, `failure` |
| `file.downloaded` | `GET /file/{key}` | `success`, `failure`, `denied` |
| `file.deleted` | `DELETE /file/{key}` | `success`, `failure` |

### Auth events

| Event | Triggered by | Outcomes |
|-------|-------------|---------|
| `auth.callback_success` | OIDC callback (successful login) | `success` |
| `auth.callback_failed` | OIDC callback (rejected login) | `failure`, `denied` |
| `auth.logout` | `POST /auth/logout` | `success` |

**Outcomes:**
- `success` — operation completed normally
- `failure` — operation failed (validation error, database error, not found)
- `denied` — operation was rejected due to missing or insufficient authentication

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

**systemd** with `StandardOutput=append:/var/log/yopass/audit.log` and `journald` log rotation handles this automatically for systemd-managed deployments.

---

## Docker Compose example

```yaml
services:
  yopass:
    image: ghcr.io/jhaals/yopass:latest
    ports:
      - "1337:1337"
    environment:
      MEMCACHED: memcached:11211
      LICENSE_KEY: your-license-key
      AUDIT_LOG: "true"
    volumes:
      - ./logs:/var/log/yopass
    command: >
      yopass-server
      --audit-log-file /var/log/yopass/audit.log
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

> **Tip:** When writing to stdout in a containerized environment, prefix your log shipping filter on `"event":` to separate audit records from regular application log lines.

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
