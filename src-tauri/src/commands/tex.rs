//! LaTeX viewing / compilation support.
//!
//! The compile affordance is surfaced in the file tree only when a TeX engine
//! is found on `PATH` — the frontend gates its menu items on `tex_capability`.
//! `compile_tex` runs the chosen engine in the source file's own directory so
//! the `.aux`/`.pdf`/log artefacts land beside the source, and prefers
//! `latexmk` (which drives bibtex + the needed reruns itself) when present.
//! Without `latexmk` it falls back to running the engine directly, slotting a
//! `bibtex` pass in between runs when the generated `.aux` shows citations.
//!
//! On pdflatex, both paths ride the cached-preamble fast path: the document's
//! preamble is dumped once into a `.fmt` (`mylatexformat`, the same trick the
//! hover preview uses) and every later compile loads the dump instead of
//! re-reading fifty packages — which is most of a large document's recompile
//! time. See the "Precompiled document preambles" section; any format failure
//! falls back to the plain compile, so the fast path can only be faster.

use std::fs;
use std::path::Path;
use std::process::Stdio;

use base64::Engine as _;
use serde::Serialize;

/// Engines we know how to drive, in preference order. Each is a `pdf`-producing
/// LaTeX engine invoked the same way (`<engine> -interaction=nonstopmode …`).
const ENGINES: &[&str] = &["pdflatex", "lualatex", "xelatex"];

/// Which TeX tools are available locally. When `available` is false the
/// frontend hides the compile affordance entirely.
#[derive(Debug, Clone, Serialize, Default)]
pub struct TexCapability {
    /// True when at least one engine (or `latexmk`) is on `PATH`.
    pub available: bool,
    /// The subset of `ENGINES` found on `PATH`.
    pub engines: Vec<String>,
    /// Whether `bibtex` is on `PATH` (used for bibliography passes).
    pub bibtex: bool,
    /// Whether `latexmk` is on `PATH` (preferred build driver).
    pub latexmk: bool,
}

/// Outcome of a `compile_tex` run.
#[derive(Debug, Clone, Serialize)]
pub struct TexCompileResult {
    /// True when the build finished and a PDF exists on disk.
    pub success: bool,
    /// Absolute path to the produced PDF, when one was written.
    pub pdf_path: Option<String>,
    /// Human-readable description of the engine/driver used.
    pub engine: String,
    /// Tail of the combined stdout/stderr, for surfacing errors in the UI.
    pub log: String,
    /// True when the build log shows shell-escape (`\write18`) ran unrestricted
    /// or actually executed an external command. We never pass `-shell-escape`
    /// and always pass [`NO_SHELL_ESCAPE`], which outranks a system `texmf.cnf`;
    /// so this only trips when a (trust-gated) `latexmkrc` rewrote the engine
    /// command behind our back — surfaced as a warning in the UI.
    pub shell_escape: bool,
    /// `latexmk`'s own account of why it exited non-zero, when it did: the
    /// `Collected error summary` block and its `Latexmk: …` cause lines, with
    /// the boilerplate advisory dropped. Present whether or not the build is
    /// reported a success — a driver that failed while still producing a PDF
    /// (see `success`) is exactly the case this exists to explain.
    pub driver_note: Option<String>,
}

/// A source location returned by SyncTeX reverse search (`synctex edit`): the
/// input `.tex` file plus 1-based line/column that produced a clicked PDF point.
#[derive(Debug, Clone, Serialize)]
pub struct SyncSource {
    /// Absolute path to the source file.
    pub input: String,
    /// 1-based source line.
    pub line: u32,
    /// 1-based source column (0 when SyncTeX did not report one).
    pub column: u32,
}

/// A PDF rectangle returned by SyncTeX forward search (`synctex view`): the page
/// and a box (big points, 72 dpi, origin at the page's top-left) the viewer can
/// scroll to and highlight.
#[derive(Debug, Clone, Serialize)]
pub struct SyncRect {
    /// 1-based PDF page.
    pub page: u32,
    /// Left edge in big points from the page's top-left.
    pub x: f64,
    /// Top edge in big points from the page's top-left.
    pub y: f64,
    /// Box width in big points.
    pub w: f64,
    /// Box height in big points.
    pub h: f64,
}

/// True if `bin` resolves on `PATH`. Uses the shared cross-platform probe so the
/// TeX toolchain is detected on Windows too (where `which` does not exist).
fn on_path(bin: &str) -> bool {
    crate::paths::binary_on_path(bin)
}

/// Probe `PATH` for the TeX toolchain. Cheap enough to call on demand.
pub fn detect_capability() -> TexCapability {
    let engines: Vec<String> = ENGINES
        .iter()
        .filter(|e| on_path(e))
        .map(|e| e.to_string())
        .collect();
    let latexmk = on_path("latexmk");
    TexCapability {
        available: latexmk || !engines.is_empty(),
        bibtex: on_path("bibtex"),
        latexmk,
        engines,
    }
}

#[tauri::command]
pub fn tex_capability() -> TexCapability {
    detect_capability()
}

// ---------------------------------------------------------------------------
// Engine auto-detection
// ---------------------------------------------------------------------------
//
// With no engine chosen, a build used to run pdflatex — and a document written
// for fontspec, luacode or xeCJK then failed on its first package ("fontspec
// requires either XeTeX or LuaTeX") until the reader found the engine menu. The
// document usually says what it needs: a magic comment names the engine
// outright, and a handful of packages and primitives exist under one engine
// only. Read those, and build under what they ask for.

/// What a document's source says about the engine it needs, strongest first.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EngineHint {
    /// Named outright: `% !TEX program = …` / `% !TeX TS-program = …` /
    /// `% arara: …` in the file's head.
    Named(&'static str),
    /// Runs under LuaTeX only (luacode, luatexja, `\directlua`, …).
    Lua,
    /// Runs under XeTeX only (xeCJK, xltxtra, bidi, mathspec, `\XeTeX…`).
    Xe,
    /// Needs a Unicode engine, either one (fontspec, unicode-math, polyglossia).
    Unicode,
}

/// Packages that load under XeTeX only. Compared case-insensitively.
const XE_ONLY_PACKAGES: &[&str] = &[
    "xecjk", "xltxtra", "xunicode", "xepersian", "xgreek", "xecyr", "xetexko",
    "xesearch", "xespotcolor", "xecolor", "xeindex", "bidi", "mathspec",
];
/// Packages that need a Unicode engine but run under either.
const UNICODE_PACKAGES: &[&str] = &[
    "fontspec", "unicode-math", "polyglossia", "realscripts", "fontsetup",
    "newcomputermodern",
];
/// Packages that load under LuaTeX only, besides every `lua…`/`ltj…` one.
const LUA_ONLY_PACKAGES: &[&str] = &["piton", "emoji", "pyluatex", "chickenize"];
/// Font commands only fontspec defines — a preamble that calls them got
/// fontspec from somewhere (a class, a package outside the document's folder).
const UNICODE_COMMANDS: &[&str] = &[
    "setmainfont", "setsansfont", "setmonofont", "newfontfamily", "setmathfont",
    "defaultfontfeatures", "setdefaultlanguage", "setmainlanguage",
];
/// Primitives and environments that exist under LuaTeX only.
const LUA_COMMANDS: &[&str] = &["directlua", "luaexec", "luadirect", "luaescapestring", "latelua"];

/// The engine a `% !TEX program = …`-style value names, if one we drive.
fn engine_named(value: &str) -> Option<&'static str> {
    let v = value.trim().to_ascii_lowercase();
    let v = v.split(|c: char| c.is_whitespace() || c == ':' || c == '{').next().unwrap_or("");
    match v {
        "lualatex" | "luatex" | "lualatexmk" | "lualatex-dev" => Some("lualatex"),
        "xelatex" | "xetex" | "xelatexmk" | "xelatex-dev" => Some("xelatex"),
        "pdflatex" | "pdftex" | "pdflatexmk" | "pdflatex-dev" | "latex" => Some("pdflatex"),
        _ => None,
    }
}

/// An engine named in the file's leading comments: `% !TEX program = X`,
/// `% !TeX TS-program = X` (TeXShop / TeXstudio / VS Code LaTeX Workshop) or an
/// `% arara: X` directive. Read from the same 20 head lines {@link magic_root}
/// reads, which is where every editor that writes these puts them.
fn magic_engine(source: &str) -> Option<&'static str> {
    for raw in source.lines().take(20) {
        let l = raw.trim_start();
        if !l.starts_with('%') {
            continue;
        }
        let body = l.trim_start_matches('%').trim();
        let lower = body.to_ascii_lowercase();
        let rest = lower
            .strip_prefix("!tex ts-program")
            .or_else(|| lower.strip_prefix("!tex program"));
        if let Some(rest) = rest {
            let rest = rest.trim_start();
            if let Some(v) = rest.strip_prefix('=').or_else(|| rest.strip_prefix(':')) {
                if let Some(e) = engine_named(v) {
                    return Some(e);
                }
            }
            continue;
        }
        if let Some(v) = lower.strip_prefix("arara:") {
            if let Some(e) = engine_named(v) {
                return Some(e);
            }
        }
    }
    None
}

/// `text` with every comment cut: from an unescaped `%` to the end of its line.
/// A commented-out `%\usepackage{fontspec}` asks for nothing.
fn strip_tex_comments(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for line in text.lines() {
        let bytes = line.as_bytes();
        let mut cut = bytes.len();
        let mut i = 0;
        while i < bytes.len() {
            match bytes[i] {
                b'\\' => i += 2, // `\%` is a literal percent, `\\` a line break
                b'%' => {
                    cut = i;
                    break;
                }
                _ => i += 1,
            }
        }
        out.push_str(&line[..cut.min(line.len())]);
        out.push('\n');
    }
    out
}

/// The hint carried by one file's (comment-stripped) text: the packages it
/// loads, the class it is, and the engine-only commands it calls. The strongest
/// one found wins (Lua/Xe over Unicode); `None` for a document any engine runs.
fn engine_hint_in(text: &str) -> Option<EngineHint> {
    let mut lua = false;
    let mut xe = false;
    let mut unicode = false;
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'\\' {
            i += 1;
            continue;
        }
        let mut j = i + 1;
        while j < bytes.len() && (bytes[j] as char).is_ascii_alphabetic() {
            j += 1;
        }
        let cmd = &text[i + 1..j];
        match cmd {
            "usepackage" | "RequirePackage" | "documentclass" | "LoadClass" => {
                // The brace list, past an optional `[...]`.
                let mut k = j;
                while k < bytes.len() && (bytes[k] as char).is_ascii_whitespace() {
                    k += 1;
                }
                if k < bytes.len() && bytes[k] == b'[' {
                    k = text[k..].find(']').map_or(bytes.len(), |c| k + c + 1);
                    while k < bytes.len() && (bytes[k] as char).is_ascii_whitespace() {
                        k += 1;
                    }
                }
                if k < bytes.len() && bytes[k] == b'{' {
                    if let Some(close) = text[k + 1..].find('}') {
                        for name in text[k + 1..k + 1 + close].split(',') {
                            let name = name.trim().to_ascii_lowercase();
                            // `luatex85` is the exception: a shim classes load
                            // under every engine, a no-op off LuaTeX.
                            if (name.starts_with("lua") && name != "luatex85")
                                || name.starts_with("ltj")
                                || LUA_ONLY_PACKAGES.contains(&name.as_str())
                            {
                                lua = true;
                            } else if XE_ONLY_PACKAGES.contains(&name.as_str()) {
                                xe = true;
                            } else if UNICODE_PACKAGES.contains(&name.as_str()) {
                                unicode = true;
                            }
                        }
                        i = k + 1 + close + 1;
                        continue;
                    }
                }
            }
            "begin" if text[j..].starts_with("{luacode") => lua = true,
            // `\XeTeX` alone is metalogo's logo, harmless anywhere; a primitive
            // carries a suffix (`\XeTeXinputencoding`, `\XeTeXlinebreaklocale`).
            _ if cmd.len() > 5 && cmd.starts_with("XeTeX") => xe = true,
            _ if LUA_COMMANDS.contains(&cmd) => lua = true,
            _ if UNICODE_COMMANDS.contains(&cmd) => unicode = true,
            _ => {}
        }
        i = j.max(i + 1);
    }
    if lua {
        Some(EngineHint::Lua)
    } else if xe {
        Some(EngineHint::Xe)
    } else if unicode {
        Some(EngineHint::Unicode)
    } else {
        None
    }
}

/// What `source` (a document, or a hover preview's preamble) asks for, reading
/// the local files its preamble pulls in from `dir` too — a `\input{preamble}`
/// or a project `.sty` is where `fontspec` usually lives. Bounded: at most
/// {@link ENGINE_SCAN_MAX_FILES} files, each read up to its first MiB, so a
/// pathological project cannot turn a compile into a filesystem walk.
fn detect_engine_hint(source: &str, dir: &Path) -> Option<EngineHint> {
    const ENGINE_SCAN_MAX_FILES: usize = 32;
    const MAX_READ: usize = 1024 * 1024;
    if let Some(e) = magic_engine(source) {
        return Some(EngineHint::Named(e));
    }
    let mut best: Option<EngineHint> = None;
    let rank = |h: Option<EngineHint>| match h {
        Some(EngineHint::Lua) => 3,
        Some(EngineHint::Xe) => 2,
        Some(EngineHint::Unicode) => 1,
        _ => 0,
    };
    let mut seen = std::collections::HashSet::new();
    let mut queue: Vec<String> = vec![strip_tex_comments(source)];
    let mut read = 0;
    while let Some(text) = queue.pop() {
        let hint = engine_hint_in(&text);
        if rank(hint) > rank(best) {
            best = hint;
        }
        if rank(best) == 3 || read >= ENGINE_SCAN_MAX_FILES {
            break;
        }
        for name in preamble_local_dep_names(&text) {
            let p = dir.join(&name);
            if read >= ENGINE_SCAN_MAX_FILES || !seen.insert(p.clone()) || !p.is_file() {
                continue;
            }
            read += 1;
            let Ok(bytes) = fs::read(&p) else { continue };
            let bytes = &bytes[..bytes.len().min(MAX_READ)];
            queue.push(strip_tex_comments(&String::from_utf8_lossy(bytes)));
        }
    }
    best
}

/// The installed engine `hint` resolves to, or `None` to keep the default (no
/// hint, or the engine it asks for is not installed — a build under the wrong
/// one fails just as it would have, and says why in its log).
fn engine_for_hint(hint: Option<EngineHint>, installed: &[String]) -> Option<String> {
    let has = |e: &str| installed.iter().any(|g| g == e);
    let pick = |order: &[&str]| order.iter().find(|e| has(e)).map(|e| e.to_string());
    match hint? {
        EngineHint::Named(e) => pick(&[e]),
        EngineHint::Lua => pick(&["lualatex"]),
        EngineHint::Xe => pick(&["xelatex"]),
        // LuaLaTeX first: the LaTeX team's recommended Unicode engine, and the
        // one fontspec's own manual leads with.
        EngineHint::Unicode => pick(&["lualatex", "xelatex"]),
    }
}

/// The engine a build of `src` with no engine chosen runs: what the document
/// asks for when an installed engine serves it, else the first installed one
/// (the {@link ENGINES} order). `None` only with no engine on `PATH` at all.
fn auto_engine(src: &Path, installed: &[String]) -> Option<String> {
    let dir = src.parent().unwrap_or_else(|| Path::new("."));
    fs::read_to_string(src)
        .ok()
        .and_then(|text| engine_for_hint(detect_engine_hint(&text, dir), installed))
        .or_else(|| installed.first().cloned())
}

/// The engine "Auto" builds `path` with — the label on the viewer's engine menu.
/// `path` is the file Compile builds (the resolved root). `None` with no engine
/// installed. Reads only; never runs anything.
#[tauri::command]
pub async fn tex_auto_engine(path: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cap = detect_capability();
        auto_engine(Path::new(&path), &cap.engines)
    })
    .await
    .ok()
    .flatten()
}

struct RunOut {
    ok: bool,
    text: String,
}

/// How long a single TeX/bibtex invocation may run before it is killed.
///
/// `compile_tex` is a **synchronous** command, so a run that never returns holds
/// a Tauri worker thread for the rest of the session and the frontend has no way
/// to abort it — the deck editor and the TeX viewer both just sit on a spinner.
/// `-interaction=nonstopmode` already rules out the classic prompt-for-input
/// hang; what is left is a genuinely pathological document (a runaway macro, a
/// `\loop` with no exit), and for that a ceiling is the only defence. Ten minutes
/// is far beyond any healthy build, including a first run that is downloading
/// packages on MiKTeX.
const RUN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(600);

/// Run `bin args…` with `dir` as the working directory, capturing stdout+stderr.
/// Spawned via `command_no_window` so MiKTeX's console tools (engine, `bibtex`,
/// `synctex`) don't flash a console window per invocation on Windows.
///
/// Killed after {@link RUN_TIMEOUT}. The output is read on a worker thread rather
/// than with `output()` so the wait can time out at all: `output()` blocks until
/// the pipes close, which a wedged child never does.
fn run_in<S: AsRef<std::ffi::OsStr>>(dir: &Path, bin: &str, args: &[S]) -> Result<RunOut, String> {
    run_in_within(dir, bin, args, RUN_TIMEOUT)
}

/// {@link run_in} with an explicit ceiling. Split out for the hover preview
/// (`tex_preview_snippet`), whose whole point is an answer while the pointer is
/// still resting on the snippet: a preview that takes ten minutes is not a
/// preview, and one wedged snippet must not tie up a worker thread for the rest
/// of the session while the reader has long since moved on.
fn run_in_within<S: AsRef<std::ffi::OsStr>>(
    dir: &Path,
    bin: &str,
    args: &[S],
    timeout: std::time::Duration,
) -> Result<RunOut, String> {
    run_in_within_env(dir, bin, args, timeout, &[])
}

