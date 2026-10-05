//! Ask-once approval for project-supplied programs Tabtivity would run on the host.
//!
//! Three things Tabtivity runs at a click execute code that lives in the project
//! tree — a tree a fenced agent, a container tab, a `git pull` or whoever sent
//! the repo can write:
//!
//! - **git hooks** (and the repo-scope config keys that name programs) on
//!   Commit / Push / Reword / Publish,
//! - a **`latexmkrc`** (Perl) on Build,
//! - the project's own **prettier** (its `node_modules` copy, a JS config, a
//!   config that loads plugins, or one naming a shared config) on Format.
//!
//! Each gate collects the exact files that would run, fingerprints them
//! (SHA-256 over sorted label + content), and compares against the approval
//! stored for that (kind, directory) in `<state_dir>/exec_trust.json` — outside
//! every fence and container. No match → the command fails with a
//! [`TRUST_REQUIRED_PREFIX`] error carrying a [`TrustRequest`]; the frontend
//! shows what would run and, on approval, calls `exec_trust_approve`, which
//! re-collects and stores the fingerprint only if nothing changed in between.
//! Any later change to those files asks again.
//!
//! A project with none of these (no hooks, no rc, no local prettier) never
//! prompts. Residuals, stated rather than hidden: there is a window between the
//! check and the tool reading the file, and an approved hook/config that runs
//! *other* project code (a test suite, a helper it `require`s) runs whatever
//! that code is at the time — the same as the Run button.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::storage;

/// Prefix of the error string a gated command returns; JSON follows.
pub const TRUST_REQUIRED_PREFIX: &str = crate::brand::TRUST_REQUIRED_PREFIX;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrustKind {
    GitHooks,
    Latexmkrc,
    Prettier,
}

impl TrustKind {
    pub fn id(self) -> &'static str {
        match self {
            TrustKind::GitHooks => "git_hooks",
            TrustKind::Latexmkrc => "latexmkrc",
            TrustKind::Prettier => "prettier",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "git_hooks" => Some(TrustKind::GitHooks),
            "latexmkrc" => Some(TrustKind::Latexmkrc),
            "prettier" => Some(TrustKind::Prettier),
            _ => None,
        }
    }
}

/// One thing that would run: a file's content, a config entry's value, or a
/// whole package tree already reduced to a digest.
pub struct Subject {
    pub label: String,
    pub bytes: Vec<u8>,
    /// Shown to the user; false for digests, where the bytes mean nothing.
    pub preview: bool,
}

