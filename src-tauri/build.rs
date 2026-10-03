// The brand module is shared with the crate it builds, so the names this
// script exports are spelled where every other name is.
#[allow(dead_code)]
#[path = "../src-core/src/brand.rs"]
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

/// The non-English dictionary chunks vite emits for `src/lib/i18n.ts`'s
/// `dictLoaders` (`/assets/de-<hash>.js` and siblings, ~0.5 MB each).
///
/// The phone can never request one, so they are not baked in. The only trigger
/// for a dictionary load is `ensureDict(cachedLang())`, `cachedLang()` reads the
/// `tabtivity-lang` localStorage key, and that key is written only by
/// `applyLanguage` — desktop code the PWA never imports (it takes `useT` and
/// `TranslationKey` from i18n, nothing else) — on the desktop webview's own
/// origin, not the sidecar's. So on the phone the language is always `en`.
/// Were one ever requested, the sidecar answers a missing `/assets/` path with a
/// 404 and `ensureDict` falls back to English. **If the phone gains a language
/// switcher, delete this filter.**
///
/// The match is exact — a two-letter language, a dash, an 8-character rollup
/// hash, `.js`, directly under `/assets/` — so a vite hash-length change makes
/// it match nothing and bake everything in, the harmless direction.
fn is_unreachable_dict_chunk(name: &str) -> bool {
    let Some(file) = name.strip_prefix("/assets/") else {
        return false;
    };
    ["de", "es", "fr", "it"].iter().any(|lang| {
        file.strip_prefix(lang)
            .and_then(|rest| rest.strip_prefix('-'))
            .and_then(|rest| rest.strip_suffix(".js"))
            .is_some_and(|hash| {
                hash.len() == 8
                    && hash
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            })
    })
}

fn generate_mobile_assets() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("manifest dir"));
    let dist = manifest.join("../mobile-dist");
    println!("cargo:rerun-if-changed={}", dist.display());
    let mut assets = Vec::new();
    collect(&dist, &dist, &mut assets);
    assets.retain(|(name, _)| !is_unreachable_dict_chunk(name));
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

// ── The `core` dispatcher (hosted plan §3.2, §10 P2) ──────────────────────
//
// A server host calls command bodies as plain functions with a `CoreCtx`; the
// one table that says how is generated here from the command files themselves,
// so it cannot drift from what `generate_handler!` registers: every
// `#[tauri::command]` fn whose parameters are Tauri-free (a `Ctx`, and values
// the frontend sends as JSON) gets a wrapper that reads its arguments by the
// camelCase keys Tauri uses and answers JSON. A command still taking `State`,
// `AppHandle`, `Window` or a raw IPC body is listed as not dispatchable with
// the reason, and `services::core_dispatch` hides it through
// `server_capabilities`. The class check (`services::command_class`) is the
// runtime module's, before any of this runs.

/// One parameter of a command, as the wrapper reads it.
enum Param {
    /// The host context (`tauri_host::Ctx`).
    Ctx,
    /// A JSON argument, by the key the frontend sends. Its Rust type is never
    /// spelled: the wrapper lets the call infer it, so a type the command file
    /// imports privately needs no path here.
    Json { key: String },
}

/// What a command answers with.
enum Ret {
    Unit,
    Plain,
    Result,
}

struct CommandSig {
    module: String,
    name: String,
    is_async: bool,
    cfg: Vec<String>,
    params: Vec<Param>,
    ret: Ret,
}

/// `project_id` → `projectId`: what `#[tauri::command]` does to every
/// argument name (heck's lower camel case; the default `rename_all`). A raw
/// identifier loses its `r#`; leading underscores go, as heck drops them.
fn camel_key(ident: &str) -> String {
    let ident = ident.strip_prefix("r#").unwrap_or(ident);
    let mut out = String::new();
    for (i, part) in ident.split('_').filter(|p| !p.is_empty()).enumerate() {
        let lower = part.to_ascii_lowercase();
        if i == 0 {
            out.push_str(&lower);
        } else {
            let mut chars = lower.chars();
            if let Some(first) = chars.next() {
                out.extend(first.to_uppercase());
                out.push_str(chars.as_str());
            }
        }
    }
    out
}

/// `#[tauri::command]`, or the form every command file uses so the library
/// also builds without Tauri: `#[cfg_attr(feature = "desktop", tauri::command)]`.
fn is_tauri_command(attr: &syn::Attribute) -> bool {
    let segments: Vec<String> = attr.path().segments.iter().map(|s| s.ident.to_string()).collect();
    if segments == ["tauri", "command"] {
        return true;
    }
    attr.path().is_ident("cfg_attr") && quote::ToTokens::to_token_stream(attr).to_string().replace(' ', "").contains(",tauri::command")
}

