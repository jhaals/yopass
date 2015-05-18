# Yopass - Share Secrets Securely
[![Build Status](https://travis-ci.org/jhaals/yopass.png?branch=master)](https://travis-ci.org/jhaals/yopass)

Yopass is a project for sharing secrets in a quick and secure manner.
The sole purpose of Yopass is to minimize the amount of passwords floating around in ticket management systems, IRC logs and emails. YoPass generates a one-time URL with an expiration date so you don't have to worry about passwords being visible forever. The decryption key can also be transferred over SMS.

You can easily integrate Yopass into other systems using it's API and host it yourself. [yopass-cli](https://github.com/jhaals/yopass-cli) is a CLI tool for yopass.

__[Demo site available here](https://yopass.se)__

* AES-256 encryption
* Secrets can only be viewed once
* No secrets are written to disk
* No accounts or user management required
* Secrets self destruct after X hours
* Rate limiting
* Decryption key can be sent over SMS

### Installation / Configuration

    gem install yopass

* Install and start memcached

All settings are configured using environment variables

    YP_MEMCACHED # default: localhost:11211
    YP_SECRET_MAX_LENGTH # default: 10000


#### Docker

    docker run --name memcached_yopass -d memcached
    docker run -it -p 3000:3000 -e 'YP_MEMCACHED=memcache:11211' --link memcached_yopass:memcache -d jhaals/yopass

### API
All endpoints expect JSON

Create secret - POST __/v1/secret__

    secret(required) - text
    lifetime(1d default) - 1h, 1d, 1w
    mobile_number(optional) - [0-9]

    Returns
    {
      key: "6738ecd96ac57c559c3d72387176b59b",
      decryption_key: "073d8b943",
      full_url: "/v1/secret/6738ecd96ac57c559c3d72387176b59b/073d8b943",
      short_url: "/v1/secret/6738ecd96ac57c559c3d72387176b59b",
      message: "secret stored"
    }
Get secret - GET __/v1/secret/key/decryption_key__

    {
      secret: "Hello World"
    }

### SMS providers
Yopass has a basic plugin system for SMS providers.

Missing your favorite SMS provider? Just fork the repo and submit a pull request.
Use the bulksms provider in ```lib/sms_provider/bulksms.rb``` as example

#### Configure provider

    YP_SEND_SMS=1
    YP_SMS_SETTINGS='{"provider": "bulksms", "settings": {"username": "smsuser", "password": "xxxx"}}'
    YP_OUTBOUND_PROXY='https://your-proxy:port'

### Screenshot
![YoPass website](http://f.cl.ly/items/1N1C3I1q1i0E343r1v3p/Screenshot%202015-02-07%2018.51.17.png)

