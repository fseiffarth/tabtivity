//! Source-formatting and syntax-checking command handlers backing the in-app
//! text viewer's "Format" button and inline validation banner.
//!
//! Formatting shells out to whatever external formatter is available for the
//! language — `prettier` (web/markup/JSON family), `black` (Python), `rustfmt`
//! (Rust), `gofmt` (Go) — each invoked over stdin→stdout so nothing touches
//! disk. Prettier is resolved from a project-local `node_modules/.bin` first
//! (walking up from the edited file) and only then from `PATH`, so a repo's
//! pinned formatter wins. When no tool is found the command returns a typed
//! `formatter-unavailable:<lang>` error and the frontend disables the button.
//!
//! Syntax checking is done in-process via `serde_json`/`serde_yaml`, which give
//! an exact line/column for the first parse error — more reliable than the
//! webview's `JSON.parse`, whose JavaScriptCore messages carry no position.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde::Serialize;

/// A resolved external formatter: the executable plus the args to invoke it with
/// (it always reads the source on stdin and writes the result to stdout).
struct Tool {
    program: PathBuf,
    args: Vec<String>,
    /// Directory to run the tool in (so prettier finds the repo's config), if
    /// the edited file's directory is known.
    cwd: Option<PathBuf>,
}

/// Find the first executable named `name` on `PATH`, if any.
fn on_path(name: &str) -> Option<PathBuf> {
    crate::paths::resolve_executable(name)
}

/// Walk up from `start` looking for a `node_modules/.bin/<name>` executable, so a
/// project's pinned prettier is preferred over a global one.
fn node_bin(start: &Path, name: &str) -> Option<PathBuf> {
    let mut dir = Some(start);
    while let Some(d) = dir {
        let bin_dir = d.join("node_modules").join(".bin");
        if let Some(cand) = crate::paths::resolve_executable_in_dir(&bin_dir, name) {
            return Some(cand);
        }
        dir = d.parent();
    }
    None
}

/// The extension a synthetic stdin filename should carry for `lang`, so prettier
/// can infer its parser when the real path is unknown.
fn synth_ext(lang: &str) -> &str {
    match lang {
        "css" => "css",
        "scss" => "scss",
        "less" => "less",
        "html" => "html",
        "json" => "json",
        "js" => "js",
        "jsx" => "jsx",
        "ts" => "ts",
        "tsx" => "tsx",
        "yaml" => "yaml",
        "vue" => "vue",
        "graphql" => "graphql",
        "markdown" => "md",
        "python" => "py",
        "rust" => "rs",
        "go" => "go",
        _ => "txt",
    }
}

/// Languages prettier handles in this app.
fn is_prettier_lang(lang: &str) -> bool {
    matches!(
        lang,
        "css"
            | "scss"
            | "less"
            | "html"
            | "json"
            | "js"
            | "jsx"
            | "ts"
            | "tsx"
            | "yaml"
            | "vue"
            | "graphql"
            | "markdown"
    )
}

/// Resolve the formatter for `lang`, using `path` (when known) to find a
/// project-local prettier and to label prettier's stdin parser. Returns `None`
/// when no suitable tool is installed.
fn resolve_tool(lang: &str, path: Option<&str>) -> Option<Tool> {
    let file_dir = path
        .and_then(|p| Path::new(p).parent())
        .map(Path::to_path_buf);
    let file_name = path
        .and_then(|p| Path::new(p).file_name())
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| format!("stdin.{}", synth_ext(lang)));

    if is_prettier_lang(lang) {
        let program = file_dir
            .as_deref()
            .and_then(|d| node_bin(d, "prettier"))
            .or_else(|| on_path("prettier"))?;
        return Some(Tool {
            program,
            args: vec!["--stdin-filepath".into(), file_name],
            cwd: file_dir,
        });
    }

    let (bin, args): (&str, Vec<String>) = match lang {
        // `black -q -` formats stdin → stdout quietly.
        "python" => ("black", vec!["-q".into(), "-".into()]),
        // rustfmt and gofmt both read stdin and write stdout with no args.
        "rust" => ("rustfmt", vec![]),
        "go" => ("gofmt", vec![]),
        _ => return None,
    };
    let program = on_path(bin)?;
    Some(Tool {
        program,
        args,
        cwd: file_dir,
    })
}

