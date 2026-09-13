<p align="center">
  <img src="logo/Yopass%20horizontal.svg" alt="Yopass" width="430">
</p>

<h1 align="center">Share secrets without leaving plaintext behind</h1>

<p align="center">
  Yopass is an open source, self-hosted service for sharing passwords, files, and other sensitive information.
  The browser encrypts your secret before it reaches the server and the decryption key is never stored with the secret.
</p>

<p align="center">
  <a href="https://share.yopass.se"><strong>Try the demo</strong></a>
  ·
  <a href="https://yopass.se/docs"><strong>Read the docs</strong></a>
  ·
  <a href="#quick-start"><strong>Self-host Yopass</strong></a>
</p>

<p align="center">
  <a href="https://codecov.io/gh/jhaals/yopass"><img src="https://codecov.io/gh/jhaals/yopass/branch/master/graph/badge.svg" alt="Code coverage"></a>
  <a href="https://github.com/jhaals/yopass/releases"><img src="https://img.shields.io/github/v/release/jhaals/yopass?sort=semver" alt="Latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/jhaals/yopass" alt="Apache 2.0 license"></a>
</p>

Use Yopass instead of putting credentials in email, chat history, or ticket systems. It needs no user accounts for the standard secret-sharing flow, collects no tracking data, and stores no plaintext secrets. Links can work once or remain available until their configured expiration.

> The public demo is useful for testing Yopass. Self-host your own instance when sharing sensitive information.

## How it works

1. Yopass generates a random decryption key and encrypts the secret in your browser using [OpenPGP](https://openpgpjs.org/).
2. The server stores the encrypted message with an expiration time. It cannot read the secret.
3. Yopass creates a link whose URL fragment contains the decryption key. URL fragments are not sent to the server.
4. The recipient's browser downloads the encrypted message and decrypts it locally. A one-time secret is removed after its first retrieval.

## Features

The open source edition includes:

- End-to-end encryption for text and files
- One-time links and automatic expiration
- Optional password protection
- No accounts or user management
- Redis or Memcached storage
- Disk and S3-compatible file storage
- Split read/write deployments with read-only mode
- Prometheus metrics
- Multiple languages

A [business license](https://yopass.se/#pricing) adds features for shared and managed deployments:

- OpenID Connect authentication and email-domain restrictions
- Custom themes, logo, and application name
- Structured audit logging for security-relevant events
- Secret requests
- Read receipts
- Signed webhooks for secret lifecycle events
- File uploads larger than 1 MB

## Quick start

You need [Docker](https://docs.docker.com/get-docker/). Start Memcached and Yopass with:

```console
docker network create yopass
docker run -d --name yopass-memcached --network yopass memcached
docker run -d --name yopass --network yopass \
  -p 127.0.0.1:1337:1337 \
  jhaals/yopass --memcached=yopass-memcached:11211
```

Open [http://localhost:1337](http://localhost:1337) and create your first secret.

This setup binds Yopass to `127.0.0.1` without TLS and is intended for local testing or use behind a TLS-terminating reverse proxy. See the [quick-start guide](https://yopass.se/docs/quickstart) for Redis and other setup options.

## Production deployment

Yopass must be served over HTTPS in production so the web application and encrypted payload cannot be modified in transit. The repository includes examples for common deployments:

| Deployment | Start here |
| --- | --- |
| Docker Compose with automatic Let's Encrypt certificates | [`deploy/docker-compose/with-nginx-proxy-and-letsencrypt`](deploy/docker-compose/with-nginx-proxy-and-letsencrypt) |
| Docker Compose behind an existing reverse proxy | [`deploy/docker-compose/insecure`](deploy/docker-compose/insecure) |
| Kubernetes | [`deploy/yopass-k8.yaml`](deploy/yopass-k8.yaml) |

The [TLS guide](https://yopass.se/docs/tls) covers built-in TLS and reverse proxy configurations for Nginx, Caddy, and Traefik.

## Configuration

Yopass accepts configuration through command-line flags or environment variables. Environment variable names are uppercase with dashes replaced by underscores.

```console
# Memcached (default)
yopass-server --memcached localhost:11211

# Redis
yopass-server --database redis --redis redis://localhost:6379/0
```

Password key derivation can optionally use memory-hard [Argon2id](https://datatracker.ietf.org/doc/rfc9106/) with `--argon2`. This requires the `'wasm-unsafe-eval'` CSP directive, so reverse proxies that replace the `Content-Security-Policy` header must allow it. See [Argon2 key derivation](https://yopass.se/docs/server-options#argon2-key-derivation) for details.

The [server options reference](https://yopass.se/docs/server-options) documents every flag and environment variable. These guides cover the main deployment topics:

| Guide | Description |
| --- | --- |
| [TLS / HTTPS](https://yopass.se/docs/tls) | Built-in TLS, Nginx, Caddy, Traefik, and Let's Encrypt |
| [File storage](https://yopass.se/docs/file-storage) | Disk and S3/MinIO backends, size limits, and cleanup |
| [Read-only mode](https://yopass.se/docs/read-only-mode) | Separate secret creation from retrieval |
| [Metrics](https://yopass.se/docs/metrics) | Prometheus metrics, alerts, and Grafana queries |
| [OpenID Connect](https://yopass.se/docs/openid-connect) | OIDC authentication and access controls *(license required)* |
| [Theming](https://yopass.se/docs/theming) | Custom themes, logo, and application name *(license required)* |
| [Audit logging](https://yopass.se/docs/audit-logging) | Structured NDJSON event logs *(license required)* |
| [Secret requests](https://yopass.se/docs/secret-requests) | Collect a secret through an end-to-end encrypted request link *(license required)* |
| [Read receipts](https://yopass.se/docs/read-receipts) | Check whether a secret was opened *(license required)* |
| [Webhooks](https://yopass.se/docs/webhooks) | Signed lifecycle event notifications *(license required)* |

## Contributing

Bug reports, fixes, and translations are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) to set up the Go backend and React frontend locally. For security vulnerabilities, follow the private reporting process in [SECURITY.md](SECURITY.md).

Yopass supports multiple languages through react-i18next. See the [current translations](website/src/shared/lib/i18n.ts) and [an example translation pull request](https://github.com/jhaals/yopass/pull/3024).

## Project history

Yopass was first released in 2014 and has since been maintained with help from many [contributors](https://github.com/jhaals/yopass/graphs/contributors). Organizations using Yopass include [Spotify](https://spotify.com), [Doddle](https://doddle.com), and [Gumtree Australia](https://www.gumtreeforbusiness.com.au/).

If Yopass is useful to you, consider making a donation or getting in touch to have your organization listed here.
