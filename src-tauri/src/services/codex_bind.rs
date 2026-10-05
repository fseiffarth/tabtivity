//! Hook-free Codex session binding — the fallback that keeps Codex tabs
//! resumable when Codex won't run Tabtivity's `SessionStart` hook.
//!
//! Codex gates user-level hooks behind a one-time trust approval (`/hooks`), and
//! an untrusted hook never fires — silently. Until the user trusts it, nothing
//! records a tab's live session id, so [`agent_session::resolve_codex_session`]
//! has nothing to resume and every restored Codex tab comes back blank.
//!
//! So we learn the id from Codex's own logs instead. Every session writes
//! `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<uuid>.jsonl`, whose first
//! line is a `session_meta` record carrying both `session_id` and `cwd`. We
//! follow that tree for a *new* rollout in a tracked tab's cwd and write its id
//! into the very same `live_sessions/<uid>` file the hook would have written —
//! so the resolve path, and Claude's, stay untouched.
//!
//! Attribution is by cwd and time, which is a heuristic, and it has two known
//! soft spots (the trusted hook has neither, which is why we still install it
//! and still nag):
//!
//! - Two Codex tabs started fresh in the *same* cwd within one tick can end up
//!   with each other's sessions. Claims are exclusive within the pass, so they
//!   cannot both be assigned the same conversation, and once a tab's hook
//!   records the conversation a sibling was only guessed into, that guess is
//!   withdrawn — two tabs never keep one conversation.
//! - A Codex started *outside* Tabtivity in a tracked tab's cwd can be mis-claimed
//!   when that tab's `/clear` is being rebound.
//!
//! Remote (ssh) Codex tabs are out of scope: their rollouts live on the far
//! host, so `commands::terminal::pty_spawn` never tracks them. Every local tab's
//! Codex — fenced or containerized — lives in its scope's Tabtivity-owned agent
//! home (`services::agent_home`), so each tracked tab carries the sessions
//! tree of its own scope and the poll walks one tree per scope.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

use crate::services::agent_session;

/// Rollout first lines inline the full base instructions, so they run ~20 KB.
/// Cap the read well above that but far below "a whole transcript".
const MAX_HEAD_BYTES: usize = 1 << 20;

/// mtime granularity + clock skew: a rollout created moments *before* we record
/// the spawn time is still plausibly ours.
const SLACK: Duration = Duration::from_secs(2);

/// A fresh Codex writes its rollout within a second or so of spawning; poll
/// briskly while any tracked tab is young, then settle into a slow watch that
/// only exists to catch a `/clear`.
const FAST_TICK: Duration = Duration::from_millis(400);
const SLOW_TICK: Duration = Duration::from_secs(2);
const FAST_PHASE: Duration = Duration::from_secs(20);

/// Once every tracked tab of a scope is past `FAST_PHASE`, its sessions tree is
/// walked again only when a watcher saw something under it change — a new
/// rollout (`/clear`), an append (a `/resume` writing to an old one) — or when
/// this backstop is due. The walk stats every rollout Codex ever wrote, so a
/// long-used home paid that every `SLOW_TICK` for as long as a Codex tab was
/// open. A tree that cannot be watched is walked every tick, as before.
const QUIET_BACKSTOP: Duration = Duration::from_secs(30);

/// A rollout's identifying header: the first JSONL line, when it is a
/// `session_meta` record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RolloutMeta {
    pub id: String,
    pub cwd: PathBuf,
    pub mtime: SystemTime,
    /// When Codex opened the thread (the header's `timestamp`, whole seconds
    /// since the epoch). The mtime moves on every append, so only this says
    /// which of two rollouts came first.
    pub created: Option<u64>,
    /// A thread Codex spawned under another one — its auto-review `guardian`,
    /// a subagent. Its header carries the *parent's* `session_id` and it can
    /// appear at any point of the parent's life, so it is never a tab's own.
    pub subagent: bool,
}

/// One Codex tab the binder is following.
struct Tracked {
    /// `TABTIVITY_TAB_UID` — the key `live_sessions/<uid>` is stored under.
    uid: String,
    /// The tab's cwd, canonicalized where possible (matched against `meta.cwd`).
    cwd: PathBuf,
    /// The scope's `.codex/sessions` tree, where this tab's rollouts land.
    root: PathBuf,
    /// Spawn time, less `SLACK`. Rollouts older than this were not made by us.
    since: SystemTime,
    /// Rollout ids that already existed when this tab spawned, plus every id
    /// we have since inspected and rejected — never opened twice.
    known: HashSet<String>,
    /// The id currently recorded for this tab, if any.
    bound: Option<String>,
    /// The id this binder guessed and wrote into the tab's record itself, as
    /// long as that record still holds it: a record equal to it is our cwd
    /// heuristic talking, not the hook.
    guessed: Option<String>,
    /// Bumped on every `track` of the same pty id, so a dying old PTY's teardown
    /// can't untrack the tab that just replaced it.
    seq: u64,
}

#[derive(Default)]
struct Binder {
    tabs: HashMap<String, Tracked>,
    next_seq: u64,
    resume_claims: HashMap<String, (u64, String)>,
}

/// A spawn-time reservation, including when rollout tracking is disabled.
/// Failed spawns release it; successful spawns hand cleanup to the PTY's exit.
pub struct ResumeClaim {
    pty: String,
    seq: u64,
    kept: bool,
}

