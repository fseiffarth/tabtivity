//! "Check for a new Tabtivity" against the project's GitHub releases.
//!
//! Deliberately *not* the Tauri updater plugin: that wants a `latest.json`
//! published next to the artifacts. This reads the same public releases page a
//! user would open by hand, picks the artifact matching the running platform,
//! and hands it to the platform's own installer.
//!
//! Three rules hold the trust boundary, because this ends with *running a
//! downloaded executable*:
//!
//! 1. Every asset URL is checked by [`is_repo_download_url`] before it is
//!    fetched and again before anything is installed. The release JSON comes
//!    off the network, so `browser_download_url` is attacker-controlled input
//!    until it has been proven to be a release download of one of
//!    [`RELEASE_OWNERS`]' repositories.
//! 2. The frontend never names a path. `stage_download` remembers what it wrote
//!    in [`STAGED`], and `install` acts on *that*, so no renderer-supplied
//!    string can select what gets executed.
//! 3. Nothing is staged unless its SHA-256 matches the release's `SHA256SUMS`,
//!    and that file's ECDSA P-256 signature verifies against the public key
//!    compiled in ([`RELEASE_PUBLIC_KEY_PEM`]; CI signs with the private half,
//!    #160). The asset name must carry the version being installed, so an old
//!    signed build re-published under a newer tag is refused. An unsigned
//!    release is not installable in-app — the user can still fetch it by hand.
//!    The URL prefix alone trusted anyone who could publish to the repository;
//!    the signature narrows that to whoever holds the key.
//!
//! `AppHandle`-free on purpose: everything here is unit-testable, and the
//! command layer in `commands::app_update` owns the progress events.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// The repository releases are published from. Any change here must also change
/// [`LATEST_API`] and [`RELEASES_PAGE`].
pub const REPO: &str = crate::brand::REPO;

/// The one API endpoint. `/releases/latest` skips drafts and pre-releases,
/// which is exactly the "latest" the README's link points at.
const LATEST_API: &str = concat!("https://api.github.com/repos/", crate::app_repo!(), "/releases/latest");

/// Where a human goes when the in-app path can't finish the job.
pub const RELEASES_PAGE: &str = concat!("https://github.com/", crate::app_repo!(), "/releases/latest");

/// Where GitHub serves release assets from: `<owner>/<repo>/releases/download/…`
/// under this host.
const DOWNLOAD_HOST: &str = "https://github.com/";

/// The GitHub accounts whose release downloads are accepted, whatever the
/// repository is called — so a renamed repository strands no installed client.
/// An account belongs here only while we control it, and the list is final for
/// every build that ships with it: a client rejects each later release
/// published under an owner it does not know.
const RELEASE_OWNERS: &[&str] = &["fseiffarth"];

/// Identify ourselves — GitHub rejects API requests with no `User-Agent`.
fn user_agent() -> String {
    format!("{} (+https://github.com/{REPO})", crate::brand::user_agent())
}

const CHECK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// The checksum list CI publishes with every release, and its detached DER
/// signature (`openssl dgst -sha256 -sign`).
const SUMS_NAME: &str = "SHA256SUMS";
const SUMS_SIG_NAME: &str = "SHA256SUMS.sig";

/// The public half of the release signing key (`scripts/release-signing-keygen.sh`).
const RELEASE_PUBLIC_KEY_PEM: &str = include_str!("../../release-signing.pub.pem");

/// A checksum list or signature is a few hundred bytes.
const MAX_SUMS_BYTES: u64 = 64 * 1024;

/// Refuse absurd downloads. The largest Tabtivity artifact is well under 200 MB;
/// this only exists so a wrong or hostile `Content-Length` can't fill a disk.
const MAX_ASSET_BYTES: u64 = 512 * 1024 * 1024;

/// How the *running* build can apply an update, which is not the same question
/// as which artifact exists. A `.deb`-installed Tabtivity can download the new
/// `.deb` but must not try to install it itself.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum InstallKind {
    /// Linux AppImage: swap the file we are running from, then restart.
    Appimage,
    /// Windows: run the NSIS installer, which offers to close Tabtivity first.
    Nsis,
    /// macOS: open the `.dmg` and let the user drag it to Applications.
    Dmg,
    /// Downloadable, but the last step is the user's (`.deb`, raw binary, a
    /// package manager's copy). We stop after staging the file.
    Manual,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct UpdateAsset {
    pub name: String,
    pub url: String,
    pub size: u64,
    /// Where the release's signed checksum list lives; `None` for a release
    /// that published none, which [`stage_download`] then refuses.
    #[serde(skip)]
    pub signature: Option<ReleaseSignature>,
}

/// The URLs of a release's `SHA256SUMS` and its signature.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReleaseSignature {
    pub sums_url: String,
    pub sig_url: String,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    /// The running version, from `CARGO_PKG_VERSION`.
    pub current: String,
    /// Normalized latest version (tag with any leading `v` stripped).
    pub latest: Option<String>,
    pub tag: Option<String>,
    pub name: Option<String>,
    /// Release body (markdown), as written by the release workflow.
    pub notes: Option<String>,
    pub published_at: Option<String>,
    pub html_url: String,
    pub update_available: bool,
    /// The artifact for this platform, if the release published one.
    pub asset: Option<UpdateAsset>,
    pub install_kind: InstallKind,
}

/// What [`stage_download`] left on disk, and the only thing [`install`] will
/// act on. Process-local: a staged file does not survive a relaunch as an
/// install candidate, which is the conservative reading.
static STAGED: Mutex<Option<Staged>> = Mutex::new(None);

