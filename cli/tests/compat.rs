//! Compatibility tests against the Go CLI (built from cmd/yopass) and the real
//! server handler (tests/testserver). Requires the Go toolchain.

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

fn go_cli() -> &'static str {
    static BIN: OnceLock<String> = OnceLock::new();
    BIN.get_or_init(|| {
        go_build("./cmd/yopass", "go-yopass")
            .to_str()
            .unwrap()
            .to_string()
    })
}

fn binaries() -> [(&'static str, &'static str); 2] {
    [("go", go_cli()), ("rust", RUST)]
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

#[derive(Debug, PartialEq, Clone)]
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

/// The Go CLI reads defaults.yml, and the Rust CLI refuses to run next to one, so
/// Go gets its own home holding the same config.
fn home_for(bin: &str, home: PathBuf) -> PathBuf {
    let config = home.join(".config/yopass/config.yaml");
    if bin == RUST || !config.exists() {
        return home;
    }
    let go_home = home.join("go");
    let dir = go_home.join(".config/yopass");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::copy(config, dir.join("defaults.yml")).unwrap();
    go_home
}

fn run(bin: &str, spec: &Run) -> Output {
    let mut command = clean_command(bin);
    command.args(&spec.args);
    command.env(
        "HOME",
        home_for(bin, spec.home.clone().unwrap_or_else(empty_home)),
    );
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

fn assert_same(spec: &Run, context: &str) -> Output {
    let go = run(go_cli(), spec);
    let rust = run(RUST, spec);
    assert_eq!(
        rust, go,
        "{context}: args {:?} env {:?}",
        spec.args, spec.env
    );
    rust
}

/// For errors where only the leading context is promised to match Go.
fn assert_same_outcome(spec: &Run, context: &str) -> Output {
    let go = run(go_cli(), spec);
    let rust = run(RUST, spec);
    let lead = |stderr: &str| stderr.split(':').next().unwrap_or("").to_string();
    assert_eq!(
        (rust.code, &rust.stdout, lead(&rust.stderr)),
        (go.code, &go.stdout, lead(&go.stderr)),
        "{context}: args {:?} env {:?}\nrust: {}\ngo: {}",
        spec.args,
        spec.env,
        rust.stderr,
        go.stderr
    );
    rust
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

// ---- Real server, every sender/receiver pairing ----

fn share(bin: &str, server: &str, extra: &[&str], stdin: &[u8]) -> String {
    let mut all = args(&["--api", server, "--url", server]);
    all.extend(args(extra));
    let spec = Run {
        args: all,
        stdin: stdin.to_vec(),
        ..Default::default()
    };
    let output = run(bin, &spec);
    assert_eq!(
        output.code,
        Some(0),
        "{bin} share failed: {}",
        output.stderr
    );
    text(&output)
}

fn fetch(bin: &str, server: &str, link: &str, extra: &[&str]) -> Output {
    let mut all = args(&["--api", server, "--url", server, "--decrypt", link]);
    all.extend(args(extra));
    run(
        bin,
        &Run {
            args: all,
            ..Default::default()
        },
    )
}

#[test]
fn every_pairing_round_trips_text() {
    let server = Server::start(false);
    for (sender, send_bin) in binaries() {
        for (receiver, recv_bin) in binaries() {
            for data in [
                &b"hello"[..],
                b"line\r\nline\n",
                b"\xff\xfe\x00 not utf-8",
                &vec![b'y'; 300_000],
            ] {
                let link = share(send_bin, &server.url, &["--one-time=false"], data);
                assert!(link.starts_with(&format!("{}/#/s/", server.url)), "{link}");
                let output = fetch(recv_bin, &server.url, &link, &[]);
                assert_eq!(
                    output.code,
                    Some(0),
                    "{sender}->{receiver}: {}",
                    output.stderr
                );
                assert_eq!(output.stdout, data, "{sender}->{receiver}");
            }
        }
    }
}

#[test]
fn every_pairing_round_trips_files() {
    let server = Server::start(false);
    let path = scratch().join("upload name.bin");
    let data: Vec<u8> = (0..=255u8).cycle().take(600_000).collect();
    std::fs::write(&path, &data).unwrap();
    for (sender, send_bin) in binaries() {
        for (receiver, recv_bin) in binaries() {
            let link = share(
                send_bin,
                &server.url,
                &["--file", path.to_str().unwrap(), "--one-time=false"],
                b"",
            );
            assert!(link.starts_with(&format!("{}/#/f/", server.url)), "{link}");
            let output = fetch(recv_bin, &server.url, &link, &[]);
            assert_eq!(
                output.code,
                Some(0),
                "{sender}->{receiver}: {}",
                output.stderr
            );
            assert_eq!(output.stdout, data, "{sender}->{receiver}");
        }
    }
}

#[test]
fn every_pairing_with_argon2_server() {
    let server = Server::start(true);
    for (sender, send_bin) in binaries() {
        for (receiver, recv_bin) in binaries() {
            let link = share(send_bin, &server.url, &[], b"argon2 secret");
            let output = fetch(recv_bin, &server.url, &link, &[]);
            assert_eq!(
                output.stdout, b"argon2 secret",
                "{sender}->{receiver}: {}",
                output.stderr
            );
        }
    }
}

#[test]
fn every_pairing_with_manual_key() {
    let server = Server::start(false);
    for (_, send_bin) in binaries() {
        for (_, recv_bin) in binaries() {
            let link = share(send_bin, &server.url, &["--key", "manual-key"], b"manual");
            assert!(!link.contains("manual-key"), "{link}");
            assert_eq!(link.matches('/').count(), 5, "key must be absent: {link}");
            let missing = fetch(recv_bin, &server.url, &link, &[]);
            assert_eq!(
                missing.stderr.trim(),
                "Manual decryption key required, set --key"
            );
            let wrong = fetch(recv_bin, &server.url, &link, &["--key", "wrong"]);
            assert_eq!(wrong.code, Some(1));
            assert_eq!(
                wrong.stderr.trim(),
                "Failed to decrypt secret: could not decrypt: invalid decryption key"
            );
        }
    }
    // A wrong key consumed the one-time secret above, so each attempt needs its own.
    for (_, send_bin) in binaries() {
        for (_, recv_bin) in binaries() {
            let link = share(
                send_bin,
                &server.url,
                &["--key", "manual-key", "--one-time=false"],
                b"manual",
            );
            let output = fetch(recv_bin, &server.url, &link, &["--key", "manual-key"]);
            assert_eq!(output.stdout, b"manual");
        }
    }
}

#[test]
fn one_time_secrets_are_consumed_identically() {
    let server = Server::start(false);
    for (_, send_bin) in binaries() {
        let link = share(send_bin, &server.url, &[], b"once");
        let first = fetch(RUST, &server.url, &link, &[]);
        assert_eq!(first.stdout, b"once");
        let second_rust = fetch(RUST, &server.url, &link, &[]);
        let second_go = fetch(go_cli(), &server.url, &link, &[]);
        assert_eq!(second_rust, second_go);
        assert_eq!(second_rust.code, Some(1));
        assert_eq!(
            second_rust.stderr.trim(),
            "Failed to fetch secret: yopass server error: unexpected response 404 Not Found: Secret not found"
        );
    }
}

#[test]
fn custom_expirations_get_the_same_server_answer() {
    let server = Server::start(false);
    for expiration in ["1h", "1d", "1w", "90d", "1d12h", "60m"] {
        let mut outcomes = Vec::new();
        for (_, bin) in binaries() {
            let mut spec = Run {
                stdin: b"x".to_vec(),
                ..Default::default()
            };
            spec.args = args(&[
                "--api",
                &server.url,
                "--url",
                &server.url,
                "--expiration",
                expiration,
            ]);
            let output = run(bin, &spec);
            outcomes.push((output.code, output.stderr));
        }
        assert_eq!(outcomes[0], outcomes[1], "{expiration}");
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

#[test]
fn flags_are_accepted_as_in_go() {
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
        let output = assert_same(&spec, "flags");
        assert_eq!(output.code, Some(0), "{values:?}: {}", output.stderr);
        let stored: Vec<_> = take_requests(&mock)
            .into_iter()
            .filter(|request| request.path == "/create/secret")
            .collect();
        assert_eq!(stored.len(), 2, "{values:?}");
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
            let output = run(RUST, &read);
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
        let output = run(RUST, &spec);
        assert_eq!(output.code, Some(2), "{values:?}");
        assert!(output.stdout.is_empty(), "{values:?}");
        assert!(take_requests(&mock).is_empty(), "{values:?}");
    }
    for help in ["-h", "--help"] {
        let spec = Run {
            args: args(&[help]),
            ..Default::default()
        };
        let output = run(RUST, &spec);
        assert_eq!(output.code, Some(0));
        assert!(text(&output).contains("--one-time"));
    }
}

#[test]
fn empty_key_generates_a_usable_link() {
    // Go loses the generated key here, leaving the secret undecryptable.
    let server = Server::start(false);
    let spec = Run {
        args: args(&["--api", &server.url, "--url", &server.url, "--key="]),
        stdin: b"x".to_vec(),
        ..Default::default()
    };
    let link = text(&run(RUST, &spec));
    assert_eq!(link.matches('/').count(), 6, "{link}");
    assert_eq!(fetch(RUST, &server.url, &link, &[]).stdout, b"x", "{link}");
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
    for (_, sender) in binaries() {
        let output = clean_command(sender)
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
        let link = text(&Output {
            code: Some(0),
            stdout: output.stdout,
            stderr: String::new(),
        });
        for (_, receiver) in binaries() {
            let got = clean_command(receiver)
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
    }
}

#[cfg(unix)]
#[test]
fn non_utf8_keys_interoperate() {
    use std::ffi::OsStr;
    use std::io::Write as _;
    use std::os::unix::ffi::OsStrExt;
    let server = Server::start(false);
    for (_, sender) in binaries() {
        let mut child = clean_command(sender)
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
        for (_, receiver) in binaries() {
            let got = clean_command(receiver)
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
    }
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
fn no_input_errors_match() {
    let spec = Run {
        no_stdin_pipe: true,
        env: unreachable_server(),
        ..Default::default()
    };
    let output = assert_same(&spec, "/dev/null stdin");
    assert_eq!(
        output.stderr.trim(),
        "No filename or piped input to encrypt given"
    );
    let missing = Run {
        args: args(&["--file", "/does/not/exist"]),
        env: unreachable_server(),
        ..Default::default()
    };
    let output = assert_same_outcome(&missing, "missing file");
    assert!(
        output
            .stderr
            .starts_with("Failed to open file: open /does/not/exist: "),
        "{}",
        output.stderr
    );
    assert_same_outcome(
        &Run {
            args: args(&["--file="]),
            env: unreachable_server(),
            ..Default::default()
        },
        "empty file",
    );
}

#[test]
fn reading_a_directory_fails_identically() {
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
    let output = assert_same_outcome(&spec, "directory");
    assert_eq!(output.code, Some(1));
}

#[test]
fn expiration_validation_matches() {
    let mock = replies(200, r#"{"message":"fixed-id"}"#);
    for expiration in [
        "1h",
        "1d",
        "1w",
        "90d",
        "1d12h",
        "30s",
        "5m",
        "0h",
        "0",
        "",
        "123",
        "abc",
        "h",
        "-1h",
        "+1h",
        "1.5h",
        "1h ",
        " 1h",
        "1H",
        "1y",
        "2147483647s",
        "2147483648s",
        "3550w",
        "3551w",
        "99999999999999999999h",
        "1h1",
        "1h2",
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
        assert_same(&spec, "expiration");
        let requests = take_requests(&mock);
        // Both binaries agree on whether, and with which lifetime, the secret is stored.
        let stored: Vec<_> = requests
            .iter()
            .filter(|r| r.path == "/create/secret")
            .collect();
        if let [go, rust] = stored[..] {
            let lifetime = |r: &Request| {
                serde_json::from_slice::<serde_json::Value>(&r.body).unwrap()["expiration"].clone()
            };
            assert_eq!(lifetime(go), lifetime(rust), "{expiration}");
        } else {
            assert!(stored.is_empty(), "{expiration}: {stored:?}");
        }
    }
}

#[test]
fn one_time_values_match_across_sources() {
    let mock = replies(200, r#"{"message":"fixed-id"}"#);
    let base = args(&["--api", &mock.url, "--url", &mock.url, "--key", "k"]);
    let home = scratch().join("one-time-home");
    let _ = std::fs::remove_dir_all(&home);
    let config_dir = home.join(".config/yopass");
    std::fs::create_dir_all(&config_dir).unwrap();
    let check = |spec: Run, context: String| {
        assert_same(&spec, &context);
        let requests = take_requests(&mock);
        let flags: Vec<_> = requests
            .iter()
            .filter(|r| r.path == "/create/secret")
            .map(|r| {
                serde_json::from_slice::<serde_json::Value>(&r.body).unwrap()["one_time"].clone()
            })
            .collect();
        assert!(
            flags.is_empty() || flags.len() == 2 && flags[0] == flags[1],
            "{context}: {flags:?}"
        );
    };
    for value in [
        "true", "false", "1", "0", "t", "f", "T", "F", "TRUE", "FALSE", "True", "False",
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
    );
    for value in [
        "true", "false", "1", "0", "T", "yes", "on", "typo", "true ", "2",
    ] {
        check(
            Run {
                args: base.clone(),
                env: vec![("YOPASS_ONE_TIME", value.to_string())],
                stdin: b"x".to_vec(),
                ..Default::default()
            },
            format!("env {value}"),
        );
    }
    for yaml in [
        "true", "false", "yes", "no", "on", "\"true\"", "\"typo\"", "1", "0", "2", "1.5", "~",
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
fn config_files_are_read_identically() {
    let mock = replies(200, r#"{"message":"fixed-id"}"#);
    let u = &mock.url;
    for (file, contents) in [
        ("config.yaml", format!("api: {u}\nurl: {u}\n")),
        (
            "config.yaml",
            format!("api: {u}\nurl: {u}\nexpiration: 1d\n"),
        ),
        (
            "config.yaml",
            format!("api: {u}\nurl: {u}\none-time: false\nexpiration: ~\n"),
        ),
    ] {
        let spec = Run {
            args: args(&["--key=k"]),
            home: Some(config_home(file, &contents)),
            stdin: b"x".to_vec(),
            ..Default::default()
        };
        let output = assert_same(&spec, &format!("{file}: {contents}"));
        assert_eq!(
            output.code,
            Some(0),
            "{file}: {contents}: {}",
            output.stderr
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
        let go = run(go_cli(), &spec);
        let rust = run(RUST, &spec);
        assert_eq!(
            rust.code, go.code,
            "{file} {contents}: {} / {}",
            go.stderr, rust.stderr
        );
        assert_eq!(rust.code, Some(3), "{file} {contents}");
        assert!(
            rust.stderr.starts_with("Yopass config file invalid: "),
            "{}",
            rust.stderr
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
        let output = run(RUST, &spec);
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
        let output = run(RUST, &spec);
        assert_eq!(output.code, Some(0), "{args:?}: {}", output.stderr);
        assert!(!take_requests(&mock).is_empty(), "{args:?}");
    }
    let help = run(
        RUST,
        &Run {
            args: args(&["-h"]),
            ..Default::default()
        },
    );
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
        text(&assert_same(&spec, "precedence"))
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

#[test]
fn decrypt_urls_are_judged_identically() {
    let mock = mock(|_| {
        (
            404,
            Vec::new(),
            br#"{"message":"Secret not found"}"#.to_vec(),
        )
    });
    let host = mock.url.trim_start_matches("http://").to_string();
    let base = mock.url.clone();
    let mut links: Vec<String> = [
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
    .map(|s| s.to_string())
    .collect();
    for suffix in [
        "/#/s/id/key",
        "/#/c/id",
        "/#/f/id/key",
        "/#/d/id",
        "/#/s/id",
        "/#/f/id",
        "#/s/id/key",
        "/#/x/id/key",
        "/#/s",
        "/#/",
        "/#",
        "/",
        "",
        "/#s/id/key",
        "/#/s/id/key/extra",
        "/#/s/id/key/",
        "/#//id/key",
        "/#/s/%2F/key",
        "/#/s/a%20b/key",
        "/#/s/id/k%2Fy",
        "/?q=1#/s/id/key",
        "/?#/s/id/key",
        "//#/s/id/key",
        "///#/s/id/key",
        "/x/#/s/id/key",
        "/%78/#/s/id/key",
        "/#/s/é/key",
        "/#/s/a b/key",
        "/#/s/a\"b/key",
        "/#/s/a?b/key",
        "/#/s/a\\b/key",
        "/#/s/a<b>/key",
        "/#/s/a#b/key",
        "/#/s/..%2F..%2Fadmin/key",
        "/#/s/%00/key",
        "/\n",
    ] {
        links.push(format!("{base}{suffix}"));
        links.push(format!(" {base}{suffix}\n"));
    }
    for variant in [
        format!("HTTP://{host}/#/s/id/key"),
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
        links.push(variant);
    }
    for link in &links {
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
        assert_same_outcome(&spec, "decrypt url");
    }
    for configured in [
        "https://yopass.se",
        "https://yopass.se/",
        "https://YOPASS.SE",
        "https://yopass.se/app",
        "https://yopass.se/app/",
        "yopass.se",
        "https://",
        "not a url",
        "https://u@yopass.se",
        "https://[::1]",
        "https://[::1",
        "HTTPS://yopass.se",
        "https://yopass.se/%zz",
        ":",
    ] {
        for link in [
            "https://yopass.se/#/q",
            "https://yopass.se/app/#/q",
            "https://YOPASS.se/#/q",
            "https://[::1]/#/q",
            "HTTPS://yopass.se/APP/#/q",
        ] {
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
            assert_same_outcome(&spec, "decrypt url");
        }
    }
}

#[test]
fn secret_ids_reach_the_server_identically() {
    let mock = mock(|_| (404, Vec::new(), br#"{"message":"nope"}"#.to_vec()));
    for id in [
        "simple", "a%20b", "a%2Fb", "a%22b", "a%3Cb", "a%5Eb", "%C3%A9", "é", "%FF",
    ] {
        let link = format!("{}/#/s/{id}/key", mock.url);
        let spec = Run {
            args: args(&["--api", &mock.url, "--url", &mock.url, "--decrypt", &link]),
            ..Default::default()
        };
        let output = assert_same_outcome(&spec, "id");
        let requests = take_requests(&mock);
        match requests.as_slice() {
            [] => assert_eq!(output.code, Some(1), "{id}"),
            [go, rust] => assert_eq!(go.path, rust.path, "{id}"),
            other => panic!("{id}: {other:?}"),
        }
    }
}

#[test]
fn secret_ids_stay_one_path_segment() {
    let mock = mock(|_| (404, Vec::new(), br#"{"message":"nope"}"#.to_vec()));
    for (id, path) in [
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
        assert_eq!(run(RUST, &spec).code, Some(1), "{id}");
        let requests = take_requests(&mock);
        assert_eq!(requests.len(), 1, "{id}");
        assert_eq!(requests[0].path, path, "{id}");
    }
    for id in ["", "..", ".", "%2E%2E", "..%2Fadmin"] {
        let link = format!("{}/#/s/{id}/key", mock.url);
        let spec = Run {
            args: args(&["--api", &mock.url, "--url", &mock.url, "--decrypt", &link]),
            ..Default::default()
        };
        assert_eq!(run(RUST, &spec).code, Some(1), "{id}");
        assert!(take_requests(&mock).is_empty(), "{id}");
    }
}

#[test]
fn requests_match_on_the_wire() {
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
    for (extra, stdin) in [
        (vec![], &b"x"[..]),
        (vec!["--api-token", "secret-token"], b"x"),
        (vec!["--api-token", "Bearer secret-token"], b"x"),
        (vec!["--api-token", " bearer  secret-token \n"], b"x"),
        (vec!["--one-time=false", "--expiration", "1d"], b"x"),
        (vec!["--file", path], b""),
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
        ),
        (vec!["--decrypt", "@URL/#/s/fixed-id/key"], b""),
        (
            vec![
                "--decrypt",
                "@URL/#/f/fixed-id/key",
                "--api-token",
                "secret-token",
            ],
            b"",
        ),
    ] {
        let extra: Vec<String> = extra
            .iter()
            .map(|value| value.replace("@URL", &mock.url))
            .collect();
        let mut spec_args = args(&["--api", &mock.url, "--url", &mock.url, "--key", "k"]);
        spec_args.extend(extra.clone());
        let mut all = Vec::new();
        for (_, bin) in binaries() {
            run(
                bin,
                &Run {
                    args: spec_args.clone(),
                    stdin: stdin.to_vec(),
                    ..Default::default()
                },
            );
            all.push(take_requests(&mock));
        }
        let (go, rust) = (&all[0], &all[1]);
        assert_eq!(go.len(), rust.len(), "{extra:?}");
        for (go, rust) in go.iter().zip(rust) {
            assert_eq!(
                (&go.method, &go.path),
                (&rust.method, &rust.path),
                "{extra:?}"
            );
            for header in [
                "authorization",
                "content-type",
                "x-yopass-expiration",
                "x-yopass-onetime",
            ] {
                assert_eq!(
                    go.headers.get(header),
                    rust.headers.get(header),
                    "{header} {extra:?}"
                );
            }
            if go.path.starts_with("/file") {
                assert_eq!(
                    rust.headers.get("accept").map(String::as_str),
                    Some("application/octet-stream")
                );
            }
            if go.path == "/create/secret" {
                let shape = |body: &[u8]| {
                    let mut value: serde_json::Value = serde_json::from_slice(body).unwrap();
                    let message = value["message"].take();
                    assert!(message.as_str().unwrap().starts_with(
                        "-----BEGIN PGP MESSAGE-----\nComment: https://yopass.se\n\n"
                    ));
                    value
                };
                assert_eq!(shape(&go.body), shape(&rust.body), "{extra:?}");
            }
        }
    }
}

#[test]
fn config_endpoint_answers_are_handled_identically() {
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
        assert_same(&spec, config);
        let stored: Vec<String> = take_requests(&mock)
            .iter()
            .filter(|r| r.path == "/create/secret")
            .map(|r| key_derivation(&r.body))
            .collect();
        assert_eq!(stored.len(), 2, "{config}");
        // SKESK starts c3 len 06 cnt 09 03 slen type. Base64 position 8 begins at the
        // S2K length and type: 0b 03 (iterated) is Cw, 14 04 (Argon2) is FA.
        let want = if argon2 { "FA" } else { "Cw" };
        for prefix in stored {
            assert_eq!(&prefix[8..10], want, "{config}: {prefix}");
        }
    }
}

#[test]
fn server_responses_produce_identical_output() {
    let bodies = [
        (404, r#"{"message":"Secret not found"}"#),
        (400, r#"{"message":"bad"}"#),
        (401, r#"{"message":"Unauthorized"}"#),
        (403, "plain forbidden"),
        (500, ""),
        (500, "<html>oops</html>"),
        (500, "[1,2]"),
        (500, "null"),
        (500, r#"{"message":1}"#),
        (500, r#"{"other":"x"}"#),
        (500, r#"{"message":"x"} trailing"#),
        (503, "\"text\""),
        (201, r#"{"message":"created"}"#),
        (204, ""),
        (200, r#"{"message":"id"}"#),
        (200, r#"{"message":null}"#),
        (200, r#"{}"#),
        (200, "null"),
    ];
    let file = scratch().join("responses.txt");
    std::fs::write(&file, "x").unwrap();
    for (status, body) in bodies {
        let mock = replies(status, body);
        let base = args(&["--api", &mock.url, "--url", &mock.url, "--key", "k"]);
        for (mode, extra) in [
            ("store secret", vec![]),
            (
                "store file",
                vec!["--file".to_string(), file.to_str().unwrap().to_string()],
            ),
            (
                "fetch secret",
                vec!["--decrypt".to_string(), format!("{}/#/s/id/key", mock.url)],
            ),
            (
                "fetch file",
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
            // Go takes no ID for success; a_store_without_an_id_is_an_error covers stores.
            if status == 200 && !body.contains(r#""id""#) {
                let output = run(RUST, &spec);
                assert_eq!(output.code, Some(1), "{mode} {body}");
                assert!(output.stdout.is_empty(), "{mode} {body}");
                continue;
            }
            assert_same_outcome(&spec, &format!("{mode} {status} {body}"));
        }
    }
}

#[test]
fn undecodable_success_bodies_fail_with_the_same_prefix() {
    // JSON library wording differs; everything before it does not.
    for body in ["", "<html>", "[1]", "\"text\"", r#"{"message":1}"#] {
        let mock = replies(200, body);
        let spec = Run {
            args: args(&["--api", &mock.url, "--url", &mock.url, "--key", "k"]),
            stdin: b"x".to_vec(),
            ..Default::default()
        };
        let (go, rust) = (run(go_cli(), &spec), run(RUST, &spec));
        assert_eq!((go.code, go.stdout), (rust.code, rust.stdout), "{body}");
        let prefix = "Failed to store secret: could not decode server response";
        assert!(go.stderr.starts_with(prefix), "{}", go.stderr);
        assert!(rust.stderr.starts_with(prefix), "{}", rust.stderr);
    }
}

#[test]
fn transport_failures_share_prefix_and_exit_code() {
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
        let (go, rust) = (run(go_cli(), &spec), run(RUST, &spec));
        assert_eq!((go.code, rust.code), (Some(1), Some(1)));
        assert!(go.stderr.starts_with(prefix), "{}", go.stderr);
        assert!(rust.stderr.starts_with(prefix), "{}", rust.stderr);
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
    let output = run(RUST, &spec);
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
    let output = run(RUST, &spec);
    assert_eq!(output.code, Some(1));
    assert!(!output.stderr.contains("LINKKEY"), "{}", output.stderr);
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
            let output = run(RUST, &spec);
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
fn empty_files_and_go_empty_secrets_round_trip() {
    let server = Server::start(false);
    let file = scratch().join("empty.txt");
    std::fs::write(&file, b"").unwrap();
    let path = file.to_str().unwrap();
    let mut links: Vec<String> = binaries()
        .iter()
        .map(|(_, bin)| share(bin, &server.url, &["--file", path], b""))
        .collect();
    links.push(share(go_cli(), &server.url, &[], b""));
    for link in links {
        let output = fetch(RUST, &server.url, &link, &[]);
        assert_eq!(output.code, Some(0), "{link}: {}", output.stderr);
        assert!(output.stdout.is_empty(), "{link}");
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
        assert_eq!(run(RUST, &spec).code, Some(3), "{setting}");
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
    assert_eq!(text(&run(RUST, &spec)), format!("{u}/#/s/fixed-id"));
    let file = scratch().join("env-file.txt");
    std::fs::write(&file, "x").unwrap();
    let spec = Run {
        env: with("YOPASS_FILE", file.to_str().unwrap().to_string()),
        ..Default::default()
    };
    assert!(text(&run(RUST, &spec)).contains("/#/f/fixed-id/"));
    take_requests(&mock);
    let spec = Run {
        env: with("YOPASS_DECRYPT", format!("{u}/#/s/some-id/key")),
        ..Default::default()
    };
    assert_eq!(run(RUST, &spec).code, Some(1));
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
        let output = run(RUST, &spec);
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
    assert_eq!(run(RUST, &spec).code, Some(3));
    let home = config_home(
        "config.yaml",
        &format!("api: {u}\nurl: https://from-config.example\napi-token: \"s3cret\"\n"),
    );
    let spec = Run {
        home: Some(home),
        stdin: b"x".to_vec(),
        ..Default::default()
    };
    let output = run(RUST, &spec);
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
fn empty_stdin_is_an_error() {
    let mock = replies(200, r#"{"message":"id"}"#);
    let spec = Run {
        args: args(&["--api", &mock.url, "--url", &mock.url]),
        ..Default::default()
    };
    let output = run(RUST, &spec);
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
        let output = run(RUST, &spec);
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
        run(RUST, &spec);
        assert_eq!(!take_requests(&proxy).is_empty(), expected, "{env:?}");
    }
}

// ---- Ciphertext from other implementations ----

fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures")
            .join(name),
    )
    .unwrap()
}

/// Serves `ciphertext` and compares what each CLI makes of it.
fn compare_decrypt(ciphertext: &[u8], key: &str, context: &str) -> Output {
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
    let file = Run {
        args: args(&[
            "--api",
            &mock.url,
            "--url",
            &mock.url,
            "--decrypt",
            &format!("{}/#/f/id/{key}", mock.url),
        ]),
        ..Default::default()
    };
    let output = assert_same(&file, context);
    if std::str::from_utf8(ciphertext).is_ok() {
        let secret = Run {
            args: args(&[
                "--api",
                &mock.url,
                "--url",
                &mock.url,
                "--decrypt",
                &format!("{}/#/s/id/{key}", mock.url),
            ]),
            ..Default::default()
        };
        assert_same(&secret, context);
    }
    output
}

fn compare_decrypt_outcome(ciphertext: &[u8], key: &str, context: &str) -> Output {
    let raw = ciphertext.to_vec();
    let mock = mock(move |_| (200, Vec::new(), raw.clone()));
    let link = format!("{}/#/f/id/{key}", mock.url);
    let spec = Run {
        args: args(&["--api", &mock.url, "--url", &mock.url, "--decrypt", &link]),
        ..Default::default()
    };
    assert_same_outcome(&spec, context)
}

#[test]
fn gnupg_messages_decrypt_identically() {
    for (name, want) in [
        ("gpg-default.asc", "gpg default secret\n"),
        ("gpg-zlib.asc", "gpg zlib secret\n"),
        ("gpg-signed.asc", "gpg signed secret\n"),
        ("gpg-signed-uncompressed.asc", "gpg signed plain\n"),
        ("go-zlib.asc", "go compressed secret\n"),
        ("gpg-text.asc", "text mode\r\nline two\r\n"),
    ] {
        let output = compare_decrypt(&fixture(name), "fixture-key", name);
        assert_eq!(
            String::from_utf8_lossy(&output.stdout),
            want,
            "{name}: {}",
            output.stderr
        );
        let wrong = compare_decrypt(&fixture(name), "wrong-key", name);
        assert_eq!(wrong.code, Some(1), "{name}");
        assert!(wrong.stdout.is_empty(), "{name}");
    }
}

#[test]
fn gnupg_ocb_is_refused() {
    let output = compare_decrypt_outcome(&fixture("gpg-ocb.asc"), "fixture-key", "ocb");
    assert_eq!(output.code, Some(1));
    assert!(output.stdout.is_empty());
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
fn armor_variations_decrypt_identically() {
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
    for (context, message) in [
        ("as is", original.clone()),
        ("trailing newlines", format!("{original}\n\n")),
        ("trailing text", format!("{original}trailing text\n")),
        ("crlf", original.replace('\n', "\r\n")),
        ("no crc", without_crc.join("\n")),
        ("bad crc", bad_crc.join("\n")),
        ("leading whitespace", format!("  {original}")),
        ("leading newline", format!("\n{original}")),
        ("truncated", original[..original.len() / 2].to_string()),
        ("header only", "-----BEGIN PGP MESSAGE-----\n\n".to_string()),
        (
            "wrong block",
            original.replace("PGP MESSAGE", "PGP SIGNATURE"),
        ),
    ] {
        compare_decrypt(message.as_bytes(), "fixture-key", context);
    }
}

#[test]
fn hostile_binary_messages_are_refused_identically() {
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
        let output = compare_decrypt(&message, "key", context);
        assert_eq!(output.code, Some(1), "{context}");
        assert!(output.stdout.is_empty(), "{context}");
    }
}

#[test]
fn unknown_aead_is_refused_without_a_panic() {
    // Valid v6 SKESK framing with an AEAD id rPGP has no parameters for.
    let mut message = vec![0xc3, 0x1a + 2, 6, 26, 9, 99, 11, 3, 8];
    message.extend([0; 9]);
    message.extend([0xd2, 38, 2, 9, 99, 12]);
    message.extend([0; 34]);
    let spec_output = compare_decrypt(&message, "key", "unknown aead");
    assert_eq!(spec_output.code, Some(1));
    assert!(!spec_output.stderr.contains("panicked"));
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
        run(
            RUST,
            &Run {
                args: base.clone(),
                stdin: data.clone(),
                ..Default::default()
            },
        );
        let path = scratch().join("to website.bin");
        std::fs::write(&path, &data).unwrap();
        let mut file_args = base.clone();
        file_args.extend(args(&["--file", path.to_str().unwrap()]));
        run(
            RUST,
            &Run {
                args: file_args,
                ..Default::default()
            },
        );

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
        let output = compare_decrypt(&message, "js-key", extra);
        assert_eq!(output.stdout, data, "{extra}: {}", output.stderr);
    }
}
