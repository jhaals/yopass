//! HTTP client for the yopass API, mirroring pkg/yopass/client.go.

use percent_encoding::{percent_encode, AsciiSet, CONTROLS};
use serde_json::Value;
use std::sync::OnceLock;
use ureq::http::{Request, Response};
use ureq::tls::{RootCerts, TlsConfig};
use ureq::{Agent, Body};

const MAX_BODY: u64 = u64::MAX;

fn agent() -> &'static Agent {
    static AGENT: OnceLock<Agent> = OnceLock::new();
    AGENT.get_or_init(|| {
        Agent::config_builder()
            .http_status_as_error(false)
            // A redirect could send the token, secret ID or ciphertext somewhere else, or
            // in cleartext. The API has no need for them, so they are errors.
            .max_redirects(0)
            // Self-hosted instances often sit behind private CAs that only the OS trusts.
            .tls_config(
                TlsConfig::builder()
                    .root_certs(RootCerts::PlatformVerifier)
                    .build(),
            )
            .build()
            .new_agent()
    })
}

fn server_error(err: impl std::fmt::Display) -> String {
    format!("yopass server error: {err}")
}

fn authorization(token: &str) -> Option<String> {
    let mut token = token.trim();
    if token.is_empty() {
        return None;
    }
    if token.len() >= 7 && token.as_bytes()[..7].eq_ignore_ascii_case(b"bearer ") {
        token = token[7..].trim();
    }
    Some(format!("Bearer {token}"))
}

fn endpoint(server: &str, path: &str) -> String {
    format!("{}{path}", server.strip_suffix('/').unwrap_or(server))
}

/// IDs come from a possibly hostile link, so they must stay one path segment. Dot
/// segments are refused when the link is parsed.
fn escape_id(id: &[u8]) -> String {
    const ESCAPED: &AsciiSet = &CONTROLS
        .add(b' ')
        .add(b'"')
        .add(b'#')
        .add(b'%')
        .add(b'/')
        .add(b'<')
        .add(b'>')
        .add(b'?')
        .add(b'\\')
        .add(b'^')
        .add(b'`')
        .add(b'{')
        .add(b'|')
        .add(b'}');
    percent_encode(id, ESCAPED).to_string()
}

fn status_line(resp: &Response<Body>) -> String {
    let status = resp.status();
    format!(
        "{} {}",
        status.as_u16(),
        status.canonical_reason().unwrap_or("")
    )
}

fn read(resp: Response<Body>) -> Result<Vec<u8>, ureq::Error> {
    resp.into_body().with_config().limit(MAX_BODY).read_to_vec()
}

fn message_of(body: &[u8]) -> Option<String> {
    let value = serde_json::from_slice::<Value>(body).ok()?;
    value.get("message")?.as_str().map(String::from)
}

fn handle_response(resp: Response<Body>) -> Result<String, String> {
    let status = status_line(&resp);
    let ok = resp.status().as_u16() == 200;
    let body = read(resp);
    if !ok {
        let body = body.unwrap_or_default();
        let message =
            message_of(&body).unwrap_or_else(|| String::from_utf8_lossy(&body).into_owned());
        return Err(server_error(format!(
            "unexpected response {status}: {message}"
        )));
    }
    let body = body.map_err(|err| format!("could not decode server response: {err}"))?;
    message_of(&body).ok_or_else(|| "could not decode server response".to_string())
}

