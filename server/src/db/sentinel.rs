//! Redis Sentinel URLs, read as the Go server's go-redis `ParseFailoverURL`
//! reads them, so one `--redis` value works for both servers:
//!
//! `redis[s]://[sentinel-user:sentinel-pass@]host[:port][/db]?master_name=name&addr=host:port&password=...`
//!
//! The URL's host and each `addr` are Sentinels; its user info authenticates
//! against them. `username`, `password` and the database apply to the primary.

use redis::sentinel::{SentinelClient, SentinelClientBuilder, SentinelServerType};
use redis::{ConnectionAddr, TlsMode};
use std::collections::BTreeMap;

/// go-redis tuning options. They are accepted, so a URL written for the Go
/// server starts this one, and checked as Go checks them, but this server
/// keeps its own timeouts and pool size.
const INT_OPTIONS: [&str; 12] = [
    "protocol",
    "max_retries",
    "dialer_retries",
    "pool_size",
    "max_concurrent_dials",
    "min_idle_conns",
    "max_idle_conns",
    "max_active_conns",
    "pipeline_pool_size",
    "pipeline_read_buffer_size",
    "pipeline_write_buffer_size",
    "db",
];
const DURATION_OPTIONS: [&str; 11] = [
    "route_by_latency_tolerance",
    "min_retry_backoff",
    "max_retry_backoff",
    "dial_timeout",
    "dialer_retry_timeout",
    "read_timeout",
    "write_timeout",
    "conn_max_lifetime",
    "conn_max_lifetime_jitter",
    "conn_max_idle_time",
    "pool_timeout",
];
const BOOL_OPTIONS: [&str; 5] = [
    "use_disconnected_replicas",
    "context_timeout_enabled",
    "pool_fifo",
    "disableIdentity",
    "unstable_resp3",
];
const STRING_OPTIONS: [&str; 2] = ["client_name", "identitySuffix"];
/// Yopass writes on every request, so it must always talk to the primary.
const ROUTING_OPTIONS: [&str; 3] = ["replica_only", "route_by_latency", "route_randomly"];

/// Whether `url` names a Sentinel set, as the Go server decides it: by the
/// first `master_name`, though the parse then takes the last.
pub(super) fn is_sentinel_url(url: &url::Url) -> bool {
    url.query_pairs()
        .find(|(name, _)| name == "master_name")
        .is_some_and(|(_, value)| !value.is_empty())
}

#[derive(Debug, PartialEq)]
pub(super) struct SentinelConfig {
    pub sentinels: Vec<(String, u16)>,
    pub master_name: String,
    pub tls: Option<TlsMode>,
    pub sentinel_username: Option<String>,
    pub sentinel_password: Option<String>,
    pub username: Option<String>,
    pub password: Option<String>,
    pub db: i64,
}

/// The query, last value winning as in Go, with `addr` kept whole.
struct Query {
    values: BTreeMap<String, Vec<String>>,
}

impl Query {
    fn take(&mut self, name: &str) -> Option<String> {
        self.values.remove(name).and_then(|mut v| v.pop())
    }

    fn take_all(&mut self, name: &str) -> Vec<String> {
        self.values.remove(name).unwrap_or_default()
    }

    fn take_bool(&mut self, name: &str) -> Result<bool, String> {
        match self.take(name).as_deref() {
            None | Some("" | "false" | "0") => Ok(false),
            Some("true" | "1") => Ok(true),
            Some(_) => Err(format!("invalid {name} boolean")),
        }
    }
}

fn is_go_duration(value: &str) -> bool {
    if value.parse::<i64>().is_ok() {
        return true;
    }
    let mut rest = value.strip_prefix(['-', '+']).unwrap_or(value);
    if rest.is_empty() {
        return false;
    }
    while !rest.is_empty() {
        let number = rest
            .find(|c: char| !(c.is_ascii_digit() || c == '.'))
            .unwrap_or(rest.len());
        if number == 0 || rest[..number].parse::<f64>().is_err() {
            return false;
        }
        rest = &rest[number..];
        let unit = ["ns", "us", "µs", "μs", "ms", "s", "m", "h"]
            .into_iter()
            .find(|unit| rest.starts_with(unit));
        let Some(unit) = unit else { return false };
        rest = &rest[unit.len()..];
    }
    true
}

