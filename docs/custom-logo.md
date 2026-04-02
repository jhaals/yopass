# Custom Logo

Yopass displays a logo in the navbar and browser tab. You can replace the default Yopass logo by bundling a custom image with the frontend and pointing the server to it.

## How it works

The logo is served as a static file from the frontend's public directory (`/public` in the Docker image). The `--logo-url` flag (or `LOGO_URL` environment variable) tells the UI which path to load the logo from.

## Image requirements

- **Format**: SVG (recommended) or PNG/JPEG/WebP
- **Shape**: Square — the image is displayed at 32×32 px in the navbar
- **Resolution**: For raster images, use at least 64×64 px so the logo looks sharp on high-DPI screens; 256×256 px covers all cases
- **File size**: Keep below 100 KB — the logo is fetched on every page load

## Docker build example

Create a `Dockerfile` that extends the official Yopass image and copies your logo into `/public`:

```dockerfile
FROM ghcr.io/jhaals/yopass:latest
COPY mylogo.png /public/mylogo.png
```

Build and run:

```bash
docker build -t yopass-custom .
docker run -p 1337:1337 yopass-custom --logo-url /mylogo.png
```

Or with an environment variable:

```bash
docker run -p 1337:1337 -e LOGO_URL=/mylogo.png yopass-custom
```

## Docker Compose example

```yaml
services:
  yopass:
    build: .
    ports:
      - "1337:1337"
    environment:
      LOGO_URL: /mylogo.png
      MEMCACHED: memcached:11211
  memcached:
    image: memcached
```

## Notes

- The logo URL is a path relative to the frontend root, so `/mylogo.png` maps to `/public/mylogo.png` inside the container.
- Any path under `/public` works, including subdirectories: `COPY assets/logo.svg /public/assets/logo.svg` → `--logo-url /assets/logo.svg`.
- In a split deployment (separate frontend and backend hosts), place the logo in the frontend's static files and set `--logo-url` to the path or full URL where it is reachable by the browser.
