---
title: API
sidebar_position: 21
description: Create and retrieve secrets over HTTP. Covers the client-side encryption model, a worked example, and the OpenAPI reference.
---

# API

Yopass has a small HTTP API for creating and retrieving secrets from scripts, CI jobs and apps. The full endpoint reference is the [OpenAPI spec](https://github.com/jhaals/yopass/blob/master/docs/openapi.yaml).

## Encrypt before you upload

Yopass never needs your plain text. Encryption happens on the client with OpenPGP, and the server is built to store only ciphertext. That has three consequences:

- The API cannot turn plain text into a secret for you. `POST /create/secret` rejects any `message` that is not an ASCII-armored OpenPGP message with `400 Message must be PGP encrypted`. That is a format check: the server cannot tell whether the content is really encrypted to a key only you hold, so always encrypt first.
- The `label` and `note` of a [secret request](./secret-requests) are stored as plain text. Keep secrets out of them.
- The decryption key never goes to the server. You build the share link yourself and give it to the recipient.

A secret is encrypted symmetrically with a random passphrase (the *key*). The server returns an ID. The share link puts both in the URL fragment, which browsers do not send to the server:

```
https://yopass.example.com/#/s/<id>/<key>        # secret
https://yopass.example.com/#/f/<id>/<key>        # file
```

:::tip Use the CLI if a shell script is enough
The [`yopass` CLI](./cli) does all of this in one command, including key generation and the share link. Write your own client only when you need the API from another language.
:::

## Worked example

This creates a secret with `gpg` and `curl`, then reads it back. Replace the server URL with yours.

```bash
set -euo pipefail   # stop instead of printing a link when a step fails
SERVER=https://yopass.example.com

# 1. Generate a random key. The recipient needs it, the server never sees it.
KEY=$(openssl rand -base64 32 | tr -d '/+=' | cut -c1-22)

# 2. Encrypt with the key as passphrase, ASCII-armored.
MESSAGE=$(printf 'my secret' | gpg --batch --pinentry-mode loopback \
  --passphrase "$KEY" --symmetric --armor --cipher-algo AES256)

# 3. Store the ciphertext.
ID=$(jq -n --arg m "$MESSAGE" '{message: $m, expiration: 3600, one_time: true}' \
  | curl -sf -X POST "$SERVER/create/secret" \
      -H 'Content-Type: application/json' --data-binary @- \
  | jq -er .message)

# 4. Share this link.
echo "$SERVER/#/s/$ID/$KEY"

# 5. Retrieve and decrypt. A one-time secret is gone after this call.
curl -sf "$SERVER/secret/$ID" | jq -r .message \
  | gpg --batch --pinentry-mode loopback --passphrase "$KEY" --decrypt
```

Check `GET /config` first when you need to know the limits. It lists the allowed expirations (`3600`, `86400` and `604800` seconds unless custom expiration is on), the maximum file size and which features are enabled.

If the server runs with `--argon2` (`ARGON2` is `true` in `/config`), the Yopass web client and CLI derive the key with Argon2id. `gpg` cannot do that, but the server accepts either, so the example still works.

## Files

Files go to `POST /create/file` as raw binary OpenPGP data, not armored. Settings travel in headers instead of a JSON body:

```bash
gpg --batch --pinentry-mode loopback --passphrase "$KEY" --symmetric \
  --cipher-algo AES256 --output file.gpg ./report.pdf

curl -sf -X POST "$SERVER/create/file" \
  -H 'Content-Type: application/octet-stream' \
  -H 'X-Yopass-Expiration: 3600' \
  -H 'X-Yopass-OneTime: true' \
  --data-binary @file.gpg
```

The response is `{"message": "<id>"}`. Download the encrypted bytes with `GET /file/<id>`.

## Authentication

Most endpoints need no credentials. Knowing the ID is what grants access.

| Credential | Header | Used for |
|---|---|---|
| API token | `Authorization: Bearer <token>` | Creating secrets, files and requests on a server started with `--require-auth`. See [OpenID Connect](./openid-connect#machine-to-machine-api-tokens). |
| Receipt token | `X-Yopass-Receipt-Token` | Checking a [read receipt](./read-receipts). |
| Request token | `X-Yopass-Request-Token` | Managing a [secret request](./secret-requests): collecting the answer, rotating the key, revoking. |

Reading a secret created with *require authentication* needs an interactive sign-in. API tokens cannot do that.

## Licensed features

These need a [licensed](./intro) server:

- [Secret requests](./secret-requests): the `/request` endpoints.
- [Read receipts](./read-receipts): the `receipt` option and `/receipt` endpoints.
- Require-authentication secrets (`require_auth`).

## Routes that are not there

A server only registers the routes its configuration allows. A disabled route answers like an unknown page: `404` with the plain text `404 page not found`. A real "secret not found" answer is JSON. If you get the plain-text version, check the server's settings:

| Setting | Removes |
|---|---|
| `--read-only` | Creation endpoints and secret requests |
| `--disable-upload` | `POST /create/file`, `/file/{key}` and `/file/{key}/status` |
| `--prefetch-secret=false` | The `/status` endpoints |

## Errors

Errors are JSON with a `message`:

```json
{ "message": "Secret not found" }
```

Each endpoint lists its status codes in the [OpenAPI spec](https://github.com/jhaals/yopass/blob/master/docs/openapi.yaml).
