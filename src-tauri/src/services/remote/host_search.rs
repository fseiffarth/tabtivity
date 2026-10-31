//! Content search and quick open on a remote-only project's host
//! (`docs/remote_only_projects_plan.md`, E6a).
//!
//! A remote-only project has no local tree, so `commands::search::project_search`
//! and `commands::fs::list_project_paths` answer from the host: one bounded
//! `grep` / `find` over the project's pooled SSH master. This module holds the
//! pure halves — the shell script each one runs, the `rel_root` check, the HPC
//! question and the NUL-separated parsers — so the commands keep only the I/O.
//!
//! Bounds: the caller runs the script through `git_bounded::run` at
//! `READ_TIMEOUT` with [`STDOUT_CAP`], and the host side stops itself first
//! (`head -n` / `head -c`), so neither a huge tree nor a minified one-line file
//! can wedge a worker or flood the window. Every value embedded in a script is
//! `shell_quote`d, and the whole script runs in its own `sh -c` (the login's
//! `$SHELL` may be fish or csh).

use crate::schema::project::RemoteSpec;
use crate::services::ssh_exec::shell_quote;

/// Vendor/build folders no walk enters — the one list behind the local walks
/// (`commands::search::should_skip_dir`, `commands::fs::should_skip_ending_scan_dir`)
/// and the host's; the app's own folder (both names) is added to it everywhere.
pub const SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".cache",
    ".venv",
    "venv",
    "__pycache__",
    ".tox",
];

/// Most file paths a host listing returns (quick open ranks them all in memory).
pub const MAX_HOST_PATHS: usize = 50_000;

/// Longest matching line kept, in chars. A minified file's one line would
/// otherwise travel whole to the window for every hit in it.
pub const MAX_LINE_CHARS: usize = 2_000;

/// Bytes the host may send back; the host's `head -c` stops it at this, and the
/// local reader at a little more.
pub const STDOUT_CAP: u64 = 16 * 1024 * 1024;

/// The slug the HPC dialog words a host search / host listing with.
pub const HPC_KIND: &str = "host-search";

/// A project-relative folder to confine a host search to: `None` for the
/// project root (absent, empty or `.`), else the POSIX path with its trailing
/// `/` dropped. Refused: an absolute path, a `..`, `.` or empty segment, a
/// NUL or other control character — the value names a host folder below the
/// project root, and the host tree is not ours to escape.
pub fn validate_rel_root(rel_root: Option<&str>) -> Result<Option<String>, String> {
    let Some(raw) = rel_root else { return Ok(None) };
    if raw.is_empty() || raw == "." {
        return Ok(None);
    }
    if raw.starts_with('/') || raw.chars().any(|c| c.is_control()) {
        return Err(format!("invalid search folder '{}'", raw.escape_debug()));
    }
    let rel = raw.trim_end_matches('/');
    if rel.split('/').any(|seg| seg.is_empty() || seg == "." || seg == "..") {
        return Err(format!("invalid search folder '{}'", raw.escape_debug()));
    }
    Ok(Some(rel.to_string()))
}

/// The HPC guard of a host search or listing: a tagged host answers the
/// `HPC_GUARD` sentinel unless this run was `confirmed` (a whole-tree walk on a
/// login node is the act the tag guards — the `sync_big_folders` shape).
pub fn hpc_refusal(tagged: bool, confirmed: Option<bool>, spec: &RemoteSpec) -> Option<String> {
    (tagged && confirmed != Some(true)).then(|| crate::services::hpc_mode::guard_error(HPC_KIND, spec))
}

/// Whether a query can never match one line: a line holds no newline (the
/// local walk splits on them too) and a NUL cannot ride a shell argument.
pub fn query_never_matches(query: &str) -> bool {
    query.is_empty() || query.contains(['\n', '\r', '\0'])
}

/// The `--exclude-dir` / `-name` names, brand folders included.
fn skip_names() -> Vec<&'static str> {
    let mut names = SKIP_DIRS.to_vec();
    names.push(crate::brand::PROJECT_DIR);
    names.push(crate::brand::LEGACY_PROJECT_DIR);
    names
}

/// `exec sh -c '<script>'`, with `cd <remote_path>` first; a missing project
/// folder exits 2 with nothing on stdout.
fn in_project(remote_path: &str, body: &str) -> Result<String, String> {
    crate::services::ssh_common::validate_arg("remote path", remote_path)?;
    let script = format!("cd {} || exit 2; {body}", shell_quote(remote_path));
    Ok(format!("exec sh -c {}", shell_quote(&script)))
}

