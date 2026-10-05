//! Git-aware local↔remote lockstep sync for SSH remote projects (TODO #28n, Phase 1).
//!
//! A remote project has **two real git working trees**: the local mirror
//! ([`remote_sync::mirror_dir`]) and the host tree at `spec.remote_path` (git run
//! over the shared ControlMaster via [`ssh_exec::run_git_remote`]). The selective/
//! auto file-sync (`services::sync_auto`) mirrors *bytes* and has no concept of git
//! branches, so a branch switch on either side rewrites many tracked files and would
//! be misread as edits and pushed. This module keeps the two repos in step
//! **semantically**: it transfers commits/refs with `git bundle` (which carries only
//! objects + the named refs — never `config`/hooks/reflogs/index/remotes/stashes/
//! worktree metadata) moved over the pooled SFTP session, then runs `git checkout`
//! on each side so each git materializes its own working tree.
//!
//! Phase 1 scope (this file): opt-in per project; bidirectional **fast-forward-only**
//! ref/commit transfer + missing-ref creation; coordinated checkout that pauses file
//! auto-sync and re-stamps its bases so checkout writes don't become false conflicts;
//! and **detection + display** of a desynchronized state (diverged history / dirty
//! peer). Full Use-local/Use-remote resolution with `refs/tabtivity/backup/*` and messy
//! initial-pairing authority are deferred to Phase 2/3.
//!
//! **Hardening (#28p).** Byte-sync (`sync_auto`) and this module are two transports
//! over the same two trees, and they used to be blind to each other. The invariant
//! that removes the whole bug class: **lockstep owns the git-tracked tree, byte-sync
//! owns everything else** ([`tracked_paths`], subtracted from the auto-sync candidate
//! set in `sync_auto::reconcile_pass`). Everything else here follows from two git
//! behaviours worth stating, because they are load-bearing and non-obvious:
//!
//! 1. `git merge --ff-only <sha>` **refuses** to overwrite an untracked working-tree
//!    file — *even when its bytes are identical* to the incoming blob (D1/D2).
//! 2. `git reset --hard <sha>` **silently clobbers** that same file (D3).
//!
//! (1) is why a file byte-synced ahead of its commit wedges the fast-forward that
//! would have delivered it — recovered by [`retry_ff_clearing_identical`], which only
//! ever deletes a file whose content is provably already in the incoming commit. (2)
//! is why initial pairing pre-checks for colliding, *differing* files
//! ([`pairing_collisions`]) instead of trusting `reset --hard` to be safe.
//!
//! **Every one of those writes can still make a local file disappear** — legitimately:
//! a fast-forward, a `reset --hard` and a checkout all delete the tracked files their
//! target commit doesn't carry, and the ff retry deletes untracked ones outright. That
//! is ordinary git, and (bar a failed retry) recoverable from git — but it happens in
//! the mirror, during background passes nobody asked for, and it used to happen in
//! silence. [`audit_local_head_move`] and its call sites file each one as a warning the
//! UI raises (`services::local_loss`, #28q).

/// Section separator for the batched probe script (ASCII RS — never in git output).
const RS: char = '\x1e';

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Output;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use notify::{RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, Mutex, Notify};
use tokio::time::MissedTickBehavior;

use crate::schema::net_usage;
use crate::schema::project::RemoteSpec;
use crate::services::local_loss;
use crate::services::remote::{remote_target_for, RemotePoolState};
use crate::services::remote_sync::{self, mirror_dir, mirror_local_path, SyncManifestState};
use crate::services::sftp;
use crate::services::ssh_exec;
use crate::services::sync_auto::AutoSyncState;

/// Host re-probe cadence while connected (the local side is caught near-instantly by
/// the `.git` watcher). A remote CLI checkout is picked up within this window.
const GIT_POLL_INTERVAL: Duration = Duration::from_secs(12);
/// Coalesce a burst of `.git` writes (a checkout touches HEAD + refs) into one pass.
const GIT_DEBOUNCE: Duration = Duration::from_millis(800);

// ── Types ───────────────────────────────────────────────────────────────────

/// A peer's HEAD: on a named branch, on a detached commit, or unborn (fresh repo).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum HeadRef {
    Branch { name: String, sha: String },
    Detached { sha: String },
    Unborn,
}

/// A `refs/heads/*` or `refs/tags/*` entry: short name + object sha.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RefEntry {
    pub name: String,
    pub sha: String,
}

/// A snapshot of one peer's git state (the inputs to `plan`/`decide`).
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerSnapshot {
    pub is_repo: bool,
    pub head: Option<HeadRef>,
    pub branches: Vec<RefEntry>,
    pub tags: Vec<RefEntry>,
    /// True only for staged/unstaged **tracked** changes (blocks a clean checkout);
    /// untracked/ignored files never count (they remain file-sync's domain).
    pub dirty_tracked: bool,
    /// True when the repo check could not be *executed* over an existing tree
    /// (git missing / spawn failure), as opposed to a clean "not a repo" answer.
    /// A side with `probe_error` must never be treated as an empty pairing dest —
    /// a transient failure must not license a `reset --hard` that wipes a real repo.
    pub probe_error: bool,
    /// Subject line of the commit at HEAD (#28p D8: shown in the desync bar so a
    /// Use-local/Use-remote choice is informed rather than blind).
    pub head_subject: Option<String>,
    /// Every branch this peer has checked out in **any** worktree, linked ones
    /// included (#23 D1).
    ///
    /// `head` alone answers only for the *main* worktree, so a branch checked out
    /// in a linked worktree looked to lockstep like an ordinary unattached ref —
    /// and every ref move for it went down the `update-ref` arm. `update-ref`,
    /// unlike `git branch -f`, does **not** refuse (verified: exit 0, no message),
    /// so the worktree's HEAD moved under it and its index was left claiming a
    /// staged modification that reverts the incoming change. Silent, and the
    /// commit UI's `git add -A` then commits the revert.
    ///
    /// Empty for a peer whose git is too old to have been asked, which reads as
    /// "no linked worktrees" — the pre-#23 behaviour, not a new failure mode.
    #[serde(default)]
    pub checked_out: Vec<String>,
}

/// Overall lockstep status for a project.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SyncStatus {
    Synchronized,
    Syncing,
    Desynchronized,
    /// The SSH pool is cold: nothing is known about the host, so nothing is claimed.
    /// #28p D4 — a dropped connection used to surface as `Ok(nonzero)` from every
    /// remote git command, which read as a *clean, legitimately empty host* and
    /// computed to `Synchronized`. Green pill, nothing done, and the same misread
    /// would route a misprobing host into a doomed pairing.
    Disconnected,
}

/// The files initial pairing refused to overwrite (#28p D3): paths that exist on the
/// would-be-`git init`ed dest and **differ** from the source's tracked content. Held
/// in the state so the UI can name them and offer an explicit confirmation, rather
/// than `reset --hard` destroying them with no backup and no prompt.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingConflict {
    /// True when the repo side (the authority) is the local mirror, i.e. the files at
    /// risk are the **host's**.
    pub source_is_local: bool,
    pub paths: Vec<String>,
}

/// Persisted per-project lockstep state (`git_peer.json`).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitPeerState {
    /// Opt-in toggle; when false the watcher/poll tasks never run.
    pub enabled: bool,
    pub status: SyncStatus,
    /// Human-readable reason when `status == Desynchronized`.
    pub detail: Option<String>,
    pub local_head: Option<HeadRef>,
    pub remote_head: Option<HeadRef>,
    pub last_sync_ts: Option<u64>,
    /// Subject lines of the two HEADs (#28p D8).
    #[serde(default)]
    pub local_subject: Option<String>,
    #[serde(default)]
    pub remote_subject: Option<String>,
    /// Set when pairing was refused because the empty side holds differing files
    /// (#28p D3). Cleared by any pass that pairs or finds no conflict.
    #[serde(default)]
    pub pairing_conflict: Option<PairingConflict>,
    /// Ref-set signatures of the last *completed* pass, per side (#28p D5 early-out):
    /// when neither side's refs (nor its tracked-dirty bit) moved and we were green,
    /// the whole bundle/transfer round trip is skipped and the cached status re-emitted.
    /// This is what stops a `git add` — which trips the `.git` watcher without moving
    /// HEAD — from costing a full network pass.
    #[serde(default)]
    pub local_sig: Option<String>,
    #[serde(default)]
    pub remote_sig: Option<String>,
}

impl Default for GitPeerState {
    fn default() -> Self {
        GitPeerState {
            enabled: false,
            status: SyncStatus::Synchronized,
            detail: None,
            local_head: None,
            remote_head: None,
            last_sync_ts: None,
            local_subject: None,
            remote_subject: None,
            pairing_conflict: None,
            local_sig: None,
            remote_sig: None,
        }
    }
}

/// The fast-forward classification for one branch that both peers know.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RefAction {
    /// Same sha on both sides.
    InSync,
    /// Dest lacks the branch entirely → create it (a trivial fast-forward).
    CreateOnDest,
    /// Dest's sha is an ancestor of the source's → dest can fast-forward.
    FastForwardDest,
    /// Source's sha is an ancestor of dest's → dest is ahead (the other direction handles it).
    DestAhead,
    /// Neither is an ancestor of the other → real divergence; never auto-applied.
    Diverged,
}

/// A tracked file changed by a checkout (`git diff --name-status <old> <new>`),
/// used to re-stamp the file-sync bases so the rewrite isn't seen as a conflict.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TrackedChange {
    pub path: String,
    pub deleted: bool,
}

/// Which peer a git command runs against.
// `Remote` is ~224 bytes wider than `Local`, and clippy suggests boxing it. It
// stays unboxed: a `Peer` is built a handful of times per sync pass and passed
// by reference thereafter, so the allocation and the extra indirection would
// cost more than the stack bytes they save.
#[allow(clippy::large_enum_variant)]
pub enum Peer {
    Local(PathBuf),
    Remote(RemoteSpec),
}

impl Peer {
    /// Run `git <args>` against this peer, returning the captured output (parsed
    /// byte-identically for both, exactly like `commands::git::run_git`).
    pub fn run(&self, args: &[&str]) -> Result<Output, String> {
        match self {
            // Hardened, hooks off: lockstep runs `status`/`checkout`/`merge`/
            // `commit` in the background, in a tree a fenced agent can write — its
            // `.git/config` and `.git/hooks/` included.
            // Bounded (#2349): a FIFO the agent planted must not hang lockstep.
            Peer::Local(dir) => {
                crate::services::git_bounded::output(crate::commands::git::hookless_git_command_in(dir, args))
            }
            Peer::Remote(spec) => {
                let owned: Vec<String> = args.iter().map(|s| s.to_string()).collect();
                ssh_exec::run_git_remote(spec, &owned)
            }
        }
    }
}

/// The subset of `shas` that `peer` actually has, in one round trip: `git rev-list
/// --no-walk --ignore-missing` echoes back every sha it can resolve and quietly drops
/// the rest. Any failure yields none of them — a full bundle is always correct, merely
/// larger, so this fails toward "exclude nothing".
///
/// An annotated tag's object sha resolves to the commit it points at rather than being
/// echoed verbatim, so it drops out of the result. That only forfeits a delta hint (a
/// bigger bundle), never correctness — which is the safe direction for the caller.
fn known_shas(peer: &Peer, shas: &[String]) -> Vec<String> {
    if shas.is_empty() {
        return Vec::new();
    }
    let mut args = vec!["rev-list", "--no-walk", "--ignore-missing"];
    args.extend(shas.iter().map(String::as_str));
    let Ok(out) = peer.run(&args) else {
        return Vec::new();
    };
    if !out.status.success() {
        return Vec::new();
    }
    let have: HashSet<String> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    shas.iter().filter(|s| have.contains(*s)).cloned().collect()
}

// ── Pure parsers (unit-tested; zero I/O) ────────────────────────────────────

/// Parse `git for-each-ref --format='%(objectname) %(refname:short)'` output into
/// `(short-name, sha)` entries. Blank/short lines are skipped.
pub fn parse_refs(stdout: &str) -> Vec<RefEntry> {
    stdout
        .lines()
        .filter_map(|line| {
            let (sha, name) = line.split_once(' ')?;
            let name = name.trim();
            if sha.is_empty() || name.is_empty() {
                return None;
            }
            Some(RefEntry {
                name: name.to_string(),
                sha: sha.to_string(),
            })
        })
        .collect()
}

/// Combine `git symbolic-ref --quiet --short HEAD` (branch, empty when detached)
/// and `git rev-parse --verify --quiet HEAD` (sha, empty on an unborn HEAD) into a
/// [`HeadRef`].
///
/// The sha must be a real object name or the head is [`HeadRef::Unborn`] — "not
/// empty" is NOT enough. A plain `git rev-parse HEAD` on an unborn repo prints the
/// literal string `HEAD` to **stdout** (and fails only via its exit status), so a
/// caller that forgets to check that status hands us `("master", "HEAD")`. Trusting
/// it built `Branch { name: "master", sha: "HEAD" }` — a branch that exists nowhere,
/// at a sha that is not a sha — which read as a legitimately-checked-out peer and so
/// masked the one state that actually needed repairing: a `git init`ed host that was
/// never checked out. Whatever the probe does, an unborn HEAD parses as unborn.
pub fn parse_head(symbolic: &str, rev: &str) -> HeadRef {
    let branch = symbolic.trim();
    let sha = rev.trim();
    if !is_hex_sha(sha) {
        HeadRef::Unborn
    } else if branch.is_empty() {
        HeadRef::Detached {
            sha: sha.to_string(),
        }
    } else {
        HeadRef::Branch {
            name: branch.to_string(),
            sha: sha.to_string(),
        }
    }
}

/// Whether `git status --porcelain` reports any **tracked** change. Untracked
/// entries (`??`) are ignored — they never block a checkout and belong to the
/// selective/auto file-sync engine.
pub fn is_dirty_tracked(porcelain: &str) -> bool {
    porcelain.lines().any(|line| {
        let line = line.trim_end_matches(['\r', '\n']);
        if line.len() < 2 {
            return false;
        }
        &line[..2] != "??"
    })
}

/// Classify how `dest` should move toward `source` for one branch, given the two
/// `merge-base --is-ancestor` bits computed on the side that has both commits.
/// `dest_sha == None` means the dest lacks the branch entirely.
pub fn decide(
    dest_sha: Option<&str>,
    source_sha: &str,
    dest_is_ancestor_of_source: bool,
    source_is_ancestor_of_dest: bool,
) -> RefAction {
    match dest_sha {
        None => RefAction::CreateOnDest,
        Some(d) if d == source_sha => RefAction::InSync,
        Some(_) => {
            if dest_is_ancestor_of_source {
                RefAction::FastForwardDest
            } else if source_is_ancestor_of_dest {
                RefAction::DestAhead
            } else {
                RefAction::Diverged
            }
        }
    }
}

/// Build `git bundle create <path> <positives...> [--not <excludes...>]`.
///
/// `positives` are the refs/shas to include (`--branches`/`--tags`/an explicit sha).
/// `excludes` are shas the receiver already has, making a thin delta bundle. We
/// **never** pass `--all` (which could rope in odd refs); the shape is asserted in
/// tests, and a bundle inherently carries only objects + the named refs — so
/// `config`/hooks/reflogs/remotes/stashes never travel.
pub fn bundle_create_args(path: &str, positives: &[&str], excludes: &[String]) -> Vec<String> {
    let mut v = vec!["bundle".to_string(), "create".to_string(), path.to_string()];
    v.extend(positives.iter().map(|s| s.to_string()));
    if !excludes.is_empty() {
        v.push("--not".to_string());
        v.extend(excludes.iter().cloned());
    }
    v
}

/// Whether a failed `git bundle create` failed only because there was nothing to
/// send — git's own "Refusing to create empty bundle" refusal — as opposed to a
/// genuine I/O failure (disk full, bad path, permission denied, ...). Load-bearing
/// for #28p D11: only the empty-bundle case may still let ref application proceed,
/// since only then does the dest already hold every object being pointed at. Pure.
fn is_empty_bundle_error(stderr: &str) -> bool {
    stderr.contains("Refusing to create empty bundle")
}

/// The two refspecs that import a bundle's refs into the receiver's isolated
/// `refs/tabtivity/incoming/*` namespace — never touching real `refs/heads`/`refs/tags`.
pub fn incoming_fetch_refspecs() -> [String; 2] {
    [
        format!("refs/heads/*:{}/heads/*", crate::brand::GIT_REF_INCOMING),
        format!("refs/tags/*:{}/tags/*", crate::brand::GIT_REF_INCOMING),
    ]
}

/// Parse `git diff --name-status <old> <new>` into per-file [`TrackedChange`]s.
/// Handles rename lines (`R100\told\tnew`) by taking the new path.
pub fn changed_tracked_paths(name_status: &str) -> Vec<TrackedChange> {
    name_status
        .lines()
        .filter_map(|line| {
            let mut cols = line.split('\t');
            let status = cols.next()?.trim();
            if status.is_empty() {
                return None;
            }
            let code = status.chars().next().unwrap_or(' ');
            // Renames/copies carry two paths; the last column is the current path.
            let path = cols.next_back()?.trim();
            if path.is_empty() {
                return None;
            }
            Some(TrackedChange {
                path: path.to_string(),
                deleted: code == 'D',
            })
        })
        .collect()
}

/// The distinct tracked files a set of applied branch moves changed on `dest`,
/// unioned across moves. Each move is `(old_tip, new_tip)`; a `None` old tip is
/// a fresh branch create, whose *whole* tree (`ls-tree -r`) is new. This feeds
/// the "files synced" metric (`net_usage`) so a lockstep transfer is counted
/// like a byte-sync one — without it the metric only ever reflected byte-sync
/// and read 0 after a lockstep seed (e.g. extend-to-remote). Tags are excluded
/// by the caller: their file content is already counted via the branch that
/// carries the commit. Best-effort — a git failure for one move contributes
/// nothing rather than aborting the count.
fn files_changed_by_moves(dest: &Peer, moves: &[(Option<String>, String)]) -> usize {
    let mut paths: HashSet<String> = HashSet::new();
    for (old, new) in moves {
        let out = match old {
            Some(old) => dest.run(&["diff", "--name-only", old, new]),
            None => dest.run(&["ls-tree", "-r", "--name-only", new]),
        };
        if let Ok(o) = out {
            if o.status.success() {
                for line in String::from_utf8_lossy(&o.stdout).lines() {
                    let p = line.trim();
                    if !p.is_empty() {
                        paths.insert(p.to_string());
                    }
                }
            }
        }
    }
    paths.len()
}

/// A timestamped safety-ref name for a to-be-overwritten branch (Phase 2 uses it to
/// back up the losing side before a reset; Phase 1 only names it).
pub fn backup_ref_name(branch_short: &str, now_secs: u64) -> String {
    format!("{}/{now_secs}/{branch_short}", crate::brand::GIT_REF_BACKUP)
}

/// The ref a diverged branch's *peer* tip is parked at on this side (#28p D8), so the
/// user can `git merge`/`rebase` it by hand in a terminal instead of being limited to
/// pick-a-winner. The objects are already local (the bundle brought them), so keeping
/// the ref is free.
pub fn peer_ref_name(branch_short: &str) -> String {
    format!("{}/{branch_short}", crate::brand::GIT_REF_PEER)
}

/// What to do with a branch's `refs/tabtivity/peer/*` ref after classifying it (#28p D8):
/// park the peer tip only while the branch is genuinely diverged and unresolved;
/// otherwise clear a stale one so the ref never outlives the divergence it documents.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PeerRefOp {
    Set,
    Delete,
}

/// See [`PeerRefOp`]. A forced pass (Use-local/Use-remote) *resolves* the divergence,
/// so it clears the peer ref rather than parking one.
pub fn peer_ref_op(action: RefAction, force: bool) -> PeerRefOp {
    match action {
        RefAction::Diverged if !force => PeerRefOp::Set,
        _ => PeerRefOp::Delete,
    }
}

/// Whether applying `action` would write the dest's ref at all — the gate for the
/// linked-worktree block (#23 D1). A create or fast-forward always writes; a divergence
/// or a dest-ahead branch is only written under a forced resolution — otherwise the
/// first is reported and the second is the *other* leg's fast-forward. Pure.
pub fn would_move_ref(action: RefAction, force: bool) -> bool {
    match action {
        RefAction::InSync => false,
        RefAction::CreateOnDest | RefAction::FastForwardDest => true,
        RefAction::DestAhead | RefAction::Diverged => force,
    }
}

/// Undo git's C-style path quoting (`core.quotePath`): a path containing non-ASCII,
/// a quote, or a control char is printed wrapped in `"` with `\`-escapes. Plain paths
/// (including ones with spaces) are printed bare and pass through unchanged.
pub fn unquote_git_path(raw: &str) -> String {
    let inner = match raw.strip_prefix('"').and_then(|s| s.strip_suffix('"')) {
        Some(i) => i,
        None => return raw.to_string(),
    };
    let mut out: Vec<u8> = Vec::with_capacity(inner.len());
    let bytes = inner.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'\\' || i + 1 >= bytes.len() {
            out.push(bytes[i]);
            i += 1;
            continue;
        }
        let c = bytes[i + 1];
        match c {
            b'n' => {
                out.push(b'\n');
                i += 2;
            }
            b't' => {
                out.push(b'\t');
                i += 2;
            }
            b'r' => {
                out.push(b'\r');
                i += 2;
            }
            b'0'..=b'7' => {
                // Octal escape (\303\251 → the two UTF-8 bytes of "é").
                let end = (i + 4).min(bytes.len());
                match u8::from_str_radix(&inner[i + 1..end], 8) {
                    Ok(b) => {
                        out.push(b);
                        i = end;
                    }
                    Err(_) => {
                        out.push(bytes[i]);
                        i += 1;
                    }
                }
            }
            // `\"`, `\\`, and anything else: the escaped byte stands for itself.
            _ => {
                out.push(c);
                i += 2;
            }
        }
    }
    String::from_utf8_lossy(&out).to_string()
}

/// The paths git names in
/// `error: The following untracked working tree files would be overwritten by merge:`
/// — the real cause of most blocked fast-forwards (#28p D1/D2), and the input to the
/// identical-content retry. The list is TAB-indented and terminated by git's
/// "Please move or remove them…" line. Pure.
pub fn parse_untracked_overwrite_paths(stderr: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut in_list = false;
    for line in stderr.lines() {
        if line.contains("untracked working tree files would be overwritten") {
            in_list = true;
            continue;
        }
        if !in_list {
            continue;
        }
        // The list is the run of indented lines; anything else ends it.
        let trimmed = line.trim_start_matches(['\t', ' ']);
        if trimmed.len() == line.len() || trimmed.is_empty() {
            break;
        }
        out.push(unquote_git_path(trimmed.trim_end()));
    }
    out
}

/// The `Desynchronized` detail for a fast-forward git refused to perform (#28p D2).
/// The old message always read "A peer has uncommitted changes" — but the cause is
/// usually *untracked* collisions, and the stderr naming the files was thrown away,
/// sending users hunting for uncommitted changes that do not exist. Pure.
pub fn blocked_detail(branch: &str, stderr: &str) -> String {
    let untracked = parse_untracked_overwrite_paths(stderr);
    if !untracked.is_empty() {
        let shown: Vec<&str> = untracked.iter().take(3).map(String::as_str).collect();
        let more = untracked.len() - shown.len();
        let extra = if more > 0 {
            format!(" (+{more} more)")
        } else {
            String::new()
        };
        return format!(
            "'{branch}' can't fast-forward: untracked file(s) on the peer differ from the incoming commit: {}{extra}",
            shown.join(", ")
        );
    }
    let first = stderr
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("the peer has uncommitted changes");
    format!("'{branch}' can't fast-forward: {first}")
}

// ── Batched probe (#28p D5) ─────────────────────────────────────────────────

/// One `sh` script emitting every field [`probe`] needs, as `\x1e`-separated sections
/// — replacing **7 SSH round trips with 1**. Sections, in order: the literal `repo`
/// marker, `symbolic-ref HEAD`, `rev-parse HEAD`, branches, tags, `status --porcelain`,
/// HEAD's subject, `worktree list --porcelain`. A non-repo emits the single token
/// `norepo`.
///
/// The worktree section is the whole of the #23 D1 fix and costs nothing extra here:
/// `symbolic-ref HEAD` answers only for the **main** worktree, so without it a branch
/// checked out in a *linked* worktree is invisible and every ref move for it takes the
/// `update-ref` arm, which does not refuse.
///
/// Contains no interpolation: it is a constant, so there is nothing here to inject
/// into (the only variable — the project's remote path — is `shell_quote`d by
/// [`ssh_exec::run_remote_script`], which `cd`s to it).
/// The batched host probe. Its **output** is its answer; its **exit status** means only
/// "the probe ran" — hence the trailing `|| true`, which must stay on whatever command
/// ends up last. An unborn repo makes `git log HEAD` exit 128, and letting that escape
/// would make a legitimately-empty side indistinguishable from a probe that could not run
/// at all — the one confusion that must never happen here, since "could not run" is what
/// withholds a `reset --hard`.
///
/// Every `rev-parse` inside must likewise report an unborn HEAD by *printing nothing*
/// (`--verify --quiet`), not by exiting non-zero: a bare `git rev-parse HEAD` prints the
/// literal `HEAD` to stdout and fails only in its status, which this script discards.
const PROBE_SCRIPT: &str = "\
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then \
printf 'repo\\036'; \
git symbolic-ref --quiet --short HEAD 2>/dev/null; printf '\\036'; \
git rev-parse --verify --quiet HEAD 2>/dev/null; printf '\\036'; \
git for-each-ref --format='%(objectname) %(refname:short)' refs/heads 2>/dev/null; printf '\\036'; \
git for-each-ref --format='%(objectname) %(refname:short)' refs/tags 2>/dev/null; printf '\\036'; \
git status --porcelain 2>/dev/null; printf '\\036'; \
git log -1 --format=%s HEAD 2>/dev/null; printf '\\036'; \
git worktree list --porcelain 2>/dev/null || true; \
else printf 'norepo'; fi";