#[derive(Clone, Debug)]
pub struct Staged {
    pub path: PathBuf,
    pub name: String,
    pub version: String,
    pub kind: InstallKind,
    /// The verified digest, re-checked by [`install`] so a file swapped in the
    /// staging dir after the download is not what runs.
    pub sha256: String,
}

/// The version this binary was built as.
pub fn current_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// Compare two dotted version strings numerically.
///
/// Hand-rolled instead of pulling in `semver`: the tags this compares are
/// written by `scripts/bump-version.sh`, which only ever produces `x.y.z`. A
/// trailing suffix (`0.2.0-rc1`) is ignored for ordering but *loses* a tie, so
/// a pre-release never presents itself as newer than the same released number.
pub fn is_newer(latest: &str, current: &str) -> bool {
    let (lat_nums, lat_pre) = split_version(latest);
    let (cur_nums, cur_pre) = split_version(current);
    if lat_nums.is_empty() {
        return false;
    }
    let len = lat_nums.len().max(cur_nums.len());
    for i in 0..len {
        let l = lat_nums.get(i).copied().unwrap_or(0);
        let c = cur_nums.get(i).copied().unwrap_or(0);
        if l != c {
            return l > c;
        }
    }
    // Same numbers: only a release beats a pre-release of itself.
    cur_pre && !lat_pre
}

/// Split `1.2.3-rc1` into `([1,2,3], true)`. Anything unparseable stops the
/// numeric run rather than poisoning the whole comparison.
fn split_version(raw: &str) -> (Vec<u64>, bool) {
    let trimmed = raw.trim().trim_start_matches(['v', 'V']);
    let head = trimmed
        .split(['-', '+'])
        .next()
        .unwrap_or("")
        .trim_end_matches('.');
    let pre = trimmed.len() != head.len();
    let nums = head
        .split('.')
        .map(|part| part.trim().parse::<u64>())
        .take_while(|parsed| parsed.is_ok())
        .filter_map(Result::ok)
        .collect();
    (nums, pre)
}

/// Normalize a tag (`v0.1.52`) to a bare version (`0.1.52`).
pub fn version_from_tag(tag: &str) -> String {
    tag.trim().trim_start_matches(['v', 'V']).to_string()
}

/// How this build can install an update, given how it is running.
///
/// On Linux the deciding fact is the `APPIMAGE` environment variable, which the
/// AppImage runtime sets to the path of the `.AppImage` itself. A `.deb`
/// install or a `cargo build` binary has no such thing, and overwriting either
/// from inside the app would be Tabtivity editing a package manager's files.
pub fn install_kind_for_running_build() -> InstallKind {
    if cfg!(target_os = "windows") {
        return InstallKind::Nsis;
    }
    if cfg!(target_os = "macos") {
        return InstallKind::Dmg;
    }
    match running_appimage_path() {
        Some(_) => InstallKind::Appimage,
        None => InstallKind::Manual,
    }
}

/// The `.AppImage` we are running from, if we are running from one.
fn running_appimage_path() -> Option<PathBuf> {
    let raw = std::env::var_os("APPIMAGE")?;
    let path = PathBuf::from(raw);
    if path.is_absolute() && path.is_file() {
        Some(path)
    } else {
        None
    }
}

/// File extensions worth downloading on this platform, best first.
fn wanted_extensions(kind: InstallKind) -> &'static [&'static str] {
    match kind {
        InstallKind::Nsis => &["exe", "msi"],
        InstallKind::Dmg => &["dmg"],
        // AppImage first even for a `.deb` install: it is the portable one, so
        // it is the artifact a `Manual` user can actually do something with.
        InstallKind::Appimage | InstallKind::Manual => &["appimage", "deb"],
    }
}

/// Name fragments that mark an asset as built for this CPU.
fn arch_tokens() -> &'static [&'static str] {
    if cfg!(target_arch = "aarch64") {
        &["aarch64", "arm64", "universal"]
    } else {
        &["x86_64", "amd64", "x64", "universal"]
    }
}

/// Pick the asset to offer, from `(name, url, size)` triples.
///
/// Extension decides first (a `.deb` is never an answer for Windows), arch
/// breaks ties, and a release that names no arch at all still resolves — the
/// current workflow publishes one artifact per platform.
pub fn pick_asset(assets: &[(String, String, u64)], kind: InstallKind) -> Option<UpdateAsset> {
    for ext in wanted_extensions(kind) {
        let matching: Vec<&(String, String, u64)> = assets
            .iter()
            .filter(|(name, url, _)| {
                is_repo_download_url(url)
                    && name
                        .rsplit('.')
                        .next()
                        .is_some_and(|got| got.eq_ignore_ascii_case(ext))
            })
            .collect();
        if matching.is_empty() {
            continue;
        }
        let chosen = matching
            .iter()
            .find(|(name, _, _)| {
                let lower = name.to_ascii_lowercase();
                arch_tokens().iter().any(|token| lower.contains(token))
            })
            .or(matching.first())?;
        return Some(UpdateAsset {
            name: chosen.0.clone(),
            url: chosen.1.clone(),
            size: chosen.2,
            signature: release_signature(assets),
        });
    }
    None
}

