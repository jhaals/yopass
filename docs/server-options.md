---
title: Server Options
sidebar_position: 10
description: Complete reference for all yopass-server CLI flags and environment variables.
---

# Server Options

Complete reference for `yopass-server`. All flags can also be set via environment variable.

## Configuration methods

**Flags** take precedence. **Environment variables** are the flag name uppercased with dashes replaced by underscores (e.g. `--max-length` → `MAX_LENGTH`).

---

## Core

| Flag | Env var | Default | Description |
|------|---------|---------|-------------|
| `--address` | `ADDRESS` | `0.0.0.0` | Listen address |
| `--port` | `PORT` | `1337` | Listen port |
| `--log-level` | `LOG_LEVEL` | `info` | Log level: `debug`, `info`, `warn`, `error` |
| `--metrics-port` | `METRICS_PORT` | `-1` | Port for the Prometheus metrics server. Disabled when `-1` |
| `--health-check` | `HEALTH_CHECK` | `false` | Check database connectivity and exit |
| `--asset-path` | `ASSET_PATH` | `public` | Path to the built frontend assets directory |

---

## Database

| Flag | Env var | Default | Description |
|------|---------|---------|-------------|
| `--database` | `DATABASE` | `memcached` | Storage backend: `memcached` or `redis` |
| `--memcached` | `MEMCACHED` | `localhost:11211` | Memcached address (`host:port`) |
| `--redis` | `REDIS` | `redis://localhost:6379/0` | Redis connection URL |

---

## Secrets

| Flag | Env var | Default | Description |
|------|---------|---------|-------------|
| `--max-length` | `MAX_LENGTH` | `10000` | Maximum encrypted secret size in bytes |
| `--default-expiry` | `DEFAULT_EXPIRY` | `1h` | Default expiration pre-selected in the UI: `1h`, `1d`, or `1w` |
| `--force-expiration` | `FORCE_EXPIRATION` | — | Force all secrets and file uploads to a fixed expiration: `1h`, `1d`, or `1w`. The server rejects any create request with a different value (`400 Expiration does not match server policy`). The UI replaces the expiration selector with the fixed duration |
| `--force-onetime-secrets` | `FORCE_ONETIME_SECRETS` | `false` | Reject secrets that are not set to one-time viewing |
| `--prefetch-secret` | `PREFETCH_SECRET` | `true` | Show a warning that the secret may be one-time use before revealing it |

---

## File Storage

| Flag | Env var | Default | Description |
|------|---------|---------|-------------|
| `--max-file-size` | `MAX_FILE_SIZE` | `512KB` | Maximum file upload size (e.g. `10KB`, `512KB`, `1MB`). Capped at 1 MB without a license key |
| `--disable-upload` | `DISABLE_UPLOAD` | `false` | Disable the `/create/file` upload endpoint entirely |
| `--file-store` | `FILE_STORE` | *(database)* | File storage backend: `disk`, `s3`, or empty to use the database |
| `--file-store-path` | `FILE_STORE_PATH` | `/tmp/yopass-files` | Base directory for the disk file store |
| `--file-store-s3-bucket` | `FILE_STORE_S3_BUCKET` | — | S3 bucket name (required for S3 storage) |
| `--file-store-s3-prefix` | `FILE_STORE_S3_PREFIX` | `yopass/` | Key prefix for objects stored in S3 |
| `--file-store-s3-endpoint` | `FILE_STORE_S3_ENDPOINT` | — | S3-compatible endpoint URL (e.g. MinIO at `http://minio:9000`) |
| `--file-store-s3-region` | `FILE_STORE_S3_REGION` | `us-east-1` | S3 region |
| `--cleanup-interval` | `CLEANUP_INTERVAL` | `60` | How often (seconds) the built-in file cleanup runs |
| `--disable-file-cleanup` | `DISABLE_FILE_CLEANUP` | `false` | Disable the built-in cleanup goroutine (use when relying on S3 lifecycle rules instead) |

See [File Storage](./file-storage) for backend setup and S3 lifecycle rule examples.

---

## TLS

| Flag | Env var | Default | Description |
|------|---------|---------|-------------|
| `--tls-cert` | `TLS_CERT` | — | Path to the TLS certificate file |
| `--tls-key` | `TLS_KEY` | — | Path to the TLS private key file |

See [TLS / HTTPS](./tls) for built-in TLS setup and reverse proxy examples.

---

## Security & Networking

| Flag | Env var | Default | Description |
|------|---------|---------|-------------|
| `--cors-allow-origin` | `CORS_ALLOW_ORIGIN` | `*` | Value for the `Access-Control-Allow-Origin` response header |
| `--trusted-proxies` | `TRUSTED_PROXIES` | — | Comma-separated IP addresses or CIDR ranges whose `X-Forwarded-For` headers are trusted (e.g. `192.168.1.0/24,10.0.0.0/8`) |

---

## Frontend / UI

