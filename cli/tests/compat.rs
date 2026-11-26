//! Compatibility tests against the real server handler (tests/testserver), the website's
//! OpenPGP.js, and messages written by GnuPG and the former Go CLI (tests/fixtures).
//! The test server requires the Go toolchain.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

const RUST: &str = env!("CARGO_BIN_EXE_yopass");

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf()
}

fn scratch() -> PathBuf {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/compat");
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// A command with an empty environment, except the profile path that lets
/// `cargo llvm-cov` record coverage from the CLI runs.
fn clean_command(bin: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut command = Command::new(bin);
    command.env_clear();
    if let Some(profile) = std::env::var_os("LLVM_PROFILE_FILE") {
        command.env("LLVM_PROFILE_FILE", profile);
    }
    command
}

fn go_build(package: &str, name: &str) -> PathBuf {
    let out = scratch().join(name);
    let status = Command::new("go")
        .args(["build", "-o"])
        .arg(&out)
        .arg(package)
        .current_dir(repo_root())
        .status()
        .expect("the Go toolchain is required for compatibility tests");
    assert!(status.success(), "go build {package}");
    out
}

struct Server {
    child: Child,
    url: String,
}

impl Server {
    fn start(argon2: bool) -> Self {
        static BIN: OnceLock<PathBuf> = OnceLock::new();
        let bin = BIN.get_or_init(|| go_build("./cli/tests/testserver", "testserver"));
        let mut command = Command::new(bin);
        if argon2 {
            command.arg("--argon2");
        }
        let mut child = command.stdout(Stdio::piped()).spawn().unwrap();
        let mut address = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut address)
            .unwrap();
        Server {
            child,
            url: format!("http://{}", address.trim()),
        }
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Default)]
struct Run<'a> {
    args: Vec<String>,
    env: Vec<(&'a str, String)>,
    stdin: Vec<u8>,
    home: Option<PathBuf>,
    no_stdin_pipe: bool,
}

#[derive(Debug)]
struct Output {
    code: Option<i32>,
    stdout: Vec<u8>,
    stderr: String,
}

fn empty_home() -> PathBuf {
    let dir = scratch().join("empty-home");
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn run(spec: &Run) -> Output {
    let mut command = clean_command(RUST);
    command.args(&spec.args);
    command.env("HOME", spec.home.clone().unwrap_or_else(empty_home));
    for (key, value) in &spec.env {
        command.env(key, value);
    }
    if spec.no_stdin_pipe {
        command.stdin(Stdio::null());
    } else {
        command.stdin(Stdio::piped());
    }
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(&spec.stdin).ok();
    }
    let output = child.wait_with_output().unwrap();
    Output {
        code: output.status.code(),
        stdout: output.stdout,
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    }
}

/// Runs the CLI for a failure: exit code 1, nothing on stdout, and stderr starting with `lead`.
fn fails(spec: &Run, lead: &str, context: &str) -> Output {
    let output = run(spec);
    assert_eq!(output.code, Some(1), "{context}: {}", output.stderr);
    assert!(output.stdout.is_empty(), "{context}");
    assert!(
        output.stderr.starts_with(lead),
        "{context}: {}",
        output.stderr
    );
    output
}

/// Runs the CLI for a store that prints `link` and nothing else.
fn stores(spec: &Run, link: &str, context: &str) {
    let output = run(spec);
    assert_eq!(
        (output.code, output.stderr.as_str()),
        (Some(0), ""),
        "{context}"
    );
    assert_eq!(text(&output), link, "{context}");
}

/// Reaches the code past the server check without contacting anything.
fn unreachable_server() -> Vec<(&'static str, String)> {
    let url = "http://127.0.0.1:1".to_string();
    vec![("YOPASS_API", url.clone()), ("YOPASS_URL", url)]
}

fn args(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| value.to_string()).collect()
}

fn text(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout)
        .trim_end()
        .to_string()
}

// ---- Real server ----

fn share(server: &str, extra: &[&str], stdin: &[u8]) -> String {
    let mut all = args(&["--api", server, "--url", server]);
    all.extend(args(extra));
    let spec = Run {
        args: all,
        stdin: stdin.to_vec(),
        ..Default::default()
    };
    let output = run(&spec);
    assert_eq!(output.code, Some(0), "share failed: {}", output.stderr);
    text(&output)
}

fn fetch(server: &str, link: &str, extra: &[&str]) -> Output {
    let mut all = args(&["--api", server, "--url", server, "--decrypt", link]);
    all.extend(args(extra));
    run(&Run {
        args: all,
        ..Default::default()
    })
}

#[test]
fn text_round_trips() {
    let server = Server::start(false);
    for data in [
        &b"hello"[..],
        b"line\r\nline\n",
        b"\xff\xfe\x00 not utf-8",
        &vec![b'y'; 300_000],
    ] {
        let link = share(&server.url, &["--one-time=false"], data);
        assert!(link.starts_with(&format!("{}/#/s/", server.url)), "{link}");
        let output = fetch(&server.url, &link, &[]);
        assert_eq!(output.code, Some(0), "{}", output.stderr);
        assert_eq!(output.stdout, data);
    }
}

#[test]
fn files_round_trip() {
    let server = Server::start(false);
    let path = scratch().join("upload name.bin");
    let data: Vec<u8> = (0..=255u8).cycle().take(600_000).collect();
    std::fs::write(&path, &data).unwrap();
    let link = share(
        &server.url,
        &["--file", path.to_str().unwrap(), "--one-time=false"],
        b"",
    );
    assert!(link.starts_with(&format!("{}/#/f/", server.url)), "{link}");
    let output = fetch(&server.url, &link, &[]);
    assert_eq!(output.code, Some(0), "{}", output.stderr);
    assert_eq!(output.stdout, data);
}

#[test]
fn secrets_round_trip_with_an_argon2_server() {
    let server = Server::start(true);
    let link = share(&server.url, &[], b"argon2 secret");
    let output = fetch(&server.url, &link, &[]);
    assert_eq!(output.stdout, b"argon2 secret", "{}", output.stderr);
}

#[test]
fn manual_keys_stay_out_of_the_link() {
    let server = Server::start(false);
    let link = share(&server.url, &["--key", "manual-key"], b"manual");
    assert!(!link.contains("manual-key"), "{link}");
    assert_eq!(link.matches('/').count(), 5, "key must be absent: {link}");
    let missing = fetch(&server.url, &link, &[]);
    assert_eq!(
        missing.stderr.trim(),
        "Manual decryption key required, set --key"
    );
    let wrong = fetch(&server.url, &link, &["--key", "wrong"]);
    assert_eq!(wrong.code, Some(1));
    assert_eq!(
        wrong.stderr.trim(),
        "Failed to decrypt secret: could not decrypt: invalid decryption key"
    );
    // The wrong key consumed the one-time secret above.
    let link = share(
        &server.url,
        &["--key", "manual-key", "--one-time=false"],
        b"manual",
    );
    let output = fetch(&server.url, &link, &["--key", "manual-key"]);
    assert_eq!(output.stdout, b"manual");
}

#[test]
fn one_time_secrets_are_consumed() {
    let server = Server::start(false);
    let link = share(&server.url, &[], b"once");
    assert_eq!(fetch(&server.url, &link, &[]).stdout, b"once");
    let second = fetch(&server.url, &link, &[]);
    assert_eq!(second.code, Some(1));
    assert_eq!(
        second.stderr.trim(),
        "Failed to fetch secret: yopass server error: unexpected response 404 Not Found: Secret not found"
    );
}

#[test]
fn custom_expirations_are_left_to_the_server() {
    // The test server allows only the standard lifetimes, in any spelling.
    let server = Server::start(false);
    for (expiration, allowed) in [
        ("1h", true),
        ("1d", true),
        ("1w", true),
        ("60m", true),
        ("90d", false),
        ("1d12h", false),
    ] {
        let spec = Run {
            args: args(&[
                "--api",
                &server.url,
                "--url",
                &server.url,
                "--expiration",
                expiration,
            ]),
            stdin: b"x".to_vec(),
            ..Default::default()
        };
        if allowed {
            let output = run(&spec);
            assert_eq!(output.code, Some(0), "{expiration}: {}", output.stderr);
        } else {
            fails(
                &spec,
                "Failed to store secret: yopass server error: unexpected response 400 Bad Request: Invalid expiration specified",
                expiration,
            );
        }
    }
}

// ---- Mock server: captured requests and exact error output ----

#[derive(Debug, Clone)]
struct Request {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

type Handler = dyn Fn(&Request) -> (u16, Vec<(String, String)>, Vec<u8>) + Send + Sync;

struct Mock {
    url: String,
    requests: Arc<Mutex<Vec<Request>>>,
}

fn mock(
    handler: impl Fn(&Request) -> (u16, Vec<(String, String)>, Vec<u8>) + Send + Sync + 'static,
) -> Mock {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let requests = Arc::new(Mutex::new(Vec::new()));
    let seen = requests.clone();
    let handler: Arc<Handler> = Arc::new(handler);
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let mut stream = stream.unwrap();
            let seen = seen.clone();
            let handler = handler.clone();
            std::thread::spawn(move || {
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                if reader.read_line(&mut line).is_err() || line.is_empty() {
                    return;
                }
                let mut parts = line.split_whitespace();
                let (method, path) = (
                    parts.next().unwrap().to_string(),
                    parts.next().unwrap().to_string(),
                );
                let mut headers = HashMap::new();
                loop {
                    let mut header = String::new();
                    reader.read_line(&mut header).unwrap();
                    if header.trim().is_empty() {
                        break;
                    }
                    let (key, value) = header.split_once(':').unwrap();
                    headers.insert(key.to_lowercase(), value.trim().to_string());
                }
                let length = headers
                    .get("content-length")
                    .map_or(0, |value| value.parse().unwrap());
                let mut body = vec![0; length];
                reader.read_exact(&mut body).unwrap();
                let request = Request {
                    method,
                    path,
                    headers,
                    body,
                };
                seen.lock().unwrap().push(request.clone());
                let (status, extra, response) = handler(&request);
                let mut head = format!(
                    "HTTP/1.1 {status} {}\r\nContent-Length: {}\r\nConnection: close\r\n",
                    reason(status),
                    response.len()
                );
                for (key, value) in extra {
                    head.push_str(&format!("{key}: {value}\r\n"));
                }
                head.push_str("\r\n");
                stream.write_all(head.as_bytes()).ok();
                stream.write_all(&response).ok();
            });
        }
    });
    Mock { url, requests }
}