/// The host command of a content search: `grep -rnIF --null` (`-i` unless
/// `case_sensitive`) over `root` (`.` or the checked `rel_root`), the skipped
/// folders excluded, at most `cap` hits and [`STDOUT_CAP`] bytes. `--null` (a
/// NUL after the file name; GNU and BSD grep, where `-Z` would be BSD's
/// decompress flag) keeps a `:` in a path from breaking the parse.
pub fn grep_command(
    remote_path: &str,
    rel_root: Option<&str>,
    query: &str,
    case_sensitive: bool,
    cap: usize,
) -> Result<String, String> {
    let mut grep = String::from("grep -rnIF --null");
    if !case_sensitive {
        grep.push_str(" -i");
    }
    for name in skip_names() {
        grep.push_str(&format!(" --exclude-dir={}", shell_quote(name)));
    }
    let root = rel_root.unwrap_or(".");
    grep.push_str(&format!(" -- {} {}", shell_quote(query), shell_quote(root)));
    let body = format!("{grep} 2>/dev/null | head -n {} | head -c {STDOUT_CAP}", cap.max(1));
    in_project(remote_path, &body)
}

/// The host command of a quick-open listing: every file under the project
/// root, the skipped folders pruned, NUL-separated (`-print0`: GNU, BSD and
/// busybox `find`), at most [`STDOUT_CAP`] bytes.
pub fn find_command(remote_path: &str) -> Result<String, String> {
    let prune = skip_names()
        .iter()
        .map(|name| format!("-name {}", shell_quote(name)))
        .collect::<Vec<_>>()
        .join(" -o ");
    let body = format!("find . \\( {prune} \\) -prune -o -type f -print0 2>/dev/null | head -c {STDOUT_CAP}");
    in_project(remote_path, &body)
}

/// A project path the host printed, cleaned to a relative POSIX path: the
/// walk root's prefix (`./` or `<rel_root>/`) stripped; `None` for anything
/// that would not stay under it (an empty, `.` or `..` segment).
fn clean_rel(name: &str, prefix: &str) -> Option<String> {
    let rel = name.strip_prefix(prefix)?;
    if rel.is_empty() || rel.split('/').any(|seg| seg.is_empty() || seg == "." || seg == "..") {
        return None;
    }
    Some(rel.to_string())
}

/// The prefix the host prints before every path for a walk of `rel_root`.
fn walk_prefix(rel_root: Option<&str>) -> String {
    match rel_root {
        Some(rel) => format!("{rel}/"),
        None => "./".to_string(),
    }
}

/// One `grep --null -n` hit: the path relative to the searched folder, the
/// 1-based line and the full line text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostHit {
    pub rel: String,
    pub line: u32,
    pub text: String,
}

/// Parse `grep --null -n` output — `name\0lineno:text\n` per hit, where the
/// name may hold anything but a NUL. Stops at the first incomplete record (the
/// host's `head -c` or the local cap cut it) and after `cap` hits; skips a
/// record whose path would leave the searched folder.
pub fn parse_grep(out: &[u8], rel_root: Option<&str>, cap: usize) -> Vec<HostHit> {
    let prefix = walk_prefix(rel_root);
    let mut hits = Vec::new();
    let mut rest = out;
    while hits.len() < cap {
        let Some(nul) = rest.iter().position(|&b| b == 0) else { break };
        let name = String::from_utf8_lossy(&rest[..nul]).into_owned();
        rest = &rest[nul + 1..];
        let Some(colon) = rest.iter().position(|&b| b == b':') else { break };
        let line = std::str::from_utf8(&rest[..colon]).ok().and_then(|n| n.parse::<u32>().ok());
        let after = &rest[colon + 1..];
        let Some(nl) = after.iter().position(|&b| b == b'\n') else { break };
        let text = String::from_utf8_lossy(&after[..nl]);
        let text = text.strip_suffix('\r').unwrap_or(&text).to_string();
        rest = &after[nl + 1..];
        let (Some(line), Some(rel)) = (line, clean_rel(&name, &prefix)) else { continue };
        hits.push(HostHit { rel, line, text });
    }
    hits
}