/// {@link run_in_within} with extra environment variables. Exists for the
/// cached-preamble compile path, which points the engine's format search at the
/// document-format cache via `TEXFORMATS` rather than embedding an absolute
/// path in a command string latexmk would re-split on whitespace.
fn run_in_within_env<S: AsRef<std::ffi::OsStr>>(
    dir: &Path,
    bin: &str,
    args: &[S],
    timeout: std::time::Duration,
    envs: &[(String, String)],
) -> Result<RunOut, String> {
    let mut cmd = crate::paths::command_no_window(bin);
    cmd.args(args)
        .current_dir(dir)
        // TeX hard-wraps its log at 79 columns, which breaks a path across two
        // lines and makes the `(file … )` nesting unreadable — and that nesting is
        // the ONLY thing that says which source a *warning* came from
        // (`-file-line-error` covers errors and nothing else). These three are the
        // engine's own knobs for that wrapping, and raising them is what lets
        // `parseTexWarnings` (#245) name a file at all in a multi-file document.
        // Harmless where they are not understood: an unknown TeX environment
        // variable is ignored.
        .env("max_print_line", "1000")
        .env("error_line", "254")
        .env("half_error_line", "238");
    for (k, v) in envs {
        cmd.env(k, v);
    }
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("run {bin}: {e}"))?;

    // Drain both pipes on their own threads. A child that fills a pipe buffer
    // deadlocks if nobody is reading, which would make the timeout fire on
    // perfectly healthy builds with a lot of log output.
    let mut out_pipe = child.stdout.take();
    let mut err_pipe = child.stderr.take();
    let out_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(p) = out_pipe.as_mut() {
            let _ = std::io::Read::read_to_end(p, &mut buf);
        }
        buf
    });
    let err_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(p) = err_pipe.as_mut() {
            let _ = std::io::Read::read_to_end(p, &mut buf);
        }
        buf
    });

    let deadline = std::time::Instant::now() + timeout;
    // Poll fast at first and back off: a fixed 50ms tick added up to 50ms of
    // pure waiting to every short run, which the hover preview pays per hover —
    // twice when it also rebuilds a preamble format. A run that is going to take
    // seconds anyway ends up on the 50ms tick after the first few polls.
    let mut poll = std::time::Duration::from_millis(2);
    let status = loop {
        match child.try_wait().map_err(|e| format!("wait {bin}: {e}"))? {
            Some(s) => break Some(s),
            None if std::time::Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            None => {
                std::thread::sleep(poll);
                poll = (poll * 2).min(std::time::Duration::from_millis(50));
            }
        }
    };

    let mut text = String::from_utf8_lossy(&out_reader.join().unwrap_or_default()).into_owned();
    text.push_str(&String::from_utf8_lossy(
        &err_reader.join().unwrap_or_default(),
    ));

    match status {
        Some(s) => Ok(RunOut {
            ok: s.success(),
            text,
        }),
        None => {
            text.push_str(&format!(
                "\n! {app} stopped {bin} after {} seconds — the build appears to be stuck.\n",
                timeout.as_secs(), app = crate::brand::DISPLAY
            ));
            Ok(RunOut { ok: false, text })
        }
    }
}

/// True when the `.aux` references a bibliography (so a `bibtex` pass is wanted).
fn aux_needs_bibtex(aux: &Path) -> bool {
    fs::read_to_string(aux)
        .map(|s| s.contains("\\citation") || s.contains("\\bibdata"))
        .unwrap_or(false)
}

/// Keep only the last `MAX` bytes of the build log (on a char boundary), so the
/// UI gets the tail where TeX errors actually appear without shipping megabytes.
fn tail(log: &str) -> String {
    const MAX: usize = 8000;
    if log.len() <= MAX {
        return log.to_string();
    }
    let mut start = log.len() - MAX;
    while start < log.len() && !log.is_char_boundary(start) {
        start += 1;
    }
    format!("…\n{}", &log[start..])
}

/// The latexmk flag that selects `engine`'s pdf mode.
fn latexmk_flag(engine: Option<&str>) -> &'static str {
    match engine {
        Some("lualatex") => "-pdflua",
        Some("xelatex") => "-pdfxe",
        _ => "-pdf", // pdflatex (latexmk default)
    }
}

/// SECURITY: reject any user-supplied extra flag that could turn on shell-escape
/// (`\write18`) — compiling untrusted `.tex` must never let document macros run
/// shell commands. We strip not just `-shell-escape`/`-enable-write18` but any
/// flag whose text mentions shell-escape / write18 (covers `-shell-escape`,
/// `--shell-escape`, `-enable-write18`, `-shell-restricted` toggles writing,
/// engine `-output-directory` variants are allowed separately). Guarded by
/// `compile_args_never_enable_shell_escape` / `filter_extra_flags_strips_shell_escape`.
fn flag_enables_shell_escape(arg: &str) -> bool {
    let a = arg.to_ascii_lowercase();
    // The two spellings that turn it *off* are the one exception.
    if matches!(a.trim_start_matches('-'), "no-shell-escape" | "disable-write18") {
        return false;
    }
    a.contains("shell-escape") || a.contains("shellescape") || a.contains("write18")
}

/// Passed on every engine run Tabtivity makes — builds (through latexmk, which
/// forwards it to the engine in `%O`, the cached-preamble override included),
/// format dumps and hover previews (#867). Without it the distribution's
/// `shell_escape` setting decides, and a `texmf.cnf` (or a `shell_escape=t`
/// in the environment) with it on would let a document's `\write18` run on
/// Build, or on merely hovering a formula. Nothing in Tabtivity turns shell-escape
/// on — [`filter_extra_flags`] drops every enabling flag — so there is no
/// trusted opt-in for this to yield to. Last before the file name, so it is the
/// engine's final word even after the user's extra flags.
const NO_SHELL_ESCAPE: &str = "-no-shell-escape";

/// Environment for a hover preview's engine runs (#867): kpathsea's paranoid
/// output mode — no `\openout` to an absolute path, a parent directory or a dot
/// file. A preview runs the document's preamble on hover, with the document's
/// folder as its working directory; it has no business writing anywhere but its
/// scratch output directory, which `-output-directory` still reaches.
fn preview_env() -> Vec<(String, String)> {
    vec![("openout_any".to_string(), "p".to_string())]
}

/// Filter user-supplied extra flags down to ones that can NEVER enable
/// shell-escape. Anything mentioning shell-escape / write18 is dropped silently.
fn filter_extra_flags(extra: &[String]) -> Vec<String> {
    extra
        .iter()
        .filter(|f| !flag_enables_shell_escape(f))
        .cloned()
        .collect()
}

/// Arguments for a `latexmk` build of `file_name` with `engine`. This is the
/// single source of truth for the latexmk invocation, and it deliberately omits
/// any shell-escape flag — compiling untrusted `.tex` must never let document
/// macros run shell commands (guarded by `compile_args_never_enable_shell_escape`).
///
/// `out_dir`, when set, becomes latexmk's `-outdir=<dir>` so artefacts (incl. the
/// PDF) land there. `extra` carries already-filtered user flags (#54).
///
/// `fmt_key`, when set, is a cached-preamble format name from
/// {@link ensure_doc_fmt}: the engine command is overridden to load that dump
/// (`-pdflatex=pdflatex -fmt=<key> %O %S`), which is what skips re-reading the
/// whole preamble on every recompile. The key is a fixed `doc-…` charset — never
/// a path — because latexmk re-splits this string on whitespace before running
/// it; the *directory* the key resolves in travels separately, via `TEXFORMATS`
/// ({@link texformats_search_path}). Placed before `extra`, so a user-supplied
/// `-pdflatex=` still wins (latexmk: last one counts).
fn latexmk_args(
    engine: Option<&str>,
    file_name: &str,
    out_dir: Option<&str>,
    extra: &[String],
    fmt_key: Option<&str>,
) -> Vec<String> {
    let mut args: Vec<String> = vec![
        latexmk_flag(engine).to_string(),
        "-interaction=nonstopmode".to_string(),
        // Always emit SyncTeX data so the viewer can map between PDF positions
        // and source lines (forward/reverse search). Harmless when unused.
        "-synctex=1".to_string(),
        // Print errors as `file:line: message` so the viewer can parse error
        // locations and offer jump-to-error (vs. the default `l.NNN` form whose
        // file has to be inferred from log parenthesis nesting). latexmk passes
        // this through to the engine.
        "-file-line-error".to_string(),
    ];
    if let Some(key) = fmt_key {
        args.push(format!("-pdflatex=pdflatex -fmt={key} %O %S"));
    }
    if let Some(dir) = out_dir {
        args.push(format!("-outdir={dir}"));
    }
    for f in extra {
        args.push(f.clone());
    }
    args.push(NO_SHELL_ESCAPE.to_string());
    args.push(file_name.to_string());
    args
}

/// Arguments for driving a TeX engine directly on `file_name` (the no-latexmk
/// path). Same shell-escape invariant as `latexmk_args`. `out_dir` maps to the
/// engine's `-output-directory=<dir>`; `extra` carries filtered user flags.
fn engine_args(file_name: &str, out_dir: Option<&str>, extra: &[String]) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-interaction=nonstopmode".to_string(),
        "-halt-on-error".to_string(),
        // Emit SyncTeX data for forward/reverse search (see latexmk_args).
        "-synctex=1".to_string(),
        // `file:line: message` error format for jump-to-error (see latexmk_args).
        "-file-line-error".to_string(),
    ];
    if let Some(dir) = out_dir {
        args.push(format!("-output-directory={dir}"));
    }
    for f in extra {
        args.push(f.clone());
    }
    args.push(NO_SHELL_ESCAPE.to_string());
    args.push(file_name.to_string());
    args
}

/// Scan a build log for evidence that shell-escape (`\write18`) was active in an
/// *unrestricted* way: either explicitly enabled (not the safe "restricted"
/// default that only allows a fixed whitelist) or an external command actually
/// executed. Used to warn when a system config enabled it despite our args.
fn log_shows_shell_escape(log: &str) -> bool {
    log.lines().any(|line| {
        let l = line.to_ascii_lowercase();
        (l.contains("write18 enabled") && !l.contains("restricted"))
            || (l.contains("runsystem(") && l.contains("executed"))
    })
}

// ── latexmk exited non-zero: the document's fault, or the driver's? ──────────
//
// `latexmk` returns a non-zero status for a whole class of things that are not
// errors *in the document*: an unresolved reference with `$warnings_as_errors`
// set in a `latexmkrc`, `$max_repeat` reached, a `bibtex`/`biber` rule that
// failed, a missing `.bib`. In every one of those the engine still typeset the
// document and wrote a PDF — but Tabtivity used to report the build as failed,
// withhold the fresh PDF, and (with no `file:line:` error to quote) title the
// card with latexmk's trailing advisory, "Use the -f option to force complete
// processing…". A configuration complaint shown as a compilation error.
//
// The discriminator is the log, not the exit code: TeX announces its own errors
// as `!` lines and — under the `-file-line-error` Tabtivity always passes — as
// `file:line: message`. Neither appears when only the driver is unhappy.

/// True when the log carries an error the *engine* raised: a `-file-line-error`
/// location line, or TeX's own `!` marker (`! Undefined control sequence`,
/// `! LaTeX Error: …`, `! Emergency stop`). Driver-level latexmk complaints have
/// neither, which is what lets a build be forgiven its exit status.
fn log_has_tex_error(log: &str) -> bool {
    log.lines().any(|raw| {
        let line = raw.trim_end();
        if line.starts_with("! ") || line == "!" {
            return true;
        }
        // `file:line: message` — the file part is non-greedy so the first
        // `:<digits>: ` wins, mirroring the frontend's `FILE_LINE_ERROR`.
        let mut rest = line;
        while let Some(colon) = rest.find(':') {
            let after = &rest[colon + 1..];
            let digits: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
            if !digits.is_empty() && after[digits.len()..].starts_with(": ") && colon > 0 {
                return true;
            }
            rest = after;
        }
        false
    })
}

/// latexmk lines that say what it is *doing*, not what went wrong. Quoting one
/// of these as the reason a build failed is the bug this list exists to avoid.
const LATEXMK_NOISE: &[&str] = &[
    "This is Latexmk",
    "Use the -f option",
    "Nothing to do",
    "All targets",
    "Examining",
    "Run number",
    "applying rule",
    "Changing directory",
    "Undoing directory change",
    "Log file says",
    "Found input file",
    "Found bibliography file",
    "Calling",
    "Getting log file",
    "Rules after",
    "Doing checks",
    "Not bothering",
    "Non-existent destination",
    "Summary of warnings",
];

/// Extract latexmk's own explanation of a non-zero exit: the indented
/// `Collected error summary` block plus any `Latexmk: …` line that names a
/// cause. Returns `None` when latexmk said nothing beyond its progress chatter.
fn latexmk_summary(log: &str) -> Option<String> {
    let mut out: Vec<String> = Vec::new();
    let mut push = |msg: &str| {
        let msg = msg.trim();
        if !msg.is_empty() && !out.iter().any(|s| s == msg) {
            out.push(msg.to_string());
        }
    };
    let mut in_collected = false;
    for raw in log.lines() {
        let line = raw.trim_end();
        let text = line.trim_start();
        if text.starts_with("Collected error summary") {
            in_collected = true;
            continue;
        }
        if in_collected {
            // The block is indented; the first unindented line closes it.
            if line.starts_with(' ') || line.starts_with('\t') {
                // "Refer to 'main.log' for details" points at a file the user
                // already has in the log panel below.
                if !text.starts_with("Refer to ") {
                    push(text);
                }
                continue;
            }
            in_collected = false;
        }
        if let Some(rest) = text.strip_prefix("Latexmk: ") {
            if !LATEXMK_NOISE.iter().any(|n| rest.starts_with(n)) {
                push(rest);
            }
        }
    }
    if out.is_empty() {
        return None;
    }
    // Four lines is the whole of a normal summary; more than that is the log,
    // and the log has its own panel.
    out.truncate(4);
    Some(out.join("; "))
}

/// Modification time of the PDF, or `None` when it does not exist. Compared
/// across a run to tell a PDF this build wrote from one left by an earlier one:
/// forgiving a non-zero exit status is only safe when the output is actually new.
fn pdf_stamp(pdf: &Path) -> Option<std::time::SystemTime> {
    fs::metadata(pdf).ok().and_then(|m| m.modified().ok())
}

/// Whether a build counts as a success, for both the latexmk and the direct
/// path. `run_ok` is the *last* build command's exit status.
///
/// A clean exit is judged by the PDF alone, and deliberately does not ask
/// whether it is new: an up-to-date no-op writes nothing and is still a success
/// (the UI names it separately, `compileWasNoop`).
///
/// A non-zero exit is forgiven only when this run wrote a PDF *and* the engine
/// raised no error of its own — the driver objecting to something around the
/// document (warnings as errors, a bibliography rule, an unresolved reference)
/// rather than the document failing to typeset. Both halves matter: without the
/// freshness check an earlier build's PDF would be passed off as this one's.
fn build_succeeded(run_ok: bool, pdf_exists: bool, pdf_fresh: bool, doc_errors: bool) -> bool {
    if run_ok {
        pdf_exists
    } else {
        pdf_fresh && !doc_errors
    }
}

// ── Precompiled document preambles (full compiles) ───────────────────────────
//
// The hover preview's biggest win — dumping the preamble into a `.fmt` via
// `mylatexformat` and loading the dump instead of re-reading fifty packages —
// applied to the *full* compile. On a large document nearly all of a routine
// recompile's engine time is the preamble: the body's pages typeset in a
// fraction of it, and latexmk's dependency machinery cannot help because the
// engine re-loads every package on every pass regardless. With the dump, a
// body edit costs (roughly) only the body's own typesetting.
//
// Same constraints as the preview cache, for the same measured reasons:
// pdflatex only (`mylatexformat` is documented-unreliable under LuaTeX/XeTeX
// font loading — a cached build with the wrong fonts is worse than a slow
// one), an age bound because the dump freezes whatever the preamble's inputs
// held at build time, and a `.bad` marker so a preamble that *cannot* be
// dumped (packages doing real work at `\begin{document}` exist) costs one
// failed attempt per age window, not one per compile.
//
// What the preview cannot get wrong but a full build can — the preamble's own
// local files changing under the dump — is keyed for: {@link doc_fmt_key}
// content-hashes every `\input`/`\usepackage`/`\documentclass` target that
// resolves to a file in the document's folder, so editing `macros.tex` or a
// local `.sty` mints a new key and rebuilds the dump. (TeX-tree packages are
// not hashed; those change on a distribution upgrade, which the age bound and
// the "made by different version" retry already cover.)
//
// Every failure degrades to today's plain compile: a format that will not
// build is marked `.bad` and skipped, a format that will not *load* is
// discarded and the run repeated without it (see the retry in
// `compile_tex_blocking`), so the fast path can never make a document fail
// that would have built before.

/// Where the full-compile preamble formats live: `<state_dir>/tex-fmt`.
/// Separate from the preview cache — different producers, one sweep rule.
fn doc_fmt_root() -> std::path::PathBuf {
    crate::storage::state_dir().join("tex-fmt")
}

/// How long one preamble dump may take. Longer than the preview's ceiling —
/// nobody is holding a pointer still, and a TikZ-heavy preamble can genuinely
/// take a minute — but far under {@link RUN_TIMEOUT}: a dump slower than this
/// would eat the very time it exists to save.
const DOC_FMT_BUILD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

/// Everything before `\begin{document}`, or `None` for a file that has no body
/// marker at all (a fragment — nothing to split, nothing to dump) or whose
/// preamble is implausibly huge (a generated file; hashing it per compile would
/// cost more than the dump saves).
fn doc_preamble_head(text: &str) -> Option<&str> {
    const MAX_HEAD: usize = 1024 * 1024;
    let i = text.find("\\begin{document}")?;
    if i > MAX_HEAD {
        return None;
    }
    Some(&text[..i])
}

/// Candidate *local* files the preamble reads, as names relative to the
/// document's folder: `\input{macros}` → `macros.tex`, `\usepackage{a,b}` →
/// `a.sty`+`b.sty`, `\documentclass{x}` → `x.cls`. Pure — the caller decides
/// which of them actually exist beside the document; a name that resolves only
/// in the TeX tree simply won't. Bounded, so a pathological preamble cannot
/// turn key derivation into a filesystem scan.
fn preamble_local_dep_names(head: &str) -> Vec<String> {
    const MAX_DEPS: usize = 64;
    let mut out: Vec<String> = Vec::new();
    let bytes = head.as_bytes();
    let mut i = 0;
    while i < bytes.len() && out.len() < MAX_DEPS {
        if bytes[i] != b'\\' {
            i += 1;
            continue;
        }
        let mut j = i + 1;
        while j < bytes.len() && (bytes[j] as char).is_ascii_alphabetic() {
            j += 1;
        }
        let cmd = &head[i + 1..j];
        let ext = match cmd {
            "input" => Some("tex"),
            "usepackage" | "RequirePackage" => Some("sty"),
            "documentclass" | "LoadClass" => Some("cls"),
            _ => None,
        };
        let Some(ext) = ext else {
            i = j.max(i + 1);
            continue;
        };
        // Skip an optional `[...]` argument between the command and its brace.
        let mut k = j;
        while k < bytes.len() && (bytes[k] as char).is_ascii_whitespace() {
            k += 1;
        }
        if k < bytes.len() && bytes[k] == b'[' {
            match head[k..].find(']') {
                Some(close) => k += close + 1,
                None => {
                    i = j.max(i + 1);
                    continue;
                }
            }
        }
        if k < bytes.len() && bytes[k] == b'{' {
            if let Some(close) = head[k + 1..].find('}') {
                for arg in head[k + 1..k + 1 + close].split(',') {
                    let arg = arg.trim();
                    if arg.is_empty() || out.len() >= MAX_DEPS {
                        continue;
                    }
                    if Path::new(arg).extension().is_some() {
                        out.push(arg.to_string());
                    } else {
                        out.push(format!("{arg}.{ext}"));
                    }
                }
                i = k + 1 + close + 1;
                continue;
            }
        }
        i = j.max(i + 1);
    }
    out
}

