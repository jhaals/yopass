---
title: Restricted Recipients
sidebar_position: 6.62
description: Name the one person who may open a secret. Only that person, signed in through your identity provider, can read it. License required.
---

# Restricted Recipients

Anyone holding a Yopass link can normally open it. A restricted secret names one email address, and only a visitor signed in with that verified address can open it. A leaked link is useless to anyone else.

> **Requires a valid license and [OpenID Connect](openid-connect).** Restricted recipients are a business feature gated behind `--license-key`. No SMTP server is needed.

## How it works

- A signed-in sender types the recipient's email address into **Restrict to recipient** on the text or file form. The field only appears when the sender is signed in. Entering an address replaces the "require sign-in" option for that secret.
- The recipient opens the link, signs in to this Yopass instance, and the secret opens if their verified address matches. Addresses are matched case-insensitively and otherwise exactly: no `@domain` entries, no lists, no plus-address or dot normalization. To share with several people, create one secret per person.
- The recipient must be able to sign in to this instance. `--oidc-allowed-domains` still decides who may sign in, so a recipient outside the allowed domains cannot open the secret.
- The sender may also open or delete their own secret. Opening it as the sender counts as a view: a one-time secret is burned, and the [read receipt](read-receipts) shows the sender as the viewer.
- A visitor who is not signed in sees that the secret is restricted to a specific recipient. The address is never shown. A visitor signed in as someone else is told so, with a link to sign out. A refused attempt does not consume a one-time secret, and there is no lockout after repeated refusals.
- Restriction and one-time are independent. With one-time off, the recipient can open the secret again until it expires.

## Enabling it

Restricted recipients are available when OIDC is configured with a fixed `--oidc-session-key`, the license is valid and email addresses are verified. `GET /config` reports `RESTRICTED_RECIPIENTS: true` then.

- **Only for verified addresses.** A recipient match must rest on an address your identity provider vouches for (`email_verified: true`). With `--oidc-require-verified-email=false`, for example for Microsoft Entra ID, which does not send that claim, the feature is switched off and the field does not appear. Restricted secrets created earlier stay restricted, and only a session with a verified address can open them. A session from before verification was required counts as no match until the user signs in again.
- **Turning it off.** `--disable-restricted-recipients` (`DISABLE_RESTRICTED_RECIPIENTS`) switches the feature off even with a valid license. Existing restricted secrets stay restricted until they expire.
- **A fixed `--oidc-session-key` is required.** The recipient is stored encrypted with a key derived from it. Without one the feature is off, since a random key would make every restricted secret unopenable after a restart. See [key changes](#key-changes).
- **The recipient must be able to sign in.** An address outside `--oidc-allowed-domains`, or one with spaces or invisible characters, is refused when the secret is created.

## API and CLI

Send `recipient` with the secret:

```bash
curl https://yopass.example.com/create/secret \
  -H 'Authorization: Bearer <api-token>' \
  -H 'Content-Type: application/json' \
  -d '{"message": "-----BEGIN PGP MESSAGE-----…", "expiration": 3600, "one_time": true,
       "recipient": "bob@example.com"}'
```

The answer carries `"restricted": true`. **Check it:** a server without the feature, such as an older version, ignores `recipient` and stores an open secret. Do not share the link of a secret whose answer lacks it.

For file uploads, send the percent-encoded address in one `X-Yopass-Recipient` header. A header that cannot be decoded, is empty or is repeated is refused with `400`. With the [CLI](cli), pass `--recipient bob@example.com`. The CLI checks `GET /config` before storing anything and refuses to print a link the server did not confirm, deleting that secret again. The web interface does the same check.

Naming a recipient needs a signed-in session or an [API token](openid-connect#api-tokens), even on an instance where anyone may create secrets. An API token can create restricted secrets but can never open or delete one. A secret created with a token has no sender who may open it, so only the recipient or its expiry removes it.

`GET /secret/{key}/status` reports `"restricted": true` for a restricted secret. Opening it answers `401` without a session and `403` for anyone who is neither the recipient nor the sender.

## Proof of delivery

- The [read receipt](read-receipts) of a restricted secret records who first opened it (`viewer_email`) and how they proved their identity (`access_method`, always `oidc`). Later views of a multi-view secret are not on the receipt, but appear in the audit log and webhooks.
- The `secret.viewed` [webhook](webhooks) carries the viewer's `user_email` and `access_method`. Refused attempts fire no webhook.
- The [audit log](audit-logging) marks restricted secrets with `restricted: true`. Successful access records the viewer in `user_email` and `access_method: oidc`. Refusals record the attempted identity.
- [Email notifications](email-notifications) work for restricted secrets. No mail is sent when the viewer is the sender.

## Security model

- **The server can learn who the recipient is, never the content.** The secret stays encrypted in the browser as always. The recipient and sender addresses are stored next to the secret, encrypted with AES-256-GCM under a key derived from `--oidc-session-key` and bound to that one secret, so no address is stored in plain text. The server decrypts them to check access, so anyone who controls the server and its key can read them.
- **Fails closed.** If the stored recipient cannot be decrypted, nobody can open the secret. A lapsed license stops the creation of new restricted secrets only: existing ones stay restricted until they expire.
- **Not a replacement for the link.** The link still carries the decryption key. Restriction stops someone holding a leaked link from opening it, and it gives you a record of who did.

## Key changes

Changing `--oidc-session-key` makes every existing restricted secret unopenable, by anyone, including its sender. They expire as usual. The viewer recorded on existing read receipts can no longer be shown either. Change the key only when you accept losing access to the restricted secrets that are still pending.

## Split deployments

In a [split deployment](read-only-mode), the instance that serves links must have OIDC configured with the same `--oidc-session-key` as the instance that creates secrets. Otherwise restricted secrets cannot be opened there.

Only Rust server versions with this feature enforce the recipient. A Go server, or an older Rust server, sharing the database treats a restricted secret as one that requires sign-in, so any signed-in user could open or delete it there. Upgrade every instance before creating restricted secrets, and do not roll back while any are pending.
