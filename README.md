# YoPass - Share Secrets Securely
[![Build Status](https://travis-ci.org/jhaals/yopass.png?branch=master)](https://travis-ci.org/jhaals/yopass)

YoPass is a website for sharing secrets in a quick and secure manner.
This project is created to minimize the amount of passwords floating around in ticket management systems, IRC logs and emails. YoPass generates a one-time URL with an expiration date so you don't have to worry about passwords being visible forever

__[Take me to the demo site](http://yopass.jhaals.se)__

* AES-256 encryption
* Secrets can only be viewed once
* No secrets are written to disk
* No account or user management required
* Secrets self destruct after X hours
* Rate limiting
* Decryption key can be sent over SMS

### Installation / Configuration

    gem install yopass

* install and start memcached
* edit `conf/yopass.yaml` and move it to desired location (don't forge to specify that path in the YOPASS_CONFIG environment variable)
* done!

Most settings can be configured with environment variables.

    YOPASS_CONFIG='/path/to/yopass.yaml'
    YOPASS_BASE_URL='https://yopass.mydomain.com'
    YOPASS_MEMCACHED_URL='memcached_address'


### Run in docker container

    docker pull jhaals/yopass
    docker run -e "RACK_ENV=production" -e "YOPASS_BASE_URL=http://192.168.59.105:4567" -p 4567:4567 -d jhaals/yopass

### SMS providers

Supported SMS providers

- Bulksms

Missing your favorite SMS provider? Just fork the repo and submit a pull request.
Use the bulksms provider in ```lib/sms_provider/bulksms.rb``` as example

### Screenshot
![YoPass website](http://f.cl.ly/items/2F2T1L3a3R162K2G383q/yopass.png)