/// Parse [`PROBE_SCRIPT`]'s output into a snapshot. `None` means the output was not
/// recognizable (a host with no POSIX `sh`, or a link that died mid-script), which
/// makes the caller fall back to the per-command probe. Pure.
pub fn parse_probe_block(stdout: &str) -> Option<PeerSnapshot> {
    if stdout.trim_start().starts_with("norepo") {
        return Some(PeerSnapshot::default());
    }
    let rest = stdout.trim_start().strip_prefix("repo")?.strip_prefix(RS)?;
    let parts: Vec<&str> = rest.split(RS).collect();
    // Tolerate a truncated tail (an older git printing nothing for a section still
    // emits its separator; a missing trailing section is not fatal).
    if parts.len() < 5 {
        return None;
    }
    Some(PeerSnapshot {
        is_repo: true,
        head: Some(parse_head(parts[0], parts[1])),
        branches: parse_refs(parts[2]),
        tags: parse_refs(parts[3]),
        dirty_tracked: is_dirty_tracked(parts[4]),
        probe_error: false,
        head_subject: parts
            .get(5)
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
        // Absent on a git too old to list worktrees → an empty set, i.e. "nothing
        // linked", which is the pre-#23 reading and never a false *block*.
        checked_out: parts
            .get(6)
            .map(|s| checked_out_branches(s))
            .unwrap_or_default(),
    })
}

/// The branches a peer has checked out in a **linked** worktree — i.e. everything
/// in `checked_out` that is not the main worktree's own HEAD (#23 D1).
///
/// This is the set no ref move may touch. The main worktree's branch is excluded
/// because it is already handled, and handled *correctly*: it takes the
/// `merge --ff-only` / `reset --hard` arm, which moves the working tree with the
/// ref and refuses on a dirty tree. It is every *other* checkout that fell
/// through to bare `update-ref`, which moves the ref and leaves the tree behind.
/// Pure.
pub fn linked_checkout_branches(snap: &PeerSnapshot) -> std::collections::HashSet<&str> {
    let head = match &snap.head {
        Some(HeadRef::Branch { name, .. }) => Some(name.as_str()),
        _ => None,
    };
    snap.checked_out
        .iter()
        .map(String::as_str)
        .filter(|b| head != Some(*b))
        .collect()
}

/// The branches checked out across a peer's worktrees, from `git worktree list
/// --porcelain`. Reuses `commands::git`'s parser so the two readings of the same
/// output cannot drift. Pure.
pub fn checked_out_branches(porcelain: &str) -> Vec<String> {
    crate::commands::git::parse_worktree_porcelain(porcelain)
        .into_iter()
        .filter(|w| !w.branch.is_empty())
        .map(|w| w.branch)
        .collect()
}

/// Whether a string is a plain hex object name — the guard that lets [`ancestry_script`]
/// interpolate shas into a shell script at all.
fn is_hex_sha(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.chars().all(|c| c.is_ascii_hexdigit())
}

/// One script running every branch's two `merge-base --is-ancestor` checks (#28p D5),
/// collapsing `2·N` round trips into 1. Emits one `01`/`10`/`00`/`11` line per pair, in
/// order: `<dest is ancestor of source><source is ancestor of dest>`. Callers must pass
/// hex shas only ([`is_hex_sha`]); nothing else is ever interpolated. Pure.
pub fn ancestry_script(pairs: &[(String, String)]) -> String {
    let mut s = String::new();
    for (dst, src) in pairs {
        s.push_str(&format!(
            "if git merge-base --is-ancestor {dst} {src} 2>/dev/null; then printf 1; else printf 0; fi; \
             if git merge-base --is-ancestor {src} {dst} 2>/dev/null; then printf '1\\n'; else printf '0\\n'; fi; "
        ));
    }
    s
}

/// Parse [`ancestry_script`]'s output into `(dest_is_ancestor_of_source,
/// source_is_ancestor_of_dest)` per pair. `None` when the line count doesn't match the
/// pairs asked about — the caller then falls back to per-branch checks rather than
/// trusting a misaligned answer (a wrong bit here would misclassify a divergence). Pure.
pub fn parse_ancestry_block(stdout: &str, expected: usize) -> Option<Vec<(bool, bool)>> {
    let v: Vec<(bool, bool)> = stdout
        .lines()
        .map(str::trim)
        .filter(|l| l.len() == 2 && l.chars().all(|c| c == '0' || c == '1'))
        .map(|l| (l.starts_with('1'), l.ends_with('1')))
        .collect();
    (v.len() == expected).then_some(v)
}

/// A compact signature of everything about a peer that can make a pass necessary: its
/// refs, its HEAD, and whether its tracked tree is dirty (a dirty→clean transition can
/// unblock a fast-forward, so it must not be invisible). Pure.
pub fn refs_signature(snap: &PeerSnapshot) -> String {
    if !snap.is_repo {
        return String::new();
    }
    let mut refs: Vec<String> = snap
        .branches
        .iter()
        .map(|r| format!("h{}={}", r.name, r.sha))
        .chain(snap.tags.iter().map(|r| format!("t{}={}", r.name, r.sha)))
        .collect();
    refs.sort();
    format!(
        "{}|{}|{}",
        refs.join(";"),
        match &snap.head {
            Some(HeadRef::Branch { name, sha }) => format!("b:{name}:{sha}"),
            Some(HeadRef::Detached { sha }) => format!("d:{sha}"),
            _ => "u".to_string(),
        },
        snap.dirty_tracked as u8
    )
}

/// The two peers' refs all match, but their HEADs point somewhere different — same
/// history, different working state. Lockstep's promise is that both sides sit on the
/// *same* commit, so this is not green. Pure; `None` means "in step".
///
/// `reconcile_with` otherwise compares only **refs**, and refs are identical in exactly
/// the situations this catches:
///   * a coordinated checkout that only half-landed — the peer's guarded checkout was
///     refused because its tree was dirty (case 19) — and the user then clears the dirt
///     and hits Retry. No ref moved, so nothing looked wrong, and the peer was left on
///     the old branch under a green pill.
///   * any peer HEAD move the event-driven detection missed.
///
/// Deliberately *reports* rather than auto-checking-out: with no observed move there is
/// no principled way to say which side should follow the other, and lockstep never
/// rewrites a worktree it wasn't asked to. The Checkout action is one click away.
pub fn head_mismatch(local: &PeerSnapshot, remote: &PeerSnapshot) -> Option<String> {
    let describe = |h: &HeadRef| match h {
        HeadRef::Branch { name, .. } => format!("'{name}'"),
        HeadRef::Detached { sha } => {
            format!("detached at {}", sha.chars().take(8).collect::<String>())
        }
        HeadRef::Unborn => "an unborn branch".to_string(),
    };
    match (&local.head, &remote.head) {
        (Some(l), Some(r)) if l != r => Some(format!(
            "Out of step: the mirror is on {}, the host is on {}",
            describe(l),
            describe(r)
        )),
        _ => None,
    }
}

/// Whether a side is **seeded**: a repo whose HEAD is *born* — some commit is actually
/// checked out. A bare `git init` is a repo but is NOT seeded: nothing has ever been
/// written to its working tree.
///
/// This, not [`PeerSnapshot::is_repo`], is what initial pairing keys on, because
/// `git init` is pairing's own *first step*. A seed that dies after it (a link that
/// drops mid-bundle) leaves a dest that is a repo, holds no commit, and has an empty
/// working tree. Under an `is_repo` gate that state is unrepairable: "exactly one side
/// is a repo" never fires again, and the steady-state path only ever moves refs
/// (`update-ref`) — it never positions HEAD or checks anything out, since that is
/// [`init_pairing`]'s exclusive job. Refs and objects land, the tree stays empty, and
/// the pill reports an eternal head mismatch against a branch nobody has. Keying on
/// "has a commit checked out" makes a half-seeded side simply *unpaired*, so the next
/// pass finishes what the dropped one started. Pure.
pub fn is_seeded(snap: &PeerSnapshot) -> bool {
    snap.is_repo
        && matches!(
            snap.head,
            Some(HeadRef::Branch { .. }) | Some(HeadRef::Detached { .. })
        )
}

/// What a pass should do with the two sides — the gate `reconcile` runs on. Pure.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PairPlan {
    /// Both sides seeded → the ordinary bidirectional transfer.
    Sync,
    /// Exactly one side seeded → initialize the other from it. `source_is_local` names
    /// the authority; the *other* side is the one `git init` + `reset --hard` touches.
    Pair { source_is_local: bool },
    /// Neither side holds a commit → there is nothing to move in either direction.
    Nothing,
}

/// Decide the pass from the two snapshots. Pure.
pub fn pair_plan(local: &PeerSnapshot, remote: &PeerSnapshot) -> PairPlan {
    match (is_seeded(local), is_seeded(remote)) {
        (true, true) => PairPlan::Sync,
        (true, false) => PairPlan::Pair {
            source_is_local: true,
        },
        (false, true) => PairPlan::Pair {
            source_is_local: false,
        },
        (false, false) => PairPlan::Nothing,
    }
}

/// Whether a pass may be skipped entirely (#28p D5). Deliberately narrow: only a
/// **green** project whose two ref signatures are both unchanged early-outs. Any
/// non-green state re-runs in full, so a manual Retry after the user clears a blocker
/// (deleting an untracked collision moves no ref) is never answered from cache. Pure.
///
/// `both_seeded` — not "both are repos": a half-seeded side must never be able to
/// early-out of the pass that would repair it.
pub fn can_early_out(
    prior: &GitPeerState,
    local_sig: &str,
    remote_sig: &str,
    both_seeded: bool,
    forced: bool,
) -> bool {
    !forced
        && both_seeded
        && prior.status == SyncStatus::Synchronized
        && prior.local_sig.as_deref() == Some(local_sig)
        && prior.remote_sig.as_deref() == Some(remote_sig)
}

// ── Pairing-collision detection (#28p D3) ───────────────────────────────────

/// A file's identity on one side: its size, plus a git blob sha when one could be
/// computed. `hash: None` means "not proven equal to anything" — treated as a
/// difference, because pairing's `reset --hard` is destructive and unproven-equal is
/// not a safe basis for it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Fingerprint {
    pub size: u64,
    pub hash: Option<String>,
}

/// Parse `git ls-tree -r -l -z HEAD`: NUL-terminated records of
/// `<mode> SP blob SP <sha> SP<pad> <size> TAB <path>`. `-z` is what makes this
/// unambiguous — an unquoted path may contain anything but NUL. Pure.
pub fn parse_ls_tree_long(stdout: &[u8]) -> HashMap<String, Fingerprint> {
    let mut out = HashMap::new();
    for rec in stdout.split(|&b| b == 0) {
        if rec.is_empty() {
            continue;
        }
        let rec = String::from_utf8_lossy(rec);
        let Some((meta, path)) = rec.split_once('\t') else {
            continue;
        };
        let cols: Vec<&str> = meta.split_whitespace().collect();
        // <mode> <type> <sha> <size>; skip submodules/trees (only blobs have bytes).
        if cols.len() != 4 || cols[1] != "blob" {
            continue;
        }
        let Ok(size) = cols[3].parse::<u64>() else {
            continue;
        };
        out.insert(
            path.replace('\\', "/"),
            Fingerprint {
                size,
                hash: Some(cols[2].to_string()),
            },
        );
    }
    out
}

/// The paths that make an initial pairing unsafe: present on **both** sides and not
/// provably identical (#28p D3). Only these are at risk — `reset --hard` would destroy
/// them with no backup — so a non-empty result must refuse the pairing rather than
/// proceed. Everything else (dest-only files, and byte-identical collisions, which is
/// the *expected* case when file-sync already mirrored the tree) pairs cleanly.
///
/// Conservative by construction: an equal size with an unknown hash counts as a
/// difference. Refusing a pairing costs a click; guessing wrong costs the user's files.
/// Pure.
pub fn pairing_collisions(
    source: &HashMap<String, Fingerprint>,
    dest: &HashMap<String, Fingerprint>,
) -> Vec<String> {
    let mut out: Vec<String> = source
        .iter()
        .filter_map(|(path, s)| {
            let d = dest.get(path)?;
            if s.size != d.size {
                return Some(path.clone());
            }
            match (&s.hash, &d.hash) {
                (Some(a), Some(b)) if a == b => None,
                _ => Some(path.clone()),
            }
        })
        .collect();
    out.sort();
    out
}

// ── Backup refs (#28p D6) ───────────────────────────────────────────────────

/// One `refs/tabtivity/backup/<ts>/<branch>` safety ref, as listed for the Backups UI.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupRef {
    /// `"local"` or `"remote"` — which peer holds it.
    pub peer: String,
    pub refname: String,
    pub ts: u64,
    pub branch: String,
    pub sha: String,
    pub subject: String,
}

/// Inverse of [`backup_ref_name`]. Pure.
pub fn parse_backup_ref_name(refname: &str) -> Option<(u64, String)> {
    let rest = refname.strip_prefix(crate::brand::GIT_REF_BACKUP)?.strip_prefix('/')?;
    let (ts, branch) = rest.split_once('/')?;
    if branch.is_empty() {
        return None;
    }
    Some((ts.parse().ok()?, branch.to_string()))
}

/// Parse `for-each-ref --format='%(objectname)%09%(refname)%09%(contents:subject)'`
/// over `refs/tabtivity/backup`. Pure.
pub fn parse_backup_refs(peer: &str, stdout: &str) -> Vec<BackupRef> {
    let mut out: Vec<BackupRef> = stdout
        .lines()
        .filter_map(|line| {
            let mut cols = line.split('\t');
            let sha = cols.next()?.trim();
            let refname = cols.next()?.trim();
            let subject = cols.next().unwrap_or("").trim();
            let (ts, branch) = parse_backup_ref_name(refname)?;
            (!sha.is_empty()).then(|| BackupRef {
                peer: peer.to_string(),
                refname: refname.to_string(),
                ts,
                branch,
                sha: sha.to_string(),
                subject: subject.to_string(),
            })
        })
        .collect();
    out.sort_by(|a, b| b.ts.cmp(&a.ts).then_with(|| a.branch.cmp(&b.branch)));
    out
}

/// Which backup refs to drop: everything that is neither among the newest `keep_n` nor
/// younger than `max_age_secs` (#28p D6 — they pin objects forever otherwise). The
/// newest ref is **never** pruned, whatever the policy says: the most recent safety net
/// is the one a user is most likely to still need. Pure.
pub fn select_prunable(
    refs: &[BackupRef],
    now: u64,
    keep_n: usize,
    max_age_secs: u64,
) -> Vec<String> {
    let mut sorted: Vec<&BackupRef> = refs.iter().collect();
    sorted.sort_by_key(|r| std::cmp::Reverse(r.ts));
    sorted
        .iter()
        .enumerate()
        .filter(|(i, r)| *i > 0 && *i >= keep_n && now.saturating_sub(r.ts) > max_age_secs)
        .map(|(_, r)| r.refname.clone())
        .collect()
}

/// The `origin` URL a freshly-paired dest should inherit from the source (#28p D7):
/// the mirror is `git init`ed from a bundle, and bundles carry no `config`/remotes, so
/// `git push` from a local agent tab used to just fail. Only the **URL** propagates —
/// never credentials, never other config keys — and never over a dest that already has
/// its own origin. Pure.
pub fn should_propagate_origin(source: Option<&str>, dest: Option<&str>) -> Option<String> {
    let src = source.map(str::trim).filter(|s| !s.is_empty())?;
    match dest.map(str::trim).filter(|s| !s.is_empty()) {
        Some(_) => None,
        None => Some(src.to_string()),
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ── State persistence ───────────────────────────────────────────────────────

/// `<state_dir>/remote-projects/<id>/git_peer.json` (sibling of `sync.json`).
pub fn state_path(project_id: &str) -> PathBuf {
    state_path_in(&crate::storage::state_dir(), project_id)
}

/// [`state_path`] under an explicit state dir — see `local_loss::log_path_in`.
pub fn state_path_in(state_dir: &Path, project_id: &str) -> PathBuf {
    state_dir
        .join("remote-projects")
        .join(project_id)
        .join("git_peer.json")
}

/// Load a project's persisted lockstep state (default/disabled if absent).
pub fn load_state(project_id: &str) -> GitPeerState {
    crate::storage::read_json(&state_path(project_id)).unwrap_or_default()
}

/// Persist a project's lockstep state.
pub fn save_state(project_id: &str, state: &GitPeerState) -> Result<(), String> {
    crate::storage::write_json(&state_path(project_id), state).map_err(|e| e.to_string())
}

// ── Probing ─────────────────────────────────────────────────────────────────

/// Read a peer's git state (HEAD, branches, tags, tracked-dirty). A non-repo or any
/// probe failure yields `is_repo == false` so the caller degrades gracefully.
///
/// A **remote** peer is probed with one batched script ([`PROBE_SCRIPT`]) instead of
/// six SSH round trips (#28p D5); anything the script's output can't answer for falls
/// back to the per-command path below, so a host without a POSIX `sh` still works.
pub fn probe(peer: &Peer) -> PeerSnapshot {
    if let Peer::Remote(spec) = peer {
        match ssh_exec::run_remote_script(spec, PROBE_SCRIPT) {
            Ok(out) => {
                if let Some(snap) = parse_probe_block(&String::from_utf8_lossy(&out.stdout)) {
                    return snap;
                }
                // Unrecognizable output → fall through to the per-command probe, which
                // classifies `probe_error` itself.
            }
            Err(_) => {
                return PeerSnapshot {
                    probe_error: true,
                    ..Default::default()
                }
            }
        }
    }
    probe_per_command(peer)
}

/// The original one-command-per-field probe. Still the path for the local mirror (six
/// local `git` spawns cost nothing) and the fallback for a remote host whose shell
/// couldn't run the batched script.
fn probe_per_command(peer: &Peer) -> PeerSnapshot {
    let res = peer.run(&["rev-parse", "--is-inside-work-tree"]);
    let is_repo = res.as_ref().map(|o| o.status.success()).unwrap_or(false);
    if !is_repo {
        // Distinguish a clean "not a repo" (git ran, said no — a legitimately empty
        // side we may safely initialize) from a probe that could not run at all. A
        // missing local dir is *not* an error: there is no repo there to destroy, so
        // pairing may create the mirror. But an execution failure over an existing
        // tree must NOT read as "empty" — that would let a `reset --hard` wipe a real
        // repo on a transient git hiccup. `remote_target_for`-side connection drops
        // surface as a non-zero ssh exit (Ok), so only a true spawn error flags here.
        let probe_error = match peer {
            Peer::Local(dir) => dir.exists() && res.is_err(),
            Peer::Remote(_) => res.is_err(),
        };
        return PeerSnapshot {
            probe_error,
            ..Default::default()
        };
    }

    let symbolic = peer
        .run(&["symbolic-ref", "--quiet", "--short", "HEAD"])
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default();
    // `--verify --quiet` so an unborn HEAD yields *empty stdout* rather than the
    // literal `HEAD` that a bare `rev-parse HEAD` prints — the two probes must agree
    // on what unborn looks like, whichever one a peer happens to take.
    let rev = peer
        .run(&["rev-parse", "--verify", "--quiet", "HEAD"])
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default();
    let head = Some(parse_head(&symbolic, &rev));

    let branches = peer
        .run(&[
            "for-each-ref",
            "--format=%(objectname) %(refname:short)",
            "refs/heads",
        ])
        .map(|o| parse_refs(&String::from_utf8_lossy(&o.stdout)))
        .unwrap_or_default();
    let tags = peer
        .run(&[
            "for-each-ref",
            "--format=%(objectname) %(refname:short)",
            "refs/tags",
        ])
        .map(|o| parse_refs(&String::from_utf8_lossy(&o.stdout)))
        .unwrap_or_default();
    let dirty_tracked = peer
        .run(&["status", "--porcelain"])
        .map(|o| is_dirty_tracked(&String::from_utf8_lossy(&o.stdout)))
        .unwrap_or(false);
    let head_subject = peer
        .run(&["log", "-1", "--format=%s", "HEAD"])
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty());
    // #23 D1: the branches checked out in LINKED worktrees, which `symbolic-ref`
    // above cannot see. The batched probe asks for the same thing in its own
    // section; both must, or a peer that fell back to per-command probing would
    // silently lose the protection.
    let checked_out = peer
        .run(&["worktree", "list", "--porcelain"])
        .ok()
        .filter(|o| o.status.success())
        .map(|o| checked_out_branches(&String::from_utf8_lossy(&o.stdout)))
        .unwrap_or_default();

    PeerSnapshot {
        is_repo: true,
        head,
        branches,
        tags,
        dirty_tracked,
        probe_error: false,
        head_subject,
        checked_out,
    }
}

/// The mirror's git-tracked path set (`git ls-files -z`), normalized to `/` separators.
///
/// **The load-bearing boundary of #28p D1.** `sync_auto` subtracts this from its
/// candidate set whenever lockstep is on, which is what makes the two transports stop
/// racing: lockstep owns every tracked file (it delivers them as commits), byte-sync
/// owns everything else. Without it, a file lockstep was about to deliver as a commit
/// could first be shipped as loose bytes, land on the peer *untracked*, and then block
/// the very fast-forward that would have delivered it properly.
///
/// NUL-delimited so paths with spaces/quotes survive verbatim (no `core.quotePath`
/// escaping). `.git` is never listed by `ls-files`; a gitignored `.tabtivity` won't be
/// either — both stay out of byte-sync, as elsewhere. Empty set on any failure, which
/// degrades to today's (racy but working) behaviour rather than silently syncing nothing.
pub fn tracked_paths(project_id: &str) -> HashSet<String> {
    let local = Peer::Local(mirror_dir(project_id));
    let out = match local.run(&["ls-files", "-z"]) {
        Ok(o) if o.status.success() => o.stdout,
        _ => return HashSet::new(),
    };
    out.split(|&b| b == 0)
        .filter(|s| !s.is_empty())
        .map(|s| String::from_utf8_lossy(s).replace('\\', "/"))
        .collect()
}

/// Every non-gitignored file in the mirror — tracked AND untracked — as git sees
/// it (`ls-files -co --exclude-standard`), or `None` when the mirror is not a
/// repo (or git failed). Backs `sync_status`'s new-local-file pass: for a
/// git-backed mirror, .gitignore is the honest noise filter — the caches, venvs
/// and result trees a raw walk would report as thousands of "new" files are
/// exactly what the user chose not to version. `None` (unlike `tracked_paths`'
/// empty set) is a distinct answer on purpose: it tells the caller to fall back
/// to a raw mirror walk rather than to conclude the mirror is empty.
pub fn non_ignored_paths(project_id: &str) -> Option<HashSet<String>> {
    let local = Peer::Local(mirror_dir(project_id));
    let out = match local.run(&["ls-files", "-z", "-co", "--exclude-standard"]) {
        Ok(o) if o.status.success() => o.stdout,
        _ => return None,
    };
    Some(
        out.split(|&b| b == 0)
            .filter(|s| !s.is_empty())
            .map(|s| String::from_utf8_lossy(s).replace('\\', "/"))
            .collect(),
    )
}

// ── Transport + apply ───────────────────────────────────────────────────────

/// Transient bundle file paths (inside `.git`, so file-sync/status never see them).
fn local_bundle_path(project_id: &str) -> PathBuf {
    mirror_dir(project_id)
        .join(".git")
        .join(crate::brand::LOCKSTEP_BUNDLE)
}
fn remote_bundle_path(spec: &RemoteSpec) -> String {
    remote_sync::join_remote(&spec.remote_path, &format!(".git/{}", crate::brand::LOCKSTEP_BUNDLE))
}

fn sha_of<'a>(snap: &'a PeerSnapshot, kind: RefKind, name: &str) -> Option<&'a str> {
    let list = match kind {
        RefKind::Head => &snap.branches,
        RefKind::Tag => &snap.tags,
    };
    list.iter().find(|r| r.name == name).map(|r| r.sha.as_str())
}

#[derive(Clone, Copy)]
enum RefKind {
    Head,
    Tag,
}