/// The release's checksum list and signature, when both are published from this
/// repository.
fn release_signature(assets: &[(String, String, u64)]) -> Option<ReleaseSignature> {
    let url_of = |wanted: &str| {
        assets
            .iter()
            .find(|(name, url, _)| name == wanted && is_repo_download_url(url))
            .map(|(_, url, _)| url.clone())
    };
    Some(ReleaseSignature {
        sums_url: url_of(SUMS_NAME)?,
        sig_url: url_of(SUMS_SIG_NAME)?,
    })
}

/// The compiled-in release verifying key.
fn release_verifying_key() -> Result<p256::ecdsa::VerifyingKey, String> {
    verifying_key_from_pem(RELEASE_PUBLIC_KEY_PEM)
}

fn verifying_key_from_pem(pem: &str) -> Result<p256::ecdsa::VerifyingKey, String> {
    use base64ct::{Base64, Encoding};
    use p256::pkcs8::DecodePublicKey;
    let body: String = pem
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with("-----"))
        .collect();
    let der = Base64::decode_vec(&body).map_err(|_| "release key: bad PEM")?;
    let key = p256::PublicKey::from_public_key_der(&der).map_err(|_| "release key: not a P-256 key")?;
    Ok(p256::ecdsa::VerifyingKey::from(key))
}

/// Check a checksum list's detached DER signature.
fn verify_sums(
    key: &p256::ecdsa::VerifyingKey,
    sums: &[u8],
    sig_der: &[u8],
) -> Result<(), String> {
    use p256::ecdsa::signature::Verifier;
    let sig = p256::ecdsa::Signature::from_der(sig_der)
        .map_err(|_| "the release signature is malformed; refusing the update")?;
    key.verify(sums, &sig)
        .map_err(|_| "the release signature does not verify; refusing the update".to_string())
}

/// The lowercase hex SHA-256 a verified checksum list gives `asset_name`.
///
/// `version` is the release being installed: the asset name must carry it
/// (`Tabtivity_<version>_amd64.AppImage`), so a signed list from an older release
/// cannot vouch for a downgrade published under a newer tag.
fn expected_digest(sums: &str, asset_name: &str, version: &str) -> Result<String, String> {
    if version.is_empty() || !asset_name.contains(&format!("_{version}_")) {
        return Err(format!(
            "the release asset {asset_name} is not version {version}; refusing the update"
        ));
    }
    let mut found = None;
    for line in sums.lines() {
        // `sha256sum` format: digest, two separators (space or ` *`), name.
        let Some((digest, rest)) = line.split_once(' ') else {
            continue;
        };
        let name = rest.strip_prefix(' ').or_else(|| rest.strip_prefix('*'));
        if name != Some(asset_name) {
            continue;
        }
        if digest.len() != 64 || !digest.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("the release checksum list is malformed; refusing the update".to_string());
        }
        if found.is_some() {
            return Err("the release checksum list names the asset twice; refusing the update".to_string());
        }
        found = Some(digest.to_ascii_lowercase());
    }
    found.ok_or_else(|| {
        format!("the release checksum list has no entry for {asset_name}; refusing the update")
    })
}

fn sha256_hex(digest: impl AsRef<[u8]>) -> String {
    digest.as_ref().iter().map(|b| format!("{b:02x}")).collect()
}