impl ResumeClaim {
    pub fn keep(mut self) {
        self.kept = true;
    }
}

impl Drop for ResumeClaim {
    fn drop(&mut self) {
        if !self.kept {
            release_resume(&self.pty, self.seq);
        }
    }
}

/// Old binder records may already name one conversation for multiple tabs.
/// Let one resume it and open Codex's own session picker for the others, so the
/// user can recover the intended conversation without deleting any history or
/// bypassing Codex's live-writer lock.
pub fn reserve_resume(opts: &mut crate::terminal::PtyOptions) -> Option<ResumeClaim> {
    let mut b = binder().lock().unwrap();
    let seq = b.reserve_resume(&opts.id, &mut opts.args)?;
    Some(ResumeClaim { pty: opts.id.clone(), seq, kept: false })
}

impl Binder {
    fn release_resume(&mut self, pty: &str, seq: u64) {
        if self.resume_claims.get(pty).is_some_and(|(current, _)| *current == seq) {
            self.resume_claims.remove(pty);
        }
    }

    fn reserve_resume(&mut self, pty: &str, args: &mut Vec<String>) -> Option<u64> {
        if args.first().map(String::as_str) != Some("resume") {
            return None;
        }
        let id = args.get(1).filter(|id| agent_session::is_uuidish(id))?.clone();
        if self.resume_claims.iter().any(|(other, (_, claimed))| other != pty && claimed == &id) {
            // Keep any trailing CLI options, but drop the conflicting target.
            args.remove(1);
            eprintln!("codex_bind: duplicate resume target for {pty}; opening the Codex session picker");
            return None;
        }
        self.next_seq += 1;
        let seq = self.next_seq;
        self.resume_claims.insert(pty.to_string(), (seq, id));
        Some(seq)
    }
}

pub fn resume_seq(pty: &str) -> Option<u64> {
    binder().lock().unwrap().resume_claims.get(pty).map(|(seq, _)| *seq)
}

pub fn release_resume(pty: &str, seq: u64) {
    binder().lock().unwrap().release_resume(pty, seq);
}

fn binder() -> &'static Mutex<Binder> {
    static BINDER: OnceLock<Mutex<Binder>> = OnceLock::new();
    BINDER.get_or_init(|| Mutex::new(Binder::default()))
}

fn sessions_root_of(scope_id: Option<&str>) -> PathBuf {
    agent_session::codex_sessions_root(scope_id)
}

// ── Pure core ───────────────────────────────────────────────────────────────

/// `rollout-2026-07-11T11-26-43-019f5080-….jsonl` → the trailing uuid.
///
/// The id is right there in the filename, which is what lets `snapshot_ids`
/// enumerate every existing session without opening a single file.
pub fn rollout_id_from_filename(name: &str) -> Option<String> {
    let rest = name.strip_prefix("rollout-")?.strip_suffix(".jsonl")?;
    // `<ISO date>T<HH-MM-SS>-<uuid>`: the uuid is the last 5 dash-separated
    // groups, so drop everything before them.
    let parts: Vec<&str> = rest.split('-').collect();
    if parts.len() < 5 {
        return None;
    }
    let id = parts[parts.len() - 5..].join("-");
    agent_session::is_uuidish(&id).then_some(id)
}

/// Every rollout under `root`, as `(path, id, mtime)`. Bounded depth (the tree is
/// `YYYY/MM/DD/file`); stats only, no file contents.
fn walk_rollouts(root: &Path, out: &mut Vec<(PathBuf, String, SystemTime)>) {
    fn walk(dir: &Path, depth: u8, out: &mut Vec<(PathBuf, String, SystemTime)>) {
        if depth > 4 {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                walk(&path, depth + 1, out);
            } else if let Some(id) = path
                .file_name()
                .and_then(|n| n.to_str())
                .and_then(rollout_id_from_filename)
            {
                let mtime = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
                out.push((path, id, mtime));
            }
        }
    }
    walk(root, 0, out);
}

/// Ids of every rollout that exists right now. No file is opened.
pub fn snapshot_ids(root: &Path) -> HashSet<String> {
    let mut found = Vec::new();
    walk_rollouts(root, &mut found);
    found.into_iter().map(|(_, id, _)| id).collect()
}

/// Parse a rollout's `session_meta` header. `None` unless the first line really
/// is one and carries both fields — a half-written line (we may be reading while
/// Codex is still writing) simply fails to parse and is retried next tick.
pub fn read_rollout_meta(path: &Path, mtime: SystemTime) -> Option<RolloutMeta> {
    use std::io::Read;

    let mut file = std::fs::File::open(path).ok()?;
    let mut buf = vec![0u8; MAX_HEAD_BYTES];
    let n = file.read(&mut buf).ok()?;
    buf.truncate(n);
    let text = String::from_utf8_lossy(&buf);
    let line = text.split('\n').next()?;

    #[derive(serde::Deserialize)]
    struct Head {
        #[serde(rename = "type")]
        kind: String,
        payload: Payload,
    }
    #[derive(serde::Deserialize)]
    struct Payload {
        session_id: String,
        cwd: PathBuf,
        #[serde(default)]
        timestamp: Option<String>,
        #[serde(default)]
        parent_thread_id: Option<String>,
        #[serde(default)]
        source: serde_json::Value,
    }

    let head: Head = serde_json::from_str(line).ok()?;
    if head.kind != "session_meta" || !agent_session::is_uuidish(&head.payload.session_id) {
        return None;
    }
    let subagent = head.payload.parent_thread_id.is_some() || head.payload.source.get("subagent").is_some();
    Some(RolloutMeta {
        id: head.payload.session_id,
        cwd: head.payload.cwd,
        mtime,
        created: head.payload.timestamp.as_deref().and_then(crate::services::prompt_blame::iso_to_epoch),
        subagent,
    })
}