/// One direction of a reconcile: bundle `source`'s heads+tags (delta-excluding what
/// `dest` already has), move the bundle to the dest's fs, `git fetch` it, then apply
/// the safe (create / fast-forward) updates on `dest`. Returns branch names that
/// diverged (never auto-applied) and whether a needed fast-forward was blocked by a
/// dirty dest. Objects only — `.git` internals never cross (see [`bundle_create_args`]).
///
/// When `force` is set (the Use-local/Use-remote resolution, #28n Phase 2), `source`
/// is the user-chosen authority: a diverged branch or one where `dest` is *ahead* is
/// reset to `source`'s sha after saving the overwritten tip to a timestamped
/// `refs/tabtivity/backup/*` safety ref (a checked-out loser branch is `reset --hard`,
/// moving ref + working tree). Tags conflicting on sha are likewise force-moved with
/// a backup. `force` never widens what history *transfers*, only how `dest` applies it.
async fn transfer_and_apply(
    pool: &RemotePoolState,
    manifest: &SyncManifestState,
    project_id: &str,
    spec: &RemoteSpec,
    to_remote: bool,
    source: &PeerSnapshot,
    dest: &PeerSnapshot,
    force: bool,
) -> Result<TransferResult, String> {
    let mut result = TransferResult::default();
    if !source.is_repo {
        return Ok(result);
    }

    // Delta-exclude every sha the dest already has (thin bundle). A brand-new dest
    // has no shas → full bundle.
    let mut excludes: Vec<String> = dest
        .branches
        .iter()
        .chain(dest.tags.iter())
        .map(|r| r.sha.clone())
        .collect();
    excludes.sort();
    excludes.dedup();

    let (src_peer, dst_peer) = if to_remote {
        (
            Peer::Local(mirror_dir(project_id)),
            Peer::Remote(spec.clone()),
        )
    } else {
        (
            Peer::Remote(spec.clone()),
            Peer::Local(mirror_dir(project_id)),
        )
    };

    // #28q: when the dest is the LOCAL mirror, the apply below can move its checked-out
    // branch — by fast-forward, or by `reset --hard` under `force` — and either one
    // deletes the tracked files the incoming commit dropped. Snapshot the tip now so the
    // audit at the end can name them. `None` for a remote dest (nothing local at risk) or
    // an unborn local one (nothing there to lose).
    let local_head_before = if to_remote {
        None
    } else {
        local_head_sha(project_id)
    };

    // …but only the ones the source actually has. An exclude the source has never seen
    // is not a delta hint to git, it is a fatal argument: `bundle create --not <unknown>`
    // aborts the entire bundle. And "the dest's tip is a commit this side has never seen"
    // is *precisely* what a divergence looks like from the source — so leaving them in
    // aborted BOTH transfer legs on every genuine divergence, and the empty-bundle no-op
    // below then reported it as Synchronized. A green pill over two histories silently
    // drifting apart, with the desync bar (and Use local / Use remote) never offered.
    // Excludes are only a bundle-size optimization, so dropping one costs bytes, never
    // correctness.
    let excludes = known_shas(&src_peer, &excludes);

    // 1. Create the bundle on the source's own fs.
    let (src_bundle, dst_bundle) = if to_remote {
        (
            local_bundle_path(project_id).to_string_lossy().to_string(),
            remote_bundle_path(spec),
        )
    } else {
        (
            remote_bundle_path(spec),
            local_bundle_path(project_id).to_string_lossy().to_string(),
        )
    };
    let create = bundle_create_args(&src_bundle, &["--branches", "--tags"], &excludes);
    let create_ref: Vec<&str> = create.iter().map(|s| s.as_str()).collect();
    let out = src_peer.run(&create_ref)?;
    // git refuses to create an *empty* bundle, which is how it reports "the dest already
    // has every object I would have sent". That is a no-op **transfer** — it is emphatically
    // not a no-op **apply**: the dest's refs still have to move onto those objects. Returning
    // here (as this used to) silently skipped step 4 whenever the objects happened to be
    // there already, which is the normal case for a Use-local/Use-remote resolve, and for any
    // branch whose commits reached the peer via a descendant branch. Observed live: a resolve
    // that transferred nothing, moved nothing, and reported the divergence it had just been
    // asked to end.
    if out.status.success() {
        // 2. Move the bundle across via the pooled SFTP session.
        move_bundle(pool, project_id, to_remote, &src_bundle, &dst_bundle).await?;

        // 3. Import objects into the dest's isolated incoming namespace.
        let specs = incoming_fetch_refspecs();
        let fetch: Vec<&str> = vec!["fetch", &dst_bundle, &specs[0], &specs[1]];
        let _ = dst_peer.run(&fetch); // fetch failure → apply below simply finds nothing
    } else {
        let stderr = String::from_utf8_lossy(&out.stderr);
        if !is_empty_bundle_error(&stderr) {
            // #28p D11: a GENUINE creation failure (disk full, bad path, permission
            // denied, ...) — as opposed to the empty-bundle refusal handled above —
            // means no objects moved anywhere. Step 4 must not run: applying a ref
            // update now would move dest's refs onto shas it was never actually given,
            // a dangling pointer no object backs, reported as `applied` and computed
            // to Synchronized — the same false-green shape the empty-bundle fix above
            // exists to avoid, in the one case that fix must not paper over.
            return Err(format!("bundle create failed: {}", stderr.trim()));
        }
    }

    // 4. Apply safe updates per branch. One shared timestamp so every safety ref this
    //    forced pass creates sorts under the same `refs/tabtivity/backup/<ts>/` batch.
    let head_branch = match &dest.head {
        Some(HeadRef::Branch { name, .. }) => Some(name.clone()),
        _ => None,
    };
    let linked_checkouts = linked_checkout_branches(dest);
    let ts = now_secs();

    // Every branch's two ancestry bits in ONE round trip on the dest (#28p D5); the
    // bundle already put every object there, so all the checks can run together.
    let known: Vec<(String, String, String)> = source
        .branches
        .iter()
        .filter_map(|r| {
            sha_of(dest, RefKind::Head, &r.name)
                .map(|d| (r.name.clone(), d.to_string(), r.sha.clone()))
        })
        .collect();
    let flags = ancestry_map(
        &dst_peer,
        &known
            .iter()
            .map(|(_, d, s)| (d.clone(), s.clone()))
            .collect::<Vec<_>>(),
    );
    let ancestry: HashMap<&str, (bool, bool)> = known
        .iter()
        .map(|(b, _, _)| b.as_str())
        .zip(flags)
        .collect();

    // Every branch tip that actually moved on the dest this pass, as
    // `(old_tip, new_tip)` — unioned into a "files synced" count at the end so a
    // lockstep transfer registers in `net_usage` like a byte-sync one.
    let mut applied_moves: Vec<(Option<String>, String)> = Vec::new();
    for src_ref in &source.branches {
        let dst_sha = sha_of(dest, RefKind::Head, &src_ref.name);
        let applied_before = result.applied;
        let (fwd, back) = ancestry
            .get(src_ref.name.as_str())
            .copied()
            .unwrap_or((false, false));
        let is_head = head_branch.as_deref() == Some(src_ref.name.as_str());
        let action = decide(dst_sha, &src_ref.sha, fwd, back);
        // #23 D1. Reported like the dirty-tree case rather than forced: a sync engine
        // that quietly rewrites a checkout it cannot see is the failure mode, and
        // `--force` here would be the same write with a nicer name. The user's escape
        // is the one git gives — remove the worktree, or commit and move it there.
        //
        // Only a move that would actually *write* the ref counts. `DestAhead` under a
        // plain reconcile touches nothing (the other leg fast-forwards the *source*),
        // so blocking it reported a red "left alone" over a branch that was never
        // going to be moved — a false Desynchronized for every linked worktree that
        // was merely ahead of its peer.
        let blocked_by_worktree = would_move_ref(action, force)
            && linked_checkouts.contains(src_ref.name.as_str());
        if blocked_by_worktree {
            result.blocked = Some(format!(
                "'{}' is checked out in a linked worktree on the {} side — its ref was left alone \
                 (moving it would leave that worktree's index reverting this change)",
                src_ref.name,
                if to_remote { "remote" } else { "local" },
            ));
        }
        match action {
            _ if blocked_by_worktree => {}
            RefAction::InSync => {}
            RefAction::DestAhead => {
                // Under a resolution the authority wins even where the dest is ahead:
                // discard the dest's extra commits (backed up) and reset to source.
                if force {
                    force_reset_branch(
                        &dst_peer,
                        &src_ref.name,
                        &src_ref.sha,
                        dst_sha.unwrap(),
                        is_head,
                        ts,
                    );
                    result.applied += 1;
                }
            }
            RefAction::CreateOnDest => {
                let _ = dst_peer.run(&[
                    "update-ref",
                    &format!("refs/heads/{}", src_ref.name),
                    &src_ref.sha,
                ]);
                result.applied += 1;
            }
            RefAction::FastForwardDest => {
                if is_head {
                    // Checked-out branch: move ref + working tree, refusing on a dirty tree.
                    match dst_peer.run(&["merge", "--ff-only", &src_ref.sha]) {
                        Ok(o) if o.status.success() => result.applied += 1,
                        Ok(o) => {
                            // Usually NOT "uncommitted changes": git also refuses when an
                            // untracked file would be overwritten — even a byte-identical
                            // one, which is exactly what a byte-sync that outran the commit
                            // leaves behind. Clear those (only when provably identical, or
                            // provably our own stale byte-sync residue — case #12) and
                            // retry; otherwise report what git actually said (#28p D1/D2).
                            let stderr = String::from_utf8_lossy(&o.stderr).to_string();
                            let colliding = parse_untracked_overwrite_paths(&stderr);
                            let residue = stale_byte_sync_residue(
                                manifest, project_id, &dst_peer, &colliding,
                            )
                            .await;
                            match retry_ff_clearing_identical(
                                &dst_peer,
                                &src_ref.sha,
                                &stderr,
                                &residue,
                            ) {
                                FfRetry::Cleared(cleared) => {
                                    // #28q: the identical files came back byte-for-byte (the ff
                                    // wrote the same blob), so only the residue ones lost
                                    // anything — their older byte-synced copy, replaced by the
                                    // committed content. Report those, and only when the mirror
                                    // is the side that was cleaned.
                                    if !to_remote {
                                        let replaced: Vec<String> = cleared
                                            .iter()
                                            .filter(|p| residue.contains(*p))
                                            .cloned()
                                            .collect();
                                        local_loss::record_paths(
                                            project_id,
                                            local_loss::LossSource::Git,
                                            local_loss::LossKind::Overwritten,
                                            "fast-forward from the host (replaced a stale \
                                             byte-synced copy)",
                                            replaced,
                                            Some(
                                                "The file now holds the host's committed content. \
                                                 The copy that was replaced was an older \
                                                 byte-synced version of the same file and was \
                                                 never committed anywhere."
                                                    .to_string(),
                                            ),
                                        );
                                    }
                                    forget_synced_paths(manifest, project_id, &colliding).await;
                                    result.applied += 1;
                                }
                                FfRetry::ClearedButFailed(cleared) => {
                                    // The files were removed to clear the way and the ff then
                                    // failed anyway: the mirror is now short every one of them,
                                    // with nothing having rewritten them. Loudest case we have.
                                    if !to_remote {
                                        local_loss::record_paths(
                                            project_id,
                                            local_loss::LossSource::Git,
                                            local_loss::LossKind::Deleted,
                                            "fast-forward from the host (cleared blocking \
                                             untracked files, then failed)",
                                            cleared,
                                            Some(format!(
                                                "The content is in git on the mirror — restore a \
                                                 file with:  git -C {} show {}:<path> > <path>",
                                                mirror_dir(project_id).display(),
                                                &src_ref.sha[..src_ref.sha.len().min(12)]
                                            )),
                                        );
                                    }
                                    result.blocked = Some(blocked_detail(&src_ref.name, &stderr));
                                }
                                FfRetry::Refused => {
                                    result.blocked = Some(blocked_detail(&src_ref.name, &stderr));
                                }
                            }
                        }
                        Err(e) => {
                            result.blocked = Some(format!("'{}' merge failed: {e}", src_ref.name))
                        }
                    }
                } else {
                    let _ = dst_peer.run(&[
                        "update-ref",
                        &format!("refs/heads/{}", src_ref.name),
                        &src_ref.sha,
                        dst_sha.unwrap(),
                    ]);
                    result.applied += 1;
                }
            }
            RefAction::Diverged => {
                if force {
                    force_reset_branch(
                        &dst_peer,
                        &src_ref.name,
                        &src_ref.sha,
                        dst_sha.unwrap(),
                        is_head,
                        ts,
                    );
                    result.applied += 1;
                } else {
                    result.diverged.push(src_ref.name.clone());
                }
            }
        }
        // If any arm above moved this branch's tip on the dest (`result.applied`
        // rose), record the move so its file delta is counted below. `dst_sha`
        // is `None` for a fresh create — its whole tree is the delta.
        if result.applied > applied_before {
            applied_moves.push((dst_sha.map(str::to_string), src_ref.sha.clone()));
        }

        // Park (or clear) the peer's tip so a divergence can be resolved with plain git
        // in a terminal rather than only by picking a winner (#28p D8).
        let peer_ref = peer_ref_name(&src_ref.name);
        match peer_ref_op(action, force) {
            PeerRefOp::Set => {
                let _ = dst_peer.run(&["update-ref", &peer_ref, &src_ref.sha]);
            }
            PeerRefOp::Delete => {
                let _ = dst_peer.run(&["update-ref", "-d", &peer_ref]);
            }
        }
    }

    // Tags: create missing ones; a same-name/different-sha tag is a conflict we
    // surface (and, under a resolution, force-move after a backup — never otherwise).
    for src_tag in &source.tags {
        match sha_of(dest, RefKind::Tag, &src_tag.name) {
            None => {
                let _ = dst_peer.run(&[
                    "update-ref",
                    &format!("refs/tags/{}", src_tag.name),
                    &src_tag.sha,
                ]);
                result.applied += 1;
            }
            Some(d) if d != src_tag.sha => {
                if force {
                    let backup = backup_ref_name(&format!("tags/{}", src_tag.name), ts);
                    let _ = dst_peer.run(&["update-ref", &backup, d]);
                    let _ = dst_peer.run(&[
                        "update-ref",
                        &format!("refs/tags/{}", src_tag.name),
                        &src_tag.sha,
                    ]);
                    result.applied += 1;
                } else {
                    result.diverged.push(format!("tag:{}", src_tag.name));
                }
            }
            Some(_) => {}
        }
    }

    // 5. #28q: if the mirror's HEAD moved above, say what that cost the working tree.
    //    Scoped to this apply, so a caller that runs a checkout of its own around it
    //    (`checkout_lockstep`) audits that separately and neither reports the other's.
    if let Some(before) = &local_head_before {
        audit_local_head_move(
            project_id,
            before,
            if force {
                "Use-remote resolve (reset --hard on the mirror)"
            } else {
                "fast-forward from the host"
            },
        );
    }

    // 6. Cleanup: drop the incoming namespace + bundle files on both ends.
    cleanup_incoming(&dst_peer);
    cleanup_bundles(pool, project_id, spec).await;

    // 7. Count the tracked files these applied moves carried into the "files
    //    synced" metric. Lockstep moves the whole tracked tree as one bundle, so
    //    without this the metric only reflected byte-sync and read 0 after a
    //    lockstep seed (e.g. extend-to-remote). Direction follows the transfer:
    //    `to_remote` is an upload, a pull is a download. Runs on the dest (the
    //    side whose refs just moved), after apply, so the diffs resolve.
    if !applied_moves.is_empty() {
        let files = files_changed_by_moves(&dst_peer, &applied_moves) as u64;
        if files > 0 {
            if to_remote {
                net_usage::record_files(project_id, 0, files);
            } else {
                net_usage::record_files(project_id, files, 0);
            }
        }
    }

    Ok(result)
}

#[derive(Default)]
struct TransferResult {
    applied: usize,
    diverged: Vec<String>,
    /// What git said when it refused a needed fast-forward, already composed into a
    /// user-facing sentence (#28p D2 — this used to be a bare `bool` that always
    /// rendered as "a peer has uncommitted changes", which was usually a lie).
    blocked: Option<String>,
}