/// Fetch a small release file (the checksum list or its signature).
async fn fetch_small(client: &reqwest::Client, url: &str) -> Result<Vec<u8>, String> {
    if !is_repo_download_url(url) {
        return Err(concat!("refusing to fetch a file from outside the ", crate::app_name!(), " releases").to_string());
    }
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("release signature: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("release signature: HTTP {}", response.status()));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("release signature: {e}"))?
    {
        body.extend_from_slice(&chunk);
        if body.len() as u64 > MAX_SUMS_BYTES {
            return Err("release signature file is implausibly large; refusing".to_string());
        }
    }
    Ok(body)
}

/// Download and verify the release's checksum list, and return the digest it
/// gives `asset`.
async fn verified_digest(
    client: &reqwest::Client,
    asset: &UpdateAsset,
    version: &str,
) -> Result<String, String> {
    let signature = asset.signature.as_ref().ok_or(
        "this release is not signed, so it can't be installed from here; download it from the releases page",
    )?;
    let sums = fetch_small(client, &signature.sums_url).await?;
    let sig = fetch_small(client, &signature.sig_url).await?;
    verify_sums(&release_verifying_key()?, &sums, &sig)?;
    let sums = std::str::from_utf8(&sums)
        .map_err(|_| "the release checksum list is not text; refusing the update")?;
    expected_digest(sums, &asset.name, version)
}

/// Whether a URL is a release download from one of *our* repositories:
/// `https://github.com/<owner>/<repo>/releases/download/<file…>` with `<owner>`
/// in [`RELEASE_OWNERS`] and `<repo>` exactly one path segment.
///
/// The owner is checked, not just the host: `https://github.com/` alone would
/// accept anyone's assets, which is the exact substitution this guards against.
/// The repository name is left open so the repository can be renamed; the
/// signed `SHA256SUMS` stays the trust anchor either way.
pub fn is_repo_download_url(url: &str) -> bool {
    let Some(rest) = url.strip_prefix(DOWNLOAD_HOST) else {
        return false;
    };
    let mut parts = rest.splitn(3, '/');
    let (Some(owner), Some(repo), Some(tail)) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    // GitHub's own repository-name alphabet; `.` and `..` would walk the path.
    let repo_ok = !repo.is_empty()
        && repo != "."
        && repo != ".."
        && repo
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'));
    RELEASE_OWNERS.contains(&owner)
        && repo_ok
        && tail
            .strip_prefix("releases/download/")
            .is_some_and(|file| !file.is_empty())
}

/// Parse a GitHub release JSON body into a check result.
///
/// Split out from the request so the shape can be tested without the network.
pub fn parse_release(body: &str, current: &str, kind: InstallKind) -> Result<UpdateCheck, String> {
    let value: serde_json::Value =
        serde_json::from_str(body).map_err(|e| format!("release JSON: {e}"))?;
    let tag = value
        .get("tag_name")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let latest = tag.as_deref().map(version_from_tag);
    let assets: Vec<(String, String, u64)> = value
        .get("assets")
        .and_then(|v| v.as_array())
        .map(|list| {
            list.iter()
                .filter_map(|asset| {
                    Some((
                        asset.get("name")?.as_str()?.to_string(),
                        asset.get("browser_download_url")?.as_str()?.to_string(),
                        asset.get("size").and_then(|v| v.as_u64()).unwrap_or(0),
                    ))
                })
                .collect()
        })
        .unwrap_or_default();
    let update_available = latest
        .as_deref()
        .is_some_and(|latest| is_newer(latest, current));
    Ok(UpdateCheck {
        current: current.to_string(),
        latest,
        tag,
        name: value
            .get("name")
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
            .map(str::to_string),
        notes: value
            .get("body")
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
            .map(str::to_string),
        published_at: value
            .get("published_at")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        html_url: value
            .get("html_url")
            .and_then(|v| v.as_str())
            .filter(|s| s.starts_with("https://github.com/"))
            .unwrap_or(RELEASES_PAGE)
            .to_string(),
        // Only offer an artifact when there is actually something newer.
        asset: if update_available {
            pick_asset(&assets, kind)
        } else {
            None
        },
        update_available,
        install_kind: kind,
    })
}

fn client() -> Result<reqwest::Client, String> {
    // `reqwest` is built with `rustls-no-provider`, and rustls 0.23 *panics*
    // when no process default is installed — see `browser_engine::reader_client`.
    crate::services::mail_engine::install_crypto_provider();
    reqwest::Client::builder()
        .user_agent(user_agent())
        .timeout(CHECK_TIMEOUT)
        .referer(false)
        .build()
        .map_err(|e| format!("update-client: {e}"))
}

/// Ask GitHub for the latest release.
pub async fn check() -> Result<UpdateCheck, String> {
    let kind = install_kind_for_running_build();
    let body = fetch_latest(LATEST_API).await?;
    parse_release(&body, current_version(), kind)
}

/// Fetch the latest-release JSON. Redirects are followed: after a repository
/// rename or transfer GitHub answers the old API path with a 301.
async fn fetch_latest(url: &str) -> Result<String, String> {
    let response = client()?
        .get(url)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|e| format!("update check failed: {e}"))?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Err("no published release found".to_string());
    }
    if !response.status().is_success() {
        return Err(format!("GitHub answered {}", response.status()));
    }
    response
        .text()
        .await
        .map_err(|e| format!("update check failed: {e}"))
}

/// Where downloads are staged. Outside the project tree, next to the rest of
/// Tabtivity's own state.
pub fn staging_dir() -> PathBuf {
    crate::storage::state_dir().join("updates")
}

/// Strip an asset name down to something safe to join onto a directory.
///
/// The name comes from the release JSON, so it is untrusted: a `..` or a
/// separator in it must not be able to choose where the file lands.
fn safe_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
        .collect();
    let cleaned = cleaned.trim_matches('.').to_string();
    if cleaned.is_empty() {
        concat!(crate::app_slug!(), "-update").to_string()
    } else {
        cleaned
    }
}

/// Download an asset into [`staging_dir`], reporting progress as it goes.
///
/// `on_progress` gets `(bytes_so_far, total_if_known)`. The file is written to
/// a `.part` sibling and renamed only on success, so an interrupted download
/// can never be mistaken for a complete one.
pub async fn stage_download(
    asset: &UpdateAsset,
    version: &str,
    kind: InstallKind,
    mut on_progress: impl FnMut(u64, Option<u64>),
) -> Result<Staged, String> {
    if !is_repo_download_url(&asset.url) {
        return Err(concat!("refusing to download an asset from outside the ", crate::app_name!(), " releases").to_string());
    }
    let dir = staging_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("update staging dir: {e}"))?;

    let name = safe_file_name(&asset.name);
    let final_path = dir.join(&name);
    let part_path = dir.join(format!("{name}.part"));
    let _ = std::fs::remove_file(&part_path);

    let client = client()?;
    // Before the artifact: a release that can't vouch for it is refused without
    // spending the download.
    let expected = verified_digest(&client, asset, version).await?;

    let mut response = client
        .get(&asset.url)
        // The download itself has no deadline: a 150 MB artifact on a slow link
        // legitimately outlives the 20 s check timeout.
        .timeout(std::time::Duration::from_secs(60 * 60))
        .send()
        .await
        .map_err(|e| format!("download failed: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("download failed: HTTP {}", response.status()));
    }
    let total = response.content_length();
    if total.is_some_and(|len| len > MAX_ASSET_BYTES) {
        return Err("release asset is implausibly large; refusing".to_string());
    }

    let digest = {
        use sha2::Digest;
        use std::io::Write;
        let mut file =
            std::fs::File::create(&part_path).map_err(|e| format!("update staging: {e}"))?;
        let mut hasher = sha2::Sha256::new();
        let mut written: u64 = 0;
        on_progress(0, total);
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|e| format!("download failed: {e}"))?
        {
            written += chunk.len() as u64;
            if written > MAX_ASSET_BYTES {
                let _ = std::fs::remove_file(&part_path);
                return Err("release asset exceeded the size cap; aborted".to_string());
            }
            hasher.update(&chunk);
            file.write_all(&chunk)
                .map_err(|e| format!("update staging: {e}"))?;
            on_progress(written, total);
        }
        file.flush().map_err(|e| format!("update staging: {e}"))?;
        sha256_hex(hasher.finalize())
    };
    if digest != expected {
        let _ = std::fs::remove_file(&part_path);
        return Err("the download does not match the signed release checksum; refusing".to_string());
    }

    std::fs::rename(&part_path, &final_path).map_err(|e| format!("update staging: {e}"))?;
    make_runnable(&final_path);

    let staged = Staged {
        path: final_path,
        name: asset.name.clone(),
        version: version.to_string(),
        kind,
        sha256: digest,
    };
    *STAGED.lock().map_err(|_| "update state poisoned")? = Some(staged.clone());
    Ok(staged)
}

