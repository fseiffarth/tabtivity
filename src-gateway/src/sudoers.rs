//! Does `sudo` grant an account anything? (P3 review finding 11, user
//! decision 2026-10-03.) The admin helper refuses to link an account that
//! sudoers names in any way — per user, per group, by uid, through a
//! `User_Alias`, a netgroup or `ALL` — whatever the rule grants: a narrow
//! `NOPASSWD` command is still a way out of the fence's reach that the
//! server's isolation does not model.
//!
//! **Read-only, and fail closed.** The files are parsed, never `sudo -l`
//! (which logs and may consult plugins): `/etc/sudoers` and everything it
//! includes (`@include`, `@includedir`, `#include`, `#includedir`; files in
//! an included directory are skipped like sudo skips them — a `.` in the
//! name or a trailing `~`). An unreadable file, an include loop deeper than
//! eight, or an `/etc/nsswitch.conf` that takes sudoers from anything but
//! `files` (LDAP, SSSD — rules this cannot see) is an error, and the caller
//! refuses the account. The parse is deliberately coarse: any user list that
//! mentions the account counts, a negation (`!alice`) included.
//!
//! Paths are resolved under `root` (`/` on the server, a fixture directory in
//! the tests), never through `..`.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

const MAX_DEPTH: usize = 8;

/// Who is asking: the account's name, uid, primary gid and group names.
pub struct Subject<'a> {
    pub name: &'a str,
    pub uid: u32,
    pub gid: u32,
    pub groups: &'a [String],
}

/// The first sudoers rule that names `who` (its text, for the refusal), or
/// `None` when no rule does.
pub fn rule_for(root: &Path, who: &Subject<'_>) -> Result<Option<String>, String> {
    check_nsswitch(root)?;
    let mut lines = Vec::new();
    let mut seen = HashSet::new();
    read_file(root, Path::new("/etc/sudoers"), Path::new("/etc"), 0, &mut seen, &mut lines)?;
    Ok(first_match(&lines, who))
}

/// `sudoers:` in nsswitch.conf naming anything but `files`.
fn check_nsswitch(root: &Path) -> Result<(), String> {
    let path = under(root, Path::new("/etc/nsswitch.conf"))?;
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("{}: {e}", path.display())),
    };
    for line in text.lines() {
        let line = line.split('#').next().unwrap_or("").trim();
        if let Some(sources) = line.strip_prefix("sudoers:") {
            for source in sources.split_whitespace() {
                if source != "files" && !source.starts_with('[') {
                    return Err(format!("sudoers rules also come from {source:?} (/etc/nsswitch.conf), which the helper cannot read; it refuses every account until that is only \"files\""));
                }
            }
        }
    }
    Ok(())
}

/// `path` (absolute, as sudoers names it) under `root`, refusing `..`.
fn under(root: &Path, path: &Path) -> Result<PathBuf, String> {
    let mut out = root.to_path_buf();
    for part in path.components() {
        match part {
            std::path::Component::Normal(p) => out.push(p),
            std::path::Component::RootDir | std::path::Component::CurDir => {}
            _ => return Err(format!("{}: a sudoers path with \"..\" is not followed", path.display())),
        }
    }
    Ok(out)
}

fn read_file(root: &Path, path: &Path, dir: &Path, depth: usize, seen: &mut HashSet<PathBuf>, out: &mut Vec<String>) -> Result<(), String> {
    if depth > MAX_DEPTH {
        return Err("sudoers includes nest deeper than eight".into());
    }
    let path = if path.is_absolute() { path.to_path_buf() } else { dir.join(path) };
    if !seen.insert(path.clone()) {
        return Ok(());
    }
    let real = under(root, &path)?;
    let text = std::fs::read_to_string(&real).map_err(|e| format!("{}: {e} (the helper reads sudoers to refuse root-capable accounts; run it with sudo)", real.display()))?;
    let parent = path.parent().unwrap_or(Path::new("/")).to_path_buf();
    for line in logical_lines(&text) {
        let directive = line.strip_prefix('@').or_else(|| line.strip_prefix('#'));
        if let Some(rest) = directive {
            if let Some(target) = rest.strip_prefix("includedir").filter(|r| r.starts_with(char::is_whitespace)) {
                read_dir(root, Path::new(target.trim()), &parent, depth + 1, seen, out)?;
                continue;
            }
            if let Some(target) = rest.strip_prefix("include").filter(|r| r.starts_with(char::is_whitespace)) {
                read_file(root, Path::new(target.trim()), &parent, depth + 1, seen, out)?;
                continue;
            }
        }
        out.push(line);
    }
    Ok(())
}