fn type_text(ty: &syn::Type) -> String {
    quote::ToTokens::to_token_stream(ty).to_string().replace(' ', "")
}

/// Why a parameter cannot be read from a JSON frame, or `None` when it can.
fn undispatchable_param(ty: &str) -> Option<&'static str> {
    if ty.contains("tauri::") || ty.contains("ipc::") {
        return Some("takes a Tauri type");
    }
    if ty.contains("State<") {
        return Some("takes Tauri `State`");
    }
    if ty.contains("AppHandle") {
        return Some("takes an `AppHandle`");
    }
    if ty.contains("Window") || ty.contains("Webview") {
        return Some("takes a `Window`");
    }
    if ty.contains("Request<") || ty.contains("Channel<") {
        return Some("takes a raw IPC body or channel");
    }
    None
}

fn command_sigs(module: &str, file: &syn::File) -> Vec<Result<CommandSig, (String, String)>> {
    let mut out = Vec::new();
    for item in &file.items {
        let syn::Item::Fn(func) = item else { continue };
        if !func.attrs.iter().any(is_tauri_command) {
            continue;
        }
        let name = func.sig.ident.to_string();
        let cfg = func
            .attrs
            .iter()
            .filter(|a| a.path().is_ident("cfg"))
            .map(|a| quote::ToTokens::to_token_stream(a).to_string())
            .collect();
        let mut params = Vec::new();
        let mut refused: Option<String> = None;
        for input in &func.sig.inputs {
            let syn::FnArg::Typed(pat) = input else {
                refused = Some("takes `self`".into());
                break;
            };
            let ty = type_text(&pat.ty);
            let last = ty.rsplit("::").next().unwrap_or(&ty);
            if last == "Ctx" {
                params.push(Param::Ctx);
                continue;
            }
            if let Some(reason) = undispatchable_param(&ty) {
                refused = Some(reason.into());
                break;
            }
            let ident = match &*pat.pat {
                syn::Pat::Ident(p) => p.ident.to_string(),
                syn::Pat::Wild(_) => String::new(),
                other => {
                    refused = Some(format!(
                        "has a destructuring parameter `{}`",
                        quote::ToTokens::to_token_stream(other)
                    ));
                    break;
                }
            };
            params.push(Param::Json { key: camel_key(&ident) });
        }
        if let Some(reason) = refused {
            out.push(Err((name, reason)));
            continue;
        }
        let ret = match &func.sig.output {
            syn::ReturnType::Default => Ret::Unit,
            syn::ReturnType::Type(_, ty) => {
                let text = type_text(ty);
                if text.contains("tauri::") || text.contains("ipc::") {
                    out.push(Err((name, "returns a raw IPC body".into())));
                    continue;
                }
                match &**ty {
                    syn::Type::Path(p) if p.path.segments.last().is_some_and(|s| s.ident == "Result") => {
                        Ret::Result
                    }
                    _ => Ret::Plain,
                }
            }
        };
        out.push(Ok(CommandSig {
            module: module.to_string(),
            name,
            is_async: func.sig.asyncness.is_some(),
            cfg,
            params,
            ret,
        }));
    }
    out
}

fn wrapper_source(sig: &CommandSig) -> String {
    let mut src = String::new();
    for cfg in &sig.cfg {
        src.push_str(cfg);
        src.push('\n');
    }
    src.push_str(&format!(
        "fn h_{name}(ctx: app_core::CoreCtx, args: serde_json::Value) -> BoxFuture {{\n    Box::pin(async move {{\n        let _ = &args;\n        let _ = &ctx;\n",
        name = sig.name
    ));
    let mut call_args = Vec::new();
    for (i, param) in sig.params.iter().enumerate() {
        match param {
            Param::Ctx => call_args.push("crate::tauri_host::Ctx(ctx.clone())".to_string()),
            Param::Json { key } => {
                src.push_str(&format!(
                    "        let a{i} = arg(&args, {key:?}, {name:?})?;\n",
                    name = sig.name
                ));
                call_args.push(format!("a{i}"));
            }
        }
    }
    let call = format!("crate::commands::{}::{}({})", sig.module, sig.name, call_args.join(", "));
    let invoke = if sig.is_async {
        format!("{call}.await")
    } else {
        // A sync body may block (file IO, a process): it runs on the blocking
        // pool, as Tauri keeps it off its async runtime too.
        format!("blocking(move || {call}).await?")
    };
    let answer = match sig.ret {
        Ret::Unit => format!("        {invoke};\n        Ok(serde_json::Value::Null)\n"),
        Ret::Plain => format!("        let out = {invoke};\n        to_json(out)\n"),
        Ret::Result => format!("        let out = {invoke};\n        result_to_json(out)\n"),
    };
    src.push_str(&answer);
    src.push_str("    })\n}\n\n");
    src
}

