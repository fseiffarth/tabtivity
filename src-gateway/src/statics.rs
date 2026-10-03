//! The phone PWA's files, served by the gateway before a device has signed
//! in (pairing happens in the PWA). Same rules as the sidecar's
//! `host::serve_asset`: hashed `/assets/*` never fall back to the shell, the
//! SPA fallback covers app routes only, and the same security headers.

use std::path::{Path, PathBuf};

/// The phone CSP of `host::security_headers`.
pub const PWA_CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
/// `host::MOBILE_PERMISSIONS_POLICY`.
pub const PERMISSIONS_POLICY: &str = "camera=(), microphone=(self), on-device-speech-recognition=(self), geolocation=(), payment=(), usb=()";

/// The file a request path names under `root`, or `None` for anything that
/// could leave it (`..`, empty or dot segments, backslashes, NUL).
pub fn resolve(root: &Path, request_path: &str) -> Option<PathBuf> {
    let rel = request_path.strip_prefix('/')?;
    let rel = if rel.is_empty() { "index.html" } else { rel };
    let mut path = root.to_path_buf();
    for part in rel.split('/') {
        if part.is_empty() || part == "." || part == ".." || part.contains('\\') || part.contains('\0') {
            return None;
        }
        path.push(part);
    }
    Some(path)
}

/// What to serve for `request_path`: `(served path, bytes, mime, cache)`.
pub fn lookup(root: &Path, request_path: &str) -> Option<(String, Vec<u8>, String, &'static str)> {
    let read = |p: &str| -> Option<Vec<u8>> {
        let file = resolve(root, p)?;
        let meta = std::fs::symlink_metadata(&file).ok()?;
        meta.is_file().then(|| std::fs::read(&file).ok()).flatten()
    };
    let (served, bytes) = match read(request_path) {
        Some(bytes) => (if request_path == "/" { "/index.html".to_string() } else { request_path.to_string() }, bytes),
        None if request_path.starts_with("/assets/") || request_path.starts_with("/api/") => return None,
        None => ("/index.html".to_string(), read("/index.html")?),
    };
    let mime = mime_guess::from_path(&served).first_or_octet_stream().essence_str().to_string();
    let mime = if mime.starts_with("text/") || mime == "application/javascript" { format!("{mime}; charset=utf-8") } else { mime };
    let cache = if served.starts_with("/assets/") { "public, max-age=31536000, immutable" } else { "no-cache" };
    Some((served, bytes, mime, cache))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_stay_inside_and_assets_never_fall_back() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("assets")).unwrap();
        std::fs::write(dir.path().join("index.html"), "<html>").unwrap();
        std::fs::write(dir.path().join("assets/app-1.js"), "x").unwrap();
        assert!(resolve(dir.path(), "/../etc/passwd").is_none());
        assert!(resolve(dir.path(), "/a//b").is_none());
        assert!(resolve(dir.path(), "/a\\b").is_none());
        let (served, _, mime, cache) = lookup(dir.path(), "/").unwrap();
        assert_eq!((served.as_str(), cache), ("/index.html", "no-cache"));
        assert!(mime.starts_with("text/html"));
        let (_, _, mime, cache) = lookup(dir.path(), "/assets/app-1.js").unwrap();
        assert!(mime.contains("javascript"), "{mime}");
        assert!(cache.contains("immutable"));
        assert!(lookup(dir.path(), "/assets/app-0.js").is_none());
        assert!(lookup(dir.path(), "/api/v1/x").is_none());
        assert_eq!(lookup(dir.path(), "/projects/7").unwrap().0, "/index.html");
    }
}
