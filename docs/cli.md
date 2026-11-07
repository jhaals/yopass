---
title: Command-Line Interface
sidebar_position: 20
description: Install and use the yopass CLI to share secrets and files from the terminal.
---

# Command-Line Interface

The `yopass` CLI lets you share secrets and files from the terminal using end-to-end encryption.

## Installation

### Install script

On Linux and macOS, this installs the latest release to `~/.local/bin`, after verifying its SHA-256 checksum:

```bash
curl -fsSL https://raw.githubusercontent.com/jhaals/yopass/master/install.sh | sh
```

To read the script first, download it and run it yourself:

```bash
curl -fsSLO https://raw.githubusercontent.com/jhaals/yopass/master/install.sh
less install.sh
sh install.sh
```

Set `YOPASS_VERSION` to install a specific release, and `YOPASS_INSTALL_DIR` to install somewhere else:

```bash
curl -fsSL https://raw.githubusercontent.com/jhaals/yopass/master/install.sh | YOPASS_VERSION=17.0.0 YOPASS_INSTALL_DIR=/usr/local/bin sh
```

The checksum detects a corrupted download. To also confirm an archive was built by this repository's release workflow, use the [GitHub CLI](https://cli.github.com) on releases that have attestations:

```bash
gh attestation verify yopass_<version>_<os>_<arch>.tar.gz --repo jhaals/yopass
```

### Manual download

