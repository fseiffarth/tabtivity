//! Codex's release package, fetched ahead of its installer.
//!
//! `install.sh` gives `releases.openai.com` a hard 300 s per asset, keeps
//! nothing of a transfer it gave up on, and falls back to a silent GitHub
//! download. 0.166.0's package is 200 MB, so a line under 670 KB/s cannot pass
//! the first and may sit in the second for an hour (2026-10-30: 480 KB/s, then
//! 50 KB/s, with `Downloading Codex CLI` the last line shown).
//!
//! So the same file is fetched here with no deadline, only a stall limit, with
//! progress in the install log and a `.part` that survives a failed attempt
//! and a restart. It is checked against the digest the release channel
//! publishes and unpacked as `releases/<version>-<target>`, which the
//! installer's `release_dir_is_complete` takes as already installed: it skips
//! its download and does the rest (selection, launcher, pruning) itself.
//!
//! Nothing here is required. A failure is a line in the log, and a package the
//! installer doesn't accept is one it replaces.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use reqwest::{header, StatusCode};

const CHANNEL_URL: &str = "https://releases.openai.com/codex/channels/latest";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const CHANNEL_TIMEOUT: Duration = Duration::from_secs(30);
/// The transfer has no deadline; a read this long without a byte is a stall.
const STALL_TIMEOUT: Duration = Duration::from_secs(60);
/// Attempts in a row that bring no new byte before the installer gets its turn.
const MAX_FRUITLESS: u32 = 4;
const RETRY_PAUSE: Duration = Duration::from_secs(2);
const MAX_PACKAGE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const PROGRESS_STEP: u64 = 20 * 1024 * 1024;
const PART_PREFIX: &str = ".prefetch.";
/// What the installer `chmod`s after unpacking. The package's own modes are
/// right today; this keeps a release of ours the same as one of its own.
const EXECUTABLES: &[&str] = &[
    "bin/codex",
    "bin/codex-code-mode-host",
    "bin/codex-exec-server",
    "codex-path/rg",
    "codex-resources/bwrap",
];

/// One download at a time, across windows: a second caller waits and then finds
/// the release in place.
static ONE_AT_A_TIME: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Debug, PartialEq)]
struct Package {
    version: String,
    asset: String,
    sha256: String,
}

/// The target the installer picks, for the platforms it has a package for.
fn target_for(os: &str, arch: &str) -> Option<&'static str> {
    match (os, arch) {
        ("linux", "x86_64") => Some("x86_64-unknown-linux-musl"),
        ("linux", "aarch64") => Some("aarch64-unknown-linux-musl"),
        ("macos", "x86_64") => Some("x86_64-apple-darwin"),
        ("macos", "aarch64") => Some("aarch64-apple-darwin"),
        _ => None,
    }
}

/// `target`'s package in the release channel's JSON: `tag_name` plus `assets`,
/// each with a `name` and a `digest` of `sha256:<hex>`. The version ends up in
/// a path, so anything but a plain one is refused.
fn parse_channel(body: &str, target: &str) -> Option<Package> {
    let json: serde_json::Value = serde_json::from_str(body).ok()?;
    let version = json["tag_name"].as_str()?.strip_prefix("rust-v")?;
    let plain = version.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-'));
    if !plain || !version.starts_with(|c: char| c.is_ascii_digit()) {
        return None;
    }
    let asset = format!("codex-package-{target}.tar.gz");
    let entry = json["assets"].as_array()?.iter().find(|a| a["name"] == asset.as_str())?;
    let sha256 = entry["digest"].as_str()?.strip_prefix("sha256:")?;
    if sha256.len() != 64 || !sha256.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    Some(Package { version: version.to_string(), asset, sha256: sha256.to_ascii_lowercase() })
}

/// The two hosts the installer reads, in its order.
fn package_urls(package: &Package) -> [String; 2] {
    let Package { version, asset, .. } = package;
    [
        format!("https://releases.openai.com/codex/releases/{version}/{asset}"),
        format!("https://github.com/openai/codex/releases/download/rust-v{version}/{asset}"),
    ]
}

fn megabytes(bytes: u64) -> u64 {
    bytes / (1024 * 1024)
}