/// Pick the rollout that belongs to a tab whose cwd is `cwd`.
///
/// The whole attribution decision, kept pure. A candidate qualifies when it is
/// in the tab's cwd, is not one this tab has already seen or rejected (`known`),
/// is not a subagent's thread, and is not already bound to a live sibling tab
/// (`claimed`). Among those we take the **oldest** by creation — a tab's own
/// rollout is the *first* to appear after it spawned, so picking the newest
/// would let a later-spawned sibling in the same cwd steal it.
pub fn pick_binding(
    candidates: &[RolloutMeta],
    cwd: &Path,
    known: &HashSet<String>,
    claimed: &HashSet<String>,
) -> Option<String> {
    candidates
        .iter()
        .filter(|m| !m.subagent && !known.contains(&m.id) && !claimed.contains(&m.id) && same_dir(&m.cwd, cwd))
        .min_by_key(|m| (m.created, m.mtime))
        .map(|m| m.id.clone())
}

/// Compare two directories for identity. Both sides are canonicalized when they
/// still exist (a project can be moved), falling back to a literal compare —
/// which also keeps this honest on Windows, where `payload.cwd` comes back as a
/// `C:\…` path that may or may not carry a `\\?\` prefix.
fn same_dir(a: &Path, b: &Path) -> bool {
    let ca = a.canonicalize().unwrap_or_else(|_| a.to_path_buf());
    let cb = b.canonicalize().unwrap_or_else(|_| b.to_path_buf());
    ca == cb
}

// ── Registry ────────────────────────────────────────────────────────────────

/// Start following a Codex tab. `initial` is the session id we just resumed it
/// into (if any) — registered as this tab's claim straight away so a sibling
/// can't take it, and so its bumped mtime (resume *appends* to the existing
/// rollout) isn't mistaken for a new session.
///
/// Idempotent per `pty_id`: a re-spawn replaces the entry and bumps its seq.
/// Returns that seq, for `untrack`.
pub fn track(pty_id: &str, uid: &str, cwd: &Path, scope_id: Option<&str>, initial: Option<String>) -> u64 {
    let root = sessions_root_of(scope_id);
    let mut known = snapshot_ids(&root);
    if let Some(id) = &initial {
        known.insert(id.clone());
    }
    let since = SystemTime::now() - SLACK;
    let cwd = cwd.canonicalize().unwrap_or_else(|_| cwd.to_path_buf());

    {
        let mut b = binder().lock().unwrap();
        b.next_seq += 1;
        let seq = b.next_seq;
        b.tabs.insert(
            pty_id.to_string(),
            Tracked {
                uid: uid.to_string(),
                cwd,
                root,
                since,
                known,
                bound: initial,
                guessed: None,
                seq,
            },
        );
        ensure_poller();
        seq
    }
}

/// Stop following the tab a *specific* spawn of `pty_id` created. The seq guard
/// matters because a PTY's death is observed asynchronously: without it, the
/// dying old process of a re-spawned tab would untrack the live new one.
pub fn untrack(pty_id: &str, seq: u64) {
    let mut b = binder().lock().unwrap();
    if b.tabs.get(pty_id).is_some_and(|t| t.seq == seq) {
        b.tabs.remove(pty_id);
    }
}

/// Stop following `pty_id` outright — the tab itself is gone (explicit kill), so
/// there is no successor spawn to protect.
pub fn untrack_now(pty_id: &str) {
    let mut b = binder().lock().unwrap();
    b.tabs.remove(pty_id);
    b.resume_claims.remove(pty_id);
}

/// The seq currently tracking `pty_id`, if any. Lets `spawn_pty` hand its
/// teardown a token without plumbing `track`'s return value through the wrapper
/// layers between them.
pub fn current_seq(pty_id: &str) -> Option<u64> {
    binder().lock().unwrap().tabs.get(pty_id).map(|t| t.seq)
}

// ── Poll loop ───────────────────────────────────────────────────────────────

/// Start the single global poll task, once. It owns every tracked tab: one walk
/// of the sessions tree per tick serves all of them.
fn ensure_poller() {
    static STARTED: OnceLock<()> = OnceLock::new();
    if STARTED.set(()).is_err() {
        return;
    }
    tokio::spawn(async move {
        loop {
            let tick = poll_once();
            tokio::time::sleep(tick).await;
        }
    });
}

/// A tracked tab, copied out from under the lock so the tick's filesystem work
/// never holds it.
struct Snapshot {
    pty: String,
    uid: String,
    cwd: PathBuf,
    since: SystemTime,
    known: HashSet<String>,
    bound: Option<String>,
    guessed: Option<String>,
}

/// A watch on one scope's sessions tree (see `QUIET_BACKSTOP`).
struct RootWatch {
    watcher: Option<notify::RecommendedWatcher>,
    /// Set by the watcher on any create/modify/remove under the tree; taken by
    /// the pass that walks it.
    changed: Arc<AtomicBool>,
    last_pass: Option<Instant>,
    /// When starting the watcher last failed (a tree Codex has not created
    /// yet), so a missing tree is retried at the backstop, not every tick.
    failed_at: Option<Instant>,
}