fn generate_core_dispatch() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("manifest dir"));
    let dir = manifest.join("src/commands");
    println!("cargo:rerun-if-changed={}", dir.display());
    let mut files: Vec<PathBuf> = fs::read_dir(&dir)
        .expect("read src/commands")
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "rs") && p.file_stem().is_some_and(|s| s != "mod"))
        .collect();
    files.sort();
    // Modules `mod.rs` declares under a cfg (the desktop-only ones): their
    // wrappers carry the same cfg, so the daemon's build leaves them out.
    let mod_rs = fs::read_to_string(dir.join("mod.rs")).expect("read commands/mod.rs");
    let mut gated: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut pending: Option<String> = None;
    for line in mod_rs.lines().map(str::trim) {
        if line.starts_with("#[cfg(") {
            pending = Some(line.to_string());
        } else if let Some(name) = line.strip_prefix("pub mod ").and_then(|l| l.strip_suffix(';')) {
            if let Some(cfg) = pending.take() {
                gated.insert(name.to_string(), cfg);
            }
        } else if !line.starts_with("//") && !line.is_empty() {
            pending = None;
        }
    }
    let mut sigs = Vec::new();
    let mut gaps: Vec<(String, String)> = Vec::new();
    for path in &files {
        println!("cargo:rerun-if-changed={}", path.display());
        let module = path.file_stem().unwrap().to_string_lossy().into_owned();
        let text = fs::read_to_string(path).expect("read command file");
        let file = syn::parse_file(&text).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        for sig in command_sigs(&module, &file) {
            match sig {
                Ok(mut sig) => {
                    if let Some(cfg) = gated.get(&module) {
                        sig.cfg.insert(0, cfg.clone());
                    }
                    sigs.push(sig)
                }
                Err(gap) => gaps.push(gap),
            }
        }
    }
    let mut generated = String::from(
        "// Generated by build.rs from src/commands/*.rs — do not edit.\n\n",
    );
    for sig in &sigs {
        generated.push_str(&wrapper_source(sig));
    }
    generated.push_str("/// The wrapper of one dispatchable command, by its registered name.\npub fn handler(cmd: &str) -> Option<Handler> {\n    match cmd {\n");
    for sig in &sigs {
        for cfg in &sig.cfg {
            generated.push_str("        ");
            generated.push_str(cfg);
            generated.push('\n');
        }
        generated.push_str(&format!("        {:?} => Some(h_{} as Handler),\n", sig.name, sig.name));
    }
    generated.push_str("        _ => None,\n    }\n}\n\n");
    generated.push_str("/// Every command whose signature the wrapper could not read, with why.\npub static NOT_DISPATCHABLE: &[(&str, &str)] = &[\n");
    gaps.sort();
    for (name, reason) in &gaps {
        generated.push_str(&format!("    ({name:?}, {reason:?}),\n"));
    }
    generated.push_str("];\n\n/// Every dispatchable command, by name (table order of the files).\npub fn dispatchable_names() -> Vec<&'static str> {\n    let mut names = Vec::new();\n");
    for sig in &sigs {
        for cfg in &sig.cfg {
            generated.push_str("    ");
            generated.push_str(cfg);
            generated.push('\n');
        }
        generated.push_str(&format!("    names.push({:?});\n", sig.name));
    }
    generated.push_str("    names\n}\n");
    let out = PathBuf::from(env::var("OUT_DIR").expect("out dir")).join("core_dispatch.rs");
    fs::write(out, generated).expect("write core dispatch");
}

fn main() {
    watch_frontend_dist();
    embed_build_commit();
    generate_mobile_assets();
    generate_help_corpus();
    generate_core_dispatch();
    // Only the desktop build is a Tauri app; the server daemon builds this
    // library with `default-features = false` (hosted plan §3.2).
    #[cfg(feature = "desktop")]
    tauri_build::build();
}
