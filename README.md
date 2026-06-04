![Yopass-horizontal](https://user-images.githubusercontent.com/37777956/59544367-0867aa80-8f09-11e9-8d6a-02008e1bccc7.png)

# Yopass - Share Secrets Securely

[![Go Report Card](https://goreportcard.com/badge/github.com/jhaals/yopass)](https://goreportcard.com/report/github.com/jhaals/yopass)
[![codecov](https://codecov.io/gh/jhaals/yopass/branch/master/graph/badge.svg)](https://codecov.io/gh/jhaals/yopass)
![GitHub release (latest SemVer)](https://img.shields.io/github/v/release/jhaals/yopass?sort=semver)

![demo](https://ydemo.netlify.com/yopass-demo.gif)

Yopass lets you share secrets, passwords, and files securely with end-to-end encryption. Secrets are encrypted in the browser using [OpenPGP](https://openpgpjs.org/) before being sent to the server — the decryption key never leaves your machine. Each secret gets a one-time URL that expires automatically.

No accounts, no tracking, no plaintext storage. Stop sharing secrets in Slack, email, and ticket systems.

**[Try the demo](https://yopass.se)** | It's recommended to self-host Yopass for sensitive use.

### Features

- End-to-end encryption using OpenPGP
- One-time secret viewing
- No accounts or user management
- Configurable expiration (hours, days, or weeks)
- Optional custom password protection
- File upload with streaming encryption
- Multi-language support
- OpenID Connect (OIDC) authentication with email domain restrictions
- Theming and branding (custom themes, logo, app name)
- Compliance audit logging (SOC 2, ISO 27001, GDPR)

## Table of Contents

- [Getting Started](#getting-started)
  - [Docker Compose](#docker-compose)
  - [Docker](#docker)
  - [Kubernetes](#kubernetes)
- [Server Configuration](#server-configuration)
- [Translations](#translations)
- [History](#history)

## Getting Started

See the [docs](https://yopass.se/docs) for detailed guides on configuration, theming, OIDC authentication, audit logging, and more.

### Docker Compose

The quickest way to get Yopass running with TLS and automatic certificate renewal via [Let's Encrypt](https://letsencrypt.org/).

1. Point your domain to the host where you want to run Yopass
2. Edit `deploy/with-nginx-proxy-and-letsencrypt/docker-compose.yml` and replace the placeholder values for `VIRTUAL_HOST`, `LETSENCRYPT_HOST`, and `LETSENCRYPT_EMAIL`
3. Start the containers:

```console
docker-compose up -d
```

Yopass will be available at the domain you configured.

**Already have a reverse proxy handling TLS?** Use the simpler setup:

```console
cd deploy/docker-compose/insecure
docker-compose up -d
```

Then point your reverse proxy to `127.0.0.1:80`.

### Docker

With TLS encryption:

```console
docker run --name memcached_yopass -d memcached
docker run -p 443:1337 -v /local/certs/:/certs \
    --link memcached_yopass:memcached -d jhaals/yopass --memcached=memcached:11211 --tls-key=/certs/tls.key --tls-cert=/certs/tls.crt
```

Yopass will be available on port 443 on all host interfaces. To restrict to localhost, use `-p 127.0.0.1:443:1337`.

Without TLS (requires a reverse proxy for transport encryption):

```console
docker run --name memcached_yopass -d memcached
docker run -p 127.0.0.1:80:1337 --link memcached_yopass:memcached -d jhaals/yopass --memcached=memcached:11211
```

Then point your TLS-terminating reverse proxy to `127.0.0.1:80`.

### Kubernetes

```console
kubectl apply -f deploy/yopass-k8.yaml
kubectl port-forward service/yopass 1337:1337
```

_This is a minimal setup to get started. Configure TLS before using in production._

## Server Configuration

Yopass uses Memcached (default) or Redis as its storage backend. All flags can also be set via environment variable (uppercase, dashes → underscores).

```bash
# Memcached (default)
yopass-server --memcached localhost:11211

# Redis
yopass-server --database redis --redis redis://localhost:6379/0
```

For the full flag reference see [yopass.se/docs/server-options](https://yopass.se/docs/server-options). Topic-specific guides:

| Guide | Description |
|-------|-------------|
| [TLS / HTTPS](https://yopass.se/docs/tls) | Built-in TLS, Nginx, Caddy, Traefik, Let's Encrypt |
| [File Storage](https://yopass.se/docs/file-storage) | Disk and S3/MinIO backends, size limits |
| [Read-Only Mode](https://yopass.se/docs/read-only-mode) | Split-instance deployments |
| [OpenID Connect](https://yopass.se/docs/openid-connect) | OIDC authentication *(license required)* |
| [Theming & Branding](https://yopass.se/docs/theming) | Custom themes, logo, app name *(license required)* |
| [Metrics](https://yopass.se/docs/metrics) | Prometheus, alerting rules, Grafana |
| [Audit Logging](https://yopass.se/docs/audit-logging) | NDJSON compliance logging *(license required)* |


## Translations

Yopass supports multiple languages via react-i18next. See the [current translations](https://github.com/jhaals/yopass/blob/master/website/src/shared/lib/i18n.ts). Contributions for new languages are welcome — see this [example PR](https://github.com/jhaals/yopass/pull/3024).

## History

Yopass was first released in 2014 and has been maintained with the help of many [contributors](https://github.com/jhaals/yopass/graphs/contributors). It is used by organizations including [Spotify](https://spotify.com), [Doddle](https://doddle.com), and [Gumtree Australia](https://www.gumtreeforbusiness.com.au/).

If you use Yopass and want to support the project, you can give thanks via email, consider donating, or give consent to list your company here.
