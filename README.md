![Yopass-horizontal](https://user-images.githubusercontent.com/37777956/59544367-0867aa80-8f09-11e9-8d6a-02008e1bccc7.png)

# Yopass - Share Secrets Securely

[![Go Report Card](https://goreportcard.com/badge/github.com/jhaals/yopass)](https://goreportcard.com/report/github.com/jhaals/yopass)
[![codecov](https://codecov.io/gh/jhaals/yopass/branch/master/graph/badge.svg)](https://codecov.io/gh/jhaals/yopass)

![demo](https://ydemo.netlify.com/yopass-demo.gif)

Yopass is a project for sharing secrets in a quick and secure manner\*.
The sole purpose of Yopass is to minimize the amount of passwords floating around in ticket management systems, IRC logs and emails. The message is encrypted/decrypted locally in the browser and then sent to yopass without the decryption key which is only visible once to the user during encryption, yopass then returns a one-time URL with specified expiry date.

There is no perfect way of sharing secrets online and there is a trade off in every implementation. Yopass is designed to be as simple and "dumb" as possible without compromising on security. There's no mapping between the generated UUID and the user that submitted the encrypted message. It's always best send all the context except password over another channel.

**[Demo available here](https://yopass.se)**. It's recommended to host your own if you care about security.

- End-to-End encryption using [OpenPGP](https://openpgpjs.org/)
- Secrets can only be viewed once
- No accounts or user management required
- Secrets self destruct after X hours

## Installation / Configuration

Here are some deployment options depending on your setup.

Command line flags:

```console
$ yopass -h
      --address string     listen address (default 0.0.0.0)
      --database string    database backend ('memcached' or 'redis') (default "memcached")
      --max-length int     max length of encrypted secret (default 10000)
      --memcached string   Memcached address (default "localhost:11211")
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

```
cd deploy/
docker-compose up -d
```

### Kubernetes

```console
kubectl apply -f deploy/yopass-k8.yaml
kubectl port-forward service/yopass 1337:1337
```

_This is meant to get you started, please configure TLS when running yopass for real._
