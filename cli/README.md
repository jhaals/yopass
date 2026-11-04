# yopass CLI (Rust)

Rust rewrite of [`cmd/yopass`](../cmd/yopass). It has the same flags and reads and writes the
same messages as the website. Releases attach this CLI as binaries, built by
[`release.yml`](../.github/workflows/release.yml). The Go CLI stays in the repository as a legacy
install.

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

## How it is tested

`tests/compat.rs` runs the Go and Rust CLIs against the real server handler
(`tests/testserver`) in every sender and receiver pairing, and covers OpenPGP.js and GnuPG
messages.

## Differences from the Go CLI

Flags and the message format match. Exact behaviour outside those is not a goal, for example:

- `--api` and `--url` have no default, so the CLI exits with code 1 when either is missing.
- `--help` goes to stdout and shows only built-in defaults, never values from the environment or
  config file. It works even when the config file is broken.
- Flag errors come from `clap` and exit with code 2. Positional arguments are errors, not ignored.
- Empty input on stdin is an error. Empty files can still be shared.
- A successful store response without a secret ID is an error.
- Server responses must be a single JSON document. Error text can differ from Go.
- Redirects are not followed, so `--api` must be the final address.
- Secret IDs in links stay one path segment: `/`, `?`, `#` and `%` are escaped, and empty IDs,
  `.` and `..` are refused.
- The config file is `config.yaml`, not `defaults.yml`. Old `defaults.*` files, unknown or
  mistyped keys, merge keys and lists or maps as values exit with code 3, so that no setting is
  silently lost. `key`, `file` and `decrypt` cannot be set there, and `api-token` must be a string,
  as YAML rewrites numbers.
- Files of 4 GiB or more cannot be encrypted.
- Refused messages: ones whose decrypted content is not a literal packet, and those from Go CLI
  releases up to 13.1.0. Signatures on signed messages are not verified, and
  signed messages with compressed content are refused. Yopass clients never sign.
- Argon2 is capped at 16 passes and parallelism 16, and messages with more than 8 password key
  packets are refused, so a hostile message cannot occupy the CPU for hours.
- Proxy environment variables follow ureq's rules. SOCKS proxies are not supported.
- `--key=` (empty) puts the generated key in the link; Go drops it and the secret is lost.
