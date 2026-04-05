# OpenID Connect (OIDC)

Yopass supports OpenID Connect for user authentication. When configured, a **Sign in** button appears in the navbar and you can optionally restrict secret creation to authenticated users only.

> **Requires a valid license.** OIDC is a premium feature gated behind `--license-key`. Without a valid license the OIDC flags are accepted but silently ignored.

---

## How it works

1. A user clicks **Sign in** in the navbar.
2. The browser is redirected to `/auth/login`, which redirects to your OIDC provider.
3. After the user authenticates, the provider redirects back to `/auth/callback`.
4. Yopass exchanges the authorization code for tokens, reads the user's `sub`, `email`, and `name` from the UserInfo endpoint, and stores them in a signed, encrypted session cookie.
5. The navbar shows the user's name and a **Sign out** button.
6. Secret retrieval always works without authentication — OIDC only gates creation.

---

## Flags

| Flag | Env var | Default | Description |
|------|---------|---------|-------------|
| `--oidc-issuer` | `OIDC_ISSUER` | — | OIDC provider issuer URL |
| `--oidc-client-id` | `OIDC_CLIENT_ID` | — | OAuth2 client ID |
| `--oidc-client-secret` | `OIDC_CLIENT_SECRET` | — | OAuth2 client secret |
| `--oidc-redirect-url` | `OIDC_REDIRECT_URL` | — | Full callback URL (must match the provider) |
| `--require-auth` | `REQUIRE_AUTH` | `false` | Reject secret creation requests from unauthenticated users |
| `--oidc-session-key` | `OIDC_SESSION_KEY` | — | 64-byte hex session key (see [Multi-instance](#multi-instance)) |
| `--oidc-allowed-domain` | `OIDC_ALLOWED_DOMAIN` | — | Restrict creation to users with this email domain (e.g. `example.com`) |

All three of `--oidc-issuer`, `--oidc-client-id`, and `--oidc-redirect-url` are required to enable OIDC.

---

## Example: Google as OIDC provider

### 1. Create a Google OAuth 2.0 client

1. Open [Google Cloud Console](https://console.cloud.google.com/) and select your project (or create one).
2. Go to **APIs & Services → Credentials**.
3. Click **Create Credentials → OAuth 2.0 Client ID**.
4. Set the application type to **Web application**.
5. Under **Authorized redirect URIs**, add your callback URL:
   ```
   https://yopass.example.com/auth/callback
   ```
6. Click **Create**. Copy the **Client ID** and **Client Secret**.

### 2. Run Yopass with OIDC enabled

```bash
yopass-server \
  --license-key   "your-license-key" \
  --oidc-issuer   "https://accounts.google.com" \
  --oidc-client-id     "123456789-abc.apps.googleusercontent.com" \
  --oidc-client-secret "GOCSPX-…" \
  --oidc-redirect-url  "https://yopass.example.com/auth/callback"
```

Or with environment variables:

```bash
LICENSE_KEY=your-license-key \
OIDC_ISSUER=https://accounts.google.com \
OIDC_CLIENT_ID=123456789-abc.apps.googleusercontent.com \
OIDC_CLIENT_SECRET=GOCSPX-… \
OIDC_REDIRECT_URL=https://yopass.example.com/auth/callback \
yopass-server
```

Yopass fetches Google's discovery document (`https://accounts.google.com/.well-known/openid-configuration`) at startup. If the provider is unreachable the server will not start.

---

## Require authentication to create secrets

Add `--require-auth` to prevent unauthenticated users from creating secrets. They will see a **Sign in** prompt on the home page and the upload page. Secret retrieval links continue to work without authentication.

```bash
yopass-server \
  --license-key        "your-license-key" \
  --oidc-issuer        "https://accounts.google.com" \
  --oidc-client-id     "123456789-abc.apps.googleusercontent.com" \
  --oidc-client-secret "GOCSPX-…" \
  --oidc-redirect-url  "https://yopass.example.com/auth/callback" \
  --require-auth
```

**Tip:** Combine `--require-auth` with a `--read-only` public instance to create a two-tier deployment:

| Instance | Flags | Purpose |
|----------|-------|---------|
| Internal | `--require-auth` | Employees create secrets after signing in |
| Public | `--read-only` | Anyone can open a secret link |

Both instances share the same database (Memcached or Redis).

---

## Restricting by email domain

Use `--oidc-allowed-domain` to limit secret creation to users whose email address belongs to a specific domain. Users from other domains will authenticate successfully but receive a **403 Forbidden** when they attempt to create a secret.

```bash
yopass-server \
  --require-auth \
  --oidc-allowed-domain "example.com" \
  # … other OIDC flags
```

- The check is case-insensitive (`Example.COM` matches `example.com`).
- Secret **retrieval** is never gated by email domain — anyone with a valid link can open a secret.
- If `--oidc-allowed-domain` is set without `--require-auth` it has no effect, because the domain check only runs inside the auth middleware.

---

## Multi-instance deployments

Session cookies are signed and encrypted with keys generated **randomly at startup**. This means sessions created by one instance cannot be validated by another — users will be logged out whenever a request hits a different server.

To share sessions across instances, generate a fixed 64-byte key and set it on every instance:

```bash
# Generate once and store securely
openssl rand -hex 64
# → e.g. 3f2a1b…c9d8e7  (128 hex characters)
```

Then pass it to every instance:

```bash
yopass-server \
  --oidc-session-key "3f2a1b…c9d8e7" \
  # … other OIDC flags
```

Or as an environment variable:

```bash
OIDC_SESSION_KEY=3f2a1b…c9d8e7 yopass-server …
```

Keep this value secret. Treat it like a password — rotate it if it is ever exposed (all active sessions will be invalidated when it changes).

---

## Docker Compose example

```yaml
services:
  yopass:
    image: ghcr.io/jhaals/yopass:latest
    ports:
      - "1337:1337"
    environment:
      MEMCACHED: memcached:11211
      LICENSE_KEY: your-license-key
      OIDC_ISSUER: https://accounts.google.com
      OIDC_CLIENT_ID: 123456789-abc.apps.googleusercontent.com
      OIDC_CLIENT_SECRET: GOCSPX-…
      OIDC_REDIRECT_URL: https://yopass.example.com/auth/callback
      REQUIRE_AUTH: "true"
      OIDC_ALLOWED_DOMAIN: example.com  # optional: restrict to one email domain
      OIDC_SESSION_KEY: 3f2a1b…c9d8e7   # required for replicated deployments
    depends_on:
      - memcached

  memcached:
    image: memcached
```

---

## Other OIDC providers

Any provider that implements [OpenID Connect Discovery](https://openid.net/specs/openid-connect-discovery-1_0.html) works. Set `--oidc-issuer` to the provider's base URL (the URL that has `/.well-known/openid-configuration` appended to it).
