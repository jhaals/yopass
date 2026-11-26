# yopass CLI

The `yopass` command-line client, written in Rust. It reads and writes the same messages as the
website. Releases attach it as binaries, built by
[`release.yml`](../.github/workflows/release.yml). It replaced the Go CLI, which is no longer in
the repository; see [Differences from the Go CLI](#differences-from-the-go-cli).

```bash
cargo build --release      # target/release/yopass
cargo test                 # needs Go; add `yarn install` in website/ for OpenPGP.js interop
```

There is no built-in server. `api` and `url` must come from a flag, a `YOPASS_` environment
variable or the config file:

```yaml
# ~/.config/yopass/config.yaml
api: https://api.example.com
url: https://example.com
```

An `api-token` is only sent when it is set the same way as `api` or more specifically (flag, then
environment, then config file), so `--api` for another server does not pick up a configured token.

## How it is tested

`tests/compat.rs` runs the CLI against the real server handler (`tests/testserver`) and
OpenPGP.js, and reads messages written by GnuPG and the Go CLI (`tests/fixtures`).

## Differences from the Go CLI

Flags and the message format match the Go CLI, which was last part of release 16.3.0. Exact
behaviour outside those was not a goal, for example:

- `--api` and `--url` have no default, so the CLI exits with code 1 when either is missing.
- `--help` goes to stdout and shows only built-in defaults, never values from the environment or
  config file. It works even when the config file is broken.
- Flag errors come from `clap` and exit with code 2. Positional arguments are errors, not ignored.
- Empty input on stdin is an error. Empty files can still be shared.
- A successful store response without a secret ID is an error.
- Server responses must be a single JSON document. Error text can differ from Go.
- A request fails when the server makes no progress for 30 seconds, or 10 minutes for file
  uploads and downloads. Go waited for as long as the connection stayed open.
- The config file is `config.yaml`, not `defaults.yml`. Old `defaults.*` files, unknown or
  mistyped keys, merge keys and lists or maps as values exit with code 3, so that no setting is
  silently lost. `key`, `file` and `decrypt` cannot be set there, and `api-token` must be a string,
  as YAML rewrites numbers.
- Files of 4 GiB or more cannot be encrypted.
- Refused messages: ones whose decrypted content is not a literal packet, and those from Go CLI
  releases up to 13.1.0. Signatures on signed messages are not verified. A compressed message
  that contains a signed one is accepted, but a signed message whose content is compressed is
  refused. Yopass clients never sign.
- Argon2 is capped at 16 passes and parallelism 16, and messages with more than 8 password key
  packets or more than 8 signatures are refused, so a hostile message cannot occupy the CPU for
  hours.
- Each compressed packet is inflated in full and may hold 1 MiB, plus 64 KiB for framing, counting
  the padding and signatures around the data. Go stopped at the end of the data and ignored what
  followed it.
- Messages with more than 64 KiB of packets in front of the encrypted data are refused, as in the
  Go CLI, and so are those with more than 64 KiB in front of the content inside it: key and
  signature packets take far more memory than their size.
- Proxy environment variables follow ureq's rules. SOCKS proxies are not supported.
- `--key=` (empty) puts the generated key in the link; Go dropped it and the secret was lost.
