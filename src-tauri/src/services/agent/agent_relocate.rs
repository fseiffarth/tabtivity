//! Taking an agent tab's conversation along to another worktree of its
//! project — the Reader's branch chip (`TerminalReaderFacts`): the window
//! stops the tab's CLI, this moves what the CLI needs to find the
//! conversation from the new folder, and the window respawns the tab there
//! on its resume args.
//!
//! What "moving" is depends on how the CLI finds a conversation again:
//!
//! - **By id, filed under the folder** — Claude keeps a session at
//!   `.claude/projects/<folder slug>/<uuid>.jsonl` (its subagents and tool
//!   results in `<uuid>/` beside it) and `--resume <uuid>` looks only under
//!   the slug of the folder it runs in. The tab's sessions (the hook-recorded
//!   live one and the launch one) are moved to the new folder's slug.
//! - **By id, anywhere** — Codex, Vibe and OpenCode resume the id their hook
//!   or plugin recorded whatever the folder: nothing to move.
//! - **The newest of the folder** — the "continue the latest" CLIs file a
//!   folder's conversations under an encoding of its path ([`FOLDER_STORES`],
//!   the layouts `services::agent_history` carries in a project bundle).
//!   The folder's newest conversation is moved: that is the one the tab's
//!   `--continue` comes back to, and the one its restart in the new folder
//!   then finds. Two tabs of one such CLI in one folder are not told apart,
//!   as on every restore.
//! - Antigravity, Copilot and Grok keep their conversations in a shape this
//!   cannot single out a folder's from: the tab starts a new one there
//!   ([`Moved::Fresh`]), and the old one stays with the old folder.
//!
//! Both folders are checked against the project's own record: the project
//! root or one of its linked worktrees (`<root>/.tabtivity/worktrees/<name>`,
//! the one place they live and the one place a restored agent tab keeps its
//! folder, `restoredAgentCwd`). Every move goes through `home_io` handles —
//! the home is the agent's to write — and never replaces anything.
//!
//! AppHandle-free.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::services::agent_history::{claude_folder_name, md5_hex, sha256_hex};
use crate::services::agent_session::{is_uuid_shaped, read_live_session_for};
use crate::services::git_bounded::BoundedOutput;
use crate::services::home_io::{HomeDir, HomeFile};

/// Whether the conversation comes along.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Moved {
    /// The tab's resume finds it from the new folder.
    Carried,
    /// The CLI starts a new conversation there; the old one stays behind.
    Fresh,
}

/// Whether `cmd` takes its conversation along (`Moved::Carried`) — the
/// picker says so before the switch. Mirrors `CARRIES_CONVERSATION` in
/// `lib/agents/agentWorktrees.ts`.
pub fn carries(cmd: &str) -> bool {
    matches!(cmd, "claude" | "codex" | "vibe" | "opencode") || FOLDER_STORES.iter().any(|s| s.cmd == cmd)
}

/// How a "continue the latest" CLI files one folder's conversations.
struct FolderStore {
    cmd: &'static str,
    /// Home-relative folder holding one folder per project path.
    base: &'static str,
    /// The per-path folder's name.
    encode: fn(&str) -> String,
    /// Where the conversations are inside it.
    sub: Option<&'static str>,
    /// A conversation is a folder (Cursor) or a file ending in this suffix.
    entry: Entry,
}

