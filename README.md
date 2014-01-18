# YoPass - Share Secrets Securely
YoPass store secrets encrypted(AES 256) in memory(memcached) for a fixed period of time.
Secrets can then be shared more securely over channels such as IRC and Email. The decryption password for the secret can be sent over SMS to improve security.

* AES-256 encryption
* Secrets can only be viewed once
* No secrets are written to disk
* No accounts and user management required
* Secrets self destruct after X hours
