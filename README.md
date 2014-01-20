# YoPass - Share Secrets Securely
YoPass is a website that store secrets encrypted(AES 256) in memory(memcached) for a fixed period of time.
Secrets can then be shared more securely over channels such as IRC and Email. The decryption password for the secret can be sent over SMS to improve security.

* AES-256 encryption
* Secrets can only be viewed once
* No secrets are written to disk
* No accounts and user management required
* Secrets self destruct after X hours

![YoPass website](http://f.cl.ly/items/1Y3I3J0f1S0Z1K172n2X/screenshot.png)

#### Workflow
    * Generate secret
    * Paste into the yopass website
    * Receive URL with or without decryption key(can be sent over sms)
    * Share with the intended person.
    * Secret is automatically removed when it's viewed by your friend
    * feel safe

### Installation

    gem install yopass

* install and start memcached
* edit yopass.yaml and move it to /etc
* done!


### SMS providers

Lacking your SMS provider? Just fork the repo and submit a pull request.
Use the bulksms provider in ```lib/sms_provider/bulksms.rb``` as example

##### Supported Providers
Bulksms