/// The cache key (and jobname, and file stem) for one document's preamble
/// format: engine + the preamble text + the content of every preamble
/// dependency that resolves to a file in `dir`. The local-dep hashing is what
/// the preview key doesn't need and a full build does: the dump freezes
/// `\input{macros}` / a local `.sty` at build time, and a *build* rendered
/// against stale macros is a wrong PDF, not a wrong hover card.
fn doc_fmt_key(engine: &str, head: &str, dir: &Path) -> String {
    let mut h = fnv64(head);
    for name in preamble_local_dep_names(head) {
        let p = dir.join(&name);
        // `is_file` first: a name like `article.sty` that only resolves in the
        // TeX tree simply isn't here, and that absence must not be an error.
        if p.is_file() {
            if let Ok(bytes) = fs::read(&p) {
                h = h.rotate_left(7) ^ fnv64(&name);
                h = h.rotate_left(7) ^ fnv64_bytes(&bytes);
            }
        }
    }
    format!("doc-{engine}-{h:016x}-{}", head.len())
}

/// The `TEXFORMATS` value pointing the engine's format search at the document
/// cache. The trailing separator is load-bearing: an empty element in a
/// kpathsea path means "insert the compile-time default here", so the engine
/// still finds everything it normally would.
fn texformats_search_path() -> String {
    let sep = if cfg!(windows) { ';' } else { ':' };
    format!("{}{sep}", doc_fmt_root().display())
}

/// The precompiled format for this document's preamble, building it if need be
/// — or `None`, in which case the caller compiles the old way and loses nothing
/// but the speedup. Returns the *key* (resolved via `TEXFORMATS` /
/// {@link doc_fmt_root}), not a path — see {@link latexmk_args} for why.
///
/// The dump is `mylatexformat` driven over the **document itself** (its
/// documented usage: everything up to `\begin{document}` is frozen, and later
/// `-fmt` runs of the same file skip that whole stretch). Run exactly like a
/// compile — the document's dir as cwd so relative `\input`s resolve — with
/// artefacts to a scratch dir and the finished format renamed into the cache,
/// so a compile racing this one never sees a half-written file.
fn ensure_doc_fmt(dir: &Path, src: &Path, head: &str) -> Option<String> {
    if !mylatexformat_available(dir) {
        return None;
    }
    let root = doc_fmt_root();
    let key = doc_fmt_key("pdflatex", head, dir);
    let fmt = root.join(format!("{key}.fmt"));
    // Freshness checked at reuse, not only by the sweep — the sweep runs on
    // cache misses, so a format reused continuously would otherwise never age
    // out ({@link ensure_preview_fmt} has the same rule for the same reason).
    if let Ok(meta) = fmt.metadata() {
        let fresh = meta
            .modified()
            .ok()
            .and_then(|m| std::time::SystemTime::now().duration_since(m).ok())
            .map(|age| age <= PREVIEW_FMT_MAX_AGE)
            .unwrap_or(true);
        if fresh {
            return Some(key);
        }
        let _ = fs::remove_file(&fmt);
    }
    if root.join(format!("{key}.bad")).is_file() {
        return None;
    }
    fs::create_dir_all(&root).ok()?;
    sweep_preview_fmts(&root, std::time::SystemTime::now());

    let scratch = make_preview_scratch().ok()?;
    // SECURITY: a fixed argument list — no user flags reach a format build, so
    // it can no more enable shell-escape than the compile itself can.
    let args = vec![
        "-ini".to_string(),
        "-interaction=nonstopmode".to_string(),
        NO_SHELL_ESCAPE.to_string(),
        format!("-output-directory={}", scratch.display()),
        format!("-jobname={key}"),
        "&pdflatex".to_string(),
        "mylatexformat.ltx".to_string(),
        src.to_string_lossy().into_owned(),
    ];
    // A spawn failure is the machine's problem, not this preamble's: no marker.
    let built = match run_in_within(dir, "pdflatex", &args, DOC_FMT_BUILD_TIMEOUT) {
        Ok(b) => b,
        Err(_) => {
            let _ = fs::remove_dir_all(&scratch);
            return None;
        }
    };
    let out_fmt = scratch.join(format!("{key}.fmt"));
    let ok = built.ok && out_fmt.is_file() && fs::rename(&out_fmt, &fmt).is_ok();
    let _ = fs::remove_dir_all(&scratch);
    if ok {
        Some(key)
    } else {
        let _ = fs::write(root.join(format!("{key}.bad")), b"");
        None
    }
}

/// Did this compile die on the *format* — dead dump, engine upgraded under it,
/// or the format not found at all — rather than on the document? Decides
/// whether a failed fmt run is retried without the format. The not-found shape
/// is the one the preview can never hit (it passes a path; the full compile
/// resolves a key through `TEXFORMATS`, which an engine is free to ignore).
fn compile_log_is_format_error(log: &str) -> bool {
    preview_log_is_format_error(log) || log.contains("find the format file")
}

/// Drop a format the engine rejected. A dump that would not *load* ("made by
/// different version", corruption) is only deleted — a rebuild fixes those. A
/// format the engine could not *find* is a search-path problem a rebuild
/// cannot fix (an engine that ignores `TEXFORMATS`), so it also gets the
/// `.bad` marker: the next compiles inside the age window go straight to the
/// plain path instead of paying a doomed run each.
fn discard_doc_fmt(key: &str, log: &str) {
    let root = doc_fmt_root();
    let _ = fs::remove_file(root.join(format!("{key}.fmt")));
    if log.contains("find the format file") {
        let _ = fs::write(root.join(format!("{key}.bad")), b"");
    }
}

/// Compile a `.tex`.
///
/// **`async` and off the UI thread, deliberately.** A *synchronous* Tauri command
/// runs on the main thread (see the note at `commands/credentials.rs`), so this
/// used to freeze the entire window for the duration of `latexmk` — which the
/// {@link RUN_TIMEOUT} above bounds at ten minutes. Every deck TeX-figure add,
/// every Recompile and every starter-deck generation paid that (TODO V #105).
/// `spawn_blocking` keeps the body's blocking process I/O legal on the async
/// runtime while the webview stays live.
#[tauri::command]
pub async fn compile_tex(
    path: String,
    engine: Option<String>,
    out_dir: Option<String>,
    extra_flags: Option<Vec<String>>,
) -> Result<TexCompileResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        compile_tex_blocking(path, engine, out_dir, extra_flags)
    })
    .await
    .map_err(|e| format!("compile task failed: {e}"))?
}

fn compile_tex_blocking(
    path: String,
    engine: Option<String>,
    out_dir: Option<String>,
    extra_flags: Option<Vec<String>>,
) -> Result<TexCompileResult, String> {
    let src = fs::canonicalize(&path).map_err(|e| format!("canonicalize {path}: {e}"))?;
    let is_tex = src
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("tex"))
        .unwrap_or(false);
    if !is_tex {
        return Err(format!("not a .tex file: {}", src.display()));
    }
    let dir = src
        .parent()
        .ok_or_else(|| "source file has no parent directory".to_string())?;
    let file_name = src
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "invalid file name".to_string())?;
    let stem = src
        .file_stem()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "invalid file name".to_string())?
        .to_string();

    let cap = detect_capability();
    if !cap.available {
        return Err("no TeX engine found on PATH".to_string());
    }

    // Resolve the optional output directory: a relative path is taken against the
    // source's directory, an absolute one is used as-is. Created if missing so the
    // engine can write into it. The PDF then lands there (not beside the source),
    // so `pdf_path` points into it.
    let out_dir = out_dir.and_then(|d| {
        let d = d.trim().to_string();
        if d.is_empty() {
            None
        } else {
            Some(d)
        }
    });
    let out_path = match &out_dir {
        Some(d) => {
            let p = Path::new(d);
            let abs = if p.is_absolute() {
                p.to_path_buf()
            } else {
                dir.join(p)
            };
            fs::create_dir_all(&abs)
                .map_err(|e| format!("create output dir {}: {e}", abs.display()))?;
            Some(abs)
        }
        None => None,
    };
    // The string form passed to the engine/latexmk flags.
    let out_arg = out_path.as_ref().map(|p| p.to_string_lossy().into_owned());

    // SECURITY: filter user-supplied flags so none can enable shell-escape.
    let extra = filter_extra_flags(&extra_flags.unwrap_or_default());

    // Only honour an explicitly requested engine we actually have; otherwise run
    // what the document asks for, else the first installed engine (see
    // {@link auto_engine}). Resolved here rather than left to latexmk, whose
    // default is pdflatex whether or not it is installed.
    let engine = engine
        .filter(|e| cap.engines.iter().any(|g| g == e))
        .or_else(|| auto_engine(&src, &cap.engines));
    // The PDF lands in the output dir if one was given, else beside the source.
    let pdf = match &out_path {
        Some(p) => p.join(format!("{stem}.pdf")),
        None => dir.join(format!("{stem}.pdf")),
    };
    let mut log = String::new();

    // The cached-preamble fast path (see the "Precompiled document preambles"
    // section): pdflatex only — the engine `mylatexformat` is reliable under —
    // and only for a file with a `\begin{document}` to split at. `None` on any
    // other engine, a missing `mylatexformat`, or a preamble that cannot be
    // dumped: the compile then runs exactly as before.
    let wants_pdflatex = matches!(engine.as_deref(), None | Some("pdflatex"))
        && cap.engines.iter().any(|e| e == "pdflatex");
    let mut fmt_key: Option<String> = None;
    if wants_pdflatex {
        if let Ok(text) = fs::read_to_string(&src) {
            if let Some(head) = doc_preamble_head(&text) {
                fmt_key = ensure_doc_fmt(dir, &src, head);
            }
        }
    }

    if cap.latexmk {
        // latexmk executes a `latexmkrc`/`.latexmkrc` in its working directory
        // as Perl — project content, so ask once (`services::exec_trust`).
        crate::services::exec_trust::require(crate::services::exec_trust::TrustKind::Latexmkrc, dir)?;
        let flag = latexmk_flag(engine.as_deref());
        // Taken before the build so a PDF this run wrote can be told from one an
        // earlier run left behind (see {@link pdf_stamp}).
        let pdf_before = pdf_stamp(&pdf);
        let run_latexmk = |fmt: Option<&str>| -> Result<RunOut, String> {
            let args = latexmk_args(engine.as_deref(), file_name, out_arg.as_deref(), &extra, fmt);
            let envs: Vec<(String, String)> = match fmt {
                // The key resolves in the cache dir via TEXFORMATS; latexmk
                // passes its environment through to the engine.
                Some(_) => vec![("TEXFORMATS".to_string(), texformats_search_path())],
                None => Vec::new(),
            };
            run_in_within_env(dir, "latexmk", &args, RUN_TIMEOUT, &envs)
        };
        let mut used_fmt = fmt_key.is_some();
        let mut out = run_latexmk(fmt_key.as_deref())?;
        // A format the engine rejected must cost one retry, not the build: drop
        // it and compile the old way. A document's own error is NOT this case
        // and gets no second run — doubling every typo's feedback loop would
        // cost more than the cache saves ({@link compile_log_is_format_error}).
        if used_fmt && !(out.ok && pdf.exists()) && compile_log_is_format_error(&out.text) {
            if let Some(key) = fmt_key.as_deref() {
                discard_doc_fmt(key, &out.text);
            }
            log.push_str(&out.text);
            out = run_latexmk(None)?;
            used_fmt = false;
        }
        // Read off the FINAL run, not the accumulated log: a format attempt that
        // was discarded and retried above must not lend its errors to the run
        // that replaced it.
        let doc_errors = log_has_tex_error(&out.text);
        let driver_note = if out.ok {
            None
        } else {
            latexmk_summary(&out.text)
        };
        log.push_str(&out.text);
        // `driver_note` carries latexmk's reason whichever way this lands, so a
        // forgiven build still says what latexmk was unhappy about.
        let pdf_fresh = {
            let now = pdf_stamp(&pdf);
            now.is_some() && now != pdf_before
        };
        let success = build_succeeded(out.ok, pdf.exists(), pdf_fresh, doc_errors);
        if success {
            // Record this file as the build root for every .tex it pulls in, so
            // pressing Compile in a child later redirects here (resolve_tex_root).
            record_root_mappings(&src);
        }
        return Ok(TexCompileResult {
            success,
            pdf_path: pdf.exists().then(|| pdf.to_string_lossy().into_owned()),
            engine: if used_fmt {
                format!("latexmk {flag} +preamble-cache")
            } else {
                format!("latexmk {flag}")
            },
            shell_escape: log_shows_shell_escape(&log),
            log: tail(&log),
            driver_note,
        });
    }

    // No latexmk: drive the engine directly. First pass, then a bibtex pass when
    // the aux shows citations, then reruns to settle references / ToC.
    let eng = engine.unwrap_or_else(|| cap.engines[0].clone());
    // The fast path only fires when pdflatex is what actually runs; `fmt_key`
    // was resolved for pdflatex above and is None otherwise.
    let fmt_key = fmt_key.filter(|_| eng == "pdflatex");
    let build_args = |fmt: Option<&str>| -> Vec<String> {
        let mut a = engine_args(file_name, out_arg.as_deref(), &extra);
        if let Some(key) = fmt {
            // The direct spawn takes argv, so the absolute path form is safe
            // here (no latexmk re-splitting the string on whitespace).
            a.insert(
                0,
                format!("-fmt={}", doc_fmt_root().join(format!("{key}.fmt")).display()),
            );
        }
        a
    };
    let mut used_fmt = fmt_key.is_some();
    let mut engine_args = build_args(fmt_key.as_deref());
    // Taken before any pass runs: this path used to answer `pdf.exists()`, which
    // hands back an earlier build's PDF as this build's output whenever the
    // engine bailed out. See {@link build_succeeded}.
    let pdf_before = pdf_stamp(&pdf);

    let mut first = run_in(dir, &eng, &engine_args)?;
    // Same retry rule as the latexmk path: only a *format* failure earns a
    // second run, and the reruns below then stay on the plain arguments too.
    if used_fmt && !first.ok && compile_log_is_format_error(&first.text) {
        if let Some(key) = fmt_key.as_deref() {
            discard_doc_fmt(key, &first.text);
        }
        log.push_str(&first.text);
        engine_args = build_args(None);
        used_fmt = false;
        first = run_in(dir, &eng, &engine_args)?;
    }
    // The verdict is the LAST pass's, not the first's: the reruns below are what
    // finally wrote the PDF, and a first pass that stumbled on a reference the
    // second resolves is not a failed build.
    let mut last_ok = first.ok;
    let mut doc_errors = log_has_tex_error(&first.text);
    log.push_str(&first.text);

    // The aux lands in the output dir too when one is set.
    let aux = match &out_path {
        Some(p) => p.join(format!("{stem}.aux")),
        None => dir.join(format!("{stem}.aux")),
    };
    let mut pass = |log: &mut String| -> Result<(), String> {
        let out = run_in(dir, &eng, &engine_args)?;
        last_ok = out.ok;
        doc_errors = log_has_tex_error(&out.text);
        log.push_str(&out.text);
        Ok(())
    };
    if cap.bibtex && aux_needs_bibtex(&aux) {
        // bibtex resolves its aux relative to its own CWD; run it in the output
        // dir when one is set so it finds the aux written there.
        let bib_dir = out_path.as_deref().unwrap_or(dir);
        let bib = run_in(bib_dir, "bibtex", std::slice::from_ref(&stem))?;
        log.push_str(&bib.text);
        for _ in 0..2 {
            pass(&mut log)?;
        }
    } else {
        // One extra pass resolves cross-references / table of contents.
        pass(&mut log)?;
    }

    let pdf_fresh = {
        let now = pdf_stamp(&pdf);
        now.is_some() && now != pdf_before
    };
    let success = build_succeeded(last_ok, pdf.exists(), pdf_fresh, doc_errors);
    if success {
        record_root_mappings(&src);
    }
    Ok(TexCompileResult {
        success,
        pdf_path: pdf.exists().then(|| pdf.to_string_lossy().into_owned()),
        engine: if used_fmt {
            format!("{eng} +preamble-cache")
        } else {
            eng
        },
        shell_escape: log_shows_shell_escape(&log),
        log: tail(&log),
        // Nothing to explain: there is no driver between Tabtivity and the engine,
        // so a failure here is the engine's own and the log already says it.
        driver_note: None,
    })
}

// ── Snippet hover preview ────────────────────────────────────────────────────
//
// The TeX editor's hover preview (#tex-hover-preview): rest the pointer on a
// `$…$`, a `\[…\]` or an `equation`/`align`/`tikzpicture` body and Tabtivity
// typesets *that fragment alone* and shows the result over the source. It is the
// same question a full Compile answers, asked about two lines instead of forty
// pages — so it is deliberately NOT the same code path:
//
//  - **The engine directly, one pass.** A fragment has no bibliography, no table
//    of contents and no cross-references to settle, so `latexmk`'s dependency
//    machinery (and its reruns) is pure latency here. `compile_tex` keeps it; this
//    does not.
//  - **Bounded by {@link PREVIEW_TIMEOUT}, not `RUN_TIMEOUT`.** A preview that
//    arrives ten minutes later is not a preview.
//  - **Nothing is written where the document lives.** The wrapper `.tex` and every
//    artefact go to a scratch dir under the state dir, which is removed before the
//    call returns; the compile's *working directory* is the document's own folder
//    so a preamble's `\usepackage{mystyle}` / `\input{macros}` still resolve.
//    That split is what makes a preview of a real paper's macros work at all
//    without leaving a single `.aux` beside the paper.
//  - **The PDF comes back as bytes, not as a path.** The frontend rasterizes it
//    with pdf.js, and the confined file commands (`commands/fs.rs`) do not — and
//    must not — reach into the state dir to read one.
//  - **The preamble is precompiled into a format file and reused.** Almost all
//    of an uncached hover's engine time goes to re-loading the same preamble —
//    the fragment itself typesets in milliseconds — so on pdflatex the preamble
//    is dumped once into a `.fmt` (via `mylatexformat`, the same trick AUCTeX's
//    preview-latex uses) and every later snippet under that preamble loads the
//    dump instead of compiling fifty packages again. See {@link ensure_preview_fmt}.