/// rustup's `rustfmt` proxy picks its toolchain from the nearest
/// `rust-toolchain`/`rust-toolchain.toml` above its cwd — the edited file's
/// folder, i.e. the project — and a toolchain *path* there (`[toolchain] path =
/// "/abs/tc"`, or a legacy file holding just a path) makes it exec that
/// directory's `bin/rustfmt` on the host (#866; verified with rustup 1.29). A
/// named channel only ever runs a toolchain rustup installed itself, so that
/// choice is honoured. Anything else — a path, or a file this cannot read as
/// plain channel settings — is overridden with the user's default toolchain
/// through `RUSTUP_TOOLCHAIN`, which rustup ranks above every toolchain file.
///
/// `Ok(None)` when there is nothing to pin: no toolchain file, a plain one, or
/// a `rustfmt` that is not a rustup proxy (no `rustup` beside it — the toolchain
/// file then means nothing to it). Refuses when a pin is needed but rustup
/// names no default toolchain, rather than run the project's.
fn rustup_toolchain_pin(rustfmt: &Path, cwd: &Path) -> Result<Option<String>, String> {
    let Some(text) = nearest_toolchain_file(cwd) else {
        return Ok(None);
    };
    if toolchain_file_is_plain_channel(&text) {
        return Ok(None);
    }
    let rustup = rustfmt.with_file_name(format!("rustup{}", std::env::consts::EXE_SUFFIX));
    if !rustup.is_file() {
        return Ok(None);
    }
    // `rustup default` reads rustup's own settings, never a toolchain file.
    let default = crate::paths::command_for_program(&rustup)
        .arg("default")
        .stdin(Stdio::null())
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| {
            String::from_utf8_lossy(&o.stdout)
                .split_whitespace()
                .next()
                .map(str::to_string)
        });
    default.map(Some).ok_or_else(|| {
        "rustfmt: this project's rust-toolchain file names a toolchain path, and rustup has no \
         default toolchain to format with instead"
            .to_string()
    })
}

/// The contents of the toolchain file rustup would read for `start`: the
/// nearest directory holding one wins, and within it both names are read (a
/// path in either counts).
fn nearest_toolchain_file(start: &Path) -> Option<String> {
    start.ancestors().find_map(|dir| {
        let found: Vec<String> = ["rust-toolchain", "rust-toolchain.toml"]
            .iter()
            .filter_map(|n| std::fs::read(dir.join(n)).ok())
            .map(|b| String::from_utf8_lossy(&b).into_owned())
            .collect();
        (!found.is_empty()).then(|| found.join("\n"))
    })
}

/// Whether a toolchain file is only named-channel settings: `[toolchain]` and
/// bare `channel`/`components`/`targets`/`profile` keys (a legacy one-line
/// channel name too), with nothing path-shaped anywhere. Deliberately a
/// whitelist of shapes rather than a TOML parse looking for `path` — a quoted
/// or escaped key (`"p\u0061th"`), a dotted one or an inline table all spell
/// `path` without the word, and every one of them fails this.
fn toolchain_file_is_plain_channel(text: &str) -> bool {
    if text.contains(['/', '\\', ':']) {
        return false;
    }
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .all(|l| match l.split_once('=') {
            Some((key, _)) => matches!(key.trim(), "channel" | "components" | "targets" | "profile"),
            None => {
                l == "[toolchain]"
                    || l.chars().all(|c| c.is_ascii_alphanumeric() || " \t\"'-_.,[]".contains(c))
            }
        })
}

/// Whether a formatter for `lang` is available (drives the button's enabled
/// state). `path` lets a project-local prettier count.
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn formatter_available(lang: String, path: Option<String>) -> bool {
    resolve_tool(&lang, path.as_deref()).is_some()
}

