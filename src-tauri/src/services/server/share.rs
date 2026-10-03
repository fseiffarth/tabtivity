//! Shared projects, the daemon's half (hosted plan §6.2–§6.6, P4a/P4b;
//! rationale in `docs/context/sharing.md`).
//!
//! The hub (`<slug>-hub`, `src-gateway/src/hub.rs`) owns every bare hub and
//! decides who may read and push by uid. This side:
//!
//! * **talks to the hub** on its socket ([`ask_at`]) — share ids, never paths;
//! * **keeps the user's own map** (`<state>/shares.json`): which local
//!   project is which share, so a revoked or deleted share stays a greyed
//!   row on this side, never a silent delete (§6.6);
//! * **pushes as bundles**: fetch the hub's refs, bundle what the hub lacks,
//!   send it with a compare-and-swap ref update. The owner moves its
//!   branch by name, an editor `refs/heads/<self>/<branch>` (§6.3);
//! * **clones to add** a share shared with this user: `git clone --no-local`
//!   from the hub into the projects root (the hub's files are another uid's,
//!   so never hardlinked), then the ordinary import path;
//! * **pins `safe.directory` to the exact hub** on every call that reads it
//!   ([`pin`]): the hub is owned by the hub's account, so git refuses it
//!   otherwise — and pinning it is safe only because no member can write a
//!   hub (§6.2 step 5). Never a global `*`;
//! * **keeps the in-tree session files out of every commit**: the app's
//!   folder goes into `.git/info/exclude` of the owner's repo and of every
//!   clone, and a push whose new commits carry it is refused;
//! * **hides other hubs from the fence** ([`fence_args`]): a tmpfs over the
//!   shared root, with only the scope's own project's hub bound back
//!   read-only (§6.3).
//!
//! Server mode only: on the desktop every entry point answers that sharing
//! needs a server.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::hub_wire::{self, RefUpdate, Reply, Request, Role, ShareInfo};
use crate::brand;

/// The remote name the hub has in the owner's repo and in every clone.
pub const REMOTE: &str = "shared";
pub const MAP_FILE: &str = "shares.json";
const TMP_DIR: &str = "share-tmp";
/// The hub's environment variable for its socket in tests (`<PREFIX>…`).
pub const HUB_SOCKET_ENV: &str = "SERVER_HUB_SOCKET";
/// The shared root, when not `/srv/<slug>/shared` (tests).
pub const SHARED_ROOT_ENV: &str = "SERVER_SHARED_ROOT";

pub fn hub_socket() -> PathBuf {
    brand::env(HUB_SOCKET_ENV)
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new("/run").join(brand::SLUG).join(hub_wire::SOCKET_NAME))
}

pub fn shared_root() -> PathBuf {
    brand::env(SHARED_ROOT_ENV)
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new("/srv").join(brand::SLUG).join("shared"))
}

/// Sharing needs the per-user daemon of a server.
pub fn require_server() -> Result<(), String> {
    if super::is_server() {
        Ok(())
    } else {
        Err("Sharing a project needs the hosted server".to_string())
    }
}

// ── The user's own map ─────────────────────────────────────────────────────

/// One local project that is a share, as this user knows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Link {
    pub share: String,
    /// `owner`, `editor` or `viewer`, as the hub last said.
    pub role: String,
    pub owner: String,
    pub hub: PathBuf,
    pub dir: PathBuf,
    /// `active`, `revoked` ("no longer shared") or `deleted` ("deleted by
    /// owner"). The local project is never removed by either.
    #[serde(default = "active")]
    pub state: String,
    /// Commits this user has reviewed the agent-facing files up to (§6.5
    /// gate 2): the owner's HEAD when sharing, each merge made after a
    /// review, each push of their own. Newest last, a few kept.
    #[serde(default)]
    pub reviewed: Vec<String>,
}

