![Yopass-horizontal](https://user-images.githubusercontent.com/37777956/59544367-0867aa80-8f09-11e9-8d6a-02008e1bccc7.png)

# Yopass - Share Secrets Securely

[![Build Status](https://travis-ci.org/jhaals/yopass.svg?branch=master)](https://travis-ci.org/jhaals/yopass)
[![Go Report Card](https://goreportcard.com/badge/github.com/jhaals/yopass)](https://goreportcard.com/report/github.com/jhaals/yopass)

![demo](https://ydemo.netlify.com/yopass-demo.gif)

Yopass is a project for sharing secrets in a quick and secure manner\*.
The sole purpose of Yopass is to minimize the amount of passwords floating around in ticket management systems, IRC logs and emails. The message is encrypted/decrypted locally in the browser and then sent to yopass without the decryption key which is only visible once to the user during encryption, yopass then returns a one-time URL with specified expiry date.

There is no perfect way of sharing secrets online and there is a trade off in every implementation. Yopass is designed to be as simple and "dumb" as possible without compromising on security. There's no mapping between the generated UUID and the user that submitted the encrypted message. It's always best send all the context except password over another channel.

**[Demo available here](https://yopass.se)**. It's recommended to host your own if you care about security.

- End-to-End encryption using [SJCL](https://bitwiseshiftleft.github.io/sjcl/)
- Secrets can only be viewed once
- No accounts or user management required
- Secrets self destruct after X hours

## Installation / Configuration

Here are some deployment options depending on your setup.

### Google App Engine

```bash
cd deploy/app-engine && ./deploy.sh
```

_requires go 1.11, gcloud and yarn._

### AWS Lambda

_Yopass website is a separate component in this step which can be deplpyed to [netlify](https://netlify.com)_ for free.

You can run Yopass on AWS Lambda backed by dynamodb

```bash
cd deploy/aws-lambda && ./deploy.sh
```

### Docker

Start memcached to store secrets in memory

    docker run --name memcached_yopass -d memcached

TLS encryption

    docker run -p 1337:1337 -v /local/certs/:/certs \
        --link memcached_yopass:memcache -d jhaals/yopass -memcached=memcache:11211 -tls.key=/certs/tls.key -tls.cert=/certs/tls.crt

Plain(make sure this is restricted to localhost)

    docker run -p 1337:1337 --link memcached_yopass:memcache -d jhaals/yopass -memcached=memcache:11211

### Kubernetes

```bash
kubectl apply -f deploy/yopass-k8.yaml
kubectl port-forward service/yopass 1337:1337
```

_This is meant to get you started, please configure TLS when running yopass for real._