/// Format `text` as `lang` via the resolved external tool, returning the
/// formatted source. Errors:
///  - `formatter-unavailable:<lang>` when no tool is installed (frontend disables
///    the button and shows a hint),
///  - the tool's stderr (trimmed) when it exits non-zero (e.g. a syntax error).
// `(async)` on a *sync* fn, as for `check_syntax`: the body spawns an external
// formatter and waits for it (a cold prettier is node startup plus config
// resolution), which as a plain `#[tauri::command]` froze the whole window for
// the run. Tauri's blocking pool runs it instead; the body, its error strings
// and the unit tests calling it directly are unchanged.
#[cfg_attr(feature = "desktop", tauri::command(async))]
pub fn format_source(text: String, lang: String, path: Option<String>) -> Result<String, String> {
    let tool = resolve_tool(&lang, path.as_deref())
        .ok_or_else(|| format!("formatter-unavailable:{lang}"))?;
    // A project's own prettier, a JS config, a config loading plugins or naming
    // a shared config is project code run on the host: ask once
    // (`services::exec_trust`). black, rustfmt and gofmt read data-only configs
    // and need no gate — but *which* rustfmt runs is the project's choice too
    // when rustfmt is rustup's proxy, so that choice is pinned below.
    if is_prettier_lang(&lang) {
        if let Some(cwd) = &tool.cwd {
            crate::services::exec_trust::require(crate::services::exec_trust::TrustKind::Prettier, cwd)?;
        }
    }

    let mut cmd = crate::paths::command_for_program(&tool.program);
    cmd.args(&tool.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(cwd) = &tool.cwd {
        cmd.current_dir(cwd);
        if lang == "rust" {
            if let Some(toolchain) = rustup_toolchain_pin(&tool.program, cwd)? {
                cmd.env("RUSTUP_TOOLCHAIN", toolchain);
            }
        }
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("formatter-unavailable:{lang}: {e}"))?;

    // Write the source and drop the handle so the tool sees EOF, then collect
    // output. Dropping before `wait_with_output` avoids a stdin/stdout deadlock.
    {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "could not open formatter stdin".to_string())?;
        stdin
            .write_all(text.as_bytes())
            .map_err(|e| e.to_string())?;
    }

    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        let err = String::from_utf8_lossy(&output.stderr);
        let trimmed = err.trim();
        Err(if trimmed.is_empty() {
            format!("{} exited with a non-zero status", tool.program.display())
        } else {
            trimmed.to_string()
        })
    }
}

/// The first parse error in a checked document: 1-based `line`/`column` and the
/// parser's message. Columns/lines of 0 mean "position unknown".
#[derive(Debug, Serialize)]
pub struct SyntaxIssue {
    pub line: usize,
    pub column: usize,
    pub message: String,
}