fn client() -> Result<reqwest::Client, String> {
    // `reqwest` is built with `rustls-no-provider`; see `app_update::client`.
    crate::services::mail_engine::install_crypto_provider();
    reqwest::Client::builder()
        .user_agent(crate::app_name!())
        .connect_timeout(CONNECT_TIMEOUT)
        .read_timeout(STALL_TIMEOUT)
        .referer(false)
        // The file is a `.tar.gz` and a resumed range counts its raw bytes.
        .no_gzip()
        .no_brotli()
        .build()
        .map_err(|e| format!("download client: {e}"))
}

/// Fetch and unpack the newest package under the install home `home`, unless
/// it is already there. See the module docs; `Err` leaves it to the installer.
pub async fn prefetch(home: &Path, log: impl Fn(&str) + Send + Sync) -> Result<(), String> {
    let Some(target) = target_for(std::env::consts::OS, std::env::consts::ARCH) else {
        return Ok(());
    };
    let _one = ONE_AT_A_TIME.lock().await;
    let client = client()?;
    let body = client
        .get(CHANNEL_URL)
        .timeout(CHANNEL_TIMEOUT)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|e| format!("release channel: {}", e.without_url()))?
        .text()
        .await
        .map_err(|e| format!("release channel: {}", e.without_url()))?;
    let package = parse_channel(&body, target)
        .ok_or_else(|| format!("the release channel lists no package for {target}"))?;
    let urls = package_urls(&package);
    let standalone = home.join(".codex").join("packages").join("standalone");
    seed(&client, &package, target, &urls, &standalone, &log).await
}

/// `package` from `urls`, unpacked as the release `standalone` selects from.
async fn seed(
    client: &reqwest::Client,
    package: &Package,
    target: &str,
    urls: &[String],
    standalone: &Path,
    log: &(impl Fn(&str) + Send + Sync),
) -> Result<(), String> {
    let releases = standalone.join("releases");
    let name = format!("{}-{target}", package.version);
    if releases.join(&name).exists() {
        return Ok(());
    }
    fs::create_dir_all(&releases).map_err(|e| format!("create {}: {e}", releases.display()))?;
    let part_name = format!("{PART_PREFIX}{name}.tar.gz.part");
    drop_other_parts(standalone, &part_name);
    let part = standalone.join(&part_name);

    log(&format!("Downloading Codex {}…", package.version));
    fetch(client, urls, &part, log).await?;

    log("Checking the download…");
    let expected = package.sha256.clone();
    let task_part = part.clone();
    app_core::rt::spawn_blocking(move || -> Result<(), String> {
        let actual = file_sha256(&task_part)?;
        if actual != expected {
            let _ = fs::remove_file(&task_part);
            return Err("the download does not match the published checksum".to_string());
        }
        unpack(&task_part, &releases, &name)?;
        let _ = fs::remove_file(&task_part);
        Ok(())
    })
    .await
    .map_err(|e| format!("unpack: {e}"))?
}

