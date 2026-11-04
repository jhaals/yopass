//! Settings resolution: flag > YOPASS_* environment variable > config file > default.
//! The config file is YAML, at ~/.config/yopass/config.yaml.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

type ConfigMap = HashMap<String, Vec<u8>>;

/// strconv.ParseBool
pub fn parse_bool(value: &[u8]) -> Option<bool> {
    match value {
        b"1" | b"t" | b"T" | b"TRUE" | b"true" | b"True" => Some(true),
        b"0" | b"f" | b"F" | b"FALSE" | b"false" | b"False" => Some(false),
        _ => None,
    }
}

/// Refused, as their settings would otherwise be silently dropped. `defaults.*` is
/// what the Go CLI read.
const OTHER_CONFIG_FILES: [&str; 13] = [
    "config.yml",
    "defaults.yaml",
    "defaults.yml",
    "defaults.json",
    "defaults.toml",
    "defaults.properties",
    "defaults.props",
    "defaults.prop",
    "defaults.hcl",
    "defaults.tfvars",
    "defaults.dotenv",
    "defaults.env",
    "defaults.ini",
];
/// `key`, `file` and `decrypt` are per-run choices, and a stored key would encrypt
/// every secret with the same key, so they are flags and environment variables only.
const KNOWN_SETTINGS: [&str; 5] = ["api", "api-token", "expiration", "one-time", "url"];

fn parse_config(text: &[u8]) -> Result<ConfigMap, String> {
    use serde_yaml_ng::Value as Y;
    let root: Option<serde_yaml_ng::Mapping> =
        serde_yaml_ng::from_slice(text).map_err(|err| err.to_string())?;
    let mut config = ConfigMap::new();
    for (key, value) in root.unwrap_or_default() {
        let Some(key) = key.as_str().filter(|key| KNOWN_SETTINGS.contains(key)) else {
            let shown = key
                .as_str()
                .map_or(format!("{key:?}"), |key| format!("{key:?}"));
            return Err(format!("unknown setting {shown}"));
        };
        // YAML rewrites numbers (0x10 is 16) and drops nulls, which would change or lose
        // the token without warning.
        if key == "api-token" && !matches!(value, Y::String(_)) {
            return Err(format!("{key} must be a quoted string"));
        }
        let value = match value {
            Y::Null => continue,
            Y::Bool(value) => value.to_string().into_bytes(),
            Y::Number(value) => value.to_string().into_bytes(),
            Y::String(value) => value.into_bytes(),
            _ => return Err(format!("{key} must be a single value")),
        };
        config.insert(key.to_string(), value);
    }
    Ok(config)
}

/// Formatted, not joined: an empty home must stay absolute, or config would load
/// from whatever directory the CLI runs in.
fn config_dir() -> PathBuf {
    let var = |name| std::env::var_os(name).unwrap_or_default();
    let mut home = var("HOME");
    if cfg!(windows) {
        home = var("HOMEDRIVE");
        home.push(var("HOMEPATH"));
        if home.is_empty() {
            home = var("USERPROFILE");
        }
    }
    home.push("/.config/yopass");
    home.into()
}

fn load_config(dir: &Path) -> Result<ConfigMap, String> {
    for name in OTHER_CONFIG_FILES {
        if dir.join(name).is_file() {
            return Err(format!("{name} is not supported, use config.yaml"));
        }
    }
    let path = dir.join("config.yaml");
    if path.is_file() {
        let text = std::fs::read(&path).map_err(|err| err.to_string())?;
        return parse_config(&text).map_err(|err| format!("While parsing config: {err}"));
    }
    Ok(ConfigMap::new())
}

pub fn bytes_of(arg: std::ffi::OsString) -> Vec<u8> {
    #[cfg(unix)]
    {
        std::os::unix::ffi::OsStringExt::into_vec(arg)
    }
    #[cfg(not(unix))]
    {
        arg.to_string_lossy().into_owned().into_bytes()
    }
}