impl Subject {
    fn file(path: &Path) -> Option<Subject> {
        let bytes = std::fs::read(path).ok()?;
        Some(Subject {
            label: path.to_string_lossy().into_owned(),
            bytes,
            preview: true,
        })
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustItem {
    pub label: String,
    pub preview: String,
    pub truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustRequest {
    pub kind: String,
    pub dir: String,
    pub fingerprint: String,
    /// An approval existed and the files changed since.
    pub changed: bool,
    pub items: Vec<TrustItem>,
}

const PREVIEW_BYTES: usize = 4096;
const PREVIEW_LINES: usize = 60;
const MAX_ITEMS: usize = 40;

pub fn fingerprint(subjects: &[Subject]) -> String {
    let mut sorted: Vec<&Subject> = subjects.iter().collect();
    sorted.sort_by(|a, b| a.label.cmp(&b.label));
    let mut h = Sha256::new();
    for s in sorted {
        h.update((s.label.len() as u64).to_le_bytes());
        h.update(s.label.as_bytes());
        h.update((s.bytes.len() as u64).to_le_bytes());
        h.update(&s.bytes);
    }
    hex(&h.finalize())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn preview_of(s: &Subject) -> (String, bool) {
    if !s.preview {
        return (String::new(), false);
    }
    if s.bytes.contains(&0) {
        return (format!("(binary, {} bytes)", s.bytes.len()), false);
    }
    let head = &s.bytes[..s.bytes.len().min(PREVIEW_BYTES)];
    let text = String::from_utf8_lossy(head);
    let mut lines: Vec<&str> = text.lines().collect();
    let mut truncated = s.bytes.len() > PREVIEW_BYTES;
    if lines.len() > PREVIEW_LINES {
        lines.truncate(PREVIEW_LINES);
        truncated = true;
    }
    (lines.join("\n"), truncated)
}

fn store_path() -> PathBuf {
    storage::state_dir().join("exec_trust.json")
}

fn key(kind: TrustKind, dir: &Path) -> String {
    let dir = std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    format!("{}:{}", kind.id(), dir.to_string_lossy())
}

fn load(store: &Path) -> BTreeMap<String, String> {
    storage::read_json(store).unwrap_or_default()
}

/// `Ok` when there is nothing project-supplied to run, or it matches the stored
/// approval; otherwise the [`TRUST_REQUIRED_PREFIX`] error.
pub fn require(kind: TrustKind, dir: &Path) -> Result<(), String> {
    require_in(&store_path(), kind, dir, collect(kind, dir))
}

fn require_in(
    store: &Path,
    kind: TrustKind,
    dir: &Path,
    subjects: Vec<Subject>,
) -> Result<(), String> {
    if subjects.is_empty() {
        return Ok(());
    }
    let fp = fingerprint(&subjects);
    let approvals = load(store);
    let previous = approvals.get(&key(kind, dir));
    if previous == Some(&fp) {
        return Ok(());
    }
    let mut items: Vec<TrustItem> = subjects
        .iter()
        .take(MAX_ITEMS)
        .map(|s| {
            let (preview, truncated) = preview_of(s);
            TrustItem { label: s.label.clone(), preview, truncated }
        })
        .collect();
    if subjects.len() > MAX_ITEMS {
        items.push(TrustItem {
            label: format!("… {} more", subjects.len() - MAX_ITEMS),
            preview: String::new(),
            truncated: false,
        });
    }
    let request = TrustRequest {
        kind: kind.id().to_string(),
        dir: dir.to_string_lossy().into_owned(),
        fingerprint: fp,
        changed: previous.is_some(),
        items,
    };
    Err(format!(
        "{TRUST_REQUIRED_PREFIX}{}",
        serde_json::to_string(&request).map_err(|e| e.to_string())?
    ))
}

/// Record the user's approval — only if what they were shown (`expected`) is
/// still exactly what would run.
pub fn approve(kind: TrustKind, dir: &Path, expected: &str) -> Result<(), String> {
    approve_in(&store_path(), kind, dir, collect(kind, dir), expected)
}

fn approve_in(
    store: &Path,
    kind: TrustKind,
    dir: &Path,
    subjects: Vec<Subject>,
    expected: &str,
) -> Result<(), String> {
    if fingerprint(&subjects) != expected {
        return Err("These files changed after they were shown to you. Nothing was \
                    approved — run the action again to review the current version."
            .to_string());
    }
    let mut approvals = load(store);
    approvals.insert(key(kind, dir), expected.to_string());
    storage::write_json_atomic(store, &approvals).map_err(|e| e.to_string())
}

fn collect(kind: TrustKind, dir: &Path) -> Vec<Subject> {
    match kind {
        TrustKind::GitHooks => git_subjects(dir),
        TrustKind::Latexmkrc => latexmkrc_subjects(dir),
        TrustKind::Prettier => prettier_subjects(dir),
    }
}

// ── git ─────────────────────────────────────────────────────────────────────

/// Repo-scope config keys whose value is a program git runs during commit or
/// push. `filter.*`/`diff.*`/`include*` are stripped outright by
/// `commands::git`'s sanitizer and `core.fsmonitor` is pinned off, so they are
/// not listed; these stay live because users set them on purpose.
fn is_exec_config_key(key: &str) -> bool {
    let k = key.to_ascii_lowercase();
    matches!(
        k.as_str(),
        "core.hookspath"
            | "core.sshcommand"
            | "core.gitproxy"
            | "core.askpass"
            | "core.editor"
            | "sequence.editor"
            | "ssh.variant"
            | "gpg.program"
            | "credential.helper"
    ) || k.starts_with("hook.")
        || (k.starts_with("gpg.") && k.ends_with(".program"))
        || (k.starts_with("credential.") && k.ends_with(".helper"))
        || (k.starts_with("remote.") && (k.ends_with(".receivepack") || k.ends_with(".uploadpack")))
        || (k.starts_with("merge.") && k.ends_with(".driver"))
}

/// Parse `git config --list --show-scope -z`: `scope\0key\nvalue\0` records.
fn parse_scoped_config(raw: &[u8]) -> Vec<(String, String, String)> {
    let text = String::from_utf8_lossy(raw);
    let mut parts = text.split('\0');
    let mut out = Vec::new();
    while let (Some(scope), Some(entry)) = (parts.next(), parts.next()) {
        if scope.is_empty() {
            break;
        }
        let (key, value) = entry.split_once('\n').unwrap_or((entry, ""));
        out.push((scope.to_string(), key.to_string(), value.to_string()));
    }
    out
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

fn git_subjects(repo: &Path) -> Vec<Subject> {
    // The hooked variant, so the view is the one the gated verb gets: the hooks
    // pin every other call carries would make `--git-path hooks` answer `./`.
    // Neither query runs a hook.
    use crate::commands::git::{hardened_git_command_in, hooked_git_command_in};
    use crate::services::git_bounded::BoundedOutput;
    let mut out = Vec::new();
    let mut have_hook = false;
    // Bounded (#2349). A query git refused or that timed out (a FIFO it reads)
    // fails closed: it becomes a subject, so the gated verb asks rather than
    // running hooks nobody looked at.
    let unread = |what: &str, e: String| Subject {
        label: format!("git could not be read ({what})"),
        bytes: e.into_bytes(),
        preview: true,
    };

    // `--git-path hooks` honours `core.hooksPath`.
    let hooks_path = hooked_git_command_in(repo, &["rev-parse", "--git-path", "hooks"]).bounded_output();
    if let Err(e) = &hooks_path {
        out.push(unread("hooks", e.clone()));
    }
    if let Ok(o) = hooks_path {
        if o.status.success() {
            let rel = String::from_utf8_lossy(&o.stdout).trim().to_string();
            let hooks = if Path::new(&rel).is_absolute() { PathBuf::from(&rel) } else { repo.join(&rel) };
            let mut files: Vec<PathBuf> = std::fs::read_dir(&hooks)
                .map(|rd| rd.flatten().map(|e| e.path()).collect())
                .unwrap_or_default();
            files.sort();
            for f in files {
                let sample = f.extension().is_some_and(|e| e == "sample");
                if !sample && is_executable(&f) {
                    if let Some(s) = Subject::file(&f) {
                        out.push(s);
                        have_hook = true;
                    }
                }
            }
        }
    }

    let config = hooked_git_command_in(repo, &["config", "--list", "--show-scope", "-z"]).bounded_output();
    if let Err(e) = &config {
        out.push(unread("config", e.clone()));
    }
    if let Ok(o) = config {
        if o.status.success() {
            for (scope, key, value) in parse_scoped_config(&o.stdout) {
                if matches!(scope.as_str(), "local" | "worktree") && is_exec_config_key(&key) {
                    out.push(Subject {
                        label: format!("git config ({scope}): {key}"),
                        bytes: value.into_bytes(),
                        preview: true,
                    });
                }
            }
        }
    }

    // Hook managers: the hook script is a stub, the real commands live here —
    // at the top level, which `repo` (a Commit from a subfolder) need not be.
    if have_hook {
        let repo = hardened_git_command_in(repo, &["rev-parse", "--show-toplevel"])
            .bounded_output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| PathBuf::from(String::from_utf8_lossy(&o.stdout).trim()))
            .unwrap_or_else(|| repo.to_path_buf());
        for name in [".pre-commit-config.yaml", "lefthook.yml", ".lefthook.yml", "lefthook-local.yml"] {
            if let Some(s) = Subject::file(&repo.join(name)) {
                out.push(s);
            }
        }
        let husky = repo.join(".husky");
        let mut files: Vec<PathBuf> = std::fs::read_dir(&husky)
            .map(|rd| rd.flatten().map(|e| e.path()).filter(|p| p.is_file()).collect())
            .unwrap_or_default();
        files.sort();
        out.extend(files.iter().filter_map(|f| Subject::file(f)));
    }
    out
}

// ── latexmk ─────────────────────────────────────────────────────────────────

/// The rc files latexmk reads from its working directory (Perl, executed).
fn latexmkrc_subjects(dir: &Path) -> Vec<Subject> {
    ["latexmkrc", ".latexmkrc"]
        .iter()
        .filter_map(|name| Subject::file(&dir.join(name)))
        .collect()
}

// ── prettier ────────────────────────────────────────────────────────────────

const PRETTIER_CONFIGS: &[&str] = &[
    ".prettierrc",
    ".prettierrc.json",
    ".prettierrc.json5",
    ".prettierrc.yaml",
    ".prettierrc.yml",
    ".prettierrc.toml",
    ".prettierrc.js",
    ".prettierrc.cjs",
    ".prettierrc.mjs",
    ".prettierrc.ts",
    ".prettierrc.cts",
    ".prettierrc.mts",
    "prettier.config.js",
    "prettier.config.cjs",
    "prettier.config.mjs",
    "prettier.config.ts",
    "prettier.config.cts",
    "prettier.config.mts",
];

const TREE_MAX_FILES: usize = 20_000;
const TREE_MAX_BYTES: u64 = 256 * 1024 * 1024;

/// The project-local `node_modules/.bin/prettier`, walking up from `start`
/// exactly as `commands::format` resolves it.
fn local_prettier_bin(start: &Path) -> Option<PathBuf> {
    start.ancestors().find_map(|d| {
        crate::paths::resolve_executable_in_dir(&d.join("node_modules").join(".bin"), "prettier")
    })
}

/// One digest over every file under `root` (relative path + content), bounded.
fn tree_digest(root: &Path) -> Vec<u8> {
    let mut files: Vec<PathBuf> = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_dir() {
                stack.push(p);
            } else {
                files.push(p);
            }
            if files.len() >= TREE_MAX_FILES {
                break;
            }
        }
        if files.len() >= TREE_MAX_FILES {
            break;
        }
    }
    files.sort();
    let mut h = Sha256::new();
    let mut total: u64 = 0;
    for f in files {
        let rel = f.strip_prefix(root).unwrap_or(&f).to_string_lossy().into_owned();
        h.update(rel.as_bytes());
        h.update([0]);
        if total < TREE_MAX_BYTES {
            if let Ok(bytes) = std::fs::read(&f) {
                total += bytes.len() as u64;
                h.update((bytes.len() as u64).to_le_bytes());
                h.update(&bytes);
            }
        }
    }
    h.finalize().to_vec()
}

fn package_subject(dir: &Path) -> Subject {
    Subject {
        label: format!("{} (package contents)", dir.to_string_lossy()),
        bytes: tree_digest(dir),
        preview: false,
    }
}

/// Every package under `node_modules` whose name mentions prettier (the
/// formatter itself, `prettier-plugin-*`, `@scope/prettier-*`, shared configs).
fn prettier_packages(node_modules: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(node_modules) else { return out };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let p = e.path();
        if name.starts_with('@') {
            if let Ok(scoped) = std::fs::read_dir(&p) {
                for s in scoped.flatten() {
                    if s.file_name().to_string_lossy().contains("prettier") {
                        out.push(s.path());
                    }
                }
            }
        } else if name.contains("prettier") {
            out.push(p);
        }
    }
    out.sort();
    out
}

/// A config that can execute code: JS/TS, a `plugins` list, or a shared-config
/// reference — prettier `require`s a config whose whole content is a string as
/// a package, whether that is package.json's `"prettier": "@x/cfg"` or a
/// `.prettierrc` holding just `"@x/cfg"` (#866). JSON, JSON5 and YAML configs
/// are all read as YAML for that check (a JSON/JSON5 string is a YAML one);
/// TOML cannot be a bare string.
fn config_executes(name: &str, bytes: &[u8]) -> bool {
    let text = String::from_utf8_lossy(bytes);
    if name == "package.json" {
        return serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|v| v.get("prettier").cloned())
            .is_some_and(|p| p.is_string() || p.get("plugins").is_some());
    }
    let script = [".js", ".cjs", ".mjs", ".ts", ".cts", ".mts"]
        .iter()
        .any(|ext| name.ends_with(ext));
    let shared = !name.ends_with(".toml")
        && serde_yaml::from_str::<serde_yaml::Value>(&text).is_ok_and(|v| v.is_string());
    script || shared || text.contains("plugins")
}