fn send(
    method: &'static str,
    url: String,
    headers: Vec<(&'static str, String)>,
    body: Option<&[u8]>,
    token: &str,
) -> Result<Response<Body>, String> {
    let mut request = Request::builder().method(method).uri(&url);
    for (name, value) in headers {
        request = request.header(name, value);
    }
    if let Some(value) = authorization(token) {
        request = request.header("Authorization", value);
    }
    let result = match body {
        Some(body) => agent().run(request.body(body).map_err(server_error)?),
        None => agent().run(request.body(()).map_err(server_error)?),
    };
    result.map_err(server_error)
}

/// Whether the server advertises Argon2. Any failure means false, because every
/// server accepts the default key derivation.
pub fn server_argon2(server: &str, token: &str) -> bool {
    let fetch = || -> Option<bool> {
        let resp = send("GET", endpoint(server, "/config"), Vec::new(), None, token).ok()?;
        if resp.status().as_u16() != 200 {
            return None;
        }
        let config = serde_json::from_slice::<Value>(&read(resp).ok()?).ok()?;
        config.get("ARGON2")?.as_bool()
    };
    fetch().unwrap_or(false)
}

pub fn fetch_secret(server: &str, id: &[u8], token: &str) -> Result<String, String> {
    let url = endpoint(server, &format!("/secret/{}", escape_id(id)));
    handle_response(send("GET", url, Vec::new(), None, token)?)
}

pub fn store_secret(
    server: &str,
    message: &str,
    expiration: i32,
    one_time: bool,
    token: &str,
) -> Result<String, String> {
    let mut secret = serde_json::Map::new();
    secret.insert("expiration".into(), expiration.into());
    secret.insert("message".into(), message.into());
    if one_time {
        secret.insert("one_time".into(), true.into());
    }
    let body = Value::Object(secret).to_string();
    let headers = vec![("Content-Type", "application/json".to_string())];
    let url = endpoint(server, "/create/secret");
    handle_response(send("POST", url, headers, Some(body.as_bytes()), token)?)
}

pub fn store_file(
    server: &str,
    data: &[u8],
    expiration: i32,
    one_time: bool,
    token: &str,
) -> Result<String, String> {
    let headers = vec![
        ("Content-Type", "application/octet-stream".to_string()),
        ("X-Yopass-Expiration", expiration.to_string()),
        ("X-Yopass-OneTime", one_time.to_string()),
    ];
    let url = endpoint(server, "/create/file");
    handle_response(send("POST", url, headers, Some(data), token)?)
}

pub fn fetch_file(server: &str, id: &[u8], token: &str) -> Result<Vec<u8>, String> {
    let url = endpoint(server, &format!("/file/{}", escape_id(id)));
    let headers = vec![("Accept", "application/octet-stream".to_string())];
    let resp = send("GET", url, headers, None, token)?;
    let status = status_line(&resp);
    if resp.status().as_u16() != 200 {
        let body = read(resp).unwrap_or_default();
        return Err(server_error(format!(
            "unexpected response {status}: {}",
            String::from_utf8_lossy(&body)
        )));
    }
    read(resp).map_err(|err| format!("could not read response: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authorization_header() {
        for (token, want) in [
            ("", None),
            ("  ", None),
            ("abc", Some("Bearer abc")),
            (" abc\n", Some("Bearer abc")),
            ("Bearer abc", Some("Bearer abc")),
            ("bEaReR   abc ", Some("Bearer abc")),
            ("bearerabc", Some("Bearer bearerabc")),
        ] {
            assert_eq!(authorization(token).as_deref(), want, "{token:?}");
        }
    }

    #[test]
    fn endpoint_trims_one_slash() {
        assert_eq!(endpoint("https://a/", "/x"), "https://a/x");
        assert_eq!(endpoint("https://a//", "/x"), "https://a//x");
        assert_eq!(endpoint("https://a", "/x"), "https://a/x");
    }

    #[test]
    fn messages() {
        assert_eq!(message_of(br#"{"message":"x"}"#).as_deref(), Some("x"));
        for body in [
            &br#"{"message":1}"#[..],
            b"{}",
            b"null",
            b"<html>",
            b"",
            b"{} x",
        ] {
            assert_eq!(message_of(body), None);
        }
    }

    #[test]
    fn id_escaping() {
        assert_eq!(escape_id(b"abc-1_2"), "abc-1_2");
        assert_eq!(escape_id(b"a b\n\xff"), "a%20b%0A%FF");
        assert_eq!(escape_id(b"a/b?c#d%e"), "a%2Fb%3Fc%23d%25e");
    }
}
