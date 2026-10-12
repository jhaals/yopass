<p align="center">
  <img src="website/public/favicon.svg" alt="" width="72" height="72">
</p>

<h1 align="center">urlx.net · One-time secret links</h1>

<p align="center">
  urlx is a self-hosted service for sharing passwords, files, and other sensitive information.
  The browser encrypts your secret before it reaches the server and the decryption key is never stored with the secret.
</p>

<p align="center">
  <a href="docs/intro.mdx"><strong>Read the docs</strong></a>
  ·
  <a href="#quick-start"><strong>Self-host urlx</strong></a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/mehrabiyan/urlx" alt="Apache 2.0 license"></a>
</p>

Use urlx instead of putting credentials in email, chat history, or ticket systems. It needs no user accounts for the standard secret-sharing flow, collects no tracking data, and stores no plaintext secrets. Links can work once or remain available until their configured expiration.

## How it works

1. urlx generates a random decryption key and encrypts the secret in your browser using [OpenPGP](https://openpgpjs.org/).
2. The server stores the encrypted message with an expiration time. It cannot read the secret.
3. urlx creates a link whose URL fragment contains the decryption key. URL fragments are not sent to the server.
4. The recipient's browser downloads the encrypted message and decrypts it locally. A one-time secret is removed after its first retrieval.

## Features

The open source edition includes:

- End-to-end encryption for text and files
- One-time links and automatic expiration, with optional custom durations
- Optional password protection
- No accounts or user management
- Redis or Memcached storage
- Disk and S3-compatible file storage
- Split read/write deployments with read-only mode
- Prometheus metrics
- Multiple languages

A business license key adds features for shared and managed deployments. License keys are issued by Yopass AB for the upstream Yopass project; see [Yopass pricing](https://yopass.se/#pricing):

- OpenID Connect authentication and email-domain restrictions
- Custom themes, logo, and application name
- Structured audit logging for security-relevant events
- Secret requests
- Read receipts
- Signed webhooks for secret lifecycle events
- File uploads larger than 1 MB

## Quick start

You need [Docker](https://docs.docker.com/get-docker/). Start Memcached and urlx with:

```console
docker network create urlx
docker run -d --name urlx-memcached --network urlx memcached
docker run -d --name urlx --network urlx \
  -p 127.0.0.1:1337:1337 \
  ghcr.io/mehrabiyan/urlx --memcached=urlx-memcached:11211
```

Open [http://localhost:1337](http://localhost:1337) and create your first secret.

This setup binds urlx to `127.0.0.1` without TLS and is intended for local testing or use behind a TLS-terminating reverse proxy. See the [quick-start guide](docs/quickstart.md) for Redis and other setup options.

## Production deployment

urlx must be served over HTTPS in production so the web application and encrypted payload cannot be modified in transit. The repository includes examples for common deployments:

| Deployment | Start here |
| --- | --- |
| Docker Compose with automatic Let's Encrypt certificates | [`deploy/docker-compose/with-nginx-proxy-and-letsencrypt`](deploy/docker-compose/with-nginx-proxy-and-letsencrypt) |
| Docker Compose behind an existing reverse proxy | [`deploy/docker-compose/insecure`](deploy/docker-compose/insecure) |
| Kubernetes | [`deploy/urlx-k8.yaml`](deploy/urlx-k8.yaml) |

The [TLS guide](docs/tls.md) covers built-in TLS and reverse proxy configurations for Nginx, Caddy, and Traefik.

## Configuration

urlx accepts configuration through command-line flags or environment variables. Environment variable names are uppercase with dashes replaced by underscores.

```console
# Memcached (default)
urlx-server --memcached localhost:11211

# Redis
urlx-server --database redis --redis redis://localhost:6379/0
```

Password key derivation can optionally use memory-hard [Argon2id](https://datatracker.ietf.org/doc/rfc9106/) with `--argon2`. This requires the `'wasm-unsafe-eval'` CSP directive, so reverse proxies that replace the `Content-Security-Policy` header must allow it. See [Argon2 key derivation](docs/server-options.md#argon2-key-derivation) for details.

The [server options reference](docs/server-options.md) documents every flag and environment variable. These guides cover the main deployment topics:

| Guide | Description |
| --- | --- |
| [TLS / HTTPS](docs/tls.md) | Built-in TLS, Nginx, Caddy, Traefik, and Let's Encrypt |
| [File storage](docs/file-storage.md) | Disk and S3/MinIO backends, size limits, and cleanup |
| [Read-only mode](docs/read-only-mode.md) | Separate secret creation from retrieval |
| [Metrics](docs/metrics.md) | Prometheus metrics, alerts, and Grafana queries |
| [OpenID Connect](docs/openid-connect.md) | OIDC authentication and access controls *(license required)* |
| [Theming](docs/theming.md) | Custom themes, logo, and application name *(license required)* |
| [Audit logging](docs/audit-logging.md) | Structured NDJSON event logs *(license required)* |
| [Secret requests](docs/secret-requests.md) | Collect a secret through an end-to-end encrypted request link *(license required)* |
| [Read receipts](docs/read-receipts.md) | Check whether a secret was opened *(license required)* |
| [Webhooks](docs/webhooks.md) | Signed lifecycle event notifications *(license required)* |

## Contributing

Bug reports, fixes, and translations are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) to set up the Go backend and React frontend locally. For security vulnerabilities, follow the private reporting process in [SECURITY.md](SECURITY.md).

urlx supports multiple languages through react-i18next. See the [current translations](website/src/shared/lib/i18n.ts).

## Credits

urlx is based on [Yopass](https://github.com/jhaals/yopass) by Johan Haals and its contributors, released under the [Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for attribution. urlx is not affiliated with or endorsed by the Yopass project.