/// The nearest directory (walking up from `start`) holding a prettier config,
/// and that config's files. `package.json` counts only with a `prettier` key.
/// A config file's name and bytes.
type ConfigFile = (String, Vec<u8>);

fn nearest_prettier_config(start: &Path) -> Option<(PathBuf, Vec<ConfigFile>)> {
    for dir in start.ancestors() {
        let mut found: Vec<ConfigFile> = PRETTIER_CONFIGS
            .iter()
            .filter_map(|n| std::fs::read(dir.join(n)).ok().map(|b| ((*n).to_string(), b)))
            .collect();
        if let Ok(pkg) = std::fs::read(dir.join("package.json")) {
            let has_key = serde_json::from_slice::<serde_json::Value>(&pkg)
                .ok()
                .is_some_and(|v| v.get("prettier").is_some());
            if has_key {
                found.push(("package.json".to_string(), pkg));
            }
        }
        if !found.is_empty() {
            return Some((dir.to_path_buf(), found));
        }
    }
    None
}

fn prettier_subjects(start: &Path) -> Vec<Subject> {
    let mut out = Vec::new();
    let mut hashed: Vec<PathBuf> = Vec::new();

    if let Some(bin) = local_prettier_bin(start) {
        // The `.bin` link's real target, then the whole package it belongs to.
        let target = std::fs::canonicalize(&bin).unwrap_or(bin.clone());
        if let Some(s) = Subject::file(&target) {
            out.push(Subject { preview: false, ..s });
        }
        if let Some(node_modules) = bin.parent().and_then(Path::parent) {
            for pkg in prettier_packages(node_modules) {
                out.push(package_subject(&pkg));
                hashed.push(pkg);
            }
        }
    }

    if let Some((dir, files)) = nearest_prettier_config(start) {
        if files.iter().any(|(n, b)| config_executes(n, b)) {
            for (name, bytes) in files {
                out.push(Subject {
                    label: dir.join(&name).to_string_lossy().into_owned(),
                    bytes,
                    preview: true,
                });
            }
            // Plugins and shared configs resolve from the nearest node_modules.
            if let Some(nm) = dir.ancestors().map(|d| d.join("node_modules")).find(|p| p.is_dir()) {
                for pkg in prettier_packages(&nm) {
                    if !hashed.contains(&pkg) {
                        out.push(package_subject(&pkg));
                    }
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn subj(label: &str, body: &str) -> Subject {
        Subject { label: label.into(), bytes: body.as_bytes().to_vec(), preview: true }
    }

    fn request_of(err: String) -> serde_json::Value {
        let json = err.strip_prefix(TRUST_REQUIRED_PREFIX).expect("trust error");
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn nothing_to_run_never_asks() {
        let tmp = tempfile::tempdir().unwrap();
        let store = tmp.path().join("t.json");
        assert!(require_in(&store, TrustKind::Latexmkrc, tmp.path(), vec![]).is_ok());
    }

    #[test]
    fn ask_once_then_again_on_change() {
        let tmp = tempfile::tempdir().unwrap();
        let store = tmp.path().join("t.json");
        let dir = tmp.path();

        let err = require_in(&store, TrustKind::Latexmkrc, dir, vec![subj("rc", "a")]).unwrap_err();
        let req = request_of(err);
        assert_eq!(req["changed"], false);
        assert_eq!(req["items"][0]["preview"], "a");
        let fp = req["fingerprint"].as_str().unwrap().to_string();

        approve_in(&store, TrustKind::Latexmkrc, dir, vec![subj("rc", "a")], &fp).unwrap();
        assert!(require_in(&store, TrustKind::Latexmkrc, dir, vec![subj("rc", "a")]).is_ok());
        // Another kind in the same dir is its own approval.
        assert!(require_in(&store, TrustKind::Prettier, dir, vec![subj("rc", "a")]).is_err());

        let err = require_in(&store, TrustKind::Latexmkrc, dir, vec![subj("rc", "b")]).unwrap_err();
        assert_eq!(request_of(err)["changed"], true);
    }

    #[test]
    fn approval_refuses_what_changed_after_it_was_shown() {
        let tmp = tempfile::tempdir().unwrap();
        let store = tmp.path().join("t.json");
        let shown = fingerprint(&[subj("rc", "benign")]);
        assert!(approve_in(&store, TrustKind::Latexmkrc, tmp.path(), vec![subj("rc", "evil")], &shown).is_err());
        assert!(!store.exists());
    }

    #[test]
    fn exec_config_keys_are_recognised() {
        for k in [
            "core.hooksPath",
            "core.sshCommand",
            "credential.helper",
            "credential.https://x.example.helper",
            "gpg.ssh.program",
            "remote.origin.receivepack",
            "hook.lint.command",
            "merge.ours.driver",
        ] {
            assert!(is_exec_config_key(k), "{k}");
        }
        for k in ["remote.origin.url", "user.email", "core.bare", "branch.main.remote"] {
            assert!(!is_exec_config_key(k), "{k}");
        }
    }

    #[test]
    fn scoped_config_parses_records() {
        let raw = b"system\0filter.lfs.clean\ngit-lfs clean\0local\0core.sshcommand\nssh -v\0";
        let got = parse_scoped_config(raw);
        assert_eq!(got.len(), 2);
        assert_eq!(got[1], ("local".into(), "core.sshcommand".into(), "ssh -v".into()));
    }

    #[test]
    fn latexmkrc_in_the_build_dir_is_a_subject() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(latexmkrc_subjects(tmp.path()).is_empty());
        std::fs::write(tmp.path().join(".latexmkrc"), "system('x');").unwrap();
        assert_eq!(latexmkrc_subjects(tmp.path()).len(), 1);
    }

    #[test]
    fn data_only_prettier_config_does_not_ask_but_plugins_do() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join(".prettierrc"), r#"{"semi":false}"#).unwrap();
        assert!(prettier_subjects(tmp.path()).is_empty());
        std::fs::write(tmp.path().join(".prettierrc"), r#"{"plugins":["./p.js"]}"#).unwrap();
        assert!(!prettier_subjects(tmp.path()).is_empty());
        std::fs::remove_file(tmp.path().join(".prettierrc")).unwrap();
        std::fs::write(tmp.path().join("prettier.config.js"), "module.exports={}").unwrap();
        assert!(!prettier_subjects(tmp.path()).is_empty());
    }

    /// #866: a config file holding only a module name is a shared config
    /// prettier `require`s — code, however data-like the file looks.
    #[test]
    fn a_prettierrc_naming_a_shared_config_asks() {
        for (name, body) in [
            (".prettierrc", "\"@x/cfg\"\n"),
            (".prettierrc.json", "\"@x/cfg\""),
            (".prettierrc.json5", "'@x/cfg'"),
            (".prettierrc.yaml", "some-shared-config\n"),
        ] {
            assert!(config_executes(name, body.as_bytes()), "{name}: {body}");
            let tmp = tempfile::tempdir().unwrap();
            std::fs::write(tmp.path().join(name), body).unwrap();
            assert!(!prettier_subjects(tmp.path()).is_empty(), "{name} did not ask");
        }
        // Data stays data, whatever the format.
        assert!(!config_executes(".prettierrc", b"semi: false\n"));
        assert!(!config_executes(".prettierrc.json", br#"{"semi": false}"#));
        assert!(!config_executes(".prettierrc.toml", b"semi = false\n"));
        assert!(!config_executes(".prettierrc", b""));
    }

    #[cfg(unix)]
    #[test]
    fn planted_git_hook_is_a_subject() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path();
        assert!(std::process::Command::new("git").args(["init", "-q"]).current_dir(repo).status().unwrap().success());
        assert!(git_subjects(repo).is_empty(), "a fresh repo only has *.sample hooks");
        let hook = repo.join(".git/hooks/pre-commit");
        std::fs::write(&hook, "#!/bin/sh\necho pwned\n").unwrap();
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        let got = git_subjects(repo);
        assert_eq!(got.len(), 1);
        assert!(got[0].label.ends_with("pre-commit"));
    }

    /// #2349: a query git refuses (a FIFO it would block on) fails closed —
    /// the gated verb asks instead of finding no hooks.
    #[cfg(unix)]
    #[test]
    fn an_unreadable_repo_is_a_subject_not_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path();
        assert!(std::process::Command::new("git").args(["init", "-q"]).current_dir(repo).status().unwrap().success());
        let c = std::ffi::CString::new(repo.join(".gitignore").as_os_str().as_encoded_bytes()).unwrap();
        // SAFETY: a valid NUL-terminated path.
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o644) }, 0);
        let got = git_subjects(repo);
        assert!(!got.is_empty(), "an unreadable repo must not read as hook-free");
        assert!(got.iter().all(|s| s.label.starts_with("git could not be read")), "{:?}", got.iter().map(|s| &s.label).collect::<Vec<_>>());
    }
}