/// Validate `text` as `lang` (`"json"` or `"yaml"`), returning the first parse
/// error or `None` when it is well-formed. Whitespace-only input is treated as
/// valid (an empty buffer isn't an error to surface while typing). Any other
/// `lang` is unchecked and returns `None`.
// `(async)` on a *sync* fn: tauri runs the body on its blocking threadpool
// instead of the GTK main thread. The body parses an entire editor draft (up
// to the 8 MiB viewer limit) on every check, and a plain `#[tauri::command]`
// would freeze the whole window for the length of that parse. Kept a plain fn
// so the return type (and the unit tests) stay `Option<SyntaxIssue>`.
#[cfg_attr(feature = "desktop", tauri::command(async))]
pub fn check_syntax(text: String, lang: String) -> Option<SyntaxIssue> {
    if text.trim().is_empty() {
        return None;
    }
    match lang.as_str() {
        "json" => match serde_json::from_str::<serde::de::IgnoredAny>(&text) {
            Ok(_) => None,
            Err(e) => Some(SyntaxIssue {
                line: e.line(),
                column: e.column(),
                message: e.to_string(),
            }),
        },
        "yaml" => match serde_yaml::from_str::<serde_yaml::Value>(&text) {
            Ok(_) => None,
            Err(e) => {
                let (line, column) = e
                    .location()
                    .map(|loc| (loc.line(), loc.column()))
                    .unwrap_or((0, 0));
                Some(SyntaxIssue {
                    line,
                    column,
                    message: e.to_string(),
                })
            }
        },
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_ok_is_none() {
        assert!(check_syntax("{\"a\": 1}".into(), "json".into()).is_none());
    }

    #[test]
    fn json_error_reports_position() {
        let issue = check_syntax("{\"a\": }".into(), "json".into()).expect("should error");
        assert_eq!(issue.line, 1);
        assert!(issue.column > 0);
    }

    #[test]
    fn blank_input_is_valid() {
        assert!(check_syntax("   \n  ".into(), "json".into()).is_none());
        assert!(check_syntax("".into(), "yaml".into()).is_none());
    }

    #[test]
    fn yaml_ok_and_error() {
        assert!(check_syntax("a: 1\nb: 2\n".into(), "yaml".into()).is_none());
        // A tab in indentation is invalid YAML.
        assert!(check_syntax("a:\n\t- 1\n".into(), "yaml".into()).is_some());
    }

    #[test]
    fn unknown_lang_is_unchecked() {
        assert!(check_syntax("@@@ not checked".into(), "python".into()).is_none());
    }

    #[test]
    fn unavailable_formatter_is_typed_error() {
        // A language with no installed tool yields the typed sentinel; we can't
        // assume any formatter is installed in CI, so only assert the prefix when
        // it is in fact unavailable.
        if !formatter_available("rust".into(), None) {
            let err = format_source("fn  main(){}".into(), "rust".into(), None).unwrap_err();
            assert!(err.starts_with("formatter-unavailable:"));
        }
    }

    #[test]
    fn only_a_plain_channel_toolchain_file_is_honoured() {
        for plain in [
            "stable\n",
            "1.80.0",
            "[toolchain]\nchannel = \"nightly-2024-01-01\"\n# a comment\n",
            "[toolchain]\nchannel = \"stable\"\ncomponents = [\n  \"rustfmt\",\n  \"clippy\",\n]\nprofile = \"minimal\"\n",
        ] {
            assert!(toolchain_file_is_plain_channel(plain), "{plain}");
        }
        for hostile in [
            "[toolchain]\npath = \"/home/u/proj/tc\"\n",
            "/home/u/proj/tc\n",
            "C:\\proj\\tc",
            "[toolchain]\n\"p\\u0061th\" = \"tc\"\n",
            "toolchain.path = \"tc\"\n",
            "toolchain = { path = \"tc\" }\n",
            "[toolchain]\nchannel = \"stable\"\npath = \"tc\"\n",
        ] {
            assert!(!toolchain_file_is_plain_channel(hostile), "{hostile}");
        }
    }

    #[test]
    fn the_nearest_toolchain_file_wins() {
        let tmp = tempfile::tempdir().unwrap();
        let sub = tmp.path().join("a").join("b");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(tmp.path().join("rust-toolchain.toml"), "path = \"/x\"").unwrap();
        std::fs::write(tmp.path().join("a").join("rust-toolchain"), "stable").unwrap();
        assert_eq!(nearest_toolchain_file(&sub).as_deref(), Some("stable"));
        assert!(nearest_toolchain_file(tmp.path()).unwrap().contains("path"));
    }

    /// #866 end to end: a `rust-toolchain.toml` naming a toolchain path in the
    /// project must not get Format to exec that path's `bin/rustfmt`. Needs
    /// rustup's proxy on PATH; skipped (not failed) where rustup no longer
    /// honours the plant, since then there is nothing to guard.
    #[cfg(unix)]
    #[test]
    fn a_toolchain_path_in_the_project_never_runs_on_format() {
        use std::os::unix::fs::PermissionsExt;
        let Some(tool) = resolve_tool("rust", None) else {
            eprintln!("rustfmt not on PATH — skipping");
            return;
        };
        if !tool.program.with_file_name("rustup").is_file() {
            eprintln!("rustfmt is not rustup's proxy — skipping");
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let proj = tmp.path().canonicalize().unwrap().join("proj");
        let bin = proj.join("tc").join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let marker = tmp.path().join("ran");
        let fake = bin.join("rustfmt");
        std::fs::write(&fake, format!("#!/bin/sh\ntouch '{}'\ncat\n", marker.display())).unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(
            proj.join("rust-toolchain.toml"),
            format!("[toolchain]\npath = \"{}\"\n", proj.join("tc").display()),
        )
        .unwrap();
        // `cargo test` under rustup exports `RUSTUP_TOOLCHAIN` itself, which would
        // mask the plant — so both runs clear it, and the second sets only what
        // `format_source` sets.
        let rustfmt = |pin: Option<&str>| {
            let mut cmd = crate::paths::command_for_program(&tool.program);
            cmd.current_dir(&proj).stdin(Stdio::null()).env_remove("RUSTUP_TOOLCHAIN");
            if let Some(t) = pin {
                cmd.env("RUSTUP_TOOLCHAIN", t);
            }
            let _ = cmd.output();
        };
        rustfmt(None);
        if !marker.exists() {
            eprintln!("this rustup does not run a toolchain path — skipping");
            return;
        }
        std::fs::remove_file(&marker).unwrap();

        let pin = rustup_toolchain_pin(&tool.program, &proj).expect("a default toolchain");
        let pin = pin.expect("a toolchain path must be pinned over");
        rustfmt(Some(&pin));
        assert!(!marker.exists(), "the project's own rustfmt ran despite the pin");
    }
}