/// How long one preview pass may run. Short on purpose: the reader is holding a
/// pointer still, waiting. A document whose preamble genuinely takes longer than
/// this to load is one the preview cannot serve, and saying so beats hanging.
const PREVIEW_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(25);

/// Largest snippet body we will typeset. A hover preview is a fragment; anything
/// past this is a document, and the Compile button is the tool for those.
const MAX_PREVIEW_BODY: usize = 32 * 1024;

/// Largest preamble we will copy into the wrapper. Generous — a real paper's
/// preamble with fifty `\newcommand`s is a few KB — and only here so a
/// pathological file cannot turn each hover into a megabyte of IPC and I/O.
const MAX_PREVIEW_PREAMBLE: usize = 256 * 1024;

/// Scratch dirs older than this are leftovers from a crash (the happy path
/// removes its own before returning) and are swept on the next preview.
const PREVIEW_SCRATCH_MAX_AGE: std::time::Duration = std::time::Duration::from_secs(3600);

/// How many precompiled preamble formats to keep. A format is a few MB and a
/// writing session touches a handful of documents; the count is a cap on disk,
/// not a working-set tuning knob.
const PREVIEW_FMT_MAX: usize = 16;

/// How old a format may get before it is rebuilt. The bound is *correctness*,
/// not disk: the dump froze whatever a preamble's relative `\input{macros}`
/// contained at build time, and the key only hashes the preamble text — the same
/// blind spot the frontend's render cache has. An hour keeps that staleness in
/// the same league as a session's, at the cost of one preamble compile per hour
/// per document.
const PREVIEW_FMT_MAX_AGE: std::time::Duration = std::time::Duration::from_secs(3600);

/// Outcome of `tex_preview_snippet`.
#[derive(Debug, Clone, Serialize)]
pub struct TexPreviewResult {
    /// True when a PDF was produced.
    pub success: bool,
    /// Tail of the build log — shown in the hover card when the snippet does not
    /// typeset, so a stray `\frac{1}{}` reads as an error and not as a hang.
    pub log: String,
    /// The one-page PDF, base64, when the build produced one. Bytes rather than a
    /// path because the file lives in the state dir, which the confined viewer
    /// file commands cannot read (and must not learn to).
    pub pdf_b64: Option<String>,
    /// True when the document's own preamble could not typeset the snippet and
    /// the minimal standalone fallback did — the preview is then honest about
    /// being rendered without the author's macros.
    pub fallback: bool,
}

/// Is this fragment a **float** — a `figure`/`table` (or its starred form)?
///
/// It decides how the fragment is wrapped, and getting it wrong is a hard error
/// rather than a bad-looking preview: `\begin{figure}` demands outer par mode,
/// and `\begin{preview}` has already put TeX in a box, so a float wrapped like
/// every other snippet fails with `! LaTeX Error: Not in outer par mode.` and
/// produces nothing. Floats are previewed through `preview.sty`'s own `floats`
/// option instead (see {@link preview_document}).
///
/// **Exactly these four names**, measured rather than assumed: the option's body
/// fixes up `\endfigure`, `\endtable` and their starred twins by name and snarfs
/// LaTeX's `@float`/`@dblfloat`. A `wrapfigure` is not a `\@float` at all and
/// yields "No pages of output"; a `float`-package custom float (which is what
/// `algorithm` is) redefines `\end@float` past what the option patches and dies
/// with "Extra }, or forgotten \endgroup". Both were tried; neither is offered.
fn body_is_float(body: &str) -> bool {
    let b = body.trim_start();
    ["\\begin{figure}", "\\begin{figure*}", "\\begin{table}", "\\begin{table*}"]
        .iter()
        .any(|p| b.starts_with(p))
}

/// Everything before `\begin{document}` — the preamble, whatever the caller sent.
/// Defensive: the frontend already slices this, and a whole document handed in by
/// mistake must not become a wrapper with two `\begin{document}`s.
fn preamble_head(preamble: &str) -> &str {
    match preamble.find("\\begin{document}") {
        Some(i) => &preamble[..i],
        None => preamble,
    }
}

/// The wrapper document for a snippet: the author's own preamble, the `preview`
/// package, and the fragment inside a `preview` environment.
///
/// `preview` with `[active,tightpage]` is what crops the page down to the
/// fragment's own ink — the same mechanism AUCTeX's preview-latex uses — so the
/// hover card gets a formula and not a formula adrift on A4. Wrapping the body in
/// an explicit `\begin{preview}` rather than using the package's `displaymath` /
/// `textmath` options means one wrapper serves every snippet kind: inline math, a
/// display, an `align`, a `tikzpicture`, a `tabular`.
///
/// A preamble that already loads `preview` is left alone — loading it twice with
/// different options is an option clash, i.e. a preview that fails for a document
/// that was *more* prepared for previewing than most. Pure / unit-tested.
fn preview_document(preamble: &str, body: &str) -> String {
    let head = preamble_head(preamble).trim_end();
    let is_float = body_is_float(body);
    let mut out = String::with_capacity(head.len() + body.len() + 256);
    // A child `.tex` has no preamble of its own; give it a plausible one rather
    // than handing the engine a document with no class at all.
    if !head.contains("\\documentclass") {
        out.push_str("\\documentclass[12pt]{article}\n");
    }
    out.push_str(head);
    out.push('\n');
    if !head.contains("{preview}") {
        out.push_str(if is_float {
            "\\usepackage[active,tightpage,floats]{preview}\n"
        } else {
            "\\usepackage[active,tightpage]{preview}\n"
        });
    }
    out.push_str("\\begin{document}\n");
    if is_float {
        // A float is NOT wrapped: `floats` makes the `figure`/`table` environment
        // itself the preview, and wrapping it would be the outer-par-mode error
        // {@link body_is_float} exists to avoid.
        out.push_str(body);
        out.push('\n');
    } else {
        out.push_str("\\begin{preview}\n");
        out.push_str(body);
        out.push_str("\n\\end{preview}\n");
    }
    out.push_str("\\end{document}\n");
    out
}

/// The fallback wrapper: `standalone` plus the AMS math packages, and none of the
/// author's preamble. Used only when the real one could not be loaded — a missing
/// `.sty`, a `preview.sty` this TeX install does not ship — so a formula still
/// previews in a document whose macros the fragment happens not to use. Pure.
fn fallback_preview_document(body: &str) -> String {
    // A float cannot live in `standalone` for the reason it cannot live inside
    // `\begin{preview}` — it needs outer par mode and a class with a float
    // mechanism — so its fallback is a plain `article` driven by the same `floats`
    // option, minus the author's preamble.
    if body_is_float(body) {
        return format!(
            "\\documentclass[12pt]{{article}}\n\
             \\usepackage{{amsmath,amssymb,amsfonts}}\n\
             \\usepackage{{graphicx}}\n\
             \\usepackage[active,tightpage,floats]{{preview}}\n\
             \\begin{{document}}\n{body}\n\\end{{document}}\n"
        );
    }
    format!(
        "\\documentclass[preview,border=4pt]{{standalone}}\n\
         \\usepackage{{amsmath,amssymb,amsfonts}}\n\
         \\usepackage{{graphicx}}\n\
         \\begin{{document}}\n{body}\n\\end{{document}}\n"
    )
}

/// Is this failure the *preamble's* rather than the snippet's — i.e. worth a
/// second pass without the author's preamble?
///
/// The distinction matters because the fallback is a whole extra engine run on
/// every hover that trips it. A snippet with a real typo (`\frac{1}{`) must fail
/// once and report; a document whose `preview.sty` is not installed, or whose
/// preamble pulls a `.sty` living somewhere this compile cannot see, is worth
/// retrying without it. Pure / unit-tested.
fn preview_needs_fallback(log: &str) -> bool {
    let l = log.to_ascii_lowercase();
    // "Not in outer par mode" is a *preamble* failure here, not the fragment's:
    // it means a float could not be given `preview`'s `floats` option, which
    // happens exactly when the document's own preamble already loaded the package
    // (an option cannot be added to a package that is loaded). The fallback drops
    // that preamble and sets the option itself.
    l.contains("not in outer par mode")
        || l.contains("preview.sty")
        || l.contains("option clash")
        || l.contains("unknown option")
        || ((l.contains(".sty") || l.contains(".cls") || l.contains("\\usepackage"))
            && (l.contains("not found") || l.contains("file not found")))
}

/// The preview scratch root: `<state_dir>/tex-preview`.
fn preview_scratch_root() -> std::path::PathBuf {
    crate::storage::state_dir().join("tex-preview")
}

/// Delete scratch dirs left behind by a crashed or killed run. The happy path
/// removes its own, so anything older than {@link PREVIEW_SCRATCH_MAX_AGE} is a
/// leftover. Every failure here is silent: a scratch dir that could not be tidied
/// is not a reason a preview should not render.
///
/// `now` is a parameter so the age rule can be tested without reaching for a
/// crate that can backdate a directory's mtime.
fn sweep_preview_scratch(root: &Path, now: std::time::SystemTime) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_dir() {
            continue;
        }
        // The format cache lives under the same root but is not run scratch: it
        // is *supposed* to outlive the run that built it, and has its own sweep
        // ({@link sweep_preview_fmts}) with its own age rule.
        if entry.file_name() == "fmt" {
            continue;
        }
        let stale = meta
            .modified()
            .ok()
            .and_then(|m| now.duration_since(m).ok())
            .map(|age| age > PREVIEW_SCRATCH_MAX_AGE)
            .unwrap_or(false);
        if stale {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

/// A fresh scratch dir for one preview run, under the swept root.
fn make_preview_scratch() -> Result<std::path::PathBuf, String> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);

    let root = preview_scratch_root();
    fs::create_dir_all(&root).map_err(|e| format!("create {}: {e}", root.display()))?;
    sweep_preview_scratch(&root, std::time::SystemTime::now());
    let dir = root.join(format!(
        "{}-{}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    Ok(dir)
}

// ── Precompiled preamble formats ─────────────────────────────────────────────

/// Where the preamble formats live: `<state_dir>/tex-preview/fmt`.
fn preview_fmt_root() -> std::path::PathBuf {
    preview_scratch_root().join("fmt")
}

/// FNV-1a, 64 bit. A cache key, not a security hash — same reasoning as the
/// frontend's `texPreviewKey`, and like it the key below also carries the input
/// length, which no cheap hash can be made to collide with by accident.
fn fnv64(s: &str) -> u64 {
    fnv64_bytes(s.as_bytes())
}

/// {@link fnv64} over raw bytes — the document-format key hashes local `.sty`/
/// `.tex` dependency *files*, which need not be UTF-8.
fn fnv64_bytes(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for &b in bytes {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

/// The cache key (and jobname, and file stem) for one preamble format: engine +
/// the wrapper's whole head — everything {@link preview_document} put before
/// `\begin{document}`, which is the exact text the dump freezes. Hashing the
/// *wrapper* head rather than the caller's preamble is deliberate: the head also
/// encodes the injected `\documentclass` and which `preview` option line was
/// chosen (`floats` for a figure/table), so a float and a formula under one
/// preamble get the two different formats they need. Pure / unit-tested.
fn preview_fmt_key(engine: &str, wrapper: &str) -> String {
    let head = match wrapper.find("\\begin{document}") {
        Some(i) => &wrapper[..i],
        None => wrapper,
    };
    format!("{engine}-{:016x}-{}", fnv64(head), head.len())
}

/// Is `mylatexformat.ltx` installed? Probed once per app run — it is a TeX Live
/// / MiKTeX package that either is or is not there, and a `kpsewhich` per hover
/// would be a process spawn spent re-learning the same answer.
fn mylatexformat_available(cwd: &Path) -> bool {
    static AVAILABLE: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *AVAILABLE.get_or_init(|| {
        run_in_within(
            cwd,
            "kpsewhich",
            &["mylatexformat.ltx"],
            std::time::Duration::from_secs(10),
        )
        .map(|o| o.ok && !o.text.trim().is_empty())
        .unwrap_or(false)
    })
}

/// Drop format-cache files that are too old to trust ({@link PREVIEW_FMT_MAX_AGE})
/// and, past {@link PREVIEW_FMT_MAX} survivors, the oldest of the rest. Applies
/// to everything in the dir — the `.bad` markers age out on the same clock,
/// which is also what gives a preamble whose format build failed transiently
/// (a timeout, a package being installed) its retry. Silent like the scratch
/// sweep: an untidied cache is not a reason a preview should not render.
fn sweep_preview_fmts(root: &Path, now: std::time::SystemTime) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    let mut files: Vec<(std::path::PathBuf, std::time::SystemTime)> = Vec::new();
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let modified = meta.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        let stale = now
            .duration_since(modified)
            .map(|age| age > PREVIEW_FMT_MAX_AGE)
            .unwrap_or(false);
        if stale {
            let _ = fs::remove_file(entry.path());
        } else {
            files.push((entry.path(), modified));
        }
    }
    if files.len() > PREVIEW_FMT_MAX {
        files.sort_by_key(|(_, m)| *m);
        for (path, _) in &files[..files.len() - PREVIEW_FMT_MAX] {
            let _ = fs::remove_file(path);
        }
    }
}

/// The precompiled format for this wrapper's preamble, building it if need be —
/// or `None`, in which case the caller compiles the old way and loses nothing
/// but the speedup.
///
/// pdflatex only, measured rather than assumed: `mylatexformat` documents itself
/// as unreliable under LuaTeX (fonts loaded by `luaotfload` do not survive a
/// dump) and XeTeX has the same problem via `fontspec`, so on those engines a
/// "cached" preview could silently render with the wrong fonts — worse than
/// slow. A failed build writes a `.bad` marker beside where the format would
/// live, so a preamble that *cannot* be dumped (packages doing real work at
/// `\begin{document}` exist) costs one failed attempt per
/// {@link PREVIEW_FMT_MAX_AGE}, not one per hover.
///
/// The build itself is `pdflatex -ini &pdflatex mylatexformat.ltx <wrapper>`,
/// run exactly like a preview pass (document's dir as cwd so the preamble's
/// relative `\input`s resolve, artefacts to the scratch dir) with the finished
/// format renamed into the cache — rename, so a preview racing this one never
/// sees a half-written file. Loading the dump also *skips* the wrapper's
/// preamble lines on the later run; that is `mylatexformat`'s contract, not an
/// assumption.
fn ensure_preview_fmt(
    cwd: &Path,
    engine: &str,
    wrapper: &str,
    scratch: &Path,
    tex: &Path,
    out_arg: &str,
) -> Option<std::path::PathBuf> {
    if engine != "pdflatex" || !mylatexformat_available(cwd) {
        return None;
    }
    let root = preview_fmt_root();
    let key = preview_fmt_key(engine, wrapper);
    let fmt = root.join(format!("{key}.fmt"));
    // The age bound is checked here, at reuse, not only by the sweep — the sweep
    // runs on cache *misses*, so a format reused continuously would otherwise
    // never age out and its frozen `\input{macros}` would go stale forever.
    if let Ok(meta) = fmt.metadata() {
        let fresh = meta
            .modified()
            .ok()
            .and_then(|m| std::time::SystemTime::now().duration_since(m).ok())
            .map(|age| age <= PREVIEW_FMT_MAX_AGE)
            .unwrap_or(true);
        if fresh {
            return Some(fmt);
        }
        let _ = fs::remove_file(&fmt);
    }
    if root.join(format!("{key}.bad")).is_file() {
        return None;
    }
    fs::create_dir_all(&root).ok()?;
    sweep_preview_fmts(&root, std::time::SystemTime::now());

    fs::write(tex, wrapper).ok()?;
    // SECURITY: a fixed argument list — no user flags reach a format build, so
    // it can no more enable shell-escape than the preview pass can.
    let args = vec![
        "-ini".to_string(),
        "-interaction=nonstopmode".to_string(),
        NO_SHELL_ESCAPE.to_string(),
        format!("-output-directory={out_arg}"),
        format!("-jobname={key}"),
        format!("&{engine}"),
        "mylatexformat.ltx".to_string(),
        tex.to_string_lossy().into_owned(),
    ];
    // A spawn failure is the machine's problem, not this preamble's: no marker.
    let built = run_in_within_env(cwd, engine, &args, PREVIEW_TIMEOUT, &preview_env()).ok()?;
    let out_fmt = scratch.join(format!("{key}.fmt"));
    if built.ok && out_fmt.is_file() && fs::rename(&out_fmt, &fmt).is_ok() {
        return Some(fmt);
    }
    let _ = fs::write(root.join(format!("{key}.bad")), b"");
    None
}

/// Did this run die loading the *format itself* — a cache corrupted on disk, or
/// a dump left behind by a since-upgraded engine ("format made by different
/// version") — rather than typesetting the snippet? That distinction decides
/// whether a failed fmt run is retried without the format (and the format
/// discarded) or reported as the snippet's own error, no second run. Pure /
/// unit-tested.
fn preview_log_is_format_error(log: &str) -> bool {
    log.contains("Fatal format file error") || log.contains("made by different")
}

/// Typeset one snippet for the editor's hover preview.
///
/// `dir` is the document's own folder — the *working directory* of the run, so a
/// preamble's relative `\input`/`\usepackage` still resolves — and nothing is
/// written there: the wrapper and every artefact live in a scratch dir that is
/// removed before this returns. See the section comment above for the rest.
///
/// `async` for the same reason `compile_tex` is: a synchronous command runs on
/// the main thread, and a preview must never be able to freeze the window.
#[tauri::command]
pub async fn tex_preview_snippet(
    dir: String,
    preamble: String,
    body: String,
    engine: Option<String>,
) -> Result<TexPreviewResult, String> {
    tauri::async_runtime::spawn_blocking(move || preview_snippet_blocking(dir, preamble, body, engine))
        .await
        .map_err(|e| format!("preview task failed: {e}"))?
}

fn preview_snippet_blocking(
    dir: String,
    preamble: String,
    body: String,
    engine: Option<String>,
) -> Result<TexPreviewResult, String> {
    if body.trim().is_empty() {
        return Err("empty snippet".to_string());
    }
    if body.len() > MAX_PREVIEW_BODY {
        return Err(format!(
            "snippet too large to preview ({} bytes; limit {MAX_PREVIEW_BODY})",
            body.len()
        ));
    }
    if preamble.len() > MAX_PREVIEW_PREAMBLE {
        return Err(format!(
            "preamble too large to preview ({} bytes; limit {MAX_PREVIEW_PREAMBLE})",
            preamble.len()
        ));
    }
    let cwd = fs::canonicalize(&dir).map_err(|e| format!("canonicalize {dir}: {e}"))?;
    if !cwd.is_dir() {
        return Err(format!("not a directory: {}", cwd.display()));
    }

    let cap = detect_capability();
    // latexmk alone cannot serve this path: the preview runs the engine itself.
    // No engine chosen: the one the preamble asks for, as a build would pick.
    let eng = engine
        .filter(|e| cap.engines.iter().any(|g| g == e))
        .or_else(|| engine_for_hint(detect_engine_hint(&preamble, &cwd), &cap.engines))
        .or_else(|| cap.engines.first().cloned())
        .ok_or_else(|| "no TeX engine found on PATH".to_string())?;

    let scratch = make_preview_scratch()?;
    let stem = concat!(crate::app_slug!(), "-preview");
    let tex = scratch.join(format!("{stem}.tex"));
    let pdf = scratch.join(format!("{stem}.pdf"));
    let out_arg = scratch.to_string_lossy().into_owned();

    // One pass per attempt: a fragment has nothing to settle over a rerun.
    let run = |source: &str, fmt: Option<&Path>| -> Result<String, String> {
        let _ = fs::remove_file(&pdf);
        fs::write(&tex, source).map_err(|e| format!("write {}: {e}", tex.display()))?;
        // SECURITY: the same argument builder the full compile uses, so a preview
        // can no more enable shell-escape than a build can (no `extra` flags are
        // accepted here at all).
        let mut args = engine_args(&tex.to_string_lossy(), Some(&out_arg), &[]);
        // …minus SyncTeX: nothing forward-searches into a hover card, and a
        // `.synctex.gz` written and thrown away per hover is pure latency.
        args.retain(|a| a != "-synctex=1");
        if let Some(f) = fmt {
            args.insert(0, format!("-fmt={}", f.display()));
        }
        let out = run_in_within_env(&cwd, &eng, &args, PREVIEW_TIMEOUT, &preview_env())?;
        Ok(out.text)
    };

    let wrapper = preview_document(&preamble, &body);
    let fmt = ensure_preview_fmt(&cwd, &eng, &wrapper, &scratch, &tex, &out_arg);
    let first = run(&wrapper, fmt.as_deref());
    let mut fallback = false;
    let mut log = match first {
        Ok(text) => text,
        Err(e) => {
            let _ = fs::remove_dir_all(&scratch);
            return Err(e);
        }
    };
    // A cached format that no longer *loads* — corrupted on disk, or the engine
    // was upgraded under it — must cost one retry, not the preview: discard it
    // and compile the old way. A snippet's own error is NOT this case and gets
    // no second run (see {@link preview_log_is_format_error}).
    if !pdf.exists() && fmt.is_some() && preview_log_is_format_error(&log) {
        if let Some(f) = &fmt {
            let _ = fs::remove_file(f);
        }
        match run(&wrapper, None) {
            Ok(text) => log = text,
            Err(e) => {
                let _ = fs::remove_dir_all(&scratch);
                return Err(e);
            }
        }
    }
    if !pdf.exists() && preview_needs_fallback(&log) {
        // Keep the FIRST log: it names what went wrong with the real preamble,
        // which is what the reader can act on. The fallback's own output only
        // matters if it, too, fails to produce anything.
        match run(&fallback_preview_document(&body), None) {
            Ok(text) => {
                if pdf.exists() {
                    fallback = true;
                } else {
                    log = text;
                }
            }
            Err(e) => {
                let _ = fs::remove_dir_all(&scratch);
                return Err(e);
            }
        }
    }

    let pdf_b64 = fs::read(&pdf)
        .ok()
        .map(|bytes| base64::engine::general_purpose::STANDARD.encode(bytes));
    let _ = fs::remove_dir_all(&scratch);
    Ok(TexPreviewResult {
        success: pdf_b64.is_some(),
        log: tail(&log),
        pdf_b64,
        fallback,
    })
}

// ── Font discovery ───────────────────────────────────────────────────────────
//
// The deck's type picker (TODO V #120). A Beamer plate is typeset in Computer
// Modern / Latin Modern, so with the standard-14 faces alone *every* layer
// caption sat in Helvetica on top of it — and a non-Latin talk was impossible,
// since those faces are WinAnsi-encoded.
//
// Deliberately a plain directory walk rather than fontconfig: the picker needs a
// **file path**, because the frontend embeds the bytes (the same bytes it
// measures with — see `deck/fonts.ts`), and `fc-list` is one more optional tool
// to depend on for a list this can produce itself.

/// One font file the deck can embed.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct FontFile {
    /// Absolute path — the key the frontend measures and embeds by.
    pub path: String,
    /// A human label: the file stem with separators normalised.
    pub name: String,
}