/// Parse `find -print0` output into project-relative file paths, sorted the
/// way the local listing sorts files. A trailing name with no NUL was cut and
/// is dropped; at most [`MAX_HOST_PATHS`].
pub fn parse_find(out: &[u8]) -> Vec<String> {
    let mut chunks: Vec<&[u8]> = out.split(|&b| b == 0).collect();
    // The piece after the last NUL is empty for a whole answer, a cut name otherwise.
    chunks.pop();
    let mut paths: Vec<String> = chunks
        .into_iter()
        .filter_map(|c| clean_rel(&String::from_utf8_lossy(c), "./"))
        .take(MAX_HOST_PATHS)
        .collect();
    paths.sort_by_key(|p| p.to_lowercase());
    paths
}

/// `text` cut to [`MAX_LINE_CHARS`] chars.
pub fn truncate_line(text: &str) -> String {
    match text.char_indices().nth(MAX_LINE_CHARS) {
        Some((at, _)) => text[..at].to_string(),
        None => text.to_string(),
    }
}

/// The host's absolute path of a hit: `remote_path[/rel_root]/rel`.
pub fn host_path(remote_path: &str, rel_root: Option<&str>, rel: &str) -> String {
    let base = remote_path.trim_end_matches('/');
    match rel_root {
        Some(root) => format!("{base}/{root}/{rel}"),
        None => format!("{base}/{rel}"),
    }
}

