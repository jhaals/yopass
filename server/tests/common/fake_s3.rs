//! A small in-process S3, path-style, for tests of the S3 file store and for
//! running the Go and Rust servers against one bucket. It behaves like the
//! services the store must work with: it requires SigV4-signed requests, decodes
//! aws-chunked uploads, rejects object tagging with 501 like Cloudflare R2, and
//! rejects bodies without a length like AWS. Operations can be made to fail or
//! hang.

use axum::Router;
use axum::body::Bytes;
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use std::collections::{BTreeMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard};
use tokio::net::TcpListener;

pub const BUCKET: &str = "yopass-test";
pub const ACCESS_KEY: &str = "fake-access-key";
pub const SECRET_KEY: &str = "fake-secret-key";
/// The CA that signed the TLS fake's certificate.
pub const CA_FILE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/s3_ca.pem");

#[derive(Clone, Debug)]
pub struct Object {
    pub data: Vec<u8>,
    /// The raw `Expires` header the object was stored with.
    pub expires: Option<String>,
}

#[derive(Clone, Debug)]
pub struct Logged {
    pub op: &'static str,
    pub key: String,
    pub headers: HeaderMap,
}

#[derive(Default)]
pub struct State {
    pub objects: BTreeMap<String, Object>,
    /// Operations that answer 500, by name, optionally for one key only.
    pub fail: HashSet<(&'static str, Option<String>)>,
    /// Operations that never answer, until removed.
    pub stall: HashSet<&'static str>,
    /// Keys per list page; 0 means 1000, as S3.
    pub page_size: usize,
    /// Send GET bodies chunked, without a Content-Length.
    pub unsized_gets: bool,
    pub log: Vec<Logged>,
}

#[derive(Clone)]
pub struct FakeS3 {
    pub url: String,
    state: Arc<Mutex<State>>,
}

impl FakeS3 {
    pub async fn start() -> Self {
        Self::start_with(false).await
    }

    /// Serves HTTPS with a certificate for 127.0.0.1 signed by [`CA_FILE`]; the
    /// Go SDK streams uploads over TLS only.
    pub async fn start_tls() -> Self {
        Self::start_with(true).await
    }

    async fn start_with(tls: bool) -> Self {
        let state = Arc::new(Mutex::new(State::default()));
        let shared = state.clone();
        let router = Router::new().fallback(
            move |method: Method, uri: Uri, headers: HeaderMap, body: Bytes| {
                let state = shared.clone();
                async move { handle(&state, method, uri, headers, body).await }
            },
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        if tls {
            let fixtures = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures");
            let acceptor = yopass_server::serve::load_tls(
                &format!("{fixtures}/s3_cert.pem"),
                &format!("{fixtures}/s3_key.pem"),
            )
            .unwrap();
            let stop = tokio_util::sync::CancellationToken::new();
            tokio::spawn(yopass_server::serve::serve(
                listener,
                router,
                Some(acceptor),
                yopass_server::serve::Limits::default(),
                stop,
            ));
            return Self {
                url: format!("https://{address}"),
                state,
            };
        }
        tokio::spawn(async move { axum::serve(listener, router).await });
        Self {
            url: format!("http://{address}"),
            state,
        }
    }

    pub fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap()
    }

    pub fn object(&self, key: &str) -> Option<Object> {
        self.state().objects.get(key).cloned()
    }

    pub fn put(&self, key: &str, data: &[u8], expires: Option<&str>) {
        self.state().objects.insert(
            key.to_owned(),
            Object {
                data: data.to_vec(),
                expires: expires.map(str::to_owned),
            },
        );
    }

    pub fn keys(&self) -> Vec<String> {
        self.state().objects.keys().cloned().collect()
    }

    pub fn ops(&self, op: &str) -> Vec<Logged> {
        self.state()
            .log
            .iter()
            .filter(|l| l.op == op)
            .cloned()
            .collect()
    }

