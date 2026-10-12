---
title: Command-Line Interface
sidebar_position: 20
description: Install and use the urlx CLI to share secrets and files from the terminal.
---

# Command-Line Interface

The `urlx` CLI lets you share secrets and files from the terminal using end-to-end encryption.

## Installation

```bash
go install github.com/mehrabiyan/urlx/cmd/urlx@latest
```

> **Note:** Installations protected with OpenID Connect are not supported by the CLI.

## Configuration

Settings are read in this order (later sources override earlier ones):

1. Config file at `~/.config/urlx/defaults.<json|toml|yml|hcl|ini|...>`
2. Environment variables prefixed with `URLX_` (dashes become underscores, e.g. `URLX_ONE_TIME`)
3. Command-line flags

## Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--api` | `https://urlx.net` | urlx API server location |
| `--url` | `https://urlx.net` | urlx public URL |
| `--decrypt` | | Decrypt a secret URL |
| `--expiration` | `1h` | Duration before secret is deleted (e.g. `1h`, `1d`, `1w`, `90d`; custom durations require server support) |
| `--file` | | Read secret from file instead of stdin |
| `--key` | | Manual encryption/decryption key |
| `--one-time` | `true` | Delete secret after first download |

## Examples

```bash
# Encrypt and share a secret from stdin
printf 'secret message' | urlx

# Encrypt and share a file
urlx --file /path/to/secret.conf

# Share a secret that can be downloaded multiple times for one day
cat secret-notes.md | urlx --expiration=1d --one-time=false

# Decrypt a secret to stdout
urlx --decrypt https://urlx.net/#/...
```

## Argon2 key derivation

Before encrypting, the CLI reads the server's `/config` endpoint. When the server runs with [`--argon2`](./server-options#argon2-key-derivation), the CLI automatically uses Argon2id key derivation so secrets match the server's policy — no CLI flag is needed. If the config cannot be fetched, the CLI falls back to the default key derivation, which every urlx server accepts.

Decryption needs no configuration in either case: the key derivation type is stored inside the encrypted message.

## Custom server

To use a self-hosted instance, set both `--api` and `--url`:

```bash
printf 'secret' | urlx --api https://api.example.com --url https://example.com
```

Or set them permanently in `~/.config/urlx/defaults.yml`:

```yaml
api: https://api.example.com
url: https://example.com
```

## Build with custom defaults

You can bake in custom API and URL defaults at build time:

```bash
go build -ldflags "-X main.defaultAPI=https://api.example.com -X main.defaultURL=https://example.com" \
  github.com/mehrabiyan/urlx/cmd/urlx
```

Custom expiration uses positive integer `s`, `m`, `h`, `d`, and `w` units, including combinations such as `1d12h`. The server must enable `--allow-custom-expiration`, and the selected duration must satisfy its configured bounds. Standard durations work with existing servers.