#[derive(Clone, Copy)]
enum Entry {
    Dir,
    File(&'static str),
}

/// Layouts from `services::agent_history` (Gemini and Qwen hash the path,
/// Cursor takes its MD5, Droid and Qwen's `projects/` a slug); none of them
/// verified against a live home.
const FOLDER_STORES: &[FolderStore] = &[
    FolderStore { cmd: "gemini", base: ".gemini/tmp", encode: sha256_hex, sub: Some("chats"), entry: Entry::File(".json") },
    FolderStore { cmd: "qwen", base: ".qwen/projects", encode: claude_folder_name, sub: Some("chats"), entry: Entry::File(".jsonl") },
    FolderStore { cmd: "qwen", base: ".qwen/tmp", encode: sha256_hex, sub: Some("chats"), entry: Entry::File(".json") },
    FolderStore { cmd: "cursor-agent", base: ".cursor/chats", encode: md5_hex, sub: None, entry: Entry::Dir },
    FolderStore { cmd: "droid", base: ".factory/sessions", encode: claude_folder_name, sub: None, entry: Entry::File(".jsonl") },
];

/// Droid keeps a session's autonomy level beside it, under the same stem.
const DROID_SETTINGS: &str = ".settings.json";

/// Move the conversation of the tab launched as `cmd` with launch id `uid` in
/// project `project_id` from the folder `from` to the folder `to`. The CLI
/// must not be running: the window stops it first.
pub fn move_session(cmd: &str, project_id: &str, uid: &str, from: &str, to: &str) -> Result<Moved, String> {
    if crate::services::remote::remote_target_for(project_id).is_some() {
        return Err("a remote project's agent tabs run in its mirror".into());
    }
    let root = crate::services::sandbox::project_dir_for(project_id).ok_or("unknown project")?;
    let (from, to) = (normal(from), normal(to));
    if !is_agent_folder(&root, &from) || !is_agent_folder(&root, &to) {
        return Err("not the project folder or one of its worktrees".into());
    }
    if !is_live_folder(&root, &to) {
        return Err("the worktree folder is gone, or git does not list it as a worktree".into());
    }
    if from == to {
        return Ok(Moved::Carried);
    }
    let home = crate::services::agent_home::scope_home(Some(project_id));
    move_in(&home, cmd, uid, &from, &to, |uid| read_live_session_for(Some(project_id), uid))
}

/// Testable core of [`move_session`]: `home` is the scope's agent home and
/// `live` maps a launch id to the hook-recorded live session id.
fn move_in(
    home: &Path,
    cmd: &str,
    uid: &str,
    from: &str,
    to: &str,
    live: impl Fn(&str) -> Option<String>,
) -> Result<Moved, String> {
    match cmd {
        "claude" => {
            if !is_uuid_shaped(uid) {
                return Err("no session id".into());
            }
            let mut ids = vec![uid.to_string()];
            if let Some(id) = live(uid).filter(|id| is_uuid_shaped(id) && id != uid) {
                ids.push(id);
            }
            move_claude(home, &ids, to).map_err(|e| format!("moving the session: {e}"))?;
            Ok(Moved::Carried)
        }
        "codex" | "vibe" | "opencode" => Ok(Moved::Carried),
        _ if carries(cmd) => {
            for store in FOLDER_STORES.iter().filter(|s| s.cmd == cmd) {
                if move_newest(home, store, from, to).map_err(|e| format!("moving the session: {e}"))? {
                    return Ok(Moved::Carried);
                }
            }
            // Nothing filed under the old folder: nothing the restart would
            // have resumed there either.
            Ok(Moved::Carried)
        }
        _ => Ok(Moved::Fresh),
    }
}

/// Claude: every `<id>.jsonl` (and `<id>/`) of `ids`, wherever it is filed,
/// into the slug folder of `to`.
fn move_claude(home: &Path, ids: &[String], to: &str) -> std::io::Result<()> {
    let Some(projects) = HomeDir::open_existing(home, ".claude/projects") else {
        return Ok(());
    };
    let target_name = claude_folder_name(to);
    for folder in projects.names() {
        if folder == target_name {
            continue;
        }
        let Some(dir) = projects.open_subdir(&folder) else { continue };
        for id in ids {
            for name in [format!("{id}.jsonl"), id.clone()] {
                let Some(file) = dir.file(&name) else { continue };
                if !file.metadata().is_some_and(|m| m.is_file || m.is_dir) {
                    continue;
                }
                let target = projects
                    .subdir(&target_name)
                    .ok_or_else(|| std::io::Error::other("the new folder's session folder"))?;
                file.move_into(&target)?;
            }
        }
    }
    Ok(())
}

/// A "continue the latest" CLI: the newest conversation filed under `from`
/// into `to`'s folder. `false` when `from` has none in this store.
fn move_newest(home: &Path, store: &FolderStore, from: &str, to: &str) -> std::io::Result<bool> {
    let rel = |path: &str| match store.sub {
        Some(sub) => format!("{}/{}/{sub}", store.base, (store.encode)(path)),
        None => format!("{}/{}", store.base, (store.encode)(path)),
    };
    let Some(source) = HomeDir::open_existing(home, &rel(from)) else {
        return Ok(false);
    };
    let Some(name) = newest_entry(&source, store.entry) else {
        return Ok(false);
    };
    let target = HomeDir::open(home, &rel(to)).ok_or_else(|| std::io::Error::other("the new folder's session folder"))?;
    source.file(&name).ok_or_else(|| std::io::Error::other("the session"))?.move_into(&target)?;
    if store.cmd == "droid" {
        if let Some(stem) = name.strip_suffix(".jsonl") {
            if let Some(settings) = source.file(&format!("{stem}{DROID_SETTINGS}")).filter(HomeFile::is_file) {
                settings.move_into(&target)?;
            }
        }
    }
    Ok(true)
}

/// The most recently written conversation in `dir`. Listed and dated by path
/// (the move itself goes through the handle, and refuses a link).
fn newest_entry(dir: &HomeDir, entry: Entry) -> Option<String> {
    dir.names()
        .into_iter()
        .filter_map(|name| {
            let meta = std::fs::symlink_metadata(dir.path().join(&name)).ok()?;
            let fits = match entry {
                Entry::Dir => meta.is_dir(),
                Entry::File(suffix) => meta.is_file() && name.ends_with(suffix) && !name.ends_with(DROID_SETTINGS),
            };
            if !fits {
                return None;
            }
            Some((meta.modified().ok()?, name))
        })
        .max()
        .map(|(_, name)| name)
}

/// `dir` without trailing separators.
fn normal(dir: &str) -> String {
    let trimmed = dir.trim_end_matches(['/', '\\']);
    if trimmed.is_empty() { dir.to_string() } else { trimmed.to_string() }
}

/// Whether `dir` is the project root `root` or one of its linked worktrees,
/// compared by components (no `..`, no other folder under the worktrees one).
fn is_agent_folder(root: &str, dir: &str) -> bool {
    let root = PathBuf::from(normal(root));
    let dir = Path::new(dir);
    if !dir.is_absolute() || crate::services::sandbox::has_dot_segment(&dir.to_string_lossy()) {
        return false;
    }
    if dir == root {
        return true;
    }
    let worktrees = crate::brand::WORKTREES_DIR.split('/').fold(root, |path, seg| path.join(seg));
    dir.parent() == Some(worktrees.as_path())
        && matches!(dir.file_name(), Some(name) if !name.is_empty())
}

/// Whether `dir` (already an [`is_agent_folder`]) is a real folder to move a
/// conversation into: the project root, or a worktree that is a plain directory
/// (the project folder is the agent's to write, so a link there proves
/// nothing) inside the root and a live entry of the root's `git worktree list`.
fn is_live_folder(root: &str, dir: &str) -> bool {
    let root = normal(root);
    if dir == root {
        return Path::new(dir).is_dir();
    }
    if !std::fs::symlink_metadata(dir).is_ok_and(|m| m.is_dir()) {
        return false;
    }
    let (Ok(real), Ok(real_root)) = (Path::new(dir).canonicalize(), Path::new(&root).canonicalize()) else {
        return false;
    };
    if !real.starts_with(&real_root) {
        return false;
    }
    // Background-grade (hookless) and bounded: the repo is untrusted.
    let listing = crate::services::git_hardened::hookless_git_command_in(&root, &["worktree", "list", "--porcelain"])
        .bounded_output();
    match listing {
        Ok(out) if out.status.success() => listed_worktree(&String::from_utf8_lossy(&out.stdout), &real),
        _ => false,
    }
}

/// Whether `real` (canonical) is a linked worktree in `git worktree list
/// --porcelain` output. The main worktree is not one: it is the root, handled
/// by the caller.
fn listed_worktree(porcelain: &str, real: &Path) -> bool {
    crate::services::git_worktrees::parse_worktree_porcelain(porcelain)
        .iter()
        .any(|w| !w.is_main && Path::new(&w.path).canonicalize().is_ok_and(|p| p == real))
}

#[cfg(test)]
mod tests {
    use super::*;

