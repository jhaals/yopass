# Yopass threat model

## Purpose and trust boundaries

Yopass shares expiring secrets and files using client-side OpenPGP encryption.
The browser and the CLIs encrypt before uploading; decryption keys normally live
in the URL fragment and must not be sent to the server. Custom passwords and
optional Argon2id key derivation are also supported. The server stores
caller-supplied ciphertext in Memcached, Redis, disk storage or S3-compatible
storage. Checking OpenPGP armor does not prove a submitted payload is encrypted.

Treat HTTP requests, ciphertext, upload streams, filenames, URL parameters,
request and receipt tokens, and data returned from storage as untrusted. Review
the frontend as well as the API: an XSS can expose plaintext and decryption
keys. Secret URLs are bearer capabilities; knowing a secret ID permits fetching
its ciphertext, while decrypting it requires its key or password.

One-time retrieval, expiration, atomic claims, request fulfillment and read
receipts must enforce their documented behavior, including concurrent access.
OIDC sessions, verified email and domain restrictions, API tokens and read-only
mode must enforce the configured access policy. Receiving a shared secret is
intentionally possible without logging in; requiring authentication controls
creation as documented in docs/openid-connect.md.

Assume production uses HTTPS and the operator controls configuration, the OIDC
provider, storage credentials, trusted proxies and webhook destinations. Check
whether untrusted request data can cross those boundaries, rather than treating
an operator's ability to configure a destination as an SSRF on its own.

## Focus and scope

Prioritize pkg/server, pkg/yopass, cmd/yopass-server, cmd/yopass, server/src,
cli/src and website/src.

Yopass is moving to Rust. server/ is a Rust reimplementation of the Go server,
published as the jhaals/yopass:next image, and cli/ is the Rust CLI. Both are
in scope with the same severity as their Go counterparts. The Rust server takes
the same flags and data format; server/README.md lists its intended differences
from Go. Any other behavioural difference that weakens a guarantee is a bug.
Include file path handling, streaming limits, cleanup, cryptography, session and
token validation, security headers, browser rendering, audit logging, webhook
signatures, and unintended disclosure through logs or metadata. The Lambda
adapter in deploy/cdk is also relevant. Business feature implementations are
in scope; existing Go tests exercise them with locally constructed test state,
so scanning does not need a production license or private signing key.

Use SECURITY.md and docs/ for the intended guarantees. Per SECURITY.md, do not
report brute-force enumeration of UUIDs or encryption keys, browser history or
cache retention of secret URLs, absent rate limiting, version disclosure,
temporary browser storage of ciphertext, social engineering, or build-only
dependency vulnerabilities without runtime impact. Do not test public Yopass
instances or other external services; use local fixtures and mocks.

## Build and offline testing

The image retains the checkout at /src, Go, Rust and Node toolchains, Go module
and Cargo caches, debug builds of every Rust target, website/node_modules and all
three Playwright browsers. Go workspace mode is disabled so the root module and
deploy/cdk can be exercised separately. The Go binaries are /usr/local/bin/yopass
and /usr/local/bin/yopass-server; the Rust binaries are
/src/server/target/debug/yopass-server and /src/cli/target/debug/yopass. Compiled
frontend assets are in /src/website/dist and /src/public.

In the scanner's offline shell, start the installed local databases and run:

```sh
memcached -u root -l 127.0.0.1 -p 11211 -d
redis-server --bind 127.0.0.1 --port 6379 --daemonize yes --save "" --appendonly no
cd /src
MEMCACHED=127.0.0.1:11211 REDIS_URL=redis://127.0.0.1:6379/0 go test -race ./cmd/... ./pkg/...
cd /src/deploy/cdk
go test -race ./...
cd /src/server
export SENTINEL_URL="$(tests/sentinel.sh /tmp/sentinel | tail -n 1)"
# The replica tests need the replica online before they start.
for _ in $(seq 100); do
  redis-cli -p 16400 -a redis-pw --no-auth-warning info replication | grep -q state=online && break
  sleep 0.2
done
MEMCACHED=127.0.0.1:11211 REDIS_URL=redis://127.0.0.1:6379/0 \
  YOPASS_GO_SERVER=/usr/local/bin/yopass-server cargo test --locked
cd /src/cli
YOPASS_REQUIRE_OPENPGPJS=1 cargo test --locked
cd /src/website
yarn test:unit
CI=true yarn test:e2e
```

The CDK tests that require DYNAMODB_ENDPOINT need a local DynamoDB emulator;
none is bundled, and those tests skip without the variable. The Rust tests that
need VALKEY_URL or REDIS_TLS_URL skip without them. YOPASS_GO_SERVER enables
the Go/Rust parity tests in server/tests/parity.rs. S3 and OIDC tests use local
mocks. Playwright starts its own Vite server; the existing browser tests use
fixtures and are not a substitute for testing the server APIs. To exercise the
application manually, run either server from /src (the default asset path,
`public`, is relative) with `--memcached=127.0.0.1:11211` and
use its HTTP listener on port 1337, or a CLI against that local listener.

## Severity and useful reports

Rate severity as follows:

- Critical: plaintext or decryption-key disclosure, including XSS on any page
  that handles a secret, unauthorized decryption, remote code execution, and
  bypassing required authentication to create secrets.
- High: one-time or expiration bypass, arbitrary file read or write, reading or
  revoking another user's secret request or receipt, and webhook or audit log
  forgery.
- Medium: denial of service with a bounded input, and XSS that cannot reach a
  secret or key.
- Low: metadata disclosure such as filenames, sizes or timing.

Explain the attacker's required knowledge and access, affected configurations and practical impact;
distinguish an intended bearer capability from an authorization bypass.
For denial of service, show disproportionate resource consumption or a crash
with a bounded input, rather than merely the absence of rate limiting.

Include a local reproducer, relevant code paths and a focused patch with a
regression test where possible. Never include real secrets, credentials or
private keys in reports or test fixtures.