/// Font-file extensions pdf-lib's fontkit can actually embed. `.pfb`/`.otc` and
/// bitmap formats are excluded rather than offered and then failing at export.
const FONT_EXTS: &[&str] = &["ttf", "otf", "ttc", "woff", "woff2"];

/// Directories to walk, per platform. A user directory first so a font the user
/// installed themselves outranks a system copy of the same family in the list.
fn font_dirs() -> Vec<std::path::PathBuf> {
    let mut out: Vec<std::path::PathBuf> = Vec::new();
    // The crate's own resolver, not a new dependency — it already encodes the
    // per-OS rules (and the tests' overrides) every other path here goes through.
    let home = crate::paths::home_dir();
    #[cfg(target_os = "linux")]
    {
        out.push(home.join(".local/share/fonts"));
        out.push(home.join(".fonts"));
    }
    #[cfg(target_os = "macos")]
    out.push(home.join("Library/Fonts"));
    #[cfg(target_os = "windows")]
    out.push(home.join("AppData/Local/Microsoft/Windows/Fonts"));
    let _ = &home;
    #[cfg(target_os = "linux")]
    {
        out.push("/usr/share/fonts".into());
        out.push("/usr/local/share/fonts".into());
    }
    #[cfg(target_os = "macos")]
    {
        out.push("/Library/Fonts".into());
        out.push("/System/Library/Fonts".into());
    }
    #[cfg(target_os = "windows")]
    out.push("C:\\Windows\\Fonts".into());
    out
}

/// Turn a font file's stem into something a picker can show: `LiberationSerif-BoldItalic`
/// → `Liberation Serif Bold Italic`.
pub fn font_display_name(stem: &str) -> String {
    let spaced = stem.replace(['-', '_'], " ");
    let mut out = String::with_capacity(spaced.len() + 4);
    let mut prev_lower = false;
    for ch in spaced.chars() {
        // Split camel case, but never inside a run of capitals (an acronym).
        if prev_lower && ch.is_uppercase() {
            out.push(' ');
        }
        prev_lower = ch.is_lowercase() || ch.is_ascii_digit();
        out.push(ch);
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn collect_fonts(dir: &Path, depth: u32, out: &mut Vec<FontFile>) {
    // Font trees are shallow (`/usr/share/fonts/truetype/<family>/`), and an
    // unbounded walk of a symlinked home directory is how a "list the fonts" call
    // turns into a filesystem scan.
    if depth > 3 || out.len() > 4000 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        // `metadata` follows symlinks; a font directory that links to itself
        // would otherwise recurse until the depth cap, needlessly.
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            collect_fonts(&path, depth + 1, out);
            continue;
        }
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .unwrap_or_default();
        if !FONT_EXTS.contains(&ext.as_str()) {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        out.push(FontFile {
            name: font_display_name(stem),
            path: path.to_string_lossy().into_owned(),
        });
    }
}

/// Every embeddable font file on this machine, deduplicated by path and sorted
/// by display name. Never an error: a missing directory is simply one fewer
/// place to look.
#[tauri::command]
pub async fn list_fonts() -> Result<Vec<FontFile>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut out: Vec<FontFile> = Vec::new();
        for dir in font_dirs() {
            collect_fonts(&dir, 0, &mut out);
        }
        out.sort_by(|a, b| {
            a.name
                .to_lowercase()
                .cmp(&b.name.to_lowercase())
                .then(a.path.cmp(&b.path))
        });
        out.dedup_by(|a, b| a.path == b.path);
        Ok(out)
    })
    .await
    .map_err(|e| format!("font scan failed: {e}"))?
}

// ── SyncTeX: which source lines produced each page ───────────────────────────
//
// This is the producer half of the deck's slide anchoring (`sidecar.ts`'s
// `reconcile`, TODO V #100). The sidecar has always documented a `line` anchor as
// "strictly better than any content heuristic" — it survives inserting, deleting
// and reordering frames exactly as well as the author's own mental model — and
// has always *consumed* one. Nothing ever wrote it, so the mechanism did not
// exist at runtime and every deck fell back to fingerprinting.
//
// It is answered by reading the `.synctex.gz` the compile already emits
// (`-synctex=1` is passed unconditionally) rather than by shelling out to
// `synctex edit` once per page: a 200-page plate would be 200 process spawns for
// one reconcile.

/// The source lines SyncTeX attributes to one page of a compiled PDF.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PageLines {
    /// 1-based, as the PDF numbers it.
    pub page: u32,
    /// Distinct contributing lines of the **main** input file, ascending.
    pub lines: Vec<u32>,
}

/// Parse a decompressed SyncTeX file into per-page line sets.
///
/// The format is one record per line. `{N` opens page N and `}N` closes it;
/// inside, a box/glyph/kern/glue record is `<type><tag>,<line>[,<column>]:<geometry>`
/// where `<tag>` names an input file declared in the preamble as
/// `Input:<tag>:<path>`. Closing records (`]`, `)`) carry no tag.
///
/// `want_tag` restricts the harvest to one input file. That restriction is
/// load-bearing rather than an optimisation: line numbers from two different
/// files are not comparable, so mixing them would produce an anchor that silently
/// means nothing. A deck whose frames live in an `\input`ed file simply records no
/// line and falls back to the fingerprint, which is the honest outcome.
pub fn parse_synctex_pages(text: &str, want_tag: Option<u32>) -> Vec<PageLines> {
    let mut out: Vec<PageLines> = Vec::new();
    let mut page: Option<u32> = None;
    let mut lines: std::collections::BTreeSet<u32> = std::collections::BTreeSet::new();

    let flush = |page: &mut Option<u32>,
                 lines: &mut std::collections::BTreeSet<u32>,
                 out: &mut Vec<PageLines>| {
        if let Some(p) = page.take() {
            out.push(PageLines {
                page: p,
                lines: lines.iter().copied().collect(),
            });
            lines.clear();
        }
    };

    for raw in text.lines() {
        let l = raw.trim_end();
        let Some(c) = l.chars().next() else { continue };
        match c {
            '{' => {
                if let Ok(p) = l[1..].trim().parse::<u32>() {
                    flush(&mut page, &mut lines, &mut out);
                    page = Some(p);
                }
            }
            '}' => flush(&mut page, &mut lines, &mut out),
            // Box open/close-with-content, void boxes, and the glyph/kern/glue
            // records. `]` and `)` are the closers and carry no tag, so they are
            // not listed.
            '[' | '(' | 'v' | 'h' | 'x' | 'k' | 'g' | '$' | 'r' if page.is_some() => {
                if let Some((tag, line)) = parse_record_tag_line(&l[1..]) {
                    if want_tag.is_none_or(|w| w == tag) && line > 0 {
                        lines.insert(line);
                    }
                }
            }
            _ => {}
        }
    }
    flush(&mut page, &mut lines, &mut out);
    out.sort_by_key(|p| p.page);
    out
}

/// `"1,23:0,0:..."` → `(1, 23)`. Returns None for anything not shaped like a
/// record body, which is how the postamble's `Count:`-style lines are skipped
/// without enumerating them.
fn parse_record_tag_line(body: &str) -> Option<(u32, u32)> {
    let head = body.split(':').next()?;
    let mut parts = head.split(',');
    let tag = parts.next()?.trim().parse::<u32>().ok()?;
    let line = parts.next()?.trim().parse::<u32>().ok()?;
    Some((tag, line))
}

/// Find the `Input:` tag whose path has file stem `stem`, i.e. the document's own
/// main source rather than one of its includes or a package.
pub fn main_input_tag(text: &str, stem: &str) -> Option<u32> {
    for raw in text.lines() {
        let l = raw.trim();
        let Some(rest) = l.strip_prefix("Input:") else {
            // The Input block is contiguous and precedes the content; once past
            // it there is nothing left to find, and scanning a 40 MB body for a
            // prefix that cannot appear is pure cost.
            if l.starts_with("Content:") {
                return None;
            }
            continue;
        };
        let mut it = rest.splitn(2, ':');
        let tag = it.next()?.trim().parse::<u32>().ok();
        let path = it.next().unwrap_or("").trim();
        if let (Some(tag), Some(s)) = (tag, Path::new(path).file_stem().and_then(|s| s.to_str())) {
            if s == stem {
                return Some(tag);
            }
        }
    }
    None
}

/// Read the SyncTeX map beside `pdf` and report the source lines behind each page.
///
/// Returns an empty vector — never an error — when there is no map: a deck whose
/// plate was imported, or compiled by something that did not emit one, is an
/// ordinary case that falls back to content fingerprinting. Only a map that
/// exists and cannot be read is an error worth surfacing.
#[tauri::command]
pub async fn synctex_page_lines(pdf: String) -> Result<Vec<PageLines>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let pdf_path = Path::new(&pdf);
        let stem = match pdf_path.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => return Ok(Vec::new()),
        };
        let dir = pdf_path.parent().unwrap_or_else(|| Path::new("."));

        let gz = dir.join(format!("{stem}.synctex.gz"));
        let plain = dir.join(format!("{stem}.synctex"));
        let text = if gz.exists() {
            let bytes = fs::read(&gz).map_err(|e| format!("read {}: {e}", gz.display()))?;
            let mut out = String::new();
            use std::io::Read;
            flate2::read::GzDecoder::new(&bytes[..])
                .read_to_string(&mut out)
                .map_err(|e| format!("decompress {}: {e}", gz.display()))?;
            out
        } else if plain.exists() {
            fs::read_to_string(&plain).map_err(|e| format!("read {}: {e}", plain.display()))?
        } else {
            return Ok(Vec::new());
        };

        let tag = main_input_tag(&text, &stem);
        Ok(parse_synctex_pages(&text, tag))
    })
    .await
    .map_err(|e| format!("synctex task failed: {e}"))?
}

// ── SyncTeX forward/reverse search ───────────────────────────────────────────

/// Parse the `synctex edit` stdout into a `SyncSource`. The relevant block looks
/// like:
/// ```text
/// SyncTeX result begin
/// Output:doc.pdf
/// Input:/abs/path/chapter.tex
/// Line:42
/// Column:-1
/// …
/// SyncTeX result end
/// ```
/// The source file is on the `Input:` line; `Output:` names the PDF and is
/// ignored. `base` is the PDF's directory, used to absolutise a relative
/// `Input:` path.
fn parse_synctex_edit(out: &str, base: &Path) -> Option<SyncSource> {
    let mut input: Option<String> = None;
    let mut line: u32 = 0;
    let mut column: u32 = 0;
    for raw in out.lines() {
        let l = raw.trim();
        if let Some(v) = l.strip_prefix("Input:") {
            if input.is_none() {
                let p = Path::new(v.trim());
                let abs = if p.is_absolute() {
                    p.to_path_buf()
                } else {
                    base.join(p)
                };
                let abs = fs::canonicalize(&abs).unwrap_or(abs);
                input = Some(abs.to_string_lossy().into_owned());
            }
        } else if let Some(v) = l.strip_prefix("Line:") {
            if line == 0 {
                line = v.trim().parse().unwrap_or(0);
            }
        } else if let Some(v) = l.strip_prefix("Column:") {
            if column == 0 {
                // SyncTeX reports -1 when there is no column; clamp to 0.
                column = v.trim().parse().unwrap_or(0);
            }
        }
    }
    let input = input?;
    if line == 0 {
        return None;
    }
    Some(SyncSource {
        input,
        line,
        column,
    })
}

/// Reverse search: which source line produced the point `(x, y)` (big points
/// from the page top-left) on `page` of `pdf`. Returns `Ok(None)` when SyncTeX
/// is unavailable or has no answer, so the UI can degrade silently.
///
/// The `.synctex(.gz)` beside the PDF is read directly
/// (`commands::synctex::resolve`) rather than by shelling out, because the CLI
/// answers a click that is not squarely on a glyph — the left margin, a
/// paragraph indent, the slack after a short line — with the *enclosing box's*
/// tag, and pdfTeX labels that box with wherever `\par` happened to fire. On a
/// three-file document that is a different `.tex` file for every such click, so
/// the jump lands in the wrong editor. See that module for the record dump.
///
/// `synctex edit` remains the fallback for a PDF with no map beside it (an
/// out-of-tree build) or a map this parser could not make sense of; the CLI is
/// also what supplies the column, which the map never records.
///
/// Async so the read + gunzip runs off the main thread: a sync `#[tauri::command]`
/// is called on it, and a large document's map is megabytes.
#[tauri::command]
pub async fn synctex_edit(
    pdf: String,
    page: u32,
    x: f64,
    y: f64,
) -> Result<Option<SyncSource>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let pdf_path = Path::new(&pdf);
        let dir = pdf_path.parent().unwrap_or_else(|| Path::new("."));
        if let Some((input, line)) = crate::commands::synctex::resolve(pdf_path, page, x, y) {
            return Ok(Some(SyncSource {
                input,
                line,
                column: 0,
            }));
        }
        if !on_path("synctex") {
            return Ok(None);
        }
        let spec = format!("{page}:{x}:{y}:{pdf}");
        let out = run_in(dir, "synctex", &["edit", "-o", &spec])?;
        Ok(parse_synctex_edit(&out.text, dir))
    })
    .await
    .map_err(|e| format!("synctex task failed: {e}"))?
}

