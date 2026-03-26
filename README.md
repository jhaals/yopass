![Yopass-horizontal](https://user-images.githubusercontent.com/37777956/59544367-0867aa80-8f09-11e9-8d6a-02008e1bccc7.png)

# Yopass - Share Secrets Securely

[![Go Report Card](https://goreportcard.com/badge/github.com/jhaals/yopass)](https://goreportcard.com/report/github.com/jhaals/yopass)
[![codecov](https://codecov.io/gh/jhaals/yopass/branch/master/graph/badge.svg)](https://codecov.io/gh/jhaals/yopass)
![GitHub release (latest SemVer)](https://img.shields.io/github/v/release/jhaals/yopass?sort=semver)

![demo](https://ydemo.netlify.com/yopass-demo.gif)

Yopass is a project for sharing secrets in a quick and secure manner.
The sole purpose of Yopass is to minimize passwords floating around in ticket management systems, Slack messages, and emails. Messages are encrypted/decrypted locally in the browser and sent to Yopass without the decryption key, which is only visible once during encryption. Yopass then returns a one-time URL with a specified expiry date.

There is no perfect way of sharing secrets online, and there is a trade-off in every implementation. Yopass is designed to be as simple and "dumb" as possible without compromising security. There's no mapping between the generated UUID and the user who submitted the encrypted message. It's always best to send all context except the password over another channel.

**[Demo available here](https://yopass.se)**. It's recommended to host yopass yourself if you care about security.

- End-to-End encryption using [OpenPGP](https://openpgpjs.org/)
- Secrets can only be viewed once
- No accounts or user management required
- Secrets self destruct after X hours
- Custom password option
- File upload with streaming encryption

## History

Yopass was first released in 2014 and has since been maintained by me and contributed to by this fantastic group of [contributors](https://github.com/jhaals/yopass/graphs/contributors). Yopass is used by many large corporations, some of which are listed below.

If you are using Yopass and want to support the project beyond code contributions, you can give thanks via email, consider donating, or give consent to list your company name as a user of Yopass in this readme.

## Trusted by

- [Doddle LTD](https://doddle.com)
- [Spotify](https://spotify.com)
- [Gumtree Australia](https://www.gumtreeforbusiness.com.au/)

## Command-line interface

The main motivation of Yopass is to make it easy for everyone to share secrets quickly via a simple web interface. A command-line interface is also provided to support use cases where program output needs to be shared.

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

The following options are currently available to install the CLI locally.

- Compile from source (requires Go >= v1.21)

  ```console
  go install github.com/jhaals/yopass/cmd/yopass@latest
  ```

## Installation / Configuration

Here are the server configuration options.

Command line flags:

```console
$ yopass-server -h
      --address string                listen address (default 0.0.0.0)
      --port int                      listen port (default 1337)
      --database string               database backend ('memcached' or 'redis') (default "memcached")
      --memcached string              Memcached address (default "localhost:11211")
      --redis string                  Redis URL (default "redis://localhost:6379/0")
      --max-length int                max length of encrypted secret in bytes (default 10000)
      --max-file-size string          max file upload size (e.g. 10KB, 14MB, 1GB, 1.5GB) (default "512KB")
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
      --metrics-port int              metrics server listen port (default -1)
      --health-check                  perform database health check and exit
      --log-level                     log level (debug, info, warn, error)
```

Encrypted secrets can be stored either in Memcached or Redis by changing the `--database` flag.

### Proxy Configuration

When Yopass is deployed behind a reverse proxy or load balancer (such as Nginx, Caddy, Cloudflare, or AWS ALB), you may want to log the real client IP addresses instead of the proxy's IP. Yopass supports trusted proxy configuration for secure handling of `X-Forwarded-For` headers.

**Security Note**: X-Forwarded-For headers are only trusted when requests come from explicitly configured trusted proxies. This prevents IP spoofing from untrusted sources.

#### Examples:

```bash
# Trust a single proxy IP
yopass-server --trusted-proxies 192.168.1.100

# Trust multiple proxy IPs
yopass-server --trusted-proxies 192.168.1.100,10.0.0.50

# Trust proxy subnets (CIDR notation)
yopass-server --trusted-proxies 192.168.1.0/24,10.0.0.0/8

# Environment variable (useful for Docker)
export TRUSTED_PROXIES="192.168.1.0/24,10.0.0.0/8"
yopass-server
```

#### Common Proxy Scenarios:

- **Nginx/Apache**: Use the IP address of your reverse proxy server
- **Cloudflare**: Use Cloudflare's IP ranges (available from their documentation)
- **AWS ALB/ELB**: Use your VPC's CIDR block or the load balancer's subnet
- **Docker networks**: Use the Docker network's gateway IP or subnet

Without trusted proxies configured, Yopass will always use the direct connection IP for security, which is the recommended default behavior.

### File Storage

Uploaded files are encrypted client-side and stored as binary data. By default files are stored in the database (Memcached/Redis), but for larger files you can configure a dedicated file store.

**Database (default)** — no extra configuration needed. Files are base64-encoded and stored in Memcached or Redis. This works well for small files but is limited by the database backend's value size limit (~1MB for Memcached). A warning is printed at startup if `--max-file-size` exceeds 1MB without a dedicated file store configured.

**Disk** — stores files on the local filesystem with automatic cleanup of expired files.

```bash
yopass-server --file-store disk --file-store-path /data/yopass-files
```

**S3** — stores files in an S3 bucket. Works with AWS S3 and compatible services like MinIO.

```bash
# AWS S3
yopass-server --file-store s3 --file-store-s3-bucket my-yopass-bucket

# MinIO or S3-compatible service
yopass-server --file-store s3 \
  --file-store-s3-bucket my-bucket \
  --file-store-s3-endpoint http://minio:9000 \
  --file-store-s3-region us-east-1
```

**S3 cleanup** — By default, Yopass runs a background goroutine that lists all objects and calls `GetObjectTagging` on each one to find expired files. This works but becomes expensive at scale due to the per-object API calls on every sweep.

The strongly recommended approach is to use an S3 lifecycle rule and disable the built-in cleanup with `--disable-file-cleanup`:

```bash
yopass-server --file-store s3 --file-store-s3-bucket my-yopass-bucket --disable-file-cleanup
```

Since the longest secret TTL in Yopass is 1 week, a lifecycle rule that deletes objects older than 7 days guarantees cleanup with zero API overhead:

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

This is cheaper, simpler, and scales to any number of objects. The built-in cleanup is only necessary when S3 lifecycle rules are unavailable (e.g. some MinIO configurations).

The `--cleanup-interval` flag controls how often the built-in cleanup runs (default: 60 seconds). It has no effect when `--disable-file-cleanup` is set.

### Read-Only Mode

Yopass supports a read-only mode that disables all secret creation endpoints while keeping retrieval active. This allows you to deploy two instances sharing the same database — a protected instance for creating secrets (behind authentication) and a public instance for retrieving them.

```bash
yopass-server --read-only
```

In read-only mode, `POST /create/secret` and `POST /create/file` return 404. Retrieval (`GET /secret/{key}`, `GET /file/{key}`) and deletion (`DELETE /secret/{key}`) remain available.

### Docker Compose

Use the Docker Compose file `deploy/with-nginx-proxy-and-letsencrypt/docker-compose.yml` to set up a Yopass instance with TLS transport encryption and automatic certificate renewal using [Let's Encrypt](https://letsencrypt.org/). First, point your domain to the host where you want to run Yopass. Then replace the placeholder values for `VIRTUAL_HOST`, `LETSENCRYPT_HOST`, and `LETSENCRYPT_EMAIL` in the docker-compose.yml file with your values. Change to the deployment directory and start the containers:

```console
docker-compose up -d
```

Yopass will then be available under the domain you specified through `VIRTUAL_HOST` / `LETSENCRYPT_HOST`.

Advanced users who already have a reverse proxy handling TLS connections can use the `insecure` setup:

```console
cd deploy/docker-compose/insecure
docker-compose up -d
```

Then point your reverse proxy to `127.0.0.1:80`.

### Docker

With TLS encryption

```console
docker run --name memcached_yopass -d memcached
docker run -p 443:1337 -v /local/certs/:/certs \
    --link memcached_yopass:memcached -d jhaals/yopass --memcached=memcached:11211 --tls-key=/certs/tls.key --tls-cert=/certs/tls.crt
```

Yopass will then be available on port 443 through all IP addresses of the host, including public ones. To limit availability to a specific IP address, use `-p 127.0.0.1:443:1337`.

Without TLS encryption (needs a reverse proxy for transport encryption):

```console
docker run --name memcached_yopass -d memcached
docker run -p 127.0.0.1:80:1337 --link memcached_yopass:memcached -d jhaals/yopass --memcached=memcached:11211
```

Then point your reverse proxy that handles TLS connections to `127.0.0.1:80`.

### Kubernetes

```console
kubectl apply -f deploy/yopass-k8.yaml
kubectl port-forward service/yopass 1337:1337
```

_This is meant to get you started, please configure TLS when running yopass for real._

## Monitoring

Yopass optionally provides metrics in the [OpenMetrics][] / [Prometheus][] text
format. Use flag `--metrics-port <port>` to let Yopass start a second HTTP
server on that port making the metrics available on path `/metrics`.

Supported metrics:

- Basic [process metrics][] with prefix `process_` (e.g. CPU, memory, and file descriptor usage)
- Go runtime metrics with prefix `go_` (e.g. Go memory usage, garbage collection statistics, etc.)
- HTTP request metrics with prefix `yopass_http_` (HTTP request counter, and HTTP request latency histogram)

[openmetrics]: https://openmetrics.io/
[prometheus]: https://prometheus.io/
[process metrics]: https://prometheus.io/docs/instrumenting/writing_clientlibs/#process-metrics

## Translations

Yopass accepts translations for additional languages. The frontend includes internationalization support using react-i18next, see [current translations](https://github.com/jhaals/yopass/blob/master/website/src/shared/lib/i18n.ts). Translation contributions are welcome via pull requests, see example [here](https://github.com/jhaals/yopass/pull/3024) for adding a new language.
