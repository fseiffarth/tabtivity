//! The PWA a *commit* published, served by a sidecar that was compiled before
//! it existed.
//!
//! The phone bundle is baked into this binary (`build.rs` embeds
//! `mobile-dist/`), so the sidecar can only ever serve the bundle as of its own
//! compile. The running window keeps its old inode across an install by design
//! — `package-dev.sh` replaces the path, the open window does not follow — and
//! the phone therefore stayed on whatever was current at the last relaunch,
//! with only `scripts/backend-stale.sh` to say so.
//!
//! This is the way out that does not cost a relaunch: `package-dev.sh`
//! publishes the bundle it just built from `HEAD` into a fixed directory, and
//! the running sidecar serves *that* instead. The phone reloads over HTTP, so a
//! pull-to-refresh is the whole update path.
//!
//! Three things keep it honest:
//!
//! - **Opt-in at compile time.** `MOBILE_LIVE_DIR` is `None` unless
//!   `TABTIVITY_MOBILE_LIVE_DIR` was set when this binary was built, which only the
//!   two dev shapes do. A released Tabtivity has no overlay path at all and reads
//!   nothing off the disk.
//! - **Never backwards.** An overlay is used only when it is *newer* than the
//!   bundle compiled in (`MOBILE_ASSETS_BUILT_AT`), so an abandoned branch's
//!   leftovers cannot shadow a freshly built binary.
//! - **All or nothing.** A bundle is one non-split entry under a hashed,
//!   immutable URL plus the shell that names it. Serving the overlay's
//!   `index.html` beside the embedded bundle's assets — or the reverse — is a
//!   white screen, so a bundle missing its shell or its stamped entry is
//!   refused whole and the embedded one answers everything.
//!
//! The overlay is the bundle only. The sidecar's own HTTP API is this binary's,
//! which is what "the phone can run ahead of the desktop" means here: a mobile
//! feature whose backend half is not in the running window will render and then
//! fail its request until the user relaunches. `backend-stale.sh` reports that
//! gap rather than hiding it.

use std::{
    collections::HashMap,
    fs,
    path::Path,
    sync::{Arc, RwLock},
    time::UNIX_EPOCH,
};

use bytes::Bytes;

use super::{MOBILE_ASSETS_BUILT_AT, MOBILE_LIVE_DIR};

/// Refuse to read a directory that is not a bundle. A published PWA is ~1.7 MB
/// across a dozen files; these bounds cost nothing against that and stop a
/// mistyped path from pulling a source tree into RSS.
const MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 64 * 1024 * 1024;

/// One published bundle, whole and in memory.
pub struct LivePwa {
    /// Epoch seconds, from the stamp — compared against `MOBILE_ASSETS_BUILT_AT`.
    pub built_at: i64,
    /// The short commit the bundle was built from, for the staleness report.
    pub commit: String,
    files: HashMap<String, (Bytes, &'static str)>,
}

impl LivePwa {
    /// `Bytes` is refcounted, so a hit costs a clone of the handle, not of the
    /// megabyte behind it.
    pub fn get(&self, path: &str) -> Option<(Bytes, &'static str)> {
        self.files
            .get(path)
            .map(|(body, mime)| (body.clone(), *mime))
    }
}

/// What was loaded, and the stamp signature it was loaded for. `signature` is
/// `None` both when the directory holds no stamp and when there is no overlay
/// directory at all, so the miss is cached as cheaply as the hit.
struct Cache {
    signature: Option<(u128, u64)>,
    pwa: Option<Arc<LivePwa>>,
}

static CACHE: RwLock<Cache> = RwLock::new(Cache {
    signature: None,
    pwa: None,
});

/// The overlay to serve right now, or `None` to serve the embedded bundle.
///
/// Costs one `stat` of the stamp per call in the steady state; the bundle is
/// re-read only when that stamp moves, which is once per published commit.
pub fn current() -> Option<Arc<LivePwa>> {
    let dir = Path::new(MOBILE_LIVE_DIR?);
    let signature = stamp_signature(dir);
    if let Ok(cache) = CACHE.read() {
        if cache.signature == signature {
            return cache.pwa.clone();
        }
    }
    // Only a present stamp is worth a read: publishing writes it last, so its
    // absence means "half a bundle" as often as it means "no bundle".
    let loaded = signature
        .and_then(|_| load(dir, MOBILE_ASSETS_BUILT_AT))
        .map(Arc::new);
    let Ok(mut cache) = CACHE.write() else {
        return loaded;
    };
    cache.signature = signature;
    cache.pwa = loaded;
    cache.pwa.clone()
}

/// mtime and length together: a publish that lands within the filesystem's
/// mtime granularity still changes the stamp's length (the commit differs), and
/// one that somehow does not is the same commit republished.
fn stamp_signature(dir: &Path) -> Option<(u128, u64)> {
    let meta = fs::metadata(dir.join(".stamp")).ok()?;
    let mtime = meta
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_nanos();
    Some((mtime, meta.len()))
}

/// Read a published bundle, or `None` if it is missing, older than `floor`, or
/// not a whole bundle. `floor` is a parameter rather than the constant so the
/// tests can pin it.
fn load(dir: &Path, floor: i64) -> Option<LivePwa> {
    let stamp = fs::read_to_string(dir.join(".stamp")).ok()?;
    let mut built_at = 0i64;
    let mut commit = String::new();
    let mut entry = String::new();
    for line in stamp.lines() {
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        match key.trim() {
            "built" => built_at = value.trim().parse().unwrap_or(0),
            "commit" => commit = value.trim().to_string(),
            "entry" => entry = value.trim().to_string(),
            _ => {}
        }
    }
    if built_at <= floor {
        return None;
    }
    let mut files = HashMap::new();
    let mut total = 0u64;
    collect(dir, dir, &mut files, &mut total);
    // All or nothing: a shell without its entry, or an entry without its shell,
    // is a white screen dressed as an upgrade.
    if !files.contains_key("/index.html") {
        return None;
    }
    if !entry.is_empty() && !files.contains_key(&entry) {
        return None;
    }
    Some(LivePwa {
        built_at,
        commit,
        files,
    })
}

fn collect(
    dir: &Path,
    root: &Path,
    out: &mut HashMap<String, (Bytes, &'static str)>,
    total: &mut u64,
) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        // Symlinks are not part of a vite bundle, and following one is how a
        // stray `node_modules` link would blow the budget below.
        if !matches!(entry.file_type(), Ok(kind) if !kind.is_symlink()) {
            continue;
        }
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') {
            continue;
        }
        if path.is_dir() {
            collect(&path, root, out, total);
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if meta.len() > MAX_FILE_BYTES || *total + meta.len() > MAX_TOTAL_BYTES {
            continue;
        }
        let Ok(bytes) = fs::read(&path) else { continue };
        *total += bytes.len() as u64;
        let Ok(rel) = path.strip_prefix(root) else {
            continue;
        };
        let key = format!("/{}", rel.to_string_lossy().replace('\\', "/"));
        let mime = mime_for(&key);
        out.insert(key, (Bytes::from(bytes), mime));
    }
}

