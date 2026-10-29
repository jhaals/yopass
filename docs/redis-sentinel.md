---
title: Redis Sentinel
sidebar_position: 7.5
description: Run Yopass against a highly available Redis or Valkey replication set managed by Sentinel.
---

# Redis Sentinel

Yopass can find the Redis primary through [Redis Sentinel](https://redis.io/docs/latest/operate/oss_and_stack/management/sentinel/). After a failover, the server asks Sentinel for the new primary and reconnects, so no TCP proxy is needed in front of the replication set. Valkey Sentinel works the same way.

Sentinel is not a separate database backend. Keep `--database redis` and point `--redis` at the Sentinels instead of at a single server.

---

## Configuration

Add a `master_name` query parameter to the Redis URL. The host in the URL is the first Sentinel; each additional Sentinel goes in an `addr` parameter:

```bash
yopass-server \
  --database redis \
  --redis 'redis://sentinel-1:26379/0?master_name=mymaster&addr=sentinel-2:26379&addr=sentinel-3:26379'
```

Without `master_name`, the URL connects to a single Redis server as before.

| Part | Meaning |
|------|---------|
| `sentinel-1:26379` | First Sentinel address |
| `/0` | Redis database number on the primary |
| `master_name` | Master set name from the Sentinel configuration (`sentinel monitor <name> ...`). Required |
| `addr` | Additional Sentinel address. Repeat for each Sentinel |
| `username`, `password` | Credentials for the Redis primary |
| `user:password@` in the URL | Credentials for the Sentinels, not for Redis |

List every Sentinel so Yopass can still find the primary when one Sentinel is down.

### Authentication

Sentinel and the Redis nodes usually have separate credentials. The user info part of the URL authenticates against the Sentinels. The Redis password goes in the `password` query parameter:

```bash
--redis 'redis://:sentinel-secret@sentinel-1:26379/0?master_name=mymaster&addr=sentinel-2:26379&password=redis-secret'
```

Percent-encode reserved characters such as `@`, `:`, `/` and `&` in both passwords.

### TLS

Use the `rediss://` scheme to connect to the Sentinels and the Redis nodes over TLS. Each certificate is verified against the address Yopass dials. For Redis nodes, that is the address Sentinel reports for the primary, which is an IP address unless Sentinel is configured with `announce-hostnames yes`. Certificates must be valid for those names or IP addresses.

### Unsupported options

Yopass writes on every request, including when a one-time secret is read, so it must always talk to the primary. The `replica_only`, `route_by_latency` and `route_randomly` options are rejected at startup.

Other go-redis URL options, such as `dial_timeout`, `read_timeout`, `max_retries` and `pool_size`, are accepted as query parameters.

---

## Docker Compose

The same URL works through the `REDIS` environment variable:

```yaml title="docker-compose.yml"
services:
  yopass:
    image: jhaals/yopass:latest
    ports:
      - "1337:1337"
    environment:
      DATABASE: redis
      REDIS: redis://sentinel-1:26379/0?master_name=mymaster&addr=sentinel-2:26379&addr=sentinel-3:26379
```

---

## Failover behavior

- Requests that are in flight when the primary goes down can return an error. Once Sentinel promotes a new primary, new requests succeed without a restart.
- `/ready` sends `PING` to the primary the running server is connected to. It does not check the Sentinels, so it stays ready while that primary answers, even if every Sentinel is down. It fails when the primary is unreachable and no Sentinel can name a new one.
- `--health-check` starts a new client, so it also fails when no Sentinel is reachable.

:::warning Replication is asynchronous
Redis replicates writes to replicas asynchronously. Writes the primary acknowledged can be lost during failover. This happens when the primary fails before replicating them, or when a network partition isolates the old primary while Yopass keeps writing to it. In the partition case, everything written until the partition heals is lost:

- A newly created secret can disappear, and its link returns "not found".
- A one-time secret that was just opened can come back on the new primary and be opened again. The same applies to revoked secrets and to secret requests.

To reduce the risk, set `min-replicas-to-write` and `min-replicas-max-lag` on the Redis nodes. The primary then refuses writes once it has lost contact with its replicas for longer than the configured lag, which limits how long an isolated primary keeps accepting writes. This reduces data loss but does not prevent it, and it does not guarantee that any single write reached a replica. It trades availability for consistency.
:::
