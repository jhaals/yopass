![Yopass-horizontal](https://user-images.githubusercontent.com/37777956/59544367-0867aa80-8f09-11e9-8d6a-02008e1bccc7.png)

# Yopass - Share Secrets Securely

[![Go Report Card](https://goreportcard.com/badge/github.com/jhaals/yopass)](https://goreportcard.com/report/github.com/jhaals/yopass)
[![codecov](https://codecov.io/gh/jhaals/yopass/branch/master/graph/badge.svg)](https://codecov.io/gh/jhaals/yopass)
![GitHub release (latest SemVer)](https://img.shields.io/github/v/release/jhaals/yopass?sort=semver)

![demo](https://ydemo.netlify.com/yopass-demo.gif)

Yopass is a project for sharing secrets in a quick and secure manner\*.
The sole purpose of Yopass is to minimize the amount of passwords floating around in ticket management systems, Slack messages and emails. The message is encrypted/decrypted locally in the browser and then sent to yopass without the decryption key which is only visible once during encryption, yopass then returns a one-time URL with specified expiry date.

There is no perfect way of sharing secrets online and there is a trade off in every implementation. Yopass is designed to be as simple and "dumb" as possible without compromising on security. There's no mapping between the generated UUID and the user that submitted the encrypted message. It's always best to send all the context except password over another channel.

**[Demo available here](https://yopass.se)**. It's recommended to host yopass yourself if you care about security.

- End-to-End encryption using [OpenPGP](https://openpgpjs.org/)
- Secrets can only be viewed once
- No accounts or user management required
- Secrets self destruct after X hours
- Custom password option
- Limited file upload functionality

## History

Yopass was first released in 2014 and has since then been maintained by me and contributed to by this fantastic group of [contributors](https://github.com/jhaals/yopass/graphs/contributors). Yopass is used by many large corporations none of which are currently listed in this readme.
If you are using yopass and want to support other then by code contributions. Give your thanks in an email, consider donating or by giving consent to list your company name as a user of Yopass in this readme(Trusted by)

## Trusted by

- [Doddle LTD](https://doddle.com)
- [Spotify](https://spotify.com)
- [Gumtree Australia](https://www.gumtreeforbusiness.com.au/)

## Command-line interface

The main motivation of Yopass is to make it easy for everyone to share secrets easily and quickly via a simple web interface. Nevertheless, a command-line interface is provided as well to support use cases where the output of a program needs to be shared.

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

- Compile from source (needs Go >= v1.15)

  ```console
  go install github.com/jhaals/yopass/cmd/yopass@latest
  ```

## Installation / Configuration

Here are the server configuration options.

Command line flags:

```console
$ yopass-server -h
      --address string     listen address (default 0.0.0.0)
      --database string    database backend ('memcached' or 'redis') (default "memcached")
      --max-length int     max length of encrypted secret (default 10000)
      --memcached string   Memcached address (default "localhost:11211")
      --metrics-port int   metrics server listen port (default -1)
      --port int           listen port (default 1337)
      --redis string       Redis URL (default "redis://localhost:6379/0")
      --tls-cert string    path to TLS certificate
      --tls-key string     path to TLS key
      --cors-allow-origin  Access-Control-Allow-Origin CORS setting (default *)
```

Encrypted secrets can be stored either in Memcached or Redis by changing the `--database` flag.

### Docker Compose

Use the Docker Compose file `deploy/with-nginx-and-letsencrypt/docker-compose.yml` to set up a yopass instance with TLS transport encryption and certificate auto renewal using [Let's Encrypt](https://letsencrypt.org/). First point your domain to the host you want to run yopass on. Then replace the placeholder values for `VIRTUAL_HOST`, `LETSENCRYPT_HOST` and `LETSENCRYPT_EMAIL` in `deploy/with-nginx-and-letsencrypt/docker-compose.yml` with your values. Afterwards change the directory to `deploy/with-nginx-and-letsencrypt` and start the containers with:

```console
docker-compose up -d
```

Yopass will then be available under the domain you specified through `VIRTUAL_HOST` / `LETSENCRYPT_HOST`.

Advanced users that already have a reverse proxy handling TLS connections can use the `insecure` setup:

```console
cd deploy/docker/compose/insecure
docker-compose up -d
```

Afterwards point your reverse proxy to `127.0.0.1:80`.

### Docker

With TLS encryption

```console
docker run --name memcached_yopass -d memcached
docker run -p 443:1337 -v /local/certs/:/certs \
    --link memcached_yopass:memcached -d jhaals/yopass --memcached=memcached:11211 --tls-key=/certs/tls.key --tls-cert=/certs/tls.crt
```

Afterwards yopass will be available on port 443 through all IP addresses of the host, including public ones. If you want to limit the availability to a specific IP address use `-p` like so: `-p 127.0.0.1:443:1337`.

Without TLS encryption (needs a reverse proxy for transport encryption):

```console
docker run --name memcached_yopass -d memcached
docker run -p 127.0.0.1:80:1337 --link memcached_yopass:memcached -d jhaals/yopass --memcached=memcached:11211
```

Afterwards point your reverse proxy that handles the TLS connections to `127.0.0.1:80`.

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

Yopass has third party support for other languages. That means you can write translations for the language you'd like or use a third party language file. Please note that yopass itself is english only and any other translations are community supported.

Here's a list of available translations:

- [Bahasa Indonesia](https://github.com/erolj/yopass-indonesian)
- [German](https://github.com/Anturix/yopass-german)
- [French](https://github.com/NicolasStr/yopass-french)
- [Spanish](https://github.com/nbensa/yopass-spanish)
- [Polish](https://github.com/mdurajewski/yopass-polish)
- [Dutch](https://github.com/KevinRosendaal/yopass-dutch)
- [Russian](https://github.com/karpechenkovkonstantin/yopass-russian)
- [Swedish](https://github.com/nkpg-kommun/yopass-swedish)
- [Portuguese (Brazil)](https://github.com/daniellopesjp/yopass-ptbr)
