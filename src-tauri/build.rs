// The brand module is shared with the crate it builds, so the names this
// script exports are spelled where every other name is.
#[allow(dead_code)]
#[path = "src/brand.rs"]
mod brand;

use crate::brand::UPPER;
use std::{
    env, fs,
    path::{Path, PathBuf},
};

fn rust_bytes(bytes: &[u8]) -> String {
    let mut out = String::from("&[");
    for (index, byte) in bytes.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        out.push_str(&byte.to_string());
    }
    out.push(']');
    out
}

/// The newest mtime under `mobile-dist/`, in epoch seconds, or 0 when the
/// directory is missing or unreadable.
///
/// This is the binary's own answer to "how old is the PWA baked into me?", and
/// the only thing that lets `live_pwa` refuse an overlay that is *older* than
/// what it would shadow. Without it a stale `target/mobile-pwa/` left behind by
/// an abandoned branch would keep serving itself to the phone after the user
/// upgraded to a newer Tabtivity — the exact staleness this whole mechanism exists
/// to end, only harder to see.
fn newest_mtime(dir: &Path) -> i64 {
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    let mut newest = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        let seen = if path.is_dir() {
            newest_mtime(&path)
        } else {
            entry
                .metadata()
                .ok()
                .and_then(|meta| meta.modified().ok())
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|age| age.as_secs() as i64)
                .unwrap_or(0)
        };
        newest = newest.max(seen);
    }
    newest
}

fn collect(dir: &Path, root: &Path, out: &mut Vec<(String, Vec<u8>)>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect(&path, root, out);
        } else if let Ok(bytes) = fs::read(&path) {
            let name = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            out.push((format!("/{name}"), bytes));
        }
    }
}

fn generate_mobile_assets() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("manifest dir"));
    let dist = manifest.join("../mobile-dist");
    println!("cargo:rerun-if-changed={}", dist.display());
    let mut assets = Vec::new();
    collect(&dist, &dist, &mut assets);
    if !assets.iter().any(|(name, _)| name == "/index.html") {
        assets.push(("/index.html".into(), concat!("<!doctype html><title>", crate::app_name!(), " Mobile</title><main>Mobile assets are not built. Run npm run mobile:build.</main>").as_bytes().to_vec()));
    }
    assets.sort_by(|a, b| a.0.cmp(&b.0));
    let rows = assets
        .into_iter()
        .map(|(name, bytes)| {
            let mime = match name.rsplit('.').next().unwrap_or("") {
                "html" => "text/html; charset=utf-8",
                "js" => "text/javascript; charset=utf-8",
                "css" => "text/css; charset=utf-8",
                "json" | "webmanifest" => "application/manifest+json",
                "svg" => "image/svg+xml",
                "png" => "image/png",
                _ => "application/octet-stream",
            };
            format!("({name:?}, {}, {mime:?})", rust_bytes(&bytes))
        })
        .collect::<Vec<_>>()
        .join(",\n");
    let built_at = newest_mtime(&dist);
    // Set only by the two dev shapes (`scripts/package-dev.sh`, `npm run
    // tauri:dev`); unset in CI and in every release build, where the constant
    // below is `None` and `live_pwa` compiles down to "there is no overlay".
    // That is deliberate: a shipped binary must never read a PWA off the disk.
    println!(concat!("cargo:rerun-if-env-changed=", crate::app_upper!(), "_MOBILE_LIVE_DIR"));
    let live_dir = match env::var(crate::app_env!("MOBILE_LIVE_DIR")) {
        Ok(dir) if !dir.trim().is_empty() => format!("Some({:?})", dir.trim()),
        _ => "None".to_string(),
    };
    let generated = format!(
        "pub static MOBILE_ASSETS: &[(&str, &[u8], &str)] = &[{rows}];\n\
         pub const MOBILE_ASSETS_BUILT_AT: i64 = {built_at};\n\
         pub static MOBILE_LIVE_DIR: Option<&str> = {live_dir};\n"
    );
    let out = PathBuf::from(env::var("OUT_DIR").expect("out dir")).join("mobile_assets.rs");
    fs::write(out, generated).expect("write mobile assets");
}