/// Why a reverse-search click did nothing, or landed on the wrong line: whether
/// a map exists beside `pdf`, whether the PDF outgrew it, and which local
/// sources were saved after it ({@link crate::commands::synctex::MapStatus}).
/// The viewer asks after a miss — and after a hit, to warn that the line it just
/// jumped to belongs to the build before the edit — and words a "recompile"
/// notice from the answer. Off the main thread for the same reason as
/// `synctex_edit`: the first call after a compile inflates the map.
#[tauri::command]
pub async fn synctex_status(pdf: String) -> Result<crate::commands::synctex::MapStatus, String> {
    tauri::async_runtime::spawn_blocking(move || crate::commands::synctex::status(Path::new(&pdf)))
        .await
        .map_err(|e| format!("synctex task failed: {e}"))
}

/// Parse the `synctex view` stdout into every record block it emitted, in order.
/// A forward query returns ONE block per node the source position maps to — one
/// per horizontal box on the line, and one per visual line when a source line
/// wraps — so the caller can pick the box matching the clicked column / row
/// rather than guessing from a single line box. Each block looks like:
/// ```text
/// SyncTeX result begin
/// Page:3
/// x:123.4
/// y:567.8
/// h:120.0
/// v:560.0
/// W:380.0
/// H:12.0
/// Page:3
/// …
/// SyncTeX result end
/// ```
/// We use `h` for the left edge and `W`/`H` for size; all in big points from the
/// page top-left. SyncTeX's `v` is the box *bottom* (baseline+depth), not its
/// top — verified empirically against `synctex edit` — so the rect's top edge is
/// `v - H`. Using `v` directly placed the highlight about one line too low. A new
/// `Page:` line starts a new record; an incomplete trailing block is dropped.
fn parse_synctex_view(out: &str) -> Vec<SyncRect> {
    /// Fields accumulated for the record currently being read.
    struct Partial {
        page: u32,
        h: Option<f64>,
        v: Option<f64>,
        w: Option<f64>,
        ht: Option<f64>,
    }

    let mut recs: Vec<SyncRect> = Vec::new();
    let mut cur: Option<Partial> = None;

    // Emit the accumulated record if it has the two fields a box needs (left edge
    // `h` and bottom `v`); width/height default to 0 when SyncTeX omitted them.
    let flush = |cur: &mut Option<Partial>, recs: &mut Vec<SyncRect>| {
        if let Some(p) = cur.take() {
            if let (Some(x), Some(v)) = (p.h, p.v) {
                let height = p.ht.unwrap_or(0.0).abs();
                recs.push(SyncRect {
                    page: p.page,
                    x,
                    // `v` is the box bottom; the rect's top is one box-height above.
                    y: v - height,
                    w: p.w.unwrap_or(0.0).abs(),
                    h: height,
                });
            }
        }
    };

    for raw in out.lines() {
        let l = raw.trim();
        if let Some(s) = l.strip_prefix("Page:") {
            // A new node begins; bank the previous one first.
            flush(&mut cur, &mut recs);
            cur = Some(Partial {
                page: s.trim().parse().unwrap_or(0),
                h: None,
                v: None,
                w: None,
                ht: None,
            });
        } else if let Some(p) = cur.as_mut() {
            let set = |slot: &mut Option<f64>, v: &str| {
                if slot.is_none() {
                    if let Ok(n) = v.trim().parse() {
                        *slot = Some(n);
                    }
                }
            };
            if let Some(s) = l.strip_prefix("h:") {
                set(&mut p.h, s);
            } else if let Some(s) = l.strip_prefix("v:") {
                set(&mut p.v, s);
            } else if let Some(s) = l.strip_prefix("W:") {
                set(&mut p.w, s);
            } else if let Some(s) = l.strip_prefix("H:") {
                set(&mut p.ht, s);
            }
        }
    }
    flush(&mut cur, &mut recs);
    recs
}

/// Forward search: where in `pdf` does `input:line:column` land. Returns every
/// SyncTeX record block (the line's constituent boxes / wrapped rows), in order;
/// the frontend picks the one matching the clicked column. Empty when SyncTeX is
/// unavailable or has no answer.
///
/// The `.synctex(.gz)` beside the PDF is read directly
/// (`commands::synctex::view`) first, for the same reason reverse search is: the
/// CLI's `synctex view -i` matches the input against the *exact* path string
/// SyncTeX recorded, so an absolute vs. `./`-prefixed vs. symlinked spelling that
/// doesn't match character-for-character silently returns nothing — "can't locate
/// the cursor" even with the caret squarely on body text. The native reader
/// matches the source file by canonicalised path, so spelling can't defeat it.
///
/// `synctex view` remains the fallback for a PDF whose map this parser could not
/// make sense of, or one with no map beside it.
#[tauri::command]
pub fn synctex_view(
    pdf: String,
    input: String,
    line: u32,
    column: u32,
) -> Result<Vec<SyncRect>, String> {
    let pdf_path = Path::new(&pdf);
    let native = crate::commands::synctex::view(pdf_path, &input, line);
    if !native.is_empty() {
        return Ok(native
            .into_iter()
            .map(|(page, x, y, w, h)| SyncRect { page, x, y, w, h })
            .collect());
    }
    let dir = pdf_path.parent().unwrap_or_else(|| Path::new("."));
    if !on_path("synctex") {
        return Ok(Vec::new());
    }
    let spec = format!("{line}:{column}:{input}");
    let out = run_in(dir, "synctex", &["view", "-i", &spec, "-o", &pdf])?;
    Ok(parse_synctex_view(&out.text))
}

// ── Subtex → main-tex root mapping ───────────────────────────────────────────

/// Commands that pull another `.tex` into the document. Matches the file-include
/// subset of the frontend's `TEX_REF_COMMANDS` (`src/components/files/tex.ts`).
const INCLUDE_COMMANDS: &[&str] = &["input", "include", "subfile", "subfileinclude"];

/// Path of the persisted child→root map.
fn tex_roots_path() -> std::path::PathBuf {
    crate::storage::state_dir().join("tex_roots.json")
}

/// Extract the `.tex` files directly included by `source` text. `\input{a}` →
/// `a.tex`; an explicit extension is kept. Relative paths stay relative (the
/// caller resolves them against the including file's directory).
fn parse_includes(source: &str) -> Vec<String> {
    let mut out = Vec::new();
    let bytes = source.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'\\' {
            i += 1;
            continue;
        }
        // Read the command name after the backslash.
        let mut j = i + 1;
        while j < bytes.len() && (bytes[j] as char).is_ascii_alphabetic() {
            j += 1;
        }
        let cmd = &source[i + 1..j];
        if INCLUDE_COMMANDS.contains(&cmd) && j < bytes.len() && bytes[j] == b'{' {
            // Read the brace argument.
            if let Some(close) = source[j + 1..].find('}') {
                let arg = source[j + 1..j + 1 + close].trim().to_string();
                if !arg.is_empty() {
                    let with_ext = if Path::new(&arg).extension().is_some() {
                        arg
                    } else {
                        format!("{arg}.tex")
                    };
                    out.push(with_ext);
                }
                i = j + 1 + close + 1;
                continue;
            }
        }
        i = j.max(i + 1);
    }
    out
}

/// Recursively collect every `.tex` file reachable from `root` via include
/// commands, as canonicalized absolute paths (excluding `root` itself). Bounded
/// by a visited set and a depth cap so a cyclic `\input` can't loop forever.
fn scan_tex_includes(root: &Path) -> Vec<std::path::PathBuf> {
    fn walk(
        file: &Path,
        depth: usize,
        seen: &mut std::collections::HashSet<std::path::PathBuf>,
        out: &mut Vec<std::path::PathBuf>,
    ) {
        if depth > 32 {
            return;
        }
        let Ok(text) = fs::read_to_string(file) else {
            return;
        };
        let dir = file.parent().unwrap_or_else(|| Path::new("."));
        for rel in parse_includes(&text) {
            let p = Path::new(&rel);
            let abs = if p.is_absolute() {
                p.to_path_buf()
            } else {
                dir.join(p)
            };
            let abs = fs::canonicalize(&abs).unwrap_or(abs);
            if seen.insert(abs.clone()) {
                out.push(abs.clone());
                walk(&abs, depth + 1, seen, out);
            }
        }
    }
    let mut seen = std::collections::HashSet::new();
    let root = fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    seen.insert(root.clone());
    let mut out = Vec::new();
    walk(&root, 0, &mut seen, &mut out);
    out
}

/// After a successful compile, persist `child → root` for every `.tex` `root`
/// includes, so a later Compile in a child builds `root` instead of the
/// fragment. Best-effort: failures to read/write the map are ignored.
fn record_root_mappings(root: &Path) {
    let root_abs = fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let children = scan_tex_includes(&root_abs);
    if children.is_empty() {
        return;
    }
    let path = tex_roots_path();
    let mut map: std::collections::HashMap<String, String> =
        crate::storage::read_json(&path).unwrap_or_default();
    let root_str = root_abs.to_string_lossy().into_owned();
    // Drop stale entries that pointed at this root but are no longer included.
    let child_set: std::collections::HashSet<String> = children
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    map.retain(|child, mapped_root| *mapped_root != root_str || child_set.contains(child));
    for child in &child_set {
        map.insert(child.clone(), root_str.clone());
    }
    let _ = crate::storage::write_json(&path, &map);
}

/// Read the `% !TEX root = …` magic comment from the head of `source`, resolved
/// against `dir`. Matches the de-facto editor convention (TeXShop/TeXstudio/…).
fn magic_root(source: &str, dir: &Path) -> Option<std::path::PathBuf> {
    for raw in source.lines().take(20) {
        let l = raw.trim_start();
        if !l.starts_with('%') {
            continue;
        }
        let body = l.trim_start_matches('%').trim();
        // Case-insensitive "!TEX root =" / "!TEX root:".
        let lower = body.to_ascii_lowercase();
        if let Some(rest) = lower.strip_prefix("!tex root") {
            let rest = rest.trim_start();
            let rest = rest.strip_prefix('=').or_else(|| rest.strip_prefix(':'))?;
            // Map back to the original-cased slice for the path value.
            let val = &body[body.len() - rest.len()..];
            let val = val.trim();
            if val.is_empty() {
                return None;
            }
            let p = Path::new(val);
            let abs = if p.is_absolute() {
                p.to_path_buf()
            } else {
                dir.join(p)
            };
            return Some(fs::canonicalize(&abs).unwrap_or(abs));
        }
    }
    None
}

