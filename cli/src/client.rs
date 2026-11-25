//! HTTP client for the yopass API, mirroring pkg/yopass/client.go.

use percent_encoding::{percent_encode, AsciiSet, CONTROLS};
use serde::de::{DeserializeOwned, Deserializer, IgnoredAny, MapAccess, Visitor};
use serde_json::Value;
use std::marker::PhantomData;
use std::sync::OnceLock;
use std::time::Duration;
use ureq::http::{Request, Response};
use ureq::tls::{RootCerts, TlsConfig};
use ureq::{Agent, AsSendBody, Body};

const MAX_BODY: u64 = u64::MAX;
/// How long the server may make no progress. It restarts with every read and write, so
/// a large file on a slow link still gets through.
const IDLE_TIMEOUT: Duration = Duration::from_secs(30);
/// The server may be silent while it moves a file to or from storage. Twice its default
/// --file-transfer-timeout.
const FILE_TIMEOUT: Duration = Duration::from_secs(600);

fn agent() -> &'static Agent {
    static AGENT: OnceLock<Agent> = OnceLock::new();
    AGENT.get_or_init(|| {
        Agent::config_builder()
            .http_status_as_error(false)
            // A redirect could send the token, secret ID or ciphertext somewhere else, or
            // in cleartext. The API has no need for them, so they are errors.
            .max_redirects(0)
            // ureq waits forever by default, and so would a script calling the CLI when
            // the server goes silent. Reads get their limit per request, in run().
            .timeout_connect(Some(IDLE_TIMEOUT))
            .timeout_per_write(Some(IDLE_TIMEOUT))
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

/// Reads one field of a JSON object and skips the others as they are parsed. A `Value`
/// of the whole response would hold every field the server chose to send, at more than
/// a hundred times the size of the response.
struct Field<T>(&'static str, PhantomData<T>);

impl<'de, T: DeserializeOwned> Visitor<'de> for Field<T> {
    type Value = Option<T>;

    fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
        formatter.write_str("an object")
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let mut value = None;
        while let Some(name) = map.next_key::<String>()? {
            if name == self.0 {
                value = Some(map.next_value()?);
            } else {
                map.next_value::<IgnoredAny>()?;
            }
        }
        Ok(value)
    }
}

fn field<T: DeserializeOwned>(body: &[u8], name: &'static str) -> Option<T> {
    let mut json = serde_json::Deserializer::from_slice(body);
    let value = json.deserialize_map(Field(name, PhantomData)).ok()?;
    json.end().ok()?;
    value
}

fn message_of(body: &[u8]) -> Option<String> {
    field(body, "message")
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

fn run(
    request: Request<impl AsSendBody>,
    read_timeout: Duration,
) -> Result<Response<Body>, ureq::Error> {
    let request = agent()
        .configure_request(request)
        .timeout_per_read(Some(read_timeout))
        .build();
    agent().run(request)
}

fn send(
    method: &'static str,
    url: String,
    headers: Vec<(&'static str, String)>,
    body: Option<&[u8]>,
    token: &str,
    read_timeout: Duration,
) -> Result<Response<Body>, String> {
    let mut request = Request::builder().method(method).uri(&url);
    for (name, value) in headers {
        request = request.header(name, value);
    }
    if let Some(value) = authorization(token) {
        request = request.header("Authorization", value);
    }
    let result = match body {
        Some(body) => run(request.body(body).map_err(server_error)?, read_timeout),
        None => run(request.body(()).map_err(server_error)?, read_timeout),
    };
    result.map_err(request_error)
}

/// ureq quotes the request URL when it lacks a scheme or host. For a fetch that URL
/// ends in the secret ID, and errors end up in logs while the secret is still on the
/// server, so that one error is reported without it.
fn request_error(err: ureq::Error) -> String {
    match err {
        ureq::Error::BadUri(_) => server_error("bad uri: missing or unknown scheme or host"),
        err => server_error(err),
    }
}

/// Whether the server advertises Argon2. Any failure means false, because every
/// server accepts the default key derivation.
pub fn server_argon2(server: &str, token: &str) -> bool {
    let fetch = || -> Option<bool> {
        let url = endpoint(server, "/config");
        let resp = send("GET", url, Vec::new(), None, token, IDLE_TIMEOUT).ok()?;
        if resp.status().as_u16() != 200 {
            return None;
        }
        field(&read(resp).ok()?, "ARGON2")
    };
    fetch().unwrap_or(false)
}

pub fn fetch_secret(server: &str, id: &[u8], token: &str) -> Result<String, String> {
    let url = endpoint(server, &format!("/secret/{}", escape_id(id)));
    handle_response(send("GET", url, Vec::new(), None, token, IDLE_TIMEOUT)?)
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
    let resp = send(
        "POST",
        url,
        headers,
        Some(body.as_bytes()),
        token,
        IDLE_TIMEOUT,
    )?;
    handle_response(resp)
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
    handle_response(send("POST", url, headers, Some(data), token, FILE_TIMEOUT)?)
}

pub fn fetch_file(server: &str, id: &[u8], token: &str) -> Result<Vec<u8>, String> {
    let url = endpoint(server, &format!("/file/{}", escape_id(id)));
    let headers = vec![("Accept", "application/octet-stream".to_string())];
    let resp = send("GET", url, headers, None, token, FILE_TIMEOUT)?;
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
    use std::io::{Read, Write};

    #[test]
    fn silent_server_is_an_error() {
        for sent in [
            "",
            "HTTP/1.1 200 OK\r\n",
            "HTTP/1.1 200 OK\r\nContent-Length: 9\r\n\r\n{",
        ] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let url = format!("http://{}/", listener.local_addr().unwrap());
            let (done, result) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let resp = send("GET", url, Vec::new(), None, "", Duration::from_millis(200));
                done.send(resp.and_then(|resp| read(resp).map_err(server_error)))
            });
            let (mut stream, _) = listener.accept().unwrap();
            assert!(stream.read(&mut [0; 4096]).unwrap() > 0);
            stream.write_all(sent.as_bytes()).unwrap();
            // Without a limit the client never returns, so it is not waited for here.
            let result = result.recv_timeout(Duration::from_secs(10));
            assert_eq!(
                result.expect("still waiting").unwrap_err(),
                "yopass server error: timeout: per read",
                "{sent:?}"
            );
        }
    }

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
            br#"["x"]"#,
        ] {
            assert_eq!(message_of(body), None);
        }
    }

    /// A `Value` cannot hold more than 128 levels, so these responses only decode if the
    /// fields the CLI does not read are skipped and never built.
    #[test]
    fn unread_fields_are_skipped() {
        let deep = format!("{}0{}", "[".repeat(500), "]".repeat(500));
        let body = format!(r#"{{"a":{deep},"message":"x","b":{deep}}}"#);
        assert_eq!(message_of(body.as_bytes()).as_deref(), Some("x"));
        let body = format!(r#"{{"a":{deep},"ARGON2":true,"b":{deep}}}"#);
        assert_eq!(field(body.as_bytes(), "ARGON2"), Some(true));
        for body in [r#"{"ARGON2":"true"}"#, r#"{"argon2":true}"#, "[true]"] {
            assert_eq!(field::<bool>(body.as_bytes(), "ARGON2"), None, "{body}");
        }
    }

    #[test]
    fn id_escaping() {
        assert_eq!(escape_id(b"abc-1_2"), "abc-1_2");
        assert_eq!(escape_id(b"a b\n\xff"), "a%20b%0A%FF");
        assert_eq!(escape_id(b"a/b?c#d%e"), "a%2Fb%3Fc%23d%25e");
    }
}
