![Yopass-horizontal](https://user-images.githubusercontent.com/37777956/59544367-0867aa80-8f09-11e9-8d6a-02008e1bccc7.png)

# Yopass - Share Secrets Securely

[![Go Report Card](https://goreportcard.com/badge/github.com/jhaals/yopass)](https://goreportcard.com/report/github.com/jhaals/yopass)
[![codecov](https://codecov.io/gh/jhaals/yopass/branch/master/graph/badge.svg)](https://codecov.io/gh/jhaals/yopass)

![demo](https://ydemo.netlify.com/yopass-demo.gif)

Yopass is a project for sharing secrets in a quick and secure manner\*.
The sole purpose of Yopass is to minimize the amount of passwords floating around in ticket management systems, Slack messages and emails. The message is encrypted/decrypted locally in the browser and then sent to yopass without the decryption key which is only visible once during encryption, yopass then returns a one-time URL with specified expiry date.

There is no perfect way of sharing secrets online and there is a trade off in every implementation. Yopass is designed to be as simple and "dumb" as possible without compromising on security. There's no mapping between the generated UUID and the user that submitted the encrypted message. It's always best send all the context except password over another channel.

**[Demo available here](https://yopass.se)**. It's recommended to host yopass yourself if you care about security.

- End-to-End encryption using [OpenPGP](https://openpgpjs.org/)
- Secrets can only be viewed once
- No accounts or user management required
- Secrets self destruct after X hours
- Custom password option
- Limited file upload functionality

Yopass was first released in 2014 and has since then been maintained by me and contributed to by this fantastic group of [contributors](https://github.com/jhaals/yopass/graphs/contributors). Yopass is used by many large corporations which of which non are currently listed in this readme.
If you are using yopass and want to support other then by code contributions. Give your thanks in an email, consider donating or by giving consent to list your company name as a user of Yopass in this readme(Trusted by)

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
```

Encrypted secrets can be stored either in Memcached or Redis by changing the `--database` flag.

### AWS Lambda

_Yopass website is a separate component in this step which can be deployed to [netlify](https://netlify.com)_ for free.

You can run Yopass on AWS Lambda backed by dynamodb

```console
cd deploy/aws-lambda && ./deploy.sh
```

### Docker

Start Memcached to store secrets in memory

```console
docker run --name memcached_yopass -d memcached
```

TLS encryption

```console
docker run -p 1337:1337 -v /local/certs/:/certs \
    --link memcached_yopass:memcache -d jhaals/yopass --memcached=memcache:11211 --tls-key=/certs/tls.key --tls-cert=/certs/tls.crt
```

Plain(make sure this is restricted to localhost)

```console
docker run -p 1337:1337 --link memcached_yopass:memcache -d jhaals/yopass --memcached=memcache:11211
```

Or use docker-compose to deploy both memcached and yopass containers.

```console
cd deploy/
docker-compose up -d
```

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