/// The Go server sends standard reason phrases, which the Rust client assumes.
fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        204 => "No Content",
        301 => "Moved Permanently",
        302 => "Found",
        303 => "See Other",
        307 => "Temporary Redirect",
        308 => "Permanent Redirect",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        500 => "Internal Server Error",
        503 => "Service Unavailable",
        _ => panic!("add a reason for {status}"),
    }
}

fn replies(status: u16, body: &str) -> Mock {
    let body = body.as_bytes().to_vec();
    mock(move |_| (status, Vec::new(), body.clone()))
}

fn take_requests(mock: &Mock) -> Vec<Request> {
    std::mem::take(&mut *mock.requests.lock().unwrap())
}

/// Takes the requests seen so far and returns the bodies of the secrets stored.
fn take_stored_secrets(mock: &Mock) -> Vec<serde_json::Value> {
    take_requests(mock)
        .iter()
        .filter(|request| request.path == "/create/secret")
        .map(|request| serde_json::from_slice(&request.body).unwrap())
        .collect()
}

#[test]
fn flags_are_accepted() {
    let mock = replies(200, r#"{"message":"fixed-id"}"#);
    let u = mock.url.as_str();
    for (key, values) in [
        ("k", &["--api", u, "--url", u, "--key", "k"][..]),
        ("k", &["--api=", "--api", u, "--url", u, "--key", "k"]),
        ("k", &["--api", u, "--url", u, "--key=first", "--key=k"]),
        ("-dash", &["--api", u, "--url", u, "--key", "-dash"]),
        ("--dash", &["--api", u, "--url", u, "--key", "--dash"]),
        ("k", &["--api", u, "--url", u, "--key=k", "--one-time"]),
        (
            "k",
            &["--api", u, "--url", u, "--key=k", "--one-time=false"],
        ),
        (
            "k",
            &["--api", u, "--url", u, "--key=k", "--expiration", "1d"],
        ),
    ] {
        let spec = Run {
            args: args(values),
            stdin: b"x".to_vec(),
            ..Default::default()
        };
        stores(&spec, &format!("{u}/#/s/fixed-id"), &format!("{values:?}"));
        let stored: Vec<_> = take_requests(&mock)
            .into_iter()
            .filter(|request| request.path == "/create/secret")
            .collect();
        assert_eq!(stored.len(), 1, "{values:?}");
        for request in stored {
            let body: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
            let reply = serde_json::json!({ "message": body["message"] }).to_string();
            let holder = replies(200, &reply);
            let link = format!("{}/#/c/id", holder.url);
            let read = Run {
                args: vec![
                    format!("--api={}", holder.url),
                    format!("--url={}", holder.url),
                    format!("--decrypt={link}"),
                    format!("--key={key}"),
                ],
                ..Default::default()
            };
            let output = run(&read);
            assert_eq!(output.stdout, b"x", "{values:?}: {}", output.stderr);
        }
    }
}

#[test]
fn flag_errors_fail_without_doing_anything() {
    for values in [
        &["--unknown"][..],
        &["-x"],
        &["--api"],
        &["--key"],
        &["--one-time=maybe"],
        &["--one-time="],
        &["positional"],
    ] {
        let mock = replies(200, r#"{"message":"id"}"#);
        let mut all = args(&["--api", &mock.url, "--url", &mock.url]);
        all.extend(args(values));
        let spec = Run {
            args: all,
            stdin: b"x".to_vec(),
            ..Default::default()
        };
        let output = run(&spec);
        assert_eq!(output.code, Some(2), "{values:?}");
        assert!(output.stdout.is_empty(), "{values:?}");
        assert!(take_requests(&mock).is_empty(), "{values:?}");
    }
    for help in ["-h", "--help"] {
        let spec = Run {
            args: args(&[help]),
            ..Default::default()
        };
        let output = run(&spec);
        assert_eq!(output.code, Some(0));
        assert!(text(&output).contains("--one-time"));
    }
}

#[test]
fn empty_key_generates_a_usable_link() {
    // Dropping the generated key from the link would leave the secret undecryptable.
    let server = Server::start(false);
    let spec = Run {
        args: args(&["--api", &server.url, "--url", &server.url, "--key="]),
        stdin: b"x".to_vec(),
        ..Default::default()
    };
    let link = text(&run(&spec));
    assert_eq!(link.matches('/').count(), 6, "{link}");
    assert_eq!(fetch(&server.url, &link, &[]).stdout, b"x", "{link}");
}

#[cfg(unix)]
#[test]
fn non_utf8_arguments_survive() {
    use std::ffi::OsStr;
    use std::os::unix::ffi::OsStrExt;
    let server = Server::start(false);
    let dir = scratch().join("non-utf8");
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join(OsStr::from_bytes(b"caf\xe9.txt"));
    if std::fs::write(&path, b"latin1 name").is_err() {
        return; // APFS refuses invalid UTF-8 names.
    }
    let output = clean_command(RUST)
        .env("HOME", empty_home())
        .args([
            "--api",
            &server.url,
            "--url",
            &server.url,
            "--one-time=false",
            "--key",
        ])
        .arg(OsStr::from_bytes(b"k\xff"))
        .arg("--file")
        .arg(&path)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let link = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let got = clean_command(RUST)
        .env("HOME", empty_home())
        .args([
            "--api",
            &server.url,
            "--url",
            &server.url,
            "--decrypt",
            &link,
            "--key",
        ])
        .arg(OsStr::from_bytes(b"k\xff"))
        .output()
        .unwrap();
    assert_eq!(got.stdout, b"latin1 name");
}

#[cfg(unix)]
#[test]
fn non_utf8_keys_round_trip() {
    use std::ffi::OsStr;
    use std::io::Write as _;
    use std::os::unix::ffi::OsStrExt;
    let server = Server::start(false);
    let mut child = clean_command(RUST)
        .env("HOME", empty_home())
        .args([
            "--api",
            &server.url,
            "--url",
            &server.url,
            "--one-time=false",
            "--key",
        ])
        .arg(OsStr::from_bytes(b"k\xff"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(b"bytes key").unwrap();
    let output = child.wait_with_output().unwrap();
    let link = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let got = clean_command(RUST)
        .env("HOME", empty_home())
        .args([
            "--api",
            &server.url,
            "--url",
            &server.url,
            "--decrypt",
            &link,
            "--key",
        ])
        .arg(OsStr::from_bytes(b"k\xff"))
        .output()
        .unwrap();
    assert_eq!(got.stdout, b"bytes key");
}

#[cfg(unix)]
#[test]
fn non_utf8_home_is_still_used() {
    use std::ffi::OsStr;
    use std::os::unix::ffi::OsStrExt;
    let mut home = scratch().as_os_str().as_bytes().to_vec();
    home.extend(b"/h\xf6me");
    let home = PathBuf::from(OsStr::from_bytes(&home));
    if std::fs::create_dir_all(home.join(".config/yopass")).is_err() {
        return; // APFS refuses invalid UTF-8 names.
    }
    std::fs::write(
        home.join(".config/yopass/config.yaml"),
        "api: https://from-config.example\nurl: https://from-config.example\n",
    )
    .unwrap();
    let output = clean_command(RUST)
        .env("HOME", &home)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    // Past the server check, so the config was read.
    assert!(String::from_utf8_lossy(&output.stderr).starts_with("No filename"));
}

#[test]
fn no_input_is_an_error() {
    let spec = Run {
        no_stdin_pipe: true,
        env: unreachable_server(),
        ..Default::default()
    };
    let output = fails(&spec, "", "/dev/null stdin");
    assert_eq!(
        output.stderr.trim(),
        "No filename or piped input to encrypt given"
    );
    for (file, lead) in [
        (
            "/does/not/exist",
            "Failed to open file: open /does/not/exist: ",
        ),
        ("", "Failed to open file: open : "),
    ] {
        let spec = Run {
            args: vec![format!("--file={file}")],
            env: unreachable_server(),
            ..Default::default()
        };
        fails(&spec, lead, file);
    }
}

#[test]
fn reading_a_directory_fails() {
    let mock = replies(200, r#"{"message":"id"}"#);
    let dir = scratch();
    let spec = Run {
        args: args(&[
            "--api",
            &mock.url,
            "--url",
            &mock.url,
            "--key",
            "k",
            "--file",
            dir.to_str().unwrap(),
        ]),
        ..Default::default()
    };
    fails(
        &spec,
        "Failed to encrypt file: could not copy data: read ",
        "directory",
    );
}

#[test]
fn expirations_are_validated() {
    let mock = replies(200, r#"{"message":"fixed-id"}"#);
    // The lifetime in seconds that the server is asked for, or None when the CLI refuses.
    for (expiration, seconds) in [
        ("1h", Some(3600)),
        ("1d", Some(86_400)),
        ("1w", Some(604_800)),
        ("90d", Some(7_776_000)),
        ("1d12h", Some(129_600)),
        ("30s", Some(30)),
        ("5m", Some(300)),
        ("0h", None),
        ("0", None),
        ("", None),
        ("123", None),
        ("abc", None),
        ("h", None),
        ("-1h", None),
        ("+1h", None),
        ("1.5h", None),
        ("1h ", None),
        (" 1h", None),
        ("1H", None),
        ("1y", None),
        ("2147483647s", Some(2_147_483_647)),
        ("2147483648s", None),
        ("3550w", Some(2_147_040_000)),
        ("3551w", None),
        ("99999999999999999999h", None),
        ("1h1", None),
        ("1h2", None),
    ] {
        let spec = Run {
            args: args(&[
                "--api",
                &mock.url,
                "--url",
                &mock.url,
                "--key",
                "k",
                &format!("--expiration={expiration}"),
            ]),
            stdin: b"x".to_vec(),
            ..Default::default()
        };
        let Some(seconds) = seconds else {
            let output = fails(&spec, "", expiration);
            assert_eq!(
                output.stderr.trim(),
                "Expiration must be a positive integer duration using s, m, h, d, or w (e.g. 1h or 90d)",
                "{expiration}"
            );
            assert!(take_requests(&mock).is_empty(), "{expiration}");
            continue;
        };
        stores(&spec, &format!("{}/#/s/fixed-id", mock.url), expiration);
        let stored = take_stored_secrets(&mock);
        assert_eq!(stored.len(), 1, "{expiration}");
        assert_eq!(stored[0]["expiration"], seconds, "{expiration}");
    }
}

#[test]
fn one_time_values_are_read_from_every_source() {
    let mock = replies(200, r#"{"message":"fixed-id"}"#);
    let base = args(&["--api", &mock.url, "--url", &mock.url, "--key", "k"]);
    let home = scratch().join("one-time-home");
    let _ = std::fs::remove_dir_all(&home);
    let config_dir = home.join(".config/yopass");
    std::fs::create_dir_all(&config_dir).unwrap();
    // `expected` is the setting the secret is stored with, or None when the CLI refuses it.
    let check = |spec: Run, context: String, expected: Option<bool>| {
        let Some(one_time) = expected else {
            let output = fails(&spec, "", &context);
            assert_eq!(
                output.stderr.trim(),
                "invalid --one-time: expected true or false",
                "{context}"
            );
            assert!(take_requests(&mock).is_empty(), "{context}");
            return;
        };
        stores(&spec, &format!("{}/#/s/fixed-id", mock.url), &context);
        let stored = take_stored_secrets(&mock);
        assert_eq!(stored.len(), 1, "{context}");
        // The request leaves the field out for false.
        assert_eq!(
            stored[0]["one_time"].as_bool().unwrap_or(false),
            one_time,
            "{context}"
        );
    };
    for (value, expected) in [
        ("true", true),
        ("false", false),
        ("1", true),
        ("0", false),
        ("t", true),
        ("f", false),
        ("T", true),
        ("F", false),
        ("TRUE", true),
        ("FALSE", false),
        ("True", true),
        ("False", false),
    ] {
        let mut flag = base.clone();
        flag.push(format!("--one-time={value}"));
        check(
            Run {
                args: flag,
                stdin: b"x".to_vec(),
                ..Default::default()
            },
            format!("flag {value}"),
            Some(expected),
        );
    }
    let mut bare = base.clone();
    bare.push("--one-time".to_string());
    check(
        Run {
            args: bare,
            stdin: b"x".to_vec(),
            ..Default::default()
        },
        "bare".to_string(),
        Some(true),
    );
    for (value, expected) in [
        ("true", Some(true)),
        ("false", Some(false)),
        ("1", Some(true)),
        ("0", Some(false)),
        ("T", Some(true)),
        ("yes", None),
        ("on", None),
        ("typo", None),
        ("true ", None),
        ("2", None),
    ] {
        check(
            Run {
                args: base.clone(),
                env: vec![("YOPASS_ONE_TIME", value.to_string())],
                stdin: b"x".to_vec(),
                ..Default::default()
            },
            format!("env {value}"),
            expected,
        );
    }
    for (yaml, expected) in [
        ("true", Some(true)),
        ("false", Some(false)),
        ("yes", None),
        ("no", None),
        ("on", None),
        ("\"true\"", Some(true)),
        ("\"typo\"", None),
        ("1", Some(true)),
        ("0", Some(false)),
        ("2", None),
        ("1.5", None),
        ("~", Some(true)),
    ] {
        std::fs::write(
            config_dir.join("config.yaml"),
            format!("one-time: {yaml}\n"),
        )
        .unwrap();
        check(
            Run {
                args: base.clone(),
                home: Some(home.clone()),
                stdin: b"x".to_vec(),
                ..Default::default()
            },
            format!("yaml {yaml}"),
            expected,
        );
    }
}

static CONFIG_DIRS: AtomicUsize = AtomicUsize::new(0);

fn config_home(file: &str, contents: &str) -> PathBuf {
    let home = scratch().join(format!(
        "config-{}",
        CONFIG_DIRS.fetch_add(1, Ordering::SeqCst)
    ));
    let dir = home.join(".config/yopass");
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(file), contents).unwrap();
    home
}

#[test]
fn config_files_are_read() {
    let mock = replies(200, r#"{"message":"fixed-id"}"#);
    let u = &mock.url;
    for (contents, expiration, one_time) in [
        (format!("api: {u}\nurl: {u}\n"), 3600, true),
        (
            format!("api: {u}\nurl: {u}\nexpiration: 1d\n"),
            86_400,
            true,
        ),
        (
            format!("api: {u}\nurl: {u}\none-time: false\nexpiration: ~\n"),
            3600,
            false,
        ),
    ] {
        let spec = Run {
            args: args(&["--key=k"]),
            home: Some(config_home("config.yaml", &contents)),
            stdin: b"x".to_vec(),
            ..Default::default()
        };
        stores(&spec, &format!("{u}/#/s/fixed-id"), &contents);
        let stored = take_stored_secrets(&mock);
        assert_eq!(stored.len(), 1, "{contents}");
        assert_eq!(stored[0]["expiration"], expiration, "{contents}");
        assert_eq!(
            stored[0]["one_time"].as_bool().unwrap_or(false),
            one_time,
            "{contents}"
        );
    }
}

#[test]
fn broken_or_unsupported_configs_exit_3() {
    // Parser wording differs between libraries; the code and prefix do not.
    for (file, contents) in [("config.yaml", "- a"), ("config.yaml", "a: b: c")] {
        let spec = Run {
            home: Some(config_home(file, contents)),
            stdin: b"x".to_vec(),
            ..Default::default()
        };
        let output = run(&spec);
        assert_eq!(output.code, Some(3), "{file} {contents}");
        assert!(
            output.stderr.starts_with("Yopass config file invalid: "),
            "{}",
            output.stderr
        );
    }
}

#[test]
fn api_and_url_have_no_built_in_default() {
    let mock = replies(200, r#"{"message":"fixed-id"}"#);
    let u = mock.url.clone();
    let (api, url) = (format!("--api={u}"), format!("--url={u}"));
    let link = format!("--decrypt={u}/#/s/id/key");
    let incomplete_config = config_home("config.yaml", &format!("api: {u}\n"));
    let missing: [(Vec<String>, Option<PathBuf>); 7] = [
        (vec![], None),
        (vec![api.clone()], None),
        (vec![url.clone()], None),
        (vec![api.clone(), "--url=".into()], None),
        (vec!["--api=".into(), url.clone()], None),
        (vec![link.clone()], None),
        (vec![], Some(incomplete_config.clone())),
    ];
    for (args, home) in missing {
        let spec = Run {
            args: args.clone(),
            home,
            stdin: b"x".to_vec(),
            ..Default::default()
        };
        let output = run(&spec);
        assert_eq!(output.code, Some(1), "{args:?}");
        assert_eq!(output.stdout, b"", "{args:?}");
        assert!(output.stderr.contains("set --api and --url"), "{args:?}");
        assert!(take_requests(&mock).is_empty(), "{args:?}");
    }
    let configs = [
        (vec![api, url.clone()], None),
        (
            vec![],
            Some(config_home("config.yaml", &format!("api: {u}\nurl: {u}\n"))),
        ),
        (vec![url], Some(incomplete_config)),
    ];
    for (args, home) in configs {
        let spec = Run {
            args: args.clone(),
            home,
            stdin: b"x".to_vec(),
            ..Default::default()
        };
        let output = run(&spec);
        assert_eq!(output.code, Some(0), "{args:?}: {}", output.stderr);
        assert!(!take_requests(&mock).is_empty(), "{args:?}");
    }
    let help = run(&Run {
        args: args(&["-h"]),
        ..Default::default()
    });
    assert!(!text(&help).contains("yopass.se"), "{}", text(&help));
}

#[test]
fn missing_home_does_not_read_config_from_the_current_directory() {
    let cwd = config_home(
        "config.yaml",
        "api: https://planted.example\nurl: https://planted.example\n",
    );
    for home in [None, Some("")] {
        let mut command = clean_command(RUST);
        command.stdin(Stdio::null()).current_dir(&cwd);
        if let Some(home) = home {
            command.env("HOME", home);
        }
        let output = command.output().unwrap();
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(stderr.starts_with("No yopass server"), "{home:?}: {stderr}");
    }
}

#[test]
fn precedence_is_flag_env_config_default() {
    let (flag, env, config) = (
        replies(200, r#"{"message":"flag"}"#),
        replies(200, r#"{"message":"env"}"#),
        replies(200, r#"{"message":"config"}"#),
    );
    let home = config_home(
        "config.yaml",
        &format!("api: {}\nurl: https://config.example\n", config.url),
    );
    let run_with = |mut args_: Vec<String>, env_: Vec<(&'static str, String)>| {
        args_.push("--key=k".to_string());
        let spec = Run {
            args: args_,
            env: env_,
            home: Some(home.clone()),
            stdin: b"x".to_vec(),
            ..Default::default()
        };
        text(&run(&spec))
    };
    assert_eq!(
        run_with(vec![], vec![]),
        "https://config.example/#/s/config"
    );
    let env_var = vec![("YOPASS_API", env.url.clone())];
    assert_eq!(
        run_with(vec![], env_var.clone()),
        "https://config.example/#/s/env"
    );
    assert_eq!(
        run_with(args(&["--api", &flag.url]), env_var),
        "https://config.example/#/s/flag"
    );
    // An empty environment variable counts as unset.
    assert_eq!(
        run_with(vec![], vec![("YOPASS_API", String::new())]),
        "https://config.example/#/s/config"
    );
    assert_eq!(
        run_with(
            args(&["--url", "https://f.example/"]),
            vec![("YOPASS_URL", "https://e.example".to_string())]
        ),
        "https://f.example/#/s/config"
    );
    assert_eq!(
        run_with(
            vec![],
            vec![("YOPASS_URL", "https://e.example/".to_string())]
        ),
        "https://e.example/#/s/config"
    );
}

// How far a `--decrypt` link gets, as the start of stderr.
const FETCH_SECRET: &str = "Failed to fetch secret: ";
const FETCH_FILE: &str = "Failed to fetch file: ";
const BAD_FORMAT: &str = "Invalid yopass decrypt URL: unexpected link format";
const OTHER_SERVER: &str = "Unconfigured yopass decrypt URL, set --api and --url";

#[test]
fn decrypt_urls_are_judged() {
    let mock = mock(|_| {
        (
            404,
            Vec::new(),
            br#"{"message":"Secret not found"}"#.to_vec(),
        )
    });
    let host = mock.url.trim_start_matches("http://").to_string();
    let base = mock.url.clone();
    let mut links: Vec<(String, &str)> = [
        "",
        " ",
        "*",
        ":",
        "#",
        "/",
        "//",
        "///",
        "https://yopass.se",
        "not a url",
        "mailto:a@b",
        "https://yopass.se/#/s/id/key",
        "ftp://x/#/s/a/b",
        "1http://x/#/s/a/b",
    ]
    .iter()
    .map(|s| (s.to_string(), OTHER_SERVER))
    .collect();
    for (suffix, expected) in [
        ("/#/s/id/key", FETCH_SECRET),
        ("/#/c/id", FETCH_SECRET),
        ("/#/f/id/key", FETCH_FILE),
        ("/#/d/id", FETCH_FILE),
        ("/#/s/id", FETCH_SECRET),
        ("/#/f/id", FETCH_FILE),
        ("#/s/id/key", FETCH_SECRET),
        ("/#/x/id/key", BAD_FORMAT),
        ("/#/s", BAD_FORMAT),
        ("/#/", BAD_FORMAT),
        ("/#", BAD_FORMAT),
        ("/", BAD_FORMAT),
        ("", BAD_FORMAT),
        ("/#s/id/key", BAD_FORMAT),
        ("/#/s/id/key/extra", BAD_FORMAT),
        ("/#/s/id/key/", BAD_FORMAT),
        ("/#//id/key", BAD_FORMAT),
        ("/#/s/%2F/key", BAD_FORMAT),
        ("/#/s/a%20b/key", FETCH_SECRET),
        ("/#/s/id/k%2Fy", BAD_FORMAT),
        ("/?q=1#/s/id/key", FETCH_SECRET),
        ("/?#/s/id/key", FETCH_SECRET),
        ("//#/s/id/key", FETCH_SECRET),
        ("///#/s/id/key", FETCH_SECRET),
        ("/x/#/s/id/key", OTHER_SERVER),
        ("/%78/#/s/id/key", OTHER_SERVER),
        ("/#/s/é/key", FETCH_SECRET),
        ("/#/s/a b/key", FETCH_SECRET),
        ("/#/s/a\"b/key", FETCH_SECRET),
        ("/#/s/a?b/key", FETCH_SECRET),
        ("/#/s/a\\b/key", FETCH_SECRET),
        ("/#/s/a<b>/key", FETCH_SECRET),
        ("/#/s/a#b/key", FETCH_SECRET),
        ("/#/s/..%2F..%2Fadmin/key", BAD_FORMAT),
        ("/#/s/%00/key", FETCH_SECRET),
        ("/\n", BAD_FORMAT),
    ] {
        // Whitespace around a pasted link does not change the verdict.
        links.push((format!("{base}{suffix}"), expected));
        links.push((format!(" {base}{suffix}\n"), expected));
    }
    links.push((format!("HTTP://{host}/#/s/id/key"), FETCH_SECRET));
    for variant in [
        format!("http://user@{host}/#/s/id/key"),
        format!("http://user:pw@{host}/#/s/id/key"),
        format!("https://{host}/#/s/id/key"),
        format!("http://{host}.evil.example/#/s/id/key"),
        format!("http://evil.example/{host}/#/s/id/key"),
        format!("http://evil.example\\@{host}/#/s/id/key"),
        format!("http://{host}:99/#/s/id/key"),
        format!("//{host}/#/s/id/key"),
        format!("{host}/#/s/id/key"),
    ] {
        links.push((variant, OTHER_SERVER));
    }
    for (link, expected) in &links {
        let spec = Run {
            args: vec![
                "--api".into(),
                base.clone(),
                "--url".into(),
                base.clone(),
                format!("--decrypt={link}"),
                "--key=k".into(),
            ],
            ..Default::default()
        };
        fails(&spec, expected, link);
    }
    // --url decides which links belong to this server. One that does is then refused for
    // its format, as /#/q names no secret.
    const ROOT: &str = "https://yopass.se/#/q";
    const UPPER: &str = "https://YOPASS.se/#/q";
    const APP: &str = "https://yopass.se/app/#/q";
    const IPV6: &str = "https://[::1]/#/q";
    const UPPER_APP: &str = "HTTPS://yopass.se/APP/#/q";
    for (configured, own) in [
        ("https://yopass.se", &[ROOT, UPPER][..]),
        ("https://yopass.se/", &[ROOT, UPPER]),
        ("https://YOPASS.SE", &[ROOT, UPPER]),
        ("https://yopass.se/app", &[APP]),
        ("https://yopass.se/app/", &[APP]),
        ("yopass.se", &[]),
        ("https://", &[]),
        ("not a url", &[]),
        ("https://u@yopass.se", &[ROOT, UPPER]),
        ("https://[::1]", &[IPV6]),
        ("https://[::1", &[]),
        ("HTTPS://yopass.se", &[ROOT, UPPER]),
        ("https://yopass.se/%zz", &[]),
        (":", &[]),
    ] {
        for link in [ROOT, APP, UPPER, IPV6, UPPER_APP] {
            let spec = Run {
                args: vec![
                    "--decrypt".into(),
                    link.into(),
                    format!("--url={configured}"),
                    format!("--api={base}"),
                    "--key=k".into(),
                ],
                ..Default::default()
            };
            let expected = if own.contains(&link) {
                BAD_FORMAT
            } else {
                OTHER_SERVER
            };
            fails(&spec, expected, &format!("{configured} {link}"));
        }
    }
}

#[test]
fn secret_ids_stay_one_path_segment() {
    let mock = mock(|_| (404, Vec::new(), br#"{"message":"nope"}"#.to_vec()));
    for (id, path) in [
        ("simple", "/secret/simple"),
        ("a%20b", "/secret/a%20b"),
        ("a%22b", "/secret/a%22b"),
        ("a%3Cb", "/secret/a%3Cb"),
        ("a%5Eb", "/secret/a%5Eb"),
        ("%C3%A9", "/secret/%C3%A9"),
        ("é", "/secret/%C3%A9"),
        ("%FF", "/secret/%FF"),
        ("a?b=c", "/secret/a%3Fb=c"),
        ("a%3Fb", "/secret/a%3Fb"),
        ("a%23b", "/secret/a%23b"),
        ("a%2520", "/secret/a%2520"),
    ] {
        let link = format!("{}/#/s/{id}/key", mock.url);
        let spec = Run {
            args: args(&["--api", &mock.url, "--url", &mock.url, "--decrypt", &link]),
            ..Default::default()
        };
        fails(&spec, FETCH_SECRET, id);
        let requests = take_requests(&mock);
        assert_eq!(requests.len(), 1, "{id}");
        assert_eq!(requests[0].path, path, "{id}");
    }
    for id in ["", "..", ".", "%2E%2E", "..%2Fadmin", "a%2Fb"] {
        let link = format!("{}/#/s/{id}/key", mock.url);
        let spec = Run {
            args: args(&["--api", &mock.url, "--url", &mock.url, "--decrypt", &link]),
            ..Default::default()
        };
        assert_eq!(run(&spec).code, Some(1), "{id}");
        assert!(take_requests(&mock).is_empty(), "{id}");
    }
}

#[test]
fn requests_on_the_wire() {
    let mock = mock(|request| {
        let body = if request.path == "/config" {
            br#"{"ARGON2":false}"#.to_vec()
        } else {
            br#"{"message":"fixed-id"}"#.to_vec()
        };
        (200, Vec::new(), body)
    });
    let file = scratch().join("wire.txt");
    std::fs::write(&file, "wire").unwrap();
    let path = file.to_str().unwrap();
    let store_secret = [("GET", "/config"), ("POST", "/create/secret")];
    let store_file = [("GET", "/config"), ("POST", "/create/file")];
    // Extra arguments, stdin, whether the token is sent, the requests made, and the
    // lifetime and one-time setting a store asks for.
    type Case<'a> = (
        Vec<&'a str>,
        &'a [u8],
        bool,
        &'a [(&'a str, &'a str)],
        u32,
        bool,
    );
    let cases: [Case; 9] = [
        (vec![], b"x", false, &store_secret, 3600, true),
        (
            vec!["--api-token", "secret-token"],
            b"x",
            true,
            &store_secret,
            3600,
            true,
        ),
        (
            vec!["--api-token", "Bearer secret-token"],
            b"x",
            true,
            &store_secret,
            3600,
            true,
        ),
        (
            vec!["--api-token", " bearer  secret-token \n"],
            b"x",
            true,
            &store_secret,
            3600,
            true,
        ),
        (
            vec!["--one-time=false", "--expiration", "1d"],
            b"x",
            false,
            &store_secret,
            86_400,
            false,
        ),
        (vec!["--file", path], b"", false, &store_file, 3600, true),
        (
            vec![
                "--file",
                path,
                "--api-token",
                "secret-token",
                "--one-time=false",
                "--expiration=1w",
            ],
            b"",
            true,
            &store_file,
            604_800,
            false,
        ),
        (
            vec!["--decrypt", "@URL/#/s/fixed-id/key"],
            b"",
            false,
            &[("GET", "/secret/fixed-id")],
            0,
            false,
        ),
        (
            vec![
                "--decrypt",
                "@URL/#/f/fixed-id/key",
                "--api-token",
                "secret-token",
            ],
            b"",
            true,
            &[("GET", "/file/fixed-id")],
            0,
            false,
        ),
    ];
    for (extra, stdin, token, expected, lifetime, one_time) in cases {
        let extra: Vec<String> = extra
            .iter()
            .map(|value| value.replace("@URL", &mock.url))
            .collect();
        let mut spec_args = args(&["--api", &mock.url, "--url", &mock.url, "--key", "k"]);
        spec_args.extend(extra.clone());
        run(&Run {
            args: spec_args,
            stdin: stdin.to_vec(),
            ..Default::default()
        });
        let requests = take_requests(&mock);
        let made: Vec<_> = requests
            .iter()
            .map(|request| (request.method.as_str(), request.path.as_str()))
            .collect();
        assert_eq!(made, expected, "{extra:?}");
        for request in requests {
            let header = |name: &str| request.headers.get(name).map(String::as_str);
            assert_eq!(
                header("authorization"),
                token.then_some("Bearer secret-token"),
                "{extra:?}"
            );
            if request.path == "/create/secret" {
                assert_eq!(header("content-type"), Some("application/json"));
                let mut body: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
                let message = body["message"].take();
                assert!(message
                    .as_str()
                    .unwrap()
                    .starts_with("-----BEGIN PGP MESSAGE-----\nComment: https://yopass.se\n\n"));
                // The field is left out for false.
                let mut want = serde_json::json!({ "message": null, "expiration": lifetime });
                if one_time {
                    want["one_time"] = true.into();
                }
                assert_eq!(body, want, "{extra:?}");
            }
            if request.path == "/create/file" {
                assert_eq!(header("content-type"), Some("application/octet-stream"));
                assert_eq!(
                    header("x-yopass-expiration"),
                    Some(lifetime.to_string().as_str()),
                    "{extra:?}"
                );
                assert_eq!(
                    header("x-yopass-onetime"),
                    Some(one_time.to_string().as_str()),
                    "{extra:?}"
                );
            }
            if request.path.starts_with("/file") {
                assert_eq!(header("accept"), Some("application/octet-stream"));
            }
        }
    }
}

#[test]
fn config_endpoint_answers_select_the_key_derivation() {
    let key_derivation = |body: &[u8]| {
        let message = serde_json::from_slice::<serde_json::Value>(body).unwrap()["message"]
            .as_str()
            .unwrap()
            .to_string();
        let encoded: String = message
            .lines()
            .skip(3)
            .take_while(|line| !line.starts_with('='))
            .collect();
        encoded[..12].to_string()
    };
    for (status, config, argon2) in [
        (200, r#"{"ARGON2":true}"#, true),
        (200, r#"{"ARGON2":false}"#, false),
        (200, r#"{"OTHER":1}"#, false),
        (200, r#"{"ARGON2":"true"}"#, false),
        (200, r#"{"ARGON2":null}"#, false),
        (200, "null", false),
        (200, "[]", false),
        (200, "not json", false),
        (200, "", false),
        (404, r#"{"ARGON2":true}"#, false),
        (500, "boom", false),
    ] {
        let config_body = config.as_bytes().to_vec();
        let mock = mock(move |request| {
            if request.path == "/config" {
                (status, Vec::new(), config_body.clone())
            } else {
                (200, Vec::new(), br#"{"message":"id"}"#.to_vec())
            }
        });
        let spec = Run {
            args: args(&["--api", &mock.url, "--url", &mock.url, "--key", "k"]),
            stdin: b"x".to_vec(),
            ..Default::default()
        };
        stores(&spec, &format!("{}/#/s/id", mock.url), config);
        let stored: Vec<String> = take_requests(&mock)
            .iter()
            .filter(|r| r.path == "/create/secret")
            .map(|r| key_derivation(&r.body))
            .collect();
        assert_eq!(stored.len(), 1, "{config}");
        // SKESK starts c3 len 06 cnt 09 03 slen type. Base64 position 8 begins at the
        // S2K length and type: 0b 03 (iterated) is Cw, 14 04 (Argon2) is FA.
        let want = if argon2 { "FA" } else { "Cw" };
        for prefix in stored {
            assert_eq!(&prefix[8..10], want, "{config}: {prefix}");
        }
    }
}

#[test]
fn server_responses_are_reported() {
    // Status, body, and the message shown in place of the body when it is a JSON error.
    let bodies = [
        (
            404,
            r#"{"message":"Secret not found"}"#,
            Some("Secret not found"),
        ),
        (400, r#"{"message":"bad"}"#, Some("bad")),
        (401, r#"{"message":"Unauthorized"}"#, Some("Unauthorized")),
        (403, "plain forbidden", None),
        (500, "", None),
        (500, "<html>oops</html>", None),
        (500, "[1,2]", None),
        (500, "null", None),
        (500, r#"{"message":1}"#, None),
        (500, r#"{"other":"x"}"#, None),
        (500, r#"{"message":"x"} trailing"#, None),
        (503, "\"text\"", None),
        (201, r#"{"message":"created"}"#, Some("created")),
        (204, "", None),
        (200, r#"{"message":"id"}"#, None),
        (200, r#"{"message":null}"#, None),
        (200, r#"{}"#, None),
        (200, "null", None),
    ];
    let file = scratch().join("responses.txt");
    std::fs::write(&file, "x").unwrap();
    for (status, body, message) in bodies {
        let mock = replies(status, body);
        let base = args(&["--api", &mock.url, "--url", &mock.url, "--key", "k"]);
        for (verb, kind, extra) in [
            ("store", "secret", vec![]),
            (
                "store",
                "file",
                vec!["--file".to_string(), file.to_str().unwrap().to_string()],
            ),
            (
                "fetch",
                "secret",
                vec!["--decrypt".to_string(), format!("{}/#/s/id/key", mock.url)],
            ),
            (
                "fetch",
                "file",
                vec!["--decrypt".to_string(), format!("{}/#/f/id/key", mock.url)],
            ),
        ] {
            let mut all = base.clone();
            all.extend(extra);
            let spec = Run {
                args: all,
                stdin: b"x".to_vec(),
                ..Default::default()
            };
            let what = format!("{verb} {kind} {status} {body}");
            if status != 200 {
                // A file is fetched as bytes, so its errors are shown as they came.
                let detail = match message {
                    Some(message) if (verb, kind) != ("fetch", "file") => message,
                    _ => body,
                };
                let output = fails(&spec, "", &what);
                assert_eq!(
                    output.stderr,
                    format!(
                        "Failed to {verb} {kind}: yopass server error: unexpected response {status} {}: {detail}\n",
                        reason(status)
                    ),
                    "{what}"
                );
            } else if !body.contains(r#""id""#) {
                // Neither a secret ID nor a message; a_store_without_an_id_is_an_error has more.
                let lead = if (verb, kind) == ("fetch", "file") {
                    "Failed to decrypt file: invalid message".to_string()
                } else {
                    format!("Failed to {verb} {kind}: could not decode server response")
                };
                fails(&spec, &lead, &what);
            } else if verb == "store" {
                let output = run(&spec);
                assert_eq!(output.code, Some(0), "{what}: {}", output.stderr);
                let link = format!("{}/#/{}/id", mock.url, &kind[..1]);
                assert_eq!(text(&output), link, "{what}");
            } else {
                fails(
                    &spec,
                    &format!("Failed to decrypt {kind}: invalid message"),
                    &what,
                );
            }
        }
    }
}

#[test]
fn undecodable_success_bodies_fail() {
    // What follows the prefix is the JSON library's wording.
    for body in ["", "<html>", "[1]", "\"text\"", r#"{"message":1}"#] {
        let mock = replies(200, body);
        let spec = Run {
            args: args(&["--api", &mock.url, "--url", &mock.url, "--key", "k"]),
            stdin: b"x".to_vec(),
            ..Default::default()
        };
        fails(
            &spec,
            "Failed to store secret: could not decode server response",
            body,
        );
    }
}

#[test]
fn transport_failures_name_the_operation() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    for (extra, prefix) in [
        (vec![], "Failed to store secret: yopass server error: "),
        (
            vec!["--decrypt".to_string(), format!("{url}/#/s/id/key")],
            "Failed to fetch secret: yopass server error: ",
        ),
        (
            vec!["--decrypt".to_string(), format!("{url}/#/f/id/key")],
            "Failed to fetch file: yopass server error: ",
        ),
    ] {
        let mut all = args(&["--api", &url, "--url", &url, "--key", "k"]);
        all.extend(extra);
        let spec = Run {
            args: all,
            stdin: b"x".to_vec(),
            ..Default::default()
        };
        fails(&spec, prefix, prefix);
    }
}

#[test]
fn empty_manual_key_is_refused_before_the_fetch() {
    let mock = replies(200, r#"{"message":"x"}"#);
    let link = format!("{}/#/c/id", mock.url);
    let base = ["--api", &mock.url, "--url", &mock.url, "--decrypt", &link];
    let spec = Run {
        args: args(&[&base[..], &["--key="]].concat()),
        ..Default::default()
    };
    let output = run(&spec);
    assert_eq!(output.code, Some(1));
    assert!(output.stderr.starts_with("Manual decryption key required"));
    assert!(take_requests(&mock).is_empty());
}

#[test]
fn malformed_links_do_not_print_the_key() {
    let mock = replies(200, r#"{"message":"x"}"#);
    let link = format!("{}/#/s/id/LINKKEY/extra", mock.url);
    let spec = Run {
        args: args(&["--api", &mock.url, "--url", &mock.url, "--decrypt", &link]),
        ..Default::default()
    };
    let output = run(&spec);
    assert_eq!(output.code, Some(1));
    assert!(!output.stderr.contains("LINKKEY"), "{}", output.stderr);
}

#[test]
fn failed_requests_do_not_print_the_secret_id() {
    // Nothing was fetched, so the ID still names a secret on the server.
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    // Nothing listens on the first, and the second never becomes a request.
    for api in [url.as_str(), "//127.0.0.1"] {
        for kind in ["s", "f"] {
            let link = format!("{url}/#/{kind}/SECRETID/key");
            let spec = Run {
                args: args(&["--api", api, "--url", &url, "--decrypt", &link]),
                ..Default::default()
            };
            let output = run(&spec);
            assert_eq!(output.code, Some(1), "{api}");
            assert!(
                !output.stderr.contains("SECRETID"),
                "{api}: {}",
                output.stderr
            );
        }
    }
}

#[test]
fn redirects_are_not_followed() {
    let other = mock(|_| (200, Vec::new(), br#"{"message":"id"}"#.to_vec()));
    for status in [301, 302, 303, 307, 308] {
        let target = other.url.clone();
        let source = mock(move |request| {
            if request.path == "/config" {
                return (200, Vec::new(), b"{}".to_vec());
            }
            let to = vec![("Location".to_string(), format!("{target}/moved"))];
            (status, to, Vec::new())
        });
        let base = [
            "--api",
            &source.url,
            "--url",
            &source.url,
            "--api-token",
            "t",
        ];
        let link = format!("{}/#/s/id/key", source.url);
        for (extra, stdin) in [(vec![], &b"x"[..]), (vec!["--decrypt", &link], b"")] {
            let spec = Run {
                args: args(&[&base[..], &extra[..]].concat()),
                stdin: stdin.to_vec(),
                ..Default::default()
            };
            let output = run(&spec);
            assert_eq!(output.code, Some(1), "{status} {extra:?}");
            assert!(
                output
                    .stderr
                    .contains(&format!("unexpected response {status}")),
                "{}",
                output.stderr
            );
            assert!(take_requests(&other).is_empty(), "{status} {extra:?}");
        }
    }
}

#[test]
fn compressed_responses_are_not_inflated() {
    // gzip of {"message":"id"}. Inflating would let a small answer fill the memory.
    const GZIP: [u8; 36] = [
        0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0x03, 0xab, 0x56, 0xca, 0x4d, 0x2d,
        0x2e, 0x4e, 0x4c, 0x4f, 0x55, 0xb2, 0x52, 0xca, 0x4c, 0x51, 0xaa, 0x05, 0x00, 0x05, 0x60,
        0xb2, 0x0d, 0x10, 0x00, 0x00, 0x00,
    ];
    let encoding = vec![("Content-Encoding".to_string(), "gzip".to_string())];
    let mock = mock(move |_| (200, encoding.clone(), GZIP.to_vec()));
    let link = format!("{}/#/s/id/key", mock.url);
    for (extra, stdin) in [(vec![], &b"x"[..]), (vec!["--decrypt", &link], b"")] {
        let base = ["--api", &mock.url, "--url", &mock.url];
        let spec = Run {
            args: args(&[&base[..], &extra[..]].concat()),
            stdin: stdin.to_vec(),
            ..Default::default()
        };
        let output = run(&spec);
        assert_eq!(output.code, Some(1), "{extra:?}");
        assert!(
            output.stderr.contains("could not decode server response"),
            "{extra:?}: {}",
            output.stderr
        );
        let requests = take_requests(&mock);
        assert!(!requests.is_empty(), "{extra:?}");
        for request in requests {
            let asked = request.headers.get("accept-encoding");
            assert_eq!(asked, None, "{extra:?}");
        }
    }
}

#[test]
fn empty_files_and_go_empty_secrets_are_read() {
    let server = Server::start(false);
    let file = scratch().join("empty.txt");
    std::fs::write(&file, b"").unwrap();
    let link = share(&server.url, &["--file", file.to_str().unwrap()], b"");
    let output = fetch(&server.url, &link, &[]);
    assert_eq!(output.code, Some(0), "{}", output.stderr);
    assert!(output.stdout.is_empty());
    // The Go CLI shared empty input from stdin too.
    for name in ["go-cli-empty.asc", "go-cli-empty-file.bin"] {
        let output = decrypt_served(&fixture(name), "fixture-key", name);
        assert_eq!(output.code, Some(0), "{name}: {}", output.stderr);
        assert!(output.stdout.is_empty(), "{name}");
    }
}

#[test]
fn per_run_settings_work_from_the_environment_but_not_the_config_file() {
    let mock = replies(200, r#"{"message":"fixed-id"}"#);
    let u = mock.url.clone();
    for setting in ["key: abc", "file: /etc/hosts", "decrypt: https://x/#/s/a/b"] {
        let contents = format!("api: {u}\nurl: {u}\n{setting}\n");
        let spec = Run {
            home: Some(config_home("config.yaml", &contents)),
            stdin: b"x".to_vec(),
            ..Default::default()
        };
        assert_eq!(run(&spec).code, Some(3), "{setting}");
        assert!(take_requests(&mock).is_empty(), "{setting}");
    }
    let server = vec![("YOPASS_API", u.clone()), ("YOPASS_URL", u.clone())];
    let with = |name, value: String| {
        let mut env = server.clone();
        env.push((name, value));
        env
    };
    // A manual key leaves the link without one.
    let spec = Run {
        env: with("YOPASS_KEY", "env-key".to_string()),
        stdin: b"x".to_vec(),
        ..Default::default()
    };
    assert_eq!(text(&run(&spec)), format!("{u}/#/s/fixed-id"));
    let file = scratch().join("env-file.txt");
    std::fs::write(&file, "x").unwrap();
    let spec = Run {
        env: with("YOPASS_FILE", file.to_str().unwrap().to_string()),
        ..Default::default()
    };
    assert!(text(&run(&spec)).contains("/#/f/fixed-id/"));
    take_requests(&mock);
    let spec = Run {
        env: with("YOPASS_DECRYPT", format!("{u}/#/s/some-id/key")),
        ..Default::default()
    };
    assert_eq!(run(&spec).code, Some(1));
    assert!(take_requests(&mock)
        .iter()
        .any(|r| r.path == "/secret/some-id"));
}

#[test]
fn other_config_files_are_refused() {
    for name in [
        "defaults.yml",
        "defaults.yaml",
        "defaults.toml",
        "config.yml",
    ] {
        let home = config_home(name, "api-token: abc\n");
        std::fs::write(
            home.join(".config/yopass/config.yaml"),
            "api: http://127.0.0.1:1\nurl: http://127.0.0.1:1\n",
        )
        .unwrap();
        let spec = Run {
            home: Some(home),
            stdin: b"x".to_vec(),
            ..Default::default()
        };
        let output = run(&spec);
        assert_eq!(output.code, Some(3), "{name}: {}", output.stderr);
        assert!(output.stderr.contains(&format!("{name} is not supported")));
    }
}

#[test]
fn merge_keys_are_refused_and_the_token_comes_from_config() {
    let mock = replies(200, r#"{"message":"id"}"#);
    let u = &mock.url;
    let merge = config_home("config.yaml", &format!("a: &a {{api: {u}}}\n<<: *a\n"));
    let spec = Run {
        home: Some(merge),
        stdin: b"x".to_vec(),
        ..Default::default()
    };
    assert_eq!(run(&spec).code, Some(3));
    let home = config_home(
        "config.yaml",
        &format!("api: {u}\nurl: https://from-config.example\napi-token: \"s3cret\"\n"),
    );
    let spec = Run {
        home: Some(home),
        stdin: b"x".to_vec(),
        ..Default::default()
    };
    let output = run(&spec);
    assert_eq!(output.code, Some(0), "{}", output.stderr);
    assert!(text(&output).starts_with("https://from-config.example/"));
    let stored: Vec<_> = take_requests(&mock)
        .into_iter()
        .filter(|request| request.path == "/create/secret")
        .collect();
    assert_eq!(stored.len(), 1);
    assert_eq!(stored[0].headers["authorization"], "Bearer s3cret");
}

#[test]
fn the_token_is_only_sent_to_the_api_it_was_set_with() {
    let other = replies(200, r#"{"message":"not a message"}"#);
    let u = other.url.as_str();
    let other_config = "api: http://127.0.0.1:1\napi-token: \"s3cret\"\n";
    let both_in_config = format!("api: {u}\napi-token: \"s3cret\"\n");
    let env_token = [("YOPASS_API_TOKEN", "s3cret")];
    let env_api = [("YOPASS_API", u)];
    let env_both = [("YOPASS_API", u), ("YOPASS_API_TOKEN", "s3cret")];
    let flags_both = ["--api", u, "--api-token", "s3cret"];
    let sent = Some("Bearer s3cret");
    // Name, flags, environment, config file and the Authorization header expected.
    type Case<'a> = (
        &'a str,
        &'a [&'a str],
        &'a [(&'a str, &'a str)],
        &'a str,
        Option<&'a str>,
    );
    let cases: [Case; 6] = [
        ("flag over config", &["--api", u], &[], other_config, None),
        ("flag over env", &["--api", u], &env_token, "", None),
        ("env over config", &[], &env_api, other_config, None),
        ("both in config", &[], &[], &both_in_config, sent),
        ("both in env", &[], &env_both, other_config, sent),
        ("both flags", &flags_both, &[], other_config, sent),
    ];
    for (case, flags, env, config, want) in cases {
        for kind in ["s", "f"] {
            let link = format!("{u}/#/{kind}/id/key");
            let what = format!("{kind} {case}");
            let spec = Run {
                args: args(&[flags, &["--url", u, "--decrypt", &link]].concat()),
                env: env.iter().map(|&(k, v)| (k, v.to_string())).collect(),
                home: Some(config_home("config.yaml", config)),
                ..Default::default()
            };
            let output = run(&spec);
            assert_eq!(output.code, Some(1), "{what}");
            assert_eq!(
                output.stderr.contains("api-token from "),
                want.is_none(),
                "{what}: {}",
                output.stderr
            );
            let requests = take_requests(&other);
            assert_eq!(requests.len(), 1, "{what}");
            assert_eq!(
                requests[0].headers.get("authorization").map(String::as_str),
                want,
                "{what}"
            );
        }
    }
}

#[test]
fn empty_stdin_is_an_error() {
    let mock = replies(200, r#"{"message":"id"}"#);
    let spec = Run {
        args: args(&["--api", &mock.url, "--url", &mock.url]),
        ..Default::default()
    };
    let output = run(&spec);
    assert_eq!(output.code, Some(1));
    assert_eq!(
        output.stderr.trim(),
        "No filename or piped input to encrypt given"
    );
    assert!(take_requests(&mock).is_empty());
}

#[test]
fn a_store_without_an_id_is_an_error() {
    for body in [r#"{}"#, r#"{"message":""}"#, r#"{"message":null}"#, "null"] {
        let server = replies(200, body);
        let spec = Run {
            args: args(&["--api", &server.url, "--url", &server.url]),
            stdin: b"x".to_vec(),
            ..Default::default()
        };
        let output = run(&spec);
        assert_eq!(output.code, Some(1), "{body}");
        assert_eq!(output.stdout, b"", "{body}");
        assert!(
            output.stderr.starts_with("Failed to store secret: "),
            "{body}"
        );
    }
}

#[test]
fn proxy_environment_is_honored() {
    // ureq's own rules apply; proxy support is undocumented, so only the basics are promised.
    let proxy = mock(|_| (200, Vec::new(), br#"{"message":"via-proxy"}"#.to_vec()));
    for (env, expected) in [
        (vec![("HTTP_PROXY", proxy.url.clone())], true),
        (vec![("HTTPS_PROXY", proxy.url.clone())], true),
        (
            vec![
                ("HTTP_PROXY", proxy.url.clone()),
                ("NO_PROXY", "yopass.invalid".to_string()),
            ],
            false,
        ),
        (vec![], false),
    ] {
        let spec = Run {
            args: args(&[
                "--api",
                "http://yopass.invalid",
                "--url",
                "http://yopass.invalid",
                "--key",
                "k",
            ]),
            env: env.clone(),
            stdin: b"x".to_vec(),
            ..Default::default()
        };
        run(&spec);
        assert_eq!(!take_requests(&proxy).is_empty(), expected, "{env:?}");
    }
}

// ---- Ciphertext from other implementations ----

// Why a served message is refused, as the end of stderr.
const INVALID_MESSAGE: &str = "invalid message";
const WRONG_KEY: &str = "could not decrypt: invalid decryption key";

/// The outcome of `decrypt_served` for a message that is refused.
fn assert_refused(output: &Output, reason: &str, context: &str) {
    assert_eq!(output.code, Some(1), "{context}");
    assert!(output.stdout.is_empty(), "{context}");
    assert_eq!(
        output.stderr,
        format!("Failed to decrypt file: {reason}\n"),
        "{context}"
    );
}

/// The go-cli fixtures were written by the Go CLI of release 16.3.0 with `--key fixture-key`.
fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures")
            .join(name),
    )
    .unwrap()
}

/// Serves `ciphertext` as a file and, when it is text, as a secret too, which must come out
/// the same. Returns the file's outcome.
fn decrypt_served(ciphertext: &[u8], key: &str, context: &str) -> Output {
    let armored = serde_json::json!({ "message": String::from_utf8_lossy(ciphertext) })
        .to_string()
        .into_bytes();
    let raw = ciphertext.to_vec();
    let mock = mock(move |request| {
        if request.path.starts_with("/file") {
            (200, Vec::new(), raw.clone())
        } else {
            (200, Vec::new(), armored.clone())
        }
    });
    let fetch = |kind: &str| fetch(&mock.url, &format!("{}/#/{kind}/id/{key}", mock.url), &[]);
    let file = fetch("f");
    if std::str::from_utf8(ciphertext).is_ok() {
        let secret = fetch("s");
        assert_eq!(
            (secret.code, &secret.stdout),
            (file.code, &file.stdout),
            "{context}: {} / {}",
            secret.stderr,
            file.stderr
        );
    }
    file
}

#[test]
fn messages_from_other_tools_decrypt() {
    // The content, and how a wrong key is reported.
    for (name, want, wrong_key) in [
        (
            "gpg-default.asc",
            &b"gpg default secret\n"[..],
            INVALID_MESSAGE,
        ),
        ("gpg-zlib.asc", b"gpg zlib secret\n", INVALID_MESSAGE),
        ("gpg-signed.asc", b"gpg signed secret\n", INVALID_MESSAGE),
        (
            "gpg-signed-uncompressed.asc",
            b"gpg signed plain\n",
            INVALID_MESSAGE,
        ),
        ("go-zlib.asc", b"go compressed secret\n", WRONG_KEY),
        ("go-cli.asc", b"go cli secret\n", WRONG_KEY),
        ("go-cli-argon2.asc", b"go cli argon2 secret\n", WRONG_KEY),
        ("go-cli-file.bin", b"go cli file \xff\xfe\x00\n", WRONG_KEY),
        (
            "gpg-text.asc",
            b"text mode\r\nline two\r\n",
            INVALID_MESSAGE,
        ),
    ] {
        let output = decrypt_served(&fixture(name), "fixture-key", name);
        assert_eq!(output.stdout, want, "{name}: {}", output.stderr);
        let wrong = decrypt_served(&fixture(name), "wrong-key", name);
        assert_refused(&wrong, wrong_key, name);
    }
}

#[test]
fn gnupg_ocb_is_refused() {
    let output = decrypt_served(&fixture("gpg-ocb.asc"), "fixture-key", "ocb");
    assert_refused(&output, WRONG_KEY, "ocb");
}

#[test]
fn failed_output_write_is_an_error() {
    // Fetching may already have deleted a one-time secret, so losing it must not look fine.
    // No trailing newline: a newline would flush stdout's line buffer by itself.
    let message = "-----BEGIN PGP MESSAGE-----\nComment: https://yopass.se\n\nw0wGGgkDCwMIPs3irOnCQEvgbpOkU4RQyXA8A27SsXr63BxmV0/YNxqhkF5zTrtV\nFKfZE4WLhbWt4VJzDk/56ltIL91uqdY827pj7HFQ0l0CCQMMRipaKrKyyktyUW/w\n4kfFXE46fH+XIjb9Gn9K6LlPChzC6EHSHV43LC7uXtnTKmXNJqWkb5aZodU4w5uQ\n6DQzN2jeA0hmVTiZkkqEWbvvogpb8RnDh7jmgaA=\n=9Y3B\n-----END PGP MESSAGE-----";
    let body = serde_json::json!({ "message": message })
        .to_string()
        .into_bytes();
    let mock = mock(move |_| (200, Vec::new(), body.clone()));
    let link = format!("{}/#/s/id/TestAEADKey12345678901", mock.url);
    let (reader, writer) = std::io::pipe().unwrap();
    drop(reader);
    let output = clean_command(RUST)
        .env("HOME", empty_home())
        .args(["--api", &mock.url, "--url", &mock.url, "--decrypt", &link])
        .stdout(writer)
        .stderr(Stdio::piped())
        .output()
        .unwrap();
    assert_eq!(
        output.status.code(),
        Some(1),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn armor_variations_are_judged() {
    let original = String::from_utf8(fixture("gpg-default.asc")).unwrap();
    let lines: Vec<&str> = original.lines().collect();
    let without_crc: Vec<&str> = lines
        .iter()
        .filter(|line| !(line.starts_with('=') && line.len() == 5))
        .copied()
        .collect();
    let bad_crc: Vec<String> = lines
        .iter()
        .map(|line| {
            if line.starts_with('=') && line.len() == 5 {
                "=AAAA".to_string()
            } else {
                line.to_string()
            }
        })
        .collect();
    for (context, message, accepted) in [
        ("as is", original.clone(), true),
        ("trailing newlines", format!("{original}\n\n"), true),
        ("trailing text", format!("{original}trailing text\n"), true),
        ("crlf", original.replace('\n', "\r\n"), true),
        ("no crc", without_crc.join("\n"), true),
        ("bad crc", bad_crc.join("\n"), true),
        ("leading whitespace", format!("  {original}"), false),
        ("leading newline", format!("\n{original}"), false),
        (
            "truncated",
            original[..original.len() / 2].to_string(),
            false,
        ),
        (
            "header only",
            "-----BEGIN PGP MESSAGE-----\n\n".to_string(),
            false,
        ),
        (
            "wrong block",
            original.replace("PGP MESSAGE", "PGP SIGNATURE"),
            false,
        ),
    ] {
        let output = decrypt_served(message.as_bytes(), "fixture-key", context);
        if accepted {
            assert_eq!(output.stdout, b"gpg default secret\n", "{context}");
        } else {
            assert_refused(&output, INVALID_MESSAGE, context);
        }
    }
}

#[test]
fn hostile_binary_messages_are_refused() {
    let mut costly = vec![0xc3, 22, 4, 9, 4];
    costly.extend([0; 16]);
    costly.extend([1, 1, 31]);
    let mut with_payload = costly.clone();
    with_payload.extend([0xd2, 1, 1]);
    for (context, message) in [
        ("costly argon2", with_payload),
        ("garbage", b"garbage bytes".to_vec()),
        ("single byte", vec![0xc3]),
        ("encrypted without key packets", vec![0xd2, 1, 1]),
        ("sed packet", vec![0xc9, 3, 1, 2, 3]),
        ("unencrypted literal", fixture("gpg-store.asc")),
    ] {
        let output = decrypt_served(&message, "key", context);
        assert_refused(&output, INVALID_MESSAGE, context);
    }
}

#[test]
fn unknown_aead_is_refused_without_a_panic() {
    // Valid v6 SKESK framing with an AEAD id rPGP has no parameters for.
    let mut message = vec![0xc3, 0x1a + 2, 6, 26, 9, 99, 11, 3, 8];
    message.extend([0; 9]);
    message.extend([0xd2, 38, 2, 9, 99, 12]);
    message.extend([0; 34]);
    let output = decrypt_served(&message, "key", "unknown aead");
    assert_refused(&output, INVALID_MESSAGE, "unknown aead");
}

// ---- Website client ----

fn openpgpjs_script(name: &str) -> Option<PathBuf> {
    let modules = repo_root().join("website/node_modules");
    if !modules.join("openpgp").exists() {
        assert!(
            std::env::var_os("YOPASS_REQUIRE_OPENPGPJS").is_none(),
            "website/node_modules is required"
        );
        eprintln!("skipping {name}: run yarn install in website/ to include OpenPGP.js");
        return None;
    }
    Some(modules)
}

fn node(modules: &Path, script: &str, input: &[u8]) -> Result<Vec<u8>, String> {
    let path = scratch().join(format!(
        "openpgp-{}.cjs",
        CONFIG_DIRS.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::write(&path, script).unwrap();
    let mut child = Command::new("node")
        .arg(&path)
        .env("NODE_PATH", modules)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("node is required for OpenPGP.js interop");
    child.stdin.take().unwrap().write_all(input).unwrap();
    let output = child.wait_with_output().unwrap();
    if output.status.success() {
        Ok(output.stdout)
    } else {
        Err(String::from_utf8_lossy(&output.stderr).into_owned())
    }
}

const JS_DECRYPT: &str = r#"
const openpgp = require('openpgp');
(async () => {
  const data = require('fs').readFileSync(0);
  const config = { maxArgon2MemoryExponent: 17, maxDecompressedMessageSize: 1 << 20 };
  const message = data.subarray(0, 5).toString() === '-----'
    ? await openpgp.readMessage({ armoredMessage: data.toString(), config })
    : await openpgp.readMessage({ binaryMessage: new Uint8Array(data), config });
  const { data: out, filename } = await openpgp.decrypt({ message, passwords: 'js-key', format: 'binary', config });
  process.stdout.write(JSON.stringify({ filename, data: Buffer.from(out).toString('base64') }));
})().catch((err) => { console.error(err); process.exit(1); });
"#;

fn js_encrypt(extra: &str) -> String {
    format!(
        r#"
const openpgp = require('openpgp');
(async () => {{
  const data = new Uint8Array(require('fs').readFileSync(0));
  const out = await openpgp.encrypt({{
    message: await openpgp.createMessage({{ binary: data, filename: 'js-file.bin' }}),
    passwords: 'js-key',
    format: 'binary',
    config: {{ aeadProtect: true, preferredAEADAlgorithm: openpgp.enums.aead.gcm {extra} }},
  }});
  process.stdout.write(Buffer.from(out));
}})().catch((err) => {{ console.error(err); process.exit(1); }});
"#
    )
}

#[test]
fn website_reads_what_the_cli_writes() {
    let Some(modules) = openpgpjs_script("website_reads_what_the_cli_writes") else {
        return;
    };
    for argon2 in [false, true] {
        // Capture ciphertext as the website would receive it.
        let capture = mock(move |request| {
            let body = if request.path == "/config" {
                format!(r#"{{"ARGON2":{argon2}}}"#).into_bytes()
            } else {
                br#"{"message":"id"}"#.to_vec()
            };
            (200, Vec::new(), body)
        });
        let data: Vec<u8> = (0..=255u8).cycle().take(300_000).collect();
        let base = args(&[
            "--api",
            &capture.url,
            "--url",
            &capture.url,
            "--key",
            "js-key",
        ]);
        run(&Run {
            args: base.clone(),
            stdin: data.clone(),
            ..Default::default()
        });
        let path = scratch().join("to website.bin");
        std::fs::write(&path, &data).unwrap();
        let mut file_args = base.clone();
        file_args.extend(args(&["--file", path.to_str().unwrap()]));
        run(&Run {
            args: file_args,
            ..Default::default()
        });

        for request in take_requests(&capture)
            .iter()
            .filter(|r| r.path.starts_with("/create"))
        {
            let input = if request.path == "/create/secret" {
                serde_json::from_slice::<serde_json::Value>(&request.body).unwrap()["message"]
                    .as_str()
                    .unwrap()
                    .as_bytes()
                    .to_vec()
            } else {
                request.body.clone()
            };
            let output = node(&modules, JS_DECRYPT, &input)
                .unwrap_or_else(|err| panic!("{}: {err}", request.path));
            let result: serde_json::Value = serde_json::from_slice(&output).unwrap();
            let want = base64_of(&data);
            assert!(
                result["data"].as_str() == Some(want.as_str()),
                "{} content differs",
                request.path
            );
            if request.path == "/create/file" {
                assert_eq!(result["filename"], "to website.bin");
            }
        }
    }
}

fn base64_of(data: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in data.chunks(3) {
        let bytes = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = u32::from(bytes[0]) << 16 | u32::from(bytes[1]) << 8 | u32::from(bytes[2]);
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(ALPHABET[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

#[test]
fn cli_reads_what_the_website_writes() {
    let Some(modules) = openpgpjs_script("cli_reads_what_the_website_writes") else {
        return;
    };
    let data: Vec<u8> = (0..=255u8).cycle().take(300_000).collect();
    for extra in ["", ", s2kType: openpgp.enums.s2k.argon2"] {
        let message = node(&modules, &js_encrypt(extra), &data).unwrap();
        let output = decrypt_served(&message, "js-key", extra);
        assert_eq!(output.stdout, data, "{extra}: {}", output.stderr);
    }
}

#[test]
fn links_that_would_not_decrypt_are_refused() {
    let ok = replies(200, r#"{"message":"id"}"#);
    // A bad public URL fails before anything is stored.
    for url in ["e.example", "https://e.example/#/x", "ftp://e.example"] {
        let spec = Run {
            args: args(&["--api", &ok.url, "--url", url]),
            stdin: b"x".to_vec(),
            ..Default::default()
        };
        let output = run(&spec);
        assert_eq!(output.code, Some(1), "{url}");
        assert!(
            output.stderr.contains("Invalid yopass URL"),
            "{}",
            output.stderr
        );
        assert!(output.stdout.is_empty(), "{url}");
    }
    assert!(take_requests(&ok).is_empty());
    // A server ID that is not one path segment would print a link to another secret, and
    // one with backspaces or a space a link that shows another host in front of the key.
    for id in ["a/b", r"\b\b\b\b\b\b\b\b\b\be.test", "a e.test"] {
        let bad = replies(200, &format!(r#"{{"message":"{id}"}}"#));
        let spec = Run {
            args: args(&["--api", &bad.url, "--url", "https://e.example"]),
            stdin: b"x".to_vec(),
            ..Default::default()
        };
        let output = run(&spec);
        assert_eq!(output.code, Some(1), "{id}");
        assert!(
            output.stderr.contains("invalid secret ID"),
            "{}",
            output.stderr
        );
        assert!(output.stdout.is_empty(), "{id}");
    }
}

/// Rust only: the Go CLI has no `--recipient`.
#[test]
fn a_recipient_travels_with_secrets_and_files() {
    let mock = mock(|request| {
        let body = match request.path.as_str() {
            "/config" => r#"{"RESTRICTED_RECIPIENTS":true}"#,
            _ => r#"{"message":"fixed-id","restricted":true}"#,
        };
        (200, Vec::new(), body.as_bytes().to_vec())
    });
    let u = mock.url.as_str();
    let dir = scratch();
    let path = dir.join("recipient.txt");
    std::fs::write(&path, b"x").unwrap();
    for extra in [vec![], vec!["--file", path.to_str().unwrap()]] {
        let mut values = vec!["--api", u, "--url", u, "--recipient", "bob@example.com"];
        values.extend(extra);
        let output = run(
            RUST,
            &Run {
                args: args(&values),
                stdin: b"x".to_vec(),
                ..Default::default()
            },
        );
        assert_eq!(output.code, Some(0), "{}", output.stderr);
        let request = take_requests(&mock)
            .into_iter()
            .find(|request| request.path.starts_with("/create/"))
            .unwrap();
        if request.path == "/create/file" {
            let header = &request.headers["x-yopass-recipient"];
            let decoded = percent_encoding::percent_decode_str(header)
                .decode_utf8()
                .unwrap();
            assert_eq!(decoded, "bob@example.com");
        } else {
            let body: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
            assert_eq!(body["recipient"], "bob@example.com");
        }
    }
}

/// A server that would ignore the recipient must never get to hand out a link.
#[test]
fn a_recipient_is_never_silently_dropped() {
    let send = |mock: &Mock| {
        let u = mock.url.as_str();
        run(
            RUST,
            &Run {
                args: args(&["--api", u, "--url", u, "--recipient", "bob@example.com"]),
                stdin: b"x".to_vec(),
                ..Default::default()
            },
        )
    };
    // Not offered: nothing is stored.
    let unaware = replies(200, r#"{"message":"fixed-id"}"#);
    let output = send(&unaware);
    assert_ne!(output.code, Some(0));
    assert!(output.stdout.is_empty());
    assert!(!take_requests(&unaware).iter().any(|r| r.method == "POST"));

    // Offered but not confirmed: the open secret is deleted again.
    let unconfirmed = mock(|request| {
        let (status, body) = match (request.method.as_str(), request.path.as_str()) {
            (_, "/config") => (200, r#"{"RESTRICTED_RECIPIENTS":true}"#),
            ("DELETE", _) => (204, ""),
            _ => (200, r#"{"message":"fixed-id"}"#),
        };
        (status, Vec::new(), body.as_bytes().to_vec())
    });
    let output = send(&unconfirmed);
    assert_ne!(output.code, Some(0));
    assert!(output.stdout.is_empty());
    assert!(output.stderr.contains("deleted again"), "{}", output.stderr);
    assert!(take_requests(&unconfirmed)
        .iter()
        .any(|r| r.method == "DELETE" && r.path == "/secret/fixed-id"));

    // Not confirmed, and the delete fails too: the user is told it remains.
    let stuck = mock(|request| {
        let (status, body) = match (request.method.as_str(), request.path.as_str()) {
            (_, "/config") => (200, r#"{"RESTRICTED_RECIPIENTS":true}"#),
            ("DELETE", _) => (500, r#"{"message":"down"}"#),
            _ => (200, r#"{"message":"fixed-id"}"#),
        };
        (status, Vec::new(), body.as_bytes().to_vec())
    });
    let output = send(&stuck);
    assert_ne!(output.code, Some(0));
    assert!(output.stdout.is_empty());
    assert!(
        output.stderr.contains("could not be deleted"),
        "{}",
        output.stderr
    );
}
