---
title: Command-Line Interface
sidebar_position: 20
description: Install and use the yopass CLI to share secrets and files from the terminal.
---

# Command-Line Interface

The `yopass` CLI lets you share secrets and files from the terminal using end-to-end encryption.

## Installation

Download the archive for your operating system and architecture from
[GitHub Releases](https://github.com/jhaals/yopass/releases). CLI binaries are
published for Linux, macOS (`darwin`), and Windows on `amd64` and `arm64`.
Extract the archive and place `yopass` (`yopass.exe` on Windows) in your `PATH`.
These binaries do not require Docker or a Go toolchain.

To pin a release, select its version in GitHub Releases and download the matching
`yopass_<version>_<os>_<arch>.tar.gz` archive (`.zip` on Windows).
Each release includes `yopass_<version>_checksums.txt` with SHA-256 checksums.
Binaries are attached to releases published after the release workflow was added;
older releases may only contain source archives.

You can also install from source with Go, using a specific release tag:

```bash
go install github.com/jhaals/yopass/cmd/yopass@15.1.0
```

The existing release tags do not use Go module semantic versioning, so Go resolves
them as revisions and may display a pseudo-version. `@latest` can resolve to the
default branch instead of the latest release; use an explicit tag to pin a build.

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
| `--expiration` | `1h` | Duration before secret is deleted (e.g. `1h`, `1d`, `1w`, `90d`; custom durations require server support) |
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

## Argon2 key derivation

Before encrypting, the CLI reads the server's `/config` endpoint. When the server runs with [`--argon2`](./server-options#argon2-key-derivation), the CLI automatically uses Argon2id key derivation so secrets match the server's policy — no CLI flag is needed. If the config cannot be fetched, the CLI falls back to the default key derivation, which every yopass server accepts.

Decryption needs no configuration in either case: the key derivation type is stored inside the encrypted message.

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

Custom expiration uses positive integer `s`, `m`, `h`, `d`, and `w` units, including combinations such as `1d12h`. The server must enable `--allow-custom-expiration`, and the selected duration must satisfy its configured bounds. Standard durations work with existing servers.

Decryption limits sender-selected Argon2 memory to 128 MiB (memory exponent 17). Yopass-generated Argon2 messages use 64 MiB and remain compatible. The web client applies the same memory cap. The CLI also limits the session-key packet prefix to 64 KiB while leaving file ciphertext streamed. Messages created by external tools with higher costs, larger key prefixes, or malformed/unsupported prefix packets are rejected.

The CLI and browser limit each compressed OpenPGP packet to 1 MiB of decompressed data, including text, request responses and streamed files. Yopass creates uncompressed messages, so this does not impose a new size limit on Yopass-generated files. Oversized compressed messages from external tools are rejected through the existing decryption error flow.
