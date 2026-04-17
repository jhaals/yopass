# Theming & Custom Branding

Yopass supports custom themes and branding via server flags. All theming and branding features require a valid `--license-key`.

---

## Application name

Replace "Yopass" with your own product name in the UI header and browser tab:

```bash
yopass-server --app-name "Acme Secrets" --license-key "your-license-key"
```

---

## Themes

Yopass uses [DaisyUI](https://daisyui.com/docs/themes/) for its UI. You can switch to any built-in DaisyUI theme or define a fully custom one.

### Built-in themes

Set the light and dark themes independently. The browser's `prefers-color-scheme` media query determines which is active.

```bash
yopass-server \
  --license-key   "your-license-key" \
  --theme-light   "corporate" \
  --theme-dark    "business"
```

Defaults are `emerald` (light) and `dim` (dark).

Available built-in theme names: `light`, `dark`, `cupcake`, `bumblebee`, `emerald`, `corporate`, `synthwave`, `retro`, `cyberpunk`, `valentine`, `halloween`, `garden`, `forest`, `aqua`, `lofi`, `pastel`, `fantasy`, `wireframe`, `black`, `luxury`, `dracula`, `cmyk`, `autumn`, `business`, `acid`, `lemonade`, `night`, `coffee`, `winter`, `dim`, `nord`, `sunset`.

### Custom themes

Provide a JSON object of CSS variables to override specific design tokens for each color scheme. Only `--color-*` variables are accepted.

```bash
yopass-server \
  --license-key         "your-license-key" \
  --theme-custom-light  '{"--color-primary":"oklch(55% 0.2 250)","--color-secondary":"oklch(70% 0.15 180)"}' \
  --theme-custom-dark   '{"--color-primary":"oklch(65% 0.25 260)","--color-secondary":"oklch(60% 0.18 190)"}'
```

The custom theme values are injected as CSS variables on the `<html>` element and override whatever `--theme-light` / `--theme-dark` provides. You can therefore mix a built-in base theme with a handful of overrides:

```bash
yopass-server \
  --license-key        "your-license-key" \
  --theme-light        "corporate" \
  --theme-custom-light '{"--color-primary":"oklch(50% 0.22 142)"}'
```

All values must use the `oklch(...)` color format, which is what DaisyUI 4 expects.

Use the [DaisyUI theme generator](https://daisyui.com/theme-generator/) to interactively build and preview a custom theme and copy the resulting CSS variable values.

---

## Logo

Yopass displays a logo in the navbar and browser tab. You can replace the default Yopass logo with your own image. Logo configuration requires a valid `--license-key`.

### Using a custom logo (`--logo-url`)

Provide a URL the browser can reach directly. This can be an absolute path under the frontend's static files or a full external URL:

```bash
yopass-server \
  --license-key "your-license-key" \
  --logo-url    "/mylogo.png"
```

In Docker, copy the file into the frontend's public directory so the path resolves:

```dockerfile
FROM ghcr.io/jhaals/yopass:latest
COPY mylogo.png /public/mylogo.png
```

```bash
docker build -t yopass-custom .
docker run -p 1337:1337 yopass-custom \
  --license-key your-license-key \
  --logo-url /mylogo.png
```

### Image requirements

- **Format**: SVG (recommended) or PNG / JPEG / WebP
- **Shape**: Square — the image is displayed at 32×32 px in the navbar
- **Resolution**: For raster images, at least 64×64 px (covers standard and 2× Retina displays)
- **File size**: Keep below 100 KB — the logo is fetched on every page load

---

## Environment variables

All flags can be set via environment variables (uppercase, dashes replaced with underscores):

| Flag | Environment variable |
|------|----------------------|
| `--license-key` | `LICENSE_KEY` |
| `--app-name` | `APP_NAME` |
| `--theme-light` | `THEME_LIGHT` |
| `--theme-dark` | `THEME_DARK` |
| `--theme-custom-light` | `THEME_CUSTOM_LIGHT` |
| `--theme-custom-dark` | `THEME_CUSTOM_DARK` |
| `--logo-url` | `LOGO_URL` |

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
      APP_NAME: Acme Secrets
      THEME_LIGHT: corporate
      THEME_DARK: business
      THEME_CUSTOM_LIGHT: '{"--color-primary":"oklch(55% 0.2 250)"}'
      LOGO_URL: /mylogo.svg
    depends_on:
      - memcached

  memcached:
    image: memcached
```

---

## Notes

- `--theme-light` and `--theme-dark` must not be set to `custom-light` or `custom-dark` — those names are reserved for internal use.
- Custom theme variables that do not start with `--color-` are rejected at startup.
- When any branding flag is set without a `--license-key`, the server starts but the customisation is not applied.