fn active() -> String {
    "active".into()
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Map {
    /// Project id → link.
    #[serde(default)]
    links: BTreeMap<String, Link>,
}

fn map_path(state_dir: &Path) -> PathBuf {
    state_dir.join(MAP_FILE)
}

fn load_map(state_dir: &Path) -> Map {
    std::fs::read(map_path(state_dir)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn save_map(state_dir: &Path, map: &Map) -> Result<(), String> {
    crate::services::mobile_control::store::write_json_atomic(&map_path(state_dir), map, 0o600)
}

/// The link of project `id`.
pub fn link_of(state_dir: &Path, id: &str) -> Option<Link> {
    load_map(state_dir).links.get(id).cloned()
}

/// The link whose project folder is `dir` or contains it.
pub fn link_for_dir(state_dir: &Path, dir: &Path) -> Option<Link> {
    let map = load_map(state_dir);
    map.links.values().find(|l| dir.starts_with(&l.dir)).cloned()
}

/// Is `dir` (or a folder above it) a project shared through a hub — the
/// owner's own or a member's clone? On a server only; the gates of §6.5
/// (hooks off, sanitizing that fails closed) key on it.
pub fn is_shared_dir(dir: &Path) -> bool {
    super::is_server() && link_for_dir(&crate::storage::state_dir(), dir).is_some()
}

fn set_link(state_dir: &Path, id: &str, link: Link) -> Result<(), String> {
    let mut map = load_map(state_dir);
    map.links.insert(id.to_string(), link);
    save_map(state_dir, &map)
}

fn drop_link(state_dir: &Path, id: &str) -> Result<(), String> {
    let mut map = load_map(state_dir);
    if map.links.remove(id).is_some() {
        save_map(state_dir, &map)?;
    }
    Ok(())
}

// ── The hub client ─────────────────────────────────────────────────────────

/// One request to the hub at `socket`, with a push's bundle after the line.
#[cfg(unix)]
pub fn ask_at(socket: &Path, request: &Request, bundle: Option<&Path>) -> Result<Reply, String> {
    use std::io::{Read, Write};
    let mut stream = std::os::unix::net::UnixStream::connect(socket).map_err(|e| format!("the share hub ({}): {e}", socket.display()))?;
    let deadline = if bundle.is_some() { std::time::Duration::from_secs(30 * 60) } else { std::time::Duration::from_secs(150) };
    stream.set_read_timeout(Some(deadline)).map_err(|e| e.to_string())?;
    stream.set_write_timeout(Some(deadline)).map_err(|e| e.to_string())?;
    let mut line = serde_json::to_vec(request).map_err(|e| e.to_string())?;
    line.push(b'\n');
    stream.write_all(&line).map_err(|e| format!("the share hub: {e}"))?;
    // The hub refuses a push before reading its bundle (a viewer's, an
    // oversized one) and closes: the upload then breaks, and the answer
    // already sent says why — read it rather than report the broken pipe.
    let mut upload = Ok(0);
    if let Some(path) = bundle {
        let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
        upload = std::io::copy(&mut file, &mut stream);
    }
    let _ = stream.shutdown(std::net::Shutdown::Write);
    let mut answer = Vec::new();
    let read = stream.take(hub_wire::MAX_LINE as u64 + 1).read_to_end(&mut answer);
    let end = answer.iter().position(|&b| b == b'\n').unwrap_or(answer.len());
    if end == 0 {
        if let Err(e) = upload {
            return Err(format!("the share hub: {e}"));
        }
        read.map_err(|e| format!("the share hub: {e}"))?;
        return Err("the share hub closed the connection without an answer".into());
    }
    serde_json::from_slice::<Reply>(&answer[..end]).map_err(|e| format!("the share hub's answer: {e}"))
}

#[cfg(not(unix))]
pub fn ask_at(_socket: &Path, _request: &Request, _bundle: Option<&Path>) -> Result<Reply, String> {
    Err("Sharing a project needs the hosted server".into())
}

/// A refusal of the hub, said in words.
pub fn explain(reply: &Reply) -> String {
    let refs = if reply.refs.is_empty() { String::new() } else { format!(" ({})", reply.refs.join(", ")) };
    match reply.error.as_deref().unwrap_or("failed") {
        "refused" => "The share hub does not serve this account".into(),
        "unknown-share" => "That share does not exist, or it is no longer shared with you".into(),
        "not-owner" => "Only the project's owner can do that".into(),
        "not-a-user" => "There is no server user by that name".into(),
        "sharing-off" => "The administrator has switched sharing projects off".into(),
        "ref-refused" => format!("Your role on this share may not move that branch{refs}"),
        "stale" => format!("The shared copy moved on meanwhile; fetch first{refs}"),
        "non-fast-forward" => format!("That push would rewrite history in the shared copy{refs}"),
        "bad-bundle" => format!("The share hub could not read what was sent{refs}"),
        "too-large" => "That push is larger than the share hub accepts".into(),
        "invalid" => "The share hub refused the request as malformed".into(),
        other => format!("The share hub could not do that ({other})"),
    }
}

fn expect_ok(reply: Reply) -> Result<Reply, String> {
    if reply.ok {
        Ok(reply)
    } else {
        Err(explain(&reply))
    }
}

// ── git, pinned to the hub ─────────────────────────────────────────────────

/// `-c safe.directory=<hub>`: the one repo of another uid this call may
/// read. The exact path, never `*`.
pub fn pin(hub: &Path) -> [String; 2] {
    ["-c".to_string(), format!("safe.directory={}", hub.display())]
}

fn git_in(dir: &Path, hub: Option<&Path>, args: &[&str]) -> Result<String, String> {
    let mut all: Vec<String> = hub.map(|h| pin(h).to_vec()).unwrap_or_default();
    all.extend(args.iter().map(|a| a.to_string()));
    let out = crate::commands::git::hookless_git_command_in(dir, &all).output().map_err(|e| format!("git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// Where a clone keeps the tips the hub's branches held before a fetch
/// moved them away (a forced move, a deleted branch): commits that came from
/// the hub stay known as such (§6.5 gate 2) after the remote-tracking ref
/// that named them is gone. One ref per commit, `<SEEN_NS><oid>`.
pub const SEEN_NS: &str = "refs/shared-seen/";

/// The remote-tracking refs of the hub: `(oid, name)`.
fn tracking_tips(dir: &Path) -> Result<Vec<(String, String)>, String> {
    let text = git_in(dir, None, &["for-each-ref", "--format=%(objectname) %(refname)", &format!("refs/remotes/{REMOTE}/")])?;
    Ok(text.lines().filter_map(|l| l.split_once(' ')).filter(|(oid, _)| hub_wire::valid_oid(oid)).map(|(oid, name)| (oid.to_string(), name.to_string())).collect())
}

/// Fetch every branch of the hub into `refs/remotes/<REMOTE>/*`. The tips
/// held before are first kept under [`SEEN_NS`], and only those the new
/// tips still reach are dropped again — so a co-member who deletes or
/// force-moves a branch after this user merged it cannot make its commits
/// look like this user's own (fails safe: an error leaves them kept).
pub fn fetch(dir: &Path, hub: &Path) -> Result<(), String> {
    let before = tracking_tips(dir)?;
    if !before.is_empty() {
        let tips: std::collections::BTreeSet<&str> = before.iter().map(|(oid, _)| oid.as_str()).collect();
        let script: String = tips.iter().map(|oid| format!("update {SEEN_NS}{oid} {oid}\n")).collect();
        git_stdin(dir, &["update-ref", "--stdin"], &script)?;
    }
    let hub_s = hub.to_string_lossy();
    let spec = format!("+refs/heads/*:refs/remotes/{REMOTE}/*");
    git_in(dir, Some(hub), &["fetch", "--quiet", "--prune", "--no-write-fetch-head", &hub_s, &spec])?;
    let after = tracking_tips(dir)?;
    if after.is_empty() {
        return Ok(());
    }
    // Every kept tip a current branch still reaches carries nothing new.
    let mut args = vec!["for-each-ref".to_string(), "--format=%(refname)".to_string()];
    args.extend(after.iter().map(|(_, name)| format!("--merged={name}")));
    args.push(SEEN_NS.to_string());
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let covered = git_in(dir, None, &args)?;
    let script: String = covered.lines().filter(|l| l.starts_with(SEEN_NS)).map(|name| format!("delete {name}\n")).collect();
    if !script.is_empty() {
        git_stdin(dir, &["update-ref", "--stdin"], &script)?;
    }
    Ok(())
}

/// [`git_in`] with `input` on stdin.
fn git_stdin(dir: &Path, args: &[&str], input: &str) -> Result<(), String> {
    use std::io::Write;
    let mut child = crate::commands::git::hookless_git_command_in(dir, args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("git: {e}"))?;
    child.stdin.take().ok_or("git: no stdin")?.write_all(input.as_bytes()).map_err(|e| format!("git: {e}"))?;
    let out = child.wait_with_output().map_err(|e| format!("git: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// Every commit this clone ever knew as a hub branch's tip: the
/// remote-tracking refs now, every value their reflogs recorded (a terminal
/// `git fetch` that force-moved one), and the tips [`fetch`] kept.
fn hub_revs(dir: &Path) -> Result<Vec<String>, String> {
    let mut revs = vec![format!("--remotes={REMOTE}"), format!("--glob={SEEN_NS}*")];
    let mut seen = std::collections::BTreeSet::new();
    for (_, name) in tracking_tips(dir)? {
        for oid in git_in(dir, None, &["reflog", "show", "--format=%H", &name])?.lines() {
            if hub_wire::valid_oid(oid) && seen.insert(oid.to_string()) {
                revs.push(oid.to_string());
            }
        }
    }
    Ok(revs)
}

/// Point the repo's `<REMOTE>` remote at the hub (for the user's own
/// terminal; Tabtivity always fetches by path with the pin).
fn set_remote(dir: &Path, hub: &Path) -> Result<(), String> {
    let hub_s = hub.to_string_lossy().into_owned();
    let key = format!("remote.{REMOTE}.url");
    match git_in(dir, None, &["config", "--get", &key]) {
        Ok(url) if url == hub_s => return Ok(()),
        // A hub this project was shared through before (stopped since): the
        // remote is the app's own, pointed at the new one.
        Ok(url) if Path::new(&url).parent().is_some_and(|p| Some(p) == hub.parent()) => {}
        Ok(url) if !url.is_empty() => return Err(format!("This repository already has a remote named '{REMOTE}' ({url})")),
        _ => {}
    }
    git_in(dir, None, &["config", &key, &hub_s])?;
    git_in(dir, None, &["config", &format!("remote.{REMOTE}.fetch"), &format!("+refs/heads/*:refs/remotes/{REMOTE}/*")]).map(|_| ())
}

/// Add the app's folder to the repo's own `info/exclude` (untracked,
/// repo-local): the in-tree session files never reach a commit.
pub fn exclude_app_dir(dir: &Path) -> Result<(), String> {
    let common = git_in(dir, None, &["rev-parse", "--git-common-dir"])?;
    let common = if Path::new(&common).is_absolute() { PathBuf::from(&common) } else { dir.join(&common) };
    let info = common.join("info");
    let file = info.join("exclude");
    let existing = std::fs::read_to_string(&file).unwrap_or_default();
    let rule = brand::PROJECT_DIR_EXCLUDE_RULE;
    if existing.lines().any(|l| l.trim() == rule) {
        return Ok(());
    }
    std::fs::create_dir_all(&info).map_err(|e| e.to_string())?;
    let mut next = existing;
    if !next.is_empty() && !next.ends_with('\n') {
        next.push('\n');
    }
    next.push_str(rule);
    next.push('\n');
    std::fs::write(&file, next).map_err(|e| e.to_string())
}

/// Paths under the app's folder that commits in `range` (rev-list args)
/// add or change.
fn session_paths_in(dir: &Path, range: &[&str]) -> Result<Vec<String>, String> {
    let mut args = vec!["log", "--format=", "--name-only"];
    args.extend_from_slice(range);
    args.extend_from_slice(&["--", brand::PROJECT_DIR]);
    let text = git_in(dir, None, &args)?;
    let mut paths: Vec<String> = text.lines().map(str::trim).filter(|l| !l.is_empty()).map(str::to_string).collect();
    paths.sort();
    paths.dedup();
    Ok(paths)
}

fn current_branch(dir: &Path) -> Result<String, String> {
    git_in(dir, None, &["symbolic-ref", "--quiet", "--short", "HEAD"]).map_err(|_| "The project is not on a branch (detached HEAD); check one out before pushing".to_string())
}

fn tmp_dir(state_dir: &Path) -> Result<PathBuf, String> {
    let dir = state_dir.join(TMP_DIR);
    crate::services::agent_home::create_private_dir(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    Ok(dir)
}

// ── Operations ─────────────────────────────────────────────────────────────

/// What a push did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pushed {
    /// The hub's branch that moved.
    pub branch: String,
    /// The commit it holds now.
    pub commit: String,
    /// Nothing to send: the hub already had it.
    pub unchanged: bool,
}

/// Push the checked-out branch to the hub: the owner by its own name, an
/// editor as `refs/heads/<user>/<branch>`. Refused for a viewer (the hub
/// refuses too), for a detached HEAD, and for commits that carry the app's
/// folder.
pub fn push_in(state_dir: &Path, socket: &Path, link: &Link, user: &str) -> Result<Pushed, String> {
    let role = match link.role.as_str() {
        "owner" => Role::Owner,
        "editor" => Role::Editor,
        _ => return Err("You can read this shared project but not push to it".into()),
    };
    if link.state != "active" {
        return Err("This project is no longer shared".into());
    }
    let dir = &link.dir;
    // A push marks what it sends as this user's own, reviewed work: so
    // nothing unreviewed from others may ride along.
    let pending = unreviewed(link)?;
    if !pending.is_empty() {
        return Err(format!("Review the agent instructions merged from other members first ({})", pending.join(", ")));
    }
    fetch(dir, &link.hub)?;
    let branch = current_branch(dir)?;
    let tip = git_in(dir, None, &["rev-parse", "--verify", "HEAD^{commit}"])?;
    let target = if role == Role::Owner { format!("refs/heads/{branch}") } else { hub_wire::member_branch(user, &branch) };
    if !hub_wire::valid_ref(&target) {
        return Err(format!("'{branch}' is not a branch name the share hub accepts"));
    }
    let tracking = format!("refs/remotes/{REMOTE}/{}", target.trim_start_matches("refs/heads/"));
    let old = git_in(dir, None, &["rev-parse", "--verify", "--quiet", &tracking]).unwrap_or_default();
    let old = if hub_wire::valid_oid(&old) { old } else { hub_wire::ZERO_OID.to_string() };
    if old == tip {
        return Ok(Pushed { branch: target, commit: tip, unchanged: true });
    }
    let not_remotes = format!("--remotes={REMOTE}");
    let carried = session_paths_in(dir, &[&tip, "--not", &not_remotes])?;
    if !carried.is_empty() {
        return Err(format!(
            "These commits carry the app's own session files ({}), which are never shared; remove them from the commits first",
            carried.join(", ")
        ));
    }
    let missing = git_in(dir, None, &["rev-list", "-n", "1", &tip, "--not", &not_remotes])?;
    let tmp = tmp_dir(state_dir)?;
    let bundle = tmp.join(format!("{}.bundle", crate::commands::projects::uuid_v4()));
    let _cleanup = Remove(bundle.clone());
    let bytes = if missing.is_empty() {
        0
    } else {
        let bundle_s = bundle.to_string_lossy().into_owned();
        git_in(dir, None, &["bundle", "create", "--quiet", &bundle_s, "HEAD", "--not", &not_remotes])?;
        std::fs::metadata(&bundle).map_err(|e| e.to_string())?.len()
    };
    let first = old == hub_wire::ZERO_OID && role == Role::Owner;
    let request = Request::Push {
        share: link.share.clone(),
        updates: vec![RefUpdate { name: target.clone(), old, new: tip.clone(), force: false }],
        bytes,
        head: first.then(|| target.clone()),
    };
    expect_ok(ask_at(socket, &request, (bytes > 0).then_some(bundle.as_path()))?)?;
    let _ = fetch(dir, &link.hub);
    // What this user pushed is their own work: reviewed by definition.
    mark_reviewed(state_dir, dir, &tip)?;
    Ok(Pushed { branch: target, commit: tip, unchanged: false })
}

struct Remove(PathBuf);

impl Drop for Remove {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// A hub branch against the checked-out one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchState {
    pub name: String,
    /// Commits it has that HEAD lacks.
    pub ahead: u32,
    /// Commits HEAD has that it lacks.
    pub behind: u32,
}

/// Fetch, then report each hub branch against HEAD — divergence is
/// reported, never resolved (§6.3, "no merge UI").
pub fn fetch_report(link: &Link) -> Result<Vec<BranchState>, String> {
    if link.state != "active" {
        return Err("This project is no longer shared".into());
    }
    fetch(&link.dir, &link.hub)?;
    let refs = git_in(&link.dir, None, &["for-each-ref", "--format=%(refname)", &format!("refs/remotes/{REMOTE}/")])?;
    let mut out = Vec::new();
    for name in refs.lines().filter(|l| !l.is_empty() && !l.ends_with("/HEAD")) {
        let counts = git_in(&link.dir, None, &["rev-list", "--left-right", "--count", &format!("{name}...HEAD")]).unwrap_or_default();
        let mut parts = counts.split_whitespace().map(|n| n.parse::<u32>().unwrap_or(0));
        let (ahead, behind) = (parts.next().unwrap_or(0), parts.next().unwrap_or(0));
        out.push(BranchState { name: name.trim_start_matches(&format!("refs/remotes/{REMOTE}/")).to_string(), ahead, behind });
    }
    Ok(out)
}

/// Make a share of a local git project: a hub, the `<REMOTE>` remote, the
/// app's folder excluded, the checked-out branch pushed.
pub fn create_in(state_dir: &Path, socket: &Path, project_id: &str, dir: &Path, name: &str, user: &str) -> Result<ShareInfo, String> {
    if let Some(old) = link_of(state_dir, project_id) {
        if old.state == "active" {
            return Err("This project is already shared".into());
        }
        // Sharing marks the owner's HEAD reviewed: never over changes from
        // the members of an earlier share that were not reviewed.
        let pending = unreviewed(&old)?;
        if !pending.is_empty() {
            return Err(format!("Review the agent instructions merged from other members first ({})", pending.join(", ")));
        }
    }
    if !dir.join(".git").exists() {
        return Err("Only a project with its own git repository can be shared".into());
    }
    current_branch(dir)?;
    git_in(dir, None, &["rev-parse", "--verify", "HEAD^{commit}"]).map_err(|_| "Make a first commit before sharing the project".to_string())?;
    let name: String = name.chars().filter(|c| !c.is_control()).take(hub_wire::MAX_NAME).collect::<String>().trim().to_string();
    let name = if name.is_empty() { "Project".to_string() } else { name };
    let share = expect_ok(ask_at(socket, &Request::Create { name }, None)?)?.share.ok_or("the share hub sent no share")?;
    let hub = PathBuf::from(&share.path);
    exclude_app_dir(dir)?;
    set_remote(dir, &hub)?;
    let head = git_in(dir, None, &["rev-parse", "HEAD"])?;
    let link = Link { share: share.id.clone(), role: "owner".into(), owner: user.to_string(), hub, dir: dir.to_path_buf(), state: active(), reviewed: vec![head] };
    set_link(state_dir, project_id, link.clone())?;
    push_in(state_dir, socket, &link, user)?;
    Ok(share)
}

/// Clone share `share` into a new folder under `parent` and return it; the
/// caller registers it as a project. The clone never hardlinks the hub's
/// objects (another uid's files) and runs no hook.
pub fn clone_into(parent: &Path, info: &ShareInfo) -> Result<PathBuf, String> {
    let hub = PathBuf::from(&info.path);
    let base = crate::commands::projects::sanitize_name(&info.name);
    let base = if base.is_empty() { "shared-project".to_string() } else { base };
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let mut dest = parent.join(&base);
    let mut n = 2;
    while std::fs::symlink_metadata(&dest).is_ok() {
        dest = parent.join(format!("{base}-{n}"));
        n += 1;
    }
    let hub_s = hub.to_string_lossy().into_owned();
    let dest_s = dest.to_string_lossy().into_owned();
    git_in(parent, Some(&hub), &["clone", "--quiet", "--no-local", "--template=", "--origin", REMOTE, &hub_s, &dest_s])?;
    if let Err(e) = exclude_app_dir(&dest) {
        let _ = std::fs::remove_dir_all(&dest);
        return Err(e);
    }
    Ok(dest)
}

/// The hub's view of this user's shares.
pub fn list_at(socket: &Path) -> Result<Vec<ShareInfo>, String> {
    Ok(expect_ok(ask_at(socket, &Request::List, None)?)?.shares)
}

/// One row of the Sharing panel.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareRow {
    pub id: String,
    pub name: String,
    pub owner: String,
    pub role: String,
    /// `active`, `revoked` ("no longer shared"), `deleted` ("deleted by owner").
    pub state: String,
    pub members: Vec<hub_wire::Member>,
    pub presence: Vec<hub_wire::Presence>,
    /// The local project this share is, when there is one.
    pub project_id: Option<String>,
    /// Agent-facing files in that project from others, not yet reviewed
    /// (filled by the caller; §6.5 gate 2).
    pub pending_review: Vec<String>,
}

/// Merge the hub's list with the local map: a share the hub no longer lists
/// for this user turns its local project into a "no longer shared" row; a
/// tombstone into "deleted by owner". Both are written back to the map, so
/// the project's gates still know it came from a share.
pub fn overview_in(state_dir: &Path, hub_shares: Vec<ShareInfo>) -> Result<Vec<ShareRow>, String> {
    let mut map = load_map(state_dir);
    let mut changed = false;
    let mut rows = Vec::new();
    let by_id: BTreeMap<String, ShareInfo> = hub_shares.into_iter().map(|s| (s.id.clone(), s)).collect();
    for (project, link) in map.links.iter_mut() {
        let state = match by_id.get(&link.share) {
            Some(info) if info.deleted.is_some() => "deleted",
            Some(info) => {
                if link.role != info.role {
                    link.role = info.role.clone();
                    changed = true;
                }
                "active"
            }
            None => "revoked",
        };
        if link.state != state {
            link.state = state.to_string();
            changed = true;
        }
        if !by_id.contains_key(&link.share) {
            rows.push(ShareRow { id: link.share.clone(), name: link.dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(), owner: link.owner.clone(), role: link.role.clone(), state: state.into(), members: Vec::new(), presence: Vec::new(), project_id: Some(project.clone()), pending_review: Vec::new() });
        }
    }
    if changed {
        save_map(state_dir, &map)?;
    }
    for info in by_id.into_values() {
        let project_id = map.links.iter().find(|(_, l)| l.share == info.id).map(|(p, _)| p.clone());
        rows.push(ShareRow {
            state: if info.deleted.is_some() { "deleted".into() } else { "active".into() },
            id: info.id,
            name: info.name,
            owner: info.owner,
            role: info.role,
            members: info.members,
            presence: info.presence,
            project_id,
            pending_review: Vec::new(),
        });
    }
    Ok(rows)
}

/// Record that `project_id` is share `info` (after a clone was registered).
pub fn adopt_in(state_dir: &Path, project_id: &str, info: &ShareInfo, dir: &Path) -> Result<(), String> {
    // Nothing of a fresh clone is reviewed: everything in it came from others.
    set_link(state_dir, project_id, Link { share: info.id.clone(), role: info.role.clone(), owner: info.owner.clone(), hub: PathBuf::from(&info.path), dir: dir.to_path_buf(), state: active(), reviewed: Vec::new() })
}

/// The owner deleted the share (or stopped sharing): forget the link.
pub fn forget_in(state_dir: &Path, project_id: &str) -> Result<(), String> {
    drop_link(state_dir, project_id)
}

/// Stop sharing `share` (the owner): the hub goes to its holding area, and
/// the owner's project forgets the link — unless changes from members are
/// in it unreviewed (or that cannot be checked): then the link stays, as
/// `deleted`, so gate 2 still holds until they are reviewed ([`accept_in`]
/// lets it go then).
pub fn stop_in(state_dir: &Path, socket: &Path, share: &str) -> Result<(), String> {
    expect_ok(ask_at(socket, &Request::Delete { share: share.to_string() }, None)?)?;
    for project in projects_of(state_dir, share) {
        let Some(link) = link_of(state_dir, &project) else { continue };
        if unreviewed(&link).map(|p| p.is_empty()).unwrap_or(false) {
            forget_in(state_dir, &project)?;
        } else {
            set_link(state_dir, &project, Link { state: "deleted".into(), ..link })?;
        }
    }
    Ok(())
}

/// The project ids whose links name `share`.
pub fn projects_of(state_dir: &Path, share: &str) -> Vec<String> {
    load_map(state_dir).links.into_iter().filter(|(_, l)| l.share == share).map(|(p, _)| p).collect()
}

// ── Gate 2: the agent-facing surface, reviewed before an agent reads it ────

/// Paths an agent CLI reads as instructions or configuration (§6.5 gate 2),
/// at any depth: the plan's `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`,
/// `.mcp.json`, `.envrc`, and everything under `.claude/`, `.codex/`,
/// `.gemini/`, `.cursor/` (Claude's `settings.json` hooks included) — and
/// the project files of the other CLIs Tabtivity launches: Claude's
/// `CLAUDE.local.md`, Codex's `AGENTS.override.md` and `.agents/` skills,
/// Antigravity's `.agent/`, Kiro's `.kiro/`, Cline's `.clinerules`,
/// Vibe's `.vibe/`, OpenCode's `opencode.json(c)` and `.opencode/`, Droid's
/// `.factory/`, Cursor's `.cursorrules`, Copilot's
/// `.github/copilot-instructions.md`, `.github/instructions/` and
/// `.github/agents/`.
pub const AGENT_PATHSPEC: &[&str] = &[
    ":(glob)**/CLAUDE.md",
    ":(glob)**/CLAUDE.local.md",
    ":(glob)**/AGENTS.md",
    ":(glob)**/AGENTS.override.md",
    ":(glob)**/GEMINI.md",
    ":(glob)**/.mcp.json",
    ":(glob)**/.envrc",
    ":(glob)**/.claude/**",
    ":(glob)**/.codex/**",
    ":(glob)**/.gemini/**",
    ":(glob)**/.cursor/**",
    ":(glob)**/.cursorrules",
    ":(glob)**/.agents/**",
    ":(glob)**/.agent/**",
    ":(glob)**/.kiro/**",
    ":(glob)**/.clinerules",
    ":(glob)**/.clinerules/**",
    ":(glob)**/.vibe/**",
    ":(glob)**/.opencode/**",
    ":(glob)**/opencode.json",
    ":(glob)**/opencode.jsonc",
    ":(glob)**/.factory/**",
    ":(glob)**/.github/copilot-instructions.md",
    ":(glob)**/.github/instructions/**",
    ":(glob)**/.github/agents/**",
];
/// Reviewed commits remembered per link.
const KEEP_REVIEWED: usize = 16;
/// The most diff text a review shows (and binds its digest to).
const MAX_REVIEW_BYTES: usize = 256 * 1024;

fn with_pathspec(mut args: Vec<&str>) -> Vec<&str> {
    args.push("--");
    args.extend_from_slice(AGENT_PATHSPEC);
    args
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// Every checked-out commit of the project's repository: the main working
/// tree's and each linked worktree's (the in-tree `.tabtivity/worktrees/`
/// ones, P5), as `(worktree dir, commit)`. A worktree on an unborn branch or
/// a detached one without a commit has none. The review gate covers all of
/// them: an agent can start in any, so what any of them holds counts.
pub fn checked_out(dir: &Path) -> Result<Vec<(PathBuf, String)>, String> {
    let listing = git_in(dir, None, &["worktree", "list", "--porcelain"])?;
    let mut heads = Vec::new();
    let mut current: Option<PathBuf> = None;
    for line in listing.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            current = Some(PathBuf::from(path));
        } else if let (Some(oid), Some(path)) = (line.strip_prefix("HEAD "), current.as_ref()) {
            if hub_wire::valid_oid(oid) && !oid.bytes().all(|b| b == b'0') {
                heads.push((path.clone(), oid.to_string()));
            }
        }
    }
    if heads.is_empty() {
        // `worktree list` names no HEAD on a repo with no commit yet.
        if let Ok(head) = git_in(dir, None, &["rev-parse", "--verify", "-q", "HEAD"]) {
            heads.push((dir.to_path_buf(), head));
        }
    }
    Ok(heads)
}

/// Agent-facing paths any checkout ([`checked_out`]) holds from commits
/// that came from the hub (a co-member's, or the owner's for a member) and
/// were never reviewed — however they got into HEAD (a Tabtivity merge, a
/// `git merge` in a terminal, the first clone), and wherever the hub's branch
/// that brought them is now ([`hub_revs`]). Errors fail closed at the caller.
pub fn unreviewed(link: &Link) -> Result<Vec<String>, String> {
    let dir = &link.dir;
    let not: Vec<String> = link.reviewed.iter().filter(|c| hub_wire::valid_oid(c)).map(|c| format!("^{c}")).collect();
    let not_refs: Vec<&str> = not.iter().map(String::as_str).collect();
    let heads = checked_out(dir)?;
    if heads.is_empty() {
        return Ok(Vec::new());
    }
    let mut head_args = vec!["rev-list", "--ignore-missing"];
    head_args.extend(heads.iter().map(|(_, oid)| oid.as_str()));
    head_args.extend(&not_refs);
    let in_head: std::collections::BTreeSet<String> = git_in(dir, None, &with_pathspec(head_args))?.lines().map(str::to_string).collect();
    if in_head.is_empty() {
        return Ok(Vec::new());
    }
    let hub_revs = hub_revs(dir)?;
    let mut hub_args = vec!["rev-list", "--ignore-missing"];
    hub_args.extend(hub_revs.iter().map(String::as_str));
    hub_args.extend(&not_refs);
    let from_hub: Vec<String> = git_in(dir, None, &with_pathspec(hub_args))?.lines().filter(|c| in_head.contains(*c)).map(str::to_string).collect();
    let mut paths = std::collections::BTreeSet::new();
    for commit in from_hub {
        // `-c`: a merge commit's own changes too (an "evil" merge whose
        // result matches neither parent); plain `diff-tree` lists nothing
        // for a merge.
        let changed = git_in(dir, None, &with_pathspec(vec!["diff-tree", "-c", "--root", "--no-commit-id", "--name-only", "-r", &commit]))?;
        paths.extend(changed.lines().filter(|l| !l.is_empty()).map(str::to_string));
    }
    Ok(paths.into_iter().collect())
}

fn mark_reviewed(state_dir: &Path, dir: &Path, commit: &str) -> Result<(), String> {
    let mut map = load_map(state_dir);
    let Some(link) = map.links.values_mut().find(|l| l.dir == dir) else { return Ok(()) };
    link.reviewed.retain(|c| c != commit);
    link.reviewed.push(commit.to_string());
    let excess = link.reviewed.len().saturating_sub(KEEP_REVIEWED);
    link.reviewed.drain(..excess);
    save_map(state_dir, &map)
}

/// Agent-facing changes awaiting this user's review.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    /// What a merge would bring in (`<REMOTE>/<branch>`), or the checked-out
    /// commit for a review of what is already there.
    pub commit: String,
    pub paths: Vec<String>,
    /// The changes as text (a diff, or the files' content), capped.
    pub text: String,
    pub truncated: bool,
    /// Binds an approval to exactly what was shown.
    pub digest: String,
}

fn review_of(commit: String, paths: Vec<String>, mut text: String) -> Review {
    let truncated = text.len() > MAX_REVIEW_BYTES;
    if truncated {
        let mut end = MAX_REVIEW_BYTES;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
    }
    let digest = sha256_hex(format!("{commit}\n{}\n{text}", paths.join("\n")).as_bytes());
    Review { commit, paths, text, truncated, digest }
}

/// What merging the hub's `branch` would change in agent-facing files —
/// shown before the merge (§6.5 gate 2).
pub fn review_merge(link: &Link, branch: &str) -> Result<Review, String> {
    if link.state != "active" {
        return Err("This project is no longer shared".into());
    }
    fetch(&link.dir, &link.hub)?;
    let tracking = format!("refs/remotes/{REMOTE}/{branch}");
    let commit = git_in(&link.dir, None, &["rev-parse", "--verify", &format!("{tracking}^{{commit}}")]).map_err(|_| format!("The shared project has no branch '{branch}'"))?;
    let range = format!("HEAD...{commit}");
    let paths: Vec<String> = git_in(&link.dir, None, &with_pathspec(vec!["diff", "--name-only", &range]))?.lines().filter(|l| !l.is_empty()).map(str::to_string).collect();
    let text = if paths.is_empty() { String::new() } else { git_in(&link.dir, None, &with_pathspec(vec!["diff", &range]))? };
    Ok(review_of(commit, paths, text))
}

/// Merge the hub's `branch` into the checked-out one — refused when it
/// changes agent-facing files and `digest` is not the review of exactly
/// those changes. Hookless (a shared clone runs none); a conflict is
/// aborted and reported, never resolved here. Trust-gated files a merge
/// changes (a `latexmkrc`, a prettier config) ask again at their next use,
/// because `exec_trust` approvals are bound to content.
pub fn merge_in(state_dir: &Path, link: &Link, branch: &str, digest: Option<&str>) -> Result<String, String> {
    let review = review_merge(link, branch)?;
    if !review.paths.is_empty() && digest != Some(review.digest.as_str()) {
        return Err(format!("Review the agent instructions this merge brings in first ({})", review.paths.join(", ")));
    }
    let dir = &link.dir;
    if let Err(e) = git_in(dir, None, &["merge", "--no-edit", "--no-verify", &review.commit]) {
        let _ = git_in(dir, None, &["merge", "--abort"]);
        return Err(format!("The merge did not go through and was undone; resolve it in a terminal or ask the other member ({e})"));
    }
    let head = git_in(dir, None, &["rev-parse", "HEAD"])?;
    // Reviewed: what was shown is now in HEAD.
    mark_reviewed(state_dir, dir, &head)?;
    if review.paths.is_empty() {
        // Nothing agent-facing came in, yet the commits did: remember the
        // merged commit too, so the next check does not walk them again.
        mark_reviewed(state_dir, dir, &review.commit)?;
    }
    Ok(head)
}

/// The agent-facing files of the checked-out commit that came from others
/// unreviewed (a fresh clone, a merge made outside the app), with their
/// current content.
pub fn pending_review(link: &Link) -> Result<Option<Review>, String> {
    let paths = unreviewed(link)?;
    if paths.is_empty() {
        return Ok(None);
    }
    // The files as every checkout holds them; a linked worktree's are named
    // by its folder. The review's `commit` lists them all, so accepting it
    // marks every one of them.
    let mut heads = checked_out(&link.dir)?;
    let mut seen = std::collections::BTreeSet::new();
    heads.retain(|(_, oid)| seen.insert(oid.clone()));
    let mut text = String::new();
    for (tree, head) in &heads {
        let label = if *tree == link.dir { String::new() } else { format!(" (worktree {})", tree.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()) };
        for path in &paths {
            let shown = git_in(&link.dir, None, &["show", &format!("{head}:{path}")]).unwrap_or_else(|_| "(removed)".to_string());
            text.push_str(&format!("── {path}{label} ──\n{shown}\n"));
        }
    }
    let commits: Vec<&str> = heads.iter().map(|(_, oid)| oid.as_str()).collect();
    Ok(Some(review_of(commits.join(" "), paths, text)))
}

/// The user reviewed [`pending_review`]: mark the checked-out commit.
pub fn accept_in(state_dir: &Path, link: &Link, digest: &str) -> Result<(), String> {
    if let Some(review) = pending_review(link)? {
        if review.digest != digest {
            return Err("The files changed after they were shown; review them again".into());
        }
        for commit in review.commit.split(' ').filter(|c| hub_wire::valid_oid(c)) {
            mark_reviewed(state_dir, &link.dir, commit)?;
        }
    }
    // An owner's link kept past a stopped share only for this review.
    if link.role == "owner" && link.state != "active" {
        let map = load_map(state_dir);
        if let Some((project, _)) = map.links.iter().find(|(_, l)| l.share == link.share && l.dir == link.dir) {
            return forget_in(state_dir, project);
        }
    }
    Ok(())
}

/// Refuse an agent spawn in a shared project whose agent-facing files hold
/// changes from others this user has not reviewed (§6.5 gate 2: "before B's
/// next agent spawn reads them"). Fails closed: a repo the check cannot
/// read refuses too. Nothing on the desktop.
pub fn spawn_gate_in(state_dir: &Path, roots: &[PathBuf], server: bool) -> Result<(), String> {
    if !server {
        return Ok(());
    }
    let map = load_map(state_dir);
    for link in map.links.values().filter(|l| roots.iter().any(|r| r.starts_with(&l.dir) || l.dir.starts_with(r))) {
        let name = link.dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        match unreviewed(link) {
            Ok(paths) if paths.is_empty() => {}
            Ok(paths) => {
                return Err(format!(
                    "The shared project '{name}' has agent instructions from other members you have not reviewed ({}); review them in Settings → Mobile → Server → Shared projects before starting an agent there",
                    paths.join(", ")
                ))
            }
            Err(e) => return Err(format!("The shared project '{name}' could not be checked for unreviewed agent instructions, so no agent starts there: {e}")),
        }
    }
    Ok(())
}

pub fn spawn_gate(roots: &[PathBuf]) -> Result<(), String> {
    spawn_gate_in(&crate::storage::state_dir(), roots, super::is_server())
}

// ── The fence ──────────────────────────────────────────────────────────────

/// bwrap arguments that hide every hub but the scope's own: a tmpfs over
/// the shared root, then each root's hub bound back read-only (§6.3). A
/// co-member of project X can then not steer this user's agent into
/// reading project Y, which this user shares with someone else. Nothing
/// on the desktop, or where the shared root does not exist.
pub fn fence_args(state_dir: &Path, shared_root: &Path, roots: &[PathBuf], server: bool) -> Vec<String> {
    if !server || !shared_root.is_dir() {
        return Vec::new();
    }
    let root_s = shared_root.to_string_lossy().into_owned();
    let mut args = vec!["--tmpfs".to_string(), root_s];
    let map = load_map(state_dir);
    let mut hubs: Vec<PathBuf> = map
        .links
        .values()
        .filter(|l| l.state == "active" && l.hub.starts_with(shared_root) && roots.iter().any(|r| r.starts_with(&l.dir) || l.dir.starts_with(r)))
        .map(|l| l.hub.clone())
        .collect();
    hubs.sort();
    hubs.dedup();
    for hub in hubs {
        let hub = hub.to_string_lossy().into_owned();
        args.extend(["--ro-bind-try".to_string(), hub.clone(), hub]);
    }
    args
}

/// [`fence_args`] for this process, spliced just before bwrap's `--`.
pub fn apply_fence(args: &mut Vec<String>, roots: &[PathBuf]) {
    let extra = fence_args(&crate::storage::state_dir(), &shared_root(), roots, super::is_server());
    if extra.is_empty() {
        return;
    }
    let separator = args.iter().position(|s| s == "--").unwrap_or(args.len());
    args.splice(separator..separator, extra);
}

#[cfg(test)]
mod tests;
