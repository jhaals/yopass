# Read-Only Mode & Split Deployments

Read-only mode disables all secret creation endpoints while keeping retrieval fully functional. Its primary use case is a **split deployment**: a protected internal instance for creating secrets and a public-facing instance for opening them.

---

## Enabling read-only mode

```bash
yopass-server --read-only
```

In this mode:

| Endpoint | Behavior |
|----------|----------|
| `POST /create/secret` | 404 Not Found |
| `POST /create/file` | 404 Not Found |
| `GET /secret/{key}` | Active |
| `GET /file/{key}` | Active |
| `DELETE /secret/{key}` | Active (needed for one-time secrets to self-destruct) |

The frontend detects `READ_ONLY: true` from the `/config` endpoint and shows a read-only landing page instead of the create form.

---

## Split deployment pattern

The most common use case is deploying two instances that share one database:

| Instance | Access | Flags |
|----------|--------|-------|
| **Internal** | VPN / corporate network only | *(normal mode)* |
| **Public** | Internet | `--read-only` |

Both instances connect to the same Memcached or Redis database. Secrets created on the internal instance can be retrieved via the public instance.

```
[Employee] ──► internal.example.com (normal mode, behind VPN)
                      │
                      ▼
                  [Memcached / Redis]
                      │
                      ▼
[Recipient] ──► yopass.example.com (read-only, public)
```

### Docker Compose example

```yaml
services:
  yopass-internal:
    image: ghcr.io/jhaals/yopass:latest
    ports:
      - "127.0.0.1:1337:1337"  # accessible only from localhost / VPN
    environment:
      MEMCACHED: memcached:11211
    depends_on:
      - memcached

  yopass-public:
    image: ghcr.io/jhaals/yopass:latest
    ports:
      - "0.0.0.0:1338:1337"    # public-facing
    environment:
      MEMCACHED: memcached:11211
      READ_ONLY: "true"
    depends_on:
      - memcached

  memcached:
    image: memcached
```

Point your internet-facing reverse proxy to the `yopass-public` container and restrict `yopass-internal` to your internal network.

---

## Combining read-only mode with OIDC authentication

For tighter access control, require authentication on the internal instance while the public instance remains open for retrieval. See [openid-connect.md](openid-connect.md) for full OIDC setup instructions.

```bash
# Internal instance — requires sign-in to create secrets
yopass-server \
  --license-key        "your-license-key" \
  --oidc-issuer        "https://accounts.google.com" \
  --oidc-client-id     "..." \
  --oidc-client-secret "..." \
  --oidc-redirect-url  "https://internal.example.com/auth/callback" \
  --require-auth

# Public instance — read-only, no authentication
yopass-server \
  --read-only \
  --memcached memcached:11211
```

The `--frontend-url` flag is used when the internal (creator) instance is at a different URL than the OIDC redirect target. After a successful sign-in, the user is redirected to `--frontend-url` + `/`:

```bash
yopass-server \
  --oidc-redirect-url "https://api.internal.example.com/auth/callback" \
  --frontend-url      "https://internal.example.com"
```

This is mainly relevant in split frontend/backend deployments during development (e.g. Vite dev server at `localhost:3000` with the API at `localhost:1337`).

---

## Docker Compose example (OIDC + read-only)

```yaml
services:
  yopass-internal:
    image: ghcr.io/jhaals/yopass:latest
    ports:
      - "127.0.0.1:1337:1337"
    environment:
      MEMCACHED: memcached:11211
      LICENSE_KEY: your-license-key
      OIDC_ISSUER: https://accounts.google.com
      OIDC_CLIENT_ID: "123456789-abc.apps.googleusercontent.com"
      OIDC_CLIENT_SECRET: "GOCSPX-..."
      OIDC_REDIRECT_URL: https://internal.example.com/auth/callback
      REQUIRE_AUTH: "true"
      OIDC_ALLOWED_DOMAIN: example.com
    depends_on:
      - memcached

  yopass-public:
    image: ghcr.io/jhaals/yopass:latest
    ports:
      - "0.0.0.0:1338:1337"
    environment:
      MEMCACHED: memcached:11211
      READ_ONLY: "true"
    depends_on:
      - memcached

  memcached:
    image: memcached
```

---

## Flags

| Flag | Env var | Default | Description |
|------|---------|---------|-------------|
| `--read-only` | `READ_ONLY` | `false` | Disable secret creation endpoints |
| `--require-auth` | `REQUIRE_AUTH` | `false` | Require OIDC authentication to create secrets |
| `--frontend-url` | `FRONTEND_URL` | — | Frontend base URL for post-login redirect in split deployments |

---

## Notes

- `--read-only` and `--require-auth` can coexist on the same instance but that combination is rarely useful — `--require-auth` gates creation, and `--read-only` removes creation entirely.
- Deletion of one-time secrets happens automatically via `DELETE /secret/{key}` when a recipient opens a secret. This endpoint remains active in read-only mode intentionally.
- If you use a CDN or caching layer in front of the public instance, ensure the secret retrieval endpoints (`GET /secret/*`, `GET /file/*`) are not cached — secrets are consumed on first read.