fn read_dir(root: &Path, path: &Path, dir: &Path, depth: usize, seen: &mut HashSet<PathBuf>, out: &mut Vec<String>) -> Result<(), String> {
    let path = if path.is_absolute() { path.to_path_buf() } else { dir.join(path) };
    let real = under(root, &path)?;
    let entries = match std::fs::read_dir(&real) {
        Ok(entries) => entries,
        // sudo ignores a missing include directory.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("{}: {e}", real.display())),
    };
    let mut names: Vec<String> = entries.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| !n.contains('.') && !n.ends_with('~')).collect();
    names.sort();
    for name in names {
        read_file(root, &path.join(&name), &path, depth, seen, out)?;
    }
    Ok(())
}

/// Lines with continuations joined and comments dropped. A `#` starts a
/// comment unless it begins an include directive or a uid (`#1000`).
fn logical_lines(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    for raw in text.lines() {
        if let Some(head) = raw.strip_suffix('\\') {
            current.push_str(head);
            current.push(' ');
            continue;
        }
        current.push_str(raw);
        let line = strip_comment(&current);
        if !line.is_empty() {
            out.push(line);
        }
        current.clear();
    }
    let line = strip_comment(&current);
    if !line.is_empty() {
        out.push(line);
    }
    out
}

fn strip_comment(line: &str) -> String {
    let trimmed = line.trim();
    if trimmed.starts_with("#include") {
        return trimmed.to_string();
    }
    let bytes = trimmed.as_bytes();
    let mut end = bytes.len();
    for (i, &b) in bytes.iter().enumerate() {
        if b == b'#' && !bytes.get(i + 1).is_some_and(u8::is_ascii_digit) {
            end = i;
            break;
        }
    }
    trimmed[..end].trim().to_string()
}

/// The comma-list before the host list: `"alice, %staff  ALL = …"` →
/// `["alice", "%staff"]`.
fn user_list(spec: &str) -> Vec<String> {
    let head = spec.split('=').next().unwrap_or("");
    let mut normalized = String::new();
    for part in head.split(',') {
        if !normalized.is_empty() {
            normalized.push(',');
        }
        normalized.push_str(part.trim());
    }
    normalized.split_whitespace().next().unwrap_or("").split(',').map(|t| t.trim().trim_start_matches('!').to_string()).filter(|t| !t.is_empty()).collect()
}

fn first_match(lines: &[String], who: &Subject<'_>) -> Option<String> {
    // User_Alias NAME = a, b : NAME2 = c
    let mut aliases: HashMap<String, Vec<String>> = HashMap::new();
    for line in lines {
        if let Some(rest) = line.strip_prefix("User_Alias") {
            for def in rest.split(':') {
                if let Some((name, members)) = def.split_once('=') {
                    aliases.insert(name.trim().to_string(), members.split(',').map(|m| m.trim().trim_start_matches('!').to_string()).filter(|m| !m.is_empty()).collect());
                }
            }
        }
    }
    let mut cache = HashMap::new();
    for line in lines {
        let keyword = line.split(|c: char| c.is_whitespace() || matches!(c, ':' | '@' | '>' | '!')).next().unwrap_or("");
        if matches!(keyword, "Defaults" | "User_Alias" | "Runas_Alias" | "Host_Alias" | "Cmnd_Alias" | "Cmd_Alias") || !line.contains('=') {
            continue;
        }
        if user_list(line).iter().any(|token| names(token, who, &aliases, &mut cache, 0)) {
            return Some(line.clone());
        }
    }
    None
}