| Flag | Env var | Default | Description |
|------|---------|---------|-------------|
| `--read-only` | `READ_ONLY` | `false` | Disable secret creation endpoints. Retrieval and deletion remain active |
| `--disable-features` | `DISABLE_FEATURES` | `false` | Hide the features section on the homepage |
| `--no-language-switcher` | `NO_LANGUAGE_SWITCHER` | `false` | Hide the language switcher in the navigation bar |
| `--privacy-notice-url` | `PRIVACY_NOTICE_URL` | — | URL linked from the privacy notice in the footer |
| `--imprint-url` | `IMPRINT_URL` | — | URL linked from the imprint / legal notice in the footer |
| `--public-url` | `PUBLIC_URL` | — | Base URL of the public read-only instance. Secret links generated by the creation instance will use this URL |

See [Read-Only Mode](./read-only-mode) for split-instance deployments.

---

## License

| Flag | Env var | Default | Description |
|------|---------|---------|-------------|
| `--license-key` | `LICENSE_KEY` | — | License key that unlocks OIDC authentication, theming, audit logging, and file sizes above 1 MB |

---

## Authentication *(requires license key)*

| Flag | Env var | Default | Description |
|------|---------|---------|-------------|
| `--oidc-issuer` | `OIDC_ISSUER` | — | OIDC provider URL (e.g. `https://accounts.google.com`) |
| `--oidc-client-id` | `OIDC_CLIENT_ID` | — | OAuth 2.0 client ID |
| `--oidc-client-secret` | `OIDC_CLIENT_SECRET` | — | OAuth 2.0 client secret |
| `--oidc-redirect-url` | `OIDC_REDIRECT_URL` | — | Callback URL registered with your OIDC provider (e.g. `https://yopass.example.com/auth/callback`) |
| `--require-auth` | `REQUIRE_AUTH` | `false` | Require users to be authenticated before they can create secrets |
| `--api-token` | `API_TOKEN` | — | Static bearer token(s) letting machine clients create secrets when `--require-auth` is set, formatted as `name:secret` (comma-separated for multiple) |
| `--oidc-allowed-domains` | `OIDC_ALLOWED_DOMAINS` | — | Comma-separated email domains allowed to log in (e.g. `corp.example.com,example.com`) |
| `--oidc-session-key` | `OIDC_SESSION_KEY` | — | 64-byte hex-encoded session key for sharing sessions across multiple instances. Generate with `openssl rand -hex 64` |
| `--frontend-url` | `FRONTEND_URL` | — | Frontend base URL for post-login redirect in split-origin (OIDC + separate frontend) deployments |

See [OpenID Connect](./openid-connect) for provider-specific setup and multi-instance configuration.

---

## Branding *(requires license key)*

| Flag | Env var | Default | Description |
|------|---------|---------|-------------|
| `--app-name` | `APP_NAME` | — | Custom application name shown in the UI (default: Yopass) |
| `--logo-url` | `LOGO_URL` | — | URL to a custom logo image (e.g. `/mylogo.svg` for a file in the `public/` directory, or an external CDN URL) |
| `--theme-light` | `THEME_LIGHT` | `emerald` | DaisyUI theme name for light mode |
| `--theme-dark` | `THEME_DARK` | `dim` | DaisyUI theme name for dark mode |
| `--theme-custom-light` | `THEME_CUSTOM_LIGHT` | — | JSON object of CSS variables for a fully custom light theme (keys must start with `--color-`) |
| `--theme-custom-dark` | `THEME_CUSTOM_DARK` | — | JSON object of CSS variables for a fully custom dark theme (keys must start with `--color-`) |

See [Theming & Branding](./theming) for available theme names and CSS variable examples.

---

## Audit Logging *(requires license key)*

| Flag | Env var | Default | Description |
|------|---------|---------|-------------|
| `--audit-log` | `AUDIT_LOG` | `false` | Enable structured NDJSON audit logging |
| `--audit-log-file` | `AUDIT_LOG_FILE` | *(stdout)* | File path for audit log output |

See [Audit Logging](./audit-logging) for log format, event types, and log rotation.

---

## Secret Requests *(requires license key)*

Secret requests are enabled automatically with a valid license key.

| Flag | Env var | Default | Description |
|------|---------|---------|-------------|
| `--disable-secret-requests` | `DISABLE_SECRET_REQUESTS` | `false` | Disable the secret request feature |

See [Secret Requests](./secret-requests) for the full flow, security model, and REST API.

---

## Webhooks & Read Receipts *(requires license key)*

Read receipts are enabled automatically with a valid license key; webhooks require a URL.

| Flag | Env var | Default | Description |
|------|---------|---------|-------------|
| `--webhook-url` | `WEBHOOK_URL` | — | Endpoint receiving secret and request lifecycle events (created, viewed, fulfilled, expired) |
| `--webhook-secret` | `WEBHOOK_SECRET` | — | HMAC-SHA256 signing key for webhook payloads |
| `--disable-read-receipts` | `DISABLE_READ_RECEIPTS` | `false` | Disable the read receipt feature |

See [Webhooks](./webhooks) for payload format and signature verification, and [Read Receipts](./read-receipts) for the per-secret "was it opened?" flow.