/// The twin of the `match` in `build.rs::generate_mobile_assets`. The two must
/// agree: a bundle served with a different content type through the overlay
/// than through the embedded copy is a bug that only appears on one of them.
fn mime_for(name: &str) -> &'static str {
    match name.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "webmanifest" => "application/manifest+json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn publish(dir: &Path, stamp: &str, files: &[(&str, &str)]) {
        for (name, body) in files {
            let path = dir.join(name);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            fs::write(path, body).unwrap();
        }
        fs::write(dir.join(".stamp"), stamp).unwrap();
    }

    fn whole(built: i64) -> (String, Vec<(&'static str, &'static str)>) {
        (
            format!("built={built}\ncommit=abc1234\nentry=/assets/index-AAA.js\n"),
            vec![
                ("index.html", "<!doctype html>"),
                ("assets/index-AAA.js", "console.log(1)"),
            ],
        )
    }

    #[test]
    fn serves_a_bundle_newer_than_the_embedded_one() {
        let dir = tempfile::tempdir().unwrap();
        let (stamp, files) = whole(2_000);
        publish(dir.path(), &stamp, &files);
        let pwa = load(dir.path(), 1_000).expect("newer bundle is served");
        assert_eq!(pwa.commit, "abc1234");
        assert_eq!(pwa.built_at, 2_000);
        let (body, mime) = pwa.get("/assets/index-AAA.js").unwrap();
        assert_eq!(&body[..], b"console.log(1)");
        assert_eq!(mime, "text/javascript; charset=utf-8");
        assert_eq!(pwa.get("/index.html").unwrap().1, "text/html; charset=utf-8");
    }

    #[test]
    fn refuses_a_bundle_not_newer_than_the_embedded_one() {
        let dir = tempfile::tempdir().unwrap();
        let (stamp, files) = whole(1_000);
        publish(dir.path(), &stamp, &files);
        // Equal counts as "not newer": the binary was built from this publish.
        assert!(load(dir.path(), 1_000).is_none());
        assert!(load(dir.path(), 5_000).is_none());
    }

    #[test]
    fn refuses_a_bundle_missing_its_shell_or_its_entry() {
        let dir = tempfile::tempdir().unwrap();
        let (stamp, _) = whole(2_000);
        publish(
            dir.path(),
            &stamp,
            &[("assets/index-AAA.js", "console.log(1)")],
        );
        assert!(load(dir.path(), 1_000).is_none(), "no shell");

        let dir = tempfile::tempdir().unwrap();
        publish(dir.path(), &stamp, &[("index.html", "<!doctype html>")]);
        assert!(load(dir.path(), 1_000).is_none(), "no stamped entry");
    }

    #[test]
    fn refuses_a_directory_with_no_stamp() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("index.html"), "<!doctype html>").unwrap();
        assert!(load(dir.path(), 0).is_none());
        assert!(stamp_signature(dir.path()).is_none());
    }

    #[test]
    fn dotfiles_are_not_part_of_the_bundle() {
        let dir = tempfile::tempdir().unwrap();
        let (stamp, mut files) = whole(2_000);
        files.push((".hidden", "secret"));
        publish(dir.path(), &stamp, &files);
        let pwa = load(dir.path(), 1_000).unwrap();
        assert!(pwa.get("/.hidden").is_none());
        assert!(pwa.get("/.stamp").is_none());
    }
}