/// Give a staged artifact the execute bit on Unix. Harmless for a `.deb`, and
/// required for an AppImage to be runnable after the swap.
fn make_runnable(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755));
    }
    #[cfg(not(unix))]
    let _ = path;
}

/// The currently staged download, if any.
pub fn staged() -> Option<Staged> {
    STAGED.lock().ok().and_then(|guard| guard.clone())
}

/// What `install` did, so the UI can say the right next step.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallOutcome {
    /// Whether Tabtivity must be restarted by the user for the update to take.
    pub restart_required: bool,
    /// Whether an external installer was launched and now owns the process.
    pub installer_launched: bool,
    /// Where the artifact sits, for the "downloaded to …" line.
    pub path: String,
}

/// Install the staged artifact.
///
/// Takes no path on purpose — see the module docs. The AppImage path swaps the
/// running file with a rename, which is atomic and legal on Linux even while
/// the old inode is executing; the new binary is picked up on the next launch,
/// which the user performs.
pub fn install() -> Result<InstallOutcome, String> {
    let staged = staged().ok_or("no update has been downloaded")?;
    if !staged.path.is_file() {
        return Err("the downloaded update is no longer on disk".to_string());
    }
    if file_sha256(&staged.path)? != staged.sha256 {
        return Err("the downloaded update changed on disk since it was verified; download it again".to_string());
    }
    let path_str = staged.path.to_string_lossy().to_string();
    match staged.kind {
        InstallKind::Appimage => {
            let target = running_appimage_path()
                .ok_or("this build is not running from an AppImage; install it by hand")?;
            swap_appimage(&staged.path, &target)?;
            Ok(InstallOutcome {
                restart_required: true,
                installer_launched: false,
                path: target.to_string_lossy().to_string(),
            })
        }
        InstallKind::Nsis => {
            // The Tauri NSIS installer detects a running Tabtivity and offers to
            // close it, so handing it over mid-session is the supported flow.
            // A plain `Command`, deliberately not `paths::command_no_window`:
            // this child is meant to put a window on screen, and suppressing a
            // console for an installer is the opposite of what is wanted here.
            let mut cmd = std::process::Command::new(&staged.path);
            // Run it from the directory it landed in, so nothing resolves
            // against whatever Tabtivity's cwd happens to be.
            if let Some(parent) = staged.path.parent() {
                cmd.current_dir(parent);
            }
            crate::paths::spawn_reaped(cmd)
                .map_err(|e| format!("could not start the installer: {e}"))?;
            Ok(InstallOutcome {
                restart_required: true,
                installer_launched: true,
                path: path_str,
            })
        }
        InstallKind::Dmg => {
            let mut cmd = crate::paths::command_no_window("open");
            cmd.arg(&staged.path);
            crate::paths::spawn_reaped(cmd).map_err(|e| format!("could not open the disk image: {e}"))?;
            Ok(InstallOutcome {
                restart_required: true,
                installer_launched: true,
                path: path_str,
            })
        }
        InstallKind::Manual => Ok(InstallOutcome {
            restart_required: false,
            installer_launched: false,
            path: path_str,
        }),
    }
}

fn file_sha256(path: &Path) -> Result<String, String> {
    use sha2::Digest;
    let mut file = std::fs::File::open(path).map_err(|e| format!("update staging: {e}"))?;
    let mut hasher = sha2::Sha256::new();
    std::io::copy(&mut file, &mut hasher).map_err(|e| format!("update staging: {e}"))?;
    Ok(sha256_hex(hasher.finalize()))
}

