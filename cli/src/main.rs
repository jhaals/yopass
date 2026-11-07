mod client;
mod crypto;
mod settings;

use clap::Parser;
use rand::RngCore;
use settings::{bytes_of, parse_bool, Settings};
use std::ffi::OsString;
use std::fs::File;
use std::io::{IsTerminal, Read, Write};
use url::Url;

const NO_INPUT: &str = "No filename or piped input to encrypt given";

const AFTER_HELP: &str = "\
Settings are read from flags, environment variables, or a config file located at
~/.config/yopass/config.yaml in this order. Environment variables have to be prefixed
with YOPASS_ and dashes become underscores. --key, --file and --decrypt cannot be set in
the config file.

Examples:
      # Encrypt and share secret from stdin
      printf 'secret message' | yopass

      # Encrypt and share secret file
      yopass --file /path/to/secret.conf

      # Share secret multiple time a whole day
      cat secret-notes.md | yopass --expiration=1d --one-time=false

      # Decrypt secret to stdout
      yopass --decrypt https://example.com/#/...";

/// Yopass - Secure sharing for secrets, passwords and files
#[derive(Parser)]
#[command(name = "yopass", args_override_self = true, after_help = AFTER_HELP)]
struct Cli {
    /// Yopass API server location
    #[arg(long, allow_hyphen_values = true)]
    api: Option<OsString>,
    /// API token for server authentication
    #[arg(long, allow_hyphen_values = true)]
    api_token: Option<OsString>,
    /// Decrypt secret URL
    #[arg(long, allow_hyphen_values = true)]
    decrypt: Option<OsString>,
    /// Duration after which secret will be deleted, such as 1h, 1d, 1w or 90d; custom
    /// durations require server support (default 1h)
    #[arg(long, allow_hyphen_values = true)]
    expiration: Option<OsString>,
    /// Read secret from file instead of stdin
    #[arg(long, allow_hyphen_values = true)]
    file: Option<OsString>,
    /// Manual encryption/decryption key
    #[arg(long, allow_hyphen_values = true)]
    key: Option<OsString>,
    /// One-time download (default true)
    #[arg(
        long,
        num_args = 0..=1,
        require_equals = true,
        default_missing_value = "true",
        value_parser = parse_one_time,
    )]
    one_time: Option<bool>,
    /// Yopass public URL
    #[arg(long, allow_hyphen_values = true)]
    url: Option<OsString>,
}

fn parse_one_time(value: &str) -> Result<bool, &'static str> {
    parse_bool(value.as_bytes()).ok_or("expected true or false")
}

impl Cli {
    fn apply(self, settings: &mut Settings) {
        for (name, value) in [
            ("api", self.api),
            ("api-token", self.api_token),
            ("decrypt", self.decrypt),
            ("expiration", self.expiration),
            ("file", self.file),
            ("key", self.key),
            ("url", self.url),
        ] {
            if let Some(value) = value {
                settings.set_flag(name, bytes_of(value));
            }
        }
        if let Some(one_time) = self.one_time {
            settings.set_flag("one-time", one_time.to_string().into_bytes());
        }
    }
}

fn lossy(value: &[u8]) -> String {
    String::from_utf8_lossy(value).into_owned()
}

/// Compares URL components so a lookalike host or path prefix cannot pass as
/// the configured public instance.
fn matches_public_url(raw: &str, configured: &str) -> bool {
    let (Ok(link), Ok(base)) = (Url::parse(raw.trim()), Url::parse(configured)) else {
        return false;
    };
    base.host_str().is_some()
        && link.username().is_empty()
        && link.password().is_none()
        && link.scheme() == base.scheme()
        && link.host_str() == base.host_str()
        && link.port() == base.port()
        && link.path().trim_end_matches('/') == base.path().trim_end_matches('/')
}

struct SecretLink {
    id: Vec<u8>,
    key: Vec<u8>,
    file: bool,
    manual_key: bool,
}