Download the archive for your operating system and architecture from
[GitHub Releases](https://github.com/jhaals/yopass/releases). CLI binaries are
published for Linux, macOS (`darwin`), and Windows on `amd64` and `arm64`.
Extract the archive and place `yopass` (`yopass.exe` on Windows) in your `PATH`.
These binaries do not need Docker, a Rust toolchain, or any other runtime.

To pin a release, select its version in GitHub Releases and download the matching
`yopass_<version>_<os>_<arch>.tar.gz` archive (`.zip` on Windows).
Each release includes `yopass_<version>_checksums.txt` with SHA-256 checksums.
Older releases contain the [legacy Go CLI](#legacy-go-cli) under the same names, and
the oldest may only contain source archives.

### Build from source

To build from source with [Rust](https://rustup.rs), check out a release tag that has a
`cli` directory and run:

```bash
cd cli && cargo build --release   # target/release/yopass
```

> **Note:** The CLI cannot complete an interactive OpenID Connect login. On a server using
> `--require-auth`, use an [API token](#api-tokens) to create secrets. Secrets marked
> *require authentication* cannot be retrieved with the CLI.

## Configuration

The CLI has no built-in server. `api` and `url` must both be set, or it exits with an error.

Settings are read in this order (later sources override earlier ones):

1. Config file at `~/.config/yopass/config.yaml`
2. Environment variables prefixed with `YOPASS_` (dashes become underscores, e.g. `YOPASS_API_TOKEN`)
3. Command-line flags

### Config file

Create `~/.config/yopass/config.yaml` with the settings you want. Only `api` and `url` are required:

```yaml
# ~/.config/yopass/config.yaml
api: https://api.example.com   # Yopass API server
url: https://example.com       # Public URL used in secret links

# Optional
api-token: "4f6a…9c2e"         # Only if the server requires one
expiration: 1d                 # 1h unless set
one-time: false                # true unless set
```

| Setting | Required | Description |
|---------|----------|-------------|
| `api` | Yes | Yopass API server location |
| `url` | Yes | Yopass public URL, used to build and check secret links |
| `api-token` | Only if the server requires one | See [API tokens](#api-tokens) |
| `expiration` | No | Duration before a secret is deleted. Defaults to `1h` |
| `one-time` | No | Delete a secret after its first download. Defaults to `true` |

`--key`, `--file` and `--decrypt` apply to a single run, so they can't be set in the config file.
Use the flags or their `YOPASS_` environment variables instead, and don't export those variables
permanently, such as from a shell profile. With `YOPASS_KEY` always set, every secret would use the
same key.

The file is checked strictly so a setting is never silently lost. The CLI exits with code 3 on
an unknown or mistyped setting, a merge key (`<<`), a list or map as a value, or a file with another
name such as `defaults.yml` or `config.yml`. `api-token` must be a string, so quote it if it
looks like a number, because YAML rewrites numbers (`0x10` becomes `16`).

### API tokens

A server started with `--require-auth` only lets signed-in users create secrets. The CLI cannot
sign in, so it needs an [API token](./openid-connect#machine-to-machine-api-tokens) from the
server's administrator. Servers without `--require-auth` do not need one.

The server is configured with `name:secret`. The CLI only uses the part after the colon:

```bash
# On the server
yopass-server --require-auth --api-token "cmdb:4f6a…9c2e"   # plus the OIDC flags
```

```yaml
# ~/.config/yopass/config.yaml
api-token: "4f6a…9c2e"
```

Treat the token like a password. Restrict the file with `chmod 600 ~/.config/yopass/config.yaml`,
or use the `YOPASS_API_TOKEN` environment variable, and avoid `--api-token` on the command line,
where other processes can see it.

## Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--api` | | Yopass API server location (required) |
| `--url` | | Yopass public URL (required) |
| `--api-token` | | [API token](#api-tokens) for server authentication |
| `--decrypt` | | Decrypt a secret URL |
| `--expiration` | `1h` | Duration before secret is deleted (e.g. `1h`, `1d`, `1w`, `90d`; custom durations require server support) |
| `--file` | | Read secret from file instead of stdin |
| `--key` | | Manual encryption/decryption key. The link then leaves out the key, so the recipient needs it separately |
| `--one-time` | `true` | Delete secret after first download. To turn it off, use `--one-time=false` |

Custom expiration uses positive integer `s`, `m`, `h`, `d`, and `w` units, including combinations such as `1d12h`. The server must enable `--allow-custom-expiration`, and the selected duration must satisfy its configured bounds. Standard durations work with existing servers.

## Examples

These examples assume `api` and `url` are set in your config file:

```yaml
# ~/.config/yopass/config.yaml
api: https://api.example.com
url: https://example.com
```

```bash
# Encrypt and share a secret from stdin
printf 'secret message' | yopass

# Encrypt and share a file
yopass --file /path/to/secret.conf

# Share a secret that can be downloaded multiple times for one day
cat secret-notes.md | yopass --expiration=1d --one-time=false

# Decrypt a secret to stdout
yopass --decrypt https://example.com/#/...
```

## Argon2 key derivation

Before encrypting, the CLI reads the server's `/config` endpoint. When the server runs with [`--argon2`](./server-options#argon2-key-derivation), the CLI automatically uses Argon2id key derivation so secrets match the server's policy — no CLI flag is needed. If the config cannot be fetched, the CLI falls back to the default key derivation, which every yopass server accepts.

Decryption needs no configuration in either case: the key derivation type is stored inside the encrypted message.

## Limits

- `--api` must be the final address of the API, because redirects are not followed. A redirect is an error, so your token, secret ID and ciphertext cannot follow one elsewhere or over plain HTTP.
- Files are held in memory while they are encrypted and decrypted, and files of 4 GiB or more cannot be encrypted.
- Decryption limits sender-selected Argon2 memory to 128 MiB (memory exponent 17), and to 16 passes and parallelism 16. Messages with more than 8 password key packets are refused. Yopass-generated Argon2 messages use 64 MiB and remain compatible. The web client applies the same memory cap. Messages created by external tools with higher costs are rejected.
- The CLI and browser limit each compressed OpenPGP packet to 1 MiB of decompressed data, including text, request responses and streamed files. Yopass creates uncompressed messages, so this does not impose a new size limit on Yopass-generated files. Oversized compressed messages from external tools are rejected through the existing decryption error flow.

## Legacy Go CLI

The CLI was rewritten in Rust. The Go CLI remains in the repository as a legacy option, but its binaries are no longer attached to releases. It reads and writes the same messages, so both can exchange secrets. Install it from source with a specific release tag:

```bash
go install github.com/jhaals/yopass/cmd/yopass@16.0.1
```

The existing release tags do not use Go module semantic versioning, so Go resolves
them as revisions and may display a pseudo-version. `@latest` can resolve to the
default branch instead of the latest release; use an explicit tag to pin a build.

The legacy CLI reads `~/.config/yopass/defaults.<json|toml|yml|hcl|ini|...>` and defaults to the public `yopass.se` server. You can bake in other defaults at build time:

```bash
go build -ldflags "-X main.defaultAPI=https://api.example.com -X main.defaultURL=https://example.com" \
  github.com/jhaals/yopass/cmd/yopass
```

### Moving from the Go CLI

The flags are the same. These are the changes most likely to affect you:

- `--api` and `--url` are required, as there is no default server. For the public instance, use `--api https://api.yopass.se --url https://yopass.se`.
- The config file is now `~/.config/yopass/config.yaml`. The CLI refuses to run while an old `defaults.*` file exists, so rename it, convert it to YAML if needed, and check it against the strict rules under [Config file](#config-file). `key`, `file` and `decrypt` can no longer be set there.
- An `--api` address that redirects, such as `http://` to `https://`, is an error.
- `--help` prints to stdout, flag errors exit with code 2, and positional arguments are errors.
- Empty input on stdin is an error.

See [`cli/README.md`](https://github.com/jhaals/yopass/blob/master/cli/README.md) for the full list.
