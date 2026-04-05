# TLS / HTTPS

Yopass supports two approaches to TLS termination: built-in TLS using certificates you supply, or delegating TLS to a reverse proxy in front of Yopass.

---

## Option 1: Built-in TLS

Pass the certificate and private key paths directly to the server. Yopass will serve HTTPS on the configured port (default `1337`).

```bash
yopass-server \
  --tls-cert /etc/ssl/yopass/tls.crt \
  --tls-key  /etc/ssl/yopass/tls.key
```

Yopass enforces a minimum TLS version of **TLS 1.2**.

### Obtaining a certificate

**Let's Encrypt with Certbot:**

```bash
certbot certonly --standalone -d yopass.example.com

yopass-server \
  --tls-cert /etc/letsencrypt/live/yopass.example.com/fullchain.pem \
  --tls-key  /etc/letsencrypt/live/yopass.example.com/privkey.pem
```

**Self-signed certificate (development only):**

```bash
openssl req -x509 -nodes -newkey rsa:4096 \
  -keyout tls.key -out tls.crt \
  -days 365 -subj "/CN=localhost"

yopass-server --tls-cert tls.crt --tls-key tls.key
```

Self-signed certificates will trigger browser warnings and should not be used in production.

### Docker with built-in TLS

```bash
docker run -p 443:1337 \
  -v /etc/letsencrypt/live/yopass.example.com:/certs:ro \
  ghcr.io/jhaals/yopass:latest \
  --memcached memcached:11211 \
  --tls-cert /certs/fullchain.pem \
  --tls-key  /certs/privkey.pem
```

---

## Option 2: Reverse proxy (recommended for production)

Run Yopass without TLS and terminate HTTPS at the reverse proxy. Yopass listens on `127.0.0.1` to ensure it is not reachable directly.

```bash
yopass-server --address 127.0.0.1 --port 1337
```

When traffic arrives via a reverse proxy, configure `--trusted-proxies` so that real client IPs are logged correctly. See [proxy-configuration.md](proxy-configuration.md).

### Nginx

```nginx
server {
    listen 443 ssl;
    server_name yopass.example.com;

    ssl_certificate     /etc/ssl/yopass/tls.crt;
    ssl_certificate_key /etc/ssl/yopass/tls.key;

    # Modern TLS settings
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers   HIGH:!aNULL:!MD5;

    location / {
        proxy_pass http://127.0.0.1:1337;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;

        # Required for streaming file uploads
        proxy_request_buffering off;
        proxy_buffering         off;
        client_max_body_size    0;
    }
}

# Redirect HTTP to HTTPS
server {
    listen 80;
    server_name yopass.example.com;
    return 301 https://$host$request_uri;
}
```

### Caddy

Caddy handles certificate provisioning and renewal automatically:

```caddyfile
yopass.example.com {
    reverse_proxy 127.0.0.1:1337
}
```

### Traefik (Docker)

```yaml
services:
  traefik:
    image: traefik:v3
    command:
      - "--providers.docker=true"
      - "--entrypoints.web.address=:80"
      - "--entrypoints.websecure.address=:443"
      - "--certificatesresolvers.le.acme.email=admin@example.com"
      - "--certificatesresolvers.le.acme.storage=/letsencrypt/acme.json"
      - "--certificatesresolvers.le.acme.tlschallenge=true"
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - letsencrypt:/letsencrypt

  yopass:
    image: ghcr.io/jhaals/yopass:latest
    environment:
      MEMCACHED: memcached:11211
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.yopass.rule=Host(`yopass.example.com`)"
      - "traefik.http.routers.yopass.entrypoints=websecure"
      - "traefik.http.routers.yopass.tls.certresolver=le"
    depends_on:
      - memcached

  memcached:
    image: memcached

volumes:
  letsencrypt:
```

---

## Docker Compose with Let's Encrypt (built-in)

The repository ships a ready-made compose file for this setup under `deploy/with-nginx-proxy-and-letsencrypt/`. Edit the placeholder values and run:

```bash
cd deploy/with-nginx-proxy-and-letsencrypt
# Edit docker-compose.yml and set VIRTUAL_HOST, LETSENCRYPT_HOST, LETSENCRYPT_EMAIL
docker-compose up -d
```

---

## Flags

| Flag | Env var | Default | Description |
|------|---------|---------|-------------|
| `--tls-cert` | `TLS_CERT` | — | Path to PEM-encoded TLS certificate |
| `--tls-key` | `TLS_KEY` | — | Path to PEM-encoded private key |
| `--address` | `ADDRESS` | `0.0.0.0` | Listen address |
| `--port` | `PORT` | `1337` | Listen port |

Both `--tls-cert` and `--tls-key` must be set together. If only one is provided the server will fail to start.

---

## Notes

- When using a reverse proxy, ensure it sets `X-Forwarded-Proto: https` so that Yopass marks session cookies as `Secure`.
- For file uploads (streaming), disable request buffering in the reverse proxy — otherwise large uploads may time out or fail.
- Certificate renewal (e.g. via Certbot's cron) requires restarting Yopass to pick up the new certificate. Consider using a reverse proxy with automatic reload (Caddy, Traefik) to avoid downtime.
