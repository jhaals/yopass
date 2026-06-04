# Yopass Documentation

Operational guides for deploying and configuring Yopass. For a quick-start and server flag reference, see the [README](../README.md).

## Guides

- [OpenID Connect Authentication](openid-connect.md) — OIDC setup, multi-instance session sharing, email domain restrictions
- [Theming & Branding](theming.md) — Custom DaisyUI themes, color variable overrides, logo and app name
- [Audit Logging](audit-logging.md) — NDJSON compliance logging, event types, log rotation, Docker examples
- [File Storage](file-storage.md) — Disk and S3/MinIO backends, size limits, lifecycle rules
- [Read-Only Mode](read-only-mode.md) — Split-instance deployment for protected creation and public retrieval
- [TLS / HTTPS](tls.md) — Built-in TLS, reverse proxy setup (Nginx, Caddy, Traefik), Let's Encrypt
- [Metrics](metrics.md) — Prometheus scrape config, HTTP metrics, alerting rules, Grafana queries

## Premium Features

The following features require a valid `--license-key`:

| Feature | Docs |
|---------|------|
| OpenID Connect authentication | [openid-connect.md](openid-connect.md) |
| Theming & branding | [theming.md](theming.md) |
| Audit logging | [audit-logging.md](audit-logging.md) |
| Increased file size limit (>1MB) | [file-storage.md](file-storage.md) |