fn parse_secret_url(raw: &str) -> Result<SecretLink, String> {
    let url = Url::parse(raw.trim()).map_err(|err| format!("invalid URL: {err}"))?;
    // Not the link itself: its fragment holds the key, and errors end up in logs.
    let unexpected = || "unexpected link format".to_string();
    let fragment: Vec<u8> =
        percent_encoding::percent_decode_str(url.fragment().unwrap_or("")).collect();
    let parts: Vec<&[u8]> = fragment.split(|&c| c == b'/').collect();
    if parts.len() < 3 || parts.len() > 4 || !parts[0].is_empty() {
        return Err(unexpected());
    }
    if matches!(parts[2], b"" | b"." | b"..") {
        return Err(unexpected());
    }
    let (file, manual_key) = match parts[1] {
        b"s" => (false, false),
        b"c" => (false, true),
        b"f" => (true, false),
        b"d" => (true, true),
        _ => return Err(unexpected()),
    };
    Ok(SecretLink {
        id: parts[2].to_vec(),
        key: parts.get(3).map_or_else(Vec::new, |key| key.to_vec()),
        file,
        manual_key,
    })
}

fn secret_url(base: &str, id: &str, key: &str, file: bool, manual_key: bool) -> String {
    let base = base.strip_suffix('/').unwrap_or(base);
    let prefix = if file { "f" } else { "s" };
    if manual_key {
        format!("{base}/#/{prefix}/{id}")
    } else {
        format!("{base}/#/{prefix}/{id}/{key}")
    }
}

/// Whether `--decrypt` would accept the link and fetch this same ID.
fn decryptable(link: &str, url: &str, id: &str) -> bool {
    matches_public_url(link, url) && parse_secret_url(link).is_ok_and(|p| p.id == id.as_bytes())
}

fn generate_key() -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut bytes = [0u8; 22];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    bytes
        .iter()
        .map(|b| ALPHABET[(b & 63) as usize] as char)
        .collect()
}

/// Positive whole-second durations in s, m, h, d and w, such as 1d12h.
fn parse_expiration(s: &str) -> Option<i32> {
    let mut total: i32 = 0;
    let mut rest = s;
    if rest.is_empty() {
        return None;
    }
    while !rest.is_empty() {
        let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 || digits == rest.len() {
            return None;
        }
        let amount: i32 = rest[..digits].parse().ok()?;
        let unit = match rest.as_bytes()[digits] {
            b's' => 1,
            b'm' => 60,
            b'h' => 3600,
            b'd' => 86400,
            b'w' => 604800,
            _ => return None,
        };
        total = total.checked_add(amount.checked_mul(unit)?)?;
        rest = &rest[digits + 1..];
    }
    (total > 0).then_some(total)
}

/// Validates the lifetime before generating a key or contacting the server.
fn encryption_options(settings: &Settings) -> Result<(i32, Vec<u8>, bool), String> {
    if !settings.one_time_valid() {
        return Err("invalid --one-time: expected true or false".to_string());
    }
    let expiration = parse_expiration(&settings.text("expiration")).ok_or(
        "Expiration must be a positive integer duration using s, m, h, d, or w (e.g. 1h or 90d)",
    )?;
    let key = settings.bytes("key");
    // A generated key has to go in the link; a manual one must not.
    let manual = !key.is_empty();
    let key = if manual {
        key
    } else {
        generate_key().into_bytes()
    };
    Ok((expiration, key, manual))
}

