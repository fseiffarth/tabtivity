//! The shared tab set of a scope — the workspace service (headless owner plan,
//! H1, `docs/headless_owner_plan.md` §2).
//!
//! What every client must see identically is a scope's ordered tabs with
//! their persisted fields (`TerminalSession::tab_layout`). Until now each
//! client wrote that back **whole** (`save_tab_layout`): two writers erased
//! each other's tabs, and one client racing itself lost four. Here the file
//! carries a version, every tab a stable `id`, and a client sends its snapshot
//! together with the version it last saw. The difference between that
//! snapshot and what the client knew at that version is the per-operation
//! change it meant — create, close, edit, reorder — and only that is applied
//! onto the current set, so a tab another client created in the meantime
//! survives, and a tab another client closed stays closed.
//!
//! The desktop and the Mobile sidecar both run this against the same file,
//! serialised by the file's advisory lock, so no single owner *process* has to
//! be alive for a write to be safe — the versioned file is the authority.
//!
//! What stays a client's own: the pane tree, the focused tab and the open
//! session list (`tab_groups`, `active_tab_index`, `open_tab_sessions`). They
//! ride in the same file for now, written by the desktop as its layout; the
//! merge never reads them.
//!
//! Bookkeeping lives in the session's `extra` (`workspaceVersion`,
//! `workspaceClosed`) and each tab's (`id`, `createdVersion`), so a file
//! written by an older build reads as version 0 and is adopted on its first
//! sync — nothing about the on-disk shape changed for anyone else.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::schema::project::TabEntry;
use crate::schema::session::TerminalSession;
use crate::services::terminal_service;
use crate::storage;

/// What a whole-snapshot writer is told once a scope is versioned.
pub const OWNED_ERROR: &str =
    "this scope's tab set is held by the workspace service; save it through workspace_sync";

/// `TerminalSession.extra`: the scope's version, `0`/absent for a file no
/// revision-aware build has synced yet.
pub const VERSION_KEY: &str = "workspaceVersion";
/// `TerminalSession.extra`: `[{id, version}]` of the tabs closed most
/// recently, so a client that still carries one of them (it had not seen the
/// close) does not bring it back.
pub const CLOSED_KEY: &str = "workspaceClosed";
/// `TabEntry.extra`: the tab's stable identity across clients and restarts.
/// The persisted `key` is not one — every restore mints a fresh key.
pub const TAB_ID_KEY: &str = "id";
/// `TabEntry.extra`: the version the service first saw the tab at. A client
/// whose base is older never knew it, so its snapshot lacking the tab is not
/// a close.
pub const TAB_CREATED_KEY: &str = "createdVersion";
/// `TabEntry.extra`: the version the tab's fields last changed at. A client
/// whose base is older than it holds a stale copy of the tab, and its
/// snapshot does not overwrite what it never saw (a phone's rename lands
/// through the sidecar; the desktop's next sync keeps it).
pub const TAB_UPDATED_KEY: &str = "updatedVersion";
/// Tombstones kept per scope; the oldest fall off.
const MAX_TOMBSTONES: usize = 64;

/// The persisted tab fields the owner mints when a created tab lacks them:
/// the tmux session a PTY tab runs in (`TabEntry.tmuxSession`, the shape
/// `discovery::expected_tmux` checks) and an agent tab's schedule binding
/// (`scheduleTargetId`). Both are inert until a spawn reads them.
const TMUX_SESSION_KEY: &str = "tmuxSession";
const TMUX_ATTACH_KEY: &str = "tmuxAttach";
const SCHEDULE_TARGET_KEY: &str = "scheduleTargetId";
const KIND_KEY: &str = "kind";

/// The version a session carries (`0` = never synced).
pub fn version_of(session: &TerminalSession) -> u64 {
    session.extra.get(VERSION_KEY).and_then(Value::as_u64).unwrap_or(0)
}

/// Whether the workspace service holds this scope's tab set — from its first
/// sync on. A whole-snapshot save is refused from then on.
pub fn is_owned(session: &TerminalSession) -> bool {
    version_of(session) > 0
}

pub fn tab_id(tab: &TabEntry) -> Option<&str> {
    tab.extra.get(TAB_ID_KEY).and_then(Value::as_str).filter(|id| !id.is_empty())
}

fn created_version(tab: &TabEntry) -> u64 {
    tab.extra.get(TAB_CREATED_KEY).and_then(Value::as_u64).unwrap_or(0)
}

fn updated_version(tab: &TabEntry) -> u64 {
    tab.extra.get(TAB_UPDATED_KEY).and_then(Value::as_u64).unwrap_or(0)
}

fn extra_str<'a>(tab: &'a TabEntry, key: &str) -> Option<&'a str> {
    tab.extra.get(key).and_then(Value::as_str).filter(|s| !s.is_empty())
}

/// The tab's tmux session name, or the session it attaches to — how the
/// phone names a tab (`discovery::ResolvedTab::tmux_name`).
pub fn tmux_of(tab: &TabEntry) -> Option<&str> {
    extra_str(tab, TMUX_SESSION_KEY).or_else(|| extra_str(tab, TMUX_ATTACH_KEY))
}

/// Whether closing the tab may end its tmux session: only a session the tab
/// minted itself. An attach tab rides a session someone else started (the
/// Sessions view, possibly by hand), so its close must leave it running.
pub fn owns_tmux_session(tab: &TabEntry) -> bool {
    extra_str(tab, TMUX_ATTACH_KEY).is_none() && extra_str(tab, TMUX_SESSION_KEY).is_some()
}

fn kind_of(tab: &TabEntry) -> &str {
    extra_str(tab, KIND_KEY).unwrap_or("")
}

// ── Owner-side minting ──────────────────────────────────────────────────────

/// Mint the tmux session name of a scope's new PTY tab:
/// `<slug>-<scope>--<shell|agent>-<uuid>`. The same shape the desktop minted
/// client-side (`lib/terminal/tmuxSession.ts::newTmuxSessionName`) and the one
/// the sidecar's catalog checks (`discovery::expected_tmux`): the scope after
/// the tmux prefix (`<slug>-`), reduced like every state-dir key, then `--`, then the kind
/// token at the front of the uuid half, so a host shared by several projects
/// can tell one project's sessions from another's.
pub fn mint_tmux_session(scope: &str, kind: &str) -> String {
    let token = if kind == "shell" { "shell" } else { "agent" };
    format!("{}{}--{token}-{}", crate::brand::TMUX_PREFIX, storage::project_key(scope), crate::commands::projects::uuid_v4())
}