/// `git merge-base --is-ancestor <a> <b>` → true iff exit 0 (a is an ancestor of b).
fn is_ancestor(peer: &Peer, a: &str, b: &str) -> bool {
    peer.run(&["merge-base", "--is-ancestor", a, b])
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// The `(dest_is_ancestor_of_source, source_is_ancestor_of_dest)` bits for every
/// `(dest_sha, source_sha)` pair, in one SSH round trip when the dest is remote
/// (#28p D5 — this was `2·N` round trips, per direction, every 12 s). Falls back to
/// per-pair `merge-base` calls for a local dest, for non-hex input, or whenever the
/// batched output doesn't line up with what we asked — a misaligned bit would
/// misclassify a divergence, so an unverifiable answer is never used.
fn ancestry_map(peer: &Peer, pairs: &[(String, String)]) -> Vec<(bool, bool)> {
    if pairs.is_empty() {
        return Vec::new();
    }
    if let Peer::Remote(spec) = peer {
        let all_hex = pairs.iter().all(|(a, b)| is_hex_sha(a) && is_hex_sha(b));
        if all_hex {
            if let Ok(out) = ssh_exec::run_remote_script(spec, &ancestry_script(pairs)) {
                if let Some(v) =
                    parse_ancestry_block(&String::from_utf8_lossy(&out.stdout), pairs.len())
                {
                    return v;
                }
            }
        }
    }
    pairs
        .iter()
        .map(|(d, s)| (is_ancestor(peer, d, s), is_ancestor(peer, s, d)))
        .collect()
}

/// Recover the fast-forward git just refused, when — and only when — every untracked
/// file in its way is either **byte-identical to the blob the incoming commit would
/// write**, or provably disposable **stale byte-sync residue** (#28p D1 layer 2, and
/// case #12 in `docs/git_lockstep_case_matrix.md`).
///
/// The identical case is a byte-sync that outran its commit: the content is already on
/// the peer, just untracked, so `merge --ff-only` balks (it refuses even for identical
/// content) while the commit that owns those bytes never crosses. It is also what a
/// project that byte-synced *before* lockstep was ever enabled looks like on its first
/// reconcile.
///
/// The residue case is #12: a file byte-synced while still untracked, then edited and
/// committed — `drop_tracked` (D1) stops byte-sync from ever delivering the newer
/// content once the path becomes tracked, so the peer is stuck holding the *older*
/// byte-synced copy, which now differs from the incoming commit. `stale_residue` names
/// exactly the paths proven (by the caller, against the sync manifest) to be that old
/// copy and nothing else.
///
/// Identity is established with git itself, on the dest: `hash-object` of the working
/// file vs `rev-parse <sha>:<path>` of the incoming blob. All-or-nothing — one file that
/// is neither provably identical nor provably stale residue, and nothing is touched,
/// because it is real unsynced work.
fn retry_ff_clearing_identical(
    dst_peer: &Peer,
    src_sha: &str,
    stderr: &str,
    stale_residue: &HashSet<String>,
) -> FfRetry {
    let paths = parse_untracked_overwrite_paths(stderr);
    if paths.is_empty() {
        return FfRetry::Refused;
    }
    if !paths
        .iter()
        .all(|p| blob_matches_worktree(dst_peer, src_sha, p) || stale_residue.contains(p))
    {
        return FfRetry::Refused;
    }
    for p in &paths {
        // `:(literal)` so a path with glob metacharacters (`*`, `[`, `?`) is matched as
        // itself and can never widen into a pathspec that removes more than it names.
        let _ = dst_peer.run(&["clean", "-f", "-x", "--", &format!(":(literal){p}")]);
    }
    let landed = dst_peer
        .run(&["merge", "--ff-only", src_sha])
        .map(|o| o.status.success())
        .unwrap_or(false);
    if landed {
        FfRetry::Cleared(paths)
    } else {
        FfRetry::ClearedButFailed(paths)
    }
}

/// What a cleared-fast-forward retry actually did. The two cleared variants used to be
/// one `false`/`true` bool, which is precisely the distinction #28q needs: the retry
/// *deletes untracked files* to get the fast-forward through, and whether those files
/// come back depends on whether the fast-forward then landed.
enum FfRetry {
    /// A colliding file was neither provably identical nor provably stale residue, so
    /// nothing was touched — it is real unsynced work and the ff stays blocked.
    Refused,
    /// The named paths were cleaned and the fast-forward landed, so git rewrote each one
    /// with the incoming commit's blob. For an identical file that is byte-for-byte what
    /// was there; for stale byte-sync residue it is the newer, committed content — the
    /// older copy is gone.
    Cleared(Vec<String>),
    /// The named paths were cleaned and the fast-forward *still* failed: they are gone
    /// and nothing rewrote them. The one path here that leaves the mirror short a file.
    ClearedButFailed(Vec<String>),
}

/// Whether the dest's on-disk `path` already holds exactly the bytes `<sha>:<path>`
/// would write. Compared as git object names so nothing has to be read over the wire:
/// `hash-object` applies the same filters (CRLF/clean) git would, so this is the blob
/// the file *would* become — an equal name means checkout is a no-op for that file.
fn blob_matches_worktree(peer: &Peer, sha: &str, path: &str) -> bool {
    let incoming = peer
        .run(&["rev-parse", "--verify", "--quiet", &format!("{sha}:{path}")])
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    if incoming.is_empty() {
        return false;
    }
    let on_disk = peer
        .run(&["hash-object", "--", path])
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    !on_disk.is_empty() && on_disk == incoming
}

/// Which of a blocked ff's colliding untracked paths are provably disposable
/// **stale byte-sync residue** rather than real, independent work on the dest (case
/// #12: `docs/git_lockstep_case_matrix.md`). A path qualifies when the sync manifest
/// holds a base for it (byte-sync touched it before it became tracked — the scope
/// this is meant to cover, kept as a cheap pre-filter) AND its current content is
/// already a git object `dst_peer`'s own store knows about (#28p D10:
/// [`object_already_known`]) — proof by content, not by a stat heuristic.
///
/// The previous check instead compared the dest's current size+mtime against the
/// manifest's recorded base, on the theory that an unchanged stat means nothing has
/// written to the path since byte-sync last put its content there. But a same-size,
/// same-mtime *different* file (clock skew, a tool that preserves mtimes on copy)
/// satisfies that heuristic despite differing content — and the caller **deletes**
/// the file on this verdict, with no backup possible for something that was never a
/// git object. Proving the content is already a git-known blob removes that gap:
/// real independent work was never committed or fetched anywhere, so it can never
/// pass this check by accident.
async fn stale_byte_sync_residue(
    manifest: &SyncManifestState,
    project_id: &str,
    dst_peer: &Peer,
    paths: &[String],
) -> HashSet<String> {
    let mut out = HashSet::new();
    if paths.is_empty() {
        return out;
    }
    let candidates: Vec<String> = {
        let mut g = manifest.lock().await;
        let m = remote_sync::ensure_loaded(&mut g, project_id);
        paths
            .iter()
            .filter(|p| m.contains_key(p.as_str()))
            .cloned()
            .collect()
    };
    for p in candidates {
        if object_already_known(dst_peer, &p) {
            out.insert(p);
        }
    }
    out
}

/// Whether the on-disk bytes at `path` (as `git hash-object` would name them) are
/// already an object `peer`'s own store has — i.e. some commit it has ever held, or
/// the incoming fetch just deposited, wrote exactly this content at some point
/// (#28p D10). `git cat-file -e` checks object *existence*, not reachability from any
/// ref, so this is true for an object the bundle fetch just brought into
/// `refs/tabtivity/incoming/*` even before any ref points at it.
fn object_already_known(peer: &Peer, path: &str) -> bool {
    let Some(hash) = peer
        .run(&["hash-object", "--", path])
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
    else {
        return false;
    };
    peer.run(&["cat-file", "-e", &hash])
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Drop the sync-manifest bases for paths a cleared ff retry just handed to lockstep
/// (they are now git-tracked, `drop_tracked` excludes them from byte-sync going
/// forward, so a lingering base would otherwise sit inert until the path were ever
/// untracked again). Best-effort, mirrors the removal `restamp_after_checkout` does
/// for a checkout-deleted tracked file.
async fn forget_synced_paths(manifest: &SyncManifestState, project_id: &str, paths: &[String]) {
    if paths.is_empty() {
        return;
    }
    let mut g = manifest.lock().await;
    let m = remote_sync::ensure_loaded(&mut g, project_id);
    for p in paths {
        m.remove(p);
    }
    let _ = remote_sync::save_manifest(project_id, m);
}

// ── Local-loss audit (#28q) ─────────────────────────────────────────────────
//
// Every lockstep write that moves the LOCAL mirror's HEAD materializes in its working
// tree, and a tracked file the incoming commit no longer carries is *deleted* there —
// by a fast-forward, by a `reset --hard`, by a checkout. That is ordinary git, it is
// recoverable from git, and it is also exactly how a file the user was looking at
// vanishes from the mirror during a background pass they never triggered. The audit
// below is what makes it say so (`services::local_loss`).
//
// Each auditor is scoped to ONE mutation and reads the mirror's HEAD itself, before and
// after. Two consequences worth stating, because they are what keep the audit honest:
// an op that failed never moved HEAD, so it records nothing (the audit observes, it
// does not predict); and a nested call that has already moved HEAD sees `from == to`,
// so an outer op and the reconcile it runs can never both report the same deletion.

/// The mirror's current HEAD sha, or `None` when it is unborn / not a repo.
fn local_head_sha(project_id: &str) -> Option<String> {
    Peer::Local(mirror_dir(project_id))
        .run(&["rev-parse", "--verify", "--quiet", "HEAD"])
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
}

/// The tracked paths present at `from` and gone at `to` — i.e. what checking `to` out
/// over `from` deletes from the working tree.
fn deleted_between(peer: &Peer, from: &str, to: &str) -> Vec<String> {
    peer.run(&["diff", "--name-only", "--diff-filter=D", from, to])
        .ok()
        .filter(|o| o.status.success())
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

/// Record the tracked files that a lockstep op — which has just moved the mirror's HEAD
/// away from `from_sha` — deleted from the local working tree. A no-op when HEAD did not
/// actually move (the op failed, or was a ref-only update on a branch that isn't checked
/// out) or when it dropped no file.
fn audit_local_head_move(project_id: &str, from_sha: &str, op: &str) {
    if from_sha.is_empty() {
        return;
    }
    let Some(to_sha) = local_head_sha(project_id) else {
        return;
    };
    if to_sha == from_sha {
        return;
    }
    let local = Peer::Local(mirror_dir(project_id));
    let gone = deleted_between(&local, from_sha, &to_sha);
    let mirror = mirror_dir(project_id);
    local_loss::record_paths(
        project_id,
        local_loss::LossSource::Git,
        local_loss::LossKind::Deleted,
        op,
        gone,
        Some(format!(
            "Still in git — restore a file with:  git -C {} checkout {} -- <path>",
            mirror.display(),
            &from_sha[..from_sha.len().min(12)]
        )),
    );
}

/// Force-move `dest`'s `branch` from `dst_sha` to the authority's `src_sha` during a
/// resolution, after saving the overwritten tip to a timestamped `refs/tabtivity/backup/*`
/// safety ref so nothing is lost. When the branch is the dest's checked-out HEAD, a
/// `reset --hard` moves the ref *and* the working tree; otherwise the ref is force-set
/// with `update-ref`'s old-value guard. Best-effort (each step ignores its own error;
/// a stale backup is harmless).
fn force_reset_branch(
    dst_peer: &Peer,
    branch: &str,
    src_sha: &str,
    dst_sha: &str,
    is_head: bool,
    ts: u64,
) {
    let backup = backup_ref_name(branch, ts);
    let _ = dst_peer.run(&["update-ref", &backup, dst_sha]);
    if is_head {
        let _ = dst_peer.run(&["reset", "--hard", src_sha]);
    } else {
        let _ = dst_peer.run(&[
            "update-ref",
            &format!("refs/heads/{branch}"),
            src_sha,
            dst_sha,
        ]);
    }
}

/// Copy the bundle file between the two machines over the pooled SFTP session.
/// Streamed in bounded chunks (#28n Phase 3) so an initial-pairing bundle carrying
/// a project's whole history never has to fit in memory on either end.
async fn move_bundle(
    pool: &RemotePoolState,
    project_id: &str,
    to_remote: bool,
    src_bundle: &str,
    dst_bundle: &str,
) -> Result<(), String> {
    let sftp = crate::services::remote::pooled_sftp(pool, project_id)
        .await
        .ok_or("remote not connected")?;
    if to_remote {
        sftp::upload_file_streaming_on(&sftp, Path::new(src_bundle), dst_bundle).await
    } else {
        sftp::download_file_streaming_on(&sftp, src_bundle, Path::new(dst_bundle)).await
    }
}

/// Delete the `refs/tabtivity/incoming/*` tracking refs on a peer after applying.
fn cleanup_incoming(peer: &Peer) {
    // `for-each-ref` then delete each; best-effort.
    if let Ok(out) = peer.run(&[
        "for-each-ref",
        "--format=%(refname)",
        crate::brand::GIT_REF_INCOMING,
    ]) {
        for line in String::from_utf8_lossy(&out.stdout).lines() {
            let r = line.trim();
            if !r.is_empty() {
                let _ = peer.run(&["update-ref", "-d", r]);
            }
        }
    }
}

async fn cleanup_bundles(pool: &RemotePoolState, project_id: &str, spec: &RemoteSpec) {
    let _ = std::fs::remove_file(local_bundle_path(project_id));
    // What an interrupted transfer of an older build left under the old name.
    if let Some(old) = crate::brand::PAIR.legacy(crate::brand::Name::LOCKSTEP_BUNDLE) {
        let _ = std::fs::remove_file(mirror_dir(project_id).join(".git").join(old));
    }
    if let Some(sftp) = crate::services::remote::pooled_sftp(pool, project_id).await {
        let _ = sftp::remove_file_on(&sftp, &remote_bundle_path(spec)).await;
    }
}

// ── Initial pairing ─────────────────────────────────────────────────────────

/// Bring an unpaired side up: `git init` the empty peer, transfer every ref from the
/// `source` (authority) peer, then position the new HEAD + working tree to match the
/// source (#28n Phase 3). `source_is_local` picks the direction — the empty side is
/// always the peer that is *not* the source. Files already physically present on the
/// empty side (selective/auto file-sync mirrored them) become the tracked tree; a
/// `reset --hard`/detached checkout materializes any that git manages but are missing,
/// and untracked files are left untouched (they stay file-sync's domain).
async fn init_pairing(
    pool: &RemotePoolState,
    manifest: &SyncManifestState,
    project_id: &str,
    spec: &RemoteSpec,
    source_is_local: bool,
    source: &PeerSnapshot,
) -> Result<(), String> {
    let (dest_peer, to_remote) = if source_is_local {
        (Peer::Remote(spec.clone()), true)
    } else {
        (Peer::Local(mirror_dir(project_id)), false)
    };
    let dest_label = if source_is_local {
        "remote host"
    } else {
        "local mirror"
    };
    if let Peer::Local(dir) = &dest_peer {
        let _ = std::fs::create_dir_all(dir);
    }

    // Defense-in-depth: init_pairing's contract is that `dest` is the *empty* side.
    // If a misprobe/race routed us here with a dest that actually already holds
    // commits, back every existing branch tip up to `refs/tabtivity/backup/*` BEFORE the
    // `reset --hard` below can move them — so an unexpected non-empty dest is always
    // recoverable rather than silently wiped. Truly-empty dests probe clean and skip.
    let pre = probe(&dest_peer);
    if !pre.branches.is_empty() {
        let ts = now_secs();
        for b in &pre.branches {
            let backup = backup_ref_name(&b.name, ts);
            let _ = dest_peer.run(&["update-ref", &backup, &b.sha]);
        }
    }

    // The host root must exist before any remote git can run: every remote command is
    // `cd '<remote_path>' && git …`, so a missing directory fails ALL of them — including
    // the `git init` below. Tabtivity only `mkdir -p`s the root at create/extend time, which
    // leaves a host whose directory is later removed (or whose creation was refused back
    // then — it is best-effort there) permanently unpairable. Idempotent, so re-pairing an
    // existing host costs one cheap round trip.
    if source_is_local {
        crate::services::ssh_exec::remote_mkdir_p(spec)
            .map_err(|e| format!("could not create '{}' on the host: {e}", spec.remote_path))?;
    }

    // `git init` the empty side. Idempotent, and deliberately so: the dest may already be
    // a repo here — a bare, never-checked-out one left behind by an earlier seed that died
    // after this very step. Re-running init on it is a no-op and the pairing carries on.
    let out = dest_peer.run(&["init"])?;
    if !out.status.success() {
        return Err(format!(
            "git init on {dest_label} failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }

    // Transfer every ref from the authority into the freshly-init'd (empty) dest;
    // with no dest shas this is a full bundle and every branch/tag is a create.
    //
    // A failure here is fatal to the pairing and must NOT fall through to the checkout
    // below: `reset --hard` would be aimed at a sha whose objects never arrived, and the
    // `git init` above has *already run* — so swallowing this (as `let _ =` used to) left
    // a dest that is a repo, holds no commit, and has an empty working tree, while
    // reporting `Ok`. That is precisely the half-seeded state `is_seeded` now exists to
    // recognize; reporting it means the user sees why, and the next pass retries the seed
    // instead of settling into a permanent head mismatch.
    let dest = probe(&dest_peer);
    transfer_and_apply(
        pool, manifest, project_id, spec, to_remote, source, &dest, false,
    )
    .await?;

    // Position HEAD + populate the working tree to match the source's HEAD. The
    // `reset --hard` here is only reached once `pairing_conflicts` has confirmed that
    // nothing it would clobber differs from what it is about to write (#28p D3).
    //
    // This is the ONLY place lockstep writes a dest's working tree at pairing time, so a
    // silent failure here is the difference between a seeded peer and an empty directory
    // with a `.git` in it. Checked, not swallowed.
    let checked = |what: &str, out: Output| -> Result<(), String> {
        if out.status.success() {
            return Ok(());
        }
        Err(format!(
            "{what} on the {dest_label} failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    };
    match &source.head {
        Some(HeadRef::Branch { name, sha }) => {
            checked(
                &format!("pointing HEAD at '{name}'"),
                dest_peer.run(&["symbolic-ref", "HEAD", &format!("refs/heads/{name}")])?,
            )?;
            checked(
                &format!("checking out '{name}'"),
                dest_peer.run(&["reset", "--hard", sha])?,
            )?;
        }
        Some(HeadRef::Detached { sha }) => {
            checked(
                "checking out the detached HEAD",
                dest_peer.run(&["checkout", sha])?,
            )?;
        }
        // Unborn/None source → nothing committed yet; leave the empty repo unborn too.
        // Unreachable via `pair_plan` (an unseeded side is never the source), kept as a
        // total match rather than a panic.
        _ => {}
    }

    // Give the fresh dest the source's `origin` URL (#28p D7). A bundle carries no
    // remotes, so without this a `git push` from a local agent tab in the mirror fails
    // with "no configured push destination" — a bad surprise in the one place agents
    // actually work.
    let source_peer = if source_is_local {
        Peer::Local(mirror_dir(project_id))
    } else {
        Peer::Remote(spec.clone())
    };
    let origin_url = |p: &Peer| -> Option<String> {
        p.run(&["config", "--get", "remote.origin.url"])
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .filter(|s| !s.is_empty())
    };
    let src_url = origin_url(&source_peer);
    let dst_url = origin_url(&dest_peer);
    if let Some(url) = should_propagate_origin(src_url.as_deref(), dst_url.as_deref()) {
        let _ = dest_peer.run(&["remote", "add", "origin", &url]);
    }
    Ok(())
}

/// The files an initial pairing would destroy (#28p D3): paths that exist on the
/// not-yet-a-repo dest **and differ** from the source's tracked content at HEAD.
///
/// Why this exists: extend-local runs `git init` + `reset --hard` on the host, and
/// `reset --hard` silently clobbers colliding untracked files. The pre-backup in
/// `init_pairing` saves *refs* — but a host that isn't a repo yet has none, which is
/// precisely the situation. So the check has to happen on *files*, before any of it.
///
/// The common case is deliberately allowed: when file-sync already mirrored the tree,
/// every collision is byte-identical and this returns empty — that is the intended
/// "adopt the mirrored files as the tracked tree" path.
async fn pairing_conflicts(
    pool: &RemotePoolState,
    project_id: &str,
    spec: &RemoteSpec,
    source_is_local: bool,
) -> Vec<String> {
    let (source_peer, dest_peer) = if source_is_local {
        (
            Peer::Local(mirror_dir(project_id)),
            Peer::Remote(spec.clone()),
        )
    } else {
        (
            Peer::Remote(spec.clone()),
            Peer::Local(mirror_dir(project_id)),
        )
    };

    // What the source would write: every tracked blob at HEAD, with its size + sha.
    let source: HashMap<String, Fingerprint> = source_peer
        .run(&["ls-tree", "-r", "-l", "-z", "HEAD"])
        .ok()
        .filter(|o| o.status.success())
        .map(|o| parse_ls_tree_long(&o.stdout))
        .unwrap_or_default();
    if source.is_empty() {
        return Vec::new(); // unborn source → nothing to overwrite with
    }

    // What is already on the dest, restricted to paths the source would touch.
    let mut dest: HashMap<String, Fingerprint> = HashMap::new();
    if source_is_local {
        let Some(sftp) = crate::services::remote::pooled_sftp(pool, project_id).await else {
            return Vec::new(); // no pool → reconcile's connectivity gate handles it
        };
        match remote_sync::walk_host_files(&sftp, &spec.remote_path, "").await {
            Ok(files) => {
                for f in files {
                    if source.contains_key(&f.rel) {
                        dest.insert(
                            f.rel,
                            Fingerprint {
                                size: f.size,
                                hash: None,
                            },
                        );
                    }
                }
            }
            Err(_) => return Vec::new(),
        }
    } else {
        let Ok(files) = remote_sync::walk_mirror_files(project_id, "") else {
            return Vec::new();
        };
        for rel in files {
            if !source.contains_key(&rel) {
                continue;
            }
            let (size, _) = remote_sync::local_size_mtime(
                std::fs::metadata(mirror_local_path(project_id, &rel)).ok(),
            );
            dest.insert(rel, Fingerprint { size, hash: None });
        }
    }

    // Only same-size collisions can possibly be identical, so only those are hashed.
    let to_hash: Vec<String> = dest
        .iter()
        .filter(|(p, d)| source.get(*p).map(|s| s.size == d.size).unwrap_or(false))
        .map(|(p, _)| p.clone())
        .collect();
    for (path, hash) in hash_objects(&dest_peer, &to_hash) {
        if let Some(e) = dest.get_mut(&path) {
            e.hash = Some(hash);
        }
    }

    pairing_collisions(&source, &dest)
}

/// Git blob names of files on a peer, batched (`git hash-object` works outside a repo,
/// which is what lets this run on the not-yet-`init`ed pairing dest). A chunk whose
/// output doesn't line up one-to-one with its input is dropped rather than
/// mis-assigned: the missing hashes then read as "not provably identical", which
/// [`pairing_collisions`] treats as a conflict — the safe direction.
fn hash_objects(peer: &Peer, paths: &[String]) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for chunk in paths.chunks(100) {
        let mut args: Vec<String> = vec!["hash-object".to_string(), "--".to_string()];
        args.extend(chunk.iter().cloned());
        let argv: Vec<&str> = args.iter().map(String::as_str).collect();
        let Ok(o) = peer.run(&argv) else { continue };
        if !o.status.success() {
            continue;
        }
        let text = String::from_utf8_lossy(&o.stdout);
        let lines: Vec<&str> = text
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .collect();
        if lines.len() != chunk.len() {
            continue;
        }
        for (p, h) in chunk.iter().zip(lines) {
            out.insert(p.clone(), h.to_string());
        }
    }
    out
}

// ── Force-reset collisions (#28p D9) ────────────────────────────────────────

/// The untracked files on `dest_peer` a force-reset of its checked-out branch to
/// `target_sha` would silently clobber: paths `target_sha`'s tree holds that also
/// exist, untracked, on `dest_peer` and differ in content.
///
/// This is the same `reset --hard` clobber behaviour (see the module doc comment)
/// `init_pairing` was hardened against for a not-yet-a-repo dest (D3) — but
/// `resolve`'s and `restore_backup`'s force-reset of an *existing* repo's checked-out
/// branch had no equivalent guard. A path git never tracked is invisible to the
/// `refs/tabtivity/backup/*` safety net (that only saves refs), so without this check it
/// is destroyed with no way back. Conservative like `pairing_collisions`: an
/// unprovable hash counts as a difference. Reuses `hash_objects`, so it costs no new
/// primitive.
fn reset_collisions(source_peer: &Peer, dest_peer: &Peer, target_sha: &str) -> Vec<String> {
    let target: HashMap<String, Fingerprint> = source_peer
        .run(&["ls-tree", "-r", "-l", "-z", target_sha])
        .ok()
        .filter(|o| o.status.success())
        .map(|o| parse_ls_tree_long(&o.stdout))
        .unwrap_or_default();
    if target.is_empty() {
        return Vec::new();
    }

    let listed = match dest_peer.run(&["ls-files", "--others", "-z"]) {
        Ok(o) if o.status.success() => o.stdout,
        _ => return Vec::new(),
    };
    let candidates: Vec<String> = listed
        .split(|&b| b == 0)
        .filter(|s| !s.is_empty())
        .map(|s| String::from_utf8_lossy(s).replace('\\', "/"))
        .filter(|p| target.contains_key(p))
        .collect();
    if candidates.is_empty() {
        return Vec::new();
    }

    let hashes = hash_objects(dest_peer, &candidates);
    let mut out: Vec<String> = candidates
        .into_iter()
        .filter(
            |p| match (target[p].hash.as_deref(), hashes.get(p).map(String::as_str)) {
                (Some(a), Some(b)) => a != b,
                _ => true, // unprovable → treat as a difference, the safe direction
            },
        )
        .collect();
    out.sort();
    out
}

// ── Reconcile + status ──────────────────────────────────────────────────────

/// Probe both peers, transfer + fast-forward in both directions, and compute the new
/// [`GitPeerState`]. Diverged branches / a dirty peer blocking a needed fast-forward
/// → `Desynchronized` (surfaced for Use-local/Use-remote resolution). Persists +
/// returns the state. `enabled` is preserved from the prior persisted state.
///
/// When exactly one side is a git repo, this performs **initial pairing** (#28n
/// Phase 3): the repo side is the authority and the empty side is `git init`-ed and
/// populated from it (remote import → mirror from remote; extend-local → remote from
/// local). If *both* already exist and diverge, no side is guessed — that is the
/// normal diverged→`Desynchronized` path, resolved by the explicit authority choice.
pub async fn reconcile(
    pool: &RemotePoolState,
    manifest: &remote_sync::SyncManifestState,
    project_id: &str,
    spec: &RemoteSpec,
) -> GitPeerState {
    reconcile_with(pool, manifest, project_id, spec, ReconcileOpts::default()).await
}

/// Knobs the two user-driven entry points need; a background pass uses the defaults.
#[derive(Clone, Copy, Debug, Default)]
pub struct ReconcileOpts {
    /// Skip the D5 early-out. A manual "Sync now"/Retry means "actually look", and a
    /// user usually clicks it *after* clearing a blocker — which moves no ref, so a
    /// signature-based cache would answer from a stale red state.
    pub forced: bool,
    /// The user has seen the conflicting files named and confirmed the overwrite
    /// (#28p D3). Only ever set by `git_peer_pair_confirm`.
    pub allow_pair_overwrite: bool,
    /// A coordinated checkout is *in flight*: it reconciles refs first and only then
    /// checks the peer out, so the two HEADs are expected to disagree for the duration.
    /// Suppresses the [`head_mismatch`] rule, which otherwise fires on that entirely
    /// normal intermediate state and leaves its stale red behind on the finished
    /// checkout. Only `checkout_lockstep`'s own reconcile sets it.
    pub mid_checkout: bool,
}

async fn reconcile_with(
    pool: &RemotePoolState,
    manifest: &remote_sync::SyncManifestState,
    project_id: &str,
    spec: &RemoteSpec,
    opts: ReconcileOpts,
) -> GitPeerState {
    let prior = load_state(project_id);

    // #28p D4: with no pooled SSH session, every remote git command would exit non-zero
    // — which `probe` reads as "the host is a clean, empty side", which pairs into it,
    // which fails, which computes to Synchronized. A green pill for a host we cannot
    // see. So: no connection, no claim, no writes.
    if !connected(pool, project_id).await {
        return persist(project_id, disconnected_state(&prior));
    }

    let local = probe(&Peer::Local(mirror_dir(project_id)));
    let remote = probe(&Peer::Remote(spec.clone()));
    let (local_sig, remote_sig) = (refs_signature(&local), refs_signature(&remote));
    let plan = pair_plan(&local, &remote);

    // #28p D5: nothing moved on either side and we were green → re-emit, skipping the
    // bundle round trip entirely. This is what stops a bare `git add` (which trips the
    // `.git` watcher without moving a ref) from costing a full network pass.
    if can_early_out(
        &prior,
        &local_sig,
        &remote_sig,
        matches!(plan, PairPlan::Sync),
        opts.forced,
    ) {
        return persist(
            project_id,
            GitPeerState {
                last_sync_ts: Some(now_secs()),
                ..prior
            },
        );
    }

    let mut diverged: Vec<String> = Vec::new();
    let mut blocked: Option<String> = None;
    // Set when we deliberately refuse to auto-pair because the side that would be
    // `git init`+`reset --hard`ed couldn't be read — forces a Desynchronized state
    // instead of a wipe (checked first in the status decision).
    let mut pairing_blocked: Option<String> = None;
    let mut pairing_conflict: Option<PairingConflict> = None;

    if matches!(plan, PairPlan::Sync) {
        // Local → remote, then remote → local (each catches the side that is ahead).
        // A leg that *errors* (bundle unreadable, SFTP transfer died) must not be
        // discarded: dropping it leaves `diverged`/`blocked` empty, which computes to
        // Synchronized — claiming green about work we never managed to do, the same
        // misreport D4 fixed for a cold pool.
        match transfer_and_apply(
            pool, manifest, project_id, spec, true, &local, &remote, false,
        )
        .await
        {
            Ok(r) => {
                diverged.extend(r.diverged);
                blocked = blocked.or(r.blocked);
            }
            Err(e) => blocked = blocked.or(Some(format!("Sync to the host failed: {e}"))),
        }
        // Re-probe the remote so the reverse pass sees any ref we just moved.
        let remote2 = probe(&Peer::Remote(spec.clone()));
        match transfer_and_apply(
            pool, manifest, project_id, spec, false, &remote2, &local, false,
        )
        .await
        {
            Ok(r) => {
                for d in r.diverged {
                    if !diverged.contains(&d) {
                        diverged.push(d);
                    }
                }
                blocked = blocked.or(r.blocked);
            }
            Err(e) => blocked = blocked.or(Some(format!("Sync from the host failed: {e}"))),
        }
    } else if let PairPlan::Pair { source_is_local } = plan {
        // Exactly one side holds a commit → initialize the other from it (initial
        // pairing). NB "holds a commit", not "is a repo": a host left as a bare
        // `git init` by a seed that died mid-way is an unpaired dest, not a peer, and
        // this is the branch that finishes it (see `is_seeded`).
        // The dest is the side we would `git init` + `reset --hard`. If *its* probe
        // errored (the tree is there, but git couldn't confirm what it is), refuse: a
        // transient git/network failure must never license a wipe of a real repo. This
        // guard used to protect only the local side — while the remote one, reached
        // over a flaky link, is by far the likelier to misprobe (#28p D3.4).
        let dest_probe_error = pairing_dest_probe_error(source_is_local, &local, &remote);
        if dest_probe_error {
            let side = if source_is_local {
                "Remote host"
            } else {
                "Local mirror"
            };
            pairing_blocked = Some(format!(
                "{side} repository could not be read; refusing to auto-initialize it. \
                 Retry once git is reachable there."
            ));
        } else {
            let conflicts = if opts.allow_pair_overwrite {
                // The user confirmed the overwrite (`pair_confirm`), so this no longer
                // blocks — but it is still the exact list of files pairing is about to
                // destroy, and when the dest is the mirror they are the user's LOCAL
                // files. Compute it anyway, purely to record what went (#28q), then
                // proceed. Only runs on the explicit confirm, never on the hot path.
                if !source_is_local {
                    local_loss::record_paths(
                        project_id,
                        local_loss::LossSource::Git,
                        local_loss::LossKind::Overwritten,
                        "initial pairing with the host (you confirmed the overwrite)",
                        pairing_conflicts(pool, project_id, spec, source_is_local).await,
                        None, // never a git object on this side — nothing to restore from
                    );
                }
                Vec::new()
            } else {
                pairing_conflicts(pool, project_id, spec, source_is_local).await
            };
            if !conflicts.is_empty() {
                // #28p D3: the empty side holds files that differ from what pairing
                // would write over them. Name them and stop — `reset --hard` would
                // destroy them with no backup and no prompt.
                pairing_conflict = Some(PairingConflict {
                    source_is_local,
                    paths: conflicts,
                });
            } else {
                let source = if source_is_local { &local } else { &remote };
                match init_pairing(pool, manifest, project_id, spec, source_is_local, source).await
                {
                    Ok(()) => {
                        // Pairing just materialized both sides to the same HEAD, so every
                        // tracked file is byte-identical across host and mirror. Seed the
                        // selective-sync manifest for them so the file tree shows them green
                        // (in sync) rather than red (untracked by SFTP sync) — there is
                        // nothing to transfer. This branch only fires at the pairing moment
                        // (exactly one side seeded), so it runs once and never re-selects a
                        // file the user later deselects.
                        seed_manifest_after_pairing(pool, manifest, project_id, spec).await;
                    }
                    // A seed that failed part-way leaves the dest a bare, unseeded repo.
                    // Say so: it used to report `Ok` and settle into a permanent, baffling
                    // head mismatch. The dest stays unseeded, so the next pass retries.
                    Err(e) => pairing_blocked = Some(format!("Initial pairing failed: {e}")),
                }
            }
        }
    }

    let final_local = probe(&Peer::Local(mirror_dir(project_id)));
    let final_remote = probe(&Peer::Remote(spec.clone()));

    let (status, detail) = if let Some(msg) = pairing_blocked {
        // We refused to auto-initialize an unreadable side — report it (must be checked
        // before the "one side has no repo" branch, which would mask it).
        (SyncStatus::Desynchronized, Some(msg))
    } else if let Some(c) = &pairing_conflict {
        let where_ = if c.source_is_local { "host" } else { "mirror" };
        let shown: Vec<&str> = c.paths.iter().take(3).map(String::as_str).collect();
        let more = c.paths.len() - shown.len();
        let extra = if more > 0 {
            format!(" (+{more} more)")
        } else {
            String::new()
        };
        (
            SyncStatus::Desynchronized,
            Some(format!(
                "Pairing would overwrite {} file(s) on the {where_} that differ: {}{extra}",
                c.paths.len(),
                shown.join(", ")
            )),
        )
    } else if !final_local.is_repo || !final_remote.is_repo {
        // Still one side without a repo (source was unborn, or init failed) — nothing
        // to lock-step yet.
        (SyncStatus::Synchronized, None)
    } else if !diverged.is_empty() {
        (
            SyncStatus::Desynchronized,
            Some(format!("Diverged: {}", diverged.join(", "))),
        )
    } else if let Some(msg) = blocked {
        (SyncStatus::Desynchronized, Some(msg))
    } else if let Some(msg) = (!opts.mid_checkout)
        .then(|| head_mismatch(&final_local, &final_remote))
        .flatten()
    {
        // Refs agree but the two sides sit on different commits — a half-landed
        // checkout. Checked last: a real divergence or block is the better story.
        (SyncStatus::Desynchronized, Some(msg))
    } else {
        (SyncStatus::Synchronized, None)
    };

    // Only a completed, green pass may seed the early-out signatures — otherwise the
    // next pass could skip the work this one failed to do.
    let green = status == SyncStatus::Synchronized;
    let local_sig = green.then(|| refs_signature(&final_local));
    let remote_sig = green.then(|| refs_signature(&final_remote));
    persist(
        project_id,
        GitPeerState {
            enabled: prior.enabled,
            status,
            detail,
            local_subject: final_local.head_subject,
            remote_subject: final_remote.head_subject,
            local_head: final_local.head,
            remote_head: final_remote.head,
            last_sync_ts: Some(now_secs()),
            pairing_conflict,
            local_sig,
            remote_sig,
        },
    )
}

/// Whether the project's pooled SSH/SFTP session is up. The single gate every writing
/// path checks before it believes anything about the host (#28p D4).
pub async fn connected(pool: &RemotePoolState, project_id: &str) -> bool {
    crate::services::remote::pooled_sftp(pool, project_id)
        .await
        .is_some()
}

/// The state to report when the pool is cold (#28p D4). Keeps the last-known heads —
/// they are the last thing we actually observed — and drops the early-out signatures so
/// the first pass after reconnecting is a real one. Pure.
pub fn disconnected_state(prior: &GitPeerState) -> GitPeerState {
    GitPeerState {
        status: SyncStatus::Disconnected,
        detail: Some("Not connected to the remote host".to_string()),
        local_sig: None,
        remote_sig: None,
        ..prior.clone()
    }
}

/// Which side an initial pairing would `git init` + `reset --hard`, and whether *its*
/// probe failed. A dest we could not read is never treated as empty: a transient git or
/// network failure must not license a wipe (#28p D3.4). This used to guard only the
/// local mirror — while the remote host, reached over a flaky link, is the far likelier
/// side to misprobe. Pure.
pub fn pairing_dest_probe_error(
    source_is_local: bool,
    local: &PeerSnapshot,
    remote: &PeerSnapshot,
) -> bool {
    if source_is_local {
        remote.probe_error
    } else {
        local.probe_error
    }
}

/// Persist and return a state (every reconcile path ends here).
fn persist(project_id: &str, state: GitPeerState) -> GitPeerState {
    let _ = save_state(project_id, &state);
    state
}

/// The head sha of a peer, if any (branch or detached).
fn head_sha(snap: &PeerSnapshot) -> Option<String> {
    match &snap.head {
        Some(HeadRef::Branch { sha, .. }) | Some(HeadRef::Detached { sha }) => Some(sha.clone()),
        _ => None,
    }
}

/// Re-stamp the file-sync manifest bases for the tracked files a checkout rewrote
/// (between `old_sha` and the current HEAD on the local mirror), so the resumed auto
/// file-sync reads them green instead of as false local edits. Deleted tracked files
/// drop their manifest entry. Best-effort; needs the pooled SFTP for host stats.
async fn restamp_after_checkout(
    pool: &RemotePoolState,
    manifest: &remote_sync::SyncManifestState,
    project_id: &str,
    spec: &RemoteSpec,
    old_sha: &str,
) {
    let local = Peer::Local(mirror_dir(project_id));
    let new_sha = match head_sha(&probe(&local)) {
        Some(s) => s,
        None => return,
    };
    if old_sha == new_sha {
        return;
    }
    let changes = local
        .run(&["diff", "--name-status", old_sha, &new_sha])
        .map(|o| changed_tracked_paths(&String::from_utf8_lossy(&o.stdout)))
        .unwrap_or_default();
    if changes.is_empty() {
        return;
    }
    let sftp = crate::services::remote::pooled_sftp(pool, project_id).await;

    let mut g = manifest.lock().await;
    let m = remote_sync::ensure_loaded(&mut g, project_id);
    for ch in changes {
        if ch.deleted {
            m.remove(&ch.path);
            continue;
        }
        let local_path = mirror_local_path(project_id, &ch.path);
        let (ls, lm) = remote_sync::local_size_mtime(std::fs::metadata(&local_path).ok());
        let (hs, hm) = match &sftp {
            Some(s) => {
                let host_abs = remote_sync::join_remote(&spec.remote_path, &ch.path);
                sftp::metadata_on(s, &host_abs).await.unwrap_or((ls, lm))
            }
            None => (ls, lm),
        };
        remote_sync::record_pull(m, &ch.path, hs, hm, ls, lm);
    }
    let _ = remote_sync::save_manifest(project_id, m);
}

/// Seed the file-sync manifest for every git-tracked file right after an INITIAL
/// PAIRING materialized both peers to the same HEAD (so each tracked path is now
/// byte-identical across host and mirror). Marks each path selected and stamps its
/// host + local bases, so `compute_state` reads them green (in sync) instead of the
/// red "not tracked by selective sync" a freshly-extended/imported project would
/// otherwise show — there is nothing to transfer. This mirrors what
/// `restamp_after_checkout` does for a checkout, applied to the pairing moment.
/// Best-effort; needs the pooled SFTP for host stats (falls back to the local base
/// when the host can't be stat'd, matching `restamp_after_checkout`).
async fn seed_manifest_after_pairing(
    pool: &RemotePoolState,
    manifest: &remote_sync::SyncManifestState,
    project_id: &str,
    spec: &RemoteSpec,
) {
    let paths = tracked_paths(project_id);
    if paths.is_empty() {
        return;
    }
    let sftp = crate::services::remote::pooled_sftp(pool, project_id).await;

    let mut g = manifest.lock().await;
    let m = remote_sync::ensure_loaded(&mut g, project_id);
    for rel in paths {
        let local_path = mirror_local_path(project_id, &rel);
        let (ls, lm) = remote_sync::local_size_mtime(std::fs::metadata(&local_path).ok());
        let (hs, hm) = match &sftp {
            Some(s) => {
                let host_abs = remote_sync::join_remote(&spec.remote_path, &rel);
                sftp::metadata_on(s, &host_abs).await.unwrap_or((ls, lm))
            }
            None => (ls, lm),
        };
        remote_sync::record_pull(m, &rel, hs, hm, ls, lm);
    }
    let _ = remote_sync::save_manifest(project_id, m);
}

/// Coordinated checkout: pause file auto-sync, check the target out on the initiating
/// side (unless already done), reconcile so the peer has the commits, check the same
/// target out on the peer (a **guarded** checkout — never `-f`), re-stamp file-sync
/// bases, and resume. `initiating_side` is `"local"` or `"remote"`.
pub async fn checkout_lockstep(
    pool: &RemotePoolState,
    manifest: &remote_sync::SyncManifestState,
    auto: &crate::services::sync_auto::AutoSyncState,
    project_id: &str,
    spec: &RemoteSpec,
    target: &str,
    initiating_side: &str,
    already_checked_out: bool,
) -> Result<GitPeerState, String> {
    // `target` is a branch name that came out of the repo (either side's
    // `git branch` listing), and `git checkout <target>` has no `--` boundary — a
    // refname beginning with `-` would be parsed as an option on BOTH peers, one of
    // which runs over ssh. Validate once, here, before either `run` sees it.
    crate::commands::git::check_rev(target)?;
    // #28p D4: a checkout writes to both trees; never start one against a host we
    // cannot reach (the remote half would fail command by command).
    if !connected(pool, project_id).await {
        return Err("Not connected to the remote host".to_string());
    }
    crate::services::sync_auto::pause(auto, project_id).await;
    // Guarantee resume even on an early error.
    let result = checkout_lockstep_inner(
        pool,
        manifest,
        project_id,
        spec,
        target,
        initiating_side,
        already_checked_out,
    )
    .await;
    crate::services::sync_auto::resume(auto, project_id).await;
    result
}

async fn checkout_lockstep_inner(
    pool: &RemotePoolState,
    manifest: &remote_sync::SyncManifestState,
    project_id: &str,
    spec: &RemoteSpec,
    target: &str,
    initiating_side: &str,
    already_checked_out: bool,
) -> Result<GitPeerState, String> {
    let local = Peer::Local(mirror_dir(project_id));
    let remote = Peer::Remote(spec.clone());

    // Old local HEAD (for the post-checkout restamp diff).
    let old_local_sha = head_sha(&probe(&local)).unwrap_or_default();

    // 1. Check out on the initiating side if the caller hasn't already.
    if !already_checked_out {
        let initiating_local = initiating_side != "remote";
        let init_peer = if initiating_local { &local } else { &remote };
        let out = init_peer.run(&["checkout", target])?;
        if !out.status.success() {
            return Ok(desync_state(
                project_id,
                spec,
                &format!(
                    "Checkout on {initiating_side} failed: {}",
                    String::from_utf8_lossy(&out.stderr).trim()
                ),
            ));
        }
        // #28q: a checkout deletes the tracked files the target commit doesn't carry.
        // Audited only when Tabtivity ran it — `already_checked_out` means the user ran
        // `git checkout` themselves in a terminal, where git already said so.
        if initiating_local {
            audit_local_head_move(project_id, &old_local_sha, &format!("checkout '{target}'"));
        }
    }

    // 2. Bring commits/refs into step so the peer has the target commit. The peer's HEAD
    //    is still on the old target until step 3, so the head-mismatch rule must not fire
    //    on this deliberately-transient state.
    let mut state = reconcile_with(
        pool,
        manifest,
        project_id,
        spec,
        ReconcileOpts {
            mid_checkout: true,
            ..Default::default()
        },
    )
    .await;

    // 3. Guarded checkout on the peer (the side that did NOT initiate). When the peer is
    //    the mirror, this is the checkout that follows a branch switch made on the host —
    //    the one the user is least expecting to rewrite their local tree, so #28q audits
    //    it from the tip as it stands *now* (step 2's fast-forward, if any, already
    //    reported its own deletions).
    let peer_is_local = initiating_side == "remote";
    let peer = if peer_is_local { &local } else { &remote };
    let peer_name = if peer_is_local { "local" } else { "remote" };
    let pre_peer_checkout = peer_is_local.then(|| local_head_sha(project_id)).flatten();
    let out = peer.run(&["checkout", target])?;
    if let Some(before) = &pre_peer_checkout {
        audit_local_head_move(
            project_id,
            before,
            &format!("checkout '{target}' (following the host)"),
        );
    }
    if !out.status.success() {
        state = desync_state(
            project_id,
            spec,
            &format!(
                "Peer ({peer_name}) checkout blocked (uncommitted changes?): {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ),
        );
    }

    // 4. Re-stamp file-sync bases for what the checkout rewrote in the mirror
    //    (both directions ultimately rewrite the local mirror tree).
    restamp_after_checkout(pool, manifest, project_id, spec, &old_local_sha).await;

    // 5. Re-observe both sides. `state` was computed at step 2 — *before* step 3 moved
    //    the peer's HEAD — so returning it as-is persisted a peer head one checkout out
    //    of date. That is not merely a wrong pill: `detect_and_sync` decides "did the
    //    peer's HEAD move?" by comparing a fresh probe against this stored value, so a
    //    stale one **masks the peer's very next checkout**, and permanently — the stale
    //    state matches the probe, so no later pass sees a move either. Observed live: a
    //    local checkout, then a checkout on the host, and the mirror never followed while
    //    the pass reported green with the two sides on different branches.
    Ok(refresh_heads(project_id, spec, state))
}

/// Re-probe both peers and refresh a state's observed heads (and, when it is green, its
/// early-out signatures) before persisting it. Used by any path that *changes* a HEAD
/// after its status was computed.
fn refresh_heads(project_id: &str, spec: &RemoteSpec, mut state: GitPeerState) -> GitPeerState {
    let local = probe(&Peer::Local(mirror_dir(project_id)));
    let remote = probe(&Peer::Remote(spec.clone()));
    let green = state.status == SyncStatus::Synchronized;
    // Only a green pass may seed the early-out, exactly as in `reconcile_with`.
    state.local_sig = green.then(|| refs_signature(&local));
    state.remote_sig = green.then(|| refs_signature(&remote));
    state.local_subject = local.head_subject;
    state.remote_subject = remote.head_subject;
    state.local_head = local.head;
    state.remote_head = remote.head;
    persist(project_id, state)
}

/// Normalize a resolution authority string to whether the **local** side wins
/// (anything but `"remote"` is treated as local — the safer default of "keep my
/// working copy" for an unexpected value).
pub fn winner_is_local(authority: &str) -> bool {
    authority != "remote"
}

/// Explicit **Use local / Use remote** divergence resolution (#28n Phase 2). The
/// chosen `authority` (`"local"` or `"remote"`) becomes the source of truth: every
/// diverged branch — and every branch where the *losing* side is ahead — is reset to
/// the winner's commit, after the overwritten tip is saved to a timestamped
/// `refs/tabtivity/backup/*` safety ref so nothing is discarded irrecoverably. Conflicting
/// tags are force-moved the same way. File auto-sync is paused for the duration and its
/// tracked-file bases are re-stamped afterward (a losing local branch is `reset --hard`,
/// rewriting the mirror tree), then a normal reconcile recomputes the (now
/// `Synchronized`) status. A no-op reconcile is returned if either side lacks a repo.
pub async fn resolve(
    pool: &RemotePoolState,
    manifest: &remote_sync::SyncManifestState,
    auto: &crate::services::sync_auto::AutoSyncState,
    project_id: &str,
    spec: &RemoteSpec,
    authority: &str,
) -> Result<GitPeerState, String> {
    if !connected(pool, project_id).await {
        return Err("Not connected to the remote host".to_string());
    }
    crate::services::sync_auto::pause(auto, project_id).await;
    let result = resolve_inner(pool, manifest, project_id, spec, authority).await;
    crate::services::sync_auto::resume(auto, project_id).await;
    result
}

async fn resolve_inner(
    pool: &RemotePoolState,
    manifest: &remote_sync::SyncManifestState,
    project_id: &str,
    spec: &RemoteSpec,
    authority: &str,
) -> Result<GitPeerState, String> {
    let local = probe(&Peer::Local(mirror_dir(project_id)));
    let remote = probe(&Peer::Remote(spec.clone()));
    if !local.is_repo || !remote.is_repo {
        // Nothing paired to resolve; a plain reconcile may still initial-pair.
        return Ok(reconcile(pool, manifest, project_id, spec).await);
    }

    let old_local_sha = head_sha(&local).unwrap_or_default();
    let winner_local = winner_is_local(authority);
    // Force in the winner→loser direction: winner local ⇒ push to the remote loser.
    let to_remote = winner_local;
    let (source, dest) = if winner_local {
        (&local, &remote)
    } else {
        (&remote, &local)
    };

    // #28p D9: a force-reset of dest's checked-out branch runs `reset --hard`, which
    // silently clobbers a colliding untracked file. Refuse and name it rather than
    // guess — the same "blocked, user clears it, retries" UX a blocked fast-forward
    // already gets (D1/D2) — instead of trusting the backup-ref safety net to cover
    // something it structurally cannot (an untracked file was never a git object).
    if let Some(HeadRef::Branch {
        name,
        sha: dest_sha,
    }) = &dest.head
    {
        if let Some(target) = source.branches.iter().find(|r| &r.name == name) {
            if &target.sha != dest_sha {
                let (source_peer, dest_peer) = if to_remote {
                    (
                        Peer::Local(mirror_dir(project_id)),
                        Peer::Remote(spec.clone()),
                    )
                } else {
                    (
                        Peer::Remote(spec.clone()),
                        Peer::Local(mirror_dir(project_id)),
                    )
                };
                let collisions = reset_collisions(&source_peer, &dest_peer, &target.sha);
                if !collisions.is_empty() {
                    let where_ = if to_remote { "host" } else { "mirror" };
                    let shown: Vec<&str> = collisions.iter().take(5).map(String::as_str).collect();
                    let more = collisions.len() - shown.len();
                    let extra = if more > 0 {
                        format!(" (+{more} more)")
                    } else {
                        String::new()
                    };
                    return Err(format!(
                        "Refusing: {} untracked file(s) on the {where_} differ from '{name}' \
                         and are not in git: {}{extra}. Move or remove them, then retry.",
                        collisions.len(),
                        shown.join(", "),
                    ));
                }
            }
        }
    }

    transfer_and_apply(
        pool, manifest, project_id, spec, to_remote, source, dest, true,
    )
    .await?;

    // A losing local branch was `reset --hard`, rewriting mirror tracked files — refresh
    // the file-sync bases so the resumed auto-sync reads them green (no-op when the
    // remote was the loser, since the mirror tree is unchanged).
    restamp_after_checkout(pool, manifest, project_id, spec, &old_local_sha).await;

    // A resolution is where backup refs are born, so it is also where they are pruned
    // (#28p D6) — keeping the cost off the hot reconcile path, which creates none.
    prune_backups(project_id, spec);

    // Recompute status; the forced side is now in sync, so this should read Synchronized.
    Ok(reconcile(pool, manifest, project_id, spec).await)
}

// ── Backup refs: list / restore / prune (#28p D6) ────────────────────────────

/// Keep at least this many backups per peer, whatever their age…
const BACKUP_KEEP_N: usize = 20;
/// …and keep anything younger than this regardless of the count.
const BACKUP_MAX_AGE: u64 = 30 * 24 * 60 * 60;

/// Every `refs/tabtivity/backup/*` safety ref on one peer, newest first.
fn backups_on(peer: &Peer, label: &str) -> Vec<BackupRef> {
    peer.run(&[
        "for-each-ref",
        "--format=%(objectname)%09%(refname)%09%(contents:subject)",
        crate::brand::GIT_REF_BACKUP,
    ])
    .ok()
    .filter(|o| o.status.success())
    .map(|o| parse_backup_refs(label, &String::from_utf8_lossy(&o.stdout)))
    .unwrap_or_default()
}

/// Both peers' safety refs, newest first (#28p D6). Until this existed the backups
/// `resolve`/`init_pairing` create were write-only: they pinned objects forever and no
/// UI could list, restore from, or prune them — which also hollowed out the "it's
/// recoverable" defence of Use-local/Use-remote.
pub fn list_backups(project_id: &str, spec: &RemoteSpec) -> Vec<BackupRef> {
    let mut all = backups_on(&Peer::Local(mirror_dir(project_id)), "local");
    all.extend(backups_on(&Peer::Remote(spec.clone()), "remote"));
    all.sort_by(|a, b| b.ts.cmp(&a.ts).then_with(|| a.branch.cmp(&b.branch)));
    all
}

/// Move a branch back onto a backed-up tip. The branch's *current* tip is itself backed
/// up first — a restore must be as undoable as the thing it undoes.
///
/// This deliberately leaves the peers diverged (one side moved, the other didn't); the
/// next reconcile reports that, and the user resolves it with the authority they meant.
pub async fn restore_backup(
    pool: &RemotePoolState,
    manifest: &remote_sync::SyncManifestState,
    auto: &crate::services::sync_auto::AutoSyncState,
    project_id: &str,
    spec: &RemoteSpec,
    peer_label: &str,
    refname: &str,
) -> Result<GitPeerState, String> {
    if !connected(pool, project_id).await {
        return Err("Not connected to the remote host".to_string());
    }
    let (_, branch) = parse_backup_ref_name(refname).ok_or(concat!("Not a ", crate::app_name!(), " backup ref"))?;
    let peer = if peer_label == "remote" {
        Peer::Remote(spec.clone())
    } else {
        Peer::Local(mirror_dir(project_id))
    };

    let sha = peer
        .run(&["rev-parse", "--verify", "--quiet", refname])
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("Backup ref {refname} no longer resolves"))?;

    crate::services::sync_auto::pause(auto, project_id).await;
    let old_local_sha = head_sha(&probe(&Peer::Local(mirror_dir(project_id)))).unwrap_or_default();

    let snap = probe(&peer);
    let is_head = matches!(&snap.head, Some(HeadRef::Branch { name, .. }) if *name == branch);

    // #23 D1 applies here too: `force_reset_branch` falls through to `update-ref` for
    // any branch that is not the MAIN worktree's HEAD, and `update-ref` does not refuse
    // a branch a linked worktree has checked out. Resume auto-sync before returning.
    if !is_head && snap.checked_out.contains(&branch) {
        crate::services::sync_auto::resume(auto, project_id).await;
        return Err(format!(
            "'{branch}' is checked out in a linked worktree on the {peer_label} side. Moving it \
             would leave that worktree's index reverting the restore — remove the worktree (or \
             restore from inside it) and retry."
        ));
    }

    // #28p D9: same clobber risk as `resolve` — check before `force_reset_branch`'s
    // `reset --hard` on the checked-out branch. Resume auto-sync before returning so a
    // refusal never leaves it paused.
    if is_head {
        let collisions = reset_collisions(&peer, &peer, &sha);
        if !collisions.is_empty() {
            crate::services::sync_auto::resume(auto, project_id).await;
            let shown: Vec<&str> = collisions.iter().take(5).map(String::as_str).collect();
            let more = collisions.len() - shown.len();
            let extra = if more > 0 {
                format!(" (+{more} more)")
            } else {
                String::new()
            };
            return Err(format!(
                "Refusing to restore: {} untracked file(s) on the {peer_label} differ from \
                 the backup and are not in git: {}{extra}. Move or remove them, then retry.",
                collisions.len(),
                shown.join(", "),
            ));
        }
    }

    match sha_of(&snap, RefKind::Head, &branch) {
        // force_reset_branch backs the current tip up before moving it, so the state we
        // are restoring *away from* stays reachable too.
        Some(cur) => force_reset_branch(&peer, &branch, &sha, cur, is_head, now_secs()),
        // The branch is gone entirely (a resolve deleted it) — recreate it.
        None => {
            let _ = peer.run(&["update-ref", &format!("refs/heads/{branch}"), &sha]);
        }
    }

    // #28q: restoring a backup onto the mirror's checked-out branch is a `reset --hard`
    // like any other — it deletes the tracked files the older tip didn't have. (A no-op
    // when the restore was on the host: the mirror's HEAD never moved.)
    audit_local_head_move(
        project_id,
        &old_local_sha,
        &format!("restore backup '{branch}' (reset --hard on the mirror)"),
    );

    restamp_after_checkout(pool, manifest, project_id, spec, &old_local_sha).await;
    crate::services::sync_auto::resume(auto, project_id).await;

    prune_backups(project_id, spec);
    Ok(reconcile(pool, manifest, project_id, spec).await)
}

/// Drop the backup refs that are neither recent nor among the newest N, per peer, so the
/// namespace stops pinning objects forever. Never drops a peer's newest. Best-effort.
fn prune_backups(project_id: &str, spec: &RemoteSpec) {
    let now = now_secs();
    for (peer, label) in [
        (Peer::Local(mirror_dir(project_id)), "local"),
        (Peer::Remote(spec.clone()), "remote"),
    ] {
        let refs = backups_on(&peer, label);
        for refname in select_prunable(&refs, now, BACKUP_KEEP_N, BACKUP_MAX_AGE) {
            let _ = peer.run(&["update-ref", "-d", &refname]);
        }
    }
}

/// Build + persist a `Desynchronized` state with a message (probes current heads).
fn desync_state(project_id: &str, spec: &RemoteSpec, detail: &str) -> GitPeerState {
    let prior = load_state(project_id);
    let local = probe(&Peer::Local(mirror_dir(project_id)));
    let remote = probe(&Peer::Remote(spec.clone()));
    persist(
        project_id,
        GitPeerState {
            enabled: prior.enabled,
            status: SyncStatus::Desynchronized,
            detail: Some(detail.to_string()),
            local_subject: local.head_subject,
            remote_subject: remote.head_subject,
            local_head: local.head,
            remote_head: remote.head,
            last_sync_ts: Some(now_secs()),
            pairing_conflict: None,
            // Not green → never seed the early-out (it must not skip the retry).
            local_sig: None,
            remote_sig: None,
        },
    )
}

// ── Detection loop + registry ───────────────────────────────────────────────

/// One running git-peer lockstep task: its cancel signal, join handle, and the
/// `.git` watcher whose lifetime is tied to the task (dropping it unwatches).
pub struct GitPeerTask {
    cancel: Arc<Notify>,
    join: tokio::task::JoinHandle<()>,
}

/// Tauri-managed registry of per-project lockstep tasks, keyed by project id.
pub type GitPeerRegistry = Arc<Mutex<HashMap<String, GitPeerTask>>>;

/// Build a fresh, empty registry for `tauri::Builder::manage`.
pub fn new_registry() -> GitPeerRegistry {
    Arc::new(Mutex::new(HashMap::new()))
}

/// One async reconcile lock per project. Manual commands and the background
/// watcher/poll loop share the same fixed bundle paths and persisted state, so
/// their complete operations—not merely individual file writes—must serialize.
fn reconcile_locks() -> &'static std::sync::Mutex<HashMap<String, Arc<Mutex<()>>>> {
    static LOCKS: OnceLock<std::sync::Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    LOCKS.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

pub async fn reconcile_guard(project_id: &str) -> tokio::sync::OwnedMutexGuard<()> {
    let lock = {
        let mut locks = reconcile_locks().lock().unwrap_or_else(|e| e.into_inner());
        Arc::clone(
            locks
                .entry(project_id.to_string())
                .or_insert_with(|| Arc::new(Mutex::new(()))),
        )
    };
    lock.lock_owned().await
}

/// Attach the mirror's `.git` watcher once the repository exists. Initial
/// pairing may create `.git` after the task starts, so every interval tick
/// retries this cheap one-time attachment.
fn ensure_git_watcher(
    slot: &mut Option<notify::RecommendedWatcher>,
    gitdir: &Path,
    tx: &mpsc::UnboundedSender<()>,
) {
    if slot.is_some() || !gitdir.exists() {
        return;
    }
    let tx = tx.clone();
    let Ok(mut watcher) = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if res.is_ok() {
            let _ = tx.send(());
        }
    }) else {
        return;
    };
    if watcher.watch(gitdir, RecursiveMode::Recursive).is_ok() {
        *slot = Some(watcher);
    }
}

/// The `git-peer-status` event payload (camelCase).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StatusEvent {
    project_id: String,
    state: GitPeerState,
}

/// Emit the current lockstep state to the frontend.
pub fn emit_status(app: &AppHandle, project_id: &str, state: &GitPeerState) {
    let _ = app.emit(
        "git-peer-status",
        StatusEvent {
            project_id: project_id.to_string(),
            state: state.clone(),
        },
    );
}

/// Start the per-project lockstep task (idempotent; no-op for a local project or a
/// project whose lockstep toggle is off). Attaches a narrowly-scoped `.git` watcher
/// on the local mirror and spawns the host-poll loop. Runs one reconcile immediately.
pub async fn start(
    app: AppHandle,
    pool: RemotePoolState,
    manifest: SyncManifestState,
    auto: AutoSyncState,
    reg: &GitPeerRegistry,
    worker_sync: crate::services::worker_sync::WorkerSyncState,
    project_id: &str,
) {
    let Some(target) = remote_target_for(project_id) else {
        return;
    };
    if !load_state(project_id).enabled {
        return;
    }
    // A host tagged HPC gets no background poll loop: every tick runs `git` in the
    // host tree, which on a cluster sits on the parallel filesystem, and a repo
    // probe every 12 s for as long as the project is open is exactly the standing
    // load a login node's rules ask you not to put there. Lockstep's manual
    // reconcile (and the local `.git` watcher's push) still work — what stops is
    // Tabtivity asking the cluster, unprompted, forever.
    if crate::services::hpc_mode::is_hpc_spec(&target.spec) {
        return;
    }
    let mut guard = reg.lock().await;
    // A task that ended on its own (the loop breaks when the host is tagged HPC
    // mid-session) is a dead registry entry, not a running task: keeping it would
    // refuse every restart until a disconnect/reconnect, so untagging the host —
    // or toggling lockstep off and on — would silently leave the loop stopped.
    if guard
        .get(project_id)
        .is_some_and(|t| t.join.is_finished())
    {
        guard.remove(project_id);
    }
    if guard.contains_key(project_id) {
        return;
    }

    let (tx, rx) = mpsc::unbounded_channel::<()>();

    let cancel = Arc::new(Notify::new());
    let join = tokio::spawn(poll_loop(
        app,
        pool,
        manifest,
        auto,
        worker_sync,
        target.spec,
        project_id.to_string(),
        tx,
        rx,
        cancel.clone(),
    ));
    guard.insert(project_id.to_string(), GitPeerTask { cancel, join });
}

/// Stop the project's lockstep task (no-op if none).
pub async fn stop(reg: &GitPeerRegistry, project_id: &str) {
    let task = reg.lock().await.remove(project_id);
    if let Some(t) = task {
        t.cancel.notify_one();
        let _ = tokio::time::timeout(Duration::from_secs(5), t.join).await;
    }
}

/// Stop every lockstep task (app exit).
pub async fn stop_all(reg: &GitPeerRegistry) {
    let tasks: Vec<GitPeerTask> = reg.lock().await.drain().map(|(_, t)| t).collect();
    for t in tasks {
        t.cancel.notify_one();
        let _ = tokio::time::timeout(Duration::from_secs(5), t.join).await;
    }
}

#[allow(clippy::too_many_arguments)]
async fn poll_loop(
    app: AppHandle,
    pool: RemotePoolState,
    manifest: SyncManifestState,
    auto: AutoSyncState,
    worker_sync: crate::services::worker_sync::WorkerSyncState,
    spec: RemoteSpec,
    project_id: String,
    tx: mpsc::UnboundedSender<()>,
    mut rx: mpsc::UnboundedReceiver<()>,
    cancel: Arc<Notify>,
) {
    // Watch only `.git` (HEAD/refs/packed-refs live here) so ordinary file edits
    // remain the byte-sync watcher's concern. The watcher lives with this future.
    let gitdir = mirror_dir(&project_id).join(".git");
    let mut watcher: Option<notify::RecommendedWatcher> = None;
    ensure_git_watcher(&mut watcher, &gitdir, &tx);
    // Initial reconcile so both sides start in step. Forced: there is no prior pass in
    // this session to early-out against, and a stale green signature from the last run
    // must not skip it.
    let reconcile = reconcile_guard(&project_id).await;
    let s = detect_and_sync(
        &pool,
        &manifest,
        &auto,
        &project_id,
        &spec,
        ReconcileOpts {
            forced: true,
            ..Default::default()
        },
    )
    .await;
    drop(reconcile);
    emit_status(&app, &project_id, &s);
    // The primary now holds the current committed code; push it to any already-
    // connected workers (multi-host, `docs/multi_host_remote_plan.md` §2). Cheap
    // when they are already at HEAD (a mirror-head read, no network).
    crate::services::worker_sync::fan_out(&app, &pool, &worker_sync, &project_id, false).await;

    // The mirror's signature as this task last left it — what tells a watcher burst
    // caused by *our own* `.git` writes apart from one caused by the user. Every pass
    // writes inside `.git` (the bundle file, `refs/tabtivity/*`, the objects a fetch
    // deposits, `index`/`ORIG_HEAD` from a merge), and each of those trips the very
    // watcher that queues the next pass. While green the D5 early-out absorbed that;
    // while red — diverged, blocked, a pairing refusal — nothing did, and the loop
    // re-ran the full SSH pass every debounce window for as long as the state stayed
    // red. The signature covers everything a pass *acts* on (heads, tags, HEAD, the
    // tracked-dirty bit), so a burst that leaves it unchanged is either ours or a
    // no-op write, and the 12 s poll still covers anything that slips through.
    let mut own_sig = local_signature(&project_id);
    // Events our pass just caused are already queued by the time it returns; drop
    // them rather than debounce into a pass that would only re-derive the same state.
    drain_events(&mut rx);

    let mut interval = tokio::time::interval(GIT_POLL_INTERVAL);
    interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            _ = cancel.notified() => break,
            _ = interval.tick() => {
                // Re-read the HPC tag rather than trusting the one `start()` saw.
                // Tagging a login node is normally a reaction to noticing this very
                // poll; a gate evaluated only at start would leave it running until
                // the project is closed. Breaking ends the task — `stop()` then
                // finds it already finished, which is what a cancel leaves too.
                if crate::services::hpc_mode::is_hpc_spec(&spec) { break; }
                ensure_git_watcher(&mut watcher, &gitdir, &tx);
                let reconcile = reconcile_guard(&project_id).await;
                let s = detect_and_sync(
                    &pool, &manifest, &auto, &project_id, &spec, ReconcileOpts::default(),
                )
                .await;
                drop(reconcile);
                emit_status(&app, &project_id, &s);
                own_sig = local_signature(&project_id);
                drain_events(&mut rx);
            }
            res = rx.recv() => {
                if res.is_none() { break; }
                // A `.git` change reconciles against the host exactly as a tick
                // does, so it takes the same re-check.
                if crate::services::hpc_mode::is_hpc_spec(&spec) { break; }
                loop {
                    tokio::select! {
                        _ = cancel.notified() => return,
                        _ = tokio::time::sleep(GIT_DEBOUNCE) => break,
                        res = rx.recv() => { if res.is_none() { return; } }
                    }
                }
                // Nothing a pass acts on changed since we last left the mirror: this
                // burst is our own tail (or a stat-cache refresh). Skip the pass; the
                // interval still re-checks the host on its own schedule.
                let now_sig = local_signature(&project_id);
                if watcher_burst_is_own(&own_sig, &now_sig) {
                    continue;
                }
                let reconcile = reconcile_guard(&project_id).await;
                let s = detect_and_sync(
                    &pool, &manifest, &auto, &project_id, &spec, ReconcileOpts::default(),
                )
                .await;
                drop(reconcile);
                emit_status(&app, &project_id, &s);
                own_sig = local_signature(&project_id);
                drain_events(&mut rx);
                // A `.git` change on the mirror = a new commit/ref move; fan the
                // committed code out to every connected worker (plan §2 trigger).
                crate::services::worker_sync::fan_out(
                    &app, &pool, &worker_sync, &project_id, false,
                )
                .await;
            }
        }
    }
}

/// The mirror's current [`refs_signature`] — local git only, no network.
fn local_signature(project_id: &str) -> String {
    refs_signature(&probe(&Peer::Local(mirror_dir(project_id))))
}

/// Discard every watcher event already queued. Called right after a pass, whose own
/// `.git` writes are exactly what is sitting in the channel by then.
fn drain_events(rx: &mut mpsc::UnboundedReceiver<()>) {
    while rx.try_recv().is_ok() {}
}

/// Whether a debounced `.git` watcher burst changed nothing a pass acts on: the
/// mirror's signature (heads, tags, HEAD, tracked-dirty) still reads exactly as the
/// previous pass left it. True for the tail of our own writes and for git's
/// stat-cache refreshes; false for a commit, a checkout, a `git add`, a branch
/// create — anything the loop exists to notice. Pure.
pub fn watcher_burst_is_own(sig_after_last_pass: &str, sig_now: &str) -> bool {
    sig_after_last_pass == sig_now
}

/// Whether a peer's checkout *target* changed between two observations — a different
/// branch, a detach, a re-attach, or (while detached) a different commit. The one
/// thing that is deliberately **not** a move: the same branch at a newer sha, which is
/// what a commit looks like. `detect_and_sync` used to compare whole `HeadRef`s, so
/// every commit on the mirror replayed as a `git checkout <branch>` on the host —
/// harmless while both sides sat on that branch, and a silent branch switch on the
/// host (under its running jobs) whenever they did not. `None` prior → nothing to
/// compare against, never a move. Pure.
pub fn head_target_moved(prior: &Option<HeadRef>, now: &Option<HeadRef>) -> bool {
    if prior.is_none() {
        return false;
    }
    target_of(prior) != target_of(now)
}

/// The target (branch name or detached sha) a HEAD points at, if any.
fn target_of(head: &Option<HeadRef>) -> Option<String> {
    match head {
        Some(HeadRef::Branch { name, .. }) => Some(name.clone()),
        Some(HeadRef::Detached { sha }) => Some(sha.clone()),
        _ => None,
    }
}

/// One detection pass: if either side's HEAD moved since the last observed state,
/// treat it as a checkout on that side and lock the peer to the same target;
/// otherwise just fast-forward-reconcile refs. Persists + returns the new state.
pub async fn detect_and_sync(
    pool: &RemotePoolState,
    manifest: &SyncManifestState,
    auto: &AutoSyncState,
    project_id: &str,
    spec: &RemoteSpec,
    opts: ReconcileOpts,
) -> GitPeerState {
    // #28p D4: probing a disconnected host is six dead round trips whose failures read
    // as "the host is empty" — bail before any of that.
    if !connected(pool, project_id).await {
        return persist(project_id, disconnected_state(&load_state(project_id)));
    }
    let prior = load_state(project_id);
    let local = probe(&Peer::Local(mirror_dir(project_id)));
    let remote = probe(&Peer::Remote(spec.clone()));

    // A HEAD move is only actionable once we have a prior observation to compare to
    // (the first pass just records heads via reconcile). "Moved" means the checkout
    // *target* changed — see [`head_target_moved`] — not merely the sha: a commit
    // advances the sha of the same branch and is a fast-forward for `reconcile_with`,
    // not a checkout to replay on the peer.
    let local_moved = head_target_moved(&prior.local_head, &local.head);
    let remote_moved = head_target_moved(&prior.remote_head, &remote.head);

    if local_moved && remote_moved {
        // Both sides changed what they have checked out since the last look (a long
        // disconnect, two people, or two windows). There is no principled way to say
        // which side follows the other, and picking the mirror — as the `if`/`else if`
        // below used to — silently switched the host's branch under whatever was
        // running there. Reconcile refs only; if the two targets differ,
        // `head_mismatch` reports it and the Checkout action is one click away.
        return reconcile_with(pool, manifest, project_id, spec, opts).await;
    }
    if local_moved {
        if let Some(t) = target_of(&local.head) {
            if let Ok(s) =
                checkout_lockstep(pool, manifest, auto, project_id, spec, &t, "local", true).await
            {
                return s;
            }
        }
    } else if remote_moved {
        if let Some(t) = target_of(&remote.head) {
            if let Ok(s) =
                checkout_lockstep(pool, manifest, auto, project_id, spec, &t, "remote", true).await
            {
                return s;
            }
        }
    }
    reconcile_with(pool, manifest, project_id, spec, opts).await
}

#[cfg(test)]
mod tests {
    use crate::brand::SLUG;
    use super::*;

    #[tokio::test]
    async fn reconcile_guard_serializes_one_project_but_not_another() {
        let first = reconcile_guard("guard-test-a").await;
        // A different project is independent.
        let other =
            tokio::time::timeout(Duration::from_millis(100), reconcile_guard("guard-test-b"))
                .await
                .expect("another project must not share the lock");
        drop(other);

        let waiting = tokio::spawn(async { reconcile_guard("guard-test-a").await });
        tokio::task::yield_now().await;
        assert!(!waiting.is_finished(), "same-project reconcile overlapped");
        drop(first);
        let acquired = tokio::time::timeout(Duration::from_secs(1), waiting)
            .await
            .expect("waiter did not acquire after release")
            .expect("waiter task failed");
        drop(acquired);
    }

    /// Returns true when `git` is on PATH; probe tests skip gracefully otherwise.
    fn git_available() -> bool {
        crate::paths::command_no_window("git")
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    #[test]
    fn probe_missing_local_dir_is_clean_empty_not_error() {
        // A local dir that does not exist is a legitimately-empty side (nothing to
        // destroy) — it must NOT flag `probe_error`, so pairing can still create it.
        let missing = std::path::PathBuf::from(concat!("/definitely/not/a/real/", crate::app_slug!(), "/dir/xyz"));
        let snap = probe(&Peer::Local(missing));
        assert!(!snap.is_repo);
        assert!(!snap.probe_error, "missing dir must read as clean-empty");
    }

    #[test]
    fn probe_existing_non_repo_dir_is_clean_empty() {
        if !git_available() {
            eprintln!("git not on PATH — skipping probe_existing_non_repo_dir_is_clean_empty");
            return;
        }
        // An existing directory that is not a git repo: git runs and cleanly says
        // "no" → is_repo=false, but probe_error=false (safe to initialize).
        let tmp = tempfile::tempdir().expect("tempdir");
        let snap = probe(&Peer::Local(tmp.path().to_path_buf()));
        assert!(!snap.is_repo);
        assert!(
            !snap.probe_error,
            "an existing non-repo dir must be a clean-empty, not a probe error"
        );
    }

    #[test]
    fn parse_refs_reads_sha_and_short_name() {
        let out = "abc123 main\ndef456 feature/x\n\n  \n";
        let refs = parse_refs(out);
        assert_eq!(refs.len(), 2);
        assert_eq!(
            refs[0],
            RefEntry {
                name: "main".into(),
                sha: "abc123".into()
            }
        );
        assert_eq!(refs[1].name, "feature/x");
    }

    #[test]
    fn parse_head_branch_detached_unborn() {
        assert_eq!(
            parse_head("main\n", "abc\n"),
            HeadRef::Branch {
                name: "main".into(),
                sha: "abc".into()
            }
        );
        assert_eq!(
            parse_head("", "abc\n"),
            HeadRef::Detached { sha: "abc".into() }
        );
        assert_eq!(parse_head("", ""), HeadRef::Unborn);
    }

    #[test]
    fn is_dirty_tracked_ignores_untracked() {
        assert!(!is_dirty_tracked("?? newfile.txt\n?? other\n"));
        assert!(is_dirty_tracked(" M tracked.rs\n"));
        assert!(is_dirty_tracked("M  staged.rs\n"));
        assert!(is_dirty_tracked("?? a\n M b\n")); // any tracked line
        assert!(!is_dirty_tracked(""));
    }

    #[test]
    fn decide_truth_table() {
        assert_eq!(decide(None, "a", false, false), RefAction::CreateOnDest);
        assert_eq!(decide(Some("a"), "a", false, false), RefAction::InSync);
        assert_eq!(
            decide(Some("old"), "new", true, false),
            RefAction::FastForwardDest
        );
        assert_eq!(
            decide(Some("new"), "old", false, true),
            RefAction::DestAhead
        );
        assert_eq!(decide(Some("x"), "y", false, false), RefAction::Diverged);
    }

    #[test]
    fn bundle_create_args_shape_never_all() {
        let excl = vec!["r1".to_string(), "r2".to_string()];
        let args = bundle_create_args("/tmp/b.bundle", &["--branches", "--tags"], &excl);
        assert_eq!(&args[..3], &["bundle", "create", "/tmp/b.bundle"]);
        assert!(args.iter().any(|a| a == "--branches"));
        assert!(args.iter().any(|a| a == "--tags"));
        assert!(args.iter().any(|a| a == "--not"));
        assert!(
            args.iter().position(|a| a == "--not").unwrap()
                < args.iter().position(|a| a == "r1").unwrap()
        );
        // Guardrail: never `--all` (could pull odd refs), and no config/hook words.
        assert!(!args.iter().any(|a| a == "--all"));
        assert!(!args
            .iter()
            .any(|a| a.contains("config") || a.contains("hooks") || a.contains("remotes")));
    }

    #[test]
    fn bundle_create_args_full_when_no_excludes() {
        let args = bundle_create_args("/tmp/b", &["--branches", "--tags"], &[]);
        assert!(!args.iter().any(|a| a == "--not"));
    }

    // ── #28p D11: distinguish an empty-bundle no-op from a real failure ──────

    #[test]
    fn empty_bundle_error_is_recognized_precisely() {
        // Git's own literal refusal text (verified against a real `git bundle create`).
        assert!(is_empty_bundle_error(
            "fatal: Refusing to create empty bundle.\n"
        ));
        // A genuine I/O failure must NOT be mistaken for the no-op case — that is
        // exactly the false-green D11 exists to close.
        assert!(!is_empty_bundle_error(
            "fatal: could not write bundle: No space left on device\n"
        ));
        assert!(!is_empty_bundle_error("fatal: bad revision 'HEAD'\n"));
        assert!(!is_empty_bundle_error(""));
    }

    #[test]
    fn bundle_create_fails_empty_with_gits_exact_message() {
        // Pins the literal string `is_empty_bundle_error` matches against a real git,
        // so a future git release changing this wording fails loudly here rather than
        // silently making every genuine failure look like the safe no-op case.
        if !git_available() {
            eprintln!(
                "git not on PATH — skipping bundle_create_fails_empty_with_gits_exact_message"
            );
            return;
        }
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path();
        let peer = Peer::Local(dir.to_path_buf());
        peer.run(&["init", "-q", "."]).expect("git init");
        peer.run(&["config", "user.email", "t@e"])
            .expect("git config");
        peer.run(&["config", "user.name", "t"]).expect("git config");
        std::fs::write(dir.join("a.txt"), b"x").unwrap();
        peer.run(&["add", "a.txt"]).expect("git add");
        peer.run(&["commit", "-qm", "init"]).expect("git commit");
        let head =
            String::from_utf8_lossy(&peer.run(&["rev-parse", "HEAD"]).expect("rev-parse").stdout)
                .trim()
                .to_string();

        let bundle_path = dir.join("out.bundle").to_string_lossy().to_string();
        let args = bundle_create_args(&bundle_path, &["--branches"], &[head]);
        let argv: Vec<&str> = args.iter().map(String::as_str).collect();
        let out = peer.run(&argv).expect("bundle create");
        assert!(!out.status.success());
        assert!(
            is_empty_bundle_error(&String::from_utf8_lossy(&out.stderr)),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    #[test]
    fn incoming_refspecs_are_namespaced() {
        let specs = incoming_fetch_refspecs();
        assert!(specs[0].ends_with(concat!(":refs/", crate::app_slug!(), "/incoming/heads/*")));
        assert!(specs[1].ends_with(concat!(":refs/", crate::app_slug!(), "/incoming/tags/*")));
        // Never target real refs/heads or refs/remotes on the receiver.
        assert!(specs.iter().all(|s| {
            let dst = s.split(':').nth(1).unwrap();
            dst.starts_with(concat!("refs/", crate::app_slug!(), "/incoming/")) && !dst.contains("refs/remotes")
        }));
    }

    #[test]
    fn changed_tracked_paths_handles_deletions_and_renames() {
        let ns = "M\tsrc/a.rs\nD\tsrc/gone.rs\nR100\told/name.rs\tnew/name.rs\nA\tadded.rs\n";
        let ch = changed_tracked_paths(ns);
        assert_eq!(ch.len(), 4);
        assert_eq!(
            ch[0],
            TrackedChange {
                path: "src/a.rs".into(),
                deleted: false
            }
        );
        assert_eq!(
            ch[1],
            TrackedChange {
                path: "src/gone.rs".into(),
                deleted: true
            }
        );
        assert_eq!(
            ch[2],
            TrackedChange {
                path: "new/name.rs".into(),
                deleted: false
            }
        );
        assert!(!ch[3].deleted);
    }

    #[test]
    fn backup_ref_name_format() {
        assert_eq!(
            backup_ref_name("feature/x", 1735689600),
            concat!("refs/", crate::app_slug!(), "/backup/1735689600/feature/x")
        );
        // Tag conflicts back up under a `tags/` prefix so a branch and a same-named tag
        // never collide in the safety-ref namespace.
        assert_eq!(
            backup_ref_name("tags/v1", 1735689600),
            concat!("refs/", crate::app_slug!(), "/backup/1735689600/tags/v1")
        );
    }

    #[test]
    fn only_a_ref_write_is_blocked_by_a_linked_worktree() {
        // A plain reconcile never writes a dest-ahead or diverged branch, so a linked
        // worktree holding one is not "left alone" — there was nothing to do. It used
        // to report a block (red pill) for every worktree that was merely ahead.
        assert!(!would_move_ref(RefAction::InSync, false));
        assert!(!would_move_ref(RefAction::DestAhead, false));
        assert!(!would_move_ref(RefAction::Diverged, false));
        // The writes: a create, a fast-forward, and anything a forced resolve resets.
        assert!(would_move_ref(RefAction::CreateOnDest, false));
        assert!(would_move_ref(RefAction::FastForwardDest, false));
        assert!(would_move_ref(RefAction::DestAhead, true));
        assert!(would_move_ref(RefAction::Diverged, true));
        assert!(!would_move_ref(RefAction::InSync, true));
    }

    #[test]
    fn a_commit_is_not_a_checkout() {
        let on = |name: &str, sha: &str| {
            Some(HeadRef::Branch {
                name: name.into(),
                sha: sha.into(),
            })
        };
        let detached = |sha: &str| Some(HeadRef::Detached { sha: sha.into() });
        // Same branch, newer sha: a commit. `detect_and_sync` must hand this to the
        // fast-forward path, not replay `git checkout main` on the peer — which used
        // to switch the host's branch whenever it sat on a different one.
        assert!(!head_target_moved(&on("main", "a"), &on("main", "b")));
        assert!(!head_target_moved(&on("main", "a"), &on("main", "a")));
        // What IS a checkout: another branch, a detach, a re-attach, and — while
        // detached — another commit (the sha is the target there).
        assert!(head_target_moved(&on("main", "a"), &on("feat", "a")));
        assert!(head_target_moved(&on("main", "a"), &detached("a")));
        assert!(head_target_moved(&detached("a"), &on("main", "a")));
        assert!(head_target_moved(&detached("a"), &detached("b")));
        assert!(head_target_moved(&on("main", "a"), &Some(HeadRef::Unborn)));
        // No prior observation → nothing to compare → never a move.
        assert!(!head_target_moved(&None, &on("main", "a")));
    }

    #[test]
    fn a_watcher_burst_that_moved_nothing_is_our_own() {
        let quiet = on_branch("main", "a");
        let sig = refs_signature(&quiet);
        assert!(watcher_burst_is_own(&sig, &refs_signature(&quiet)));
        // A commit, a checkout, a `git add` (dirty bit) and a new branch all change
        // the signature and must wake the loop.
        assert!(!watcher_burst_is_own(&sig, &refs_signature(&on_branch("main", "b"))));
        assert!(!watcher_burst_is_own(&sig, &refs_signature(&on_branch("feat", "a"))));
        let mut dirty = on_branch("main", "a");
        dirty.dirty_tracked = true;
        assert!(!watcher_burst_is_own(&sig, &refs_signature(&dirty)));
        let mut branched = on_branch("main", "a");
        branched.branches.push(RefEntry {
            name: "feat".into(),
            sha: "c".into(),
        });
        assert!(!watcher_burst_is_own(&sig, &refs_signature(&branched)));
    }

    #[test]
    fn winner_is_local_defaults_to_local() {
        assert!(winner_is_local("local"));
        assert!(!winner_is_local("remote"));
        // Anything unexpected keeps the safer "my working copy wins" default.
        assert!(winner_is_local(""));
        assert!(winner_is_local("garbage"));
    }

    #[test]
    fn decide_under_force_targets_diverged_and_dest_ahead() {
        // The resolution force path acts exactly on the two actions that a normal
        // reconcile leaves for the user: a real divergence, and the loser being ahead.
        // (`force_reset_branch` is IO; this pins which classifications route into it.)
        assert_eq!(decide(Some("x"), "y", false, false), RefAction::Diverged);
        assert_eq!(
            decide(Some("new"), "old", false, true),
            RefAction::DestAhead
        );
        // Fast-forwardable / create / in-sync never need forcing (no data loss).
        assert_eq!(
            decide(Some("old"), "new", true, false),
            RefAction::FastForwardDest
        );
        assert_eq!(decide(None, "a", false, false), RefAction::CreateOnDest);
        assert_eq!(decide(Some("a"), "a", false, false), RefAction::InSync);
    }

    // ── #28p D1/D2: the blocked-fast-forward stderr ──────────────────────────

    #[test]
    fn parse_untracked_overwrite_paths_reads_gits_list() {
        // Verbatim shape of a real `git merge --ff-only` refusal (captured from git).
        let stderr =
            "error: The following untracked working tree files would be overwritten by merge:\n\
                      \tnew.txt\n\
                      \tsp ace.txt\n\
                      \tsrc/deep/file.rs\n\
                      Please move or remove them before you merge.\n\
                      Aborting\n";
        assert_eq!(
            parse_untracked_overwrite_paths(stderr),
            vec!["new.txt", "sp ace.txt", "src/deep/file.rs"]
        );
    }

    #[test]
    fn parse_untracked_overwrite_paths_unquotes_and_ignores_other_errors() {
        // core.quotePath wraps non-ASCII paths in C-escapes; \303\251 is "é".
        let stderr =
            "error: The following untracked working tree files would be overwritten by merge:\n\
                      \t\"caf\\303\\251.txt\"\n\
                      Please move or remove them before you merge.\n";
        assert_eq!(parse_untracked_overwrite_paths(stderr), vec!["café.txt"]);
        // A genuinely-dirty tree is a different message and yields no paths, so the
        // identical-content retry never fires for it.
        assert!(parse_untracked_overwrite_paths(
            "error: Your local changes to the following files would be overwritten by merge:\n\tsrc/a.rs\n"
        )
        .is_empty());
        assert!(parse_untracked_overwrite_paths("").is_empty());
    }

    #[test]
    fn blocked_detail_names_the_untracked_files_not_uncommitted_changes() {
        let stderr =
            "error: The following untracked working tree files would be overwritten by merge:\n\
                      \ta.txt\n\tb.txt\n\tc.txt\n\td.txt\n\
                      Please move or remove them before you merge.\n";
        let d = blocked_detail("main", stderr);
        assert!(d.contains("untracked"), "{d}");
        assert!(d.contains("a.txt") && d.contains("c.txt"), "{d}");
        assert!(d.contains("+1 more"), "{d}");
        // The old message claimed uncommitted changes for every blocked ff — the lie D2
        // exists to kill.
        assert!(!d.contains("uncommitted"), "{d}");

        // A blocked ff with no untracked list still says what git said.
        let dirty = blocked_detail("main", "error: Your local changes would be overwritten\n");
        assert!(dirty.contains("local changes"), "{dirty}");
    }

    #[test]
    fn unquote_git_path_passes_plain_paths_through() {
        assert_eq!(unquote_git_path("a/b c.txt"), "a/b c.txt");
        assert_eq!(unquote_git_path("\"a\\tb\""), "a\tb");
        assert_eq!(unquote_git_path("\"q\\\"uote\""), "q\"uote");
    }

    // ── #28p D1: lockstep owns the tracked tree ──────────────────────────────

    #[test]
    fn tracked_paths_lists_the_mirrors_tracked_files_only() {
        if !git_available() {
            eprintln!(
                "git not on PATH — skipping tracked_paths_lists_the_mirrors_tracked_files_only"
            );
            return;
        }
        // `tracked_paths` reads the mirror of a project id, so drive it through a repo
        // built at that exact path via the real `mirror_dir` mapping.
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path();
        let git = |args: &[&str]| {
            crate::paths::command_no_window("git")
                .args(args)
                .current_dir(dir)
                .output()
                .expect("git")
        };
        git(&["init", "-q", "."]);
        git(&["config", "user.email", "t@e"]);
        git(&["config", "user.name", "t"]);
        std::fs::write(dir.join("tracked.txt"), b"x").unwrap();
        std::fs::write(dir.join("untracked.txt"), b"y").unwrap();
        git(&["add", "tracked.txt"]);
        git(&["commit", "-qm", "x"]);

        let peer = Peer::Local(dir.to_path_buf());
        let out = peer.run(&["ls-files", "-z"]).expect("ls-files");
        let set: HashSet<String> = out
            .stdout
            .split(|&b| b == 0)
            .filter(|s| !s.is_empty())
            .map(|s| String::from_utf8_lossy(s).replace('\\', "/"))
            .collect();
        assert!(set.contains("tracked.txt"));
        assert!(
            !set.contains("untracked.txt"),
            "byte-sync keeps the untracked files"
        );
        assert!(!set.iter().any(|p| p.starts_with(".git/")));
    }

    /// Build a repo where `main` is one commit behind `feat`, `feat` adds `new.txt` +
    /// `keep.txt`, and `main` is checked out. Returns the repo dir and `feat`'s sha —
    /// the exact shape a byte-sync-outran-the-commit collision arrives in.
    fn repo_behind_by_one(dir: &Path) -> String {
        let git = |args: &[&str]| {
            crate::paths::command_no_window("git")
                .args(args)
                .current_dir(dir)
                .output()
                .expect("git")
        };
        git(&["init", "-q", "-b", "main", "."]);
        git(&["config", "user.email", "t@e"]);
        git(&["config", "user.name", "t"]);
        std::fs::write(dir.join("base.txt"), b"base\n").unwrap();
        git(&["add", "-A"]);
        git(&["commit", "-qm", "base"]);
        git(&["checkout", "-q", "-b", "feat"]);
        std::fs::write(dir.join("new.txt"), b"incoming content\n").unwrap();
        std::fs::write(dir.join("keep.txt"), b"also incoming\n").unwrap();
        git(&["add", "-A"]);
        git(&["commit", "-qm", "feat"]);
        let sha = String::from_utf8_lossy(&git(&["rev-parse", "HEAD"]).stdout)
            .trim()
            .to_string();
        git(&["checkout", "-q", "main"]);
        sha
    }

    /// A worktree file as git *checked it out*, with the line endings its filters
    /// applied normalized back out. Git for Windows defaults to `core.autocrlf=true`,
    /// so a blob committed with LF lands on disk with CRLF — the assertions below are
    /// about *which content* a fast-forward wrote, never about its line endings. The
    /// lockstep code itself never compares raw worktree bytes for this reason: it asks
    /// git (`hash-object`, which runs the same filters) whether the file already is the
    /// blob — see `blob_matches_worktree`.
    fn checked_out(path: &Path) -> Vec<u8> {
        let bytes = std::fs::read(path).unwrap();
        let mut out = Vec::with_capacity(bytes.len());
        for (i, &b) in bytes.iter().enumerate() {
            if b == b'\r' && bytes.get(i + 1) == Some(&b'\n') {
                continue;
            }
            out.push(b);
        }
        out
    }

    #[test]
    fn deleted_between_names_only_what_a_move_removes() {
        // #28q: the audit's whole job is to name the files a HEAD move deletes from the
        // working tree. `feat` ADDS new.txt/keep.txt on top of `main`, so moving forward
        // deletes nothing — and moving BACK (a checkout of the older commit, a
        // `reset --hard` onto it, a restored backup) deletes both. A warning that fired
        // on the forward move would be crying wolf on every ordinary fast-forward.
        if !git_available() {
            eprintln!("git not on PATH — skipping deleted_between_names_only_what_a_move_removes");
            return;
        }
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path();
        let feat = repo_behind_by_one(dir);
        let peer = Peer::Local(dir.to_path_buf());
        let main =
            String::from_utf8_lossy(&peer.run(&["rev-parse", "HEAD"]).expect("rev-parse").stdout)
                .trim()
                .to_string();

        assert!(
            deleted_between(&peer, &main, &feat).is_empty(),
            "a fast-forward that only adds files must warn about nothing"
        );

        let mut back = deleted_between(&peer, &feat, &main);
        back.sort();
        assert_eq!(back, vec!["keep.txt".to_string(), "new.txt".to_string()]);

        // An unmoved HEAD (the op failed, or was a ref-only update on a branch that is
        // not checked out) is not a deletion of anything.
        assert!(deleted_between(&peer, &feat, &feat).is_empty());
    }

    /// The blocked `merge --ff-only` and its stderr, against a real git.
    fn try_ff(peer: &Peer, sha: &str) -> (bool, String) {
        let o = peer.run(&["merge", "--ff-only", sha]).expect("merge");
        (
            o.status.success(),
            String::from_utf8_lossy(&o.stderr).to_string(),
        )
    }

    #[test]
    fn ff_retry_clears_byte_identical_untracked_files_and_succeeds() {
        if !git_available() {
            eprintln!("git not on PATH — skipping ff_retry_clears_byte_identical_untracked_files");
            return;
        }
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path();
        let sha = repo_behind_by_one(dir);
        let peer = Peer::Local(dir.to_path_buf());

        // The D1 collision: byte-sync already delivered the files the incoming commit
        // carries, so they sit here untracked and byte-identical.
        std::fs::write(dir.join("new.txt"), b"incoming content\n").unwrap();
        std::fs::write(dir.join("keep.txt"), b"also incoming\n").unwrap();

        // Git refuses even though the bytes match — the behaviour the whole fix exists
        // for. (If this ever stops being true, the retry is dead code and should go.)
        let (ok, stderr) = try_ff(&peer, &sha);
        assert!(
            !ok,
            "git is expected to refuse over identical untracked files"
        );
        assert!(!parse_untracked_overwrite_paths(&stderr).is_empty());

        // #28q: the retry reports WHICH files it deleted to get here, so the caller can
        // warn about them — a `git diff` never could, they were never tracked.
        let retry = retry_ff_clearing_identical(&peer, &sha, &stderr, &HashSet::new());
        let FfRetry::Cleared(cleared) = &retry else {
            panic!("identical untracked files must be cleared and the ff retried");
        };
        // Both collisions are named — the warning the caller files must not under-report
        // what it deleted just because the ff put identical bytes straight back.
        let mut named = cleared.clone();
        named.sort();
        assert_eq!(named, vec!["keep.txt".to_string(), "new.txt".to_string()]);
        // The fast-forward landed, and the files are now TRACKED at the incoming content.
        let head = probe(&peer);
        assert_eq!(
            head.head,
            Some(HeadRef::Branch {
                name: "main".into(),
                sha: sha.clone()
            })
        );
        assert_eq!(checked_out(&dir.join("new.txt")), b"incoming content\n");
        assert!(!head.dirty_tracked);
    }

    #[test]
    fn ff_retry_refuses_when_any_colliding_file_differs() {
        if !git_available() {
            eprintln!(
                "git not on PATH — skipping ff_retry_refuses_when_any_colliding_file_differs"
            );
            return;
        }
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path();
        let sha = repo_behind_by_one(dir);
        let peer = Peer::Local(dir.to_path_buf());

        // One collision is identical; the other holds REAL unsynced work.
        std::fs::write(dir.join("new.txt"), b"incoming content\n").unwrap();
        std::fs::write(dir.join("keep.txt"), b"MY UNSAVED WORK\n").unwrap();

        let (ok, stderr) = try_ff(&peer, &sha);
        assert!(!ok);
        assert!(
            matches!(
                retry_ff_clearing_identical(&peer, &sha, &stderr, &HashSet::new()),
                FfRetry::Refused
            ),
            "one differing file must abort the whole retry"
        );
        // All-or-nothing: nothing was deleted — not even the identical one — and the
        // branch did not move. The user's work is still there to be seen and merged.
        assert_eq!(
            std::fs::read(dir.join("keep.txt")).unwrap(),
            b"MY UNSAVED WORK\n"
        );
        assert_eq!(
            std::fs::read(dir.join("new.txt")).unwrap(),
            b"incoming content\n"
        );
        assert!(matches!(
            probe(&peer).head,
            Some(HeadRef::Branch { ref name, .. }) if name == "main"
        ));
        // And the message the user gets names the real culprit rather than inventing
        // uncommitted changes (D2).
        let detail = blocked_detail("main", &stderr);
        assert!(detail.contains("keep.txt"), "{detail}");
    }

    #[test]
    fn ff_retry_clears_a_differing_file_when_named_as_stale_residue() {
        // Case #12: `keep.txt` differs from the incoming commit, but the caller has
        // already proven (via the sync manifest) that it is byte-sync's own old copy —
        // this is what makes the retry succeed where the plain identical-only check
        // above refuses.
        if !git_available() {
            eprintln!("git not on PATH — skipping ff_retry_clears_a_differing_file_when_named_as_stale_residue");
            return;
        }
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path();
        let sha = repo_behind_by_one(dir);
        let peer = Peer::Local(dir.to_path_buf());

        std::fs::write(dir.join("new.txt"), b"incoming content\n").unwrap();
        std::fs::write(dir.join("keep.txt"), b"stale pre-commit copy\n").unwrap();

        let (ok, stderr) = try_ff(&peer, &sha);
        assert!(!ok);
        let residue: HashSet<String> = ["keep.txt".to_string()].into_iter().collect();
        // Cleared *and named*: `keep.txt`'s old copy is the one thing this retry destroys
        // that the ff does not put back byte-for-byte, which is what the caller warns
        // about (#28q).
        assert!(
            matches!(
                retry_ff_clearing_identical(&peer, &sha, &stderr, &residue),
                FfRetry::Cleared(ref cleared) if cleared.contains(&"keep.txt".to_string())
            ),
            "a file named as proven stale residue must be cleared even though it differs"
        );
        assert_eq!(checked_out(&dir.join("keep.txt")), b"also incoming\n");
        assert!(matches!(
            probe(&peer).head,
            Some(HeadRef::Branch { sha: ref s, .. }) if s == &sha
        ));
    }

    #[tokio::test]
    async fn stale_residue_recognizes_content_already_known_to_git() {
        // #28p D10: `f.txt` sits on the dest, untracked, holding content that WAS once
        // committed there (a prior commit, later untracked — the shape a byte-synced
        // leftover takes once lockstep starts owning the path). `g.txt` holds content
        // that has never been part of any commit — real, never-synced work — and must
        // never be treated as safe even though the manifest also has an entry for it.
        // `h.txt` holds git-known content too, but carries NO manifest entry, so the
        // scope gate must exclude it regardless of what its content proves.
        if !git_available() {
            eprintln!(
                "git not on PATH — skipping stale_residue_recognizes_content_already_known_to_git"
            );
            return;
        }
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path();
        let git = |args: &[&str]| {
            crate::paths::command_no_window("git")
                .args(args)
                .current_dir(dir)
                .output()
                .expect("git")
        };
        git(&["init", "-q", "."]);
        git(&["config", "user.email", "t@e"]);
        git(&["config", "user.name", "t"]);
        std::fs::write(dir.join("f.txt"), b"old committed content\n").unwrap();
        std::fs::write(dir.join("h.txt"), b"old committed content\n").unwrap();
        git(&["add", "f.txt", "h.txt"]);
        git(&["commit", "-qm", "add"]);
        // Untrack both, then leave f.txt/h.txt holding that SAME (git-known) content,
        // and g.txt holding content nothing has ever recorded.
        git(&["rm", "-q", "--cached", "f.txt", "h.txt"]);
        git(&["commit", "-qm", "untrack"]);
        std::fs::write(dir.join("g.txt"), b"totally new, never committed\n").unwrap();

        let project_id = format!("d10-test-{}-{}", std::process::id(), line!());
        let manifest = remote_sync::new_manifest_state();
        {
            let mut g = manifest.lock().await;
            let m = remote_sync::ensure_loaded(&mut g, &project_id);
            m.insert("f.txt".to_string(), remote_sync::SyncEntry::default());
            m.insert("g.txt".to_string(), remote_sync::SyncEntry::default());
            // h.txt deliberately has no manifest entry.
        }

        let peer = Peer::Local(dir.to_path_buf());
        let paths = vec![
            "f.txt".to_string(),
            "g.txt".to_string(),
            "h.txt".to_string(),
        ];
        let residue = stale_byte_sync_residue(&manifest, &project_id, &peer, &paths).await;
        assert!(
            residue.contains("f.txt"),
            "content matching a git-known blob must be recognized as safe residue"
        );
        assert!(
            !residue.contains("g.txt"),
            "content nothing has ever recorded must never be treated as safe to delete, \
             manifest entry or not"
        );
        assert!(
            !residue.contains("h.txt"),
            "a path outside the manifest's scope must be excluded regardless of content"
        );

        forget_synced_paths(&manifest, &project_id, &paths).await;
        {
            let mut g = manifest.lock().await;
            let m = remote_sync::ensure_loaded(&mut g, &project_id);
            assert!(
                m.is_empty(),
                "the bases must be dropped once lockstep owns the paths"
            );
        }

        if let Some(parent) = remote_sync::manifest_path(&project_id).parent() {
            let _ = std::fs::remove_dir_all(parent);
        }
    }

    // ── #28p D3: pairing collisions + symmetric probe-error refusal ──────────

    fn fp(size: u64, hash: Option<&str>) -> Fingerprint {
        Fingerprint {
            size,
            hash: hash.map(str::to_string),
        }
    }

    #[test]
    fn pairing_collisions_only_flags_files_that_actually_differ() {
        let source: HashMap<String, Fingerprint> = [
            ("same.txt".to_string(), fp(3, Some("aaa"))),
            ("differs.txt".to_string(), fp(3, Some("bbb"))),
            ("bigger.txt".to_string(), fp(9, Some("ccc"))),
            ("source-only.txt".to_string(), fp(1, Some("ddd"))),
        ]
        .into_iter()
        .collect();
        let dest: HashMap<String, Fingerprint> = [
            // Byte-identical: the EXPECTED case when file-sync already mirrored the
            // tree — pairing must adopt these, not refuse over them.
            ("same.txt".to_string(), fp(3, Some("aaa"))),
            // Same size, different content → a real difference.
            ("differs.txt".to_string(), fp(3, Some("zzz"))),
            // Different size → differs without needing a hash at all.
            ("bigger.txt".to_string(), fp(4, None)),
            // Only on the dest → pairing doesn't touch it.
            ("dest-only.txt".to_string(), fp(2, Some("eee"))),
        ]
        .into_iter()
        .collect();
        assert_eq!(
            pairing_collisions(&source, &dest),
            vec!["bigger.txt", "differs.txt"]
        );
        // Nothing in common → nothing at risk.
        assert!(pairing_collisions(&source, &HashMap::new()).is_empty());
    }

    #[test]
    fn pairing_collisions_treat_an_unprovable_match_as_a_difference() {
        // Same size but the dest's hash couldn't be computed: `reset --hard` is
        // destructive, so "probably fine" is not good enough.
        let source: HashMap<String, Fingerprint> = [("f".to_string(), fp(3, Some("aaa")))]
            .into_iter()
            .collect();
        let dest: HashMap<String, Fingerprint> =
            [("f".to_string(), fp(3, None))].into_iter().collect();
        assert_eq!(pairing_collisions(&source, &dest), vec!["f"]);
    }

    #[test]
    fn parse_ls_tree_long_reads_blobs_with_sizes() {
        let out = b"100644 blob aaa111    6\tsrc/a.rs\x00100755 blob bbb222   12\tb in.sh\x00160000 commit ccc333       -\tsub\x00";
        let m = parse_ls_tree_long(out);
        assert_eq!(
            m.len(),
            2,
            "submodules/commits carry no bytes and are skipped"
        );
        assert_eq!(m["src/a.rs"], fp(6, Some("aaa111")));
        assert_eq!(m["b in.sh"], fp(12, Some("bbb222")));
    }

    #[test]
    fn pairing_dest_probe_error_is_symmetric() {
        let clean = PeerSnapshot::default();
        let errored = PeerSnapshot {
            probe_error: true,
            ..Default::default()
        };
        // Source local ⇒ the host is the side we'd init+reset: its probe error blocks.
        assert!(pairing_dest_probe_error(true, &clean, &errored));
        assert!(!pairing_dest_probe_error(true, &errored, &clean));
        // Source remote ⇒ the mirror is the dest (the case that was already guarded).
        assert!(pairing_dest_probe_error(false, &errored, &clean));
        assert!(!pairing_dest_probe_error(false, &clean, &errored));
        assert!(!pairing_dest_probe_error(true, &clean, &clean));
    }

    // ── #28p D4: disconnected ────────────────────────────────────────────────

    #[tokio::test]
    async fn cold_pool_reads_as_disconnected_not_connected() {
        // The gate every writing path checks: an empty pool is not a connection, so no
        // probe ever runs and no host state is believed (a dropped SSH exits non-zero,
        // which `probe` would otherwise read as "the host is a clean, empty side").
        let pool = crate::services::remote::new_pool();
        assert!(!connected(&pool, "no-such-project").await);
    }

    #[test]
    fn disconnected_state_keeps_heads_and_drops_the_early_out() {
        let prior = GitPeerState {
            enabled: true,
            status: SyncStatus::Synchronized,
            local_head: Some(HeadRef::Branch {
                name: "main".into(),
                sha: "a".into(),
            }),
            remote_head: Some(HeadRef::Branch {
                name: "main".into(),
                sha: "a".into(),
            }),
            local_sig: Some("sig".into()),
            remote_sig: Some("sig".into()),
            ..Default::default()
        };
        let s = disconnected_state(&prior);
        assert_eq!(s.status, SyncStatus::Disconnected);
        assert!(s.enabled, "the opt-in survives a dropped link");
        assert_eq!(
            s.local_head, prior.local_head,
            "last-known heads are still shown"
        );
        // Signatures must not persist across a disconnect, else the first pass after
        // reconnecting could early-out on a stale green.
        assert!(s.local_sig.is_none() && s.remote_sig.is_none());
    }

    // ── #28p D5: batched probe + ancestry + early-out ────────────────────────

    #[test]
    fn parse_probe_block_round_trips_a_synthesized_block() {
        let block = format!(
            "repo{RS}main\n{RS}abc123\n{RS}abc123 main\ndef456 feat\n{RS}t1t1 v1.0\n{RS} M src/a.rs\n?? new\n{RS}Fix the thing\n"
        );
        let s = parse_probe_block(&block).expect("parses");
        assert!(s.is_repo && !s.probe_error);
        assert_eq!(
            s.head,
            Some(HeadRef::Branch {
                name: "main".into(),
                sha: "abc123".into()
            })
        );
        assert_eq!(s.branches.len(), 2);
        assert_eq!(s.branches[1].name, "feat");
        assert_eq!(
            s.tags,
            vec![RefEntry {
                name: "v1.0".into(),
                sha: "t1t1".into()
            }]
        );
        assert!(
            s.dirty_tracked,
            "a tracked modification, despite the ?? line"
        );
        assert_eq!(s.head_subject.as_deref(), Some("Fix the thing"));
    }

    #[test]
    fn parse_probe_block_tolerates_empty_sections_and_a_non_repo() {
        // Unborn HEAD, no branches, no tags, clean tree, no subject.
        let s = parse_probe_block(&format!("repo{RS}{RS}{RS}{RS}{RS}{RS}")).expect("parses");
        assert!(s.is_repo);
        assert_eq!(s.head, Some(HeadRef::Unborn));
        assert!(s.branches.is_empty() && s.tags.is_empty() && !s.dirty_tracked);
        assert!(s.head_subject.is_none());

        let none = parse_probe_block("norepo").expect("parses");
        assert!(!none.is_repo && !none.probe_error);

        // Garbage (no POSIX sh, or a link that died mid-script) → the caller must fall
        // back to the per-command probe rather than believe a half-read snapshot.
        assert!(parse_probe_block("").is_none());
        assert!(parse_probe_block("sh: 1: git: not found\n").is_none());
    }

    #[test]
    fn ancestry_script_and_block_round_trip() {
        let pairs = vec![
            ("aaa".to_string(), "bbb".to_string()),
            ("ccc".to_string(), "ddd".to_string()),
        ];
        let script = ancestry_script(&pairs);
        assert!(script.contains("merge-base --is-ancestor aaa bbb"));
        assert!(script.contains("merge-base --is-ancestor bbb aaa"));

        assert_eq!(
            parse_ancestry_block("10\n01\n", 2),
            Some(vec![(true, false), (false, true)])
        );
        assert_eq!(
            parse_ancestry_block("00\n11\n", 2),
            Some(vec![(false, false), (true, true)])
        );
        // A misaligned answer is never used: a wrong bit here would misclassify a
        // divergence, so the caller falls back to per-branch checks instead.
        assert_eq!(parse_ancestry_block("10\n", 2), None);
        assert_eq!(parse_ancestry_block("", 1), None);
    }

    /// Run a script through a real POSIX `sh` in `dir`, exactly as
    /// `ssh_exec::run_remote_script` has the remote shell run it. A syntax error here
    /// would make every remote probe fall back to the six-round-trip path *silently* —
    /// D5 would look implemented and do nothing.
    #[cfg(unix)]
    fn run_sh(dir: &Path, script: &str) -> String {
        let out = std::process::Command::new("sh")
            .arg("-c")
            .arg(format!("cd {} && {{ {script}\n}}", dir.display()))
            .output()
            .expect("sh");
        assert!(
            out.status.success(),
            "script failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).to_string()
    }

    #[cfg(unix)]
    #[test]
    fn probe_script_runs_in_a_real_shell_and_parses() {
        if !git_available() {
            eprintln!("git not on PATH — skipping probe_script_runs_in_a_real_shell_and_parses");
            return;
        }
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path();
        let sha = repo_behind_by_one(dir); // leaves `main` checked out, `feat` ahead
        std::fs::write(dir.join("base.txt"), b"edited\n").unwrap(); // tracked, dirty

        let snap = parse_probe_block(&run_sh(dir, PROBE_SCRIPT))
            .expect("the batched probe must parse its own script's output");
        assert!(snap.is_repo && !snap.probe_error);
        assert!(matches!(&snap.head, Some(HeadRef::Branch { name, .. }) if name == "main"));
        assert_eq!(snap.branches.len(), 2, "main + feat");
        assert!(snap
            .branches
            .iter()
            .any(|b| b.name == "feat" && b.sha == sha));
        assert!(snap.dirty_tracked);
        assert_eq!(snap.head_subject.as_deref(), Some("base"));

        // The one-round-trip answer must match the six-round-trip one it replaces.
        let per_cmd = probe_per_command(&Peer::Local(dir.to_path_buf()));
        assert_eq!(snap.head, per_cmd.head);
        assert_eq!(snap.dirty_tracked, per_cmd.dirty_tracked);
        assert_eq!(snap.branches.len(), per_cmd.branches.len());
    }

    /// #23 D1 — the single most valuable test in the worktree audit, and the one
    /// whose absence let the corruption ship.
    ///
    /// `git symbolic-ref HEAD` at the peer root answers for the MAIN worktree only,
    /// so a branch checked out in a linked worktree read as an ordinary unattached
    /// ref and every lockstep ref move for it went down the `update-ref` arm. That
    /// arm does not refuse (verified: exit 0, silent) — unlike `git branch -f`,
    /// which answers `fatal: cannot force update the branch 'feat' used by worktree
    /// at '…'`. The worktree's HEAD moved under it and its index was left staging a
    /// revert of the incoming change, which the commit UI's `git add -A` would then
    /// commit.
    ///
    /// The whole fix is upstream of the decision: the probe has to *see* the linked
    /// checkout. So that is what this asserts, on both probe paths.
    #[cfg(unix)]
    #[test]
    fn the_probe_sees_a_branch_checked_out_in_a_linked_worktree() {
        if !git_available() {
            eprintln!("git not on PATH — skipping");
            return;
        }
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path();
        repo_behind_by_one(dir); // `main` checked out, `feat` ahead and unattached
        let wt = tmp.path().join("wt-feat");
        let out = std::process::Command::new("git")
            .args(["worktree", "add", &wt.to_string_lossy(), "feat"])
            .current_dir(dir)
            .output()
            .expect("git worktree add");
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );

        let snap = parse_probe_block(&run_sh(dir, PROBE_SCRIPT)).expect("parses");
        // HEAD alone still says only "main" — which is exactly the blind spot.
        assert!(matches!(&snap.head, Some(HeadRef::Branch { name, .. }) if name == "main"));
        assert!(
            snap.checked_out.iter().any(|b| b == "feat"),
            "the batched probe must report the linked worktree's branch: {:?}",
            snap.checked_out
        );
        assert!(snap.checked_out.iter().any(|b| b == "main"));

        // The per-command fallback must agree, or a peer that fell back would
        // silently lose the protection.
        let per_cmd = probe_per_command(&Peer::Local(dir.to_path_buf()));
        let mut a = snap.checked_out.clone();
        let mut b = per_cmd.checked_out.clone();
        a.sort();
        b.sort();
        assert_eq!(a, b);

        // And the guard derived from it names `feat` and only `feat`.
        let linked = linked_checkout_branches(&snap);
        assert!(linked.contains("feat"));
        assert!(
            !linked.contains("main"),
            "the MAIN worktree's branch is handled by the reset/merge arm, not blocked"
        );
    }

    #[test]
    fn linked_checkout_branches_excludes_the_main_worktrees_head() {
        let snap = PeerSnapshot {
            is_repo: true,
            head: Some(HeadRef::Branch {
                name: "main".into(),
                sha: "abc".into(),
            }),
            checked_out: vec!["main".into(), "feat".into(), "wip".into()],
            ..Default::default()
        };
        let linked = linked_checkout_branches(&snap);
        assert_eq!(linked.len(), 2);
        assert!(linked.contains("feat") && linked.contains("wip"));

        // A detached peer has no HEAD branch to exclude, so every checkout is linked.
        let detached = PeerSnapshot {
            is_repo: true,
            head: Some(HeadRef::Detached { sha: "abc".into() }),
            checked_out: vec!["feat".into()],
            ..Default::default()
        };
        assert!(linked_checkout_branches(&detached).contains("feat"));

        // A peer whose git never answered reads as "nothing linked" — the pre-#23
        // behaviour, never a false block on every branch.
        assert!(linked_checkout_branches(&PeerSnapshot::default()).is_empty());
    }

    #[test]
    fn checked_out_branches_skips_detached_and_bare_worktrees() {
        let text = "worktree /r\nHEAD abc\nbranch refs/heads/main\n\n\
                    worktree /r/wt\nHEAD def\ndetached\n\n\
                    worktree /r/bare.git\nbare\n\n\
                    worktree /r/wt2\nHEAD ghi\nbranch refs/heads/feat\n";
        let mut got = checked_out_branches(text);
        got.sort();
        assert_eq!(got, vec!["feat".to_string(), "main".to_string()]);
    }

    #[cfg(unix)]
    #[test]
    fn probe_script_reports_a_non_repo_dir() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let snap = parse_probe_block(&run_sh(tmp.path(), PROBE_SCRIPT)).expect("parses");
        assert!(!snap.is_repo);
        // A clean "not a repo" is a legitimately-empty side we may pair into — it must
        // never be confused with a probe that could not run (which would license a wipe).
        assert!(!snap.probe_error);
    }

    #[cfg(unix)]
    #[test]
    fn ancestry_script_runs_in_a_real_shell_and_agrees_with_merge_base() {
        if !git_available() {
            eprintln!("git not on PATH — skipping ancestry_script_runs_in_a_real_shell");
            return;
        }
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path();
        let feat = repo_behind_by_one(dir);
        let peer = Peer::Local(dir.to_path_buf());
        let main = String::from_utf8_lossy(&peer.run(&["rev-parse", "main"]).unwrap().stdout)
            .trim()
            .to_string();

        // main is strictly behind feat → (dest=main is ancestor of source=feat) = true,
        // and the reverse false. Plus a self-pair, which is an ancestor of itself.
        let pairs = vec![(main.clone(), feat.clone()), (feat.clone(), feat.clone())];
        let out = run_sh(dir, &ancestry_script(&pairs));
        let got = parse_ancestry_block(&out, 2).expect("batched ancestry must parse");
        assert_eq!(got, vec![(true, false), (true, true)]);

        // And it agrees with the per-pair `merge-base` calls it replaces.
        let fallback: Vec<(bool, bool)> = pairs
            .iter()
            .map(|(d, s)| (is_ancestor(&peer, d, s), is_ancestor(&peer, s, d)))
            .collect();
        assert_eq!(got, fallback);
    }

    #[test]
    fn is_hex_sha_gates_what_reaches_the_shell() {
        assert!(is_hex_sha("abc123"));
        assert!(!is_hex_sha(""));
        assert!(!is_hex_sha("abc; rm -rf /"));
        assert!(!is_hex_sha("$(whoami)"));
    }

    #[test]
    fn early_out_only_when_green_and_nothing_moved() {
        let snap = PeerSnapshot {
            is_repo: true,
            head: Some(HeadRef::Branch {
                name: "main".into(),
                sha: "a".into(),
            }),
            branches: vec![RefEntry {
                name: "main".into(),
                sha: "a".into(),
            }],
            ..Default::default()
        };
        let sig = refs_signature(&snap);
        let green = GitPeerState {
            status: SyncStatus::Synchronized,
            local_sig: Some(sig.clone()),
            remote_sig: Some(sig.clone()),
            ..Default::default()
        };
        assert!(can_early_out(&green, &sig, &sig, true, false));
        // A moved ref on either side.
        assert!(!can_early_out(&green, "other", &sig, true, false));
        assert!(!can_early_out(&green, &sig, "other", true, false));
        // A manual Retry always looks (the user may have cleared a blocker that moved
        // no ref at all — deleting an untracked collision, say).
        assert!(!can_early_out(&green, &sig, &sig, true, true));
        // Never skip a pass that has real work: a red state, or an unpaired side.
        let red = GitPeerState {
            status: SyncStatus::Desynchronized,
            ..green.clone()
        };
        assert!(!can_early_out(&red, &sig, &sig, true, false));
        assert!(!can_early_out(&green, &sig, &sig, false, false));
        // A first-ever pass has no signatures to compare against.
        assert!(!can_early_out(
            &GitPeerState::default(),
            &sig,
            &sig,
            true,
            false
        ));
    }

    #[test]
    fn refs_signature_moves_when_dirty_flips() {
        // A dirty→clean transition can unblock a fast-forward, so it must not be
        // invisible to the early-out.
        let clean = PeerSnapshot {
            is_repo: true,
            ..Default::default()
        };
        let dirty = PeerSnapshot {
            is_repo: true,
            dirty_tracked: true,
            ..Default::default()
        };
        assert_ne!(refs_signature(&clean), refs_signature(&dirty));
    }

    // ── Out-of-step HEADs (live-QA case 17/19) ───────────────────────────────

    fn on_branch(name: &str, sha: &str) -> PeerSnapshot {
        PeerSnapshot {
            is_repo: true,
            head: Some(HeadRef::Branch {
                name: name.into(),
                sha: sha.into(),
            }),
            ..Default::default()
        }
    }

    #[test]
    fn peers_on_the_same_head_are_in_step() {
        assert_eq!(
            head_mismatch(&on_branch("main", "aaa"), &on_branch("main", "aaa")),
            None
        );
        // Nothing observed on a side → nothing to claim.
        assert_eq!(
            head_mismatch(&on_branch("main", "aaa"), &PeerSnapshot::default()),
            None
        );
    }

    #[test]
    fn peers_on_different_branches_are_not_green() {
        // The live failure: every ref matched on both sides, so `reconcile_with` — which
        // compares only refs — called it Synchronized while the mirror sat on `master`
        // and the host on `feat-x`. A half-landed checkout is not "in step".
        let msg = head_mismatch(&on_branch("master", "aaa"), &on_branch("feat-x", "bbb"))
            .expect("different branches must not be green");
        assert!(msg.contains("master") && msg.contains("feat-x"), "{msg}");
    }

    #[test]
    fn detached_peer_is_reported_against_a_branch() {
        let detached = PeerSnapshot {
            is_repo: true,
            head: Some(HeadRef::Detached {
                sha: "cafebabe1234".into(),
            }),
            ..Default::default()
        };
        let msg = head_mismatch(&on_branch("main", "aaa"), &detached).expect("out of step");
        assert!(msg.contains("detached at cafebabe"), "{msg}");
    }

    // ── #28p D6: backup refs ─────────────────────────────────────────────────

    #[test]
    fn backup_ref_name_round_trips_through_the_parser() {
        for branch in ["main", "feature/x", "tags/v1"] {
            let name = backup_ref_name(branch, 1735689600);
            assert_eq!(
                parse_backup_ref_name(&name),
                Some((1735689600, branch.to_string()))
            );
        }
        assert_eq!(parse_backup_ref_name("refs/heads/main"), None);
        assert_eq!(
            parse_backup_ref_name(concat!("refs/", crate::app_slug!(), "/backup/notanumber/x")),
            None
        );
    }

    #[test]
    fn parse_backup_refs_reads_for_each_ref_output() {
        let out = concat!("aaa\trefs/", crate::app_slug!(), "/backup/100/main\tOld tip\n\
                   bbb\trefs/", crate::app_slug!(), "/backup/200/feature/x\tNewer tip\n\
                   ccc\trefs/heads/main\tnot a backup\n");
        let refs = parse_backup_refs("local", out);
        assert_eq!(refs.len(), 2);
        assert_eq!(refs[0].ts, 200, "newest first");
        assert_eq!(refs[0].branch, "feature/x");
        assert_eq!(refs[0].peer, "local");
        assert_eq!(refs[1].subject, "Old tip");
    }

    #[test]
    fn select_prunable_keeps_the_newest_n_and_anything_recent() {
        let now = 1_800_000_000u64; // a plausible epoch; must exceed the ages below
        let day = 24 * 60 * 60;
        let mk = |ts: u64| BackupRef {
            peer: "local".into(),
            refname: format!("refs/{SLUG}/backup/{ts}/main"),
            ts,
            branch: "main".into(),
            sha: "a".into(),
            subject: String::new(),
        };
        // Three ancient, two recent.
        let refs = vec![
            mk(now - 100 * day),
            mk(now - 90 * day),
            mk(now - 80 * day),
            mk(now - 2 * day),
            mk(now - day),
        ];
        // keep_n=2 → the two newest survive on count; the recent ones survive on age
        // anyway; the three ancient ones beyond the count go.
        let pruned = select_prunable(&refs, now, 2, 30 * day);
        assert_eq!(pruned.len(), 3);
        assert!(pruned
            .iter()
            .all(|r| r.contains(&format!("{}", now - 100 * day))
                || r.contains(&format!("{}", now - 90 * day))
                || r.contains(&format!("{}", now - 80 * day))));

        // Age alone protects a ref even past the count.
        assert!(select_prunable(&refs, now, 0, 30 * day).len() == 3);
        // The newest is NEVER pruned, however aggressive the policy.
        let all_ancient = vec![mk(now - 100 * day), mk(now - 99 * day)];
        let pruned = select_prunable(&all_ancient, now, 0, 0);
        assert_eq!(pruned.len(), 1);
        assert!(pruned[0].contains(&format!("{}", now - 100 * day)));
        assert!(select_prunable(&[], now, 0, 0).is_empty());
    }

    // ── #28p D7: origin propagation ──────────────────────────────────────────

    #[test]
    fn origin_propagates_only_into_a_dest_that_has_none() {
        assert_eq!(
            should_propagate_origin(Some("git@github.com:me/p.git"), None),
            Some("git@github.com:me/p.git".to_string())
        );
        // The dest already has its own origin → never overwritten.
        assert_eq!(
            should_propagate_origin(Some("git@github.com:me/p.git"), Some("git@other:x.git")),
            None
        );
        // Nothing to propagate.
        assert_eq!(should_propagate_origin(None, None), None);
        assert_eq!(should_propagate_origin(Some("  "), None), None);
    }

    // ── #28p D8: peer refs for a hand-resolved divergence ────────────────────

    #[test]
    fn only_diverged_branches_park_a_peer_ref() {
        assert_eq!(peer_ref_op(RefAction::Diverged, false), PeerRefOp::Set);
        // Everything in step (or already resolved) clears the ref, so it never outlives
        // the divergence it documents.
        assert_eq!(peer_ref_op(RefAction::InSync, false), PeerRefOp::Delete);
        assert_eq!(
            peer_ref_op(RefAction::FastForwardDest, false),
            PeerRefOp::Delete
        );
        assert_eq!(
            peer_ref_op(RefAction::CreateOnDest, false),
            PeerRefOp::Delete
        );
        assert_eq!(peer_ref_op(RefAction::DestAhead, false), PeerRefOp::Delete);
        // A forced pass RESOLVES the divergence, so it clears rather than parks.
        assert_eq!(peer_ref_op(RefAction::Diverged, true), PeerRefOp::Delete);
        assert_eq!(peer_ref_name("feature/x"), concat!("refs/", crate::app_slug!(), "/peer/feature/x"));
    }

    // ── #28p D9: force-reset collisions ──────────────────────────────────────

    /// A fresh repo at `dir` with one commit tracking `path` = `content`. Returns the
    /// commit sha.
    fn init_repo_with_file(dir: &Path, path: &str, content: &[u8]) -> String {
        let git = |args: &[&str]| {
            crate::paths::command_no_window("git")
                .args(args)
                .current_dir(dir)
                .output()
                .expect("git")
        };
        git(&["init", "-q", "."]);
        git(&["config", "user.email", "t@e"]);
        git(&["config", "user.name", "t"]);
        std::fs::write(dir.join(path), content).unwrap();
        git(&["add", path]);
        git(&["commit", "-qm", "add"]);
        String::from_utf8_lossy(&git(&["rev-parse", "HEAD"]).stdout)
            .trim()
            .to_string()
    }

    #[test]
    fn reset_collisions_flags_only_the_differing_source_tracked_path() {
        if !git_available() {
            eprintln!("git not on PATH — skipping reset_collisions_flags_only_the_differing_source_tracked_path");
            return;
        }
        let src_tmp = tempfile::tempdir().expect("tempdir");
        let sha = init_repo_with_file(src_tmp.path(), "keep.txt", b"committed content\n");
        let source = Peer::Local(src_tmp.path().to_path_buf());

        let dst_tmp = tempfile::tempdir().expect("tempdir");
        let dst = dst_tmp.path();
        crate::paths::command_no_window("git")
            .args(["init", "-q", "."])
            .current_dir(dst)
            .output()
            .expect("git init");
        // Differs from what the target sha tracks → at risk.
        std::fs::write(dst.join("keep.txt"), b"MY UNSAVED WORK\n").unwrap();
        // Untracked but not something the source's tree even mentions → never at risk.
        std::fs::write(dst.join("other.txt"), b"unrelated\n").unwrap();
        let dest = Peer::Local(dst.to_path_buf());

        assert_eq!(reset_collisions(&source, &dest, &sha), vec!["keep.txt"]);
    }

    #[test]
    fn reset_collisions_allows_byte_identical_untracked_files() {
        if !git_available() {
            eprintln!(
                "git not on PATH — skipping reset_collisions_allows_byte_identical_untracked_files"
            );
            return;
        }
        let src_tmp = tempfile::tempdir().expect("tempdir");
        let sha = init_repo_with_file(src_tmp.path(), "keep.txt", b"committed content\n");
        let source = Peer::Local(src_tmp.path().to_path_buf());

        let dst_tmp = tempfile::tempdir().expect("tempdir");
        let dst = dst_tmp.path();
        crate::paths::command_no_window("git")
            .args(["init", "-q", "."])
            .current_dir(dst)
            .output()
            .expect("git init");
        std::fs::write(dst.join("keep.txt"), b"committed content\n").unwrap();
        let dest = Peer::Local(dst.to_path_buf());

        assert!(
            reset_collisions(&source, &dest, &sha).is_empty(),
            "byte-identical untracked content is a no-op for reset --hard, not a collision"
        );
    }

    #[test]
    fn reset_collisions_within_a_single_peer_detects_the_restore_backup_case() {
        // `restore_backup` calls this with source_peer == dest_peer: the backup ref
        // and the untracked collision live on the same repo.
        if !git_available() {
            eprintln!("git not on PATH — skipping reset_collisions_within_a_single_peer_detects_the_restore_backup_case");
            return;
        }
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path();
        let backup_sha = init_repo_with_file(dir, "secret.env", b"old committed secret\n");
        let git = |args: &[&str]| {
            crate::paths::command_no_window("git")
                .args(args)
                .current_dir(dir)
                .output()
                .expect("git")
        };
        // A later commit untracks the path (the shape restoring an OLDER backup onto
        // a repo that has since moved on produces), then the now-untracked file is
        // edited — real, never-committed work sitting where the backup would land it.
        git(&["rm", "-q", "--cached", "secret.env"]);
        git(&["commit", "-qm", "untrack secret"]);
        std::fs::write(dir.join("secret.env"), b"NEW LOCAL WORK\n").unwrap();

        let peer = Peer::Local(dir.to_path_buf());
        assert_eq!(
            reset_collisions(&peer, &peer, &backup_sha),
            vec!["secret.env"]
        );
    }

    #[test]
    fn state_default_is_disabled_and_synchronized() {
        let s = GitPeerState::default();
        assert!(!s.enabled);
        assert_eq!(s.status, SyncStatus::Synchronized);
    }

    #[test]
    fn state_roundtrips_camelcase() {
        let s = GitPeerState {
            enabled: true,
            status: SyncStatus::Desynchronized,
            detail: Some("Diverged: main".into()),
            local_head: Some(HeadRef::Branch {
                name: "main".into(),
                sha: "a".into(),
            }),
            remote_head: Some(HeadRef::Detached { sha: "b".into() }),
            last_sync_ts: Some(42),
            local_subject: Some("Fix it".into()),
            remote_subject: None,
            pairing_conflict: Some(PairingConflict {
                source_is_local: true,
                paths: vec!["README.md".into()],
            }),
            local_sig: None,
            remote_sig: None,
        };
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("\"lastSyncTs\":42"));
        assert!(json.contains("\"localHead\""));
        assert!(json.contains("\"kind\":\"branch\""));
        assert!(json.contains("\"desynchronized\""));
        assert!(json.contains("\"pairingConflict\""));
        assert!(json.contains("\"sourceIsLocal\":true"));
        let back: GitPeerState = serde_json::from_str(&json).unwrap();
        assert_eq!(back.status, SyncStatus::Desynchronized);
        assert_eq!(
            back.remote_head,
            Some(HeadRef::Detached { sha: "b".into() })
        );
        assert_eq!(back.pairing_conflict.unwrap().paths, vec!["README.md"]);
    }

    #[test]
    fn state_from_before_28p_still_loads() {
        // Every field #28p added is `#[serde(default)]`, so a `git_peer.json` written by
        // the shipped #28n build keeps working instead of resetting the opt-in.
        let old = r#"{"enabled":true,"status":"synchronized","detail":null,
                      "localHead":{"kind":"unborn"},"remoteHead":null,"lastSyncTs":7}"#;
        let s: GitPeerState = serde_json::from_str(old).unwrap();
        assert!(s.enabled);
        assert_eq!(s.status, SyncStatus::Synchronized);
        assert!(s.pairing_conflict.is_none() && s.local_sig.is_none());
    }

    // ── The half-seeded host: `git init` ran, the checkout never did ─────────
    //
    // Live failure (DemoProj, extend-local-to-remote): the host ended up holding a
    // `.git` and an empty working tree, permanently, and the pill blamed a branch that
    // existed on neither side ("the mirror is on 'transfer-learning', the host is on
    // 'master'"). Three bugs in series; one test each, plus the gate that repairs it.

    /// Bug 1. `git rev-parse HEAD` on an unborn repo prints the literal `HEAD` to
    /// **stdout** and reports the failure only in its exit status. `PROBE_SCRIPT`
    /// discarded that status, so `parse_head` was handed `("master", "HEAD")` and built
    /// `Branch { name: "master", sha: "HEAD" }` — a branch nobody has, at a sha that is
    /// not a sha. `parse_head` now demands a real object name, so no probe, however
    /// broken, can fabricate a checked-out branch again.
    #[test]
    fn parse_head_never_invents_a_branch_from_a_non_sha() {
        assert_eq!(parse_head("master", "HEAD"), HeadRef::Unborn);
        assert_eq!(parse_head("", "HEAD"), HeadRef::Unborn);
        assert_eq!(parse_head("main", ""), HeadRef::Unborn);
        assert_eq!(parse_head("main", "not-a-sha"), HeadRef::Unborn);
        // …while a real head still parses exactly as before.
        assert_eq!(
            parse_head("main", "abc123"),
            HeadRef::Branch {
                name: "main".into(),
                sha: "abc123".into()
            }
        );
        assert_eq!(
            parse_head("", "abc123"),
            HeadRef::Detached {
                sha: "abc123".into()
            }
        );
    }

    /// Bug 1, at the level that actually shipped. `parse_probe_block_tolerates_empty_
    /// sections_and_a_non_repo` already asserted "unborn → `HeadRef::Unborn`", and passed
    /// throughout — because it *synthesized* the block by hand with an empty sha section,
    /// encoding the very assumption that was false. So: drive the real `PROBE_SCRIPT`
    /// through a real `sh` against a real `git init`ed repo, and read what git actually
    /// prints. This is the test that would have caught it.
    #[cfg(unix)]
    #[test]
    fn probe_script_reports_a_real_unborn_repo_as_unborn() {
        if !git_available() {
            eprintln!("git not on PATH — skipping probe_script_reports_a_real_unborn_repo");
            return;
        }
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path();
        crate::paths::command_no_window("git")
            .args(["init", "-q", "-b", "master", "."])
            .current_dir(dir)
            .output()
            .expect("git init");

        let snap = parse_probe_block(&run_sh(dir, PROBE_SCRIPT)).expect("parses");
        assert!(snap.is_repo, "a bare `git init` IS a repo…");
        assert_eq!(
            snap.head,
            Some(HeadRef::Unborn),
            "…but its HEAD is unborn — NOT `Branch {{ name: \"master\", sha: \"HEAD\" }}`"
        );
        assert!(snap.branches.is_empty() && snap.head_subject.is_none());
        // The batched remote probe and the per-command local one must agree about what
        // unborn looks like, or the bug simply moves to whichever path a peer takes.
        assert_eq!(
            snap.head,
            probe_per_command(&Peer::Local(dir.to_path_buf())).head
        );
        // And the whole point: this side is not seeded, so it is still pairable.
        assert!(!is_seeded(&snap));
    }

    /// Bug 2. The pairing gate keyed on `is_repo`, but `git init` is pairing's own first
    /// step — so a seed that died after it flipped the gate shut behind itself. The dest
    /// was a repo forever after, "exactly one side is a repo" never fired again, and the
    /// steady-state path only ever moves refs (`update-ref`); it never positions HEAD or
    /// checks out. Hence: objects and refs on the host, empty tree, forever.
    #[test]
    fn a_bare_git_init_is_not_seeded_and_stays_pairable() {
        let unborn = PeerSnapshot {
            is_repo: true,
            head: Some(HeadRef::Unborn),
            ..Default::default()
        };
        let seeded = PeerSnapshot {
            is_repo: true,
            head: Some(HeadRef::Branch {
                name: "transfer-learning".into(),
                sha: "a5b535d".into(),
            }),
            branches: vec![RefEntry {
                name: "transfer-learning".into(),
                sha: "a5b535d".into(),
            }],
            ..Default::default()
        };
        let absent = PeerSnapshot::default();

        assert!(!is_seeded(&absent), "not a repo");
        assert!(!is_seeded(&unborn), "a repo, but nothing is checked out");
        assert!(is_seeded(&seeded));
        assert!(is_seeded(&PeerSnapshot {
            is_repo: true,
            head: Some(HeadRef::Detached {
                sha: "abc123".into()
            }),
            ..Default::default()
        }));

        // The live case: mirror seeded, host `git init`ed and never checked out.
        assert_eq!(
            pair_plan(&seeded, &unborn),
            PairPlan::Pair {
                source_is_local: true
            },
            "the half-seeded host must be re-paired, not treated as a peer"
        );
        // Under the old `is_repo` gate this was `Sync` — which moved refs and never a
        // single file, which is exactly how it wedged.
        assert!(
            seeded.is_repo && unborn.is_repo,
            "…and both ARE repos, which is the trap"
        );

        assert_eq!(
            pair_plan(&seeded, &absent),
            PairPlan::Pair {
                source_is_local: true
            }
        );
        assert_eq!(
            pair_plan(&absent, &seeded),
            PairPlan::Pair {
                source_is_local: false
            }
        );
        assert_eq!(pair_plan(&seeded, &seeded), PairPlan::Sync);
        assert_eq!(pair_plan(&absent, &absent), PairPlan::Nothing);
        assert_eq!(
            pair_plan(&unborn, &unborn),
            PairPlan::Nothing,
            "nothing to move either way"
        );
    }

    /// The nastiest shape of bug 2: the refs DID land (the steady-state pass creates them
    /// with `update-ref`), so the host looks populated by every measure except the only
    /// one that matters — whether anything is checked out. A gate that looked at branches
    /// rather than HEAD would call this seeded and wedge exactly as before.
    #[test]
    fn a_host_with_refs_but_no_checkout_is_still_unseeded() {
        let mirror = PeerSnapshot {
            is_repo: true,
            head: Some(HeadRef::Branch {
                name: "transfer-learning".into(),
                sha: "a5b535d".into(),
            }),
            branches: vec![RefEntry {
                name: "transfer-learning".into(),
                sha: "a5b535d".into(),
            }],
            ..Default::default()
        };
        // Every ref arrived; HEAD is still unborn. Empty working tree.
        let host = PeerSnapshot {
            is_repo: true,
            head: Some(HeadRef::Unborn),
            branches: vec![
                RefEntry {
                    name: "transfer-learning".into(),
                    sha: "a5b535d".into(),
                },
                RefEntry {
                    name: "main".into(),
                    sha: "64bd1c3".into(),
                },
            ],
            ..Default::default()
        };
        assert!(!is_seeded(&host), "refs are not a checkout");
        assert_eq!(
            pair_plan(&mirror, &host),
            PairPlan::Pair {
                source_is_local: true
            }
        );
    }

    /// Bug 3's other half: a half-seeded side must never be able to *early-out* of the
    /// very pass that would repair it. `can_early_out` now gates on both sides being
    /// seeded, not on both being repos.
    #[test]
    fn early_out_never_skips_a_half_seeded_side() {
        let prior = GitPeerState {
            status: SyncStatus::Synchronized,
            local_sig: Some("sig".into()),
            remote_sig: Some("sig".into()),
            ..Default::default()
        };
        assert!(
            can_early_out(&prior, "sig", "sig", true, false),
            "both seeded + green + unmoved → skip, as before"
        );
        assert!(
            !can_early_out(&prior, "sig", "sig", false, false),
            "a side that was never checked out must always be re-examined"
        );
    }

    /// The constraint on the repair: it must never cost the user a local file. When the
    /// mirror is the unseeded side, pairing writes *it* — so the D3 collision guard is
    /// what stands between `reset --hard` and the user's untracked work, and it must fail
    /// CLOSED. A dest file that cannot be proven byte-identical to what the source would
    /// write over it (`hash: None` — the hash could not be computed) is a conflict, which
    /// blocks the pairing and raises the prompt instead of clobbering.
    #[test]
    fn pairing_into_the_mirror_refuses_to_clobber_unproven_local_files() {
        let source: HashMap<String, Fingerprint> = [
            (
                "README.md".to_string(),
                Fingerprint {
                    size: 10,
                    hash: Some("aaa".into()),
                },
            ),
            (
                "src/a.rs".to_string(),
                Fingerprint {
                    size: 20,
                    hash: Some("bbb".into()),
                },
            ),
        ]
        .into_iter()
        .collect();

        // Same path, same size, but the hash could not be established → NOT provably
        // identical → refused rather than overwritten.
        let unproven: HashMap<String, Fingerprint> = [(
            "README.md".to_string(),
            Fingerprint {
                size: 10,
                hash: None,
            },
        )]
        .into_iter()
        .collect();
        assert_eq!(
            pairing_collisions(&source, &unproven),
            vec!["README.md".to_string()]
        );

        // Differing content → refused.
        let differs: HashMap<String, Fingerprint> = [(
            "src/a.rs".to_string(),
            Fingerprint {
                size: 20,
                hash: Some("zzz".into()),
            },
        )]
        .into_iter()
        .collect();
        assert_eq!(
            pairing_collisions(&source, &differs),
            vec!["src/a.rs".to_string()]
        );

        // Byte-identical → adopting it is a no-op, so pairing proceeds (the intended
        // "the mirror already holds these files" path).
        let identical: HashMap<String, Fingerprint> = [(
            "README.md".to_string(),
            Fingerprint {
                size: 10,
                hash: Some("aaa".into()),
            },
        )]
        .into_iter()
        .collect();
        assert!(pairing_collisions(&source, &identical).is_empty());

        // A local file the source does not track is not a collision at all — and
        // `reset --hard` never removes untracked paths, so it survives the pairing.
        let untracked: HashMap<String, Fingerprint> = [(
            "data/big.npz".to_string(),
            Fingerprint {
                size: 999,
                hash: None,
            },
        )]
        .into_iter()
        .collect();
        assert!(pairing_collisions(&source, &untracked).is_empty());
    }
}
