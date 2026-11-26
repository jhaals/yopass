---
title: Restricted Recipients
sidebar_position: 6.62
description: Name the one person who may open a secret. Only that person, signed in through your identity provider or proven by an emailed code, can read it. License required.
---

# Restricted Recipients

Anyone holding a Yopass link can normally open it. A restricted secret names one email address, and only a visitor signed in with that verified address can open it. A leaked link is useless to anyone else.

> **Requires a valid license and [OpenID Connect](openid-connect).** Restricted recipients are a business feature gated behind `--license-key`. No SMTP server is needed, except for [emailed codes](#emailed-codes).

## How it works

- A signed-in sender types the recipient's email address into **Restrict to recipient** on the text or file form. The field only appears when the sender is signed in. Entering an address replaces the "require sign-in" option for that secret.
- The recipient opens the link, signs in to this Yopass instance, and the secret opens if their verified address matches. Addresses are matched case-insensitively and otherwise exactly: no `@domain` entries, no lists, no plus-address or dot normalization. To share with several people, create one secret per person.
- Each address is bound to one account at your identity provider. The sender's account is recorded when the secret is created. The first account to open a secret that allows several views becomes its recipient, and later views must come from that same account. Another account with the same address is refused.
- The recipient must be able to sign in to this instance, or, with [emailed codes](#emailed-codes) on, receive mail. `--oidc-allowed-domains` still decides who may sign in.
- The sender may also open or delete their own secret. Opening it as the sender counts as a view: a one-time secret is burned, and the [read receipt](read-receipts) shows the sender as the viewer.
- A visitor who is not signed in sees that the secret is restricted to a specific recipient. The address is never shown. A visitor signed in as someone else is told so, with a link to sign out. A refused attempt does not consume a one-time secret, and there is no lockout after repeated refusals.
- Restriction and one-time are independent. With one-time off, the recipient can open the secret again until it expires.

## Enabling it

Restricted recipients are off until you turn them on with `--restricted-recipients` (`RESTRICTED_RECIPIENTS=true`). Do that only once your identity provider is set up as described under [security model](#security-model). The server refuses to start with the flag unless OIDC is configured with verified addresses and a fixed `--oidc-session-key`, and the license is valid. `GET /config` reports `RESTRICTED_RECIPIENTS: true` then.

- **Only for verified addresses.** A recipient match must rest on an address your identity provider vouches for (`email_verified: true`). The flag cannot be combined with `--oidc-require-verified-email=false`, which for example Microsoft Entra ID needs because it does not send that claim. A session from before verification was required counts as no match until the user signs in again.
- **Turning it off.** Remove the flag, and `--recipient-email-code` with it if set: the server refuses codes without restricted recipients. Existing restricted secrets stay restricted until they expire. Recipients who could sign in can still open them; recipients who relied on codes no longer can.
- **A fixed `--oidc-session-key` is required.** The recipient is stored encrypted with a key derived from it; a random key would make every restricted secret unopenable after a restart. See [key changes](#key-changes).
- **The recipient must be able to sign in.** An address outside `--oidc-allowed-domains`, or one with spaces or invisible characters, is refused when the secret is created. With [emailed codes](#emailed-codes) on, an address outside the allowed domains is accepted and uses a code instead.

## Emailed codes

A recipient who has no account with your identity provider, such as someone at a partner company, can prove their address with a one-time code instead. Turn it on with `--recipient-email-code` (`RECIPIENT_EMAIL_CODE`). It needs `--restricted-recipients`, [SMTP](email-notifications#configuration), `--oidc-allowed-domains` and a valid license, and the server refuses to start with it otherwise. `GET /config` reports `RECIPIENT_EMAIL_CODE: true` then.

- **Who gets a code.** Only an address outside `--oidc-allowed-domains`. Anyone who can sign in must sign in, so the stronger proof of your identity provider is never skipped.
- **The flow.** The recipient opens the link, chooses to get a code, and types their address. The server mails a six-digit code if that address is the secret's recipient, and answers the same either way, so the page never reveals who the secret is for. Entering the code opens the secret.
- **Limits.** A code is valid for 10 minutes and works once. Five wrong guesses burn it, and a guess only counts when it comes with the recipient's address, so a leaked link alone cannot burn the recipient's codes. At most 3 codes are sent per secret in 10 minutes and 10 over its whole life, and a new code replaces the previous one. Someone who has both the link and the address therefore gets at most 50 guesses at a million possible codes, however long the secret lives. They can also use up the codes, after which the recipient cannot get one either; alert on `secret.code_failed` to notice. The code and these counts are stored encrypted in the shared database, so every instance agrees.
- **What a code unlocks.** That one secret, for 15 minutes, through a cookie scoped to it. It cannot delete the secret, create anything, or count as a sign-in elsewhere. It satisfies `--require-auth-all` for that secret only.
- **The mail.** Plain text with the code, the instance name and the time it expires. No link, no secret ID and no sender. In English, like the other mails.
- **Records.** The audit log has `secret.code_requested`, `secret.code_verified` and `secret.code_failed` (`file.*` for files). The read receipt, the audit log and the `secret.viewed` webhook report `access_method: email_code`. A mail that cannot be queued is audited as `code mail not sent`. A delivery that fails later, at the mail server, is logged and counted in `yopass_email_deliveries_total` under `recipient.code`. The visitor is never told either way.
- **Mail volume.** Each restricted secret can trigger at most 10 code mails, but a signed-in sender can create many secrets. The mail queue is shared with [email notifications](email-notifications).
- **License.** A lapsed license stops new restricted secrets, but codes keep working for the existing ones, so their recipients are not stranded.
- **Turning it off.** Codes and the access they granted stop working at once. Secrets for recipients outside the allowed domains can then no longer be opened by anyone but their sender.

A code proves only that someone can read the recipient's mailbox, which is why it is reserved for recipients your identity provider does not know.

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

`GET /secret/{key}/status` reports `"restricted": true` for a restricted secret. Opening it answers `401` without a session and `403` for anyone who is neither the recipient nor the sender, with `"error": "recipient_required"` or `"not_recipient"`.

## Proof of delivery

- The [read receipt](read-receipts) of a restricted secret records who first opened it (`viewer_email`) and how they proved their identity (`access_method`: `oidc` or `email_code`). Later views of a multi-view secret are not on the receipt, but appear in the audit log and webhooks.
- The `secret.viewed` [webhook](webhooks) carries the viewer's `user_email` and `access_method`. Refused attempts fire no webhook.
- The [audit log](audit-logging) marks restricted secrets with `restricted: true`. Successful access records the viewer in `user_email` and `access_method`. Refusals record the attempted identity.
- [Email notifications](email-notifications) work for restricted secrets. No mail is sent when the viewer is the sender.

## Security model

- **The server can learn who the recipient is, never the content.** The secret stays encrypted in the browser as always. The recipient and sender addresses are stored next to the secret, encrypted with AES-256-GCM under a key derived from `--oidc-session-key` and bound to that one secret, so no address is stored in plain text. The server decrypts them to check access, so anyone who controls the server and its key can read them.
- **Your identity provider decides who owns an address.** A match rests on the provider marking the address verified. Only enable restricted recipients with a provider where users cannot set or change their own verified address, and set `--oidc-allowed-domains` to the domains that provider owns. A provider that lets users edit a verified address lets them pose as any recipient.
- **Fails closed.** If the stored recipient cannot be decrypted, nobody can open the secret. A lapsed license stops the creation of new restricted secrets only: existing ones stay restricted until they expire.
- **Not a replacement for the link.** The link still carries the decryption key. Restriction stops someone holding a leaked link from opening it, and it gives you a record of who did.

## Key changes

Changing `--oidc-session-key` makes every existing restricted secret unopenable, by anyone, including its sender. They expire as usual. The viewer recorded on existing read receipts can no longer be shown either. Change the key only when you accept losing access to the restricted secrets that are still pending.

## Split deployments

In a [split deployment](read-only-mode), the instance that serves links must have OIDC configured with the same `--oidc-session-key` as the instance that creates secrets. Otherwise restricted secrets cannot be opened there. For emailed codes it also needs `--recipient-email-code` and SMTP.

A restricted secret has a longer ID than other secrets. A Go server, or a Rust server without this feature, sharing the database does not recognize it and answers `404`, so the secret is never served without its recipient check. Upgrade every instance that serves links before creating restricted secrets, or their recipients will not be able to open them there.