fn default_of(key: &str) -> Option<Vec<u8>> {
    Some(match key {
        "api" | "api-token" | "url" => Vec::new(),
        "one-time" => b"true".to_vec(),
        "expiration" => b"1h".to_vec(),
        _ => return None,
    })
}

pub struct Settings {
    flags: HashMap<&'static str, Vec<u8>>,
    config: ConfigMap,
}

impl Settings {
    pub fn load() -> Result<Self, String> {
        Ok(Self {
            flags: HashMap::new(),
            config: load_config(&config_dir())?,
        })
    }

    pub fn set_flag(&mut self, key: &'static str, value: Vec<u8>) {
        self.flags.insert(key, value);
    }

    fn get(&self, key: &str) -> Option<Vec<u8>> {
        if let Some(value) = self.flags.get(key) {
            return Some(value.clone());
        }
        let env = format!("YOPASS_{}", key.to_uppercase().replace('-', "_"));
        std::env::var_os(env)
            .map(bytes_of)
            .filter(|value| !value.is_empty())
            .or_else(|| self.config.get(key).cloned())
            .or_else(|| default_of(key))
    }

    pub fn is_set(&self, key: &str) -> bool {
        self.get(key).is_some()
    }

    pub fn bytes(&self, key: &str) -> Vec<u8> {
        self.get(key).unwrap_or_default()
    }

    pub fn text(&self, key: &str) -> String {
        String::from_utf8_lossy(&self.bytes(key)).into_owned()
    }

    pub fn boolean(&self, key: &str) -> bool {
        parse_bool(&self.bytes(key)).unwrap_or(false)
    }

    /// Whether one-time holds a value strconv.ParseBool accepts.
    pub fn one_time_valid(&self) -> bool {
        parse_bool(&self.bytes("one-time")).is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn value<'a>(config: &'a ConfigMap, key: &str) -> &'a [u8] {
        &config[key]
    }

    #[test]
    fn parses_yaml() {
        let config = parse_config(
            b"api: x\none-time: false\napi-token: \"12\"\nurl: 1.5\nexpiration: null\n",
        )
        .unwrap();
        assert_eq!(value(&config, "api"), b"x");
        assert_eq!(value(&config, "one-time"), b"false");
        assert_eq!(value(&config, "api-token"), b"12");
        assert_eq!(value(&config, "url"), b"1.5");
        assert!(!config.contains_key("expiration"));
    }

    #[test]
    fn settings_that_would_be_lost_are_refused() {
        for bad in [
            &b"KEY: abc"[..],
            b"API-Token: abc",
            b"other: 1",
            b"1: abc",
            b"key: abc",
            b"file: x",
            b"decrypt: x",
            b"url: [a]",
            b"url: {a: 1}",
            b"api-token: 0x10",
            b"api-token: 1.50",
            b"api-token: true",
            b"api-token:",
            b"api-token: ~",
            b"a: &a {url: x}\n<<: *a",
            b"\"<<\": {url: x}",
        ] {
            assert!(
                parse_config(bad).is_err(),
                "{}",
                String::from_utf8_lossy(bad)
            );
        }
    }

    #[test]
    fn unknown_settings_are_named() {
        for (config, shown) in [(&b"key: abc"[..], "\"key\""), (b"1: abc", "Number(1)")] {
            let err = parse_config(config).err().unwrap();
            assert_eq!(err, format!("unknown setting {shown}"));
        }
    }

    #[test]
    fn invalid_and_empty_yaml() {
        assert!(parse_config(b"- a").is_err());
        assert!(parse_config(b"a: b: c").is_err());
        assert!(parse_config(b"").unwrap().is_empty());
    }

    #[test]
    fn booleans() {
        assert_eq!(parse_bool(b"T"), Some(true));
        assert_eq!(parse_bool(b"0"), Some(false));
        assert_eq!(parse_bool(b"tRuE"), None);
        assert_eq!(parse_bool(b"true "), None);
        assert_eq!(parse_bool(b""), None);
    }
}
