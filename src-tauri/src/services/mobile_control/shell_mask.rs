//! A running shell's command line as the phone may see it (threat model gap
//! 79): the desktop Reader shows the whole command, the phone a masked copy.
//!
//! Three passes, in this order:
//! 1. the tab's own folders (project root, box members, the tab's cwd) become
//!    project-relative (`/…/proj/src/x.rs` → `src/x.rs`, the folder itself
//!    `.`), so the line still reads as the agent wrote it;
//! 2. anything secret-shaped is replaced with [`HIDDEN`]: URL passwords,
//!    credential headers, `Bearer`/`Basic` credentials, `name=value` and
//!    `--flag value` pairs whose name says secret, well-known token prefixes,
//!    private-key blocks and long mixed-case random runs;
//! 3. every other absolute or `~/` path keeps only its leaf (`…/config`), since
//!    host paths never cross the browser API.
//!
//! A heuristic, not a guarantee: the paired phone could already read the same
//! text off the Terminal view. Pure + tested.

use std::sync::LazyLock;

use regex::{Captures, Regex};

/// What a masked secret reads as.
pub const HIDDEN: &str = "•••";

/// `command` as the phone may see it, with `folders` (the tab's own project
/// folders, any order) made relative. Empty folders are skipped.
pub fn mask_command(command: &str, folders: &[&str]) -> String {
    let relative = relative_to_folders(command, folders);
    let hidden = hide_secrets(&relative);
    leaf_only_paths(&hidden)
}

/// One of the tab's folders as pass 1 looks for it.
#[derive(PartialEq, Eq)]
struct Folder {
    /// POSIX: as given, no trailing `/`. Windows: no verbatim prefix, `\`
    /// separators, no trailing `\`.
    text: String,
    /// A Windows path (`C:\…`, `\\server\share\…`): matched without regard
    /// to case or to `\` versus `/`, verbatim (`\\?\…`) spellings included.
    windows: bool,
}

impl Folder {
    /// `None` for a folder that is no absolute path, or is a root (`/`, `C:\`)
    /// that would make every path on the line relative.
    fn new(folder: &str) -> Option<Self> {
        if folder.starts_with('/') {
            let text = folder.trim_end_matches('/');
            return (text.len() > 1).then(|| Self { text: text.to_string(), windows: false });
        }
        let plain = without_verbatim(folder)?;
        if !is_windows_absolute(&plain) {
            return None;
        }
        let text = plain.replace('/', "\\").trim_end_matches('\\').to_string();
        (text.len() > 2).then_some(Self { text, windows: true })
    }

    fn is_separator(&self, ch: char) -> bool {
        ch == '/' || (self.windows && ch == '\\')
    }

    /// `rest` after this folder, when `rest` starts with it.
    fn strip<'r>(&self, rest: &'r str) -> Option<&'r str> {
        if !self.windows {
            return rest.strip_prefix(self.text.as_str());
        }
        if let Some(found) = strip_windows(rest, &self.text) {
            return Some(found);
        }
        // The same folder spelled verbatim on the line.
        let after = strip_windows(rest, r"\\?\")?;
        match self.text.strip_prefix(r"\\") {
            Some(unc) => strip_windows(strip_windows(after, r"UNC\")?, unc),
            None => strip_windows(after, &self.text),
        }
    }
}

/// `path` with a Windows verbatim prefix taken off: `\\?\C:\x` → `C:\x`,
/// `\\?\UNC\srv\share` → `\\srv\share`. `None` for a verbatim path of any
/// other kind (a device, a volume GUID).
fn without_verbatim(path: &str) -> Option<String> {
    let Some(rest) = strip_windows(path, r"\\?\") else { return Some(path.to_string()) };
    if let Some(unc) = strip_windows(rest, r"UNC\") {
        return Some(format!(r"\\{unc}"));
    }
    is_windows_absolute(rest).then(|| rest.to_string())
}

/// A drive path (`C:\…`, `C:/…`) or a UNC one (`\\server\…`).
fn is_windows_absolute(path: &str) -> bool {
    let bytes = path.as_bytes();
    let drive = bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && matches!(bytes[2], b'\\' | b'/');
    drive || (path.starts_with(r"\\") && !path.starts_with(r"\\?"))
}

/// `rest` after `prefix`, compared the way Windows compares paths: without
/// regard to case, `\` in `prefix` matching `\` or `/`.
fn strip_windows<'r>(rest: &'r str, prefix: &str) -> Option<&'r str> {
    let mut chars = rest.char_indices();
    for want in prefix.chars() {
        let (_, got) = chars.next()?;
        let same = if want == '\\' {
            matches!(got, '\\' | '/')
        } else {
            got == want || got.to_lowercase().eq(want.to_lowercase())
        };
        if !same {
            return None;
        }
    }
    Some(chars.next().map_or("", |(at, _)| &rest[at..]))
}