fn root_watches() -> &'static Mutex<HashMap<PathBuf, RootWatch>> {
    static W: OnceLock<Mutex<HashMap<PathBuf, RootWatch>>> = OnceLock::new();
    W.get_or_init(|| Mutex::new(HashMap::new()))
}

fn watch_tree(root: &Path, changed: &Arc<AtomicBool>) -> Option<notify::RecommendedWatcher> {
    use notify::{RecursiveMode, Watcher};
    let flag = changed.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        // Content changes only: the pass's own reads of rollout headers are
        // access events, and counting them would keep the tree "changed".
        if res.is_ok_and(|ev| ev.kind.is_create() || ev.kind.is_modify() || ev.kind.is_remove()) {
            flag.store(true, Ordering::Release);
        }
    })
    .ok()?;
    watcher.watch(root, RecursiveMode::Recursive).ok()?;
    Some(watcher)
}

/// Whether `root` needs walking at `now`: always while it cannot be watched,
/// otherwise when something under it changed or the backstop is due.
fn pass_due(watch: &mut RootWatch, root: &Path, now: Instant) -> bool {
    if watch.watcher.is_none()
        && watch.failed_at.is_none_or(|t| now.duration_since(t) >= QUIET_BACKSTOP)
    {
        watch.watcher = watch_tree(root, &watch.changed);
        watch.failed_at = watch.watcher.is_none().then_some(now);
        // A fresh watch saw nothing before it started: walk once now.
        watch.last_pass = None;
    }
    let changed = watch.changed.swap(false, Ordering::AcqRel);
    let due = watch.watcher.is_none()
        || changed
        || watch.last_pass.is_none_or(|t| now.duration_since(t) >= QUIET_BACKSTOP);
    if due {
        watch.last_pass = Some(now);
    }
    due
}

/// One pass: bind every tracked tab that can be bound, one walk per scope's
/// sessions tree. Returns how long to wait before the next pass.
fn poll_once() -> Duration {
    let now = SystemTime::now();
    let (roots, young): (Vec<PathBuf>, HashSet<PathBuf>) = {
        let b = binder().lock().unwrap();
        let mut roots: Vec<PathBuf> = b.tabs.values().map(|t| t.root.clone()).collect();
        roots.sort();
        roots.dedup();
        let young = b
            .tabs
            .values()
            .filter(|t| now.duration_since(t.since).unwrap_or_default() < FAST_PHASE)
            .map(|t| t.root.clone())
            .collect();
        (roots, young)
    };
    // A scope with no tracked tab left drops its watch.
    root_watches().lock().unwrap().retain(|r, _| roots.contains(r));
    if roots.is_empty() {
        return SLOW_TICK;
    }
    let live = agent_session::live_sessions_dir();
    let at = Instant::now();
    roots
        .iter()
        .map(|root| {
            if !young.contains(root) {
                let mut watches = root_watches().lock().unwrap();
                let watch = watches.entry(root.clone()).or_insert_with(|| RootWatch {
                    watcher: None,
                    changed: Arc::new(AtomicBool::new(false)),
                    last_pass: None,
                    failed_at: None,
                });
                if !pass_due(watch, root, at) {
                    return SLOW_TICK;
                }
            }
            let store = root
                .parent()
                .and_then(crate::services::codex_store::state_db_in);
            poll_once_in(root, &live, store.as_deref(), binder())
        })
        .min()
        .unwrap_or(SLOW_TICK)
}