/// Put `new` in place of `target`, keeping a `.old` copy until the swap lands.
///
/// A plain copy-over-the-running-file would fail with `ETXTBSY`; a rename onto
/// the path does not, because it replaces the directory entry rather than the
/// bytes the kernel is executing.
fn swap_appimage(new: &Path, target: &Path) -> Result<(), String> {
    let staged_beside = target.with_extension("new");
    std::fs::copy(new, &staged_beside)
        .map_err(|e| format!("could not write next to the installed AppImage: {e}"))?;
    make_runnable(&staged_beside);
    let backup = target.with_extension("old");
    let _ = std::fs::remove_file(&backup);
    // Keep the outgoing build reachable if the rename below is the last thing
    // that works today.
    if let Err(e) = std::fs::rename(target, &backup) {
        let _ = std::fs::remove_file(&staged_beside);
        return Err(format!("could not move the installed AppImage aside: {e}"));
    }
    if let Err(e) = std::fs::rename(&staged_beside, target) {
        let _ = std::fs::rename(&backup, target);
        return Err(format!("could not put the new AppImage in place: {e}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newer_versions_compare_numerically_not_lexically() {
        assert!(is_newer("0.1.53", "0.1.52"));
        assert!(is_newer("0.2.0", "0.1.99"));
        // The lexical trap: "0.1.9" > "0.1.10" as strings.
        assert!(is_newer("0.1.10", "0.1.9"));
        assert!(!is_newer("0.1.52", "0.1.52"));
        assert!(!is_newer("0.1.51", "0.1.52"));
        assert!(is_newer("v0.1.53", "0.1.52"));
    }

    #[test]
    fn a_prerelease_never_outranks_the_release_it_precedes() {
        assert!(!is_newer("0.2.0-rc1", "0.2.0"));
        assert!(is_newer("0.2.0", "0.2.0-rc1"));
        assert!(is_newer("0.2.0-rc1", "0.1.52"));
    }

    #[test]
    fn a_garbage_tag_is_never_newer() {
        assert!(!is_newer("", "0.1.52"));
        assert!(!is_newer("nightly", "0.1.52"));
    }

    #[test]
    fn only_this_repositorys_release_downloads_are_accepted() {
        assert!(is_repo_download_url(
            "https://github.com/fseiffarth/ProjectEldrun/releases/download/v0.1.53/Eldrun.AppImage"
        ));
        // A different repository, same host.
        assert!(!is_repo_download_url(
            "https://github.com/attacker/evil/releases/download/v1/Eldrun.AppImage"
        ));
        // A look-alike host.
        assert!(!is_repo_download_url(
            "https://github.com.example.org/fseiffarth/ProjectEldrun/releases/download/v1/x"
        ));
        assert!(!is_repo_download_url("http://github.com/fseiffarth/ProjectEldrun/releases/download/v1/x"));
        // The prefix alone names no file.
        assert!(!is_repo_download_url(
            "https://github.com/fseiffarth/ProjectEldrun/releases/download/"
        ));
    }

    #[test]
    fn a_renamed_repository_of_the_same_owner_is_still_accepted() {
        assert!(is_repo_download_url(
            "https://github.com/fseiffarth/renamed-repo/releases/download/v0.3.0/App_0.3.0_amd64.deb"
        ));
        // The repository is exactly one path segment.
        for url in [
            "https://github.com/fseiffarth//releases/download/v1/x",
            "https://github.com/fseiffarth/../releases/download/v1/x",
            "https://github.com/fseiffarth/./releases/download/v1/x",
            "https://github.com/fseiffarth/a/b/releases/download/v1/x",
            "https://github.com/fseiffarth/a%2Fb/releases/download/v1/x",
            "https://github.com/fseiffarth/releases/download/v1/x",
            // Not a release download at all.
            "https://github.com/fseiffarth/renamed-repo/archive/refs/heads/main.zip",
            "https://github.com/fseiffarth/renamed-repo/releases/downloadx/v1/x",
            // An owner that merely starts or ends like ours.
            "https://github.com/fseiffarth-evil/ProjectEldrun/releases/download/v1/x",
            "https://github.com/evil/fseiffarth/releases/download/v1/x",
            "https://github.com/FSEIFFARTH@evil.example.org/x/releases/download/v1/x",
        ] {
            assert!(!is_repo_download_url(url), "{url}");
        }
    }

    /// Serve `responses` one per connection on a loopback port.
    async fn serve_once_each(responses: Vec<String>) -> std::net::SocketAddr {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            for response in responses {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut seen = Vec::new();
                let mut buf = [0u8; 1024];
                while !seen.windows(4).any(|w| w == b"\r\n\r\n") {
                    let n = stream.read(&mut buf).await.unwrap();
                    if n == 0 {
                        break;
                    }
                    seen.extend_from_slice(&buf[..n]);
                }
                stream.write_all(response.as_bytes()).await.unwrap();
                let _ = stream.shutdown().await;
            }
        });
        addr
    }

    #[tokio::test]
    async fn the_update_check_follows_a_renamed_repositorys_redirect() {
        let body = r#"{"tag_name":"v9.9.9"}"#;
        let addr = serve_once_each(vec![
            "HTTP/1.1 301 Moved Permanently\r\nLocation: /repositories/1/releases/latest\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string(),
            format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            ),
        ])
        .await;
        let fetched = fetch_latest(&format!("http://{addr}/repos/old/name/releases/latest"))
            .await
            .unwrap();
        assert_eq!(fetched, body);
    }

    // ── signed checksums (#160) ──────────────────────────────────────────
    //
    // Fixtures from a throwaway key (its private half was never kept), signed
    // with `openssl dgst -sha256 -sign` exactly as the release job does. One
    // signature has a high S value: openssl doesn't normalise S, so the
    // verifier must not demand low-S.

    const TEST_PUB: &str = "-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEHzQNAoxlQCSV/JjopXBNKQsj3VAN
zWKrqHHacn3R/vU4reeTtE+MP1CZrcNAOYOmswDjH92r/YoK3ZxNK3NjBg==
-----END PUBLIC KEY-----
";
    const TEST_SUMS: &str = "8b408ed68dfd56d503752ff2ee2ecb3c0ffa55a26f6fa107bd4444c3943ee6e1  Eldrun_0.2.0_amd64.AppImage