/// Give a freshly created tab what the owner mints for it: a tmux session
/// name for a PTY tab (shell, agent, local-model agent) that carries none and
/// attaches to none, and a schedule binding for an agent tab that has none.
/// A tab of another kind, or one that already carries them, is left alone.
fn mint_for_created(scope: &str, tab: &mut TabEntry) {
    let kind = kind_of(tab).to_string();
    let pty_tab = matches!(kind.as_str(), "shell" | "agent" | "local_agent");
    if !pty_tab {
        return;
    }
    if kind != "shell" && extra_str(tab, SCHEDULE_TARGET_KEY).is_none() {
        tab.extra.insert(SCHEDULE_TARGET_KEY.to_string(), Value::String(crate::commands::projects::uuid_v4()));
    }
    if tmux_of(tab).is_none() {
        tab.extra.insert(TMUX_SESSION_KEY.to_string(), Value::String(mint_tmux_session(scope, &kind)));
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct Tombstone {
    id: String,
    version: u64,
}

fn tombstones(session: &TerminalSession) -> Vec<Tombstone> {
    session
        .extra
        .get(CLOSED_KEY)
        .cloned()
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

fn set_tombstones(session: &mut TerminalSession, mut stones: Vec<Tombstone>) {
    if stones.len() > MAX_TOMBSTONES {
        stones.drain(..stones.len() - MAX_TOMBSTONES);
    }
    if stones.is_empty() {
        session.extra.remove(CLOSED_KEY);
    } else if let Ok(value) = serde_json::to_value(&stones) {
        session.extra.insert(CLOSED_KEY.to_string(), value);
    }
}

fn set_version(session: &mut TerminalSession, version: u64) {
    session.extra.insert(VERSION_KEY.to_string(), Value::from(version));
}

/// Give every tab without one a stable id, and an unversioned session version
/// 1. Returns whether anything changed. Pure; the caller writes.
pub fn adopt(session: &mut TerminalSession) -> bool {
    let mut changed = false;
    let version = version_of(session).max(1);
    let mut ids: HashSet<String> = session.tab_layout.iter().filter_map(tab_id).map(str::to_string).collect();
    for tab in session.tab_layout.iter_mut() {
        if tab_id(tab).is_none() {
            let id = fresh_id(&ids);
            ids.insert(id.clone());
            tab.extra.insert(TAB_ID_KEY.to_string(), Value::String(id));
            changed = true;
        }
        if !tab.extra.contains_key(TAB_CREATED_KEY) {
            tab.extra.insert(TAB_CREATED_KEY.to_string(), Value::from(version));
            changed = true;
        }
    }
    if version_of(session) == 0 {
        set_version(session, 1);
        changed = true;
    }
    changed
}

fn fresh_id(taken: &HashSet<String>) -> String {
    let mut id = crate::commands::projects::uuid_v4();
    while taken.contains(&id) {
        id = crate::commands::projects::uuid_v4();
    }
    id
}

// ── The protocol ────────────────────────────────────────────────────────────

/// A client's view of a scope: what it sends to sync, the tab set it holds at
/// `base_version` plus its own layout. Tauri payloads use the frontend's
/// camelCase keys.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientSync {
    /// The version the client last received (a snapshot or a sync answer);
    /// `0` for a client that never did.
    #[serde(default)]
    pub base_version: u64,
    pub tabs: Vec<TabEntry>,
    /// The client's pane tree; `None` leaves the stored one alone.
    #[serde(default)]
    pub groups: Option<Value>,
    /// The open agent-session list; `Some([])` clears it, `None` keeps it.
    #[serde(default)]
    pub sessions: Option<Value>,
    #[serde(default)]
    pub active_tab_index: Option<usize>,
    /// What lets an **empty** `tabs` close every tab the client knew, rather
    /// than reading as a client that had nothing loaded (see
    /// `terminal_service::write_terminal_session`).
    #[serde(default)]
    pub allow_clear: bool,
}

/// One change the merge applied, for the `workspace:patch` event.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Op {
    Created { id: String },
    Closed { id: String },
    Updated { id: String },
    Reordered,
}

/// What a sync answers: the version now on disk and the tab set as stored,
/// each tab carrying its `id` (the client learns the ids of the tabs it
/// created) under the `key` the client sent.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncOutcome {
    pub version: u64,
    pub tabs: Vec<TabEntry>,
    pub ops: Vec<Op>,
    /// The client's base was behind: something else wrote in between, and
    /// its change was merged rather than applied verbatim.
    pub stale: bool,
}

/// A scope's state as a client receives it on connect.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub version: u64,
    #[serde(flatten)]
    pub session: TerminalSession,
}

/// The tab minus the service's own bookkeeping — what "changed" compares.
fn comparable(tab: &TabEntry) -> Value {
    let mut value = serde_json::to_value(tab).unwrap_or(Value::Null);
    if let Some(obj) = value.as_object_mut() {
        obj.remove(TAB_CREATED_KEY);
        obj.remove(TAB_UPDATED_KEY);
    }
    value
}

/// Merge a client's snapshot onto `session` (already adopted), in memory.
///
/// - A client tab whose id the set holds is **kept** with the client's
///   fields — unless the held copy changed after the client's base
///   (`updatedVersion > base`): then the client's copy is older knowledge,
///   not an edit, and the held one stands.
/// - A client tab with no id, or an id the set never held, is **created** —
///   unless the id was closed after the client's base, in which case the
///   close stands. A created PTY tab lacking a tmux name is given one here
///   (`mint_for_created`).
/// - A held tab missing from the snapshot is **closed** if the client knew it
///   (`createdVersion <= base`) and **kept** if it was created after the
///   client's base, in its place next to the neighbour it had.
/// - The client's order applies to the tabs it knows.
///
/// An empty snapshot without `allow_clear` is a client with nothing loaded:
/// nothing changes.
fn merge(scope: &str, session: &TerminalSession, client: &ClientSync) -> (Vec<TabEntry>, Vec<Op>, Vec<Tombstone>) {
    let version = version_of(session);
    let next_version = version + 1;
    let base = client.base_version;
    let current = &session.tab_layout;
    let mut stones = tombstones(session);
    if client.tabs.is_empty() && !client.allow_clear {
        return (current.clone(), Vec::new(), stones);
    }
    let current_by_id: HashMap<&str, &TabEntry> = current.iter().filter_map(|t| tab_id(t).map(|id| (id, t))).collect();
    let closed_after_base: HashSet<String> =
        stones.iter().filter(|s| s.version > base).map(|s| s.id.clone()).collect();
    let mut taken: HashSet<String> = current_by_id.keys().map(|id| id.to_string()).collect();
    for stone in &stones {
        taken.insert(stone.id.clone());
    }

    let mut result: Vec<TabEntry> = Vec::with_capacity(client.tabs.len());
    let mut ops: Vec<Op> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for tab in &client.tabs {
        let mut next = tab.clone();
        match tab_id(tab).map(str::to_string) {
            Some(id) if current_by_id.contains_key(id.as_str()) => {
                if !seen.insert(id.clone()) {
                    continue; // the client listed one tab twice
                }
                let held = current_by_id[id.as_str()];
                next.extra.insert(TAB_CREATED_KEY.to_string(), Value::from(created_version(held)));
                next.extra.insert(TAB_UPDATED_KEY.to_string(), Value::from(updated_version(held)));
                if comparable(&next) != comparable(held) {
                    if updated_version(held) > base {
                        // Changed by someone after this client last looked: the
                        // client's copy is older knowledge, not an edit.
                        result.push(held.clone());
                        continue;
                    }
                    next.extra.insert(TAB_UPDATED_KEY.to_string(), Value::from(next_version));
                    ops.push(Op::Updated { id });
                }
                result.push(next);
            }
            Some(id) if closed_after_base.contains(id.as_str()) => {
                // Closed elsewhere after this client last looked: the close wins.
                continue;
            }
            Some(id) => {
                if !seen.insert(id.clone()) {
                    continue;
                }
                // A client-minted id, or a tab this client re-opened: a create.
                taken.insert(id.clone());
                next.extra.insert(TAB_CREATED_KEY.to_string(), Value::from(next_version));
                next.extra.insert(TAB_UPDATED_KEY.to_string(), Value::from(next_version));
                mint_for_created(scope, &mut next);
                stones.retain(|s| s.id != id);
                ops.push(Op::Created { id });
                result.push(next);
            }
            None => {
                let id = fresh_id(&taken);
                taken.insert(id.clone());
                seen.insert(id.clone());
                next.extra.insert(TAB_ID_KEY.to_string(), Value::String(id.clone()));
                next.extra.insert(TAB_CREATED_KEY.to_string(), Value::from(next_version));
                next.extra.insert(TAB_UPDATED_KEY.to_string(), Value::from(next_version));
                mint_for_created(scope, &mut next);
                ops.push(Op::Created { id });
                result.push(next);
            }
        }
    }

    // Held tabs the client did not send: closed by it, or unknown to it.
    let mut inserted_after: Option<usize> = None;
    for (index, held) in current.iter().enumerate() {
        let Some(id) = tab_id(held) else { continue };
        if seen.contains(id) {
            continue;
        }
        if created_version(held) <= base {
            ops.push(Op::Closed { id: id.to_string() });
            stones.push(Tombstone { id: id.to_string(), version: next_version });
            continue;
        }
        // Created after the client's base: keep it where it was, after the
        // nearest earlier neighbour the result still holds.
        let neighbour = current[..index]
            .iter()
            .rev()
            .filter_map(tab_id)
            .find_map(|prev| result.iter().position(|t| tab_id(t) == Some(prev)));
        let at = match (neighbour, inserted_after) {
            (Some(n), _) => n + 1,
            (None, Some(last)) => last + 1,
            (None, None) => 0,
        };
        result.insert(at, held.clone());
        inserted_after = Some(at);
    }

    // Reordered: the tabs both sides hold, in a different order.
    let before: Vec<&str> = current.iter().filter_map(tab_id).filter(|id| seen.contains(*id)).collect();
    let after: Vec<&str> = result.iter().filter_map(tab_id).filter(|id| seen.contains(*id)).collect();
    if before != after {
        ops.push(Op::Reordered);
    }
    (result, ops, stones)
}