/// The desktop frontend is embedded by `generate_context!()` at macro expansion
/// time, and the only record of that is the crate's rustc depfile, which names
/// each asset by its vite content hash. On a rebuild those assets are not
/// modified, they are *renamed* — the recorded paths vanish — and cargo reused
/// the cached rlib rather than treating the deletion as dirty. The result was a
/// frozen `package:dev` binary whose frontend predated the `npm run build` that
/// had run three minutes earlier (2026-09-03), which the install-time assert
/// caught only as "does not embed the frontend". Watching the directory the way
/// mobile-dist is watched invalidates this script, and with it the crate, on
/// every bundle write.
fn watch_frontend_dist() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("manifest dir"));
    println!(
        "cargo:rerun-if-changed={}",
        manifest.join("../dist").display()
    );
}

/// Bake the commit this binary is compiled from in as `TABTIVITY_BUILD_COMMIT`,
/// for the side panel's version footer. It is the backend's commit on purpose:
/// the dev window's frontend hot-reloads and its vite server restarts on a
/// config edit, but the binary is what the window was launched as. Reruns when
/// HEAD moves (a checkout, a commit on the branch); unset outside git.
fn embed_build_commit() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("manifest dir"));
    let git = |args: &[&str]| -> Option<String> {
        let out = std::process::Command::new("git")
            .arg("-C")
            .arg(&manifest)
            .args(args)
            .output()
            .ok()?;
        let text = String::from_utf8(out.stdout).ok()?.trim().to_string();
        (out.status.success() && !text.is_empty()).then_some(text)
    };
    let Some(commit) = git(&["rev-parse", "--short", "HEAD"]) else {
        return;
    };
    println!("cargo:rustc-env={UPPER}_BUILD_COMMIT={commit}");
    let mut watched = vec!["HEAD".to_string(), "packed-refs".to_string()];
    if let Some(branch) = git(&["symbolic-ref", "-q", "HEAD"]) {
        watched.push(branch);
    }
    for name in watched {
        if let Some(path) = git(&["rev-parse", "--path-format=absolute", "--git-path", &name]) {
            println!("cargo:rerun-if-changed={path}");
        }
    }
}

/// Embed the help corpus (`docs/help/*.md`) for `services::help_mcp`: one
/// `include_str!` per file, sorted by name, so the binary serves exactly the
/// docs it was built from and never reads the project tree at runtime. A
/// missing directory yields an empty corpus rather than a failed build; the
/// `help_mcp` tests hold the real files to the front-matter contract.
fn generate_help_corpus() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("manifest dir"));
    let dir = manifest.join("../docs/help");
    println!("cargo:rerun-if-changed={}", dir.display());
    let mut files: Vec<(String, PathBuf)> = fs::read_dir(&dir)
        .map(|entries| {
            entries
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.is_file() && p.extension().is_some_and(|x| x == "md"))
                .filter_map(|p| {
                    let name = p.file_name()?.to_str()?.to_string();
                    let path = fs::canonicalize(&p).ok()?;
                    Some((name, path))
                })
                .collect()
        })
        .unwrap_or_default();
    files.sort();
    let rows = files
        .iter()
        .map(|(name, path)| format!("({name:?}, include_str!({:?}))", path.display().to_string()))
        .collect::<Vec<_>>()
        .join(",\n");
    let generated = format!("pub static HELP_CORPUS: &[(&str, &str)] = &[{rows}];\n");
    let out = PathBuf::from(env::var("OUT_DIR").expect("out dir")).join("help_corpus.rs");
    fs::write(out, generated).expect("write help corpus");
}

fn main() {
    watch_frontend_dist();
    embed_build_commit();
    generate_mobile_assets();
    generate_help_corpus();
    tauri_build::build()
}
