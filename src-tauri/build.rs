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
    // The only phone app the binary serves, dev builds included: nothing read
    // off the disk at run time can stand in for it (threat recheck 2026-10-08,
    // gap 20 — the dev-only overlay from `target/mobile-pwa/` is gone).
    let generated = format!("pub static MOBILE_ASSETS: &[(&str, &[u8], &str)] = &[{rows}];\n");
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

/// tauri-build's default Windows app manifest: it binds Common Controls v6,
/// the only comctl32 that exports `TaskDialogIndirect` (the dialog plugin's
/// message boxes).
#[cfg(feature = "desktop")]
const WINDOWS_APP_MANIFEST: &str = concat!(
    r#"<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity
        type="win32"
        name="Microsoft.Windows.Common-Controls"
"#,
    "        version=\"6.0.0.0\"\n", // privacy-check: ok — an assembly version, not an address
    r#"        processorArchitecture="*"
        publicKeyToken="6595b64144ccf1df"
        language="*"
      />
    </dependentAssembly>
  </dependency>
</assembly>
"#
);

/// tauri-build puts the manifest in a resource that reaches only the app
/// binary, so the lib's test binary loaded System32's comctl32 5.82 and died
/// before its first test (0xc0000139, STATUS_ENTRYPOINT_NOT_FOUND, CI
/// 2026-10-05). On MSVC the manifest goes through the linker instead, which
/// reaches every linked target; tauri-build's copy is switched off so the
/// app binary does not get two.
#[cfg(feature = "desktop")]
fn build_tauri() {
    let msvc = env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc");
    if !msvc {
        tauri_build::build();
        return;
    }
    let path = PathBuf::from(env::var("OUT_DIR").expect("out dir")).join("windows-app-manifest.xml");
    fs::write(&path, WINDOWS_APP_MANIFEST).expect("write the Windows app manifest");
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", path.display());
    let windows = tauri_build::WindowsAttributes::new_without_app_manifest();
    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
        .expect("failed to run tauri-build");
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
    build_tauri();
}