// ── File-level entry points ─────────────────────────────────────────────────

fn read_session(path: &Path) -> Result<TerminalSession, String> {
    if !path.exists() {
        return Ok(TerminalSession::default());
    }
    storage::read_json(path).map_err(|e| format!("read {}: {e}", path.display()))
}

fn write_session(path: &Path, session: &TerminalSession) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create session dir: {e}"))?;
    }
    storage::write_json_atomic(path, session).map_err(|e| e.to_string())
}

/// Read a scope's state for a client. A file with tabs that predates the
/// service is adopted (ids, version 1) and written back; an absent or empty
/// one stays version 0, so a scope nobody ever opened grows no file.
pub fn snapshot_in(path: &Path) -> Result<Snapshot, String> {
    let _lock = storage::FileLock::exclusive(path).map_err(|e| format!("lock {}: {e}", path.display()))?;
    let mut session = read_session(path)?;
    if !session.tab_layout.is_empty() && adopt(&mut session) {
        write_session(path, &session)?;
    }
    Ok(Snapshot { version: version_of(&session), session })
}

/// Apply a client's snapshot onto the file: read, adopt, merge, write — all
/// under the file's lock, so a second process cannot interleave. Nothing is
/// written when nothing changed. `scope` is the scope id the file belongs to
/// (a project id, `box:<id>`, or `root`): what a minted tmux name carries.
pub fn sync_in(path: &Path, scope: &str, client: ClientSync) -> Result<SyncOutcome, String> {
    let _lock = storage::FileLock::exclusive(path).map_err(|e| format!("lock {}: {e}", path.display()))?;
    let mut session = read_session(path)?;
    let adopted = adopt(&mut session);
    let version = version_of(&session);
    let stale = client.base_version < version && client.base_version > 0;
    let (tabs, ops, stones) = merge(scope, &session, &client);

    let mut next_groups = session.tab_groups.clone();
    if tabs.is_empty() {
        next_groups = None;
    } else if client.groups.is_some() {
        next_groups = client.groups.clone();
    }
    let next_sessions = match &client.sessions {
        Some(s) if s.as_array().is_some_and(|a| a.is_empty()) => None,
        Some(s) => Some(s.clone()),
        None => session.open_tab_sessions.clone(),
    };
    let next_active = client.active_tab_index.unwrap_or(session.active_tab_index);
    let layout_changed = next_groups != session.tab_groups
        || next_sessions != session.open_tab_sessions
        || next_active != session.active_tab_index;

    if ops.is_empty() && !layout_changed && !adopted {
        return Ok(SyncOutcome { version, tabs: session.tab_layout, ops, stale });
    }
    session.tab_layout = tabs;
    session.tab_groups = next_groups;
    session.open_tab_sessions = next_sessions;
    session.active_tab_index = next_active;
    set_tombstones(&mut session, stones);
    // A layout-only change moves the version too: the version names the file,
    // not just the tab set, so a client can tell any write from none.
    set_version(&mut session, version + 1);
    write_session(path, &session)?;
    Ok(SyncOutcome { version: version + 1, tabs: session.tab_layout, ops, stale })
}

/// A backend-side edit of the whole session (a path rewrite, an adoption from
/// a project folder, a tab the sidecar creates): applied under the lock, ids
/// and tmux names assigned to new tabs, the version bumped, every tab the edit
/// changed stamped `updatedVersion` (so a client holding the old copy merges
/// rather than overwrites), tabs that vanished tombstoned. Returns what was
/// stored.
pub fn edit_in(
    path: &Path,
    scope: &str,
    edit: impl FnOnce(&mut TerminalSession) -> Result<(), String>,
) -> Result<TerminalSession, String> {
    let _lock = storage::FileLock::exclusive(path).map_err(|e| format!("lock {}: {e}", path.display()))?;
    let mut session = read_session(path)?;
    adopt(&mut session);
    let version = version_of(&session);
    let before: HashMap<String, Value> = session
        .tab_layout
        .iter()
        .filter_map(|t| tab_id(t).map(|id| (id.to_string(), comparable(t))))
        .collect();
    edit(&mut session)?;
    let mut ids: HashSet<String> = session.tab_layout.iter().filter_map(tab_id).map(str::to_string).collect();
    for tab in session.tab_layout.iter_mut() {
        match tab_id(tab).map(str::to_string) {
            None => {
                let id = fresh_id(&ids);
                ids.insert(id.clone());
                tab.extra.insert(TAB_ID_KEY.to_string(), Value::String(id));
                tab.extra.insert(TAB_CREATED_KEY.to_string(), Value::from(version + 1));
                tab.extra.insert(TAB_UPDATED_KEY.to_string(), Value::from(version + 1));
                mint_for_created(scope, tab);
            }
            Some(id) => {
                if !tab.extra.contains_key(TAB_CREATED_KEY) {
                    tab.extra.insert(TAB_CREATED_KEY.to_string(), Value::from(version + 1));
                }
                // A field the edit changed: stamped, so a client holding the
                // old copy does not write it back.
                if before.get(&id).is_none_or(|was| *was != comparable(tab)) {
                    tab.extra.insert(TAB_UPDATED_KEY.to_string(), Value::from(version + 1));
                }
            }
        }
    }
    let mut stones = tombstones(&session);
    for id in before.keys().filter(|id| !ids.contains(*id)) {
        stones.push(Tombstone { id: id.clone(), version: version + 1 });
    }
    set_tombstones(&mut session, stones);
    set_version(&mut session, version + 1);
    write_session(path, &session)?;
    Ok(session)
}

/// What the sidecar's headless create answers with: the tab as stored, with
/// its owner-minted `id` and tmux name, and whether it was already there — a
/// repeat of the same request (`mobileRequestHash`) opens nothing twice.
#[derive(Debug, Clone)]
pub struct CreatedTab {
    pub tab: TabEntry,
    pub existed: bool,
}