/// A `.part` of an older release will never be resumed.
fn drop_other_parts(standalone: &Path, keep: &str) {
    let Ok(entries) = fs::read_dir(standalone) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with(PART_PREFIX) && name != keep {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// Bring `part` up to the whole file. A failed attempt keeps what it got; one
/// that got nothing moves on to the next host, so a slow host that is working
/// is kept and the fallback is only for one that isn't.
async fn fetch(
    client: &reqwest::Client,
    urls: &[String],
    part: &Path,
    log: &(impl Fn(&str) + Send + Sync),
) -> Result<(), String> {
    let held = || fs::metadata(part).map_or(0, |m| m.len());
    let mut host = 0;
    let mut fruitless = 0;
    loop {
        let from = held();
        let url = &urls[host % urls.len()];
        let error = match fetch_from(client, url, part, from, log).await {
            Ok(()) => return Ok(()),
            Err(error) => error,
        };
        if held() > from {
            fruitless = 0;
        } else {
            fruitless += 1;
            host += 1;
            if fruitless >= MAX_FRUITLESS {
                return Err(error);
            }
            tokio::time::sleep(RETRY_PAUSE).await;
        }
        log(&format!("Download interrupted at {} MB ({error}); trying again…", megabytes(held())));
    }
}

/// One request for `part`'s missing tail, `from` bytes in.
async fn fetch_from(
    client: &reqwest::Client,
    url: &str,
    part: &Path,
    from: u64,
    log: &(impl Fn(&str) + Send + Sync),
) -> Result<(), String> {
    let mut request = client.get(url);
    if from > 0 {
        request = request.header(header::RANGE, format!("bytes={from}-"));
    }
    let mut response = request.send().await.map_err(|e| e.without_url().to_string())?;
    let status = response.status();
    // Nothing past the end of the file: the part is whole. The digest decides.
    if status == StatusCode::RANGE_NOT_SATISFIABLE {
        return Ok(());
    }
    if !status.is_success() {
        return Err(format!("HTTP {status}"));
    }
    // A host that ignored the range is sending the file from its start.
    let resumed = status == StatusCode::PARTIAL_CONTENT;
    let mut written = if resumed { from } else { 0 };
    let total = response.content_length().map(|len| len + written);
    if total.unwrap_or(0) > MAX_PACKAGE_BYTES {
        return Err("the package is implausibly large".to_string());
    }
    let mut file = fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(resumed)
        .truncate(!resumed)
        .open(part)
        .map_err(|e| format!("{}: {e}", part.display()))?;
    let of_total = total.map_or(String::new(), |total| format!(" of {} MB", megabytes(total)));
    if resumed {
        log(&format!("Resuming at {} MB{of_total}", megabytes(written)));
    }
    let mut next_report = written + PROGRESS_STEP;
    while let Some(chunk) = response.chunk().await.map_err(|e| e.without_url().to_string())? {
        file.write_all(&chunk).map_err(|e| format!("{}: {e}", part.display()))?;
        written += chunk.len() as u64;
        if written > MAX_PACKAGE_BYTES {
            let _ = fs::remove_file(part);
            return Err("the package exceeded the size cap".to_string());
        }
        if written >= next_report {
            log(&format!("{} MB{of_total}", megabytes(written)));
            next_report = written + PROGRESS_STEP;
        }
    }
    file.flush().map_err(|e| format!("{}: {e}", part.display()))?;
    if total.is_some_and(|total| written < total) {
        return Err("the connection ended early".to_string());
    }
    Ok(())
}

fn file_sha256(path: &Path) -> Result<String, String> {
    use sha2::Digest;
    let mut file = fs::File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut hasher = sha2::Sha256::new();
    std::io::copy(&mut file, &mut hasher).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(crate::digest::hex(&hasher.finalize()))
}

/// The installer's `install_package_release`: unpack into a `.staging.` dir
/// (which its next run sweeps if this one dies), then rename into place.
fn unpack(archive: &Path, releases: &Path, name: &str) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    let stage: PathBuf = releases.join(format!(".staging.{name}.prefetch"));
    let _ = fs::remove_dir_all(&stage);
    fs::create_dir_all(&stage).map_err(|e| format!("create {}: {e}", stage.display()))?;
    let build = || -> Result<(), String> {
        let output = crate::paths::command_no_window("tar")
            .arg("-xzf")
            .arg(archive)
            .arg("-C")
            .arg(&stage)
            .output()
            .map_err(|e| format!("tar: {e}"))?;
        if !output.status.success() {
            return Err(format!("tar: {}", String::from_utf8_lossy(&output.stderr).trim()));
        }
        for rel in EXECUTABLES {
            let path = rel.split('/').fold(stage.clone(), |path, part| path.join(part));
            if path.is_file() {
                fs::set_permissions(&path, fs::Permissions::from_mode(0o755))
                    .map_err(|e| format!("{}: {e}", path.display()))?;
            }
        }
        std::os::unix::fs::symlink(Path::new("bin").join("codex"), stage.join("codex"))
            .map_err(|e| format!("link codex: {e}"))?;
        fs::rename(&stage, releases.join(name)).map_err(|e| format!("rename {name}: {e}"))
    };
    let result = build();
    if result.is_err() {
        let _ = fs::remove_dir_all(&stage);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::net::TcpListener;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::{Arc, Mutex};

    const TARGET: &str = "x86_64-unknown-linux-musl";

    fn package(sha256: &str) -> Package {
        Package {
            version: "0.166.0".to_string(),
            asset: format!("codex-package-{TARGET}.tar.gz"),
            sha256: sha256.to_string(),
        }
    }

    /// A package's tree as `tar` packs it, and its digest.
    fn archive(dir: &Path) -> (Vec<u8>, String) {
        let tree = dir.join("tree");
        for sub in ["bin", "codex-path", "codex-resources"] {
            fs::create_dir_all(tree.join(sub)).unwrap();
        }
        for file in ["bin/codex", "bin/codex-code-mode-host", "codex-path/rg", "codex-resources/bwrap"] {
            fs::write(tree.join(file), vec![b'x'; 4096]).unwrap();
        }
        fs::write(tree.join("codex-package.json"), "{}").unwrap();
        let path = dir.join("package.tar.gz");
        let status = std::process::Command::new("tar")
            .args(["-czf"])
            .arg(&path)
            .arg("-C")
            .arg(&tree)
            .arg(".")
            .status()
            .unwrap();
        assert!(status.success());
        (fs::read(&path).unwrap(), file_sha256(&path).unwrap())
    }

    /// Serve `body`, the first full request cut off after `cut` bytes as a
    /// dropped connection would, a `Range` from there on. Returns the base URL
    /// and the `Range` header of each request.
    fn serve(body: Vec<u8>, cut: usize) -> (String, Arc<Mutex<Vec<Option<String>>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/package", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let mut stream = stream.unwrap();
                let mut head = Vec::new();
                let mut byte = [0u8; 1];
                while !head.ends_with(b"\r\n\r\n") && stream.read(&mut byte).unwrap() == 1 {
                    head.push(byte[0]);
                }
                let head = String::from_utf8_lossy(&head).to_lowercase();
                let range = head
                    .lines()
                    .find_map(|l| l.strip_prefix("range: bytes=")?.strip_suffix('-'))
                    .map(str::to_string);
                log.lock().unwrap().push(range.clone());
                let reply = match range {
                    Some(from) => {
                        let from: usize = from.parse().unwrap();
                        let rest = &body[from..];
                        let head = format!(
                            "HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            rest.len()
                        );
                        [head.as_bytes(), rest].concat()
                    }
                    None => {
                        let head = format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len()
                        );
                        [head.as_bytes(), &body[..cut]].concat()
                    }
                };
                let _ = std::io::Write::write_all(&mut stream, &reply);
            }
        });
        (url, seen)
    }

    /// A host that refuses at once: its port was bound and let go.
    fn dead_url() -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        format!("http://{}/package", listener.local_addr().unwrap())
    }

    #[test]
    fn the_target_is_the_one_the_installer_picks() {
        assert_eq!(target_for("linux", "x86_64"), Some(TARGET));
        assert_eq!(target_for("macos", "aarch64"), Some("aarch64-apple-darwin"));
        assert_eq!(target_for("windows", "x86_64"), None);
    }

    #[test]
    fn the_channel_names_the_package_and_its_digest() {
        let digest = "1D44".repeat(16);
        let body = serde_json::json!({
            "tag_name": "rust-v0.166.0",
            "assets": [
                {"name": "codex-package_SHA256SUMS", "digest": format!("sha256:{}", "0".repeat(64))},
                {"name": format!("codex-package-{TARGET}.tar.gz"), "digest": format!("sha256:{digest}")},
            ],
        })
        .to_string();
        assert_eq!(parse_channel(&body, TARGET), Some(package(&digest.to_lowercase())));
        assert_eq!(parse_channel(&body, "riscv64-unknown-linux-musl"), None);
        assert_eq!(parse_channel("<html>", TARGET), None);
    }

    #[test]
    fn a_channel_version_never_reaches_a_path_unchecked() {
        let digest = format!("sha256:{}", "0".repeat(64));
        for tag in ["rust-v../../evil", "rust-v", "0.166.0", "rust-vlatest"] {
            let body = serde_json::json!({
                "tag_name": tag,
                "assets": [{"name": format!("codex-package-{TARGET}.tar.gz"), "digest": digest}],
            })
            .to_string();
            assert_eq!(parse_channel(&body, TARGET), None, "{tag}");
        }
    }

    #[test]
    fn the_hosts_are_the_installers_in_its_order() {
        let [first, second] = package_urls(&package(""));
        assert_eq!(
            first,
            format!("https://releases.openai.com/codex/releases/0.166.0/codex-package-{TARGET}.tar.gz")
        );
        assert_eq!(
            second,
            format!("https://github.com/openai/codex/releases/download/rust-v0.166.0/codex-package-{TARGET}.tar.gz")
        );
    }

    #[tokio::test]
    async fn a_dropped_transfer_resumes_and_lands_a_release_the_installer_accepts() {
        let tmp = tempfile::tempdir().unwrap();
        let (bytes, digest) = archive(tmp.path());
        let cut = bytes.len() / 2;
        let (url, seen) = serve(bytes, cut);
        let standalone = tmp.path().join("standalone");
        fs::create_dir_all(&standalone).unwrap();
        let stale = standalone.join(format!("{PART_PREFIX}0.165.0-{TARGET}.tar.gz.part"));
        fs::write(&stale, "old").unwrap();

        let lines = Mutex::new(Vec::new());
        let log = |line: &str| lines.lock().unwrap().push(line.to_string());
        seed(&client().unwrap(), &package(&digest), TARGET, &[url], &standalone, &log)
            .await
            .unwrap();

        assert_eq!(*seen.lock().unwrap(), vec![None, Some(cut.to_string())]);
        let release = standalone.join("releases").join(format!("0.166.0-{TARGET}"));
        // `release_dir_is_complete`, the part it can check without a real binary.
        assert!(release.join("codex-package.json").is_file());
        for rel in ["bin/codex", "bin/codex-code-mode-host", "codex-path/rg", "codex-resources/bwrap"] {
            let mode = fs::metadata(rel.split('/').fold(release.clone(), |p, s| p.join(s))).unwrap();
            assert_eq!(mode.permissions().mode() & 0o777, 0o755, "{rel}");
        }
        assert_eq!(fs::read_link(release.join("codex")).unwrap(), Path::new("bin").join("codex"));
        let left: Vec<_> = fs::read_dir(&standalone).unwrap().flatten().map(|e| e.file_name()).collect();
        assert_eq!(left, vec![std::ffi::OsString::from("releases")]);
        assert!(lines.lock().unwrap().iter().any(|line| line.contains("Download interrupted")));
    }

    #[tokio::test]
    async fn a_release_already_there_downloads_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir_all(tmp.path().join("releases").join(format!("0.166.0-{TARGET}"))).unwrap();
        let (url, seen) = serve(Vec::new(), 0);
        seed(&client().unwrap(), &package(""), TARGET, &[url], tmp.path(), &|_: &str| {})
            .await
            .unwrap();
        assert!(seen.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_host_that_gives_nothing_falls_over_to_the_next() {
        let tmp = tempfile::tempdir().unwrap();
        let (bytes, digest) = archive(tmp.path());
        let whole = bytes.len();
        let (url, seen) = serve(bytes, whole);
        let standalone = tmp.path().join("standalone");
        seed(&client().unwrap(), &package(&digest), TARGET, &[dead_url(), url], &standalone, &|_: &str| {})
            .await
            .unwrap();
        assert_eq!(seen.lock().unwrap().len(), 1);
        assert!(standalone.join("releases").join(format!("0.166.0-{TARGET}")).is_dir());
    }

    #[tokio::test]
    async fn a_digest_mismatch_installs_nothing_and_keeps_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let (bytes, _) = archive(tmp.path());
        let whole = bytes.len();
        let (url, _) = serve(bytes, whole);
        let standalone = tmp.path().join("standalone");
        let wrong = "0".repeat(64);
        let error = seed(&client().unwrap(), &package(&wrong), TARGET, &[url], &standalone, &|_: &str| {})
            .await
            .unwrap_err();
        assert!(error.contains("checksum"), "{error}");
        let left: Vec<_> = fs::read_dir(standalone.join("releases")).unwrap().flatten().collect();
        assert!(left.is_empty());
        assert_eq!(fs::read_dir(&standalone).unwrap().count(), 1);
    }

    #[test]
    fn a_broken_archive_leaves_no_staging_behind() {
        let tmp = tempfile::tempdir().unwrap();
        let archive = tmp.path().join("broken.tar.gz");
        fs::write(&archive, "not a tarball").unwrap();
        let releases = tmp.path().join("releases");
        fs::create_dir_all(&releases).unwrap();
        assert!(unpack(&archive, &releases, "0.166.0").is_err());
        assert_eq!(fs::read_dir(&releases).unwrap().count(), 0);
    }

    /// `CODEX_PACKAGE_PROBE_HOME=<dir> cargo test -p tabtivity --no-default-features --lib
    /// the_real_package -- --ignored --nocapture`, then run the real installer
    /// with `HOME=<dir>`: it must not print `Downloading Codex CLI`.
    #[tokio::test]
    #[ignore = "downloads the real package"]
    async fn the_real_package_prefetches() {
        let home = std::env::var("CODEX_PACKAGE_PROBE_HOME").expect("CODEX_PACKAGE_PROBE_HOME");
        prefetch(Path::new(&home), |line| println!("{line}")).await.unwrap();
    }
}
