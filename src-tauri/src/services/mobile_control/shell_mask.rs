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
//! 3. every other absolute, `~/` or `~user/` path and `file://` address keeps
//!    only its leaf (`…/config`), since host paths never cross the browser API.
//!    A path is found by what it is, wherever it starts (after `2>`, `<`, `@`,
//!    `;`, a glued `-I`, `${X:-`, `git+`, …); a quoted one is cut as one path,
//!    spaces included, and a backslash-escaped character does not end one.
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

/// A file path (an `Edit`/`Write` permission dialog's subject) as the phone
/// may see it: the tab's own `folders` made project-relative, secret-shaped
/// text hidden, and a path still absolute (or `~/…`) cut to its leaf after
/// `…/`. The whole string is one path, so a space inside a folder name does
/// not let the rest of the folders through as [`mask_command`] would. A
/// relative path the agent wrote stays as it is; a path of one component
/// (`/tmp`, `~/x`, `C:\Users`) names nothing private and stays.
pub fn mask_path(path: &str, folders: &[&str]) -> String {
    let path: String = path.chars().filter(|&c| !is_invisible(c)).collect();
    let relative = relative_to_folders(path.trim(), folders);
    let hidden = hide_secrets(&relative);
    let home = hidden == "~" || hidden.starts_with("~/");
    let plain = without_verbatim(&hidden).unwrap_or_else(|| hidden.clone());
    let unc = plain.starts_with(r"\\");
    let drive = !unc && is_windows_absolute(&plain);
    if !(home || unc || drive || hidden.starts_with('/')) {
        // Relative as written, and nothing else: a `..` (it climbs out of the
        // folder that was just taken off), a scheme or drive colon, a rooted
        // `\`, a `~user` or a second path after a space are not.
        return if is_plain_relative(&hidden) { hidden } else { leaf_of(&hidden) };
    }
    let body = if drive {
        &plain[2..]
    } else if home {
        &plain[1..]
    } else {
        plain.as_str()
    };
    let parts: Vec<&str> = body.split(['\\', '/']).filter(|part| !part.is_empty()).collect();
    // A UNC path shows no more than what follows its server and share.
    let shown = if unc { 2 } else { 1 };
    let sep = if plain.contains('\\') { '\\' } else { '/' };
    let prefix = if home { "~/" } else { "" };
    match parts.last().filter(|_| parts.len() > shown) {
        Some(leaf) => format!("{prefix}…{sep}{leaf}"),
        None if unc => "…".to_string(),
        None => hidden,
    }
}

/// Characters that show nothing or reorder what is shown (bidi controls,
/// zero-width and joiner marks, tags, controls): `evil\u{202E}txt.exe` reads
/// `evilexe.txt`.
fn is_invisible(c: char) -> bool {
    c.is_control()
        || matches!(c, '\u{AD}' | '\u{61C}' | '\u{180E}' | '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{206F}' | '\u{FEFF}' | '\u{FFF9}'..='\u{FFFB}' | '\u{E0000}'..='\u{E007F}')
}

/// A relative path that stays inside the folder it is relative to and names
/// no other: no `..` component, no `:`, no leading `\` or `~`, and no later
/// word that starts an absolute path.
fn is_plain_relative(path: &str) -> bool {
    !path.starts_with(['\\', '~'])
        && !path.contains(':')
        && !path.split(['/', '\\']).any(|part| part == "..")
        && !path.split_whitespace().skip(1).any(|word| word.starts_with(['/', '\\', '~']))
}

/// Only the last component of `path`, after `…/` (`…\` when it is written
/// with backslashes): what is left of a path that is no plain relative one.
fn leaf_of(path: &str) -> String {
    let sep = if path.contains('\\') && !path.contains('/') { '\\' } else { '/' };
    match path.split(['/', '\\']).rfind(|part| !part.is_empty() && *part != "..") {
        Some(leaf) => format!("…{sep}{leaf}"),
        None => "…".to_string(),
    }
}

/// A URL (a `WebFetch` permission dialog's subject) as the phone may see it:
/// its scheme and host and nothing else — no user info, port, path, query or
/// fragment, all of which can hold what the host must not show. Empty for
/// anything that is no `scheme://host` (a `data:` or `file:` URL, a host with
/// a character no host name has): the phone then shows the tool's name alone.
pub fn mask_url(url: &str) -> String {
    let url = url.trim();
    let Some((scheme, rest)) = url.split_once("://") else { return String::new() };
    let scheme_ok = scheme.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
        && scheme.len() <= 16
        && scheme.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'));
    if !scheme_ok {
        return String::new();
    }
    // The authority ends at the first `/`, `?`, `#` or `\`; user info is
    // everything before its last `@`.
    let authority = rest.split(['/', '?', '#', '\\']).next().unwrap_or_default();
    let host_port = authority.rsplit('@').next().unwrap_or_default();
    let host = match host_port.strip_prefix('[') {
        Some(v6) => match v6.split_once(']') {
            Some((address, _)) if !address.is_empty() && address.chars().all(|c| c.is_ascii_hexdigit() || matches!(c, ':' | '.')) => {
                format!("[{address}]")
            }
            _ => return String::new(),
        },
        None => {
            let name = host_port.split(':').next().unwrap_or_default();
            // ASCII only: another script's look-alike letters read as a host
            // the user knows (`раураl.com`), and the phone cannot tell.
            if name.is_empty() || name.len() > 253 || !name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_')) {
                return String::new();
            }
            name.to_string()
        }
    };
    // A host label can itself be a random run (a token in a sub-domain).
    hide_secrets(&format!("{scheme}://{host}"))
}