/// Run `script` on the host, bounded: [`STDOUT_CAP`] (a cut answer is parsed
/// as far as it is whole), `READ_TIMEOUT`, the subtree killed at either. An
/// ssh failure (255, or killed) or a missing project folder (2) is an error.
pub fn run_bounded(spec: &RemoteSpec, script: &str) -> Result<Vec<u8>, String> {
    let mut cmd = crate::services::ssh_exec::remote_shell_command(spec, script)?;
    let opts = crate::services::git_bounded::Opts {
        stdout_cap: Some(STDOUT_CAP + 64 * 1024),
        timeout: Some(crate::services::git_bounded::READ_TIMEOUT),
        no_precheck: true,
        ..Default::default()
    };
    let ran = crate::services::git_bounded::run(&mut cmd, opts).map_err(String::from)?;
    if ran.cut {
        return Ok(ran.output.stdout);
    }
    match ran.output.status.code() {
        Some(2) => Err(format!("the project folder '{}' is not on the host", spec.remote_path)),
        Some(255) | None => {
            let err = String::from_utf8_lossy(&ran.output.stderr).trim().to_string();
            Err(if err.is_empty() { "the host did not answer".to_string() } else { err })
        }
        _ => Ok(ran.output.stdout),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> RemoteSpec {
        serde_json::from_value(serde_json::json!({
            "host": "h.example", "user": "u", "remote_path": "/srv/p"
        }))
        .unwrap()
    }

    #[test]
    fn rel_root_stays_below_the_project_root() {
        assert_eq!(validate_rel_root(None), Ok(None));
        assert_eq!(validate_rel_root(Some("")), Ok(None));
        assert_eq!(validate_rel_root(Some(".")), Ok(None));
        assert_eq!(validate_rel_root(Some("src")), Ok(Some("src".into())));
        assert_eq!(validate_rel_root(Some("src/lib/")), Ok(Some("src/lib".into())));
        assert_eq!(validate_rel_root(Some("-rf dir")), Ok(Some("-rf dir".into())));
        for bad in ["/etc", "..", "a/../b", "a/./b", "a//b", "./a", "a\0b", "a\nb"] {
            assert!(validate_rel_root(Some(bad)).is_err(), "{bad:?} must be refused");
        }
    }

    #[test]
    fn a_tagged_host_asks_unless_confirmed() {
        let s = spec();
        let err = hpc_refusal(true, None, &s).expect("tagged, unconfirmed");
        assert!(err.starts_with(crate::services::hpc_mode::HPC_GUARD), "{err}");
        assert!(err.contains(" host-search "), "{err}");
        assert!(hpc_refusal(true, Some(false), &s).is_some());
        assert_eq!(hpc_refusal(true, Some(true), &s), None);
        assert_eq!(hpc_refusal(false, None, &s), None);
    }

    #[test]
    fn queries_that_cannot_match_a_line_are_answered_empty() {
        assert!(query_never_matches(""));
        assert!(query_never_matches("a\nb"));
        assert!(query_never_matches("a\rb"));
        assert!(query_never_matches("a\0b"));
        assert!(!query_never_matches("a b\t'$x"));
    }

    /// Undo one level of POSIX single quoting (`'…'` with `'\''`) — enough to
    /// read back what `sh -c` receives.
    fn unquote(word: &str) -> String {
        let mut out = String::new();
        let mut chars = word.chars().peekable();
        let mut quoted = false;
        while let Some(c) = chars.next() {
            match c {
                '\'' => quoted = !quoted,
                '\\' if !quoted => out.extend(chars.next()),
                c => out.push(c),
            }
        }
        out
    }

    #[test]
    fn grep_command_quotes_every_value_and_runs_in_its_own_sh() {
        let cmd = grep_command("/srv/my p", None, "it's $(rm -rf ~)", false, 500).unwrap();
        let quoted = cmd.strip_prefix("exec sh -c ").expect("own sh");
        let script = unquote(quoted);
        assert!(script.starts_with("cd '/srv/my p' || exit 2; grep -rnIF --null -i"), "{script}");
        assert!(script.contains(" --exclude-dir='.git'"), "{script}");
        assert!(script.contains(&format!(" --exclude-dir='{}'", crate::brand::PROJECT_DIR)), "{script}");
        assert!(script.contains(" -- 'it'\\''s $(rm -rf ~)' '.' 2>/dev/null | head -n 500 | head -c "), "{script}");
        // Case-sensitive drops `-i`; a folder scope replaces `.`.
        let script = unquote(grep_command("/srv/p", Some("-x/y"), "q", true, 3).unwrap().strip_prefix("exec sh -c ").unwrap());
        assert!(script.contains("grep -rnIF --null --exclude-dir"), "{script}");
        assert!(script.contains(" -- 'q' '-x/y' "), "{script}");
        assert!(script.contains("head -n 3 "), "{script}");
        // A remote path that reads as an option is refused, as every host builder does.
        assert!(grep_command("-oProxyCommand=x", None, "q", true, 1).is_err());
    }

    #[test]
    fn find_command_prunes_the_skipped_folders_and_prints_nul_separated() {
        let script = unquote(find_command("/srv/p").unwrap().strip_prefix("exec sh -c ").unwrap());
        assert!(script.starts_with("cd '/srv/p' || exit 2; find . \\( -name '.git' -o -name 'node_modules'"), "{script}");
        assert!(script.contains(&format!("-name '{}'", crate::brand::LEGACY_PROJECT_DIR)), "{script}");
        assert!(script.contains(" \\) -prune -o -type f -print0 2>/dev/null | head -c "), "{script}");
    }

    #[test]
    fn grep_output_parses_names_with_colons_and_stops_at_a_cut_record() {
        let out = b"./a:b.txt\x0012:has: colons\n./src/x.rs\x003:fn x() {}\r\n./cut.txt\x009:no newline";
        let hits = parse_grep(out, None, 10);
        assert_eq!(
            hits,
            vec![
                HostHit { rel: "a:b.txt".into(), line: 12, text: "has: colons".into() },
                HostHit { rel: "src/x.rs".into(), line: 3, text: "fn x() {}".into() },
            ]
        );
        assert_eq!(parse_grep(out, None, 1).len(), 1, "cap honoured");
    }

    #[test]
    fn grep_output_under_a_folder_is_relative_to_it_and_never_escapes() {
        let out = b"src/a.rs\x001:hit\nsrc/../etc/passwd\x001:hit\nother/b.rs\x001:hit\nsrc/\x001:hit\nsrc/n\nl.rs\x002:hit\n";
        let hits = parse_grep(out, Some("src"), 10);
        let rels: Vec<&str> = hits.iter().map(|h| h.rel.as_str()).collect();
        assert_eq!(rels, vec!["a.rs", "n\nl.rs"]);
    }

    #[test]
    fn find_output_drops_the_cut_tail_and_sorts() {
        let out = b"./b.txt\0./A/c.md\0./x/../y\0.\0./cut";
        assert_eq!(parse_find(out), vec!["A/c.md".to_string(), "b.txt".to_string()]);
        assert!(parse_find(b"").is_empty());
    }

    #[test]
    fn lines_are_cut_to_the_cap_on_a_char_boundary() {
        let long = "é".repeat(MAX_LINE_CHARS + 5);
        assert_eq!(truncate_line(&long).chars().count(), MAX_LINE_CHARS);
        assert_eq!(truncate_line("short"), "short");
    }

    #[test]
    fn host_paths_join_root_folder_and_rel() {
        assert_eq!(host_path("/srv/p/", None, "a/b.rs"), "/srv/p/a/b.rs");
        assert_eq!(host_path("/srv/p", Some("src"), "b.rs"), "/srv/p/src/b.rs");
    }
}
