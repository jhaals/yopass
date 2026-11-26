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

### With Valkey (recommended)

```yaml title="docker-compose.yml"
services:
  yopass:
    image: jhaals/yopass:latest
    ports:
      - "1337:1337"
    environment:
      DATABASE: redis
      REDIS: redis://valkey:6379/0
    depends_on:
      - valkey

  valkey:
    image: valkey/valkey:8-alpine
    command: valkey-server --save "" --appendonly no
```

[Valkey](https://valkey.io/) speaks the Redis protocol, so it uses the `redis` backend. Redis works with the same settings. The `command` turns off snapshots and the append-only file, so secrets stay in memory and are never written to disk. See [Persistence](#persistence) to change that.

### With Memcached

```yaml title="docker-compose.yml"
services:
  yopass:
    image: jhaals/yopass:latest
    ports:
      - "1337:1337"
    environment:
      MEMCACHED: memcached:11211
    depends_on:
      - memcached

  memcached:
    image: memcached
```

Memcached is supported, but it evicts unexpired secrets when memory runs low and limits items to 1 MB by default.

Start either setup with:

```bash
docker compose up -d
```

Open [http://localhost:1337](http://localhost:1337) — Yopass is running.

:::tip Share your first secret
1. Type or paste a secret into the box.
2. Choose an expiration (1 hour, 1 day, or 1 week).
3. Click **Encrypt**, or press **Ctrl+Enter** (**Cmd+Enter** on macOS) while focused in the form. Copy the generated link.
4. Send the link to the recipient. It self-destructs after one view.
:::

---

## Persistence

The examples in these docs run Valkey in memory only. A secret that has expired or been opened is gone, and restarting Valkey removes every stored secret.

To keep secrets across restarts, remove the `command` line and mount a volume on `/data`:

```yaml
  valkey:
    image: valkey/valkey:8-alpine
    volumes:
      - valkey-data:/data

volumes:
  valkey-data:
```

Valkey then writes snapshots to that volume. A snapshot holds the encrypted secrets, so a deleted or expired secret stays in the snapshot file, and in any backup of the volume, until a later snapshot replaces it.

Memcached never writes to disk.

---

## Common server flags

| Flag | Env var | Default | Description |
|------|---------|---------|-------------|
| `--database` | `DATABASE` | `memcached` | Storage backend: `memcached` or `redis` |
| `--memcached` | `MEMCACHED` | `localhost:11211` | `host:port` of the Memcached instance |
| `--redis` | `REDIS` | `redis://localhost:6379/0` | Valkey or Redis connection URL |
| `--port` | `PORT` | `1337` | Port for the HTTP server |
| `--max-length` | `MAX_LENGTH` | `10000` | Maximum encrypted secret size in bytes |
| `--metrics-port` | `METRICS_PORT` | — | Port to expose Prometheus metrics (disabled when unset) |
| `--license-key` | `LICENSE_KEY` | — | License key for premium features |

See [Server Options](./server-options) for the complete list.

:::info Backend required
Yopass needs a Valkey, Redis or Memcached backend to store secrets. Valkey is recommended. The server still uses Memcached unless `--database redis` is set; `--redis` alone does not switch the backend.
:::

---

## Next steps

- **Add TLS** — [TLS / HTTPS guide](./tls) to serve over HTTPS
- **Enable file uploads** — [File Storage guide](./file-storage) for disk or S3 backends
- **Add authentication** — [OpenID Connect guide](./openid-connect) *(license required)*
- **Customize branding** — [Theming guide](./theming) *(license required)*
- **Production metrics** — [Metrics guide](./metrics) for Prometheus and Grafana
