![Yopass-horizontal](https://user-images.githubusercontent.com/37777956/59544367-0867aa80-8f09-11e9-8d6a-02008e1bccc7.png)

# Yopass - Share Secrets Securely
Simple service to share secrets.

Based on [jhaals/yopass](https://github.com/jhaals/yopass/). 

## Run locally
go run ./cmd/yopass-server/

## Command-line interface

The main motivation of Yopass is to make it easy for everyone to share secrets easily and quickly via a simple webinterface. Nevertheless, a command-line interface is provided as well to support use cases where the output of a program needs to be shared.

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
      go run ./cmd/yopass --api http://localhost:1337 --url http://localhost:1337 <<< 'my-password'

      # Decrypt secret to stdout
      go run ./cmd/yopass --api http://localhost:1337 --url http://localhost:1337 --decrypt http://localhost:1337/#/s/.../..
```
