//! The S3 file store against an in-process S3: the store itself, its expiry
//! sweep, and the file endpoints running on it.

mod common;

use aws_sdk_s3::config::{BehaviorVersion, Credentials, Region, StalledStreamProtectionConfig};
use bytes::Bytes;
use common::fake_s3::{ACCESS_KEY, BUCKET, FakeS3, SECRET_KEY};
use common::*;
use futures_util::{StreamExt, stream};
use std::io;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};
use tokio_util::sync::CancellationToken;
use yopass_server::app::STREAM_KEY_PREFIX;
use yopass_server::files::s3::S3FileStore;
use yopass_server::files::{BodyTooLarge, ByteStream, FileError, FileStore};
use yopass_server::handlers::is_too_large;
use yopass_server::util::redact_secret_id;

const KEY: &str = "AbCdEf0123456789GhIjKl";

fn client(fake: &FakeS3, secret: &str) -> aws_sdk_s3::Client {
    let config = aws_sdk_s3::Config::builder()
        .behavior_version(BehaviorVersion::latest())
        .region(Region::new("us-east-1"))
        .credentials_provider(Credentials::new(ACCESS_KEY, secret, None, None, "test"))
        .endpoint_url(&fake.url)
        .force_path_style(true)
        .build();
    aws_sdk_s3::Client::from_conf(config)
}

fn store(fake: &FakeS3, prefix: &str) -> S3FileStore {
    S3FileStore::with_client(client(fake, SECRET_KEY), BUCKET, prefix)
}

