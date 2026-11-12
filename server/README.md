# yopass-next

An alpha Rust implementation of `yopass-server`, published as the `jhaals/yopass:next` Docker image (and `next-<version>` for a fixed build). The Go server in `cmd/yopass-server` remains the stable release and keeps `jhaals/yopass:latest` and the version tags; it is unaffected by this crate.

It serves the same frontend, takes the same flags and environment variables, and stores the same data format, so it can run against an existing Memcached, Redis or Valkey. Both servers can share a backend at the same time, and one-time claims hold across them.

```bash
docker run -p 1337:1337 -e MEMCACHED=memcached:11211 jhaals/yopass:next
docker run -p 1337:1337 -e DATABASE=redis -e REDIS=redis://valkey:6379/0 jhaals/yopass:next
```

## Differences from the Go server

- **Outages are reported as outages.** `GET /secret/{key}`, `/file/{key}` and their status routes answer 503 when the database is unreachable. Go answers 404, which looks like a spent link.
- **Session cookies are not interchangeable.** The cookie format differs, so a user logged in through one server must log in again on the other. A login in progress cannot cross servers either.
- **Stricter parsing.** `--trusted-proxies` rejects anything that is not an IP or CIDR. JSON bodies must be a single document and field names are case-sensitive.
- **No stored value without a lifetime.** Backends refuse a zero expiration, which would mean "never expire".
- **Webhooks do not follow redirects.** A redirect would resend the signed body somewhere unconfigured.
- **OIDC redirects are not followed** either, and ID tokens must use an asymmetric signature.
- **The audit log file is created with mode 0600.**
- **Static directories are not listed.**
- **OIDC signing keys are cached with an expiry.** They are refetched after an hour, or when a token fails verification (at most every 30 seconds). If a refetch fails, the held keys keep working for up to 24 hours, then logins fail closed.
- **`--max-file-size=0` needs a license.** It means unlimited, so without a valid license it is capped at 1MB like any other large value.
- **Expiry webhooks stop with the license.** Go keeps sending `secret.expired` and `request.expired` after a license lapses mid-run.
- **S3 over plain HTTP works.** The Go server cannot upload to an `http://` `--file-store-s3-endpoint` (its SDK streams only over TLS), so a local MinIO needs TLS there.
- **S3 calls have a deadline.** Reads, deletes and health checks give up after 30 seconds, like the Go sweeper's calls; an upload is bounded by `--file-transfer-timeout`, as in Go.
- **AWS SDK debug logs stay off.** They print object keys, which are secret IDs, so `--log-level=debug` keeps the SDK at info. Naming a crate, as in `debug,aws_smithy_runtime=debug`, turns it back on.
- **Sentinel URLs take go-redis tuning options but not their values.** `dial_timeout`, `pool_size` and the like are accepted and checked, so the same `--redis` works for both servers, but this server keeps its own timeouts and connection limit.
- **HSTS follows proxy trust.** With `--trusted-proxies` set, `X-Forwarded-Proto` from any other peer does not add the header.

## Design notes

Some Rust-specific risks shaped the code, and each has a test:

- **Handlers run on their own task.** Hyper drops a request's future when its client disconnects, which could stop a handler between a one-time claim and its audit record, or an upload between its commit and its metadata. See `detach` in `src/app.rs`.
- **`HEAD` has its own route.** axum answers `HEAD` by running the `GET` handler unless told otherwise, and a link scanner must not spend a one-time link.
- **Connections close with a linger.** Closing with unread request data resets the connection, so a refused upload would look like a network error. See `GuardedIo` in `src/serve.rs`.
- **Clients never resend.** Memcached uses a small client in `src/db/memcached.rs`, and a connection with any failure is closed instead of reused, so a late reply cannot answer a later command. A write that may have applied is reported as failed and not sent again.
- **`unsafe` is forbidden** across the crate.
- **Memory after file bursts.** Files kept in the database are copied a few times on the way in (base64, JSON, the backend command). glibc then keeps the freed buffers for reuse, so a burst of large uploads leaves the process at a steady, bounded size rather than shrinking back. `MALLOC_MMAP_THRESHOLD_=131072` makes it return them. That cut memory held after a burst from 77 MB to 28 MB in our tests, but costs about a third of the upload throughput. Disk and S3 stores stream and are unaffected.

## Tests

```bash
docker run -d -p 6379:6379 redis
docker run -d -p 6380:6379 valkey/valkey
docker run -d -p 11211:11211 memcached
export SENTINEL_URL=$(tests/sentinel.sh /tmp/yopass-sentinel)   # needs redis-server
redis-server --port 0 --tls-port 16420 --bind 127.0.0.1 --save '' --daemonize yes --tls-auth-clients no \
  --tls-cert-file tests/fixtures/s3_cert.pem --tls-key-file tests/fixtures/s3_key.pem --tls-ca-cert-file tests/fixtures/s3_ca.pem
export REDIS_TLS_URL=rediss://127.0.0.1:16420/0
go build -o /tmp/yopass-go ../cmd/yopass-server

export REDIS_URL=redis://localhost:6379/0 VALKEY_URL=redis://localhost:6380/0 MEMCACHED=localhost:11211
export YOPASS_GO_SERVER=/tmp/yopass-go
cargo test
```

Without those variables, backend tests run only against the in-memory database and the Go comparison is skipped.

| Suite | Covers |
| --- | --- |
| `tests/db_contract.rs` | The database contract on every backend: claim races, replaced values, lost replies and lost commands through a fault-injecting TCP proxy, writes never resent |
| `tests/secrets.rs`, `tests/files.rs`, `tests/requests.rs`, `tests/receipts.rs` | Lifecycles and HTTP-level races across several server instances, plus failure handling |
| `tests/lifecycle.rs` | The secret lifecycle's ordering invariants without the HTTP stack: receipt before claim, open before claim, cleanup after delivery and revocation |
| `tests/auth.rs` | Cookie authority, forged tokens and CSRF, against a real HTTP identity provider |
| `tests/transport.rs` | Real sockets: disconnects, stalled peers, header limits, TLS, shutdown |
| `tests/sentinel.rs` | Following the primary through a real Sentinel failover; the database contract and the Go comparison also run on Sentinel |
| `tests/s3.rs` | The S3 file store and its sweeper against an in-process S3 that checks signatures, rejects tagging like R2 and fails or stalls on demand, and the file endpoints and binary on it |
| `tests/logging.rs` | Secret IDs, tokens and query strings never reach logs |
| `tests/parity.rs` | Runs the Go and Rust binaries side by side and compares answers across flag combinations, then checks stored data, one-time claims, and S3 files and expiry across both |
| `tests/http_contract.rs`, `tests/webhooks.rs`, `tests/cli.rs` | Routes, `/config`, exact errors, webhook signing and retries, startup failures |

Licensed features are tested in-process with an injected license. `tests/parity.rs` compares unlicensed behaviour only, because the Go binary needs a real key.

The files in `tests/fixtures/` are throwaway test keys. They protect nothing.