fn names(token: &str, who: &Subject<'_>, aliases: &HashMap<String, Vec<String>>, cache: &mut HashMap<String, bool>, depth: usize) -> bool {
    if token == "ALL" || token == who.name || token == format!("#{}", who.uid) {
        return true;
    }
    // Netgroups and non-Unix groups cannot be resolved here: fail closed.
    if token.starts_with('+') || token.starts_with("%:") {
        return true;
    }
    if let Some(gid) = token.strip_prefix("%#") {
        return gid.parse::<u32>().map(|g| g == who.gid).unwrap_or(true);
    }
    if let Some(group) = token.strip_prefix('%') {
        return who.groups.iter().any(|g| g == group);
    }
    if let Some(members) = aliases.get(token) {
        if depth > MAX_DEPTH {
            return true;
        }
        if let Some(known) = cache.get(token) {
            return *known;
        }
        cache.insert(token.to_string(), false);
        let hit = members.iter().any(|m| names(m, who, aliases, cache, depth + 1));
        cache.insert(token.to_string(), hit);
        return hit;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(files: &[(&str, &str)]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for (path, text) in files {
            let full = dir.path().join(path.trim_start_matches('/'));
            std::fs::create_dir_all(full.parent().unwrap()).unwrap();
            std::fs::write(full, text).unwrap();
        }
        dir
    }

    const UBUNTU: &str = "Defaults env_reset\nDefaults:alice !lecture\n# User privilege specification\nroot\tALL=(ALL:ALL) ALL\n%admin ALL=(ALL) ALL\n%sudo   ALL=(ALL:ALL) ALL\n@includedir /etc/sudoers.d\n";

    fn alice(groups: &[String]) -> Subject<'_> {
        Subject { name: "alice", uid: 1001, gid: 1001, groups }
    }

    #[test]
    fn the_stock_file_grants_a_plain_user_nothing() {
        let root = fixture(&[("/etc/sudoers", UBUNTU), ("/etc/sudoers.d/README", "# nothing\n")]);
        let groups = vec!["alice".to_string(), "users_group".to_string()];
        assert_eq!(rule_for(root.path(), &alice(&groups)).unwrap(), None, "a Defaults:alice line grants nothing");
        let sudo = vec!["alice".to_string(), "sudo".to_string()];
        assert!(rule_for(root.path(), &alice(&sudo)).unwrap().unwrap().starts_with("%sudo"));
    }

    #[test]
    fn every_way_of_naming_the_account_counts() {
        let groups = vec!["alice".to_string(), "staff".to_string()];
        for rule in [
            "alice ALL=(root) NOPASSWD: /usr/bin/systemctl restart nginx",
            "bob, alice\thost1 = /bin/true",
            "bob ,alice ALL = ALL",
            "#1001 ALL=(ALL) ALL",
            "%staff ALL=(ALL) /usr/bin/apt",
            "%#1001 ALL=ALL",
            "User_Alias OPS = bob, %staff\nOPS ALL = ALL",
            "User_Alias INNER = alice\nUser_Alias OUTER = INNER, bob\nOUTER ALL = ALL",
            "ALL ALL=(ALL) NOPASSWD: /usr/bin/foo",
            "+admins ALL=ALL",
            "!alice ALL=ALL",
            "bob, \\\n  alice ALL = ALL",
        ] {
            let root = fixture(&[("/etc/sudoers", "root ALL=(ALL:ALL) ALL\n@includedir /etc/sudoers.d\n"), ("/etc/sudoers.d/ops", rule)]);
            assert!(rule_for(root.path(), &alice(&groups)).unwrap().is_some(), "{rule}");
        }
        // Not about alice: other users, aliases, defaults, hosts called alice.
        for rule in ["bob ALL=ALL", "User_Alias OPS = bob\nOPS ALL=ALL", "Defaults:alice env_keep += HOME", "Host_Alias alice = h1", "Cmnd_Alias X = /bin/ls # alice"] {
            let root = fixture(&[("/etc/sudoers", "root ALL=(ALL:ALL) ALL\n@includedir /etc/sudoers.d\n"), ("/etc/sudoers.d/ops", rule)]);
            assert_eq!(rule_for(root.path(), &alice(&groups)).unwrap(), None, "{rule}");
        }
    }

    #[test]
    fn includes_are_followed_and_skipped_like_sudo() {
        let groups = vec!["alice".to_string()];
        let root = fixture(&[
            ("/etc/sudoers", "#include /etc/sudoers.local\n#includedir /etc/sudoers.d\n"),
            ("/etc/sudoers.local", "@include extra\n"),
            ("/etc/extra", "alice ALL=ALL\n"),
        ]);
        assert!(rule_for(root.path(), &alice(&groups)).unwrap().is_some(), "a relative include is the including file's directory");
        let root = fixture(&[("/etc/sudoers", "@includedir /etc/sudoers.d\n"), ("/etc/sudoers.d/alice.bak", "alice ALL=ALL\n"), ("/etc/sudoers.d/alice~", "alice ALL=ALL\n")]);
        assert_eq!(rule_for(root.path(), &alice(&groups)).unwrap(), None, "sudo skips names with a dot or a tilde");
        let root = fixture(&[("/etc/sudoers", "@include /etc/sudoers\nalice ALL=ALL\n")]);
        assert!(rule_for(root.path(), &alice(&groups)).unwrap().is_some(), "a loop is read once");
    }

    #[test]
    fn what_cannot_be_read_refuses() {
        let groups = vec!["alice".to_string()];
        let empty = tempfile::tempdir().unwrap();
        assert!(rule_for(empty.path(), &alice(&groups)).is_err(), "no sudoers at all: fail closed");
        let root = fixture(&[("/etc/sudoers", "@include /etc/missing\n")]);
        assert!(rule_for(root.path(), &alice(&groups)).is_err());
        let root = fixture(&[("/etc/sudoers", "@include ../../outside\n")]);
        assert!(rule_for(root.path(), &alice(&groups)).is_err(), "never through ..");
        let root = fixture(&[("/etc/sudoers", "root ALL=ALL\n"), ("/etc/nsswitch.conf", "passwd: files\nsudoers: files sss\n")]);
        assert!(rule_for(root.path(), &alice(&groups)).unwrap_err().contains("sss"));
        let root = fixture(&[("/etc/sudoers", "root ALL=ALL\n"), ("/etc/nsswitch.conf", "sudoers: files\n")]);
        assert_eq!(rule_for(root.path(), &alice(&groups)).unwrap(), None);
    }
}