9cfa1468c93fc18652e34a000f0c6614b0fa18f6f4887477ad9b0d36ca6a7eaa  Eldrun_0.2.0_amd64.deb
";
    const TEST_SIG_LOW_S: &str = "MEQCIDksJ5Qox68bOODi9plWkN+MSvMyyhyienbTI+SHfuY8AiA6gIwEB9xXCHx9ZaFu+abwEdntBgHFx59PMVZoY/83vw==";
    const TEST_SIG_HIGH_S: &str = "MEUCIFvpBJKt154qAvElYHRkyWMqk+jSb5rsAoYH5fhELBVDAiEAy2tLXoINBN4hcIoGlq9/DYOT9Q3Ao7adg571gEh4tXM=";

    fn der(b64: &str) -> Vec<u8> {
        use base64ct::{Base64, Encoding};
        Base64::decode_vec(b64).unwrap()
    }

    #[test]
    fn the_compiled_in_release_key_parses() {
        release_verifying_key().unwrap();
    }

    #[test]
    fn an_openssl_signed_checksum_list_verifies() {
        let key = verifying_key_from_pem(TEST_PUB).unwrap();
        verify_sums(&key, TEST_SUMS.as_bytes(), &der(TEST_SIG_LOW_S)).unwrap();
        verify_sums(&key, TEST_SUMS.as_bytes(), &der(TEST_SIG_HIGH_S)).unwrap();
    }

    #[test]
    fn a_tampered_checksum_list_or_foreign_key_is_refused() {
        let key = verifying_key_from_pem(TEST_PUB).unwrap();
        let tampered = TEST_SUMS.replacen('8', "9", 1);
        assert!(verify_sums(&key, tampered.as_bytes(), &der(TEST_SIG_LOW_S)).is_err());
        assert!(verify_sums(&key, TEST_SUMS.as_bytes(), b"not a signature").is_err());
        // The release key did not sign the test list.
        let release = release_verifying_key().unwrap();
        assert!(verify_sums(&release, TEST_SUMS.as_bytes(), &der(TEST_SIG_LOW_S)).is_err());
    }

    #[test]
    fn the_digest_comes_from_the_exact_asset_line() {
        assert_eq!(
            expected_digest(TEST_SUMS, "Eldrun_0.2.0_amd64.deb", "0.2.0").unwrap(),
            "9cfa1468c93fc18652e34a000f0c6614b0fa18f6f4887477ad9b0d36ca6a7eaa"
        );
        // Binary-mode marker, uppercase hex.
        let star = "ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef0123456789 *Eldrun_0.2.0_x64-setup.exe\n";
        assert_eq!(
            expected_digest(star, "Eldrun_0.2.0_x64-setup.exe", "0.2.0").unwrap(),
            "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
        );
        // A name that is only a suffix or prefix of a listed one is not listed.
        assert!(expected_digest(TEST_SUMS, "Eldrun_0.2.0_amd64.App", "0.2.0").is_err());
        assert!(expected_digest(TEST_SUMS, "x/Eldrun_0.2.0_amd64.deb", "0.2.0").is_err());
    }

    #[test]
    fn an_old_signed_build_under_a_newer_tag_is_refused() {
        // A signed 0.2.0 list re-published as the 0.3.0 release.
        assert!(expected_digest(TEST_SUMS, "Eldrun_0.2.0_amd64.deb", "0.3.0").is_err());
        assert!(expected_digest(TEST_SUMS, "Eldrun_0.2.0_amd64.deb", "").is_err());
    }

    #[test]
    fn a_malformed_or_ambiguous_checksum_list_is_refused() {
        let short = "abc  Eldrun_0.2.0_amd64.deb\n";
        assert!(expected_digest(short, "Eldrun_0.2.0_amd64.deb", "0.2.0").is_err());
        let twice = format!("{TEST_SUMS}{TEST_SUMS}");
        assert!(expected_digest(&twice, "Eldrun_0.2.0_amd64.deb", "0.2.0").is_err());
    }

    #[test]
    fn a_release_signature_needs_both_files_from_this_repository() {
        let mut assets = vec![asset("Eldrun_0.1.53_amd64.AppImage")];
        let picked = pick_asset(&assets, InstallKind::Appimage).unwrap();
        assert_eq!(picked.signature, None);

        assets.push(asset(SUMS_NAME));
        assert_eq!(pick_asset(&assets, InstallKind::Appimage).unwrap().signature, None);

        assets.push((
            SUMS_SIG_NAME.to_string(),
            "https://github.com/attacker/evil/releases/download/v1/SHA256SUMS.sig".to_string(),
            10,
        ));
        assert_eq!(pick_asset(&assets, InstallKind::Appimage).unwrap().signature, None);

        assets.push(asset(SUMS_SIG_NAME));
        let signature = pick_asset(&assets, InstallKind::Appimage)
            .unwrap()
            .signature
            .unwrap();
        assert!(signature.sums_url.ends_with("/SHA256SUMS"));
        assert!(signature.sig_url.ends_with("/SHA256SUMS.sig"));
        assert!(is_repo_download_url(&signature.sig_url));
    }

    #[test]
    fn a_staged_file_is_hashed_the_way_the_download_was() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("f");
        std::fs::write(&path, "deb").unwrap();
        assert_eq!(
            file_sha256(&path).unwrap(),
            "9cfa1468c93fc18652e34a000f0c6614b0fa18f6f4887477ad9b0d36ca6a7eaa"
        );
    }

    fn asset(name: &str) -> (String, String, u64) {
        (
            name.to_string(),
            format!("https://github.com/fseiffarth/ProjectEldrun/releases/download/v0.1.53/{name}"),
            10,
        )
    }

    #[test]
    fn asset_selection_follows_the_platform_not_the_release_order() {
        let assets = vec![
            asset("eldrun_0.1.53_amd64.deb"),
            asset("Eldrun_0.1.53_x64-setup.exe"),
            asset("eldrun_0.1.53_amd64.AppImage"),
            asset("Eldrun_0.1.53_universal.dmg"),
        ];
        assert_eq!(
            pick_asset(&assets, InstallKind::Nsis).unwrap().name,
            "Eldrun_0.1.53_x64-setup.exe"
        );
        assert_eq!(
            pick_asset(&assets, InstallKind::Dmg).unwrap().name,
            "Eldrun_0.1.53_universal.dmg"
        );
        // AppImage wins over the .deb for both Linux kinds.
        assert_eq!(
            pick_asset(&assets, InstallKind::Appimage).unwrap().name,
            "eldrun_0.1.53_amd64.AppImage"
        );
        assert_eq!(
            pick_asset(&assets, InstallKind::Manual).unwrap().name,
            "eldrun_0.1.53_amd64.AppImage"
        );
    }

    #[test]
    fn an_asset_hosted_elsewhere_is_not_offered() {
        let assets = vec![(
            "Eldrun_0.1.53_x64-setup.exe".to_string(),
            "https://evil.example.org/Eldrun_0.1.53_x64-setup.exe".to_string(),
            10,
        )];
        assert!(pick_asset(&assets, InstallKind::Nsis).is_none());
    }

    #[test]
    fn a_release_with_no_artifact_for_us_picks_nothing() {
        let assets = vec![asset("eldrun_0.1.53_amd64.deb")];
        assert!(pick_asset(&assets, InstallKind::Nsis).is_none());
        assert!(pick_asset(&assets, InstallKind::Dmg).is_none());
    }

    #[test]
    fn an_untrusted_asset_name_cannot_choose_where_the_file_lands() {
        assert_eq!(safe_file_name("../../.bashrc"), "bashrc");
        assert_eq!(safe_file_name("a/b/c.AppImage"), "abc.AppImage");
        assert_eq!(safe_file_name(""), concat!(crate::app_slug!(), "-update"));
        assert_eq!(safe_file_name("..."), concat!(crate::app_slug!(), "-update"));
        assert_eq!(
            safe_file_name("Eldrun_0.1.53_amd64.AppImage"),
            "Eldrun_0.1.53_amd64.AppImage"
        );
    }

    const RELEASE_JSON: &str = r#"{
      "tag_name": "v0.1.53",
      "name": "Eldrun 0.1.53",
      "body": "- Linux: `.AppImage` (portable) and `.deb`",
      "published_at": "2026-08-20T10:00:00Z",
      "html_url": "https://github.com/fseiffarth/ProjectEldrun/releases/tag/v0.1.53",
      "assets": [
        {"name": "eldrun_0.1.53_amd64.AppImage", "size": 120,
         "browser_download_url": "https://github.com/fseiffarth/ProjectEldrun/releases/download/v0.1.53/eldrun_0.1.53_amd64.AppImage"},
        {"name": "Eldrun_0.1.53_x64-setup.exe", "size": 130,
         "browser_download_url": "https://github.com/fseiffarth/ProjectEldrun/releases/download/v0.1.53/Eldrun_0.1.53_x64-setup.exe"}
      ]
    }"#;

    #[test]
    fn a_newer_release_reports_an_asset_for_this_platform() {
        let check = parse_release(RELEASE_JSON, "0.1.52", InstallKind::Appimage).unwrap();
        assert!(check.update_available);
        assert_eq!(check.latest.as_deref(), Some("0.1.53"));
        assert_eq!(check.tag.as_deref(), Some("v0.1.53"));
        assert_eq!(
            check.asset.as_ref().unwrap().name,
            "eldrun_0.1.53_amd64.AppImage"
        );
        assert_eq!(check.asset.unwrap().size, 120);
    }

    #[test]
    fn being_current_offers_nothing_to_download() {
        let check = parse_release(RELEASE_JSON, "0.1.53", InstallKind::Appimage).unwrap();
        assert!(!check.update_available);
        assert!(check.asset.is_none());
        // A newer local build (a dev checkout ahead of the tag) is not "behind".
        let ahead = parse_release(RELEASE_JSON, "0.2.0", InstallKind::Appimage).unwrap();
        assert!(!ahead.update_available);
    }

    #[test]
    fn a_release_page_link_is_never_taken_from_an_arbitrary_host() {
        let hostile = r#"{"tag_name":"v9.9.9","html_url":"https://evil.example.org/x","assets":[]}"#;
        let check = parse_release(hostile, "0.1.52", InstallKind::Appimage).unwrap();
        assert_eq!(check.html_url, RELEASES_PAGE);
        assert!(check.asset.is_none());
    }

    #[test]
    fn an_empty_body_is_reported_as_no_notes_rather_than_an_empty_card() {
        let json = r#"{"tag_name":"v0.1.53","body":"   ","name":"","assets":[]}"#;
        let check = parse_release(json, "0.1.52", InstallKind::Appimage).unwrap();
        assert!(check.notes.is_none());
        assert!(check.name.is_none());
    }

    #[test]
    fn a_non_json_answer_is_an_error_not_a_panic() {
        assert!(parse_release("<html>502</html>", "0.1.52", InstallKind::Appimage).is_err());
    }
}