/// Which paths one scan of pass 3 looks for.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    /// A drive path (`C:\a`, `C:/a`), a UNC one (`\\server\share`) or anything
    /// verbatim (`\\?\…`).
    Windows,
    /// An absolute (`/a/b`, not `//host`), home (`~/a`, `~user/a`) or
    /// `file://` path.
    Posix,
}

/// Pass 3: such a path keeps only its last component, after `…/` (`~/…/` for
/// a home path, `file://…/` for a file address). A path of one component
/// (`/tmp`, `~/x`) names nothing private and stays. A Windows path the same,
/// after `…\`: a drive path of one component (`C:\Users`) stays; a UNC path
/// shows no more than what follows its server and share, since those name a
/// host.
///
/// A path is found by what it is, wherever it starts: after a redirection
/// (`2>/a/b`, `</a/b`), `@`, `;`, `{`, a backtick or a glued short flag
/// (`-I/a/b`, and `/I` for a Windows tool) as much as after a space. It is
/// not one when it follows a character a path is made of (`src/a/b`,
/// `https://host/a/b`). A quoted string that is one path is cut as one, so a
/// space in a folder name lets nothing through; any other quoted string is
/// scanned like the rest of the line. Windows paths go first, so the POSIX
/// scan does not take `/IC:\…` for a path of its own.
fn leaf_only_paths(command: &str) -> String {
    let windows = scan_paths(command, Kind::Windows);
    scan_paths(&windows, Kind::Posix)
}

fn scan_paths(text: &str, kind: Kind) -> String {
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    while let Some(ch) = text[at..].chars().next() {
        let rest = &text[at..];
        if matches!(ch, '\'' | '"') {
            if let Some(len) = closing_quote(&rest[1..], ch, kind) {
                let inner = &rest[1..1 + len];
                out.push(ch);
                if is_one_path(inner, kind) {
                    out.push_str(&leaf_of_path(inner, kind));
                } else {
                    out.push_str(&scan_paths(inner, kind));
                }
                out.push(ch);
                at += len + 2;
                continue;
            }
        }
        // A file address may also follow a scheme it is glued to (`git+file://`).
        let after_scheme = kind == Kind::Posix && text[..at].ends_with('+') && is_file_address(rest);
        if after_scheme || may_start_path(&text[..at], kind) {
            if let Some(len) = path_len(rest, kind) {
                out.push_str(&leaf_of_path(&rest[..len], kind));
                at += len;
                continue;
            }
        }
        out.push(ch);
        at += ch.len_utf8();
    }
    out
}

/// Byte offset in `after` (what follows an opening `quote`) of the quote that
/// closes it. In a POSIX double-quoted string `\"` closes nothing.
fn closing_quote(after: &str, quote: char, kind: Kind) -> Option<usize> {
    if quote == '\'' || kind == Kind::Windows {
        return after.find(quote);
    }
    let mut chars = after.char_indices();
    while let Some((at, ch)) = chars.next() {
        if ch == '\\' {
            chars.next();
        } else if ch == quote {
            return Some(at);
        }
    }
    None
}

/// A character a path or a word is made of: a path never starts right after
/// one (`src/a/b`, `https://host/a`, `$HOME/a`, `a*/b`).
fn is_word_char(ch: char) -> bool {
    ch.is_alphanumeric() || matches!(ch, '.' | '_' | '-' | '~' | '+' | '%' | '/' | '\\' | '*' | '?' | ']' | '$')
}

/// Whether a path may start right after `before`: at the line start, after a
/// character no word is made of, after a sign that starts a word (a parameter
/// default, `${X:-/a/b}`, `${X:+/a/b}`), or after a glued short flag (`-I`,
/// and for Windows tools `/I`) that itself starts a word.
fn may_start_path(before: &str, kind: Kind) -> bool {
    let mut back = before.chars().rev();
    let Some(prev) = back.next() else { return true };
    if !is_word_char(prev) {
        return true;
    }
    let before_prev = back.next();
    if matches!(prev, '-' | '+') && before_prev.is_none_or(|c| !is_word_char(c)) {
        return true;
    }
    let flag = |c: char| c == '-' || (kind == Kind::Windows && c == '/');
    prev.is_ascii_alphabetic() && before_prev.is_some_and(flag) && back.next().is_none_or(|c| !is_word_char(c))
}

/// What ends an unquoted path.
fn ends_path(ch: char, kind: Kind) -> bool {
    ch.is_whitespace()
        || matches!(ch, '\'' | '"' | '`' | ';' | '|' | '&' | '<' | '>' | '(' | ')' | ',')
        || (kind == Kind::Posix && matches!(ch, '{' | '}'))
}