fn decode(text: &str) -> String {
    percent_encoding::percent_decode_str(text)
        .decode_utf8_lossy()
        .into_owned()
}

fn port(text: &str) -> Option<u16> {
    text.parse().ok()
}

/// Parses a Sentinel URL. Errors never quote it: it can hold credentials.
pub(super) fn parse(url: &url::Url) -> Result<SentinelConfig, String> {
    let fail = |what: &str| format!("redis: invalid Sentinel URL: {what}");
    let tls = match url.scheme() {
        "redis" => None,
        "rediss" => Some(TlsMode::Secure),
        _ => return Err(fail("the scheme must be redis or rediss")),
    };
    let host = match url.host_str() {
        None | Some("") => "localhost".to_owned(),
        // url keeps the brackets of an IPv6 literal; the dialer wants it bare.
        Some(host) => host
            .trim_start_matches('[')
            .trim_end_matches(']')
            .to_owned(),
    };
    let mut sentinels = vec![(host, url.port().unwrap_or(6379))];
    let segments: Vec<&str> = url.path().split('/').filter(|s| !s.is_empty()).collect();
    let mut db = match segments.as_slice() {
        [] => 0,
        [db] => db.parse().map_err(|_| fail("invalid database number"))?,
        _ => return Err(fail("invalid path")),
    };
    let nonempty = |s: String| (!s.is_empty()).then_some(s);
    let sentinel_username = nonempty(decode(url.username()));
    let sentinel_password = url.password().map(decode).and_then(nonempty);

    let mut query = Query {
        values: BTreeMap::new(),
    };
    for (name, value) in url.query_pairs() {
        query
            .values
            .entry(name.into_owned())
            .or_default()
            .push(value.into_owned());
    }
    let master_name = query.take("master_name").unwrap_or_default();
    if master_name.is_empty() {
        return Err(fail("master_name is required"));
    }
    for option in ROUTING_OPTIONS {
        if query.take_bool(option).map_err(|e| fail(&e))? {
            return Err(
                "redis: replica_only, route_by_latency and route_randomly are not supported"
                    .to_owned(),
            );
        }
    }
    let username = query.take("username").and_then(nonempty);
    let password = query.take("password").and_then(nonempty);
    for option in INT_OPTIONS {
        if let Some(value) = query.take(option).filter(|v| !v.is_empty()) {
            let parsed: i64 = value
                .parse()
                .map_err(|_| fail(&format!("invalid {option} number")))?;
            if option == "db" {
                db = parsed;
            }
        }
    }
    for option in DURATION_OPTIONS {
        if let Some(value) = query.take(option).filter(|v| !v.is_empty())
            && !is_go_duration(&value)
        {
            return Err(fail(&format!("invalid {option} duration")));
        }
    }
    for option in BOOL_OPTIONS {
        query.take_bool(option).map_err(|e| fail(&e))?;
    }
    for option in STRING_OPTIONS {
        query.take(option);
    }
    for addr in query.take_all("addr") {
        // As Go's net.SplitHostPort: an IPv6 host needs its brackets.
        let (host, port) = addr
            .rsplit_once(':')
            .and_then(|(host, p)| Some((host, port(p)?)))
            .and_then(|(host, port)| match host.strip_prefix('[') {
                Some(inner) => Some((inner.strip_suffix(']')?, port)),
                None => (!host.contains([':', ']'])).then_some((host, port)),
            })
            .filter(|(host, _)| !host.is_empty())
            .ok_or_else(|| fail("unable to parse addr param"))?;
        sentinels.push((host.to_owned(), port));
    }
    // As in Go, skip_verify is a TLS option only, and unknown without it.
    let tls = if tls.is_some() && query.take_bool("skip_verify").map_err(|e| fail(&e))? {
        Some(TlsMode::Insecure)
    } else {
        tls
    };
    // Not named: a mistyped query can hold a password.
    if !query.values.is_empty() {
        return Err(fail("unexpected option"));
    }
    Ok(SentinelConfig {
        sentinels,
        master_name,
        tls,
        sentinel_username,
        sentinel_password,
        username,
        password,
        db,
    })
}