/// Append `tab` to the scope's set (owner-side create, headless owner plan
/// H1b): the tab gets its id, its tmux name and — for an agent — its schedule
/// binding from the owner, and the version moves so a window that opens
/// later merges it in rather than overwriting it. When a tab already carries
/// `request_hash` under `mobileRequestHash`, that tab is answered instead and
/// nothing is written: the phone retries a create until it sees the tab.
pub fn create_tab_in(path: &Path, scope: &str, tab: TabEntry, request_hash: Option<&str>) -> Result<CreatedTab, String> {
    // The closure runs under the lock, so the check and the append are one
    // step; a hit aborts the edit (nothing written) and is answered below.
    const EXISTS: &str = "\u{0}exists";
    let mut found: Option<TabEntry> = None;
    let stored = edit_in(path, scope, |session| {
        if let Some(hash) = request_hash {
            if let Some(existing) = session.tab_layout.iter().find(|t| extra_str(t, "mobileRequestHash") == Some(hash)) {
                found = Some(existing.clone());
                return Err(EXISTS.to_string());
            }
        }
        session.tab_layout.push(tab);
        Ok(())
    });
    match (stored, found) {
        (Err(e), Some(tab)) if e == EXISTS => Ok(CreatedTab { tab, existed: true }),
        (Err(e), _) => Err(e),
        (Ok(stored), _) => {
            let tab = stored.tab_layout.last().cloned().ok_or_else(|| "create: tab not stored".to_string())?;
            Ok(CreatedTab { tab, existed: false })
        }
    }
}

// ── The phone's tab operations (headless owner plan, H3) ────────────────────
//
// What the sidecar applies to the file when no window is open to apply it
// to a store: named by tmux session, as every mobile tab request is. Each is
// one [`edit_in`], so the version moves and a client holding the old copy
// merges rather than overwrites (`updatedVersion`).

/// What a tab operation is told when the tab is not in the set.
pub const TAB_NOT_FOUND: &str = "tab_not_found";
/// `TerminalSession.extra`: the agent tabs closed with no window open, newest
/// first, for the phone's "Recently closed" row and a headless reopen
/// (`[{ id, closedAt, tab }]`, at most [`MAX_CLOSED_TABS`]). The window keeps
/// its own closed list in memory; this is the owner's.
pub const CLOSED_TABS_KEY: &str = "workspaceClosedTabs";
/// Closed agent tabs kept per scope — the window keeps ten too.
const MAX_CLOSED_TABS: usize = 10;

/// One closed agent tab as the owner remembers it for a reopen: an opaque id
/// minted at close (never the session id), when it closed (ms since the
/// epoch), and the record itself.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClosedTab {
    pub id: String,
    pub closed_at: u64,
    pub tab: TabEntry,
}

/// The scope's owner-closed agent tabs, newest first.
pub fn closed_tabs(session: &TerminalSession) -> Vec<ClosedTab> {
    session
        .extra
        .get(CLOSED_TABS_KEY)
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default()
}

fn set_closed_tabs(session: &mut TerminalSession, closed: Vec<ClosedTab>) {
    if closed.is_empty() {
        session.extra.remove(CLOSED_TABS_KEY);
    } else {
        session.extra.insert(CLOSED_TABS_KEY.to_string(), serde_json::to_value(closed).unwrap_or(Value::Null));
    }
}