/// Pass 1: each folder (longest first, so a member folder inside the root is
/// not cut short) followed by a separator is dropped, the bare folder becomes
/// `.`. A match must start and end on a path boundary: `/a/proj` is not a
/// prefix of `/a/project` or of `/mnt/a/proj`. A Windows folder matches in any
/// case, with either separator and spelled verbatim; one written another way
/// (an 8.3 short name for a long one) is left to pass 3, which cuts it to its
/// leaf.
fn relative_to_folders(command: &str, folders: &[&str]) -> String {
    let mut folders: Vec<Folder> = folders.iter().filter_map(|folder| Folder::new(folder)).collect();
    folders.sort_by_key(|folder| std::cmp::Reverse(folder.text.len()));
    folders.dedup();
    let mut out = String::with_capacity(command.len());
    let mut rest = command;
    'scan: while let Some(ch) = rest.chars().next() {
        let after_path_char = out.chars().next_back().is_some_and(is_path_char);
        if !after_path_char && (matches!(ch, '/' | '\\') || ch.is_ascii_alphabetic()) {
            for folder in &folders {
                let Some(tail) = folder.strip(rest) else { continue };
                match tail.chars().next() {
                    Some(sep) if folder.is_separator(sep) => {
                        // `/proj/` alone (a trailing slash) still names the folder.
                        let after = &tail[1..];
                        if after.chars().next().is_none_or(|next| !is_path_char(next) && !folder.is_separator(next)) {
                            out.push('.');
                        }
                        rest = after;
                        continue 'scan;
                    }
                    Some(next) if is_path_char(next) => {}
                    _ => {
                        out.push('.');
                        rest = tail;
                        continue 'scan;
                    }
                }
            }
        }
        out.push(ch);
        rest = &rest[ch.len_utf8()..];
    }
    out
}

fn is_path_char(ch: char) -> bool {
    ch.is_alphanumeric() || matches!(ch, '/' | '.' | '_' | '-' | '~' | '+' | '@' | '%')
}

/// Names that say their value is a secret, for `name=value`, `--name value`
/// and `"name": "value"`.
const SECRET_NAME: &str = r"[A-Za-z0-9_.-]*(?i:password|passwd|passphrase|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credentials?|auth[_-]?token|session[_-]?id|cookie)[A-Za-z0-9_.-]*";

/// A value: quoted, or a run up to whitespace, a quote or a shell operator.
const VALUE: &str = r#"(?:'[^']*'|"[^"]*"|[^\s'"`;|&<>()]+)"#;

static URL_PASSWORD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"([A-Za-z][A-Za-z0-9+.-]*://)[^/\s@:'\x22]*:[^/\s@'\x22]*@").expect("url password"));
static PRIVATE_KEY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----(?s:.*?)(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|\z)").expect("private key")
});
static HEADER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(proxy-authorization|authorization|set-cookie|cookie|x-[a-z0-9-]*(?:token|key|secret|auth)[a-z0-9-]*|[a-z0-9-]*api-?key)(\s*:\s*)[^'\x22\n]+")
        .expect("header")
});
static SCHEME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b(bearer|basic)(\s+)[A-Za-z0-9._~+/=-]{6,}").expect("scheme"));
static ASSIGNED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"({SECRET_NAME})={VALUE}")).expect("assigned"));
static FLAG: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"(^|\s)(--?{SECRET_NAME})(\s+)({VALUE})")).expect("flag"));
static JSON_FIELD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r#""({SECRET_NAME})"(\s*:\s*)"[^"]*""#)).expect("json field"));
static KNOWN_TOKEN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}", // privacy-check: ok — a regex that recognises token shapes, no token
        r"|xox[abposr]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}",
        r"|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})",
    ))
    .expect("known token")
});
static LONG_RUN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[A-Za-z0-9_+=-]{32,}").expect("long run"));