/// Resolve the file that should actually be compiled for `path`:
///   1. an explicit `% !TEX root = …` magic comment, else
///   2. the stored child→root map (if the root still exists and still includes
///      this child), else
///   3. `path` itself.
#[tauri::command]
pub fn resolve_tex_root(path: String) -> Result<String, String> {
    let src = fs::canonicalize(&path).unwrap_or_else(|_| Path::new(&path).to_path_buf());
    let dir = src.parent().unwrap_or_else(|| Path::new("."));

    // 1. Magic comment wins.
    if let Ok(text) = fs::read_to_string(&src) {
        if let Some(root) = magic_root(&text, dir) {
            if root.exists() {
                return Ok(root.to_string_lossy().into_owned());
            }
        }
    }

    // 2. Stored map, verified.
    let src_str = src.to_string_lossy().into_owned();
    if let Ok(map) =
        crate::storage::read_json::<std::collections::HashMap<String, String>>(&tex_roots_path())
    {
        if let Some(root) = map.get(&src_str) {
            let root_path = Path::new(root);
            if root_path.exists()
                && scan_tex_includes(root_path)
                    .iter()
                    .any(|c| c.to_string_lossy() == *src_str)
            {
                return Ok(root.clone());
            }
        }
    }

    // 3. It is its own root.
    Ok(src_str)
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// A SyncTeX body shaped like the real thing: a preamble of `Input:` files,
    /// then two pages, the second of which is a Beamer overlay of the first — the
    /// case the whole line anchor exists for, since both come from the same frame
    /// and are therefore attributed to the same source lines.
    const SYNCTEX: &str = "\
SyncTeX Version:1
Input:1:/talks/main.tex
Input:2:/usr/share/texmf/beamer.sty
Content:
{1
[1,12:0,0:100,50,0
(1,14:10,10:80,20,0
h1,15:10,10:80,10,0
)
x2,99:5,5
]
}1
{2
[1,12:0,0:100,50,0
h1,15:10,10:80,10,0
h1,18:10,30:80,10,0
]
}2
Postamble:
Count:2
";

    #[test]
    fn a_preview_wrapper_keeps_the_authors_preamble_and_crops_to_the_snippet() {
        let doc = preview_document(
            "\\documentclass{article}\n\\newcommand{\\R}{\\mathbb{R}}\n\\begin{document}\nbody\n\\end{document}\n",
            "$x \\in \\R$",
        );
        // The author's macro survives; the document body does not (a whole file
        // handed in by mistake must not become two \begin{document}s).
        assert!(doc.contains("\\newcommand{\\R}"));
        assert_eq!(doc.matches("\\begin{document}").count(), 1);
        assert!(!doc.contains("\nbody\n"));
        // Cropping is the whole point of the wrapper.
        assert!(doc.contains("\\usepackage[active,tightpage]{preview}"));
        assert!(doc.contains("\\begin{preview}\n$x \\in \\R$\n\\end{preview}"));
    }

    #[test]
    fn a_preamble_less_fragment_still_gets_a_class() {
        // A child `.tex` (`\input`ed by the main file) has no preamble at all.
        let doc = preview_document("\\newcommand{\\R}{\\mathbb{R}}\n", "$\\R$");
        assert!(doc.contains("\\documentclass"));
        assert!(doc.contains("\\newcommand{\\R}"));
    }

    #[test]
    fn a_preamble_that_already_loads_preview_is_not_made_to_clash() {
        // Loading `preview` twice with different options is an option clash —
        // i.e. the preview would fail for exactly the documents most prepared
        // for previewing.
        let doc = preview_document("\\documentclass{article}\n\\usepackage{preview}\n", "$x$");
        assert_eq!(doc.matches("\\usepackage").count(), 1);
        assert!(!doc.contains("[active,tightpage]"));
    }

    #[test]
    fn a_float_is_previewed_through_previews_own_float_option() {
        // Measured, not assumed: `\begin{figure}` demands outer par mode, so a
        // float wrapped in `\begin{preview}` dies with "Not in outer par mode"
        // and writes no PDF. `floats` makes the environment itself the preview.
        let doc = preview_document(
            "\\documentclass{article}\n\\usepackage{graphicx}\n",
            "\\begin{figure}\n\\includegraphics{fig/a}\n\\caption{A}\n\\end{figure}",
        );
        assert!(doc.contains("\\usepackage[active,tightpage,floats]{preview}"));
        assert!(!doc.contains("\\begin{preview}"));
        assert!(doc.contains("\\begin{figure}"));
    }

    #[test]
    fn only_the_four_float_names_preview_takes_are_treated_as_floats() {
        for body in [
            "\\begin{figure}x\\end{figure}",
            "  \\begin{figure*}x\\end{figure*}",
            "\\begin{table}x\\end{table}",
            "\\begin{table*}x\\end{table*}",
        ] {
            assert!(body_is_float(body), "{body}");
        }
        // A `wrapfigure` is not a `\@float` (it previews to no pages at all) and a
        // `float`-package custom float — which `algorithm` is — redefines
        // `\end@float` past what the option patches ("Extra }, or forgotten
        // \endgroup"). Both were tried against a real engine; neither is offered,
        // so neither may be wrapped as though it worked.
        for body in [
            "\\begin{wrapfigure}{r}{2cm}x\\end{wrapfigure}",
            "\\begin{algorithm}x\\end{algorithm}",
            "$x$",
            "\\begin{align}x\\end{align}",
        ] {
            assert!(!body_is_float(body), "{body}");
        }
    }

    #[test]
    fn a_floats_fallback_is_an_article_rather_than_standalone() {
        // `standalone` cannot host a float for the same reason `\begin{preview}`
        // cannot, so the float fallback has to be a class that has floats at all.
        let doc = fallback_preview_document("\\begin{table}x\\end{table}");
        assert!(doc.contains("{article}"));
        assert!(doc.contains("[active,tightpage,floats]{preview}"));
        assert!(!doc.contains("standalone"));
    }

    #[test]
    fn a_float_that_could_not_get_the_option_falls_back() {
        // The one case the option cannot be set: the document's own preamble
        // already loaded `preview`, and options cannot be added to a loaded
        // package. That is a preamble failure, so it earns the second pass.
        assert!(preview_needs_fallback("! LaTeX Error: Not in outer par mode."));
    }

    #[test]
    fn the_fallback_carries_no_preamble_of_the_authors() {
        let doc = fallback_preview_document("$x$");
        assert!(doc.contains("{standalone}"));
        assert!(doc.contains("amsmath"));
        assert!(doc.contains("$x$"));
    }

    #[test]
    fn only_a_preamble_failure_earns_the_second_pass() {
        // A missing style file / class, or a `preview.sty` this install lacks:
        // retry without the author's preamble.
        assert!(preview_needs_fallback(
            "! LaTeX Error: File `preview.sty' not found."
        ));
        assert!(preview_needs_fallback(
            "! LaTeX Error: File `mystyle.sty' not found."
        ));
        assert!(preview_needs_fallback("! LaTeX Error: Option clash for package preview."));
        // A typo in the fragment is the fragment's problem: fail once, report it,
        // and don't pay for a second engine run on every hover.
        assert!(!preview_needs_fallback(
            "! Missing } inserted.\nl.5 $\\frac{1}{"
        ));
        assert!(!preview_needs_fallback("! Undefined control sequence."));
    }

    #[test]
    fn a_preview_never_enables_shell_escape() {
        // Same invariant as the full compile, asserted separately because the
        // preview builds its own argument list rather than going through
        // `compile_tex` (see `compile_args_never_enable_shell_escape`).
        let args = engine_args(concat!("/scratch/", crate::app_slug!(), "-preview.tex"), Some("/scratch"), &[]);
        assert!(!args.iter().any(|a| flag_enables_shell_escape(a)));
        // …and turns it off outright, whatever the distribution's default (#867).
        assert!(args.iter().any(|a| a == NO_SHELL_ESCAPE), "{args:?}");
        assert!(preview_env().iter().any(|(k, v)| k == "openout_any" && v == "p"));
    }

    /// #867 end to end, where a TeX engine is installed: `shell_escape=t` in the
    /// environment stands in for a distribution that enables it in `texmf.cnf`.
    /// A preamble's `\write18` must not run on hover, nor its `\openout` escape
    /// the scratch dir.
    #[cfg(unix)]
    #[test]
    fn a_hover_preview_runs_no_shell_command_even_where_the_default_allows_it() {
        let Some(eng) = ["pdflatex", "lualatex", "xelatex"]
            .into_iter()
            .find(|e| crate::paths::resolve_executable(e).is_some())
        else {
            eprintln!("no TeX engine on PATH — skipping");
            return;
        };
        let tmp = tempfile::tempdir().unwrap();
        let doc = tmp.path().canonicalize().unwrap().join("doc");
        let out = tmp.path().canonicalize().unwrap().join("out");
        fs::create_dir_all(&doc).unwrap();
        fs::create_dir_all(&out).unwrap();
        let pwned = tmp.path().join("pwned");
        let escaped = tmp.path().join("escaped.tex");
        let tex = out.join("p.tex");
        fs::write(
            &tex,
            format!(
                "\\documentclass{{article}}\\immediate\\write18{{touch {}}}\n\
                 \\begin{{document}}x\\end{{document}}\n",
                pwned.display()
            ),
        )
        .unwrap();
        let args = engine_args(&tex.to_string_lossy(), Some(&out.to_string_lossy()), &[]);
        let mut envs = preview_env();
        envs.push(("shell_escape".to_string(), "t".to_string()));
        // Without the flag the plant must fire, or this test proves nothing.
        let bare: Vec<&String> = args.iter().filter(|a| *a != NO_SHELL_ESCAPE).collect();
        let _ = run_in_within_env(&doc, eng, &bare, PREVIEW_TIMEOUT, &envs);
        if !pwned.exists() {
            eprintln!("{eng} ignores shell_escape=t here — skipping");
            return;
        }
        fs::remove_file(&pwned).unwrap();
        let _ = fs::remove_file(out.join("p.pdf"));
        let run = run_in_within_env(&doc, eng, &args, PREVIEW_TIMEOUT, &envs).expect("engine ran");
        assert!(out.join("p.pdf").is_file(), "the preview itself must still typeset: {}", run.text);
        assert!(!pwned.exists(), "\\write18 ran through a preview");

        // An `\openout` aimed outside the scratch dir is refused (TeX makes that
        // fatal, so this preview fails — the right answer for such a preamble).
        fs::write(
            &tex,
            format!(
                "\\documentclass{{article}}\\immediate\\openout5={}\n\
                 \\immediate\\write5{{x}}\\immediate\\closeout5\n\
                 \\begin{{document}}x\\end{{document}}\n",
                escaped.display()
            ),
        )
        .unwrap();
        let _ = run_in_within_env(&doc, eng, &args, PREVIEW_TIMEOUT, &preview_env());
        assert!(!escaped.exists(), "\\openout wrote outside the preview's output dir");
    }

    #[test]
    fn an_oversized_snippet_is_refused_rather_than_typeset() {
        let big = "x".repeat(MAX_PREVIEW_BODY + 1);
        let err = preview_snippet_blocking(".".into(), String::new(), big, None).unwrap_err();
        assert!(err.contains("too large"), "{err}");
        let err = preview_snippet_blocking(".".into(), String::new(), "  \n ".into(), None)
            .unwrap_err();
        assert!(err.contains("empty"), "{err}");
    }

    #[test]
    fn stale_scratch_dirs_are_swept_and_fresh_ones_kept() {
        let root = std::env::temp_dir().join(format!(concat!(crate::app_slug!(), "-prevsweep-{}"), std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("run-1")).unwrap();
        fs::write(root.join("stray.txt"), b"x").unwrap();

        // "Now" as of creation: nothing is old enough to sweep.
        sweep_preview_scratch(&root, std::time::SystemTime::now());
        assert!(root.join("run-1").exists());

        // An hour and a bit later, the same dir is a leftover from a crashed run.
        let later = std::time::SystemTime::now()
            + PREVIEW_SCRATCH_MAX_AGE
            + std::time::Duration::from_secs(60);
        sweep_preview_scratch(&root, later);
        assert!(!root.join("run-1").exists());
        // Only directories are ours to remove.
        assert!(root.join("stray.txt").exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn the_scratch_sweep_spares_the_format_cache() {
        let root = std::env::temp_dir().join(format!(concat!(crate::app_slug!(), "-fmtspare-{}"), std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("fmt")).unwrap();
        fs::write(root.join("fmt").join("k.fmt"), b"x").unwrap();
        // Way past the scratch age: a run dir this old would be swept, but the
        // format cache is supposed to outlive the run that built it.
        let later = std::time::SystemTime::now()
            + PREVIEW_SCRATCH_MAX_AGE
            + std::time::Duration::from_secs(60);
        sweep_preview_scratch(&root, later);
        assert!(root.join("fmt").join("k.fmt").exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_format_key_names_the_dumped_head_and_nothing_else() {
        let a = preview_document("\\documentclass{article}\n\\usepackage{amsmath}", "$x$");
        let b = preview_document("\\documentclass{article}\n\\usepackage{amsmath}", "$y+z$");
        // Two snippets under one preamble share a format…
        assert_eq!(preview_fmt_key("pdflatex", &a), preview_fmt_key("pdflatex", &b));
        // …a changed preamble does not, and neither does a changed engine.
        let c = preview_document("\\documentclass{article}\n\\usepackage{amssymb}", "$x$");
        assert_ne!(preview_fmt_key("pdflatex", &a), preview_fmt_key("pdflatex", &c));
        assert_ne!(preview_fmt_key("pdflatex", &a), preview_fmt_key("xelatex", &a));
        // A float's wrapper head carries the `floats` preview option, so it gets
        // its own format rather than sharing (and mis-loading) the formula one.
        let f = preview_document(
            "\\documentclass{article}\n\\usepackage{amsmath}",
            "\\begin{figure}x\\end{figure}",
        );
        assert_ne!(preview_fmt_key("pdflatex", &a), preview_fmt_key("pdflatex", &f));
    }

    #[test]
    fn a_dead_format_is_told_apart_from_a_broken_snippet() {
        // The two shapes pdfTeX actually prints for a bad dump…
        assert!(preview_log_is_format_error("(Fatal format file error; I'm stymied)"));
        assert!(preview_log_is_format_error(
            "---! /x/k.fmt was made by different (pdf)tex version"
        ));
        // …and a snippet's own failure, which must NOT trigger a second run.
        assert!(!preview_log_is_format_error(
            "! File ended while scanning use of \\frac.\n!  ==> Fatal error occurred, no output PDF file produced!"
        ));
    }

    #[test]
    fn old_and_surplus_formats_are_swept_oldest_first() {
        let root = std::env::temp_dir().join(format!(concat!(crate::app_slug!(), "-fmtsweep-{}"), std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let now = std::time::SystemTime::now();
        // One over the cap, with strictly increasing mtimes so "oldest" is
        // well-defined even on a coarse-mtime filesystem.
        for i in 0..=PREVIEW_FMT_MAX {
            let p = root.join(format!("k{i}.fmt"));
            fs::write(&p, b"x").unwrap();
            let f = fs::File::options().append(true).open(&p).unwrap();
            f.set_modified(now - std::time::Duration::from_secs(600 - i as u64))
                .unwrap();
        }
        sweep_preview_fmts(&root, now);
        assert!(!root.join("k0.fmt").exists(), "the oldest goes");
        assert!(root.join(format!("k{PREVIEW_FMT_MAX}.fmt")).exists());
        assert_eq!(fs::read_dir(&root).unwrap().count(), PREVIEW_FMT_MAX);

        // Past the age bound everything goes, `.bad` markers included — that is
        // what re-arms a preamble whose build failed transiently.
        fs::write(root.join("k1.bad"), b"").unwrap();
        let later = now + PREVIEW_FMT_MAX_AGE + std::time::Duration::from_secs(60);
        sweep_preview_fmts(&root, later);
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn font_names_are_readable_in_a_picker() {
        assert_eq!(
            font_display_name("LiberationSerif-BoldItalic"),
            "Liberation Serif Bold Italic"
        );
        assert_eq!(font_display_name("DejaVuSans"), "Deja Vu Sans");
        assert_eq!(font_display_name("lmroman10-regular"), "lmroman10 regular");
        // A run of capitals is an acronym, not words: don't shatter it.
        assert_eq!(font_display_name("NIMBUSSans"), "NIMBUSSans");
        assert_eq!(font_display_name("Some__Font  Name"), "Some Font Name");
    }

    #[test]
    fn only_embeddable_font_formats_are_offered() {
        // A format fontkit cannot embed must not reach the picker: offering it
        // and failing at export is the worst of both.
        let dir = std::env::temp_dir().join(format!(concat!(crate::app_slug!(), "-fonts-{}"), std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("nested")).unwrap();
        for name in ["Good.ttf", "Also.OTF", "Bitmap.pcf", "Notes.txt"] {
            fs::write(dir.join(name), b"x").unwrap();
        }
        fs::write(dir.join("nested/Deep.woff2"), b"x").unwrap();

        let mut out = Vec::new();
        collect_fonts(&dir, 0, &mut out);
        let mut names: Vec<&str> = out.iter().map(|f| f.name.as_str()).collect();
        names.sort_unstable();
        assert_eq!(names, vec!["Also", "Deep", "Good"]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_font_directory_is_not_an_error() {
        let mut out = Vec::new();
        collect_fonts(Path::new("/definitely/not/here"), 0, &mut out);
        assert!(out.is_empty());
    }

    #[test]
    fn synctex_pages_harvest_the_main_file_s_lines() {
        let tag = main_input_tag(SYNCTEX, "main");
        assert_eq!(tag, Some(1));
        let pages = parse_synctex_pages(SYNCTEX, tag);
        assert_eq!(
            pages,
            vec![
                PageLines {
                    page: 1,
                    lines: vec![12, 14, 15]
                },
                PageLines {
                    page: 2,
                    lines: vec![12, 15, 18]
                },
            ]
        );
        // The package's own tag is excluded: line numbers from two files are not
        // comparable, so mixing them would be an anchor that means nothing.
        assert!(!pages[0].lines.contains(&99));
    }

    #[test]
    fn overlay_pages_share_a_first_line() {
        // Both pages of the frame report 12 as their lowest line. That is not a
        // bug to fix here — it is the fact `reconcile` matches *within* the group
        // for, so the k-th slide on line L takes the k-th page L produced.
        let pages = parse_synctex_pages(SYNCTEX, Some(1));
        assert_eq!(pages[0].lines.first(), Some(&12));
        assert_eq!(pages[1].lines.first(), Some(&12));
    }

    #[test]
    fn a_map_with_no_matching_input_yields_no_lines() {
        // A deck whose frames live in an `\input`ed file records nothing rather
        // than an anchor built from another file's line numbering.
        assert_eq!(main_input_tag(SYNCTEX, "chapter"), None);
        let pages = parse_synctex_pages(SYNCTEX, Some(7));
        assert_eq!(pages.len(), 2);
        assert!(pages.iter().all(|p| p.lines.is_empty()));
    }

    #[test]
    fn postamble_lines_are_not_mistaken_for_records() {
        // `Count:2` sits outside any page and must not become line data.
        let pages = parse_synctex_pages(SYNCTEX, None);
        assert_eq!(pages.len(), 2);
    }

    // A latexmk failure whose cause is configuration, not the document: no `!`
    // line, no `file:line:` location — only latexmk's own complaint.
    const CONFIG_FAILURE_LOG: &str = concat!(
        "This is pdfTeX, Version 3.141592653\n",
        "Latexmk: applying rule 'pdflatex'...\n",
        "Output written on main.pdf (12 pages, 214830 bytes).\n",
        "Latexmk: Summary of warnings from last run of *latex:\n",
        "  Latex failed to resolve 2 reference(s)\n",
        "Latexmk: Some warnings have been treated as errors.\n",
        "Collected error summary (may duplicate other messages):\n",
        "  pdflatex: Warnings treated as errors\n",
        "      Refer to 'main.log' for details\n",
        "Latexmk: Use the -f option to force complete processing,\n",
        " unless error was exceeding maximum runs, or warnings treated as errors.\n",
    );

    #[test]
    fn config_failure_is_not_a_tex_error() {
        assert!(
            !log_has_tex_error(CONFIG_FAILURE_LOG),
            "a latexmk config complaint must not read as an engine error",
        );
    }

    #[test]
    fn document_errors_are_tex_errors() {
        assert!(log_has_tex_error("./main.tex:12: Undefined control sequence.\n"));
        assert!(log_has_tex_error("! LaTeX Error: File `foo.sty' not found.\n"));
        assert!(log_has_tex_error("! Emergency stop.\n"));
        // Progress chatter must not trip it: no `:<digits>: ` run anywhere.
        assert!(!log_has_tex_error("Latexmk: Run number 1 of rule 'pdflatex'\n"));
        assert!(!log_has_tex_error("Output written on main.pdf (12 pages).\n"));
    }

    #[test]
    fn latexmk_summary_names_the_cause_not_the_advisory() {
        let note = latexmk_summary(CONFIG_FAILURE_LOG).expect("a summary");
        assert!(
            note.contains("Warnings treated as errors"),
            "the collected summary must survive: {note}",
        );
        assert!(
            !note.contains("Use the -f option"),
            "the trailing advisory is not a reason: {note}",
        );
        assert!(
            !note.contains("Refer to "),
            "the log pointer is not a reason: {note}",
        );
        assert!(
            !note.contains("applying rule"),
            "progress chatter is not a reason: {note}",
        );
    }

    #[test]
    fn a_clean_exit_is_judged_by_the_pdf_alone() {
        // An up-to-date no-op writes nothing and is still a success.
        assert!(build_succeeded(true, true, false, false));
        // A clean exit with no PDF at all is not.
        assert!(!build_succeeded(true, false, false, false));
    }

    #[test]
    fn a_failed_exit_needs_a_fresh_pdf_and_no_engine_error() {
        // The forgiven case: latexmk unhappy, engine silent, PDF newly written.
        assert!(build_succeeded(false, true, true, false));
        // An earlier build's PDF must never be passed off as this build's.
        assert!(!build_succeeded(false, true, false, false));
        // A document that genuinely failed to typeset stays a failure, however
        // much of a PDF the engine managed to emit.
        assert!(!build_succeeded(false, true, true, true));
    }

    #[test]
    fn latexmk_summary_is_none_without_a_complaint() {
        let clean = concat!(
            "Latexmk: This is Latexmk, John Collins\n",
            "Latexmk: Nothing to do for 'main.tex'.\n",
            "Latexmk: All targets (main.pdf) are up-to-date\n",
        );
        assert_eq!(latexmk_summary(clean), None);
    }

    #[test]
    fn latexmk_flag_maps_engines() {
        assert_eq!(latexmk_flag(Some("lualatex")), "-pdflua");
        assert_eq!(latexmk_flag(Some("xelatex")), "-pdfxe");
        assert_eq!(latexmk_flag(Some("pdflatex")), "-pdf");
        assert_eq!(latexmk_flag(None), "-pdf");
    }

    fn hint(src: &str) -> Option<EngineHint> {
        detect_engine_hint(src, Path::new("/nonexistent-tex-dir"))
    }

    #[test]
    fn engine_hint_reads_magic_comments() {
        assert_eq!(hint("% !TEX program = lualatex\n\\documentclass{article}"), Some(EngineHint::Named("lualatex")));
        assert_eq!(hint("%!TeX TS-program = xelatex\n"), Some(EngineHint::Named("xelatex")));
        assert_eq!(hint("% !TEX TS-program: pdflatex\n\\usepackage{fontspec}"), Some(EngineHint::Named("pdflatex")));
        assert_eq!(hint("% arara: xelatex: { shell: false }\n"), Some(EngineHint::Named("xelatex")));
        // `!TEX root` is the build root, not an engine; an unknown program is no hint.
        assert_eq!(hint("% !TEX root = main.tex\n"), None);
        assert_eq!(hint("% !TEX program = context\n"), None);
    }

    #[test]
    fn engine_hint_reads_packages_and_primitives() {
        let doc = |pre: &str| format!("\\documentclass{{article}}\n{pre}\n\\begin{{document}}x\\end{{document}}\n");
        assert_eq!(hint(&doc("\\usepackage{amsmath}")), None);
        assert_eq!(hint(&doc("\\usepackage{fontspec}\n\\setmainfont{Libertinus Serif}")), Some(EngineHint::Unicode));
        assert_eq!(hint(&doc("\\usepackage[math-style=ISO]{unicode-math}")), Some(EngineHint::Unicode));
        assert_eq!(hint(&doc("\\setmainfont{TeX Gyre Pagella}")), Some(EngineHint::Unicode));
        assert_eq!(hint(&doc("\\usepackage{amsmath, luacode}")), Some(EngineHint::Lua));
        assert_eq!(hint(&doc("\\usepackage{fontspec}\n\\directlua{tex.print(1)}")), Some(EngineHint::Lua));
        assert_eq!(hint("\\documentclass{ltjsarticle}\n"), Some(EngineHint::Lua));
        assert_eq!(hint(&doc("\\usepackage{xeCJK}\n\\usepackage{fontspec}")), Some(EngineHint::Xe));
        assert_eq!(hint(&doc("\\XeTeXinputencoding \"utf8\"")), Some(EngineHint::Xe));
        // metalogo's `\XeTeX` logo and the engine-agnostic luatex85 shim ask for nothing.
        assert_eq!(hint(&doc("\\usepackage{metalogo}\\XeTeX{} and \\LuaTeX")), None);
        assert_eq!(hint(&doc("\\usepackage{luatex85}")), None);
        // A commented-out package is no request; an escaped percent is not a comment.
        assert_eq!(hint(&doc("%\\usepackage{fontspec}\n50\\% \\usepackage{luacode}")), Some(EngineHint::Lua));
        assert_eq!(hint(&doc("% \\usepackage{fontspec}")), None);
    }

    #[test]
    fn engine_hint_follows_local_preamble_files() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join("preamble.tex"), "\\usepackage{mystyle}\n").unwrap();
        fs::write(tmp.path().join("mystyle.sty"), "\\RequirePackage{fontspec}\n").unwrap();
        let main = "\\documentclass{article}\n\\input{preamble}\n\\begin{document}\\end{document}\n";
        assert_eq!(detect_engine_hint(main, tmp.path()), Some(EngineHint::Unicode));
    }

    #[test]
    fn engine_for_hint_picks_an_installed_engine() {
        let all: Vec<String> = ENGINES.iter().map(|e| e.to_string()).collect();
        let only = |e: &[&str]| e.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(engine_for_hint(None, &all), None);
        assert_eq!(engine_for_hint(Some(EngineHint::Unicode), &all).as_deref(), Some("lualatex"));
        assert_eq!(engine_for_hint(Some(EngineHint::Unicode), &only(&["pdflatex", "xelatex"])).as_deref(), Some("xelatex"));
        assert_eq!(engine_for_hint(Some(EngineHint::Xe), &all).as_deref(), Some("xelatex"));
        // An engine-only document never lands on the other Unicode engine.
        assert_eq!(engine_for_hint(Some(EngineHint::Xe), &only(&["pdflatex", "lualatex"])), None);
        assert_eq!(engine_for_hint(Some(EngineHint::Named("lualatex")), &only(&["pdflatex"])), None);
    }

    #[test]
    fn auto_engine_falls_back_to_the_first_installed() {
        let tmp = tempfile::tempdir().unwrap();
        let plain = tmp.path().join("plain.tex");
        let lua = tmp.path().join("lua.tex");
        fs::write(&plain, "\\documentclass{article}\n").unwrap();
        fs::write(&lua, "\\documentclass{article}\n\\usepackage{fontspec}\n").unwrap();
        let installed: Vec<String> = ENGINES.iter().map(|e| e.to_string()).collect();
        assert_eq!(auto_engine(&plain, &installed).as_deref(), Some("pdflatex"));
        assert_eq!(auto_engine(&lua, &installed).as_deref(), Some("lualatex"));
        assert_eq!(auto_engine(&lua, &[]), None);
    }

    #[test]
    fn compile_args_never_enable_shell_escape() {
        // Compiling an untrusted `.tex` must never run the engine with
        // shell-escape / write18 enabled — that would let document macros
        // execute arbitrary shell commands. Guard the actual arg builders used
        // by `compile_tex` (its single source of truth) across every engine.
        let no_extra: Vec<String> = vec![];
        for engine in [None, Some("pdflatex"), Some("lualatex"), Some("xelatex")] {
            for fmt in [None, Some("doc-pdflatex-0a-12")] {
                let args = latexmk_args(engine, "doc.tex", None, &no_extra, fmt);
                assert!(
                    !args.iter().any(|a| flag_enables_shell_escape(a)),
                    "latexmk args for {engine:?} enable shell-escape: {args:?}",
                );
            }
        }

        let direct = engine_args("doc.tex", None, &no_extra);
        assert!(
            !direct.iter().any(|a| flag_enables_shell_escape(a)),
            "direct engine args enable shell-escape: {direct:?}",
        );

        // #867: both builders turn it off outright rather than trust the
        // distribution's default — last, after the user's (filtered) flags,
        // and with the file name still the final argument.
        let extra = vec!["-synctex=0".to_string()];
        let mk = latexmk_args(None, "doc.tex", Some("build"), &extra, Some("doc-pdflatex-0a-12"));
        let direct = engine_args("doc.tex", Some("build"), &extra);
        for args in [&mk, &direct] {
            assert_eq!(args[args.len() - 2..], [NO_SHELL_ESCAPE, "doc.tex"], "{args:?}");
        }
        assert!(!flag_enables_shell_escape("-no-shell-escape"));
        assert!(!flag_enables_shell_escape("--disable-write18"));
    }

    #[test]
    fn filter_extra_flags_strips_shell_escape() {
        // User-supplied extra flags must never smuggle in shell-escape, in any
        // of its spellings. Benign flags pass through unchanged.
        let input: Vec<String> = vec![
            "-shell-escape".into(),
            "--shell-escape".into(),
            "-enable-write18".into(),
            "-shell-escape=1".into(),
            "-synctex=1".into(),
            "-file-line-error".into(),
        ];
        let kept = filter_extra_flags(&input);
        assert!(
            !kept.iter().any(|f| flag_enables_shell_escape(f)),
            "filtered flags still enable shell-escape: {kept:?}",
        );
        assert!(kept.contains(&"-synctex=1".to_string()));
        assert!(kept.contains(&"-file-line-error".to_string()));
        assert_eq!(kept.len(), 2, "only the two benign flags survive: {kept:?}");

        // And the filtered flags, when fed into the arg builders, keep the
        // shell-escape invariant — even alongside the benign ones.
        let args = latexmk_args(None, "doc.tex", Some("build"), &kept, None);
        assert!(!args.iter().any(|a| flag_enables_shell_escape(a)));
    }

    #[test]
    fn out_dir_maps_to_correct_engine_args() {
        let no_extra: Vec<String> = vec![];
        // latexmk uses -outdir; the engine uses -output-directory.
        let mk = latexmk_args(None, "doc.tex", Some("/tmp/out"), &no_extra, None);
        assert!(
            mk.iter().any(|a| a == "-outdir=/tmp/out"),
            "latexmk should set -outdir: {mk:?}",
        );
        let eng = engine_args("doc.tex", Some("/tmp/out"), &no_extra);
        assert!(
            eng.iter().any(|a| a == "-output-directory=/tmp/out"),
            "engine should set -output-directory: {eng:?}",
        );
        // No out_dir → neither flag appears.
        let mk2 = latexmk_args(None, "doc.tex", None, &no_extra, None);
        assert!(!mk2.iter().any(|a| a.contains("outdir")));
    }

    #[test]
    fn log_shows_shell_escape_distinguishes_restricted() {
        // The safe default (restricted) must NOT trip the warning.
        assert!(!log_shows_shell_escape(
            "This is pdfTeX...\n restricted \\write18 enabled.\n"
        ));
        // Unrestricted enablement trips it.
        assert!(log_shows_shell_escape(
            "This is pdfTeX...\n \\write18 enabled.\n"
        ));
        // An actually-executed external command trips it.
        assert!(log_shows_shell_escape(
            "runsystem(rm -rf /tmp/x)...executed.\n"
        ));
        // A clean build does not.
        assert!(!log_shows_shell_escape(
            "Output written on doc.pdf (1 page).\n"
        ));
    }

    #[test]
    fn aux_needs_bibtex_detects_citations() {
        let dir = std::env::temp_dir().join(format!(concat!(crate::app_slug!(), "-tex-{}"), std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let aux = dir.join("doc.aux");

        fs::write(&aux, "\\relax\n\\citation{knuth}\n").unwrap();
        assert!(aux_needs_bibtex(&aux));

        fs::write(&aux, "\\relax\n").unwrap();
        assert!(!aux_needs_bibtex(&aux));

        // Missing aux → no bibtex pass.
        assert!(!aux_needs_bibtex(&dir.join("missing.aux")));

        let _ = fs::remove_dir_all(&dir);
    }

    /// The compile environment must keep TeX from hard-wrapping its log at 79
    /// columns. That wrapping breaks a source path across two lines, and the
    /// `(file … )` nesting is the ONLY thing that says which file a *warning*
    /// came from (`-file-line-error` covers errors and nothing else) — so
    /// dropping these silently makes every warning in a multi-file document
    /// unplaceable in the viewer, with nothing failing. A tripwire over this
    /// file's own source, the shape `mail.rs`'s path check already uses.
    #[test]
    fn compile_env_disables_log_line_wrapping() {
        let src = include_str!("tex.rs");
        for var in ["max_print_line", "error_line", "half_error_line"] {
            assert!(
                src.contains(&format!("\"{var}\"")),
                "run_in must set {var} so the log's (file …) nesting stays readable",
            );
        }
    }

    #[test]
    fn tail_truncates_to_char_boundary() {
        let short = "ok";
        assert_eq!(tail(short), short);

        let long = "é".repeat(10_000); // multi-byte, > MAX
        let out = tail(&long);
        assert!(out.starts_with("…\n"));
        // The truncated remainder must itself be valid UTF-8 (no split char).
        assert!(out.is_char_boundary(out.len()));
    }

    #[test]
    fn compile_tex_rejects_non_tex() {
        let dir = std::env::temp_dir().join(format!(concat!(crate::app_slug!(), "-tex-nt-{}"), std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let txt = dir.join("notes.txt");
        fs::write(&txt, "hi").unwrap();
        // The blocking body, not the async command wrapper: the rejection is the
        // body's, and testing it here keeps this a plain synchronous test.
        let err =
            compile_tex_blocking(txt.to_string_lossy().into_owned(), None, None, None).unwrap_err();
        assert!(err.contains("not a .tex file"), "got: {err}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn arg_builders_always_emit_synctex() {
        let no_extra: Vec<String> = vec![];
        let mk = latexmk_args(None, "doc.tex", None, &no_extra, None);
        assert!(mk.iter().any(|a| a == "-synctex=1"), "latexmk: {mk:?}");
        let eng = engine_args("doc.tex", None, &no_extra);
        assert!(eng.iter().any(|a| a == "-synctex=1"), "engine: {eng:?}");
    }

    #[test]
    fn arg_builders_always_emit_file_line_error() {
        // `-file-line-error` makes the engine print `file:line: message`, which the
        // viewer parses for jump-to-error. Both build paths must request it.
        let no_extra: Vec<String> = vec![];
        let mk = latexmk_args(None, "doc.tex", None, &no_extra, None);
        assert!(
            mk.iter().any(|a| a == "-file-line-error"),
            "latexmk: {mk:?}"
        );
        let eng = engine_args("doc.tex", None, &no_extra);
        assert!(
            eng.iter().any(|a| a == "-file-line-error"),
            "engine: {eng:?}"
        );
    }

    #[test]
    fn parse_synctex_edit_extracts_source() {
        // Real `synctex edit` output: `Output:` is the PDF, `Input:` is the source.
        let out = "SyncTeX result begin\nOutput:doc.pdf\nInput:chapter.tex\nLine:42\nColumn:-1\nSyncTeX result end\n";
        let base = std::env::temp_dir();
        let s = parse_synctex_edit(out, &base).expect("a source");
        assert!(s.input.ends_with("chapter.tex"), "input: {}", s.input);
        assert_eq!(s.line, 42);
        // Column:-1 (no column) clamps to 0.
        assert_eq!(s.column, 0);
    }

    #[test]
    fn parse_synctex_edit_none_without_input() {
        // No Input:/Line: block → no answer. An Output:-only block (just the PDF
        // name, no source) must not be mistaken for a source location.
        assert!(
            parse_synctex_edit("SyncTeX result begin\nSyncTeX result end\n", Path::new("/"))
                .is_none()
        );
        assert!(parse_synctex_edit(
            "SyncTeX result begin\nOutput:doc.pdf\nSyncTeX result end\n",
            Path::new("/")
        )
        .is_none());
    }

    #[test]
    fn parse_synctex_view_extracts_rect() {
        let out = "SyncTeX result begin\nPage:3\nx:120.0\ny:560.0\nh:121.5\nv:559.0\nW:380.25\nH:12.0\nSyncTeX result end\n";
        let recs = parse_synctex_view(out);
        assert_eq!(recs.len(), 1);
        let r = &recs[0];
        assert_eq!(r.page, 3);
        assert_eq!(r.x, 121.5);
        // `v` (559.0) is the box bottom; the top edge is one box-height (H) above.
        assert_eq!(r.y, 559.0 - 12.0);
        assert_eq!(r.w, 380.25);
        assert_eq!(r.h, 12.0);
    }

    #[test]
    fn parse_synctex_view_extracts_all_records() {
        // A wrapped source line emits one record per visual row; every `Page:`
        // starts a new block. The frontend picks the row matching the column.
        let out = "SyncTeX result begin\n\
                   Page:1\nx:100.0\ny:200.0\nh:100.0\nv:200.0\nW:300.0\nH:12.0\n\
                   Page:1\nx:72.0\ny:214.0\nh:72.0\nv:214.0\nW:150.0\nH:12.0\n\
                   SyncTeX result end\n";
        let recs = parse_synctex_view(out);
        assert_eq!(recs.len(), 2);
        // First row.
        assert_eq!(recs[0].x, 100.0);
        assert_eq!(recs[0].y, 200.0 - 12.0);
        assert_eq!(recs[0].w, 300.0);
        // Second (wrapped) row, lower on the page.
        assert_eq!(recs[1].x, 72.0);
        assert_eq!(recs[1].y, 214.0 - 12.0);
        assert_eq!(recs[1].w, 150.0);
    }

    #[test]
    fn parse_synctex_view_empty_without_records() {
        // No node blocks → no rects (so the command yields an empty list).
        assert!(parse_synctex_view("SyncTeX result begin\nSyncTeX result end\n").is_empty());
        // An incomplete trailing block (no `v`) is dropped, not half-emitted.
        assert!(parse_synctex_view("Page:1\nx:1.0\nh:1.0\n").is_empty());
    }

    #[test]
    fn parse_includes_finds_tex_children() {
        let src = "\\documentclass{article}\n\\begin{document}\n\\input{intro}\n\\include{chapters/two.tex}\n\\includegraphics{fig.png}\n\\end{document}\n";
        let inc = parse_includes(src);
        assert_eq!(
            inc,
            vec!["intro.tex".to_string(), "chapters/two.tex".to_string()]
        );
    }

    #[test]
    fn scan_tex_includes_recurses() {
        let dir = std::env::temp_dir().join(format!(concat!(crate::app_slug!(), "-tex-scan-{}"), std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("chapters")).unwrap();
        let root = dir.join("main.tex");
        fs::write(&root, "\\input{chapters/one}\n").unwrap();
        fs::write(dir.join("chapters/one.tex"), "\\input{../two}\n").unwrap();
        fs::write(dir.join("two.tex"), "no includes\n").unwrap();

        let found = scan_tex_includes(&root);
        let names: std::collections::HashSet<String> = found
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert!(names.contains("one.tex"), "got: {names:?}");
        assert!(names.contains("two.tex"), "got: {names:?}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn magic_root_reads_tex_root_comment() {
        let dir = std::env::temp_dir();
        let root = magic_root(
            "% !TEX root = ../main.tex\n\\section{x}\n",
            Path::new("/proj/chapters"),
        );
        assert!(root.is_some());
        assert!(root.unwrap().to_string_lossy().ends_with("main.tex"));
        // Case-insensitive and colon form.
        assert!(magic_root("%!tex root: book.tex\n", &dir).is_some());
        // No magic comment → None.
        assert!(magic_root("\\documentclass{article}\n", &dir).is_none());
    }

    #[test]
    fn resolve_tex_root_prefers_magic_comment() {
        let dir = std::env::temp_dir().join(format!(concat!(crate::app_slug!(), "-tex-root-{}"), std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let main = dir.join("main.tex");
        fs::write(&main, "\\input{child}\n").unwrap();
        let child = dir.join("child.tex");
        let main_disp = fs::canonicalize(&main).unwrap();
        fs::write(
            &child,
            format!("% !TEX root = {}\n\\section{{x}}\n", main_disp.display()),
        )
        .unwrap();

        let resolved = resolve_tex_root(child.to_string_lossy().into_owned()).unwrap();
        assert_eq!(resolved, main_disp.to_string_lossy());

        // A file that is its own root resolves to itself.
        let solo = resolve_tex_root(main.to_string_lossy().into_owned()).unwrap();
        assert_eq!(solo, main_disp.to_string_lossy());
        let _ = fs::remove_dir_all(&dir);
    }

    // ── Cached document preambles (full compiles) ───────────────────────────

    #[test]
    fn a_doc_head_needs_a_body_marker() {
        assert_eq!(
            doc_preamble_head("\\documentclass{a}\n\\begin{document}x\\end{document}"),
            Some("\\documentclass{a}\n")
        );
        // A fragment has nothing to split at, so nothing to dump.
        assert_eq!(doc_preamble_head("\\section{x}\n"), None);
    }

    #[test]
    fn preamble_deps_name_local_candidates() {
        let head = "\\documentclass[12pt]{myclass}\n\
                    \\usepackage{amsmath, mystyle}\n\
                    \\usepackage[utf8]{inputenc}\n\
                    \\RequirePackage{other}\n\
                    \\input{macros}\n\
                    \\input{defs.tex}\n";
        let deps = preamble_local_dep_names(head);
        assert_eq!(
            deps,
            vec![
                "myclass.cls",
                "amsmath.sty",
                "mystyle.sty",
                "inputenc.sty",
                "other.sty",
                "macros.tex",
                "defs.tex",
            ]
        );
    }

    #[test]
    fn a_doc_format_key_tracks_the_preamble_and_its_local_files() {
        let dir = std::env::temp_dir().join(format!(concat!(crate::app_slug!(), "-docfmt-{}"), std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("macros.tex"), "\\newcommand{\\R}{\\mathbb{R}}\n").unwrap();

        let head = "\\documentclass{article}\n\\input{macros}\n";
        let a = doc_fmt_key("pdflatex", head, &dir);
        // Stable while nothing changed.
        assert_eq!(a, doc_fmt_key("pdflatex", head, &dir));
        // A changed preamble mints a new key…
        assert_ne!(
            a,
            doc_fmt_key("pdflatex", "\\documentclass{book}\n\\input{macros}\n", &dir)
        );
        // …and so does editing a local file the preamble reads: a dump rendered
        // against stale macros would be a wrong PDF, not a wrong hover card.
        fs::write(dir.join("macros.tex"), "\\newcommand{\\R}{\\mathbb{C}}\n").unwrap();
        assert_ne!(a, doc_fmt_key("pdflatex", head, &dir));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_latexmk_fmt_override_keeps_every_invariant() {
        let no_extra: Vec<String> = vec![];
        let args = latexmk_args(None, "doc.tex", None, &no_extra, Some("doc-pdflatex-0a-12"));
        // The override names the key, never a path (latexmk re-splits this
        // string on whitespace; the directory travels via TEXFORMATS), and
        // stands before user extras so a user's own -pdflatex wins.
        assert!(args
            .iter()
            .any(|a| a == "-pdflatex=pdflatex -fmt=doc-pdflatex-0a-12 %O %S"));
        assert!(!args.iter().any(|a| flag_enables_shell_escape(a)));
        // Without a key the args are exactly the old ones.
        assert!(!latexmk_args(None, "doc.tex", None, &no_extra, None)
            .iter()
            .any(|a| a.starts_with("-pdflatex=")));
    }

    #[test]
    fn a_compile_format_error_includes_the_not_found_shape() {
        // Everything the preview treats as a dead dump…
        assert!(compile_log_is_format_error(
            "(Fatal format file error; I'm stymied)"
        ));
        // …plus the shape only the full compile can hit: an engine that ignores
        // TEXFORMATS never finds the key at all.
        assert!(compile_log_is_format_error(
            "I can't find the format file `doc-pdflatex-0a-12.fmt'!"
        ));
        // A document's own error must NOT earn a second full run — that would
        // double every typo's feedback loop.
        assert!(!compile_log_is_format_error("! Undefined control sequence."));
    }

    #[test]
    fn texformats_ends_with_the_default_slot() {
        // The trailing separator is kpathsea's "insert the default path here";
        // without it the engine would find OUR formats and nothing else.
        let sep = if cfg!(windows) { ';' } else { ':' };
        assert!(texformats_search_path().ends_with(sep));
    }
}
