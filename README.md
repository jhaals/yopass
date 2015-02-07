# YoPass - Share Secrets Securely
[![Build Status](https://travis-ci.org/jhaals/yopass.png?branch=master)](https://travis-ci.org/jhaals/yopass)

YoPass is a website/API for sharing secrets in a quick and secure manner.
This project is created to minimize the amount of passwords floating around in ticket management systems, IRC logs and emails. YoPass generates a one-time URL with an expiration date so you don't have to worry about passwords being visible forever

__[Demo site available here](http://yopass.jhaals.se)__

* AES-256 encryption
* Secrets can only be viewed once
* No secrets are written to disk
* No account or user management required
* Secrets self destruct after X hours
* Rate limiting
* Decryption key can be sent over SMS

### Installation / Configuration

    gem install yopass

* Install and start memcached
* Edit `conf/yopass.yaml` and move it to desired location (don't forge to specify that path in the YOPASS_CONFIG environment variable)

Most settings can be configured with environment variables.

    YOPASS_CONFIG='/path/to/yopass.yaml'
    YOPASS_BASE_URL='https://yopass.mydomain.com'
    YOPASS_MEMCACHED_URL='memcached_address'

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
      full_url: "http://127.0.0.1:4567/v1/secret/6738ecd96ac57c559c3d72387176b59b/073d8b943",
      short_url: "http://127.0.0.1:4567/v1/secret/6738ecd96ac57c559c3d72387176b59b",
      message: "secret stored"
    }
Get secret - GET __/v1/secret/key/decryption_key__

    {
      secret: "Hello World"
    }

### SMS providers

Supported SMS providers

- Bulksms

Missing your favorite SMS provider? Just fork the repo and submit a pull request.
Use the bulksms provider in ```lib/sms_provider/bulksms.rb``` as example

### Screenshot
![YoPass website](http://f.cl.ly/items/1N1C3I1q1i0E343r1v3p/Screenshot%202015-02-07%2018.51.17.png)