/// The opaque id a closed tab is reopened by: 32 hex characters, never the
/// session id (the phone echoes it back, bounded by the host's id check).
fn closed_id() -> String {
    let mut bytes = [0u8; 16];
    let _ = getrandom::fill(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn edit_tab_in(
    path: &Path,
    scope: &str,
    tmux: &str,
    edit: impl FnOnce(&mut TerminalSession, usize) -> Result<(), String>,
) -> Result<TerminalSession, String> {
    edit_in(path, scope, |session| {
        let index = session
            .tab_layout
            .iter()
            .position(|t| tmux_of(t) == Some(tmux))
            .ok_or_else(|| TAB_NOT_FOUND.to_string())?;
        edit(session, index)
    })
}

/// Rename the tab behind `tmux`. `label` is already cleaned by the caller.
pub fn rename_tab_in(path: &Path, scope: &str, tmux: &str, label: &str) -> Result<TerminalSession, String> {
    edit_tab_in(path, scope, tmux, |session, i| {
        session.tab_layout[i].label = label.to_string();
        Ok(())
    })
}

/// Colour the tab behind `tmux` with a palette id, or clear it with `None`.
pub fn color_tab_in(path: &Path, scope: &str, tmux: &str, color: Option<&str>) -> Result<TerminalSession, String> {
    edit_tab_in(path, scope, tmux, |session, i| {
        match color {
            Some(color) => {
                session.tab_layout[i].extra.insert("color".to_string(), Value::String(color.to_string()));
            }
            None => {
                session.tab_layout[i].extra.remove("color");
            }
        }
        Ok(())
    })
}

/// The `tabKeys` of every pane (group node) of a saved pane tree
/// (`tab_groups`), left to right.
fn pane_keys_mut<'a>(node: &'a mut Value, out: &mut Vec<&'a mut Vec<Value>>) {
    let Some(obj) = node.as_object_mut() else { return };
    if obj.get("type").and_then(Value::as_str) == Some("group") {
        if let Some(Value::Array(keys)) = obj.get_mut("tabKeys") {
            out.push(keys);
        }
        return;
    }
    if let Some(Value::Array(children)) = obj.get_mut("children") {
        for child in children {
            pane_keys_mut(child, out);
        }
    }
}

/// Move the tab behind `tmux` next to the one behind `anchor`, before or
/// after it. A refused move (no anchor) changes nothing.
///
/// The shared order is the saved pane tree's, left to right (a window saves
/// its tabs in that order and restores from the tree), so the tree moves
/// with it: a window that restores later, or that takes this move into its
/// panes (`followSharedOrder`), shows it rather than sending its own older
/// order back. A tab the tree does not place is placed first where a restore
/// puts it — the end of the first pane, in set order. A move between two
/// panes has no slot to land in, as in the window's own reorder, and leaves
/// everything as it is.
pub fn reorder_tab_in(path: &Path, scope: &str, tmux: &str, anchor: &str, after: bool) -> Result<TerminalSession, String> {
    const NO_SLOT: &str = "\u{0}no-slot";
    let place = |keys: &mut Vec<Value>, key: &str, anchor_key: &str| {
        let Some(from) = keys.iter().position(|k| k.as_str() == Some(key)) else { return };
        let moved = keys.remove(from);
        if let Some(at) = keys.iter().position(|k| k.as_str() == Some(anchor_key)) {
            keys.insert(if after { at + 1 } else { at }, moved);
        }
    };
    let edited = edit_tab_in(path, scope, tmux, |session, i| {
        let key = session.tab_layout[i].key.clone();
        let anchor_key = session
            .tab_layout
            .iter()
            .enumerate()
            .find(|(j, t)| *j != i && tmux_of(t) == Some(anchor))
            .map(|(_, t)| t.key.clone())
            .ok_or_else(|| TAB_NOT_FOUND.to_string())?;
        if let Some(tree) = session.tab_groups.as_mut() {
            let mut panes = Vec::new();
            pane_keys_mut(tree, &mut panes);
            if !panes.is_empty() {
                let mut placed: HashSet<String> = panes.iter().flat_map(|p| p.iter().filter_map(Value::as_str).map(str::to_string)).collect();
                for tab in &session.tab_layout {
                    if placed.insert(tab.key.clone()) {
                        panes[0].push(Value::String(tab.key.clone()));
                    }
                }
                let pane_of = |k: &str| panes.iter().position(|p| p.iter().any(|v| v.as_str() == Some(k)));
                let (from, to) = (pane_of(&key), pane_of(&anchor_key));
                if from != to {
                    return Err(NO_SLOT.to_string());
                }
                if let Some(pane) = from {
                    place(panes[pane], &key, &anchor_key);
                }
            }
        }
        let tab = session.tab_layout.remove(i);
        let at = session
            .tab_layout
            .iter()
            .position(|t| tmux_of(t) == Some(anchor))
            .ok_or_else(|| TAB_NOT_FOUND.to_string())?;
        session.tab_layout.insert(if after { at + 1 } else { at }, tab);
        Ok(())
    });
    match edited {
        Err(e) if e == NO_SLOT => read_session(path),
        other => other,
    }
}

/// Take the tab behind `tmux` out of the set and hand it back, so the caller
/// can end the session behind it (the desktop's own × ends a local session
/// the tab minted). An agent tab joins the scope's closed list, under a fresh
/// opaque id, for a reopen. `now_ms` is the close stamp.
pub fn close_tab_in(path: &Path, scope: &str, tmux: &str, now_ms: u64) -> Result<TabEntry, String> {
    let mut removed: Option<TabEntry> = None;
    edit_tab_in(path, scope, tmux, |session, i| {
        let tab = session.tab_layout.remove(i);
        if matches!(kind_of(&tab), "agent" | "local_agent") {
            let mut closed = closed_tabs(session);
            closed.insert(0, ClosedTab { id: closed_id(), closed_at: now_ms, tab: tab.clone() });
            closed.truncate(MAX_CLOSED_TABS);
            set_closed_tabs(session, closed);
        }
        removed = Some(tab);
        Ok(())
    })?;
    removed.ok_or_else(|| TAB_NOT_FOUND.to_string())
}

/// Put a closed agent tab back — the newest, or the one `closed_id` names —
/// at the end of the set, as a **new** tab: a fresh id (the old one is
/// tombstoned, and a window whose base predates the close would otherwise
/// read its own stale snapshot as closing it again) and a fresh tmux name
/// (the close ended the old session). `Ok(None)` when there is nothing to
/// reopen. The record keeps its `sessionId`, so the launch resumes the
/// conversation.
pub fn reopen_tab_in(path: &Path, scope: &str, closed_id: Option<&str>) -> Result<Option<TabEntry>, String> {
    const NOTHING: &str = "\u{0}nothing";
    let stored = edit_in(path, scope, |session| {
        let mut closed = closed_tabs(session);
        let index = match closed_id {
            Some(id) => closed.iter().position(|c| c.id == id),
            None => (!closed.is_empty()).then_some(0),
        };
        let Some(index) = index else {
            return Err(NOTHING.to_string());
        };
        let mut tab = closed.remove(index).tab;
        set_closed_tabs(session, closed);
        for key in [TAB_ID_KEY, TAB_CREATED_KEY, TAB_UPDATED_KEY, TMUX_SESSION_KEY, "mobileRequestHash", "launchedAt"] {
            tab.extra.remove(key);
        }
        tab.key = format!("headless-{}", crate::commands::projects::uuid_v4());
        session.tab_layout.push(tab);
        Ok(())
    });
    match stored {
        Err(e) if e == NOTHING => Ok(None),
        Err(e) => Err(e),
        Ok(stored) => Ok(stored.tab_layout.last().cloned()),
    }
}

/// Bump the version of a session held as raw JSON (the path rewrite keeps
/// fields this build does not model). A no-op for an unversioned file.
pub fn bump_raw_version(session: &mut Value) {
    if let Some(version) = session.get(VERSION_KEY).and_then(Value::as_u64) {
        session[VERSION_KEY] = Value::from(version + 1);
    }
}

// ── Project-keyed wrappers ──────────────────────────────────────────────────

/// [`snapshot_in`] for a project scope, sanitized like every load.
pub fn snapshot(project_id: &str) -> Result<Snapshot, String> {
    let mut snapshot = snapshot_in(&terminal_service::state_session_path(project_id))?;
    terminal_service::sanitize_loaded_layout(&mut snapshot.session.tab_layout);
    Ok(snapshot)
}

/// [`sync_in`] for a project scope, then the state-dir write's companions:
/// stale host-bound markers pruned and the project-tree export copy refreshed
/// (`terminal_service::store_state_session`).
pub fn sync(project_id: &str, local_file: &str, client: ClientSync) -> Result<SyncOutcome, String> {
    let path = terminal_service::state_session_path(project_id);
    let outcome = sync_in(&path, project_id, client)?;
    if !outcome.ops.is_empty() {
        terminal_service::after_state_session_write(project_id, local_file);
    }
    Ok(outcome)
}

/// [`edit_in`] for a project scope, with the same companions as [`sync`].
pub fn edit(
    project_id: &str,
    local_file: &str,
    edit: impl FnOnce(&mut TerminalSession) -> Result<(), String>,
) -> Result<TerminalSession, String> {
    let session = edit_in(&terminal_service::state_session_path(project_id), project_id, edit)?;
    terminal_service::after_state_session_write(project_id, local_file);
    Ok(session)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tab(key: &str, label: &str) -> TabEntry {
        let mut extra = HashMap::new();
        extra.insert("kind".to_string(), Value::String("shell".to_string()));
        TabEntry {
            key: key.to_string(),
            label: label.to_string(),
            cmd: String::new(),
            cwd: "/tmp".to_string(),
            session_id: None,
            extra,
        }
    }

    fn ids(tabs: &[TabEntry]) -> Vec<&str> {
        tabs.iter().filter_map(tab_id).collect()
    }

    fn labels(tabs: &[TabEntry]) -> Vec<&str> {
        tabs.iter().map(|t| t.label.as_str()).collect()
    }

    fn client(base: u64, tabs: Vec<TabEntry>) -> ClientSync {
        ClientSync { base_version: base, tabs, allow_clear: true, ..Default::default() }
    }

    fn file() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sessions").join("p").join("terminals.json");
        (dir, path)
    }

    #[test]
    fn a_legacy_file_is_adopted_once_with_ids_and_version_one() {
        let (_dir, path) = file();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            r#"{"tabLayout":[{"key":"k1","label":"A","cmd":"","cwd":"/tmp","kind":"shell"},{"key":"k2","label":"B","cmd":"","cwd":"/tmp"}],"activeTabIndex":1,"tabGroups":{"type":"group","tabKeys":["k1","k2"],"activeKey":"k2"},"openApps":[]}"#,
        )
        .unwrap();
        let snap = snapshot_in(&path).unwrap();
        assert_eq!(snap.version, 1);
        assert_eq!(snap.session.tab_layout.len(), 2);
        assert!(snap.session.tab_layout.iter().all(|t| tab_id(t).is_some()));
        assert_eq!(snap.session.active_tab_index, 1, "the client's layout survived");
        assert!(snap.session.tab_groups.is_some());
        let again = snapshot_in(&path).unwrap();
        assert_eq!(ids(&again.session.tab_layout), ids(&snap.session.tab_layout), "ids are stable");
        assert_eq!(again.version, 1);
        // An absent file is version 0 and grows no file.
        let (_dir, empty) = file();
        assert_eq!(snapshot_in(&empty).unwrap().version, 0);
        assert!(!empty.exists());
    }

    #[test]
    fn a_first_sync_creates_the_tabs_and_hands_back_their_ids() {
        let (_dir, path) = file();
        let out = sync_in(&path, "p", client(0, vec![tab("k1", "A"), tab("k2", "B")])).unwrap();
        assert_eq!(out.version, 2, "adopted (1) then written (2)");
        assert!(!out.stale);
        assert_eq!(out.tabs.iter().map(|t| t.key.as_str()).collect::<Vec<_>>(), ["k1", "k2"]);
        assert!(out.tabs.iter().all(|t| tab_id(t).is_some()));
        assert_eq!(out.ops.iter().filter(|op| matches!(op, Op::Created { .. })).count(), 2);
        // Nothing changed: nothing written, same version.
        let same = sync_in(&path, "p", client(out.version, out.tabs.clone())).unwrap();
        assert_eq!(same.version, out.version);
        assert!(same.ops.is_empty());
    }

    /// The plan's owner test: two clients rename, reorder and close tabs
    /// concurrently, and the final set is the owner's, with no tab lost.
    #[test]
    fn two_clients_edit_the_same_scope_and_neither_loses_the_others_tabs() {
        let (_dir, path) = file();
        let seeded = sync_in(&path, "p", client(0, vec![tab("a", "A"), tab("b", "B"), tab("c", "C")])).unwrap();
        let base = seeded.version;
        let [a, b, c] = [&seeded.tabs[0], &seeded.tabs[1], &seeded.tabs[2]].map(|t| t.clone());

        // Client 1 (the desktop) renames A, closes B, opens D.
        let mut a1 = a.clone();
        a1.label = "A renamed".into();
        let one = sync_in(&path, "p", client(base, vec![a1.clone(), c.clone(), tab("d", "D")])).unwrap();
        assert_eq!(labels(&one.tabs), ["A renamed", "C", "D"]);
        assert!(one.ops.contains(&Op::Closed { id: tab_id(&b).unwrap().to_string() }));

        // Client 2 (a phone through the sidecar) still holds the seeded set:
        // it reorders C before A, colours C, and opens E — never having seen
        // client 1's changes.
        let mut c2 = c.clone();
        c2.extra.insert("color".into(), Value::String("blue".into()));
        let two = sync_in(&path, "p", client(base, vec![c2, a.clone(), b.clone(), tab("e", "E")])).unwrap();
        assert!(two.stale, "its base was behind");
        let final_labels = labels(&two.tabs);
        assert!(!final_labels.contains(&"B"), "B stays closed: {final_labels:?}");
        assert!(final_labels.contains(&"D"), "D, created by client 1, survives: {final_labels:?}");
        assert!(final_labels.contains(&"E"), "E, created by client 2, lands: {final_labels:?}");
        assert!(
            final_labels.iter().position(|l| *l == "C") < final_labels.iter().position(|l| l.starts_with('A')),
            "client 2's order applies to the tabs it knew: {final_labels:?}"
        );
        let c_now = two.tabs.iter().find(|t| t.label == "C").unwrap();
        assert_eq!(c_now.extra["color"], "blue");
        // Client 2 sent A's old label, but client 1 renamed A after client 2's
        // base: that copy is older knowledge, and the rename stands.
        assert!(final_labels.contains(&"A renamed"), "{final_labels:?}");
        assert_eq!(two.tabs.len(), 4);

        // Both clients converge on the stored set from here.
        let three = sync_in(&path, "p", client(two.version, two.tabs.clone())).unwrap();
        assert!(three.ops.is_empty());
        assert_eq!(three.version, two.version);
    }

    #[test]
    fn a_tab_created_after_the_clients_base_keeps_its_place() {
        let (_dir, path) = file();
        let seeded = sync_in(&path, "p", client(0, vec![tab("a", "A"), tab("b", "B")])).unwrap();
        let base = seeded.version;
        // Someone else inserts X between A and B.
        let mut with_x = seeded.tabs.clone();
        with_x.insert(1, tab("x", "X"));
        sync_in(&path, "p", client(base, with_x)).unwrap();
        // The first client, unaware of X, only renames B.
        let mut renamed = seeded.tabs.clone();
        renamed[1].label = "B2".into();
        let out = sync_in(&path, "p", client(base, renamed)).unwrap();
        assert_eq!(labels(&out.tabs), ["A", "X", "B2"]);
        assert!(out.ops.contains(&Op::Updated { id: tab_id(&seeded.tabs[1]).unwrap().to_string() }));
        assert!(!out.ops.iter().any(|op| matches!(op, Op::Closed { .. })));
    }

    #[test]
    fn an_empty_snapshot_only_clears_when_the_client_vouches_for_it() {
        let (_dir, path) = file();
        let seeded = sync_in(&path, "p", client(0, vec![tab("a", "A")])).unwrap();
        let nothing_loaded = ClientSync { base_version: seeded.version, tabs: vec![], allow_clear: false, ..Default::default() };
        let out = sync_in(&path, "p", nothing_loaded).unwrap();
        assert_eq!(labels(&out.tabs), ["A"]);
        assert_eq!(out.version, seeded.version);
        let out = sync_in(&path, "p", client(seeded.version, vec![])).unwrap();
        assert!(out.tabs.is_empty());
        assert_eq!(out.ops, vec![Op::Closed { id: tab_id(&seeded.tabs[0]).unwrap().to_string() }]);
        let stored = read_session(&path).unwrap();
        assert!(stored.tab_groups.is_none(), "an empty set drops the tree");
        assert_eq!(tombstones(&stored).len(), 1);
    }

    #[test]
    fn a_close_by_another_client_is_not_undone_by_a_stale_snapshot() {
        let (_dir, path) = file();
        let seeded = sync_in(&path, "p", client(0, vec![tab("a", "A"), tab("b", "B")])).unwrap();
        let base = seeded.version;
        sync_in(&path, "p", client(base, vec![seeded.tabs[0].clone()])).unwrap(); // closes B
        // A stale client that still lists B does not bring it back...
        let out = sync_in(&path, "p", client(base, seeded.tabs.clone())).unwrap();
        assert_eq!(labels(&out.tabs), ["A"]);
        // ...but a client that saw the close may deliberately re-open it.
        let out = sync_in(&path, "p", client(out.version, seeded.tabs.clone())).unwrap();
        assert_eq!(labels(&out.tabs), ["A", "B"]);
        assert!(out.ops.iter().any(|op| matches!(op, Op::Created { .. })));
    }

    #[test]
    fn the_whole_snapshot_save_is_refused_once_the_scope_is_owned() {
        let (_dir, path) = file();
        assert!(!is_owned(&read_session(&path).unwrap()));
        sync_in(&path, "p", client(0, vec![tab("a", "A")])).unwrap();
        let stored = read_session(&path).unwrap();
        assert!(is_owned(&stored));
        assert_eq!(version_of(&stored), 2);
    }

    #[test]
    fn a_backend_edit_bumps_the_version_and_tombstones_what_it_dropped() {
        let (_dir, path) = file();
        let seeded = sync_in(&path, "p", client(0, vec![tab("a", "A"), tab("b", "B")])).unwrap();
        let stored = edit_in(&path, "p", |session| {
            session.tab_layout.retain(|t| t.label != "B");
            session.tab_layout.push(tab("n", "New"));
            Ok(())
        })
        .unwrap();
        assert_eq!(version_of(&stored), seeded.version + 1);
        assert_eq!(labels(&stored.tab_layout), ["A", "New"]);
        assert!(stored.tab_layout.iter().all(|t| tab_id(t).is_some()));
        assert_eq!(tombstones(&stored)[0].id, tab_id(&seeded.tabs[1]).unwrap());
        let mut raw = serde_json::to_value(&stored).unwrap();
        bump_raw_version(&mut raw);
        assert_eq!(raw[VERSION_KEY], seeded.version + 2);
    }

    fn pty_tab(key: &str, label: &str, tmux: &str) -> TabEntry {
        let mut t = tab(key, label);
        t.extra.insert("tmuxSession".to_string(), Value::String(tmux.to_string()));
        t
    }

    /// H1b: an edit written by another writer (the sidecar, with no window
    /// open) while a window holds an older copy survives that window's next
    /// sync — the window's copy is older knowledge, not an edit — and the
    /// window's own later edit wins.
    #[test]
    fn a_change_written_after_the_clients_base_is_kept_over_its_stale_copy() {
        let (_dir, path) = file();
        let seeded = sync_in(&path, "p", client(0, vec![pty_tab("a", "A", concat!(crate::app_slug!(), "-p--shell-1")), pty_tab("b", "B", concat!(crate::app_slug!(), "-p--agent-2"))])).unwrap();
        let base = seeded.version;
        // The other writer renames and colours A and closes B.
        edit_in(&path, "p", |session| {
            let a = session.tab_layout.iter_mut().find(|t| tmux_of(t) == Some(concat!(crate::app_slug!(), "-p--shell-1"))).unwrap();
            a.label = "From the phone".into();
            a.extra.insert("color".into(), Value::String("teal".into()));
            session.tab_layout.retain(|t| tmux_of(t) != Some(concat!(crate::app_slug!(), "-p--agent-2")));
            Ok(())
        })
        .unwrap();
        // The window's debounced save still carries the seeded copies.
        let out = sync_in(&path, "p", client(base, seeded.tabs.clone())).unwrap();
        assert!(out.stale);
        assert_eq!(labels(&out.tabs), ["From the phone"], "B stays closed, A keeps the other writer's name");
        assert_eq!(out.tabs[0].extra["color"], "teal");
        assert!(out.ops.is_empty(), "nothing the window sent was newer: {:?}", out.ops);
        // Having taken the answer, the window renames A itself: that lands.
        let mut mine = out.tabs.clone();
        mine[0].label = "Mine".into();
        let out = sync_in(&path, "p", client(out.version, mine)).unwrap();
        assert_eq!(labels(&out.tabs), ["Mine"]);
        // An edit that changed nothing about a tab leaves its stamp alone.
        let before = updated_version(&out.tabs[0]);
        let stored = edit_in(&path, "p", |_| Ok(())).unwrap();
        assert_eq!(updated_version(&stored.tab_layout[0]), before);
    }

    /// H1b: the owner mints what a created PTY tab lacks — its tmux name in
    /// the shape the sidecar's catalog checks, and an agent's schedule
    /// binding — and leaves a name the client minted, an attach, and a pane
    /// kind with no PTY alone.
    #[test]
    fn a_created_pty_tab_is_given_a_tmux_name_and_an_agent_its_schedule_binding() {
        let (_dir, path) = file();
        let mut agent = tab("a", "Claude");
        agent.extra.insert("kind".into(), Value::String("agent".into()));
        let mut local = tab("l", "Local");
        local.extra.insert("kind".into(), Value::String("local_agent".into()));
        let mut attach = tab("t", "Attached");
        attach.extra.insert("tmuxAttach".into(), Value::String("train".into()));
        let mut files = tab("f", "Files");
        files.extra.insert("kind".into(), Value::String("files".into()));
        let out = sync_in(&path, "box:paper", client(0, vec![tab("s", "Shell"), agent, local, attach, files, pty_tab("m", "Mine", concat!(crate::app_slug!(), "-box_paper--shell-mine"))])).unwrap();
        let by_label = |l: &str| out.tabs.iter().find(|t| t.label == l).unwrap().clone();
        let shell = tmux_of(&by_label("Shell")).unwrap().to_string();
        assert!(shell.starts_with(concat!(crate::app_slug!(), "-box_paper--shell-")), "{shell}");
        assert!(shell.len() > concat!(crate::app_slug!(), "-box_paper--shell-").len() + 8);
        assert!(shell.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
        assert!(extra_str(&by_label("Shell"), "scheduleTargetId").is_none(), "a shell binds no schedules");
        let agent = by_label("Claude");
        assert!(tmux_of(&agent).unwrap().starts_with(concat!(crate::app_slug!(), "-box_paper--agent-")));
        assert!(extra_str(&agent, "scheduleTargetId").is_some());
        assert!(tmux_of(&by_label("Local")).unwrap().starts_with(concat!(crate::app_slug!(), "-box_paper--agent-")), "a local-model tab carries the agent token");
        assert_eq!(tmux_of(&by_label("Attached")), Some("train"), "an attach is not re-minted");
        assert!(extra_str(&by_label("Attached"), "tmuxSession").is_none());
        assert!(tmux_of(&by_label("Files")).is_none(), "no PTY, no session");
        assert_eq!(tmux_of(&by_label("Mine")), Some(concat!(crate::app_slug!(), "-box_paper--shell-mine")), "the client's own name stands");
        // A sync that changes nothing mints nothing new.
        let again = sync_in(&path, "box:paper", client(out.version, out.tabs.clone())).unwrap();
        assert!(again.ops.is_empty());
        assert_eq!(tmux_of(&again.tabs[0]).unwrap(), shell);
    }

    /// H1b: the sidecar's create appends one owner-minted tab per request;
    /// the same request again answers the tab it already opened.
    #[test]
    fn a_headless_create_lands_once_per_request_and_moves_the_version() {
        let (_dir, path) = file();
        let seeded = sync_in(&path, "p", client(0, vec![tab("a", "A")])).unwrap();
        let mut spec = tab("", "Claude");
        spec.extra.insert("kind".into(), Value::String("agent".into()));
        spec.extra.insert("mobileRequestHash".into(), Value::String("req-1".into()));
        let created = create_tab_in(&path, "p", spec.clone(), Some("req-1")).unwrap();
        assert!(!created.existed);
        assert!(tab_id(&created.tab).is_some());
        assert!(tmux_of(&created.tab).unwrap().starts_with(concat!(crate::app_slug!(), "-p--agent-")));
        assert_eq!(created_version(&created.tab), seeded.version + 1);
        let again = create_tab_in(&path, "p", spec, Some("req-1")).unwrap();
        assert!(again.existed);
        assert_eq!(tab_id(&again.tab), tab_id(&created.tab));
        let stored = read_session(&path).unwrap();
        assert_eq!(labels(&stored.tab_layout), ["A", "Claude"]);
        assert_eq!(version_of(&stored), seeded.version + 1, "a repeat writes nothing");
        // A window that hydrated before the create merges the tab in rather
        // than overwriting it with its older set.
        let out = sync_in(&path, "p", client(seeded.version, seeded.tabs.clone())).unwrap();
        assert!(out.stale);
        assert_eq!(labels(&out.tabs), ["A", "Claude"]);
    }

    /// H3: the phone's tab edits with no window open land through the
    /// per-tab operations — rename, colour, reorder, close — each one an
    /// `edit_in`, so a window's stale copy merges rather than overwrites; a
    /// closed agent tab is remembered for a reopen, which comes back as a
    /// new tab (fresh id and tmux name, same session id) at the end.
    #[test]
    fn phone_tab_operations_land_in_the_file_and_a_closed_agent_tab_reopens() {
        let (_dir, path) = file();
        let mut agent = pty_tab("b", "Claude", concat!(crate::app_slug!(), "-p--agent-2"));
        agent.extra.insert("kind".into(), Value::String("agent".into()));
        agent.session_id = Some("uid-1".into());
        agent.extra.insert("scheduleTargetId".into(), Value::String("target-1".into()));
        let seeded = sync_in(&path, "p", client(0, vec![pty_tab("a", "A", concat!(crate::app_slug!(), "-p--shell-1")), agent, pty_tab("c", "C", concat!(crate::app_slug!(), "-p--shell-3"))])).unwrap();
        let base = seeded.version;

        let stored = rename_tab_in(&path, "p", concat!(crate::app_slug!(), "-p--shell-1"), "From the phone").unwrap();
        assert_eq!(stored.tab_layout[0].label, "From the phone");
        assert_eq!(rename_tab_in(&path, "p", "nope", "x").unwrap_err(), TAB_NOT_FOUND);
        let stored = color_tab_in(&path, "p", concat!(crate::app_slug!(), "-p--shell-1"), Some("teal")).unwrap();
        assert_eq!(stored.tab_layout[0].extra["color"], "teal");
        let stored = color_tab_in(&path, "p", concat!(crate::app_slug!(), "-p--shell-1"), None).unwrap();
        assert!(!stored.tab_layout[0].extra.contains_key("color"));
        let stored = reorder_tab_in(&path, "p", concat!(crate::app_slug!(), "-p--shell-3"), concat!(crate::app_slug!(), "-p--shell-1"), false).unwrap();
        assert_eq!(labels(&stored.tab_layout), ["C", "From the phone", "Claude"]);
        let stored = reorder_tab_in(&path, "p", concat!(crate::app_slug!(), "-p--shell-3"), concat!(crate::app_slug!(), "-p--agent-2"), true).unwrap();
        assert_eq!(labels(&stored.tab_layout), ["From the phone", "Claude", "C"]);
        assert_eq!(reorder_tab_in(&path, "p", concat!(crate::app_slug!(), "-p--shell-3"), "nope", true).unwrap_err(), TAB_NOT_FOUND);
        assert_eq!(labels(&read_session(&path).unwrap().tab_layout), ["From the phone", "Claude", "C"], "a refused move changes nothing");

        // Closing hands the record back (the caller ends its session); a shell
        // is forgotten, an agent tab is kept for a reopen.
        let shell = close_tab_in(&path, "p", concat!(crate::app_slug!(), "-p--shell-3"), 1_000).unwrap();
        assert_eq!(shell.label, "C");
        assert!(closed_tabs(&read_session(&path).unwrap()).is_empty());
        let closed = close_tab_in(&path, "p", concat!(crate::app_slug!(), "-p--agent-2"), 2_000).unwrap();
        assert_eq!(closed.label, "Claude");
        let stored = read_session(&path).unwrap();
        assert_eq!(labels(&stored.tab_layout), ["From the phone"]);
        let remembered = closed_tabs(&stored);
        assert_eq!(remembered.len(), 1);
        assert_eq!(remembered[0].closed_at, 2_000);
        assert_eq!(remembered[0].tab.label, "Claude");
        assert_ne!(remembered[0].id, "uid-1", "the closed id is never the session id");
        assert_eq!(close_tab_in(&path, "p", concat!(crate::app_slug!(), "-p--agent-2"), 3_000).unwrap_err(), TAB_NOT_FOUND);

        // The window's stale snapshot neither resurrects the closed tabs nor
        // undoes the rename.
        let out = sync_in(&path, "p", client(base, seeded.tabs.clone())).unwrap();
        assert_eq!(labels(&out.tabs), ["From the phone"]);

        // Reopening by an unknown id is nothing; the newest comes back as a
        // new tab with a fresh id, a fresh tmux name and its session id.
        assert!(reopen_tab_in(&path, "p", Some("not-a-closed-id")).unwrap().is_none());
        let reopened = reopen_tab_in(&path, "p", None).unwrap().expect("reopened");
        assert_eq!(reopened.label, "Claude");
        assert_eq!(reopened.session_id.as_deref(), Some("uid-1"));
        assert_eq!(reopened.extra["scheduleTargetId"], "target-1", "its schedules follow it");
        assert_ne!(tmux_of(&reopened), Some(concat!(crate::app_slug!(), "-p--agent-2")));
        assert!(tmux_of(&reopened).unwrap().starts_with(concat!(crate::app_slug!(), "-p--agent-")));
        assert_ne!(tab_id(&reopened), tab_id(&closed));
        let stored = read_session(&path).unwrap();
        assert_eq!(labels(&stored.tab_layout), ["From the phone", "Claude"]);
        assert!(closed_tabs(&stored).is_empty());
        assert!(reopen_tab_in(&path, "p", None).unwrap().is_none());
        // A window whose base predates the close keeps the reopened tab: it is
        // a create after its base, not a close it knew of.
        let out = sync_in(&path, "p", client(out.version, out.tabs.clone())).unwrap();
        assert_eq!(labels(&out.tabs), ["From the phone", "Claude"]);
    }

    /// The owner's reorder moves the saved pane tree with the set, so a
    /// window restoring from the tree keeps it; a tab the tree did not place
    /// is placed where a restore puts it, and a move between panes is refused.
    #[test]
    fn a_reorder_moves_the_saved_pane_tree_and_never_crosses_panes() {
        let (_dir, path) = file();
        let tmux = |n: &str| format!("{}-p--shell-{n}", crate::app_slug!());
        let groups = serde_json::json!({
            "type": "split", "dir": "row", "sizes": [0.5, 0.5],
            "children": [
                { "type": "group", "tabKeys": ["a", "b"], "activeKey": "a" },
                { "type": "group", "tabKeys": ["c"], "activeKey": "c" },
            ],
        });
        let tabs = vec![pty_tab("a", "A", &tmux("1")), pty_tab("b", "B", &tmux("2")), pty_tab("c", "C", &tmux("3"))];
        sync_in(&path, "p", ClientSync { groups: Some(groups), ..client(0, tabs) }).unwrap();
        let panes = |session: &TerminalSession| -> Vec<Vec<String>> {
            let mut tree = session.tab_groups.clone().unwrap();
            let mut out = Vec::new();
            pane_keys_mut(&mut tree, &mut out);
            out.iter().map(|p| p.iter().filter_map(Value::as_str).map(str::to_string).collect()).collect()
        };

        let stored = reorder_tab_in(&path, "p", &tmux("2"), &tmux("1"), false).unwrap();
        assert_eq!(labels(&stored.tab_layout), ["B", "A", "C"]);
        assert_eq!(panes(&stored), [vec!["b", "a"], vec!["c"]]);

        let version = version_of(&stored);
        let refused = reorder_tab_in(&path, "p", &tmux("3"), &tmux("1"), false).unwrap();
        assert_eq!(labels(&refused.tab_layout), ["B", "A", "C"], "no slot between panes");
        assert_eq!(panes(&refused), [vec!["b", "a"], vec!["c"]]);
        assert_eq!(version_of(&refused), version, "a refused move writes nothing");

        // Created by the owner after the window saved its tree: unplaced.
        create_tab_in(&path, "p", pty_tab("h", "H", &tmux("4")), None).unwrap();
        let stored = reorder_tab_in(&path, "p", &tmux("4"), &tmux("2"), false).unwrap();
        assert_eq!(labels(&stored.tab_layout), ["H", "B", "A", "C"]);
        assert_eq!(panes(&stored), [vec!["h", "b", "a"], vec!["c"]]);
    }

    #[test]
    fn tombstones_are_bounded() {
        let mut session = TerminalSession::default();
        let stones: Vec<Tombstone> = (0..(MAX_TOMBSTONES as u64 + 10)).map(|i| Tombstone { id: i.to_string(), version: i }).collect();
        set_tombstones(&mut session, stones);
        let kept = tombstones(&session);
        assert_eq!(kept.len(), MAX_TOMBSTONES);
        assert_eq!(kept[0].id, "10", "the oldest fell off");
    }

    /// A phone close with no window ends only a session the tab minted: an
    /// attach tab rides a session someone else started (possibly by hand),
    /// so the close hands it back without the right to end it.
    #[test]
    fn closing_an_attach_tab_does_not_own_the_session_it_rode() {
        let (_dir, path) = file();
        let mut attach = tab("t", "Attached");
        attach.extra.insert("tmuxAttach".into(), Value::String("train".into()));
        sync_in(&path, "box:paper", client(0, vec![attach, pty_tab("m", "Mine", concat!(crate::app_slug!(), "-box_paper--shell-mine"))])).unwrap();

        let closed = close_tab_in(&path, "box:paper", "train", 1).unwrap();
        assert_eq!(closed.label, "Attached");
        assert!(!owns_tmux_session(&closed), "the attached session is not the tab's to end");

        let closed = close_tab_in(&path, "box:paper", concat!(crate::app_slug!(), "-box_paper--shell-mine"), 2).unwrap();
        assert!(owns_tmux_session(&closed), "a minted session ends with its tab");
    }
}