fn body(chunks: &[&'static [u8]]) -> ByteStream {
    let chunks: Vec<io::Result<Bytes>> = chunks.iter().map(|c| Ok(Bytes::from_static(c))).collect();
    Box::pin(stream::iter(chunks))
}

async fn collect(mut stream: ByteStream) -> Vec<u8> {
    let mut out = Vec::new();
    while let Some(chunk) = stream.next().await {
        out.extend_from_slice(&chunk.unwrap());
    }
    out
}

fn http_date(at: SystemTime) -> String {
    httpdate::fmt_http_date(at)
}

fn hour_ago() -> String {
    http_date(SystemTime::now() - Duration::from_secs(3600))
}

fn hour_ahead() -> String {
    http_date(SystemTime::now() + Duration::from_secs(3600))
}

#[tokio::test]
async fn saves_loads_and_deletes_under_the_prefix() {
    let fake = FakeS3::start().await;
    for prefix in ["yopass/", ""] {
        let store = store(&fake, prefix);
        let object = format!("{prefix}{KEY}");
        store
            .save(KEY, body(&[b"\xc3\x04", b"da", b"ta"]), Some(6), 3600)
            .await
            .unwrap();
        assert_eq!(fake.object(&object).unwrap().data, b"\xc3\x04data");
        let (stream, size) = store.load(KEY).await.unwrap();
        assert_eq!(size, 6);
        assert_eq!(collect(stream).await, b"\xc3\x04data");
        store.delete(KEY).await.unwrap();
        assert!(fake.object(&object).is_none());
        assert!(matches!(store.load(KEY).await, Err(FileError::NotFound)));
        // Deleting what is gone is not an error, as with S3 itself.
        store.delete(KEY).await.unwrap();
    }
}

#[tokio::test]
async fn the_lifetime_is_an_expires_header_never_a_tag() {
    let fake = FakeS3::start().await;
    store(&fake, "yopass/")
        .save(KEY, body(&[b"data"]), Some(4), 3600)
        .await
        .unwrap();
    let expires = fake
        .object(&format!("yopass/{KEY}"))
        .unwrap()
        .expires
        .unwrap();
    let expires = httpdate::parse_http_date(&expires).unwrap();
    let expected = SystemTime::now() + Duration::from_secs(3600);
    let skew = expires
        .duration_since(expected)
        .unwrap_or_else(|e| e.duration());
    assert!(skew < Duration::from_secs(5), "{skew:?}");
    let put = &fake.ops("put")[0];
    assert!(!put.headers.contains_key("x-amz-tagging"));
}

#[tokio::test]
async fn an_upload_is_held_to_its_declared_length() {
    let fake = FakeS3::start().await;
    let store = store(&fake, "");
    for (declared, chunks) in [
        (5, &[b"da".as_slice(), b"ta"] as &[&[u8]]),
        (3, &[b"da", b"ta"]),
    ] {
        let chunks: Vec<io::Result<Bytes>> = chunks
            .iter()
            .map(|c| Ok(Bytes::copy_from_slice(c)))
            .collect();
        let error = store
            .save(KEY, Box::pin(stream::iter(chunks)), Some(declared), 60)
            .await
            .unwrap_err();
        assert!(matches!(error, FileError::Read(_)), "{declared}: {error}");
        assert!(fake.keys().is_empty(), "{declared}");
    }
}

#[tokio::test]
async fn a_failing_upload_stream_keeps_its_own_error() {
    let fake = FakeS3::start().await;
    let chunks: Vec<io::Result<Bytes>> = vec![
        Ok(Bytes::from_static(b"da")),
        Err(io::Error::other(BodyTooLarge)),
    ];
    let error = store(&fake, "")
        .save(KEY, Box::pin(stream::iter(chunks)), Some(4), 60)
        .await
        .unwrap_err();
    assert!(
        matches!(&error, FileError::Read(read) if is_too_large(read)),
        "{error}"
    );
    assert!(fake.keys().is_empty());
}

#[tokio::test]
async fn an_upload_without_a_length_is_refused_before_reading_it() {
    // S3 needs the length of a streamed upload, as it does for the Go server.
    let fake = FakeS3::start().await;
    let read = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let seen = read.clone();
    let body: ByteStream = Box::pin(stream::once(async move {
        seen.store(true, std::sync::atomic::Ordering::SeqCst);
        Ok(Bytes::from_static(b"data"))
    }));
    let error = store(&fake, "")
        .save(KEY, body, None, 60)
        .await
        .unwrap_err();
    assert!(matches!(error, FileError::Storage(_)), "{error}");
    assert!(!read.load(std::sync::atomic::Ordering::SeqCst));
    assert!(fake.keys().is_empty());
}

#[tokio::test]
async fn a_pausing_upload_is_not_cut_off_by_the_sdk() {
    // The SDK's stalled-stream check would end it; the transfer deadline
    // bounds uploads instead.
    let fake = FakeS3::start().await;
    let config = client(&fake, SECRET_KEY)
        .config()
        .to_builder()
        .stalled_stream_protection(
            StalledStreamProtectionConfig::enabled()
                .grace_period(Duration::from_millis(200))
                .build(),
        )
        .build();
    let store = S3FileStore::with_client(aws_sdk_s3::Client::from_conf(config), BUCKET, "");
    let paused: ByteStream = Box::pin(stream::iter([b"da".as_slice(), b"ta"]).then(
        |chunk| async move {
            tokio::time::sleep(Duration::from_millis(1500)).await;
            Ok(Bytes::from_static(chunk))
        },
    ));
    store.save(KEY, paused, Some(4), 60).await.unwrap();
    assert_eq!(fake.object(KEY).unwrap().data, b"data");
}

#[tokio::test]
async fn a_download_without_a_length_is_still_served() {
    let fake = FakeS3::start().await;
    fake.state().unsized_gets = true;
    let harness = s3_harness(&fake, None);
    let key = harness.send(sized_upload(false)).await.message();
    let (stream, size) = store(&fake, "yopass/").load(&key).await.unwrap();
    assert_eq!(size, 0);
    assert_eq!(collect(stream).await, PGP_BINARY);
    let download = harness.get(&format!("/file/{key}")).await;
    assert_eq!(download.status, 200);
    assert_eq!(download.body, PGP_BINARY);
}

#[tokio::test]
async fn only_a_missing_key_is_not_found() {
    let fake = FakeS3::start().await;
    fake.put(KEY, b"data", None);
    let wrong_bucket = S3FileStore::with_client(client(&fake, SECRET_KEY), "other-bucket", "");
    let denied = S3FileStore::with_client(
        aws_sdk_s3::Client::from_conf(
            aws_sdk_s3::Config::builder()
                .behavior_version(BehaviorVersion::latest())
                .region(Region::new("us-east-1"))
                .credentials_provider(Credentials::new("other", "x", None, None, "test"))
                .endpoint_url(&fake.url)
                .force_path_style(true)
                .build(),
        ),
        BUCKET,
        "",
    );
    for (name, store) in [("bucket", &wrong_bucket), ("denied", &denied)] {
        let error = store.load(KEY).await.err().unwrap();
        assert!(matches!(error, FileError::Storage(_)), "{name}: {error}");
        assert!(store.health().await.is_err(), "{name}");
        assert!(store.delete(KEY).await.is_err(), "{name}");
        assert!(store.save(KEY, body(&[b"x"]), Some(1), 60).await.is_err());
    }
    fake.state().fail.insert(("get", None));
    let error = store(&fake, "").load(KEY).await.err().unwrap();
    assert!(matches!(error, FileError::Storage(_)), "{error}");
}

#[tokio::test]
async fn health_checks_the_bucket() {
    let fake = FakeS3::start().await;
    let store = store(&fake, "yopass/");
    store.health().await.unwrap();
    fake.state().fail.insert(("head_bucket", None));
    let error = store.health().await.unwrap_err();
    assert!(
        error.to_string().contains("s3 health check failed"),
        "{error}"
    );
}

#[tokio::test]
async fn stalled_calls_time_out() {
    let fake = FakeS3::start().await;
    let store = store(&fake, "").call_timeout(Duration::from_millis(200));
    fake.put(KEY, b"data", None);
    for op in ["get", "head_bucket", "delete"] {
        fake.state().stall.insert(op);
        let started = Instant::now();
        let error = match op {
            "get" => store.load(KEY).await.err().unwrap(),
            "head_bucket" => store.health().await.unwrap_err(),
            _ => store.delete(KEY).await.unwrap_err(),
        };
        assert!(error.to_string().contains("timed out"), "{op}: {error}");
        assert!(started.elapsed() < Duration::from_secs(5), "{op}");
        fake.state().stall.remove(op);
    }
}

/// An expired object under the prefix in each date format the Go server reads,
/// plus objects that must survive.
fn seed_for_cleanup(fake: &FakeS3) {
    let past = SystemTime::now() - Duration::from_secs(3600);
    let format = |description: &str| {
        let description = time::format_description::parse_borrowed::<2>(description).unwrap();
        time::OffsetDateTime::from(past)
            .format(&description)
            .unwrap()
    };
    let rfc850 = format(
        "[weekday], [day]-[month repr:short]-[year repr:last_two] [hour]:[minute]:[second] GMT",
    );
    let asctime = format(
        "[weekday repr:short] [month repr:short] [day padding:space] [hour]:[minute]:[second] [year]",
    );
    fake.put("yopass/expired-imf", b"x", Some(&hour_ago()));
    fake.put("yopass/expired-rfc850", b"x", Some(&rfc850));
    fake.put("yopass/expired-asctime", b"x", Some(&asctime));
    fake.put("yopass/fresh", b"x", Some(&hour_ahead()));
    fake.put("yopass/no-expires", b"x", None);
    fake.put("yopass/invalid-expires", b"x", Some("soon"));
    fake.put("other/expired", b"x", Some(&hour_ago()));
}

const SURVIVORS: [&str; 4] = [
    "other/expired",
    "yopass/fresh",
    "yopass/invalid-expires",
    "yopass/no-expires",
];

#[tokio::test]
async fn cleanup_deletes_only_expired_objects_under_the_prefix() {
    for page_size in [0, 1, 2] {
        let fake = FakeS3::start().await;
        fake.state().page_size = page_size;
        seed_for_cleanup(&fake);
        store(&fake, "yopass/").cleanup_expired().await;
        assert_eq!(fake.keys(), SURVIVORS, "page size {page_size}");
    }
}

#[tokio::test]
async fn cleanup_carries_on_past_failed_objects_and_retries_them_later() {
    let fake = FakeS3::start().await;
    fake.state().page_size = 2;
    for key in ["yopass/a", "yopass/b", "yopass/c"] {
        fake.put(key, b"x", Some(&hour_ago()));
    }
    {
        let mut state = fake.state();
        state.fail.insert(("head", Some("yopass/a".into())));
        state.fail.insert(("delete", Some("yopass/b".into())));
    }
    let store = store(&fake, "yopass/");
    store.cleanup_expired().await;
    assert_eq!(fake.keys(), ["yopass/a", "yopass/b"]);
    fake.state().fail.clear();
    store.cleanup_expired().await;
    assert!(fake.keys().is_empty());
}

#[tokio::test]
async fn a_failed_listing_deletes_nothing() {
    let fake = FakeS3::start().await;
    fake.put("yopass/a", b"x", Some(&hour_ago()));
    fake.state().fail.insert(("list", None));
    store(&fake, "yopass/").cleanup_expired().await;
    assert_eq!(fake.keys(), ["yopass/a"]);
}

#[tokio::test]
async fn a_stalled_sweep_call_does_not_wedge_cleanup() {
    for op in ["list", "head", "delete"] {
        let fake = FakeS3::start().await;
        fake.put("yopass/a", b"x", Some(&hour_ago()));
        let store = store(&fake, "yopass/").call_timeout(Duration::from_millis(200));
        fake.state().stall.insert(op);
        tokio::time::timeout(Duration::from_secs(5), store.cleanup_expired())
            .await
            .unwrap_or_else(|_| panic!("{op}: sweep hung"));
        assert_eq!(fake.keys(), ["yopass/a"], "{op}");
        fake.state().stall.clear();
        store.cleanup_expired().await;
        assert!(fake.keys().is_empty(), "{op}: a later sweep must retry");
    }
}

#[tokio::test]
async fn cleanup_logs_fingerprints_not_keys() {
    let logs = captured_logs();
    let fake = FakeS3::start().await;
    let id = "LogRedaction0123456789";
    let object = format!("yopass/{id}");
    fake.put(&object, b"x", Some(&hour_ago()));
    fake.state().fail.insert(("delete", None));
    store(&fake, "yopass/").cleanup_expired().await;
    // The SDK's own debug logs are filtered in production; see `log_filter`.
    let ours: Vec<String> = logs
        .text()
        .lines()
        .filter(|line| line.contains(r#""target":"yopass_server"#))
        .map(str::to_owned)
        .collect();
    assert!(
        ours.iter().any(|l| l.contains(&redact_secret_id(id))),
        "{ours:?}"
    );
    assert!(!ours.iter().any(|l| l.contains(id)), "{ours:?}");
}

#[tokio::test]
async fn the_sweeper_runs_on_its_interval_and_stops_mid_sweep() {
    let fake = FakeS3::start().await;
    fake.put("yopass/a", b"x", Some(&hour_ago()));
    let stop = CancellationToken::new();
    let task =
        tokio::spawn(store(&fake, "yopass/").run_cleanup(Duration::from_millis(20), stop.clone()));
    let swept = fake.clone();
    eventually("the sweeper deletes the expired object", async || {
        swept.keys().is_empty()
    })
    .await;
    // A cancelled sweep in flight does not hold up shutdown.
    let before = fake.ops("list").len();
    fake.state().stall.insert("list");
    let stalled = fake.clone();
    eventually("a sweep is in flight", async || {
        stalled.ops("list").len() > before
    })
    .await;
    stop.cancel();
    tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .expect("the sweeper stops")
        .unwrap();
}

// The file endpoints on an S3 store.

fn s3_harness(fake: &FakeS3, transfer_timeout: Option<Duration>) -> Harness {
    Builder::new()
        .files(Arc::new(store(fake, "yopass/")))
        .settings(|s| s.file_transfer_timeout = transfer_timeout)
        .build()
}

fn sized_upload(one_time: bool) -> Req {
    upload_req(PGP_BINARY, "3600", one_time).header("content-length", &PGP_BINARY.len().to_string())
}

#[tokio::test]
async fn files_round_trip_through_s3() {
    let fake = FakeS3::start().await;
    let harness = s3_harness(&fake, Some(Duration::from_secs(60)));
    for one_time in [true, false] {
        let response = harness.send(sized_upload(one_time)).await;
        assert_eq!(response.status, 200, "{}", response.text());
        let key = response.message();
        let object = format!("yopass/{key}");
        assert_eq!(fake.object(&object).unwrap().data, PGP_BINARY);
        let download = harness.get(&format!("/file/{key}")).await;
        assert_eq!(download.status, 200);
        assert_eq!(download.body, PGP_BINARY);
        assert_eq!(
            download.header("content-length"),
            Some(PGP_BINARY.len().to_string().as_str())
        );
        if one_time {
            eventually("the delivered blob is removed", async || {
                fake.object(&object).is_none()
            })
            .await;
            assert_eq!(harness.get(&format!("/file/{key}")).await.status, 404);
        } else {
            assert_eq!(harness.get(&format!("/file/{key}")).await.status, 200);
            assert_eq!(harness.delete(&format!("/file/{key}")).await.status, 204);
            assert!(fake.object(&object).is_none());
        }
    }
}

#[tokio::test]
async fn an_unreachable_bucket_keeps_a_one_time_file_retryable() {
    let fake = FakeS3::start().await;
    let harness = s3_harness(&fake, None);
    let key = harness.send(sized_upload(true)).await.message();
    fake.state().fail.insert(("get", None));
    let response = harness.get(&format!("/file/{key}")).await;
    assert_eq!(response.status, 503, "{}", response.text());
    fake.state().fail.clear();
    let response = harness.get(&format!("/file/{key}")).await;
    assert_eq!(response.status, 200);
    assert_eq!(response.body, PGP_BINARY);
}

#[tokio::test]
async fn a_vanished_object_is_not_found_and_its_metadata_cleaned_up() {
    let fake = FakeS3::start().await;
    let harness = s3_harness(&fake, None);
    let key = harness.send(sized_upload(false)).await.message();
    fake.state().objects.clear();
    assert_eq!(harness.get(&format!("/file/{key}")).await.status, 404);
    assert!(
        harness
            .app
            .db
            .status(&format!("{STREAM_KEY_PREFIX}{key}"))
            .await
            .is_err()
    );
}

#[tokio::test]
async fn a_failed_put_is_a_server_error_and_is_cleaned_up() {
    let fake = FakeS3::start().await;
    let harness = s3_harness(&fake, None);
    fake.state().fail.insert(("put", None));
    let response = harness.send(sized_upload(false)).await;
    assert_eq!(response.status, 500);
    assert_eq!(response.json()["message"], "Failed to store file");
    // A failed response does not prove the store rejected the write.
    assert!(!fake.ops("delete").is_empty());
}

#[tokio::test]
async fn a_stalled_put_ends_at_the_transfer_deadline() {
    let fake = FakeS3::start().await;
    let harness = s3_harness(&fake, Some(Duration::from_millis(300)));
    fake.state().stall.insert("put");
    let started = Instant::now();
    let response = tokio::time::timeout(Duration::from_secs(10), harness.send(sized_upload(false)))
        .await
        .expect("the upload must not outlive its deadline");
    assert_eq!(response.status, 500);
    assert!(started.elapsed() < Duration::from_secs(5));
}

#[tokio::test]
async fn an_oversized_upload_never_reaches_the_bucket() {
    let fake = FakeS3::start().await;
    let harness = Builder::new()
        .files(Arc::new(store(&fake, "yopass/")))
        .settings(|s| s.max_file_size = 4)
        .build();
    let response = harness.send(sized_upload(false)).await;
    assert_eq!(response.status, 413);
    assert!(fake.ops("put").is_empty());
}

#[tokio::test]
async fn readiness_follows_the_bucket() {
    let fake = FakeS3::start().await;
    let harness = s3_harness(&fake, None);
    assert_eq!(harness.get("/ready").await.status, 200);
    fake.state().fail.insert(("head_bucket", None));
    assert_eq!(harness.get("/ready").await.status, 503);
}

// The binary: credentials from the environment, the endpoint flags, the sweeper.

struct Process(std::process::Child);

/// Stops the server gracefully, so it shuts down its sweeper and writes its
/// coverage profile, and kills it if that takes too long.
impl Drop for Process {
    fn drop(&mut self) {
        let pid = rustix::process::Pid::from_child(&self.0);
        let _ = rustix::process::kill_process(pid, rustix::process::Signal::TERM);
        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(10) {
            if let Ok(Some(status)) = self.0.try_wait() {
                assert!(status.success(), "the server failed to shut down: {status}");
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let _ = self.0.kill();
        let _ = self.0.wait();
        panic!("the server did not shut down");
    }
}

/// The binary needs a real database; `None` skips the test.
fn database_args() -> Option<Vec<String>> {
    if let Some(address) = memcached_addr() {
        return Some(vec![format!("--memcached={address}")]);
    }
    let url = redis_url()?;
    Some(vec!["--database=redis".into(), format!("--redis={url}")])
}

async fn spawn_server(fake: &FakeS3, db: &[String], extra: &[&str]) -> (Process, String) {
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let mut command = std::process::Command::new(env!("CARGO_BIN_EXE_yopass-server"));
    command
        .env_clear()
        .envs(fake.env())
        .args(fake.args("yopass/"))
        .args(db)
        .args(["--address=127.0.0.1", "--asset-path=", "--log-level=error"])
        .arg(format!("--port={port}"))
        .args(extra)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    // Coverage runs collect from child processes through this variable.
    if let Some(profile) = std::env::var_os("LLVM_PROFILE_FILE") {
        command.env("LLVM_PROFILE_FILE", profile);
    }
    let process = Process(command.spawn().unwrap());
    let base = format!("http://127.0.0.1:{port}");
    let url = format!("{base}/health");
    eventually("the server starts", async || {
        reqwest::get(&url).await.is_ok()
    })
    .await;
    (process, base)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_server_stores_files_in_s3_and_sweeps_them() {
    let Some(db) = database_args() else {
        eprintln!("skipped: set MEMCACHED or REDIS_URL");
        return;
    };
    let fake = FakeS3::start().await;
    fake.put("yopass/expired", b"x", Some(&hour_ago()));
    fake.put("yopass/live", b"x", Some(&hour_ahead()));
    let (_server, base) = spawn_server(&fake, &db, &["--cleanup-interval=1"]).await;
    let client = reqwest::Client::new();
    let ready = client.get(format!("{base}/ready")).send().await.unwrap();
    assert_eq!(ready.status(), 200);
    let created: serde_json::Value = client
        .post(format!("{base}/create/file"))
        .header("content-type", "application/octet-stream")
        .header("x-yopass-expiration", "3600")
        .header("x-yopass-onetime", "false")
        .body(PGP_BINARY)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let key = created["message"].as_str().unwrap();
    assert_eq!(
        fake.object(&format!("yopass/{key}")).unwrap().data,
        PGP_BINARY
    );
    let download = client
        .get(format!("{base}/file/{key}"))
        .send()
        .await
        .unwrap();
    assert_eq!(&download.bytes().await.unwrap()[..], PGP_BINARY);
    let swept = fake.clone();
    eventually("the sweeper removes the expired object", async || {
        swept.object("yopass/expired").is_none()
    })
    .await;
    assert!(fake.object("yopass/live").is_some());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn disabled_cleanup_leaves_expired_objects() {
    let Some(db) = database_args() else {
        eprintln!("skipped: set MEMCACHED or REDIS_URL");
        return;
    };
    let fake = FakeS3::start().await;
    fake.put("yopass/expired", b"x", Some(&hour_ago()));
    let (_server, _) = spawn_server(
        &fake,
        &db,
        &["--cleanup-interval=1", "--disable-file-cleanup"],
    )
    .await;
    tokio::time::sleep(Duration::from_millis(2500)).await;
    assert!(fake.object("yopass/expired").is_some());
    assert!(fake.ops("list").is_empty());
}

#[tokio::test]
async fn requests_signed_with_the_wrong_secret_are_refused() {
    let fake = FakeS3::start().await;
    let wrong = S3FileStore::with_client(client(&fake, "not-the-secret"), BUCKET, "");
    let data: ByteStream = Box::pin(stream::iter([Ok(Bytes::from_static(b"data"))]));
    assert!(wrong.save(KEY, data, Some(4), 60).await.is_err());
    assert!(fake.keys().is_empty());
    // The same request with the right secret goes through.
    let data: ByteStream = Box::pin(stream::iter([Ok(Bytes::from_static(b"data"))]));
    store(&fake, "").save(KEY, data, Some(4), 60).await.unwrap();
    assert_eq!(fake.object(KEY).unwrap().data, b"data");
}