    /// Environment for a server process pointed at this fake.
    pub fn env(&self) -> Vec<(&'static str, String)> {
        vec![
            ("AWS_ACCESS_KEY_ID", ACCESS_KEY.to_owned()),
            ("AWS_SECRET_ACCESS_KEY", SECRET_KEY.to_owned()),
            ("AWS_EC2_METADATA_DISABLED", "true".to_owned()),
            ("AWS_CONFIG_FILE", "/nonexistent".to_owned()),
            ("AWS_SHARED_CREDENTIALS_FILE", "/nonexistent".to_owned()),
            ("SSL_CERT_FILE", CA_FILE.to_owned()),
        ]
    }

    /// Server flags for a file store in this fake's bucket.
    pub fn args(&self, prefix: &str) -> Vec<String> {
        vec![
            "--file-store=s3".to_owned(),
            format!("--file-store-s3-bucket={BUCKET}"),
            format!("--file-store-s3-prefix={prefix}"),
            format!("--file-store-s3-endpoint={}", self.url),
            "--file-store-s3-region=us-east-1".to_owned(),
        ]
    }
}

fn error(status: StatusCode, code: &str) -> Response {
    let body = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?><Error><Code>{code}</Code><Message>{code}</Message><RequestId>fake</RequestId></Error>"#
    );
    (status, [("content-type", "application/xml")], body).into_response()
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn query(uri: &Uri, name: &str) -> Option<String> {
    url::form_urlencoded::parse(uri.query().unwrap_or("").as_bytes())
        .find(|(k, _)| k == name)
        .map(|(_, v)| v.into_owned())
}

/// Decodes an aws-chunked body: `hex-size[;ext]\r\n data \r\n`, until size 0.
fn decode_aws_chunked(body: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let mut rest = body;
    loop {
        let line_end = rest.windows(2).position(|w| w == b"\r\n")?;
        let line = std::str::from_utf8(&rest[..line_end]).ok()?;
        let size = usize::from_str_radix(line.split(';').next()?.trim(), 16).ok()?;
        rest = &rest[line_end + 2..];
        if size == 0 {
            return Some(out);
        }
        out.extend_from_slice(rest.get(..size)?);
        rest = rest.get(size..)?.strip_prefix(b"\r\n")?;
    }
}

async fn handle(
    state: &Mutex<State>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let path = uri.path().trim_start_matches('/');
    let (bucket, key) = path.split_once('/').unwrap_or((path, ""));
    let key = percent_decode(key);
    let op = match (&method, key.is_empty()) {
        (&Method::HEAD, true) => "head_bucket",
        (&Method::GET, true) => "list",
        (&Method::HEAD, false) => "head",
        (&Method::PUT, false) => "put",
        (&Method::GET, false) => "get",
        (&Method::DELETE, false) => "delete",
        _ => return error(StatusCode::METHOD_NOT_ALLOWED, "MethodNotAllowed"),
    };
    let stall = {
        let mut state = state.lock().unwrap();
        state.log.push(Logged {
            op,
            key: key.clone(),
            headers: headers.clone(),
        });
        state.stall.contains(op)
    };
    if stall {
        std::future::pending::<()>().await;
    }
    let signed = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| {
            v.starts_with(&format!("AWS4-HMAC-SHA256 Credential={ACCESS_KEY}/"))
                && v.contains("Signature=")
        });
    if !signed {
        return error(StatusCode::FORBIDDEN, "AccessDenied");
    }
    if bucket != BUCKET {
        return match op {
            "head_bucket" | "head" => StatusCode::NOT_FOUND.into_response(),
            _ => error(StatusCode::NOT_FOUND, "NoSuchBucket"),
        };
    }
    let mut state = state.lock().unwrap();
    if state.fail.contains(&(op, None)) || state.fail.contains(&(op, Some(key.clone()))) {
        return match op {
            "head" | "head_bucket" => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
            _ => error(StatusCode::INTERNAL_SERVER_ERROR, "InternalError"),
        };
    }
    match op {
        "head_bucket" => StatusCode::OK.into_response(),
        "list" => {
            if query(&uri, "list-type").as_deref() != Some("2") {
                return error(StatusCode::BAD_REQUEST, "InvalidArgument");
            }
            let prefix = query(&uri, "prefix").unwrap_or_default();
            let after = query(&uri, "continuation-token").unwrap_or_default();
            let page = match state.page_size {
                0 => 1000,
                n => n,
            };
            let keys: Vec<&String> = state
                .objects
                .keys()
                .filter(|k| k.starts_with(&prefix) && k.as_str() > after.as_str())
                .take(page + 1)
                .collect();
            let truncated = keys.len() > page;
            let mut xml = String::from(
                r#"<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">"#,
            );
            xml += &format!("<Name>{BUCKET}</Name><Prefix>{}</Prefix>", escape(&prefix));
            xml += &format!("<IsTruncated>{truncated}</IsTruncated>");
            for key in keys.iter().take(page) {
                xml += &format!("<Contents><Key>{}</Key></Contents>", escape(key));
            }
            if truncated {
                xml += &format!(
                    "<NextContinuationToken>{}</NextContinuationToken>",
                    escape(keys[page - 1])
                );
            }
            xml += "</ListBucketResult>";
            ([("content-type", "application/xml")], xml).into_response()
        }
        "put" => {
            if headers.contains_key("x-amz-tagging") {
                return error(StatusCode::NOT_IMPLEMENTED, "NotImplemented");
            }
            if !headers.contains_key("content-length") {
                return error(StatusCode::NOT_IMPLEMENTED, "NotImplemented");
            }
            let chunked = headers
                .get("x-amz-content-sha256")
                .and_then(|v| v.to_str().ok())
                .is_some_and(|v| v.starts_with("STREAMING-"));
            let data = if chunked {
                let Some(data) = decode_aws_chunked(&body) else {
                    return error(StatusCode::BAD_REQUEST, "IncompleteBody");
                };
                let declared = headers
                    .get("x-amz-decoded-content-length")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.parse::<usize>().ok());
                if declared != Some(data.len()) {
                    return error(StatusCode::BAD_REQUEST, "IncompleteBody");
                }
                data
            } else {
                body.to_vec()
            };
            let expires = headers
                .get("expires")
                .and_then(|v| v.to_str().ok())
                .map(str::to_owned);
            state.objects.insert(key, Object { data, expires });
            (StatusCode::OK, [("etag", "\"fake\"")]).into_response()
        }
        "get" | "head" => {
            let Some(object) = state.objects.get(&key) else {
                return match op {
                    "head" => StatusCode::NOT_FOUND.into_response(),
                    _ => error(StatusCode::NOT_FOUND, "NoSuchKey"),
                };
            };
            let mut response = if op == "get" && state.unsized_gets {
                let chunk: Result<Bytes, std::io::Error> = Ok(Bytes::from(object.data.clone()));
                axum::body::Body::from_stream(futures_util::stream::iter([chunk])).into_response()
            } else if op == "get" {
                object.data.clone().into_response()
            } else {
                let mut response = ().into_response();
                response
                    .headers_mut()
                    .insert("content-length", object.data.len().into());
                response
            };
            if let Some(expires) = &object.expires {
                response
                    .headers_mut()
                    .insert("expires", expires.parse().unwrap());
            }
            response
        }
        "delete" => {
            state.objects.remove(&key);
            StatusCode::NO_CONTENT.into_response()
        }
        _ => unreachable!(),
    }
}

fn percent_decode(text: &str) -> String {
    url::form_urlencoded::parse(format!("k={}", text.replace('+', "%2B")).as_bytes())
        .next()
        .map(|(_, v)| v.into_owned())
        .unwrap_or_default()
}
