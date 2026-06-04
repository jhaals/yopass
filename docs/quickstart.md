---
title: Quick Start
sidebar_position: 2
description: Get Yopass running in five minutes with Docker Compose.
---

# Quick Start

Get Yopass running locally in under five minutes. The recommended path is Docker Compose — it wires up the server and its storage backend in a single command.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and Docker Compose (v2+)
- Port `1337` available on your machine

---

## Option 1: Docker Compose (recommended)

### With Memcached

```yaml title="docker-compose.yml"
services:
  yopass:
    image: ghcr.io/jhaals/yopass:latest
    ports:
      - "1337:1337"
    environment:
      MEMCACHED: memcached:11211
    depends_on:
      - memcached

  memcached:
    image: memcached
```

### With Redis

```yaml title="docker-compose.yml"
services:
  yopass:
    image: ghcr.io/jhaals/yopass:latest
    ports:
      - "1337:1337"
    environment:
      DATABASE: redis
      REDIS: redis://redis:6379/0
    depends_on:
      - redis

  redis:
    image: redis:7-alpine
```

Start either setup with:

```bash
docker compose up -d
```

Open [http://localhost:1337](http://localhost:1337) — Yopass is running.

:::tip Share your first secret
1. Type or paste a secret into the box.
2. Choose an expiration (1 hour, 1 day, or 1 week).
3. Click **Encrypt**. Copy the generated link.
4. Send the link to the recipient. It self-destructs after one view.
:::

---

## Common server flags

| Flag | Env var | Default | Description |
|------|---------|---------|-------------|
| `--memcached` | `MEMCACHED` | — | `host:port` of the Memcached instance |
| `--redis` | `REDIS` | — | Redis connection URL (e.g. `redis://host:port/0`) |
| `--port` | `PORT` | `1337` | Port for the HTTP server |
| `--max-length` | `MAX_LENGTH` | `10000` | Maximum secret length in characters |
| `--metrics-port` | `METRICS_PORT` | — | Port to expose Prometheus metrics (disabled when unset) |
| `--license-key` | `LICENSE_KEY` | — | License key for premium features |

:::info Backend required
Yopass requires either `--memcached` or `--redis`. Starting without either will cause the server to exit.
:::

---

## Next steps

- **Add TLS** — [TLS / HTTPS guide](./tls) to serve over HTTPS
- **Enable file uploads** — [File Storage guide](./file-storage) for disk or S3 backends
- **Add authentication** — [OpenID Connect guide](./openid-connect) *(license required)*
- **Customize branding** — [Theming guide](./theming) *(license required)*
- **Production metrics** — [Metrics guide](./metrics) for Prometheus and Grafana
