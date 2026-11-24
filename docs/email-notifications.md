---
title: Email Notifications
sidebar_position: 6.65
description: Email the creator when their secret is first opened or their secret request is fulfilled. License required.
---

# Email Notifications

A signed-in user can ask to be emailed when a secret they shared is first opened, or when a secret request they created is fulfilled. They no longer need to keep a tab open to find out.

> **Requires a valid license, OIDC and an SMTP server.** Email notifications are a business feature gated behind `--license-key`. For pushing events to your own systems instead, see [Webhooks](webhooks).

## How it works

- Ticking **Email me when the secret is opened** on the text or file form sends one mail on the **first** view. A secret that can be opened several times still mails once.
- Ticking **Email me when the secret is provided** on the secret request form sends one mail when someone answers the request.
- The mail goes to the email address of the signed-in user who ticked the box. Nobody can type in another address, and API tokens cannot opt in.
- Yopass never emails a link to a secret, in any form. Send the link to your recipient yourself.

The option is off by default and only shows for signed-in users on a server with SMTP configured.

A secret notification rides on a [read receipt](read-receipts): opting in creates a receipt, and `--disable-read-receipts` also turns off secret notifications for new secrets; ones already opted in still mail. Request notifications are not affected.

## Setup

```bash
yopass-server \
  --license-key "$LICENSE_KEY" \
  --oidc-issuer https://id.example.com ... \
  --oidc-session-key "$OIDC_SESSION_KEY" \
  --smtp-host smtp.example.com \
  --smtp-user yopass \
  --smtp-password "$SMTP_PASSWORD" \
  --smtp-from yopass@example.com
```

| Flag | Env var | Default | Description |
|------|---------|---------|-------------|
| `--smtp-host` | `SMTP_HOST` | — | SMTP server. Setting it enables email notifications |
| `--smtp-port` | `SMTP_PORT` | `587`, `465` or `25` by TLS mode | SMTP port |
| `--smtp-user` | `SMTP_USER` | — | SMTP username; leave out for a relay without authentication |
| `--smtp-password` | `SMTP_PASSWORD` | — | SMTP password |
| `--smtp-from` | `SMTP_FROM` | — | Sender address. Required |
| `--smtp-tls` | `SMTP_TLS` | `starttls` | `starttls`, `implicit` (TLS from the first byte) or `none` |

TLS is required by default. If the server does not offer STARTTLS, or its certificate does not verify, the mail is not sent: there is no fallback to plaintext. `--smtp-tls=none` sends in plaintext, password included, and is meant for a relay on the same host or a trusted network.

The server refuses to start with `--smtp-host` when:

- there is no license key, no `--oidc-issuer` or no `--oidc-session-key`, or
- `--oidc-require-verified-email=false` is set. Mail only goes to addresses your identity provider has verified, so a provider that never sends `email_verified` cannot be used with this feature.

## What the mail contains

Plain text, in English. The subject and sender name carry `--app-name` (default `Yopass`).

```
Subject: Yopass: your secret was viewed

A secret you shared was viewed.

Label: Prod DB password
Kind: text
One-time: yes
Created: Tue, 24 Nov 2026 10:00:00 +0000
Viewed: Tue, 24 Nov 2026 10:05:12 +0000
ID: 3f9a1c0b7d2e

https://yopass.example.com
```

- **Label** is an optional text of up to 100 characters that you type when opting in, so you can tell your secrets apart. Request mails have no label.
- **ID** is the same fingerprint that [webhooks](webhooks) and the [audit log](audit-logging) use. It cannot be used to fetch the secret.
- The address at the end is `--frontend-url`, or `--public-url` when that is not set; request mails point to the request list there. With neither set the line is left out.
- The mail never contains the secret link, the decryption key or the viewer's IP address.

## What is stored

The address and label are stored encrypted (AES-256-GCM) next to the read receipt or request, with the same lifetime, and removed at the first view or at fulfilment, whether or not a mail could be sent. The encryption key is derived from `--oidc-session-key`, which is why that flag is required.

- **Changing `--oidc-session-key` drops pending notifications.** The stored address can no longer be read, so no mail is sent. The server logs it; the read receipt and the request keep working.

## Delivery

The mail is sent by the instance that serves the view or receives the answer. When you run several instances, including a [read-only](read-only-mode) one, give all of them the same `--smtp-*` settings, license and `--oidc-session-key`; an instance without them logs a warning and sends nothing.

Only the Rust server sends notifications. If a Go server shares the database and serves the view or receives the answer, no mail is sent and nothing is logged.

Mails are sent from a background queue, so a slow or unreachable mail server never delays or fails opening a secret or answering a request. A mail is tried up to three times with a short backoff, then logged and dropped. Queued mails are not kept across a restart.

Deliveries are counted in `yopass_email_deliveries_total` (see [Metrics](metrics)).

## Limits

- One mail per secret, on the first view only.
- No mail when a secret expires unopened or is deleted.
- Notifications stop when the license expires.