/// The pass for the tabs whose rollouts land under `root`.
fn poll_once_in(root: &Path, live_dir: &Path, store: Option<&Path>, state: &Mutex<Binder>) -> Duration {
    let mut tabs: Vec<Snapshot> = {
        let b = state.lock().unwrap();
        b.tabs
            .iter()
            .filter(|(_, t)| t.root == root)
            .map(|(pty, t)| Snapshot {
                pty: pty.clone(),
                uid: t.uid.clone(),
                cwd: t.cwd.clone(),
                since: t.since,
                known: t.known.clone(),
                bound: t.bound.clone(),
                guessed: t.guessed.clone(),
            })
            .collect()
    };
    // The tab spawned first picks first: with the oldest rollout going to it,
    // two fresh tabs in one cwd end up with their own sessions, not crossed.
    tabs.sort_by(|a, b| a.since.cmp(&b.since).then_with(|| a.pty.cmp(&b.pty)));
    if tabs.is_empty() {
        return SLOW_TICK;
    }

    let earliest = tabs.iter().map(|t| t.since).min().unwrap();
    let now = SystemTime::now();
    let young = tabs
        .iter()
        .any(|t| now.duration_since(t.since).unwrap_or_default() < FAST_PHASE);

    // Stat-only filter first: the vast majority of rollouts predate every tracked
    // tab, and those we never open.
    let mut found = Vec::new();
    walk_rollouts(root, &mut found);
    let fresh: Vec<(PathBuf, String, SystemTime)> = found
        .into_iter()
        .filter(|(_, _, mtime)| *mtime >= earliest)
        .collect();

    // Ids bound to *some* live tab — off-limits to every other tab.
    let mut claimed: HashSet<String> = tabs.iter().filter_map(|t| t.bound.clone()).collect();

    // Parse each fresh rollout at most once per tick, and only when at least one
    // tab hasn't already written it off. Keyed by the file's own id: a
    // subagent's header names its parent's session instead.
    let parsed: Vec<(String, RolloutMeta)> = fresh
        .iter()
        .filter(|(_, id, _)| tabs.iter().any(|t| !t.known.contains(id)))
        .filter_map(|(path, id, mtime)| Some((id.clone(), read_rollout_meta(path, *mtime)?)))
        .collect();
    // A subagent's file is nobody's session: written off for every tab at
    // once, so a busy auto-review isn't re-read each tick.
    let subagent_files: Vec<String> =
        parsed.iter().filter(|(_, m)| m.subagent).map(|(id, _)| id.clone()).collect();
    if !subagent_files.is_empty() {
        for t in &tabs {
            remember(state, &t.pty, subagent_files.clone());
        }
    }
    let metas: Vec<RolloutMeta> = parsed.into_iter().map(|(_, m)| m).collect();

    // A hook's precise assignment outranks the cwd heuristic even when its tab
    // comes later in this pass. Reserve every hook record before guessing any.
    // A record still holding the id we guessed into it is ours, not the hook's.
    let hook_ids: HashMap<String, String> = tabs.iter().filter_map(|t| {
        let id = agent_session::read_live_session_in(live_dir, &t.uid)
            .filter(|id| Some(id) != t.guessed.as_ref())
            .filter(|id| agent_session::codex_session_exists(root, store, id))?;
        Some((t.pty.clone(), id))
    }).collect();
    claimed.extend(hook_ids.values().cloned());
    for Snapshot {
        pty,
        uid,
        cwd,
        since: _,
        mut known,
        mut bound,
        guessed,
    } in tabs
    {
        // Our guess put this tab on a conversation some other tab's hook has
        // since recorded as its own: the guess was wrong. Withdraw it, so the
        // two tabs stop showing (and resuming) one conversation, and let this
        // tab pick again below.
        if let Some(g) = guessed.as_ref().filter(|g| {
            bound.as_ref() == Some(*g) && hook_ids.iter().any(|(other, id)| other != &pty && id == *g)
        }) {
            withdraw(state, live_dir, &pty, &uid, g);
            known.insert(g.clone());
            bound = None;
        }

        // The trusted hook, if it is running, is strictly more precise than we
        // are — so if it has recorded an id we didn't put there, it wins. Only
        // an id Codex actually still has, though: the record can also be written
        // by a *Claude* fired under this tab (its hook inherits the tab's key),
        // and adopting that id would leave the tab with a session Codex cannot
        // resume.
        if let Some(hook_id) = hook_ids.get(&pty).cloned() {
            if Some(&hook_id) != bound.as_ref() && !known.contains(&hook_id) {
                adopt(state, &pty, hook_id);
                continue;
            }
        }

        let mut mine = claimed.clone();
        if let Some(b) = &bound {
            mine.remove(b); // our own claim doesn't block us
        }
        let inspected: Vec<String> = metas.iter().map(|m| m.id.clone()).collect();

        match pick_binding(&metas, &cwd, &known, &mine) {
            Some(id) => {
                if let Err(e) = agent_session::write_live_session_in(live_dir, &uid, &id) {
                    eprintln!("codex_bind: record session for {uid}: {e}");
                    continue;
                }
                // This pass's next tab must see the claim we just wrote. A
                // snapshot frozen at the start assigned the same oldest rollout
                // to every fresh tab in a cwd, making their next resumes collide.
                claimed.insert(id.clone());
                adopt(state, &pty, id.clone());
                guess(state, &pty, id);
            }
            None => remember(state, &pty, inspected),
        }
    }

    if young {
        FAST_TICK
    } else {
        SLOW_TICK
    }
}

/// Record `id` as a tab's bound session (and never reconsider it).
fn adopt(state: &Mutex<Binder>, pty_id: &str, id: String) {
    let mut b = state.lock().unwrap();
    if let Some(t) = b.tabs.get_mut(pty_id) {
        t.known.insert(id.clone());
        t.guessed = None;
        t.bound = Some(id);
    }
}

/// Mark the tab's bound session as one this binder wrote from its cwd guess.
fn guess(state: &Mutex<Binder>, pty_id: &str, id: String) {
    if let Some(t) = state.lock().unwrap().tabs.get_mut(pty_id) {
        t.guessed = Some(id);
    }
}

/// Take back a wrong guess: unbind it and drop the record we wrote — unless
/// the hook has rewritten that record since, in which case it stays.
fn withdraw(state: &Mutex<Binder>, live_dir: &Path, pty_id: &str, uid: &str, id: &str) {
    {
        let mut b = state.lock().unwrap();
        if let Some(t) = b.tabs.get_mut(pty_id) {
            t.known.insert(id.to_string());
            t.guessed = None;
            t.bound = None;
        }
    }
    if agent_session::read_live_session_in(live_dir, uid).as_deref() == Some(id) {
        if let Err(e) = std::fs::remove_file(live_dir.join(uid)) {
            eprintln!("codex_bind: withdraw guessed session for {uid}: {e}");
        }
    }
}