    const UID: &str = "11111111-2222-3333-4444-555555555555";
    const LIVE: &str = "66666666-7777-8888-9999-000000000000";

    fn abs(parts: &[&str]) -> PathBuf {
        let base = if cfg!(windows) { PathBuf::from(r"C:\") } else { PathBuf::from("/") };
        parts.iter().fold(base, |path, part| path.join(part))
    }

    fn worktree(root: &Path, name: &str) -> PathBuf {
        crate::brand::WORKTREES_DIR.split('/').fold(root.to_path_buf(), |path, seg| path.join(seg)).join(name)
    }

    #[test]
    fn only_the_root_and_its_worktrees_are_agent_folders() {
        let root = abs(&["home", "me", "proj"]);
        let r = root.to_string_lossy().to_string();
        assert!(is_agent_folder(&r, &r));
        assert!(is_agent_folder(&r, &worktree(&root, "feature").to_string_lossy()));
        assert!(!is_agent_folder(&r, &root.join("src").to_string_lossy()));
        assert!(!is_agent_folder(&r, &worktree(&root, "a").join("b").to_string_lossy()));
        assert!(!is_agent_folder(&r, &worktree(&root, "..").to_string_lossy()));
        assert!(!is_agent_folder(&r, &worktree(&root, ".").to_string_lossy()));
        assert!(!is_agent_folder(&r, &abs(&["home", "me", "other"]).to_string_lossy()));
        assert!(!is_agent_folder(&r, "relative"));
    }

    #[test]
    fn only_a_listed_linked_worktree_counts() {
        let tmp = tempfile::tempdir().unwrap();
        let main = tmp.path().join("main");
        let linked = tmp.path().join("linked");
        let stray = tmp.path().join("stray");
        for d in [&main, &linked, &stray] {
            std::fs::create_dir_all(d).unwrap();
        }
        let listing = format!(
            "worktree {}\nHEAD aaa\nbranch refs/heads/main\n\nworktree {}\nHEAD bbb\ndetached\n",
            main.display(),
            linked.display()
        );
        assert!(listed_worktree(&listing, &linked.canonicalize().unwrap()));
        assert!(!listed_worktree(&listing, &main.canonicalize().unwrap()));
        assert!(!listed_worktree(&listing, &stray.canonicalize().unwrap()));
    }

    #[cfg(unix)]
    #[test]
    fn a_link_or_an_unlisted_folder_is_not_a_worktree_to_move_into() {
        let git = |dir: &Path, args: &[&str]| {
            std::process::Command::new("git")
                .args(["-c", "user.name=t", "-c", "user.email=t@example.com"])
                .args(args)
                .current_dir(dir)
                .output()
        };
        if git(Path::new("."), &["--version"]).is_err() {
            eprintln!("git not on PATH — skipping");
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap().join("proj");
        std::fs::create_dir_all(&root).unwrap();
        assert!(git(&root, &["init", "-q"]).unwrap().status.success());
        assert!(git(&root, &["commit", "-q", "--allow-empty", "-m", "x"]).unwrap().status.success());
        let wt = worktree(&root, "real");
        std::fs::create_dir_all(wt.parent().unwrap()).unwrap();
        let added = git(&root, &["worktree", "add", "-q", "--detach", &wt.to_string_lossy()]).unwrap();
        assert!(added.status.success(), "{}", String::from_utf8_lossy(&added.stderr));
        let r = root.to_string_lossy().to_string();

        assert!(is_live_folder(&r, &r));
        assert!(is_live_folder(&r, &wt.to_string_lossy()));

        // A plain folder git does not list.
        let plain = worktree(&root, "plain");
        std::fs::create_dir_all(&plain).unwrap();
        assert!(!is_live_folder(&r, &plain.to_string_lossy()));

        // A link at the worktree's name, to the real one or to a stranger.
        let alias = worktree(&root, "alias");
        std::os::unix::fs::symlink(&wt, &alias).unwrap();
        assert!(!is_live_folder(&r, &alias.to_string_lossy()));
        let outside = tmp.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        let out_link = worktree(&root, "out");
        std::os::unix::fs::symlink(&outside, &out_link).unwrap();
        assert!(!is_live_folder(&r, &out_link.to_string_lossy()));

        // A removed worktree is gone.
        assert!(git(&root, &["worktree", "remove", "--force", &wt.to_string_lossy()]).unwrap().status.success());
        assert!(!is_live_folder(&r, &wt.to_string_lossy()));
    }

    #[test]
    fn claude_sessions_move_to_the_new_folders_slug() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        let root = abs(&["home", "me", "proj"]);
        let to = worktree(&root, "feature");
        let (from_s, to_s) = (root.to_string_lossy().to_string(), to.to_string_lossy().to_string());
        let old = home.join(".claude").join("projects").join(claude_folder_name(&from_s));
        std::fs::create_dir_all(old.join(LIVE).join("subagents")).unwrap();
        std::fs::write(old.join(format!("{UID}.jsonl")), "launch").unwrap();
        std::fs::write(old.join(format!("{LIVE}.jsonl")), "live").unwrap();
        std::fs::write(old.join("other.jsonl"), "someone else's").unwrap();

        let moved = move_in(home, "claude", UID, &from_s, &to_s, |_| Some(LIVE.to_string())).unwrap();
        assert_eq!(moved, Moved::Carried);
        let new = home.join(".claude").join("projects").join(claude_folder_name(&to_s));
        assert_eq!(std::fs::read_to_string(new.join(format!("{UID}.jsonl"))).unwrap(), "launch");
        assert_eq!(std::fs::read_to_string(new.join(format!("{LIVE}.jsonl"))).unwrap(), "live");
        assert!(new.join(LIVE).join("subagents").is_dir());
        assert!(!old.join(format!("{LIVE}.jsonl")).exists());
        assert!(old.join("other.jsonl").exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_linked_session_folder_is_not_followed() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let elsewhere = tmp.path().join("elsewhere");
        std::fs::create_dir_all(&elsewhere).unwrap();
        let root = abs(&["home", "me", "proj"]);
        let to = worktree(&root, "feature");
        let (from_s, to_s) = (root.to_string_lossy().to_string(), to.to_string_lossy().to_string());
        let projects = home.join(".claude").join("projects");
        std::fs::create_dir_all(projects.join(claude_folder_name(&from_s))).unwrap();
        std::fs::write(projects.join(claude_folder_name(&from_s)).join(format!("{UID}.jsonl")), "launch").unwrap();
        std::os::unix::fs::symlink(&elsewhere, projects.join(claude_folder_name(&to_s))).unwrap();

        assert!(move_in(&home, "claude", UID, &from_s, &to_s, |_| None).is_err());
        assert!(std::fs::read_dir(&elsewhere).unwrap().next().is_none());
        assert!(projects.join(claude_folder_name(&from_s)).join(format!("{UID}.jsonl")).exists());
    }

    #[test]
    fn a_continue_cli_takes_the_folders_newest_conversation() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        let root = abs(&["home", "me", "proj"]);
        let to = worktree(&root, "feature");
        let (from_s, to_s) = (root.to_string_lossy().to_string(), to.to_string_lossy().to_string());
        let old = home.join(".factory").join("sessions").join(claude_folder_name(&from_s));
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(old.join("a.jsonl"), "older").unwrap();
        let earlier = std::time::SystemTime::now() - std::time::Duration::from_secs(60);
        std::fs::File::options().write(true).open(old.join("a.jsonl")).unwrap().set_modified(earlier).unwrap();
        std::fs::write(old.join("b.jsonl"), "newest").unwrap();
        std::fs::write(old.join("b.settings.json"), "{}").unwrap();

        assert_eq!(move_in(home, "droid", UID, &from_s, &to_s, |_| None).unwrap(), Moved::Carried);
        let new = home.join(".factory").join("sessions").join(claude_folder_name(&to_s));
        assert_eq!(std::fs::read_to_string(new.join("b.jsonl")).unwrap(), "newest");
        assert!(new.join("b.settings.json").is_file());
        assert!(old.join("a.jsonl").is_file());
    }

    #[test]
    fn id_resuming_clis_carry_and_the_rest_start_fresh() {
        let tmp = tempfile::tempdir().unwrap();
        for cmd in ["codex", "vibe", "opencode"] {
            assert_eq!(move_in(tmp.path(), cmd, UID, "/a", "/b", |_| None).unwrap(), Moved::Carried);
        }
        for cmd in ["agy", "copilot", "grok"] {
            assert!(!carries(cmd));
            assert_eq!(move_in(tmp.path(), cmd, UID, "/a", "/b", |_| None).unwrap(), Moved::Fresh);
        }
    }
}