fn decrypt(settings: &Settings, out: &mut dyn Write) -> Result<(), String> {
    let link = settings.text("decrypt");
    if !matches_public_url(&link, &settings.text("url")) {
        return Err("Unconfigured yopass decrypt URL, set --api and --url".to_string());
    }
    let mut parsed =
        parse_secret_url(&link).map_err(|err| format!("Invalid yopass decrypt URL: {err}"))?;
    if parsed.manual_key || parsed.key.is_empty() {
        parsed.key = settings.bytes("key");
        // Before the fetch, which can consume a one-time secret.
        if parsed.key.is_empty() {
            return Err("Manual decryption key required, set --key".to_string());
        }
    }
    let (api, token) = (settings.text("api"), settings.text("api-token"));
    let (kind, ciphertext) = if parsed.file {
        let data = client::fetch_file(&api, &parsed.id, &token);
        (
            "file",
            data.map_err(|err| format!("Failed to fetch file: {err}"))?,
        )
    } else {
        let data = client::fetch_secret(&api, &parsed.id, &token);
        (
            "secret",
            data.map_err(|err| format!("Failed to fetch secret: {err}"))?
                .into_bytes(),
        )
    };
    // A panic on hostile input is reported as an invalid message, not a backtrace.
    let hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(|_| {}));
    let decrypted = crypto::decrypt(&ciphertext, &parsed.key);
    std::panic::set_hook(hook);
    let plaintext = decrypted.map_err(|err| format!("Failed to decrypt {kind}: {err}"))?;
    out.write_all(&plaintext)
        .and_then(|()| out.flush())
        .map_err(|err| format!("write stdout: {err}"))
}

/// os.File.Stat().Name()
fn base_name(path: &[u8]) -> &[u8] {
    let path = match path {
        [drive, b':', rest @ ..] if cfg!(windows) && drive.is_ascii_alphabetic() => rest,
        _ => path,
    };
    let is_separator = |c: u8| c == b'/' || (cfg!(windows) && c == b'\\');
    let mut end = path.len();
    while end > 1 && is_separator(path[end - 1]) {
        end -= 1;
    }
    let start = path[..end]
        .iter()
        .rposition(|&c| is_separator(c))
        .map_or(0, |i| i + 1);
    if start >= end {
        &path[..end]
    } else {
        &path[start..end]
    }
}

fn path_of(bytes: &[u8]) -> std::path::PathBuf {
    #[cfg(unix)]
    {
        <std::ffi::OsStr as std::os::unix::ffi::OsStrExt>::from_bytes(bytes).into()
    }
    #[cfg(not(unix))]
    {
        lossy(bytes).into()
    }
}

fn encrypt_file(settings: &Settings, out: &mut dyn Write) -> Result<(), String> {
    let path = settings.bytes("file");
    let shown = lossy(&path);
    let mut file = File::open(path_of(&path))
        .map_err(|err| format!("Failed to open file: open {shown}: {err}"))?;
    share(settings, &mut file, &shown, Some(base_name(&path)), out)
}

/// Encrypts `input`, stores it and prints the link. A file name means a file
/// upload; without one it is a text secret.
fn share(
    settings: &Settings,
    input: &mut dyn Read,
    source: &str,
    file_name: Option<&[u8]>,
    out: &mut dyn Write,
) -> Result<(), String> {
    let kind = if file_name.is_some() {
        "file"
    } else {
        "secret"
    };
    let (expiration, key, manual) = encryption_options(settings)?;
    let url = settings.text("url");
    // Before storing, so a bad --url cannot orphan a secret behind a link decrypt refuses.
    if !decryptable(&secret_url(&url, "id", "", false, true), &url, "id") {
        return Err(format!(
            "Invalid yopass URL {url}: secret links to it could not be decrypted"
        ));
    }
    let mut data = Vec::new();
    input.read_to_end(&mut data).map_err(|err| {
        format!("Failed to encrypt {kind}: could not copy data: read {source}: {err}")
    })?;
    if file_name.is_none() && data.is_empty() {
        return Err(NO_INPUT.to_string());
    }
    let (api, token) = (settings.text("api"), settings.text("api-token"));
    let argon2 = client::server_argon2(&api, &token);
    let one_time = settings.boolean("one-time");
    let encrypt_failed = |err| format!("Failed to encrypt {kind}: {err}");
    let stored = match file_name {
        Some(name) => {
            let encrypted =
                crypto::encrypt_binary(data, &key, name, argon2).map_err(encrypt_failed)?;
            client::store_file(&api, &encrypted, expiration, one_time, &token)
        }
        None => {
            let message = crypto::encrypt(data, &key, argon2).map_err(encrypt_failed)?;
            client::store_secret(&api, &message, expiration, one_time, &token)
        }
    };
    let id = stored.map_err(|err| format!("Failed to store {kind}: {err}"))?;
    if id.is_empty() {
        return Err(format!(
            "Failed to store {kind}: server response has no secret ID"
        ));
    }
    let link = secret_url(&url, &id, &lossy(&key), file_name.is_some(), manual);
    if !decryptable(&link, &url, &id) {
        return Err(format!(
            "Failed to store {kind}: server returned an invalid secret ID"
        ));
    }
    writeln!(out, "{link}").map_err(|err| format!("write stdout: {err}"))
}