/// Write off rollouts this tab has now looked at and does not want, so a later
/// tick never opens them again.
fn remember(state: &Mutex<Binder>, pty_id: &str, ids: Vec<String>) {
    let mut b = state.lock().unwrap();
    if let Some(t) = b.tabs.get_mut(pty_id) {
        t.known.extend(ids);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_tmp(prefix: &str) -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("{prefix}-{}-{n}", std::process::id()))
    }

    fn meta(id: &str, cwd: &str, secs: u64) -> RolloutMeta {
        RolloutMeta {
            id: id.to_string(),
            cwd: PathBuf::from(cwd),
            mtime: SystemTime::UNIX_EPOCH + Duration::from_secs(secs),
            created: Some(secs),
            subagent: false,
        }
    }

    fn new_watch() -> RootWatch {
        RootWatch {
            watcher: None,
            changed: Arc::new(AtomicBool::new(false)),
            last_pass: None,
            failed_at: None,
        }
    }

    /// A quiet scope's tree is walked once when watched, then only after a
    /// change under it (or at the backstop).
    #[test]
    fn a_watched_tree_is_walked_only_after_a_change() {
        let root = unique_tmp("codex-watch");
        std::fs::create_dir_all(root.join("2026/10/01")).unwrap();
        let mut w = new_watch();
        let t0 = Instant::now();
        assert!(pass_due(&mut w, &root, t0), "first pass walks");
        assert!(w.watcher.is_some());
        assert!(!pass_due(&mut w, &root, t0 + Duration::from_secs(2)), "nothing changed");

        std::fs::write(root.join("2026/10/01/rollout-x.jsonl"), b"{}\n").unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !w.changed.load(Ordering::Acquire) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(pass_due(&mut w, &root, t0 + Duration::from_secs(4)), "a new rollout walks");
        assert!(!pass_due(&mut w, &root, t0 + Duration::from_secs(6)));
        assert!(
            pass_due(&mut w, &root, t0 + Duration::from_secs(4) + QUIET_BACKSTOP),
            "the backstop walks"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A tree Codex has not created yet cannot be watched: it is walked every tick.
    #[test]
    fn an_unwatchable_tree_is_walked_every_tick() {
        let root = unique_tmp("codex-watch-missing");
        let mut w = new_watch();
        let t0 = Instant::now();
        assert!(pass_due(&mut w, &root, t0));
        assert!(w.watcher.is_none());
        assert!(pass_due(&mut w, &root, t0 + Duration::from_secs(2)));
    }

    fn tracked(uid: &str, cwd: &Path, root: &Path, since_secs: u64) -> Tracked {
        Tracked {
            uid: uid.into(),
            cwd: cwd.into(),
            root: root.into(),
            since: SystemTime::UNIX_EPOCH + Duration::from_secs(since_secs),
            known: HashSet::new(),
            bound: None,
            guessed: None,
            seq: since_secs,
        }
    }

    /// A rollout file for thread `file_id`, whose header names `session`
    /// (the parent's, for a subagent) and was opened at `at`.
    fn write_rollout(root: &Path, file_id: &str, session: &str, cwd: &Path, at: &str, subagent: bool) {
        let mut payload = serde_json::json!({
            "session_id": session, "id": file_id, "cwd": cwd, "timestamp": at, "source": "cli",
        });
        if subagent {
            payload["parent_thread_id"] = session.into();
            payload["source"] = serde_json::json!({"subagent": {"other": "guardian"}});
        }
        let header = serde_json::json!({"type": "session_meta", "payload": payload});
        std::fs::write(root.join(format!("rollout-2026-09-29T17-40-29-{file_id}.jsonl")), header.to_string()).unwrap();
    }

    #[test]
    fn a_guess_another_tabs_hook_records_is_withdrawn() {
        // Tab one was guessed onto B — tab two's conversation — before tab
        // two's hook said so. Once it does, the two tabs must not keep showing
        // one conversation: tab one moves to its own, A.
        let dir = tempfile::tempdir().unwrap();
        let (root, live) = (dir.path().join("sessions"), dir.path().join("live"));
        std::fs::create_dir_all(&root).unwrap();
        write_rollout(&root, A, A, dir.path(), "2026-09-29T15:40:30.000Z", false);
        write_rollout(&root, B, B, dir.path(), "2026-09-29T15:40:29.000Z", false);
        let (one, two) = ("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222");
        let state = Mutex::new(Binder::default());
        {
            let mut b = state.lock().unwrap();
            let mut first = tracked(one, dir.path(), &root, 1);
            first.known.insert(B.into());
            first.bound = Some(B.into());
            first.guessed = Some(B.into());
            b.tabs.insert("pty-one".into(), first);
            b.tabs.insert("pty-two".into(), tracked(two, dir.path(), &root, 2));
        }
        agent_session::write_live_session_in(&live, one, B).unwrap();
        agent_session::write_live_session_in(&live, two, B).unwrap(); // tab two's hook
        poll_once_in(&root, &live, None, &state);
        assert_eq!(agent_session::read_live_session_in(&live, two).as_deref(), Some(B));
        assert_eq!(agent_session::read_live_session_in(&live, one).as_deref(), Some(A));
        poll_once_in(&root, &live, None, &state);
        assert_eq!(agent_session::read_live_session_in(&live, one).as_deref(), Some(A));
        assert_eq!(agent_session::read_live_session_in(&live, two).as_deref(), Some(B));
    }

    #[test]
    fn an_auto_review_thread_is_never_a_sibling_tabs_session() {
        // Codex's guardian opens its own rollout mid-session whose header
        // carries the parent's session id; a fresh tab in that cwd must not be
        // bound to the parent's conversation through it.
        let dir = tempfile::tempdir().unwrap();
        let (root, live) = (dir.path().join("sessions"), dir.path().join("live"));
        std::fs::create_dir_all(&root).unwrap();
        write_rollout(&root, C, A, dir.path(), "2026-09-29T15:40:29.000Z", true);
        let fresh = "33333333-3333-4333-8333-333333333333";
        let state = Mutex::new(Binder::default());
        state.lock().unwrap().tabs.insert("pty".into(), tracked(fresh, dir.path(), &root, 1));
        poll_once_in(&root, &live, None, &state);
        assert_eq!(agent_session::read_live_session_in(&live, fresh), None);
        assert!(state.lock().unwrap().tabs["pty"].known.contains(C), "the guardian's file is written off");
    }

    #[test]
    fn two_fresh_tabs_take_their_rollouts_in_spawn_order() {
        let dir = tempfile::tempdir().unwrap();
        let (root, live) = (dir.path().join("sessions"), dir.path().join("live"));
        std::fs::create_dir_all(&root).unwrap();
        write_rollout(&root, A, A, dir.path(), "2026-09-29T15:40:29.000Z", false);
        write_rollout(&root, B, B, dir.path(), "2026-09-29T15:40:35.000Z", false);
        let (early, late) = ("44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555");
        let state = Mutex::new(Binder::default());
        {
            let mut b = state.lock().unwrap();
            // Pty names chosen so map order and name order both put the late tab first.
            b.tabs.insert("a-late".into(), tracked(late, dir.path(), &root, 5));
            b.tabs.insert("b-early".into(), tracked(early, dir.path(), &root, 1));
        }
        poll_once_in(&root, &live, None, &state);
        assert_eq!(agent_session::read_live_session_in(&live, early).as_deref(), Some(A));
        assert_eq!(agent_session::read_live_session_in(&live, late).as_deref(), Some(B));
    }

    const A: &str = "019f5080-245c-7813-8a7c-0e3c988ff891";
    const B: &str = "019f5081-1111-7813-8a7c-0e3c988ff892";
    const C: &str = "019f5082-2222-7813-8a7c-0e3c988ff893";

    #[test]
    fn one_poll_assigns_distinct_sessions_to_tabs_in_the_same_cwd() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("sessions");
        let live = dir.path().join("live");
        std::fs::create_dir_all(&root).unwrap();
        let state = Mutex::new(Binder::default());
        for (seq, uid) in [A, B].into_iter().enumerate() {
            state.lock().unwrap().tabs.insert(uid.into(), Tracked {
                uid: uid.into(), cwd: dir.path().into(), root: root.clone(), since: SystemTime::UNIX_EPOCH,
                known: HashSet::new(), bound: None, guessed: None, seq: seq as u64,
            });
            let header = serde_json::json!({"type": "session_meta", "payload": {
                "session_id": uid, "cwd": dir.path(),
            }});
            std::fs::write(root.join(format!("rollout-2026-09-15-{uid}.jsonl")), header.to_string()).unwrap();
        }
        poll_once_in(&root, &live, None, &state);
        let first = agent_session::read_live_session_in(&live, A).unwrap();
        let second = agent_session::read_live_session_in(&live, B).unwrap();
        assert_ne!(first, second, "two restored tabs must not resume the same writer");
        assert_eq!(HashSet::from([first, second]), HashSet::from([A.into(), B.into()]));
        poll_once_in(&root, &live, None, &state);
        assert_ne!(agent_session::read_live_session_in(&live, A), agent_session::read_live_session_in(&live, B));
    }

    #[test]
    fn duplicate_saved_resume_uses_picker_without_changing_other_options() {
        let mut state = Binder::default();
        let mut first = vec!["resume".into(), A.into()];
        let old_seq = state.reserve_resume("tab-a", &mut first).unwrap();
        let mut duplicate = vec!["resume".into(), A.into(), "--no-alt-screen".into()];
        assert!(state.reserve_resume("tab-b", &mut duplicate).is_none());
        assert_eq!(duplicate, vec!["resume", "--no-alt-screen"]);
        assert_eq!(first, vec!["resume", A]);
        let new_seq = state.reserve_resume("tab-a", &mut first).unwrap();
        assert_ne!(old_seq, new_seq);
        state.release_resume("tab-a", old_seq);
        assert!(state.resume_claims.contains_key("tab-a"));
        state.release_resume("tab-a", new_seq);
        let mut recovered = vec!["resume".into(), A.into()];
        assert!(state.reserve_resume("tab-c", &mut recovered).is_some());
        let mut other = vec!["resume".into(), B.into()];
        assert!(state.reserve_resume("tab-b", &mut other).is_some());
        assert!(state.reserve_resume("picker", &mut vec!["resume".into()]).is_none());
        assert!(state.reserve_resume("fresh", &mut vec![]).is_none());
    }

    #[test]
    fn failed_spawn_drops_claim_successful_spawn_keeps_it_until_exit() {
        let pty = "codex-resume-claim-lifecycle-test";
        let reserve = || {
            let seq = binder().lock().unwrap()
                .reserve_resume(pty, &mut vec!["resume".into(), C.into()]).unwrap();
            ResumeClaim { pty: pty.into(), seq, kept: false }
        };
        drop(reserve());
        assert_eq!(resume_seq(pty), None);
        let claim = reserve();
        let seq = claim.seq;
        claim.keep();
        assert_eq!(resume_seq(pty), Some(seq));
        release_resume(pty, seq);
        assert_eq!(resume_seq(pty), None);
    }

    #[test]
    fn rollout_id_parses_out_of_the_filename() {
        assert_eq!(
            rollout_id_from_filename(&format!("rollout-2026-07-11T11-26-43-{A}.jsonl")).as_deref(),
            Some(A)
        );
        assert_eq!(rollout_id_from_filename("notes.txt"), None);
        assert_eq!(rollout_id_from_filename("rollout-short.jsonl"), None);
        // A `.jsonl` that isn't a rollout at all.
        assert_eq!(rollout_id_from_filename("session-2026.jsonl"), None);
    }

    #[test]
    fn snapshot_ids_opens_no_files() {
        let root = unique_tmp(concat!(crate::app_slug!(), "-bind-snap"));
        let day = root.join("2026").join("07").join("11");
        std::fs::create_dir_all(&day).unwrap();
        for id in [A, B] {
            // Deliberately unparseable content: ids must come from the names.
            std::fs::write(
                day.join(format!("rollout-2026-07-11T11-26-43-{id}.jsonl")),
                b"",
            )
            .unwrap();
        }
        std::fs::write(day.join("stray.txt"), b"x").unwrap();

        let ids = snapshot_ids(&root);
        assert_eq!(ids.len(), 2);
        assert!(ids.contains(A) && ids.contains(B));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn read_rollout_meta_handles_a_fat_header_and_rejects_non_meta() {
        let root = unique_tmp(concat!(crate::app_slug!(), "-bind-head"));
        std::fs::create_dir_all(&root).unwrap();

        // Real headers inline ~20 KB of base instructions ahead of nothing in
        // particular — the fields must still come out.
        let filler = "x".repeat(30_000);
        let good = root.join("good.jsonl");
        std::fs::write(
            &good,
            format!(
                "{{\"timestamp\":\"t\",\"type\":\"session_meta\",\"payload\":{{\"session_id\":\"{A}\",\"cwd\":\"/home/u/proj\",\"base_instructions\":{{\"text\":\"{filler}\"}}}}}}\n{{\"type\":\"turn\"}}\n"
            ),
        )
        .unwrap();
        let m = read_rollout_meta(&good, SystemTime::UNIX_EPOCH).unwrap();
        assert_eq!(m.id, A);
        assert_eq!(m.cwd, PathBuf::from("/home/u/proj"));

        // Not a session_meta first line.
        let other = root.join("other.jsonl");
        std::fs::write(&other, "{\"type\":\"turn_context\",\"payload\":{}}\n").unwrap();
        assert_eq!(read_rollout_meta(&other, SystemTime::UNIX_EPOCH), None);

        // Torn line (we may read while Codex is still writing) → no panic, no id.
        let torn = root.join("torn.jsonl");
        std::fs::write(&torn, "{\"type\":\"session_meta\",\"payl").unwrap();
        assert_eq!(read_rollout_meta(&torn, SystemTime::UNIX_EPOCH), None);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn pick_binding_takes_the_oldest_unclaimed_rollout_in_the_tab_cwd() {
        let cwd = PathBuf::from("/home/u/proj");
        let candidates = vec![
            meta(A, "/home/u/other", 10), // wrong cwd
            meta(B, "/home/u/proj", 30),  // right cwd, but younger than C
            meta(C, "/home/u/proj", 20),  // ← the tab's own: first to appear
        ];
        assert_eq!(
            pick_binding(&candidates, &cwd, &HashSet::new(), &HashSet::new()).as_deref(),
            Some(C)
        );
    }

    #[test]
    fn pick_binding_ignores_rollouts_that_predate_the_tab() {
        // Ids present at spawn live in `known` and are never ours.
        let cwd = PathBuf::from("/home/u/proj");
        let candidates = vec![meta(A, "/home/u/proj", 10)];
        let known: HashSet<String> = [A.to_string()].into_iter().collect();
        assert_eq!(
            pick_binding(&candidates, &cwd, &known, &HashSet::new()),
            None
        );
    }

    #[test]
    fn pick_binding_skips_subagent_threads() {
        let cwd = PathBuf::from("/home/u/proj");
        let mut guardian = meta(A, "/home/u/proj", 10);
        guardian.subagent = true;
        let candidates = vec![guardian, meta(B, "/home/u/proj", 20)];
        assert_eq!(
            pick_binding(&candidates, &cwd, &HashSet::new(), &HashSet::new()).as_deref(),
            Some(B)
        );
    }

    #[test]
    fn pick_binding_orders_by_creation_not_by_last_write() {
        // B was opened first but A was written to last — B is still the older.
        let cwd = PathBuf::from("/home/u/proj");
        let mut a = meta(A, "/home/u/proj", 30);
        a.created = Some(10);
        let mut b = meta(B, "/home/u/proj", 40);
        b.created = Some(5);
        assert_eq!(pick_binding(&[a, b], &cwd, &HashSet::new(), &HashSet::new()).as_deref(), Some(B));
    }

    #[test]
    fn pick_binding_never_steals_a_sibling_tabs_session() {
        // Two tabs, one cwd: the only new rollout is already bound to tab A, so
        // tab B must come away with nothing rather than hijack it.
        let cwd = PathBuf::from("/home/u/proj");
        let candidates = vec![meta(A, "/home/u/proj", 10)];
        let claimed: HashSet<String> = [A.to_string()].into_iter().collect();
        assert_eq!(
            pick_binding(&candidates, &cwd, &HashSet::new(), &claimed),
            None
        );
    }
}