/// A client that asks the Sentinels for the primary and checks its role.
pub(super) fn client(config: &SentinelConfig) -> Result<SentinelClient, String> {
    let addrs = config
        .sentinels
        .iter()
        .map(|(host, port)| match config.tls {
            None => ConnectionAddr::Tcp(host.clone(), *port),
            Some(mode) => ConnectionAddr::TcpTls {
                host: host.clone(),
                port: *port,
                insecure: mode == TlsMode::Insecure,
                tls_params: None,
            },
        });
    let mut builder =
        SentinelClientBuilder::new(addrs, &config.master_name, SentinelServerType::Master)
            .map_err(|e| format!("redis: invalid Sentinel URL: {:?}", e.kind()))?
            .set_client_to_redis_db(config.db);
    if let Some(mode) = config.tls {
        builder = builder
            .set_client_to_redis_tls_mode(mode)
            .set_client_to_sentinel_tls_mode(mode);
    }
    if let Some(username) = &config.username {
        builder = builder.set_client_to_redis_username(username);
    }
    if let Some(password) = &config.password {
        builder = builder.set_client_to_redis_password(password);
    }
    if let Some(username) = &config.sentinel_username {
        builder = builder.set_client_to_sentinel_username(username);
    }
    if let Some(password) = &config.sentinel_password {
        builder = builder.set_client_to_sentinel_password(password);
    }
    builder
        .build()
        .map_err(|e| format!("redis: invalid Sentinel URL: {:?}", e.kind()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parsed(url: &str) -> Result<SentinelConfig, String> {
        parse(&url::Url::parse(url).unwrap())
    }

    #[test]
    fn reads_the_url_as_go_does() {
        let config = parsed(
            "redis://sentinel-user:sentinel-pw@sentinel1:26379/2?master_name=mymaster&addr=sentinel2:26379&addr=[::1]:26380&password=redis-pw&username=app",
        )
        .unwrap();
        assert_eq!(
            config,
            SentinelConfig {
                sentinels: vec![
                    ("sentinel1".into(), 26379),
                    ("sentinel2".into(), 26379),
                    ("::1".into(), 26380),
                ],
                master_name: "mymaster".into(),
                tls: None,
                sentinel_username: Some("sentinel-user".into()),
                sentinel_password: Some("sentinel-pw".into()),
                username: Some("app".into()),
                password: Some("redis-pw".into()),
                db: 2,
            }
        );
        let defaults = parsed("redis://?master_name=m").unwrap();
        assert_eq!(defaults.sentinels, [("localhost".to_owned(), 6379)]);
        assert_eq!(defaults.db, 0);
        assert_eq!(defaults.sentinel_password, None);
        // The db option overrides the path, and the last value of an option wins.
        let config = parsed("redis://h/1?master_name=a&master_name=b&db=3").unwrap();
        assert_eq!((config.master_name.as_str(), config.db), ("b", 3));
    }

    #[test]
    fn credentials_are_percent_decoded() {
        let config =
            parsed("redis://u%40x:p%40ss%3A1@h/0?master_name=m&password=r%26x%2B").unwrap();
        assert_eq!(config.sentinel_username.as_deref(), Some("u@x"));
        assert_eq!(config.sentinel_password.as_deref(), Some("p@ss:1"));
        assert_eq!(config.password.as_deref(), Some("r&x+"));
        let config = parsed("redis://:@h/0?master_name=m&password=").unwrap();
        assert_eq!((config.sentinel_password, config.password), (None, None));
    }

    #[test]
    fn tls_covers_sentinels_and_the_primary() {
        assert_eq!(
            parsed("rediss://h/0?master_name=m").unwrap().tls,
            Some(TlsMode::Secure)
        );
        assert_eq!(
            parsed("rediss://h/0?master_name=m&skip_verify=true")
                .unwrap()
                .tls,
            Some(TlsMode::Insecure)
        );
        assert_eq!(
            parsed("rediss://h/0?master_name=m&skip_verify=false")
                .unwrap()
                .tls,
            Some(TlsMode::Secure)
        );
        // As in Go, skip_verify is unknown without TLS.
        assert!(parsed("redis://h/0?master_name=m&skip_verify=true").is_err());
        let config = parsed("rediss://s1:26379/0?master_name=m&addr=s2:26379").unwrap();
        assert!(client(&config).is_ok());
    }

    #[test]
    fn go_tuning_options_are_accepted_and_checked() {
        for option in [
            "dial_timeout=5s",
            "read_timeout=3",
            "write_timeout=-1",
            "conn_max_idle_time=1h30m",
            "pool_timeout=1.5s",
            "pool_size=10",
            "protocol=3",
            "max_retries=",
            "pool_fifo=true",
            "client_name=yopass",
            "replica_only=false",
            "route_by_latency=0",
            "route_randomly=",
        ] {
            let url = format!("redis://h/0?master_name=m&{option}");
            assert!(parsed(&url).is_ok(), "{option}");
        }
        for option in [
            "dial_timeout=5x",
            "read_timeout=s",
            "pool_size=ten",
            "pool_fifo=yes",
            "db=x",
        ] {
            let url = format!("redis://h/0?master_name=m&{option}");
            assert!(parsed(&url).is_err(), "{option}");
        }
    }

    #[test]
    fn invalid_urls_are_refused_as_go_refuses_them() {
        for url in [
            "redis://s1:26379/0?master_name=mymaster&replica_only=true",
            "redis://s1:26379/0?master_name=mymaster&route_by_latency=true",
            "redis://s1:26379/0?master_name=mymaster&route_randomly=1",
            "redis://s1:26379/0?master_name=mymaster&unknown_option=1",
            "redis://s1:26379/0?master_name=",
            "memcached://s1:26379/0?master_name=mymaster",
            "redis://s1:26379/x?master_name=m",
            "redis://s1:26379/0/1?master_name=m",
            "redis://s1/0?master_name=m&addr=s2",
            "redis://s1/0?master_name=m&addr=:26379",
            "redis://s1/0?master_name=m&addr=s2:port",
            "redis://s1/0?master_name=m&addr=::1:26380",
            "redis://s1/0?master_name=m&addr=[::1:26380",
        ] {
            assert!(parsed(url).is_err(), "{url}");
        }
    }

    #[test]
    fn errors_never_quote_the_url() {
        for url in [
            "redis://:hunter2@h/0?master_name=m&hunter2",
            "redis://:hunter2@h/hunter2?master_name=m",
            "redis://h/0?master_name=m&addr=hunter2&password=hunter2",
            "redis://h/0?master_name=m&dial_timeout=hunter2",
            "ftp://:hunter2@h/0?master_name=m",
        ] {
            let error = parsed(url).unwrap_err();
            assert!(!error.contains("hunter2"), "{url}: {error}");
        }
    }

    #[test]
    fn only_a_nonempty_master_name_selects_sentinel() {
        let is = |url: &str| is_sentinel_url(&url::Url::parse(url).unwrap());
        assert!(is("redis://h/0?master_name=m"));
        assert!(!is("redis://h/0?master_name="));
        // As Go, by the first value.
        assert!(!is("redis://h/0?master_name=&master_name=m"));
        assert!(is("redis://h/0?master_name=m&master_name=x"));
        assert!(!is("redis://h/0"));
    }

    #[test]
    fn go_durations() {
        for ok in [
            "0", "5", "-1", "5s", "1.5h", "1h30m", "300ms", "2us", "2µs", "+3s",
        ] {
            assert!(is_go_duration(ok), "{ok}");
        }
        for bad in ["", "s", "5x", "1.2.3s", "--1s", "h1", "5 s"] {
            assert!(!is_go_duration(bad), "{bad}");
        }
    }
}
