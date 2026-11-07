//! Runs ../install.sh with fake `curl` and `uname` commands, so no network is used.
#![cfg(unix)]

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicUsize, Ordering};

const FAKE_CURL: &str = r#"#!/bin/sh
while [ $# -gt 0 ]; do
    case "$1" in
        -o) out=$2; shift ;;
        -fsSLI) head=1 ;;
        *) url=$1 ;;
    esac
    shift
done
if [ -n "${head:-}" ]; then
    echo "https://github.com/jhaals/yopass/releases/tag/9.9.9"
    exit 0
fi
echo "$url" >>"$RELEASE/requested"
cp "$RELEASE/${url##*/}" "$out" 2>/dev/null || exit 22
"#;

struct Fixture {
    root: PathBuf,
}

static NEXT: AtomicUsize = AtomicUsize::new(0);

fn executable(path: &Path, contents: &str) {
    std::fs::write(path, contents).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

impl Fixture {
    /// A release of `version` for linux/amd64, with a matching checksum file.
    fn new(version: &str) -> Self {
        let root = Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!(
            "install-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        let (fake, release) = (root.join("fake"), root.join("release"));
        std::fs::create_dir_all(&fake).unwrap();
        std::fs::create_dir_all(&release).unwrap();
        executable(&fake.join("curl"), FAKE_CURL);
        executable(
            &fake.join("uname"),
            "#!/bin/sh\ncase \"$1\" in -s) echo \"${FAKE_OS:-Linux}\" ;; -m) echo \"${FAKE_ARCH:-x86_64}\" ;; esac\n",
        );
        executable(&release.join("yopass"), "new binary\n");
        let archive = format!("yopass_{version}_linux_amd64.tar.gz");
        let script = format!(
            "tar -czf {archive} yopass && rm yopass && \
             {{ sha256sum {archive} 2>/dev/null || shasum -a 256 {archive}; }} > yopass_{version}_checksums.txt"
        );
        let status = Command::new("sh")
            .args(["-c", &script])
            .current_dir(&release)
            .status()
            .unwrap();
        assert!(status.success());
        Self { root }
    }

    fn release(&self, name: &str) -> PathBuf {
        self.root.join("release").join(name)
    }

    fn installed(&self) -> PathBuf {
        self.root.join("bin/yopass")
    }

    fn run(&self, env: &[(&str, &str)]) -> Output {
        let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("../install.sh");
        // With /sbin, as on a real Mac, whose sha256sum differs from GNU's.
        let path = format!("{}:/usr/bin:/bin:/sbin", self.root.join("fake").display());
        Command::new("sh")
            .arg(script)
            .env_clear()
            .env("PATH", path)
            .env("HOME", &self.root)
            .env("RELEASE", self.root.join("release"))
            .env("YOPASS_INSTALL_DIR", self.root.join("bin"))
            .envs(env.iter().copied())
            .output()
            .unwrap()
    }
}

fn assert_failed(output: &Output, message: &str) {
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert_eq!(output.status.code(), Some(1), "{stderr}");
    assert!(stderr.contains(message), "{stderr}");
}

#[test]
fn installs_the_latest_release() {
    let fixture = Fixture::new("9.9.9");
    let output = fixture.run(&[]);
    assert!(output.status.success(), "{output:?}");
    assert_eq!(
        std::fs::read_to_string(fixture.installed()).unwrap(),
        "new binary\n"
    );
    let mode = std::fs::metadata(fixture.installed())
        .unwrap()
        .permissions();
    assert_eq!(mode.mode() & 0o777, 0o755);
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("is not in your PATH"), "{stdout}");
}

#[test]
fn a_pinned_version_keeps_its_tag_in_the_url_only() {
    let fixture = Fixture::new("8.0.0");
    let output = fixture.run(&[("YOPASS_VERSION", "v8.0.0")]);
    assert!(output.status.success(), "{output:?}");
    let requested = std::fs::read_to_string(fixture.release("requested")).unwrap();
    assert!(
        requested.contains("/download/v8.0.0/yopass_8.0.0_linux_amd64.tar.gz"),
        "{requested}"
    );
}

#[test]
fn a_tampered_archive_installs_nothing_and_keeps_the_old_binary() {
    let fixture = Fixture::new("9.9.9");
    std::fs::create_dir_all(fixture.installed().parent().unwrap()).unwrap();
    std::fs::write(fixture.installed(), "old binary\n").unwrap();
    std::fs::write(fixture.release("yopass_9.9.9_linux_amd64.tar.gz"), "evil").unwrap();
    assert_failed(&fixture.run(&[]), "checksum mismatch");
    assert_eq!(
        std::fs::read_to_string(fixture.installed()).unwrap(),
        "old binary\n"
    );
}

#[test]
fn a_malformed_checksum_is_refused() {
    let fixture = Fixture::new("9.9.9");
    std::fs::write(
        fixture.release("yopass_9.9.9_checksums.txt"),
        "abc  yopass_9.9.9_linux_amd64.tar.gz\n",
    )
    .unwrap();
    assert_failed(&fixture.run(&[]), "checksum mismatch");
    assert!(!fixture.installed().exists());
}

#[test]
fn a_failed_install_leaves_nothing_behind() {
    let fixture = Fixture::new("9.9.9");
    executable(&fixture.root.join("fake/mv"), "#!/bin/sh\nexit 1\n");
    assert_failed(&fixture.run(&[]), "could not write to");
    let left: Vec<_> = std::fs::read_dir(fixture.root.join("bin"))
        .unwrap()
        .collect();
    assert!(left.is_empty(), "{left:?}");
}

#[test]
fn a_directory_at_the_destination_is_refused() {
    let fixture = Fixture::new("9.9.9");
    std::fs::create_dir_all(fixture.installed()).unwrap();
    assert_failed(&fixture.run(&[]), "is a directory");
}

#[test]
fn a_trailing_slash_in_the_install_dir_is_ignored() {
    let fixture = Fixture::new("9.9.9");
    let bin = fixture.root.join("bin");
    let dir = format!("{}/", bin.display());
    let path = format!(
        "{}:{}:/usr/bin:/bin:/sbin",
        fixture.root.join("fake").display(),
        bin.display()
    );
    let output = fixture.run(&[("YOPASS_INSTALL_DIR", &dir), ("PATH", &path)]);
    assert!(output.status.success(), "{output:?}");
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(!stdout.contains("not in your PATH"), "{stdout}");
    assert!(!stdout.contains("//yopass"), "{stdout}");
}

#[test]
fn an_archive_missing_from_the_checksums_is_refused() {
    let fixture = Fixture::new("9.9.9");
    std::fs::write(
        fixture.release("yopass_9.9.9_checksums.txt"),
        "abc  yopass_9.9.9_linux_arm64.tar.gz\n",
    )
    .unwrap();
    assert_failed(&fixture.run(&[]), "no checksum listed");
    assert!(!fixture.installed().exists());
}

#[test]
fn a_missing_download_fails() {
    let fixture = Fixture::new("9.9.9");
    std::fs::remove_file(fixture.release("yopass_9.9.9_checksums.txt")).unwrap();
    assert_failed(&fixture.run(&[]), "could not download");
    assert!(!fixture.installed().exists());
}

#[test]
fn unsupported_platforms_are_refused() {
    let fixture = Fixture::new("9.9.9");
    assert_failed(
        &fixture.run(&[("FAKE_OS", "FreeBSD")]),
        "unsupported system",
    );
    assert_failed(
        &fixture.run(&[("FAKE_ARCH", "riscv64")]),
        "unsupported architecture",
    );
    assert!(!fixture.installed().exists());
}
