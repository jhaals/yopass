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

## Table of Contents

- [Getting Started](#getting-started)
  - [Docker Compose](#docker-compose)
  - [Docker](#docker)
  - [Kubernetes](#kubernetes)
- [Server Configuration](#server-configuration)
  - [Proxy Configuration](#proxy-configuration)
  - [File Storage](#file-storage)
  - [Read-Only Mode](#read-only-mode)
- [Command-Line Interface](#command-line-interface)
- [Monitoring](#monitoring)
- [Translations](#translations)
- [History](#history)

## Getting Started

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

```console
$ yopass-server -h
      --address string                listen address (default 0.0.0.0)
      --port int                      listen port (default 1337)
      --database string               database backend ('memcached' or 'redis') (default "memcached")
      --memcached string              Memcached address (default "localhost:11211")
      --redis string                  Redis URL (default "redis://localhost:6379/0")
      --max-length int                max length of encrypted secret in bytes (default 10000)
      --max-file-size string          max file upload size - up to 1MB (e.g. 10KB, 512KB, 1MB)
      --default-expiry string         default expiry time for secrets [1h, 1d, 1w] (default "1h")
      --file-store string             file store backend: 'disk' or 's3' (default: database)
      --file-store-path string        base path for disk file store (default "/tmp/yopass-files")
      --file-store-s3-bucket string   S3 bucket name
      --file-store-s3-prefix string   S3 key prefix (default "yopass/")
      --file-store-s3-endpoint string S3 endpoint URL (for MinIO/compatible services)
      --file-store-s3-region string   S3 region (default "us-east-1")
      --cleanup-interval int          file cleanup interval in seconds (default 60)
      --disable-file-cleanup           disable file store cleanup goroutine (use with S3 lifecycle rules)
      --tls-cert string               path to TLS certificate
      --tls-key string                path to TLS key
      --cors-allow-origin string      Access-Control-Allow-Origin CORS setting (default "*")
      --force-onetime-secrets         reject non onetime secrets from being created
      --read-only                     disable all secret creation endpoints (retrieval-only mode)
      --disable-upload                disable the /file upload endpoints
      --prefetch-secret               display information that the secret might be one time use (default true)
      --disable-features              disable features section on frontend
      --no-language-switcher          disable the language switcher in the UI
      --trusted-proxies strings       trusted proxy IP addresses or CIDR blocks for X-Forwarded-For header validation
      --privacy-notice-url string     URL to privacy notice page
      --imprint-url string            URL to imprint/legal notice page
      --public-url string             base URL of the public/read-only instance used in generated secret links
      --metrics-port int              metrics server listen port (default -1)
      --health-check                  perform database health check and exit
      --log-level                     log level (debug, info, warn, error)
```

Encrypted secrets can be stored in either Memcached (default) or Redis via the `--database` flag.

### Proxy Configuration

When deployed behind a reverse proxy or load balancer (Nginx, Caddy, Cloudflare, AWS ALB, etc.), configure trusted proxies to log real client IPs instead of proxy IPs.

`X-Forwarded-For` headers are only trusted from explicitly configured proxies, preventing IP spoofing from untrusted sources.

```bash
# Single proxy
yopass-server --trusted-proxies 192.168.1.100

# Multiple proxies
yopass-server --trusted-proxies 192.168.1.100,10.0.0.50

# CIDR notation
yopass-server --trusted-proxies 192.168.1.0/24,10.0.0.0/8

# Via environment variable
TRUSTED_PROXIES="192.168.1.0/24,10.0.0.0/8" yopass-server
```

Common scenarios:

- **Nginx/Apache**: Use the reverse proxy server's IP
- **Cloudflare**: Use Cloudflare's published IP ranges
- **AWS ALB/ELB**: Use your VPC CIDR or load balancer subnet
- **Docker networks**: Use the Docker network gateway IP or subnet

Without trusted proxies configured, Yopass uses the direct connection IP (recommended default).

### File Storage

Uploaded files are encrypted client-side and stored as binary data. By default they go into the database, but larger files benefit from a dedicated file store.

**Database (default)** — No extra configuration. Works well for small files but limited by backend size constraints (~1MB for Memcached). A warning is logged at startup if `--max-file-size` exceeds 1MB without a dedicated file store.

**Disk** — Local filesystem with automatic cleanup of expired files:

```bash
yopass-server --file-store disk --file-store-path /data/yopass-files
```

**S3** — AWS S3 or compatible services (MinIO, etc.):

```bash
# AWS S3
yopass-server --file-store s3 --file-store-s3-bucket my-yopass-bucket

# S3-compatible (MinIO, etc.)
yopass-server --file-store s3 \
  --file-store-s3-bucket my-bucket \
  --file-store-s3-endpoint http://minio:9000 \
  --file-store-s3-region us-east-1
```

**S3 cleanup** — The built-in cleanup scans all objects and checks tags on each sweep, which gets expensive at scale. The recommended approach is to use S3 lifecycle rules instead:

```bash
yopass-server --file-store s3 --file-store-s3-bucket my-yopass-bucket --disable-file-cleanup
```

Since the longest secret TTL is 1 week, a lifecycle rule deleting objects older than 7 days covers all cases:

```json
{
  "Rules": [
    {
      "ID": "yopass-expiration",
      "Filter": { "Prefix": "" },
      "Status": "Enabled",
      "Expiration": { "Days": 7 }
    }
  ]
}
```

The `--cleanup-interval` flag (default: 60s) controls built-in cleanup frequency. It has no effect when `--disable-file-cleanup` is set.

### Read-Only Mode

Deploy two Yopass instances sharing one database: a protected instance for creating secrets (behind authentication) and a public instance for retrieval only.

```bash
yopass-server --read-only
```

In this mode, `POST /create/secret` and `POST /create/file` return 404. Retrieval and deletion endpoints remain active.

When using this two-instance setup, tell the creation instance the URL of the public instance so that generated secret links point there instead of the creation instance:

```bash
# Creation instance (internal, behind authentication)
yopass-server --public-url https://secrets.example.com

# Public instance (read-only)
yopass-server --read-only
```

With `--public-url` set, all secret links displayed after creation will use `https://secrets.example.com` as their base, so recipients are directed to the public instance.

## Command-Line Interface

A CLI is available for sharing secrets from the terminal, useful when program output needs to be shared.

```console
$ yopass --help
Yopass - Secure sharing for secrets, passwords and files

Flags:
      --api string          Yopass API server location (default "https://api.yopass.se")
      --decrypt string      Decrypt secret URL
      --expiration string   Duration after which secret will be deleted [1h, 1d, 1w] (default "1h")
      --file string         Read secret from file instead of stdin
      --key string          Manual encryption/decryption key
      --one-time            One-time download (default true)
      --url string          Yopass public URL (default "https://yopass.se")

Settings are read from flags, environment variables, or a config file located at
~/.config/yopass/defaults.<json,toml,yml,hcl,ini,...> in this order. Environment
variables have to be prefixed with YOPASS_ and dashes become underscores.

Examples:
      # Encrypt and share secret from stdin
      printf 'secret message' | yopass

      # Encrypt and share secret file
      yopass --file /path/to/secret.conf

      # Share secret multiple time a whole day
      cat secret-notes.md | yopass --expiration=1d --one-time=false

      # Decrypt secret to stdout
      yopass --decrypt https://yopass.se/#/...

Website: https://yopass.se
```

### Installation

Install from source (requires Go >= 1.21):

```console
go install github.com/jhaals/yopass/cmd/yopass@latest
```

## Monitoring

Yopass optionally exposes metrics in [OpenMetrics](https://openmetrics.io/) / [Prometheus](https://prometheus.io/) format. Use `--metrics-port <port>` to start a metrics server on that port, serving metrics at `/metrics`.

Supported metrics:

- [Process metrics](https://prometheus.io/docs/instrumenting/writing_clientlibs/#process-metrics) (`process_*`) — CPU, memory, file descriptor usage
- Go runtime metrics (`go_*`) — memory, garbage collection
- HTTP request metrics (`yopass_http_*`) — request count and latency histogram

See [docs/metrics.md](docs/metrics.md) for the full reference including Prometheus configuration and example alerting rules.

## Audit Logging

Yopass supports structured audit logging for compliance requirements (SOC 2, ISO 27001, GDPR). When enabled, every secret creation, access, deletion, and authentication event is recorded as NDJSON — with identity, IP address, outcome, and metadata, but never the encrypted content.

```bash
yopass-server --license-key "your-license-key" --audit-log
```

See [docs/audit-logging.md](docs/audit-logging.md) for the full reference including log format, event types, log rotation, and Docker examples.

## Translations

Yopass supports multiple languages via react-i18next. See the [current translations](https://github.com/jhaals/yopass/blob/master/website/src/shared/lib/i18n.ts). Contributions for new languages are welcome — see this [example PR](https://github.com/jhaals/yopass/pull/3024).

## History

Yopass was first released in 2014 and has been maintained with the help of many [contributors](https://github.com/jhaals/yopass/graphs/contributors). It is used by organizations including [Spotify](https://spotify.com), [Doddle](https://doddle.com), and [Gumtree Australia](https://www.gumtreeforbusiness.com.au/).

If you use Yopass and want to support the project, you can give thanks via email, consider donating, or give consent to list your company here.
