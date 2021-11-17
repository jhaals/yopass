# Yopass - Share Secrets Securely

![Yopass-horizontal](https://user-images.githubusercontent.com/37777956/59544367-0867aa80-8f09-11e9-8d6a-02008e1bccc7.png)

Simple service to share secrets.

Based on [jhaals/yopass](https://github.com/jhaals/yopass/).

## Local Development

- Run Server

```bash
export ONETIME_ELVID_BASE_URL="https://elvid.contoso.io"
export VAULT_ADDR="https://vault.constoso.io"
export GITHUB_PERSONAL_ACCESS_TOKEN_READ_ORG_SCOPE='ghp_000000000000000000000000000000000000' # read-org-scope — read:org
export GITHUB_TOKEN="${GITHUB_PERSONAL_ACCESS_TOKEN_READ_ORG_SCOPE}"
go run ./cmd/yopass-server/
```

- Run Website

```bash
cd website
yarn
REACT_APP_BACKEND_URL='http://localhost:1337' yarn start
```

## History

Yopass was first released in 2014 and has since then been maintained by me and contributed to by this fantastic group of [contributors](https://github.com/jhaals/yopass/graphs/contributors). Yopass is used by many large corporations which of which none are currently listed in this readme.
If you are using yopass and want to support other then by code contributions. Give your thanks in an email, consider donating or by giving consent to list your company name as a user of Yopass in this readme(Trusted by)

## Trusted by

- [Doddle LTD](https://doddle.com)

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