/// Byte length of the run that continues a path, from the start of `body`.
/// A POSIX backslash escape (`\ `, `\'`, `\(`, `\;`, …) does not end it.
fn body_len(body: &str, kind: Kind) -> usize {
    let mut chars = body.char_indices();
    while let Some((at, ch)) = chars.next() {
        if kind == Kind::Posix && ch == '\\' {
            chars.next();
            continue;
        }
        if ends_path(ch, kind) {
            return at;
        }
    }
    body.len()
}

/// Byte length of the path of `kind` that starts `text`, if one does.
fn path_len(text: &str, kind: Kind) -> Option<usize> {
    let bytes = text.as_bytes();
    let head = match kind {
        Kind::Windows => {
            if text.starts_with(r"\\?\") {
                4
            } else if bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && matches!(bytes[2], b'\\' | b'/') {
                3
            } else {
                // A UNC path: `\\`, a server name, then `\`.
                let unc = text.strip_prefix(r"\\")?;
                let server = unc.find(|c: char| c == '\\' || c == '/' || c == '?' || ends_path(c, kind)).filter(|&n| n > 0)?;
                if !unc[server..].starts_with('\\') {
                    return None;
                }
                2 + server + 1
            }
        }
        Kind::Posix => {
            if is_file_address(text) {
                7
            } else {
                // `~/a`, or another user's home, `~alice/a` (not `~1`, `~+`, `~-`).
                let slash = match text.strip_prefix('~') {
                    Some(user) => {
                        let name = user.find(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))).unwrap_or(user.len());
                        if name > 0 && !user.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_') {
                            return None;
                        }
                        1 + name
                    }
                    None => 0,
                };
                if !text[slash..].starts_with('/') {
                    return None;
                }
                // `/` alone, `//host` and `/ ` start no path.
                let next = text[slash + 1..].chars().next()?;
                if next == '/' || ends_path(next, kind) {
                    return None;
                }
                slash + 1
            }
        }
    };
    let len = head + body_len(&text[head..], kind);
    (kind == Kind::Windows || len > head).then_some(len)
}

/// A quoted string that is one path and nothing else: it starts as one, and
/// no shell operator or later word that starts a flag or another path follows.
fn is_one_path(inner: &str, kind: Kind) -> bool {
    path_len(inner, kind).is_some()
        && !inner.contains([';', '|', '&', '<', '>', '`'])
        && !inner.split_whitespace().skip(1).any(|word| {
            word.starts_with(['-', '/', '\\', '~']) || path_len(word, Kind::Windows).is_some() || path_len(word, Kind::Posix).is_some()
        })
}

/// `path` (one that [`path_len`] found) cut to its leaf.
fn leaf_of_path(path: &str, kind: Kind) -> String {
    match kind {
        Kind::Windows => windows_leaf(path),
        Kind::Posix => posix_leaf(path),
    }
}

fn windows_leaf(path: &str) -> String {
    let sep = if path.contains('\\') { '\\' } else { '/' };
    let plain = without_verbatim(path).unwrap_or_else(|| path.to_string());
    let unc = plain.starts_with(r"\\");
    let body = if unc { &plain[2..] } else { plain.get(2..).unwrap_or_default() };
    let parts: Vec<&str> = body.split(['\\', '/']).filter(|part| !part.is_empty()).collect();
    let shown = if unc { 2 } else { 1 };
    if !unc && parts.len() <= shown && plain == path {
        return path.to_string();
    }
    let trail = if parts.len() > shown && path.ends_with(['\\', '/']) { sep.to_string() } else { String::new() };
    match parts.last().filter(|_| parts.len() > shown) {
        Some(leaf) => format!("…{sep}{leaf}{trail}"),
        None => "…".to_string(),
    }
}

/// `text` starts with `file://`, in any case.
fn is_file_address(text: &str) -> bool {
    text.get(..7).is_some_and(|scheme| scheme.eq_ignore_ascii_case("file://"))
}

fn posix_leaf(path: &str) -> String {
    let slash = if path.ends_with('/') { "/" } else { "" };
    if is_file_address(path) {
        // Its host, if any, is a component like the rest.
        let parts: Vec<&str> = path[7..].split(['/', '\\']).filter(|part| !part.is_empty()).collect();
        return match parts.last().filter(|_| parts.len() > 1) {
            Some(leaf) => format!("{}…/{leaf}{slash}", &path[..7]),
            None => path.to_string(),
        };
    }
    if path.starts_with('~') && !path.starts_with("~/") {
        // Another user's home: even one component under it names that user.
        let leaf = path.rsplit('/').find(|part| !part.is_empty()).unwrap_or_default();
        return format!("…/{leaf}{slash}");
    }
    let body = path.trim_start_matches('~').trim_matches('/');
    if !body.contains('/') {
        return path.to_string();
    }
    let leaf = body.rsplit('/').next().unwrap_or_default();
    let home = if path.starts_with('~') { "~/" } else { "" };
    format!("{home}…/{leaf}{slash}")
}

#[cfg(test)]
mod tests;