/// Pass 2.
fn hide_secrets(command: &str) -> String {
    let out = PRIVATE_KEY.replace_all(command, HIDDEN);
    let out = URL_PASSWORD.replace_all(&out, format!("${{1}}{HIDDEN}@").as_str());
    let out = HEADER.replace_all(&out, format!("${{1}}${{2}}{HIDDEN}").as_str());
    let out = SCHEME.replace_all(&out, |caps: &Captures| {
        // A credential, not prose: "add basic support" keeps its word.
        let credential = &caps[0][caps[1].len() + caps[2].len()..];
        if credential.chars().all(|c| c.is_ascii_lowercase()) {
            caps[0].to_string()
        } else {
            format!("{}{}{HIDDEN}", &caps[1], &caps[2])
        }
    });
    let out = JSON_FIELD.replace_all(&out, format!("\"${{1}}\"${{2}}\"{HIDDEN}\"").as_str());
    let out = ASSIGNED.replace_all(&out, format!("${{1}}={HIDDEN}").as_str());
    let out = FLAG.replace_all(&out, |caps: &Captures| {
        // `--token=x` was the assignment's; a flag followed by another flag
        // (`--password --verbose`) has no value here.
        if caps[4].starts_with('-') {
            caps[0].to_string()
        } else {
            format!("{}{}{}{HIDDEN}", &caps[1], &caps[2], &caps[3])
        }
    });
    let out = KNOWN_TOKEN.replace_all(&out, HIDDEN);
    LONG_RUN
        .replace_all(&out, |caps: &Captures| {
            let run = &caps[0];
            let mixed = run.chars().any(|c| c.is_ascii_uppercase())
                && run.chars().any(|c| c.is_ascii_lowercase())
                && run.chars().any(|c| c.is_ascii_digit());
            if mixed { HIDDEN.to_string() } else { run.to_string() }
        })
        .into_owned()
}

/// An absolute (`/a/b`, not `//host`) or home (`~/a`) path, starting the line
/// or after whitespace, a quote, `=`, `:`, `(` or `,`.
static PATH: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(^|[\s'"=:(,])(~?/[^/\s'"`;|&<>(),][^\s'"`;|&<>(),]*)"#).expect("path"));

/// A Windows absolute path, after the same boundaries as [`PATH`]: a drive
/// path (`C:\a`, `C:/a`), a UNC one (`\\server\share`) or anything verbatim
/// (`\\?\…`).
static WINDOWS_PATH: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(^|[\s'"=:(,])((?:\\\\\?\\|[A-Za-z]:[\\/]|\\\\[^\\/\s'"`;|&<>(),?]+\\)[^\s'"`;|&<>(),]*)"#)
        .expect("windows path")
});

/// Pass 3: such a path keeps only its last component, after `…/` (`~/…/` for
/// a home path). A path of one component (`/tmp`, `~/x`) names nothing private
/// and stays. A Windows path the same, after `…\`: a drive path of one
/// component (`C:\Users`) stays; a UNC path shows no more than what follows
/// its server and share, since those name a host.
fn leaf_only_paths(command: &str) -> String {
    let command = WINDOWS_PATH.replace_all(command, |caps: &Captures| {
        let path = &caps[2];
        let sep = if path.contains('\\') { '\\' } else { '/' };
        let plain = without_verbatim(path).unwrap_or_else(|| path.to_string());
        let unc = plain.starts_with(r"\\");
        let body = if unc { &plain[2..] } else { plain.get(2..).unwrap_or_default() };
        let parts: Vec<&str> = body.split(['\\', '/']).filter(|part| !part.is_empty()).collect();
        let shown = if unc { 2 } else { 1 };
        if !unc && parts.len() <= shown && plain == path {
            return caps[0].to_string();
        }
        let trail = if parts.len() > shown && path.ends_with(['\\', '/']) { sep.to_string() } else { String::new() };
        match parts.last().filter(|_| parts.len() > shown) {
            Some(leaf) => format!("{}…{sep}{leaf}{trail}", &caps[1]),
            None => format!("{}…", &caps[1]),
        }
    });
    PATH.replace_all(&command, |caps: &Captures| {
        let path = &caps[2];
        let body = path.trim_start_matches('~').trim_matches('/');
        if !body.contains('/') {
            return caps[0].to_string();
        }
        let leaf = body.rsplit('/').next().unwrap_or_default();
        let slash = if path.ends_with('/') { "/" } else { "" };
        let home = if path.starts_with('~') { "~/" } else { "" };
        format!("{}{home}…/{leaf}{slash}", &caps[1])
    })
    .into_owned()
}

#[cfg(test)]
mod tests;
