---
title: Command-Line Interface
sidebar_position: 20
description: Install and use the yopass CLI to share secrets and files from the terminal.
---

# Command-Line Interface

The `yopass` CLI lets you share secrets and files from the terminal using end-to-end encryption.

## Installation

```bash
go install github.com/jhaals/yopass/cmd/yopass@latest
```

> **Note:** Installations protected with OpenID Connect are not supported by the CLI.

## Configuration

Settings are read in this order (later sources override earlier ones):

1. Config file at `~/.config/yopass/defaults.<json|toml|yml|hcl|ini|...>`
2. Environment variables prefixed with `YOPASS_` (dashes become underscores, e.g. `YOPASS_ONE_TIME`)
3. Command-line flags

## Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--api` | `https://api.yopass.se` | Yopass API server location |
| `--url` | `https://yopass.se` | Yopass public URL |
| `--decrypt` | | Decrypt a secret URL |
| `--expiration` | `1h` | Duration before secret is deleted (`1h`, `1d`, `1w`) |
| `--file` | | Read secret from file instead of stdin |
| `--key` | | Manual encryption/decryption key |
| `--one-time` | `true` | Delete secret after first download |

## Examples

```bash
# Encrypt and share a secret from stdin
printf 'secret message' | yopass

# Encrypt and share a file
yopass --file /path/to/secret.conf

# Share a secret that can be downloaded multiple times for one day
cat secret-notes.md | yopass --expiration=1d --one-time=false

# Decrypt a secret to stdout
yopass --decrypt https://yopass.se/#/...
```

## Custom server

To use a self-hosted instance, set both `--api` and `--url`:

```bash
printf 'secret' | yopass --api https://api.example.com --url https://example.com
```

Or set them permanently in `~/.config/yopass/defaults.yml`:

```yaml
api: https://api.example.com
url: https://example.com
```

## Build with custom defaults

You can bake in custom API and URL defaults at build time:

```bash
go build -ldflags "-X main.defaultAPI=https://api.example.com -X main.defaultURL=https://example.com" \
  github.com/jhaals/yopass/cmd/yopass
```