fn encrypt_stdin(settings: &Settings, out: &mut dyn Write) -> Result<(), String> {
    if std::io::stdin().is_terminal() {
        return Err(NO_INPUT.to_string());
    }
    share(settings, &mut std::io::stdin(), "stdin", None, out)
}

fn main() {
    let cli = Cli::parse();
    let mut settings = match Settings::load() {
        Ok(settings) => settings,
        Err(err) => {
            eprintln!("Yopass config file invalid: {err}");
            std::process::exit(3);
        }
    };
    cli.apply(&mut settings);
    if settings.text("api").is_empty() || settings.text("url").is_empty() {
        eprintln!(
            "No yopass server configured, set --api and --url or add them to the config file"
        );
        std::process::exit(1);
    }
    let mut stdout = std::io::stdout();
    let result = if settings.is_set("decrypt") {
        decrypt(&settings, &mut stdout)
    } else if settings.is_set("file") {
        encrypt_file(&settings, &mut stdout)
    } else {
        encrypt_stdin(&settings, &mut stdout)
    };
    if let Err(err) = result {
        eprintln!("{err}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cli_definition_is_valid() {
        use clap::CommandFactory;
        Cli::command().debug_assert();
    }

    #[test]
    fn expiration_durations() {
        for (input, want) in [
            ("1h", Some(3600)),
            ("1d", Some(86400)),
            ("1w", Some(604800)),
            ("90d", Some(7776000)),
            ("1d12h", Some(129600)),
            ("1s", Some(1)),
            ("1m", Some(60)),
            ("2147483647s", Some(i32::MAX)),
            ("2147483648s", None),
            ("3550w", Some(3550 * 604800)),
            ("3551w", None),
            ("0h", None),
            ("", None),
            ("123", None),
            ("h", None),
            ("1h ", None),
            (" 1h", None),
            ("-1h", None),
            ("+1h", None),
            ("1.5h", None),
            ("1y", None),
            ("invalid", None),
            ("1H", None),
        ] {
            assert_eq!(parse_expiration(input), want, "{input:?}");
        }
    }

    #[test]
    fn public_url_matching() {
        for (link, base, want) in [
            ("https://yopass.se/#/s/id/key", "https://yopass.se", true),
            (
                "https://YOPASS.se/app/#/s/id/key",
                "https://yopass.se/app/",
                true,
            ),
            (
                "  https://yopass.se/#/s/id/key\n",
                "https://yopass.se",
                true,
            ),
            (
                "https://yopass.se.evil.example/#/s/id/key",
                "https://yopass.se",
                false,
            ),
            (
                "https://yopass.se@evil.example/#/s/id/key",
                "https://yopass.se",
                false,
            ),
            (
                "https://yopass.se/application/#/s/id/key",
                "https://yopass.se/app",
                false,
            ),
            ("http://yopass.se/#/s/id/key", "https://yopass.se", false),
            ("https://yopass.se/#/s/id/key", "", false),
        ] {
            assert_eq!(matches_public_url(link, base), want, "{link} {base}");
        }
    }

    #[test]
    fn public_url_edge_cases() {
        let base = "https://yopass.se";
        for (link, want) in [
            ("https://yopass.se:443/#/s/id/key", true),
            ("https://yopass.se:8443/#/s/id/key", false),
            // Normalized to the same host, where Go would refuse them.
            ("https:/yopass.se/#/s/id/key", true),
            ("https:yopass.se/#/s/id/key", true),
            ("https:///yopass.se/#/s/id/key", true),
            ("https://@yopass.se/#/s/id/key", true),
            ("https://yopass.se\\#/s/id/key", true),
            ("https://yopass.se/\t#/s/id/key", true),
            ("https://yopass.se/#/s/id%zz/key", true),
            ("https://evil.example\\@yopass.se/#/s/id/key", false),
            ("https://yopass.se\\.evil.example/#/s/id/key", false),
            ("https://yopass.se%2eevil.example/#/s/id/key", false),
            ("https://user@yopass.se/#/s/id/key", false),
            ("https://:pw@yopass.se/#/s/id/key", false),
            ("not a url", false),
            ("/#/s/id/key", false),
        ] {
            assert_eq!(matches_public_url(link, base), want, "{link}");
        }
        assert!(matches_public_url(
            "https://b\u{fc}cher.example/#/s/id/key",
            "https://xn--bcher-kva.example"
        ));
    }

    #[test]
    fn secret_links() {
        let link = parse_secret_url("https://x/#/s/id/key").unwrap();
        assert_eq!(
            (
                link.id.as_slice(),
                link.key.as_slice(),
                link.file,
                link.manual_key
            ),
            (&b"id"[..], &b"key"[..], false, false)
        );
        assert!(parse_secret_url("https://x/#/c/id").unwrap().manual_key);
        let link = parse_secret_url("https://x/#/d/id").unwrap();
        assert!(link.file && link.manual_key);
        assert!(parse_secret_url("https://x/#/f/id/k").unwrap().file);
        assert_eq!(parse_secret_url("https://x/#/s/a%2Fb").unwrap().key, b"b");
        for bad in [
            "https://x",
            "https://x/#/q/id",
            "https://x/#s/id",
            "https://x/#/s",
            "https://x/#/s/a/b/c",
            "https://x/#/s//key",
            "https://x/#/s/./key",
            "https://x/#/s/../key",
            "https://x/#/s/%2E%2E/key",
        ] {
            assert_eq!(
                parse_secret_url(bad).err(),
                Some("unexpected link format".to_string()),
                "{bad}"
            );
        }
    }

    #[test]
    fn links_must_decrypt() {
        let url = "https://e.example/";
        let link = |id| secret_url(url, id, "k", false, false);
        assert!(decryptable(&link("abc-1"), url, "abc-1"));
        for id in ["", ".", "..", "a/b", "%41"] {
            assert!(!decryptable(&link(id), url, id), "{id}");
        }
        for url in ["e.example", "https://e.example/#/x", "mailto:a@e.example"] {
            let probe = secret_url(url, "id", "", false, true);
            assert!(!decryptable(&probe, url, "id"), "{url}");
        }
    }

    #[test]
    fn secret_url_format() {
        assert_eq!(
            secret_url("https://x/", "id", "k", false, false),
            "https://x/#/s/id/k"
        );
        assert_eq!(
            secret_url("https://x", "id", "k", true, false),
            "https://x/#/f/id/k"
        );
        assert_eq!(
            secret_url("https://x", "id", "k", false, true),
            "https://x/#/s/id"
        );
        assert_eq!(
            secret_url("https://x", "id", "k", true, true),
            "https://x/#/f/id"
        );
    }

    #[test]
    fn generated_keys_match_the_javascript_format() {
        let a = generate_key();
        assert_eq!(a.len(), 22);
        assert!(a
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_'));
        assert_ne!(a, generate_key());
    }

    #[cfg(windows)]
    #[test]
    fn file_base_names_drop_the_drive() {
        for (path, want) in [
            ("C:secret.txt", "secret.txt"),
            ("C:\\dir\\secret.txt", "secret.txt"),
            ("dir\\secret.txt", "secret.txt"),
        ] {
            assert_eq!(base_name(path.as_bytes()), want.as_bytes(), "{path:?}");
        }
    }

    #[test]
    fn file_base_names() {
        for (path, want) in [
            ("a/b.txt", "b.txt"),
            ("b.txt", "b.txt"),
            ("a/b/", "b"),
            ("/", "/"),
            (".", "."),
            ("..", ".."),
            ("", ""),
        ] {
            assert_eq!(base_name(path.as_bytes()), want.as_bytes(), "{path:?}");
        }
    }
}
