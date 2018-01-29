# Yopass - Share Secrets Securely

[![Build Status](https://travis-ci.org/jhaals/yopass.svg)](https://travis-ci.org/jhaals/yopass)

Yopass is a project for sharing secrets in a quick and secure manner*.
The sole purpose of Yopass is to minimize the amount of passwords floating around in ticket management systems, IRC logs and emails. The message is encrypted/decrypted locally in the browser and then sent to yopass without the decryption key which is only visible once to the user during encryption, yopass then returns a one-time URL with specified expiry date.

There is no perfect way of sharing secrets online and there is a trade off in every implementation. Yopass is designed to be as simple and "dumb" as possible without compromising on security. There's no mapping between the generated UUID and the user that submitted the encrypted message. It's always best send all the context except password over another channel.

__[Demo available here](https://yopass.se)__. It's recommended to host your own if you care about security. You can run Yopass on AWS Lambda backed by dynamodb, see [yopass-lambda](https://github.com/yopass/yopass-lambda)

* End-to-End encryption using [SJCL](https://bitwiseshiftleft.github.io/sjcl/)
* Secrets can only be viewed once
* No accounts or user management required
* Secrets self destruct after X hours

### Installation / Configuration
It's highly recommended to run TLS encryption using nginx/apache or the Golang built-in TLS server.

#### Docker

    docker run --name memcached_yopass -d memcached

TLS encryption

    docker run -p 1337:1337 -v /local/certs/:/certs -e TLS_CERT=/certs/tls.crt \
        -e TLS_KEY=/certs/tls.key -e 'MEMCACHED=memcache:11211' --link memcached_yopass:memcache -d jhaals/yopass

Plain(make sure this is restricted to localhost)

    docker run -p 1337:1337 -e 'MEMCACHED=memcache:11211' --link memcached_yopass:memcache -d jhaals/yopass


##### Install locally

    go get github.com/jhaals/yopass
    MEMCACHED=memcache:11211 go run yopass.go
