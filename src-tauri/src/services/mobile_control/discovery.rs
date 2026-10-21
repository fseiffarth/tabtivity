use std::{
    collections::HashMap,
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    time::{Duration, Instant},
};

use base64ct::{Base64UrlUnpadded, Encoding};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::Sha256;

use super::protocol::TAB_COLORS;

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Clone, Deserialize)]
struct ProjectRecord {
    id: String,
    name: String,
    status: String,
    #[serde(default)]
    directory: Option<String>,
    /// The legacy shape's only folder hint: a record with no `directory` is
    /// the folder holding its `project.json` (`ProjectEntry::directory`).
    #[serde(default, deserialize_with = "lenient_string")]
    local_file: Option<String>,
    #[serde(default)]
    remote: Option<Value>,
    #[serde(default)]
    sandbox: Option<Value>,
    #[serde(default)]
    vm: Option<Value>,
    /// A remote (or VM) project's explicitly chosen local mirror folder, the
    /// entry's flattened top-level `mirror` key (`remote_sync::mirror_override`
    /// reads the same key). Lenient: a value that is not a string is no
    /// mirror, never a parse error for the file.
    #[serde(default, deserialize_with = "lenient_string")]
    mirror: Option<String>,
    // brand-check: allow — a serde key must be a literal; a test pins it to brand::MOBILE_ACCESS_KEY
    #[serde(default, rename = "tabtivity_mobile_access")]
    app_mobile_access: bool,
    /// The paired phones that may open it; absent means every phone
    /// (`brand::MOBILE_DEVICES_KEY`). Lenient: a malformed value closes this
    /// scope alone instead of failing the whole file.
    // brand-check: allow — a serde key must be a literal; a test pins it to brand::MOBILE_DEVICES_KEY
    #[serde(default, rename = "tabtivity_mobile_devices", deserialize_with = "crate::schema::projects::lenient_mobile_devices")]
    app_mobile_devices: Option<Vec<String>>,
}

impl ProjectRecord {
    /// The project's own folder, by the rule of `ProjectEntry::directory` and
    /// the window's `resolveProjectDirectory`: the trimmed `directory`, else
    /// the folder of a `project.json` named by `local_file` (a record from
    /// before `directory` was persisted, which startup backfills but a
    /// sidecar that read the file first, or a daemon, has not seen). Never an
    /// empty path or a filesystem root.
    fn directory(&self) -> Option<PathBuf> {
        if let Some(dir) = self.directory.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
            return Some(PathBuf::from(dir));
        }
        let file = Path::new(self.local_file.as_deref()?);
        if !file.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.eq_ignore_ascii_case("project.json")) {
            return None;
        }
        file.parent().filter(|dir| dir.file_name().is_some()).map(Path::to_path_buf)
    }
}

/// `deserialize_with` for an optional string that must never fail the record:
/// a string is kept, anything else is `None`.
fn lenient_string<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<String>, D::Error> {
    Ok(Value::deserialize(deserializer)?.as_str().map(str::to_string))
}

/// The slice of `boxes.json` the catalog reads (#31aa). A box is listed as a
/// scope of its own — its `box:<id>` scope has its own session file and tmux
/// names, and its tabs run locally whatever its members are — so it needs the
/// same three things a project does: a switch, a label and a root.
#[derive(Debug, Clone, Deserialize)]
struct BoxRecord {
    id: String,
    name: String,
    #[serde(default)]
    member_ids: Vec<String>,
    #[serde(default)]
    folder: Option<String>,
    // brand-check: allow — a serde key must be a literal; a test pins it to brand::MOBILE_ACCESS_KEY
    #[serde(default, rename = "tabtivity_mobile_access")]
    app_mobile_access: bool,
    /// The paired phones that may open it; absent means every phone
    /// (`brand::MOBILE_DEVICES_KEY`). Lenient: a malformed value closes this
    /// scope alone instead of failing the whole file.
    // brand-check: allow — a serde key must be a literal; a test pins it to brand::MOBILE_DEVICES_KEY
    #[serde(default, rename = "tabtivity_mobile_devices", deserialize_with = "crate::schema::projects::lenient_mobile_devices")]
    app_mobile_devices: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionFile {
    #[serde(default)]
    tab_layout: Vec<SavedTab>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedTab {
    label: String,
    cmd: String,
    cwd: String,
    kind: String,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    resume_args: Option<Vec<String>>,
    #[serde(default)]
    tmux_session: Option<String>,
    #[serde(default)]
    tmux_attach: Option<String>,
    /// Where the tab runs (`"local"`, `"remote"`, `"host:<id>"`); absent until
    /// the user or the Run-host picker sets it, then the per-kind default
    /// applies ([`tab_is_local`]). Loose, so an odd shape never drops the file.
    #[serde(default)]
    location: Option<Value>,
    #[serde(default)]
    ephemeral: bool,
    /// The user's tab colour, a palette id (see `protocol::TAB_COLORS`).
    #[serde(default)]
    color: Option<String>,
    /// A local-model tab's `{driver, model, args}` — what lets it restore, and
    /// so be one the phone can come back to (`terminal_service::local_launch_ok`).
    #[serde(default)]
    local_launch: Option<Value>,
    /// The tab's binding into `agent_tasks.json` — what its schedules are
    /// filed under. Read here so the sidecar can list them with no window.
    #[serde(default)]
    schedule_target_id: Option<String>,
    /// A sign-in tab (`src/lib/agents/signInLaunch.ts`): the CLI's login
    /// command, with no session to resume. The desktop saves it only while it
    /// runs (`isSavedWhileLive`), so it is listed like a resumable agent tab.
    #[serde(default)]
    sign_in: bool,
    /// A vendor cloud session (`src/lib/agents/cloudSessions.ts`), saved while
    /// it runs for the same reason.
    #[serde(default)]
    cloud: bool,
    /// The args the tab was launched with, and the launch moment (epoch ms) a
    /// headless create stamps (`headless::tab_record`): together they say
    /// whether an OpenCode tab began a session of its own — see
    /// [`ResolvedTab::since`]. Loose `Value`s, so an odd shape in either never
    /// drops the whole file.
    #[serde(default)]
    args: Option<Value>,
    #[serde(default)]
    launched_at: Option<Value>,
    /// The chat assistant's launch block (`assistant::ASSISTANT_KEY`): what
    /// makes a tab of that scope a chat at all. Loose, validated where the
    /// scope is resolved ([`assistant_chat`]).
    #[serde(default)]
    assistant: Option<Value>,
}

/// [`ResolvedTab::since`] off the saved record: its stamped launch moment,
/// unless it was started on `--continue` (the window's rule in
/// `agentReader.ts`).
fn fresh_since(tab: &SavedTab) -> Option<i64> {
    let continued = tab
        .args
        .as_ref()
        .and_then(Value::as_array)
        .is_some_and(|args| args.iter().any(|arg| arg.as_str().is_some_and(|arg| matches!(arg, "--continue" | "--resume" | "-c" | "-r"))));
    if continued {
        return None;
    }
    tab.launched_at.as_ref().and_then(|at| at.as_i64().or_else(|| at.as_f64().map(|ms| ms as i64)))
}

#[derive(Debug, Clone)]
struct LiveTmux {
    activity: u64,
    cwd: PathBuf,
}

/// What a scope row is. A box is not a project — it has no status of its own
/// and its tabs may live in several roots — and the phone says so on the row,
/// so a "Paper" box and a "Paper" project can be told apart.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ScopeKind {
    Project,
    Box,
    /// The root console (`docs/context/root_console.md`, "On the phone"): the
    /// one scope that is in neither list, behind its own switch and gate.
    Root,
    /// The chat assistant (`docs/assistant_plan.md`, decision 12): like root it
    /// is in neither list and behind a switch of its own ([`assistant_open`]),
    /// but it holds no project, no files and no repository: every
    /// `== ScopeKind::Project` gate leaves it out, and its tabs are chats the
    /// phone starts from [`super::assistant`]'s opaque launches.
    Assistant,
}

#[derive(Debug, Clone, Serialize)]
pub struct PublicProject {
    pub id: String,
    pub label: String,
    pub status: String,
    pub kind: ScopeKind,
    /// Where the project's tabs run: a type word the phone words one line
    /// from (`local`, `remote`, `container`, `vm`), never a host name or path.
    pub host: ProjectHost,
    pub live_sessions: usize,
    pub last_activity: Option<u64>,
    /// Root only: how many staged root-agent proposals wait for a decision.
    /// A count and nothing else — deciding them is the desktop's alone.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_reviews: Option<usize>,
    /// The desktop's git dot for a project (`protocol::git_dot`), filled in
    /// per request from the desktop — never read from disk here. Absent when
    /// clean, not a repo, never probed, or the desktop is closed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git: Option<&'static str>,
    /// How many of the project's agent tabs are working, waiting on a
    /// decision, or done right now, filled in per request from the same
    /// readings the activity list uses. Absent when none is in any of the three.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agents: Option<AgentCounts>,
}

/// A project row's agent tabs by state, for the phone's project list.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct AgentCounts {
    pub working: usize,
    pub question: usize,
    pub done: usize,
}

impl AgentCounts {
    /// Counts one tab's agent status; the states the row does not show are
    /// skipped.
    pub fn add(&mut self, status: &str) {
        match status {
            "working" => self.working += 1,
            "question" => self.question += 1,
            "done" => self.done += 1,
            _ => {}
        }
    }

    pub fn any(&self) -> bool {
        self.working + self.question + self.done > 0
    }
}

/// The one-line schedule summary the desktop's Agents view puts under an agent
/// tab, carried in the tab row itself so the phone's project overview reads the
/// same thing without a per-tab round trip.
#[derive(Debug, Clone, Serialize)]
pub struct TabSchedules {
    pub total: u32,
    pub enabled: u32,
    /// Desktop-local `YYYY-MM-DDTHH:MM` of the next run, when one is due.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next: Option<String>,
    /// The soonest enabled schedules still to fire, `at` desktop-local like
    /// `next`: the phone lists them with the tab's last prompts.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub upcoming: Vec<TabPrompt>,
}

/// One prompt an agent tab was given, as the desktop read it off the agent's
/// own transcript. `at` is the record's ISO instant; the phone formats it in
/// its own zone, and a record that carried none arrives without one.
#[derive(Debug, Clone, Serialize)]
pub struct TabPrompt {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PublicTab {
    pub id: String,
    pub label: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_label: Option<String>,
    /// The desktop's derived state for an agent tab, if the desktop is online.
    /// This intentionally never stores or infers terminal text in the sidecar.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_status: Option<String>,
    /// The model an agent tab's session is showing, in the words the session
    /// itself prints — the desktop reads them off the pane. A tab whose pane
    /// the desktop window does not hold falls back to the model it last
    /// answered with, shortened from the transcript's id.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_model: Option<String>,
    /// The agent tab's session is in plan mode / running a `/goal`, as its
    /// own status line says — the desktop's PLAN and GOAL tab pills, which
    /// the phone's cards wear too. Omitted while off or unknown.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub agent_plan: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub agent_goal: bool,
    /// How many subagents the agent tab's session has at work right now, as
    /// the desktop (or, with no window, the transcript) reads it — the count
    /// the phone's tab cards wear. Omitted at zero.
    #[serde(skip_serializing_if = "super::protocol::is_zero")]
    pub agent_subagents: u32,
    /// Desktop wall clock (ms) of the tab's last working output and of its last
    /// finished turn — the two keys the phone's Agents list can sort by. The
    /// desktop's numbers travel untouched: they are compared with each other,
    /// never with the phone's clock.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub working_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub done_at: Option<u64>,
    /// Desktop wall clock (ms) of when the tab's current or last turn began —
    /// with `working_at`/`done_at`, how long it has been or was at work.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_started_at: Option<u64>,
    /// How many prompts this agent tab has scheduled, and when the first fires.
    /// Absent for a shell tab and while the desktop is closed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schedules: Option<TabSchedules>,
    /// The newest prompts this agent tab was given, oldest first, as the
    /// desktop read them off the agent's transcript. Unlike `agent_status` this
    /// is published for a quiet tab as well: "what was this session last asked"
    /// is the line the phone's lists are opened for, and a session nobody has
    /// prompted in an hour is exactly the one whose answer is worth showing.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub prompts: Vec<TabPrompt>,
    pub available: bool,
    pub viewer_busy: bool,
    pub last_activity: Option<u64>,
    /// The tab's user-set colour as a palette id, absent when it has none. The
    /// phone resolves the id to the same hex the desktop does, so a tab reads
    /// as one colour on both surfaces; an id this build does not know is
    /// dropped here rather than published for the phone to guess at.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// The tab is a sign-in tab (`SavedTab::sign_in`), so the phone opens it
    /// with its sign-in sheet however it got there — from the tab list, or
    /// after the PWA reloaded on the way back from the sign-in page. Only the
    /// flag crosses; never the login command.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub sign_in: bool,
    /// The tab drives a local Ollama model (`local_agent`), so the phone shows
    /// its model rather than offering the driver's `/model` list, which would
    /// only move it off that model.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub local_model: bool,
    /// The linked worktree an agent tab runs in (`git_overview::tab_worktrees`),
    /// filled by the project route; absent for the project folder's checkout.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree: Option<super::git_overview::TabWorktree>,
    /// The other linked worktrees its subagents at work run in, with how many
    /// of them each (`git_overview::subagent_worktrees`), filled by the
    /// project route.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub subagent_worktrees: Vec<super::git_overview::SubagentWorktree>,
    /// A chat of the assistant scope: the opaque id of the launch it runs
    /// (`assistant::launch_handle`), the same id `launch-options` lists, so the
    /// phone's CLI picker can show which one is on.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assistant_launch: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ResolvedTab {
    pub public: PublicTab,
    pub tmux_name: String,
    /// The desktop's session id for an agent tab — the `TABTIVITY_TAB_UID` its
    /// processes run with, which `tabtivity-send` stamps on what it sends. Never
    /// crosses the browser API.
    pub session_id: Option<String>,
    /// The tab's `agent_tasks.json` binding, for answering its schedules with
    /// no window open (`headless`). Never crosses the browser API.
    pub schedule_target_id: Option<String>,
    /// The command the tab runs (`claude`, `codex`, `bash`, …) and the folder
    /// it runs in — what reading its transcript with no window needs. The
    /// folder is a raw path and never crosses the browser API.
    pub cmd: String,
    pub cwd: String,
    /// The launch moment (epoch ms) of a tab opened fresh rather than started
    /// on its continue flag — what keeps a new OpenCode tab from reading the
    /// folder's older session (`opencode_store`), as the window's
    /// `launchedAt` does. `None` once its args carry `--continue`.
    pub since: Option<i64>,
    /// A local-model tab: its agent runs in the scope's local-model home
    /// (`services::agent_home::local_model_home`), where its transcript is.
    pub local_model: bool,
}

/// Where a project's tabs run, a type word and nothing more (it crosses the
/// browser API as `host`). Read from the entry's `vm`, `remote` and `sandbox`
/// values, never from a path (AGENTS: remoteness is explicit).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ProjectHost {
    #[default]
    Local,
    Remote,
    Container,
    Vm,
}

/// What a phone may create in a scope (it crosses the browser API as
/// `create`): any tab, agents only, or nothing — the tabs of a remote host, a
/// container or a VM have no local tmux session to attach to (phase 1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CreateVerdict {
    All,
    Agents,
    None,
}

#[derive(Debug, Clone)]
pub struct ResolvedProject {
    pub public: PublicProject,
    /// The desktop's own id for the scope: a project id, or a `box:<id>` scope
    /// id, which the desktop bridge resolves the same way.
    pub raw_id: String,
    /// The scope's home: the project folder (a remote project's local mirror),
    /// or the box folder. The inbox lives here. When [`Self::folder`] is false
    /// it names no folder that exists: nothing may be read from or written to
    /// it.
    pub root: PathBuf,
    /// Every canonical directory a tab of this scope may run in — `root`
    /// first, then (for a box) each local member's root, because a box's
    /// per-member agent tab deliberately starts in that member's tree.
    pub roots: Vec<PathBuf>,
    pub tabs: Vec<ResolvedTab>,
    /// The paired phones this scope is open to: `None` is every phone, a list
    /// only those device ids (none when empty). Never crosses the browser API.
    pub devices: Option<Vec<String>>,
    /// Where the project's tabs run. `Local` for a box, root and the assistant.
    pub host: ProjectHost,
    /// Whether the scope has a folder the phone may read, write and probe: its
    /// first root resolved. False for a remote project whose mirror is not
    /// there yet, a VM project with no mirror (both are listed, with no
    /// tabs) and the assistant, which has a work folder and no project folder.
    pub folder: bool,
    /// What the phone may create here ([`CreateVerdict`]).
    pub create: CreateVerdict,
}

impl ResolvedProject {
    /// Whether the phone paired as `device_id` may see this scope at all.
    pub fn reaches(&self, device_id: &str) -> bool {
        device_listed(self.devices.as_deref(), device_id)
    }

    /// Whether [`Self::root`] is a real folder: the one test every
    /// folder-shaped route makes (files, git, upload, inbox, markup), instead
    /// of asking the scope's kind.
    pub fn has_folder(&self) -> bool {
        self.folder
    }
}

/// One scope to resolve, before its session file and tmux rows are read.
struct ScopeSource {
    raw_id: String,
    label: String,
    status: String,
    kind: ScopeKind,
    /// Uncanonicalized; the first entry is the home and must exist (a remote
    /// or VM project, and the assistant, are listed without it; a VM without
    /// a mirror has none at all), the rest are best-effort.
    roots: Vec<PathBuf>,
    /// [`ResolvedProject::devices`].
    devices: Option<Vec<String>>,
    /// [`ResolvedProject::host`].
    host: ProjectHost,
    /// A remote project's tabs are saved with `cwd` = the entry's `directory`
    /// (the window swaps the mirror in only at spawn); a tab saved with
    /// exactly this cwd is read as running in the first root (the mirror).
    cwd_alias: Option<PathBuf>,
    /// A container project whose spec scope is `all`: its shells run in the
    /// container too, not only its agents.
    shells_in_container: bool,
}

#[derive(Debug, Clone, Default)]
pub struct Catalog {
    pub projects: Vec<ResolvedProject>,
}

/// A catalog load forks `tmux ls` and walks every mobile-enabled project's
/// session directory. It is on the path of every HTTP handler, every WebSocket
/// upgrade *and* the periodic authorization re-check of each open terminal
/// (every fifth second of `pty_bridge`'s tick), so without a TTL an idle phone
/// with one terminal open kept the workstation at roughly 1.7 tmux forks per
/// second forever. At 1 s nearly every phone request still missed (its polls
/// run every 5 s and 8 s, the re-check every 5 s), so each paid a fork and the
/// session-file reads; 3 s lets a poll's burst of requests share one load.
/// The cost is staleness: a change made on the desktop (a tab opened or
/// closed there, phone access switched off) reaches the phone up to 3 s later.
/// Changes the phone makes itself go through `load_fresh` / `invalidate`.
const CATALOG_TTL: Duration = Duration::from_millis(3_000);

/// How long `tmux ls` may take before it is killed. It answers in
/// milliseconds; one that has not in this long is talking to a hung server,
/// and the load — which runs under the catalog mutex, in front of every
/// catalog-backed route — must not wait on it forever.
const TMUX_LS_TIMEOUT: Duration = Duration::from_secs(3);

/// After tmux could not be asked, how long before it is asked again. Without
/// this every load in the meantime would pay `TMUX_LS_TIMEOUT` again, one
/// after another under the mutex, and a hung tmux would still stall the
/// phone — just three seconds at a time.
const TMUX_RETRY: Duration = Duration::from_secs(5);

#[derive(Debug, Default)]
pub struct CatalogCache {
    last_valid: Option<Catalog>,
    loaded_at: Option<Instant>,
    /// What tmux last *answered*. Carried forward while it cannot be asked
    /// (see `live`), so a failed or hung `tmux ls` changes no tab's
    /// availability.
    last_live: Option<HashMap<String, LiveTmux>>,
    /// When tmux last could not be asked; cleared by the next answer.
    tmux_failed_at: Option<Instant>,
}

impl CatalogCache {
    /// Serves a snapshot up to `CATALOG_TTL` old.
    pub fn load(&mut self, state_dir: &Path, host_key: &[u8]) -> Result<Catalog, String> {
        if let (Some(catalog), Some(at)) = (self.last_valid.as_ref(), self.loaded_at) {
            if at.elapsed() < CATALOG_TTL {
                return Ok(catalog.clone());
            }
        }
        self.load_fresh(state_dir, host_key)
    }

    /// Bypasses the TTL, for the one caller that is waiting on a change it knows
    /// is not in the snapshot yet (a tab the desktop has just been told to open).
    pub fn load_fresh(&mut self, state_dir: &Path, host_key: &[u8]) -> Result<Catalog, String> {
        self.load_fresh_with(state_dir, host_key, live_tmux)
    }

    /// The live tmux sessions for this load: tmux's answer, or — when it could
    /// not be asked — the last answer it gave.
    ///
    /// "Could not be asked" (the spawn failed, the listing errored, it hung
    /// past `TMUX_LS_TIMEOUT`) used to read as "no sessions": every tab went
    /// `available: false`, and each open terminal's re-check then closed it
    /// with `access_revoked`, which does not retry — one failed fork took down
    /// every terminal on every phone. The previous answer is carried forward
    /// rather than the whole previous snapshot served, because the rest of the
    /// load is files and must stay current: a project whose phone access was
    /// just switched off is revoked on time even while tmux is wedged. With no
    /// previous answer at all the load fails, and the routes say
    /// `catalog_unavailable` instead of presenting every session as gone.
    fn live(
        &mut self,
        ask_tmux: impl FnOnce() -> Result<HashMap<String, LiveTmux>, String>,
    ) -> Result<HashMap<String, LiveTmux>, String> {
        if self.tmux_failed_at.is_some_and(|at| at.elapsed() < TMUX_RETRY) {
            return self
                .last_live
                .clone()
                .ok_or_else(|| "tmux could not be asked".to_string());
        }
        match ask_tmux() {
            Ok(live) => {
                self.tmux_failed_at = None;
                self.last_live = Some(live.clone());
                Ok(live)
            }
            Err(error) => {
                self.tmux_failed_at = Some(Instant::now());
                self.last_live.clone().ok_or(error)
            }
        }
    }

    fn load_fresh_with(
        &mut self,
        state_dir: &Path,
        host_key: &[u8],
        ask_tmux: impl FnOnce() -> Result<HashMap<String, LiveTmux>, String>,
    ) -> Result<Catalog, String> {
        let loaded = self
            .live(ask_tmux)
            .and_then(|live| Catalog::load_with(state_dir, host_key, &RootEnv::live(), &live));
        match loaded {
            Ok(next) => {
                self.last_valid = Some(next.clone());
                self.loaded_at = Some(Instant::now());
                Ok(next)
            }
            // A failed read leaves `loaded_at` alone so the next call retries
            // rather than pinning a stale snapshot for the whole TTL.
            Err(error) => self.last_valid.clone().ok_or(error),
        }
    }

    /// Forget how old the snapshot is, so the next read goes to disk. For the
    /// caller that has just changed what the snapshot describes and knows the
    /// change is already written: a tab closed from the phone is out of the
    /// session file by the time the desktop answers, and serving the rest of
    /// the TTL from the pre-close snapshot puts the row back under the reader's
    /// thumb. The snapshot itself is kept as the fallback for a failed read.
    pub fn invalidate(&mut self) {
        self.loaded_at = None;
    }
}

fn enabled(value: &Option<Value>) -> bool {
    value
        .as_ref()
        .and_then(|v| v.get("enabled"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

pub(super) fn key_id(key: &[u8], domain: &str, parts: &[&str]) -> String {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC accepts all key sizes");
    mac.update(domain.as_bytes());
    mac.update(&[0]);
    for (i, part) in parts.iter().enumerate() {
        if i > 0 {
            mac.update(&[0]);
        }
        mac.update(part.as_bytes());
    }
    Base64UrlUnpadded::encode_string(&mac.finalize().into_bytes()[..20])
}

/// Domains used by the mobile protocol's opaque identities.  Keep this allow
/// list narrow: callers may only derive IDs for the public objects the paired
/// device is permitted to receive or send back to the desktop bridge.
fn valid_opaque_control_domain(domain: &str) -> bool {
    matches!(
        domain,
        "agent"
            | "assistant"
            | "request"
            | "task"
            | "mail"
            | "calendar"
            | "event"
            | "project"
            | "subtask"
            | "worktree"
            | "alert"
    )
}

pub fn opaque_control_id(state_dir: &Path, domain: &str, value: &str) -> Result<String, String> {
    if !valid_opaque_control_domain(domain) {
        return Err("invalid opaque id domain".into());
    }
    let key = fs::read(state_dir.join("mobile-control/host.key"))
        .map_err(|e| format!("read host key: {e}"))?;
    if key.len() != 32 {
        return Err("invalid host key".into());
    }
    Ok(key_id(&key, domain, &[value]))
}

/// The root scope's own id, as the desktop's tab store and bridge spell it.
const ROOT_SCOPE_ID: &str = "root";

/// The root scope's id, or anything that maps onto its session directory.
fn is_root_scope_id(id: &str) -> bool {
    project_key(id) == ROOT_SCOPE_ID
}

/// What the root gate needs from outside the state dir, so a test can say it.
pub struct RootEnv {
    /// `paths::root_work_dir()`.
    pub dir: PathBuf,
    /// A root agent started now would run fenced — the three facts behind
    /// `root_mcp_status`'s `review_enforced`. Only asked when it decides.
    pub fenced: fn() -> bool,
}

impl RootEnv {
    fn live() -> Self {
        Self {
            dir: crate::paths::root_work_dir(),
            fenced: crate::services::agent_fence::enforced_here,
        }
    }
}

/// Whether the root console is the phone's right now. Read per catalog load,
/// so flipping any of its inputs needs no sidecar restart and an open root
/// terminal detaches at `pty_bridge`'s next re-check.
///
/// Off unless `tabtivity_mobile_host.root_access` is set. Then: a root agent
/// without the MCP tools holds no right a project agent lacks, so root is
/// open; with them, only while every write is staged (`root_mcp_review` =
/// all, the default and the reading of any unknown value) behind a fence the
/// agent cannot walk around — otherwise a prompt typed on the phone would
/// write the calendar with nobody at the desk to see it. Unreadable settings
/// refuse, as they do for the tools themselves.
fn root_open(state_dir: &Path, env: &RootEnv) -> bool {
    let Some(settings) = fs::read(state_dir.join("settings.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
    else {
        return false;
    };
    let switched_on = settings
        .get(crate::brand::MOBILE_HOST_KEY)
        .and_then(|host| host.get("root_access"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !switched_on {
        return false;
    }
    let tools = settings.get("root_mcp").and_then(Value::as_bool).unwrap_or(true);
    if !tools {
        return true;
    }
    let staged = !matches!(
        settings.get("root_mcp_review").and_then(Value::as_str),
        Some("destructive" | "off")
    );
    staged && (env.fenced)()
}

/// The assistant scope's own id, as the desktop's tab store and bridge spell it.
const ASSISTANT_SCOPE_ID: &str = crate::storage::ASSISTANT_SCOPE;

/// The assistant scope's id, or anything that maps onto its session directory
/// (`Assistant`, ` assistant`: a case-folding filesystem or the key reduction
/// would otherwise let a project record share its state and walk past
/// [`assistant_open`]).
pub(super) fn is_assistant_scope_id(id: &str) -> bool {
    project_key(id.trim()).eq_ignore_ascii_case(ASSISTANT_SCOPE_ID)
}

/// Whether the chat assistant is the phone's right now: the experimental flag
/// on and `[MOBILE_HOST_KEY].assistant_access` not `false` (unset is on — it
/// holds no right a phone should not reach). Read per catalog load, like
/// [`root_open`], so turning either off unlists the scope and an open chat
/// detaches at `pty_bridge`'s next re-check. Raw JSON, the sidecar's way;
/// [`crate::schema::Settings::assistant_phone_open`] is the same rule on the
/// typed settings and a test holds the two together (including the debug
/// fallback of a profile not yet marked `experimental_explicit`). Missing or
/// unreadable settings refuse.
pub fn assistant_open(state_dir: &Path) -> bool {
    let Some(settings) = fs::read(state_dir.join("settings.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
    else {
        return false;
    };
    // A value that is not a boolean would fail the typed settings' parse (and
    // so read as the defaults: off); it closes this reader too.
    let flag = |key: &str| -> Option<Option<bool>> {
        match settings.get(key) {
            None | Some(Value::Null) => Some(None),
            Some(Value::Bool(value)) => Some(Some(*value)),
            Some(_) => None,
        }
    };
    let (Some(flag_on), Some(explicit), Some(debug)) = (flag("assistant"), flag("experimental_explicit"), flag("debug")) else {
        return false;
    };
    let host = settings.get(crate::brand::MOBILE_HOST_KEY);
    let Some(access) = (match host.and_then(|host| host.get("assistant_access")) {
        None | Some(Value::Null) => Some(None),
        Some(Value::Bool(value)) => Some(Some(*value)),
        Some(_) => None,
    }) else {
        return false;
    };
    flag_on.unwrap_or_else(|| !explicit.unwrap_or(false) && debug.unwrap_or(false)) && access != Some(false)
}

fn project_key(id: &str) -> String {
    let out: String = id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if out.is_empty() {
        "x".into()
    } else {
        out
    }
}

fn expected_tmux(project_id: &str, kind: &str, name: &str) -> bool {
    expected_tmux_for(&crate::brand::PAIR, project_id, kind, name)
}

/// [`expected_tmux`] for a brand pair: the session may carry the prefix an
/// older build minted (a saved tab keeps its session's name, and a remote
/// session keeps running across an update).
fn expected_tmux_for(pair: &crate::brand::Pair, project_id: &str, kind: &str, name: &str) -> bool {
    let scoped = format!("{}--{kind}-", project_key(project_id));
    crate::services::brand_migration::compat::tmux_session_rest(pair, name)
        .is_some_and(|rest| rest.starts_with(&scoped) && rest.len() > scoped.len() + 8)
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// The built-in agent CLIs whose tabs resume across a relaunch, in registry
/// order (`commands::agents`' `Resume`, the frontend's `RESUMABLE_AGENTS`):
/// what the phone may come back to, and — with no window — what it may start
/// (`headless::agents`).
pub(super) fn resumable_builtins() -> Vec<&'static str> {
    crate::commands::agents::agent_bins()
        .into_iter()
        .filter(|bin| crate::commands::agents::is_resumable_bin(bin))
        .collect()
}

fn resumable(tab: &SavedTab) -> bool {
    tab.session_id.is_some()
        && (crate::commands::agents::is_resumable_bin(&tab.cmd)
            || tab.resume_args.as_ref().is_some_and(|v| !v.is_empty()))
}

/// Which agent an agent tab runs, as the phone names it: the registry's name
/// for the tab's CLI, so a tab renamed to "release review" still says it is
/// Claude — and the phone's per-agent readers (mode walk, paste, prompt echo)
/// still recognise it. The command itself never crosses the browser API; an
/// agent the registry does not list keeps its tab label, as before.
fn agent_label_of(tab: &SavedTab) -> String {
    // A local-model tab's `cmd` may be `ollama` (`ollama launch claude …`);
    // the agent is the driver's CLI, and the phone reads it as that one.
    let bin = tab
        .local_launch
        .as_ref()
        .and_then(|launch| launch.get("driver"))
        .and_then(Value::as_str)
        .and_then(crate::commands::ollama::local_driver_bin)
        .unwrap_or(&tab.cmd);
    crate::commands::agents::agent_label_for_bin(bin)
        .map(str::to_string)
        .unwrap_or_else(|| tab.label.chars().take(120).collect())
}

/// The command a tab's transcript is read as: its own, except that a
/// local-model tab driving OpenCode (`ollama launch opencode …`) reads as
/// `opencode` — found by folder, it needs no launch id. The other local
/// drivers keep their `ollama` line: Claude's and Codex's transcripts need the
/// launch id a local tab never mints. The window's `agentTranscriptFor` makes
/// the same call.
fn transcript_cmd_of(tab: &SavedTab) -> &str {
    let driver = tab
        .local_launch
        .as_ref()
        .and_then(|launch| launch.get("driver"))
        .and_then(Value::as_str);
    if tab.kind == "local_agent" && driver == Some("opencode") {
        "opencode"
    } else {
        &tab.cmd
    }
}

fn canonical_below_any(path: &Path, roots: &[PathBuf]) -> bool {
    path.canonicalize()
        .ok()
        .is_some_and(|p| roots.iter().any(|root| p.starts_with(root)))
}

/// Where a project's tabs run, from its record: a VM first (a VM project is
/// also a remote one, but pinned to the VM), then a remote host, then a
/// container; else this machine.
fn project_host(project: &ProjectRecord) -> ProjectHost {
    if enabled(&project.vm) {
        ProjectHost::Vm
    } else if project.remote.is_some() {
        ProjectHost::Remote
    } else if enabled(&project.sandbox) {
        ProjectHost::Container
    } else {
        ProjectHost::Local
    }
}

/// The folder a project gives the phone — the scope root that files, uploads,
/// the inbox and outbox, markup and the git dot use:
/// - local and container: the entry's `directory` (a container mounts the host
///   folder at the same path);
/// - remote: the local mirror, the entry's `mirror` if set, else the default
///   `remote_sync::default_mirror_dir_in` (the `directory` of a remote project
///   holds only its `project.json` and `sync.json`);
/// - VM: the `mirror` folder only if the user opted into one — a VM project has
///   no mirror by default, its overlay is the working tree.
///
/// It is computed from the record and `state_dir`, never through
/// `remote_sync::mirror_dir` (which reads the global `projects.json`). `None`
/// when there is no such folder on the record at all; the folder may still be
/// missing on disk.
fn mobile_root(state_dir: &Path, project: &ProjectRecord) -> Option<PathBuf> {
    let mirror = project.mirror.as_deref().map(str::trim).filter(|m| !m.is_empty()).map(PathBuf::from);
    match project_host(project) {
        ProjectHost::Vm => mirror,
        ProjectHost::Remote => Some(mirror.unwrap_or_else(|| crate::services::remote_sync::default_mirror_dir_in(state_dir, &project.id))),
        ProjectHost::Local | ProjectHost::Container => project.directory(),
    }
}

/// Whether a saved tab runs on this machine, by the window's rule
/// (`effectiveTabLocation` in `src/stores/tabs.ts`): a `local_agent` is always
/// local; on a VM project everything else is pinned to the VM; otherwise the
/// tab's `location` if set, else an agent is local and a shell is remote.
/// Only an exact `"local"` is local — `"remote"`, `"host:<id>"` and anything
/// unknown are not. Pinned against the window by one shared fixture.
fn tab_is_local(kind: &str, location: Option<&str>, vm_project: bool) -> bool {
    if kind == "local_agent" {
        return true;
    }
    if vm_project {
        return false;
    }
    match location {
        Some(location) => location == "local",
        None => kind != "shell",
    }
}

/// Whether a saved tab of this scope has a local tmux session the phone can
/// attach to: a local project's always; a remote or VM project's only when the
/// tab is local ([`tab_is_local`]); a container project's only when it runs on
/// the host — not an agent, and not a shell while the spec's scope is `all`
/// (the window's `sandbox` flag in `PaneSlot`).
fn tab_on_this_machine(source: &ScopeSource, tab: &SavedTab) -> bool {
    runs_on_this_machine(source.host, source.shells_in_container, &tab.kind, tab.location.as_ref().and_then(Value::as_str))
}

/// [`tab_on_this_machine`] on its inputs, so a launch (`launch_place`) applies
/// the same table as the catalog does.
fn runs_on_this_machine(host: ProjectHost, shells_in_container: bool, kind: &str, location: Option<&str>) -> bool {
    match host {
        ProjectHost::Local => true,
        ProjectHost::Remote | ProjectHost::Vm => tab_is_local(kind, location, host == ProjectHost::Vm),
        ProjectHost::Container => match kind {
            "agent" => false,
            "shell" => !shells_in_container,
            _ => true,
        },
    }
}

/// Whether a container project's shells run in the container: its spec's scope
/// is anything but `agents`.
fn container_shells(project: &ProjectRecord) -> bool {
    project.sandbox.as_ref().and_then(|s| s.get("scope")).and_then(Value::as_str) != Some("agents")
}

/// Where a phone's launch of a stored tab record runs, decided from the
/// project's record the way the window decides it (the same table as the
/// catalog's [`tab_on_this_machine`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum LaunchPlace {
    /// As the record says: a local project, a box, the root or the assistant,
    /// a container project's tab that runs on the host, or a scope with no
    /// project record (the spawn's own gate refuses an unknown project).
    AsRecorded,
    /// A remote project's tab that runs on this machine: `local_only`, in the
    /// project's mirror (the path), as the window runs an agent of it.
    LocalMirror(PathBuf),
    /// A container project's tab that runs in the container (`docker exec`,
    /// the sandbox flag re-derived at spawn): no local tmux session carries it
    /// for the phone to attach to, so the phone does not start one. A restart of
    /// a bound agent (the scheduler's) still launches it as recorded, which
    /// `launch_prep` puts in the container, as it always did.
    InContainer,
    /// A tab that runs on a remote host or in a VM: no local tmux session, so
    /// the phone cannot attach to it and does not start it. (`launch_prep` has
    /// no window's pool here, so a spawn would only fail.)
    NotAttachable,
}

/// [`LaunchPlace`] of a tab of `kind` and `location` (the record's loose
/// strings) in the scope `raw_id`, read from `<state_dir>/projects.json`. An
/// unreadable file is `NotAttachable` (nothing is guessed); a missing one, or
/// an id with no project record, is `AsRecorded`. Remoteness comes from the
/// record, never from a path.
pub(super) fn launch_place(state_dir: &Path, raw_id: &str, kind: &str, location: Option<&str>) -> LaunchPlace {
    // The root console and a box are no project record: their launch never
    // looked at `projects.json`, and a file the catalog cannot read must not
    // stop them restarting a tab.
    if is_root_scope_id(raw_id) || raw_id.trim().starts_with("box:") {
        return LaunchPlace::AsRecorded;
    }
    let projects: Vec<ProjectRecord> = match fs::read(state_dir.join("projects.json")) {
        Ok(bytes) => match serde_json::from_slice(&bytes) {
            Ok(projects) => projects,
            Err(_) => return LaunchPlace::NotAttachable,
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return LaunchPlace::AsRecorded,
        Err(_) => return LaunchPlace::NotAttachable,
    };
    let Some(project) = projects.iter().find(|p| p.id == raw_id) else {
        return LaunchPlace::AsRecorded;
    };
    let host = project_host(project);
    // A VM project never runs a tab on the host (`launch_prep` refuses a local
    // spawn there), not even the `local_agent` the catalog lists.
    if host == ProjectHost::Vm {
        return LaunchPlace::NotAttachable;
    }
    if !runs_on_this_machine(host, container_shells(project), kind, location) {
        return if host == ProjectHost::Container { LaunchPlace::InContainer } else { LaunchPlace::NotAttachable };
    }
    match (host, mobile_root(state_dir, project)) {
        (ProjectHost::Remote, Some(mirror)) => LaunchPlace::LocalMirror(mirror),
        (ProjectHost::Remote, None) => LaunchPlace::NotAttachable,
        _ => LaunchPlace::AsRecorded,
    }
}

/// What the phone may create in a project: local projects anything; a remote
/// project with a mirror its agents (they run in the mirror); a remote
/// project without one, a container and a VM nothing (phase 1).
fn create_verdict(host: ProjectHost, folder: bool) -> CreateVerdict {
    match host {
        ProjectHost::Local => CreateVerdict::All,
        ProjectHost::Remote if folder => CreateVerdict::Agents,
        ProjectHost::Remote | ProjectHost::Container | ProjectHost::Vm => CreateVerdict::None,
    }
}

/// `tmux ls` through Tabtivity's effective PATH, the one the desktop's own tmux
/// spawns use (`services::tmux_local`). A headless sidecar (launchd/systemd
/// user service) inherits a bare PATH, so a bare `tmux` misses Homebrew's on a
/// Mac, or picks `/usr/bin/tmux` against a server a `~/.local/bin/tmux` started
/// — and tmux refuses a client of another protocol version.
fn tmux_ls_command(format: &str) -> Command {
    let mut command = crate::services::tmux_local::tmux_command();
    command.args(["ls", "-F", format]);
    command
}

/// `Command::output` with a deadline: the child is killed and reaped once
/// `limit` has passed, and that is reported as `TimedOut`. Both pipes are
/// drained on their own threads meanwhile, so a child that fills one cannot
/// block on it; the threads end when the child's ends of the pipes close,
/// which killing it does.
fn output_within(mut command: Command, limit: Duration) -> std::io::Result<Output> {
    fn drain(pipe: Option<impl Read + Send + 'static>) -> std::thread::JoinHandle<Vec<u8>> {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            if let Some(mut pipe) = pipe {
                let _ = pipe.read_to_end(&mut bytes);
            }
            bytes
        })
    }
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let stdout = drain(child.stdout.take());
    let stderr = drain(child.stderr.take());
    let deadline = Instant::now() + limit;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(2)),
            waited => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(match waited {
                    Err(error) => error,
                    _ => std::io::Error::new(std::io::ErrorKind::TimedOut, "timed out"),
                });
            }
        }
    };
    Ok(Output {
        status,
        stdout: stdout.join().unwrap_or_default(),
        stderr: stderr.join().unwrap_or_default(),
    })
}

/// Whether a failed `tmux ls` is tmux saying there is no server — which is
/// how it says "zero sessions": the server exits with its last session, and a
/// client that finds none exits non-zero. The same three wordings the
/// desktop's own tmux calls take for "already gone"
/// (`tmux_local::kill_failure_is_already_gone`): `no server running on …`
/// (the socket is there, nobody behind it), `error connecting to … (No such
/// file or directory)` (no socket at all, tmux ≥ 3.x), and the older `failed
/// to connect to server`. Any other failure — a permission error, an
/// exhausted table, a server too busy to accept — is tmux not answering.
fn tmux_says_no_server(stderr: &str) -> bool {
    stderr.contains("no server running")
        || stderr.contains("failed to connect to server")
        || (stderr.contains("error connecting to")
            && (stderr.contains("No such file or directory") || stderr.contains("Connection refused")))
}

/// One `tmux ls` exit, read as an answer or as a failure to get one.
fn live_from_ls(success: bool, stdout: &[u8], stderr: &[u8]) -> Result<HashMap<String, LiveTmux>, String> {
    if !success {
        let stderr = String::from_utf8_lossy(stderr);
        if tmux_says_no_server(&stderr) {
            return Ok(HashMap::new());
        }
        return Err(format!("tmux ls failed: {}", stderr.trim()));
    }
    Ok(String::from_utf8_lossy(stdout)
        .lines()
        .filter_map(|line| {
            let mut p = line.splitn(3, '\t');
            let name = p.next()?.to_string();
            let activity = p.next()?.parse().ok()?;
            let cwd = PathBuf::from(p.next()?);
            Some((name, LiveTmux { activity, cwd }))
        })
        .collect())
}

/// The live tmux sessions, or `Err` when tmux could not be asked. The two
/// are different facts and are kept apart all the way up (`CatalogCache::live`):
/// an empty map is tmux answering "none".
fn live_tmux() -> Result<HashMap<String, LiveTmux>, String> {
    // Windows has no tmux, and local tabs there are never wrapped in one
    // (`CenterPanel` disables local persistence on Windows), so there is nothing
    // to list — and a spawn per catalog read would only ever fail. The desktop's
    // Mobile settings say so rather than leaving an empty terminal list to explain
    // itself.
    if terminals_support() == TERMINALS_UNSUPPORTED {
        return Ok(HashMap::new());
    }
    let format ="#{session_name}\t#{session_activity}\t#{pane_current_path}";
    match output_within(tmux_ls_command(format), TMUX_LS_TIMEOUT) {
        Ok(out) => live_from_ls(out.status.success(), &out.stdout, &out.stderr),
        // No tmux on Tabtivity's PATH: no session was ever started in one.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(HashMap::new()),
        Err(error) => Err(format!("tmux ls: {error}")),
    }
}

/// The project detail's `terminals` value where the host's tabs attach
/// through tmux: the phone offers ＋, Schedule and Mark up's Submit.
pub const TERMINALS_TMUX: &str = "tmux";
/// … and where the host has no tmux (Windows): the phone hides those three
/// and says why in one line. An older desktop sends no field, which the
/// phone reads as `tmux`.
pub const TERMINALS_UNSUPPORTED: &str = "unsupported";

/// Whether this host's terminals reach a phone — the one predicate behind
/// `live_tmux`'s short-circuit and the detail payload's `terminals` field, so
/// the two cannot drift. Pure, so both answers have a test on every OS.
fn terminals_support_on(windows: bool) -> &'static str {
    if windows { TERMINALS_UNSUPPORTED } else { TERMINALS_TMUX }
}

/// `terminals_support_on` for the host this build runs on.
pub fn terminals_support() -> &'static str {
    terminals_support_on(cfg!(target_os = "windows"))
}

/// Whether a paired phone may see and open shell tabs. Off unless
/// `tabtivity_mobile_host.shell_tabs` is set: a shell is the whole account with
/// nothing between it and a lost phone, so Mobile is agents-only by default.
/// Read per catalog load, like `root_open`, so turning it off unlists every
/// shell and detaches an open one at `pty_bridge`'s next re-check.
/// Unreadable settings refuse.
pub fn shells_open(state_dir: &Path) -> bool {
    fs::read(state_dir.join("settings.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|settings| settings.get(crate::brand::MOBILE_HOST_KEY)?.get("shell_tabs")?.as_bool())
        .unwrap_or(false)
}

impl Catalog {
    #[cfg(test)]
    pub fn load(state_dir: &Path, host_key: &[u8]) -> Result<Self, String> {
        Self::load_with(state_dir, host_key, &RootEnv::live(), &live_tmux().unwrap_or_default())
    }

    fn load_with(
        state_dir: &Path,
        host_key: &[u8],
        root: &RootEnv,
        live: &HashMap<String, LiveTmux>,
    ) -> Result<Self, String> {
        let sources = scope_sources(state_dir, root)?;
        let shells = shells_open(state_dir);
        let resolved = sources
            .into_iter()
            .filter_map(|source| resolve_scope(state_dir, host_key, live, shells, source))
            .collect();
        Ok(Self { projects: resolved })
    }
}

/// Every scope a phone may be shown and the per-phone list of each, read
/// from the state dir as the catalog reads it — before any session file or
/// tmux row. The one place the opt-in rule lives: `Catalog::load_with` and
/// [`ScopeAccess`] both start here.
fn scope_sources(state_dir: &Path, root: &RootEnv) -> Result<Vec<ScopeSource>, String> {
    let bytes =
        fs::read(state_dir.join("projects.json")).map_err(|e| format!("read projects: {e}"))?;
    let projects: Vec<ProjectRecord> =
        serde_json::from_slice(&bytes).map_err(|e| format!("parse projects: {e}"))?;
    // Boxes are optional: no file, or one this build cannot read, costs the
    // boxes and never the projects — a corrupt `boxes.json` must not take
    // the whole catalog with it (see the session-file rule below).
    let boxes: Vec<BoxRecord> = fs::read(state_dir.join("boxes.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    let mut sources = Vec::new();
    if root_open(state_dir, root) {
        sources.push(ScopeSource {
            raw_id: ROOT_SCOPE_ID.into(),
            label: "Root".into(),
            status: "active".into(),
            kind: ScopeKind::Root,
            roots: vec![root.dir.clone()],
            // Root has its own switch and gate; per-phone root is out of
            // scope (docs/done/mobile_device_scoped_access_plan.md).
            devices: None,
            host: ProjectHost::Local,
            cwd_alias: None,
            shells_in_container: false,
        });
    }
    if assistant_open(state_dir) {
        sources.push(ScopeSource {
            raw_id: ASSISTANT_SCOPE_ID.into(),
            label: crate::brand::ASSISTANT_NAME.into(),
            status: "active".into(),
            kind: ScopeKind::Assistant,
            // Every chat runs in a folder of its own below the work folder
            // (`assistant::chat_dir`); a tab whose cwd is anywhere else is
            // dropped by `resolve_scope`.
            roots: vec![crate::services::assistant::work_root(state_dir)],
            // Like root: one switch, not a per-phone list.
            devices: None,
            host: ProjectHost::Local,
            cwd_alias: None,
            shells_in_container: false,
        });
    }
    for project in &projects {
        if !project.app_mobile_access {
            continue;
        }
        // Root is listed above, by its own switch and gate, and is not a
        // project: this refuses a hand-edited record that would borrow its
        // session directory — and walk past that gate — by taking its id.
        // The same for any scope the app keeps for itself (the chat
        // assistant's has its own source, listed by its own switch).
        if is_root_scope_id(&project.id) || is_assistant_scope_id(&project.id) || crate::storage::is_reserved_scope(&project.id) {
            continue;
        }
        let host = project_host(project);
        // A remote project's folder is its mirror, a default that needs no
        // `directory`; a VM without a mirror has none and is listed all the
        // same (no tabs, no folder) so the switch shows on the phone. A local
        // or container project with no `directory` is no project folder.
        let roots: Vec<PathBuf> = match mobile_root(state_dir, project) {
            Some(root) => vec![root],
            None if host == ProjectHost::Vm => Vec::new(),
            None => continue,
        };
        sources.push(ScopeSource {
            raw_id: project.id.clone(),
            label: project.name.clone(),
            status: project.status.clone(),
            kind: ScopeKind::Project,
            roots,
            devices: project.app_mobile_devices.clone(),
            host,
            cwd_alias: (host == ProjectHost::Remote).then(|| project.directory()).flatten(),
            shells_in_container: host == ProjectHost::Container && container_shells(project),
        });
    }
    for b in &boxes {
        // A box never opened on the desktop has no folder and so no tabs;
        // the desktop's switch resolves the folder on enable, so this only
        // skips a bit hand-edited onto a folder-less record.
        if !b.app_mobile_access {
            continue;
        }
        let Some(folder) = b.folder.as_deref() else {
            continue;
        };
        let mut roots = vec![PathBuf::from(folder)];
        for id in &b.member_ids {
            let Some(member) = projects.iter().find(|p| &p.id == id) else {
                continue;
            };
            // A member's own Mobile switch is not consulted: the box's
            // switch is the consent, and what it covers is the box's tabs
            // — which run locally, in the folder or a member's phone folder
            // (a remote member's mirror). A VM member without a mirror
            // contributes no root, as a missing member root does.
            if let Some(dir) = mobile_root(state_dir, member) {
                roots.push(dir);
            }
        }
        sources.push(ScopeSource {
            raw_id: format!("box:{}", b.id),
            label: b.name.clone(),
            // A box has no status of its own; listing it is what the
            // switch means, so it is always in the phone's active list.
            status: "active".into(),
            kind: ScopeKind::Box,
            roots,
            // The box's own list; a member's list, like its switch, is
            // not consulted.
            devices: b.app_mobile_devices.clone(),
            // A box's tabs run locally whatever its members are.
            host: ProjectHost::Local,
            cwd_alias: None,
            shells_in_container: false,
        });
    }
    Ok(sources)
}

/// Whether a scope's per-phone list (`None`: every phone) names `device_id`.
fn device_listed(devices: Option<&[String]>, device_id: &str) -> bool {
    devices.is_none_or(|devices| devices.iter().any(|id| id == device_id))
}

/// Which phones may reach which scope, by raw scope id, without resolving a
/// tab: the catalog's own opt-in rule ([`scope_sources`]) and per-phone
/// list ([`ResolvedProject::reaches`]). What a phone-made prompt or schedule
/// is checked against before it is typed (`phone_origin`), so an access a
/// phone lost also stops what it left behind.
pub struct ScopeAccess {
    scopes: HashMap<String, Option<Vec<String>>>,
    /// `boxes.json` / `settings.json` is there but cannot be read. The
    /// catalog lists no box (no root) then, which is right for what it
    /// shows; for a rule that answer would *remove*, it is unknown instead.
    boxes_unread: bool,
    /// `settings.json`, which root's and the assistant's switches live in.
    settings_unread: bool,
}

/// Whether `path` exists but does not parse as `T` — a missing file is a
/// plain "none".
fn present_but_unreadable<T: serde::de::DeserializeOwned>(path: &Path) -> bool {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice::<T>(&bytes).is_err(),
        Err(error) => error.kind() != std::io::ErrorKind::NotFound,
    }
}

impl ScopeAccess {
    pub fn load(state_dir: &Path) -> Result<Self, String> {
        Self::load_with(state_dir, &RootEnv::live())
    }

    fn load_with(state_dir: &Path, root: &RootEnv) -> Result<Self, String> {
        Ok(Self {
            scopes: scope_sources(state_dir, root)?
                .into_iter()
                .map(|source| (source.raw_id, source.devices))
                .collect(),
            boxes_unread: present_but_unreadable::<Vec<BoxRecord>>(&state_dir.join("boxes.json")),
            settings_unread: present_but_unreadable::<Value>(&state_dir.join("settings.json")),
        })
    }

    /// Whether the phone paired as `device_id` reaches the scope `raw_id`. A
    /// scope no longer opted in reaches no phone. `Err` for a box, root or
    /// assistant whose file cannot be read right now: not known, so not "no".
    pub fn reaches(&self, raw_id: &str, device_id: &str) -> Result<bool, String> {
        if let Some(devices) = self.scopes.get(raw_id) {
            return Ok(device_listed(devices.as_deref(), device_id));
        }
        if self.boxes_unread && raw_id.starts_with("box:") {
            return Err("boxes.json cannot be read".into());
        }
        if self.settings_unread && (is_root_scope_id(raw_id) || is_assistant_scope_id(raw_id)) {
            return Err("settings.json cannot be read".into());
        }
        Ok(false)
    }
}

impl Catalog {
    /// This snapshot as the phone paired as `device_id` sees it: every scope
    /// whose per-phone list leaves that phone out is gone, so `project`, `tab`
    /// and `grants` answer for it exactly as for an unknown id. The cache stays
    /// one device-agnostic snapshot; each request filters its own copy.
    pub fn for_device(mut self, device_id: &str) -> Self {
        self.projects.retain(|project| project.reaches(device_id));
        self
    }

    pub fn project(&self, id: &str) -> Option<&ResolvedProject> {
        self.projects.iter().find(|p| p.public.id == id)
    }
    pub fn tab(&self, id: &str) -> Option<(&ResolvedProject, &ResolvedTab)> {
        self.projects
            .iter()
            .find_map(|p| p.tabs.iter().find(|t| t.public.id == id).map(|t| (p, t)))
    }

    /// Whether this snapshot still grants an open terminal its tab: the tab is
    /// listed (its scope's phone access is on, its row is in the session
    /// file), its session is live, and it is still the session the terminal
    /// attached to.
    pub fn grants(&self, tab_id: &str, tmux_name: &str) -> bool {
        self.tab(tab_id)
            .is_some_and(|(_, tab)| tab.public.available && tab.tmux_name == tmux_name)
    }
}

/// One project scope holding one live agent tab, for tests elsewhere in the
/// sidecar that need a catalog without a state dir or a tmux server.
#[cfg(test)]
pub(super) fn fixture_scope(tab_id: &str, tmux_name: &str, devices: Option<Vec<String>>) -> ResolvedProject {
    let tab = PublicTab {
        id: tab_id.into(),
        label: "Agent".into(),
        kind: "agent".into(),
        agent_label: None,
        agent_status: None,
        agent_model: None,
        agent_plan: false,
        agent_goal: false,
        agent_subagents: 0,
        working_at: None,
        done_at: None,
        schedules: None,
        prompts: Vec::new(),
        available: true,
        viewer_busy: false,
        last_activity: None,
        color: None,
        sign_in: false,
        local_model: false,
        turn_started_at: None,
        worktree: None,
        subagent_worktrees: Vec::new(),
        assistant_launch: None,
    };
    ResolvedProject {
        public: PublicProject {
            id: "p".into(),
            label: "P".into(),
            status: "active".into(),
            kind: ScopeKind::Project,
            host: ProjectHost::Local,
            live_sessions: 1,
            last_activity: None,
            pending_reviews: None,
            git: None,
            agents: None,
        },
        raw_id: "raw-p".into(),
        root: PathBuf::from("/"),
        roots: vec![PathBuf::from("/")],
        tabs: vec![ResolvedTab {
            public: tab,
            tmux_name: tmux_name.into(),
            session_id: None,
            schedule_target_id: None,
            cmd: "claude".into(),
            cwd: "/".into(),
            since: None,
            local_model: false,
        }],
        devices,
        host: ProjectHost::Local,
        folder: true,
        create: CreateVerdict::All,
    }
}

/// The launch an assistant-scope tab must carry to be listed, or `None` for a
/// record the scope does not keep: the strict `assistant` block of an offered
/// profile (a bad model fails), a plain agent tab (no local-model launch, sign-in,
/// cloud session or attach) running that profile's binary, a uuid-shaped
/// `sessionId`, and a working folder that is exactly `work/<sessionId>`. The
/// sidecar reads the session file raw, past `terminal_service`'s sanitiser, so
/// the rule is repeated here (`assistant::record_launch` is the same one on a
/// loaded `TabEntry`).
fn assistant_chat(tab: &SavedTab, roots: &[PathBuf]) -> Option<crate::services::assistant::AssistantLaunch> {
    use crate::services::assistant::{validate_launch, AssistantLaunch};
    let launch: AssistantLaunch = serde_json::from_value(tab.assistant.clone()?).ok()?;
    validate_launch(&launch).ok()?;
    let uid = tab.session_id.as_deref().filter(|uid| crate::services::agent_session::is_uuid_shaped(uid))?;
    let plain = tab.kind == "agent"
        && tab.cmd == launch.cli.bin()
        && tab.local_launch.is_none()
        && !tab.sign_in
        && !tab.cloud
        && tab.tmux_attach.is_none();
    let cwd = Path::new(&tab.cwd).canonicalize().ok()?;
    let own_folder = roots.first().is_some_and(|work| cwd.parent() == Some(work.as_path()))
        && cwd.file_name().and_then(|name| name.to_str()) == Some(uid);
    (plain && own_folder).then_some(launch)
}

/// Whether two paths name the same folder: equal as written, or both resolving
/// to one canonical path.
fn same_dir(a: &Path, b: &Path) -> bool {
    a == b || a.canonicalize().ok().zip(b.canonicalize().ok()).is_some_and(|(a, b)| a == b)
}

/// Read one scope's saved tabs and join them to the live tmux rows. `None`
/// when the scope's home directory does not resolve — a scope with no home has
/// nowhere for an inbox and nothing a tab could be checked against. The
/// exceptions are listed with no tab and `folder: false`: the assistant (until
/// its first chat makes the work folder), and a remote or VM project, whose
/// mirror may not be there yet (or, for a VM, at all) while its Mobile switch
/// must still show on the phone.
fn resolve_scope(
    state_dir: &Path,
    host_key: &[u8],
    live: &HashMap<String, LiveTmux>,
    shells: bool,
    source: ScopeSource,
) -> Option<ResolvedProject> {
    let assistant = source.kind == ScopeKind::Assistant;
    let listed_without_folder = assistant
        || (source.kind == ScopeKind::Project && matches!(source.host, ProjectHost::Remote | ProjectHost::Vm));
    let mut roots: Vec<PathBuf> = Vec::new();
    for (index, raw) in source.roots.iter().enumerate() {
        match raw.canonicalize() {
            Ok(root) => roots.push(root),
            // The assistant's work folder is made by the first chat's spawn:
            // until then the scope is listed with no tab, so the phone can
            // start that chat (a tab cannot sit below a root that is not
            // there, so none is listed).
            Err(_) if listed_without_folder && index == 0 => {}
            // The home must exist; a member root that does not simply hosts
            // no box tab, exactly as the fence's root list treats it.
            Err(_) if index == 0 => return None,
            Err(_) => {}
        }
    }
    let folder = !assistant && !roots.is_empty();
    let root = match roots.first() {
        Some(root) => root.clone(),
        // A root that is not there: the assistant's, or a remote/VM project's
        // mirror. A VM with no mirror has no path at all; the default mirror
        // location stands in, which nothing creates for it and no route
        // reads while `folder` is false.
        None if listed_without_folder => source
            .roots
            .first()
            .cloned()
            .unwrap_or_else(|| crate::services::remote_sync::default_mirror_dir_in(state_dir, &source.raw_id)),
        None => return None,
    };
    let session_path = state_dir
        .join("sessions")
        .join(project_key(&source.raw_id))
        .join("terminals.json");
    // One scope's session file is that scope's problem, not the catalog's.
    // The desktop writes it atomically, so a file that does not parse is real
    // corruption or a shape this build does not read — and it used to fail
    // the whole load, which the cache then answered from its last valid
    // snapshot on every request, forever: one bad file froze every project
    // the phone could see, with nothing anywhere to say why. Such a scope
    // simply has no attachable tabs until the desktop rewrites the file.
    let session = match fs::read(&session_path) {
        // No root, no tab: nothing could be checked against one.
        _ if roots.is_empty() => SessionFile { tab_layout: vec![] },
        Ok(bytes) => serde_json::from_slice::<SessionFile>(&bytes)
            .unwrap_or_else(|_| SessionFile { tab_layout: vec![] }),
        Err(_) => SessionFile { tab_layout: vec![] },
    };
    let mut tabs = Vec::new();
    // project-tree-read: ok — this is the state-dir terminal-session snapshot.
    for tab in session.tab_layout {
        // A local-model tab (`local_agent`) comes back like an agent tab: Mistral's
        // resumes its session, the other drivers relaunch the line they were
        // started with — and while the tmux session lives, both reattach.
        let local_agent = tab.kind == "local_agent";
        let agent = tab.kind == "agent" || local_agent;
        // The assistant scope lists chats and nothing else: a tab with no
        // valid launch block (a hand-edited or older record) is not one, and
        // a chat's folder is its own `work/<uid>`.
        let chat = if assistant {
            match assistant_chat(&tab, &roots) {
                Some(chat) => Some(chat),
                None => continue,
            }
        } else {
            None
        };
        let eligible_kind = (shells && tab.kind == "shell")
            || (agent && (resumable(&tab) || tab.sign_in || tab.cloud))
            || (local_agent
                && tab.local_launch.as_ref().is_some_and(|launch| {
                    crate::services::terminal_service::local_launch_ok(launch, &tab.cmd)
                }));
        // A remote project's tab is saved with the project's state-dir
        // `directory` as its cwd, though the agent runs in the mirror (the
        // window swaps it in at spawn): read it as the mirror, so it is below
        // the root and its transcript is looked up where the agent ran.
        let cwd = match &source.cwd_alias {
            Some(alias) if same_dir(Path::new(&tab.cwd), alias) => root.to_string_lossy().into_owned(),
            _ => tab.cwd.clone(),
        };
        if !eligible_kind
            || tab.ephemeral
            || tab.tmux_attach.is_some()
            || !tab_on_this_machine(&source, &tab)
            || !canonical_below_any(Path::new(&cwd), &roots)
        {
            continue;
        }
        let Some(tmux) = tab.tmux_session.as_deref() else {
            continue;
        };
        // Local-model tabs are minted with the `agent` token, like every agent
        // (`newTmuxSessionName`), and the phone knows them as agent tabs.
        let kind = if agent { "agent" } else { tab.kind.as_str() };
        if !expected_tmux(&source.raw_id, kind, tmux) {
            continue;
        }
        let live_row = live
            .get(tmux)
            .filter(|row| canonical_below_any(&row.cwd, &roots));
        let public = PublicTab {
            id: key_id(host_key, "tab", &[&source.raw_id, tmux]),
            label: tab.label.chars().take(120).collect(),
            kind: kind.to_string(),
            agent_label: agent.then(|| agent_label_of(&tab)),
            agent_status: None,
            agent_model: None,
            agent_plan: false,
            agent_goal: false,
            agent_subagents: 0,
            working_at: None,
            done_at: None,
            turn_started_at: None,
            schedules: None,
            prompts: Vec::new(),
            available: live_row.is_some(),
            viewer_busy: false,
            last_activity: live_row.map(|r| r.activity),
            color: tab
                .color
                .as_deref()
                .filter(|id| TAB_COLORS.contains(id))
                .map(str::to_string),
            sign_in: agent && tab.sign_in,
            local_model: local_agent || chat.as_ref().is_some_and(|launch| launch.cli.is_local()),
            worktree: None,
            subagent_worktrees: Vec::new(),
            assistant_launch: chat
                .as_ref()
                .map(|launch| super::assistant::launch_handle(host_key, launch.cli, launch.model.as_deref())),
        };
        tabs.push(ResolvedTab {
            public,
            tmux_name: tmux.to_string(),
            session_id: tab.session_id.clone(),
            schedule_target_id: tab.schedule_target_id.clone(),
            cmd: transcript_cmd_of(&tab).to_string(),
            cwd,
            since: fresh_since(&tab),
            local_model: local_agent || chat.as_ref().is_some_and(|launch| launch.cli.is_local()),
        });
    }
    let last_activity = tabs.iter().filter_map(|t| t.public.last_activity).max();
    let public = PublicProject {
        id: key_id(host_key, "project", &[&source.raw_id]),
        label: source.label.chars().take(120).collect(),
        status: source.status,
        kind: source.kind,
        host: source.host,
        live_sessions: tabs.iter().filter(|t| t.public.available).count(),
        last_activity,
        pending_reviews: (source.kind == ScopeKind::Root)
            .then(|| crate::services::root_mcp_review::pending_count(state_dir)),
        git: None,
        agents: None,
    };
    Some(ResolvedProject {
        public,
        raw_id: source.raw_id,
        root,
        roots,
        tabs,
        devices: source.devices,
        host: source.host,
        folder,
        create: create_verdict(source.host, folder),
    })
}

#[cfg(test)]
mod tests {
    /// The detail payload's `terminals` field has exactly two values, and the
    /// host's own answer is the one `live_tmux` short-circuits on: a Windows
    /// build says `unsupported` and lists no session, every other says `tmux`.
    #[test]
    fn terminals_support_names_tmux_or_unsupported() {
        assert_eq!(super::terminals_support_on(false), super::TERMINALS_TMUX);
        assert_eq!(super::terminals_support_on(true), super::TERMINALS_UNSUPPORTED);
        assert_eq!(super::terminals_support(), super::terminals_support_on(cfg!(target_os = "windows")));
        for value in [super::TERMINALS_TMUX, super::TERMINALS_UNSUPPORTED] {
            let row = serde_json::json!({ "shells": false, "terminals": value });
            assert_eq!(row["terminals"].as_str(), Some(value));
        }
        if cfg!(target_os = "windows") {
            assert!(super::live_tmux().is_ok_and(|live| live.is_empty()));
        }
    }

    /// A saved tab keeps the session name it was created with, and a remote
    /// session keeps running across an update: the name an older build
    /// minted still matches its tab, and is counted.
    #[test]
    fn a_session_minted_under_the_old_prefix_still_matches_its_tab() {
        use crate::brand::{Name, LEGACY};
        use crate::services::brand_migration::{hits, testing::RENAMED};
        let _ = hits::taken();
        let old = format!("{}p1--agent-123456789", LEGACY.name(Name::TMUX_PREFIX));
        assert!(super::expected_tmux_for(&RENAMED, "p1", "agent", &old));
        assert_eq!(hits::taken(), ["tmux-prefix"]);
        assert!(super::expected_tmux_for(&RENAMED, "p1", "agent", "newname-p1--agent-123456789"));
        assert!(!super::expected_tmux_for(&RENAMED, "p2", "agent", &old));
        assert!(!super::expected_tmux_for(&RENAMED, "p1", "agent", "other-p1--agent-123456789"));
    }

    /// The serde keys are literals in the attributes; this ties them to the
    /// brand module so they cannot drift.
    #[test]
    fn the_mobile_access_key_is_the_brand_constant() {
        let key = crate::brand::MOBILE_ACCESS_KEY;
        let project: super::ProjectRecord =
            serde_json::from_str(&format!(r#"{{"id":"p","name":"P","status":"active","{key}":true}}"#)).unwrap();
        assert!(project.app_mobile_access);
        let b: super::BoxRecord = serde_json::from_str(&format!(r#"{{"id":"b","name":"B","{key}":true}}"#)).unwrap();
        assert!(b.app_mobile_access);
    }

    /// The per-phone list's serde key is a literal too, and it is read
    /// leniently: absent is every phone, a list is those ids, anything else
    /// is no phone — and never a parse error for the record.
    #[test]
    fn the_mobile_devices_key_is_the_brand_constant_and_read_leniently() {
        let key = crate::brand::MOBILE_DEVICES_KEY;
        let project = |value: &str| -> super::ProjectRecord {
            let extra = if value.is_empty() { String::new() } else { format!(r#","{key}":{value}"#) };
            serde_json::from_str(&format!(r#"{{"id":"p","name":"P","status":"active"{extra}}}"#)).unwrap()
        };
        assert_eq!(project("").app_mobile_devices, None);
        assert_eq!(project(r#"["d1","d2"]"#).app_mobile_devices, Some(vec!["d1".to_string(), "d2".to_string()]));
        for malformed in ["[]", "null", r#""d1""#, r#"["d1",2]"#, "{}"] {
            assert_eq!(project(malformed).app_mobile_devices, Some(vec![]), "{malformed}");
        }
        let b: super::BoxRecord = serde_json::from_str(&format!(r#"{{"id":"b","name":"B","{key}":7}}"#)).unwrap();
        assert_eq!(b.app_mobile_devices, Some(vec![]));
    }

    /// The phone's access is read under the current key only. A key an older
    /// build left behind must not open a project the window (which reads the
    /// current key) shows as closed; and a record with both keys still parses.
    #[test]
    fn a_leftover_old_access_key_opens_nothing() {
        if !crate::brand::PAIR.renamed() {
            return;
        }
        let old = crate::brand::LEGACY_MOBILE_ACCESS_KEY;
        let new = crate::brand::MOBILE_ACCESS_KEY;
        let project: super::ProjectRecord =
            serde_json::from_str(&format!(r#"{{"id":"p","name":"P","status":"active","{old}":true}}"#)).unwrap();
        assert!(!project.app_mobile_access);
        let b: super::BoxRecord =
            serde_json::from_str(&format!(r#"{{"id":"b","name":"B","{old}":true,"{new}":false}}"#)).unwrap();
        assert!(!b.app_mobile_access);
    }

    use crate::brand::SLUG;
    use super::*;

    #[test]
    fn agent_counts_keep_working_question_and_done_and_skip_the_rest() {
        let mut counts = AgentCounts::default();
        assert!(!counts.any());
        for status in ["working", "question", "done", "done", "interrupted", "bogus"] {
            counts.add(status);
        }
        assert_eq!(counts, AgentCounts { working: 1, question: 1, done: 2 });
        assert!(counts.any());
        assert_eq!(
            serde_json::to_value(counts).unwrap(),
            serde_json::json!({ "working": 1, "question": 1, "done": 2 })
        );
    }

    #[test]
    fn tmux_ls_runs_through_app_path() {
        let command = tmux_ls_command("#{session_name}");
        let path = command
            .get_envs()
            .find(|(key, _)| *key == "PATH")
            .and_then(|(_, value)| value)
            .expect("PATH is set on the tmux ls spawn");
        let first = std::env::split_paths(path).next().expect("non-empty PATH");
        assert_eq!(first, crate::paths::extra_path_dirs()[0]);
    }

    #[test]
    fn opaque_ids_are_domain_separated_and_stable() {
        let key = [7u8; 32];
        assert_eq!(
            key_id(&key, "project", &["a"]),
            key_id(&key, "project", &["a"])
        );
        assert_ne!(key_id(&key, "project", &["a"]), key_id(&key, "tab", &["a"]));
        assert!(!key_id(&key, "project", &["secret-project"]).contains("secret"));
    }

    #[test]
    fn mobile_protocol_domains_are_accepted_but_arbitrary_ones_are_not() {
        for domain in [
            "agent", "request", "task", "mail", "calendar", "event", "project", "subtask",
            "worktree", "alert",
        ] {
            assert!(valid_opaque_control_domain(domain), "{domain}");
        }
        assert!(!valid_opaque_control_domain("filesystem_path"));
    }

    /// Every literal domain the desktop bridge mints an opaque id under must be
    /// on the allow list. The bridge swallows the command's error in places
    /// (the ＋ sheet's worktrees, the alert strip), and vitest mocks `invoke`, so
    /// a missing domain otherwise fails silently in production only.
    #[test]
    fn every_domain_the_bridge_mints_is_allowed() {
        let source = include_str!("../../../../src/components/mobile/MobileBridgeHost.tsx");
        let mut seen = Vec::new();
        // `invoke("mobile_opaque_id", { domain: "<x>", … })`
        for (at, _) in source.match_indices("\"mobile_opaque_id\"") {
            let rest = source[at + "\"mobile_opaque_id\"".len()..]
                .trim_start_matches(|c: char| c == ',' || c == '{' || c.is_whitespace());
            if let Some(after) = rest.strip_prefix("domain:") {
                if let Some(literal) = after.trim_start().strip_prefix('"') {
                    let domain = &literal[..literal.find('"').expect("closed literal")];
                    seen.push(domain.to_string());
                }
            }
        }
        // `opaqueId("<x>", …)`, the bridge's own wrapper
        for (at, _) in source.match_indices("opaqueId(\"") {
            let literal = &source[at + "opaqueId(\"".len()..];
            seen.push(literal[..literal.find('"').expect("closed literal")].to_string());
        }
        for domain in ["worktree", "alert", "request", "task", "agent"] {
            assert!(seen.iter().any(|d| d == domain), "scan found no {domain:?} call: {seen:?}");
        }
        for domain in &seen {
            assert!(valid_opaque_control_domain(domain), "the bridge mints {domain:?} ids");
        }
    }

    #[test]
    fn exact_session_names_only() {
        assert!(expected_tmux("p1", "shell", concat!(crate::app_slug!(), "-p1--shell-123456789")));
        assert!(!expected_tmux("p1", "shell", concat!(crate::app_slug!(), "-p2--shell-123456789")));
        assert!(!expected_tmux("p1", "shell", concat!(crate::app_slug!(), "-p1--agent-123456789")));
    }

    #[test]
    fn one_corrupt_session_file_costs_that_project_its_tabs_not_the_whole_catalog() {
        let dir = tempfile::tempdir().expect("state dir");
        let state = dir.path();
        allow_shells(state);
        let root_a = state.join("a");
        let root_b = state.join("b");
        fs::create_dir_all(&root_a).expect("root a");
        fs::create_dir_all(&root_b).expect("root b");
        let project = |id: &str, name: &str, root: &Path| {
            serde_json::json!({
                "id": id,
                "name": name,
                "status": "active",
                "directory": root.to_string_lossy(),
                concat!(crate::app_slug!(), "_mobile_access"): true,
            })
        };
        fs::write(
            state.join("projects.json"),
            serde_json::to_vec(&serde_json::json!([
                project("p-a", "A", &root_a),
                project("p-b", "B", &root_b),
            ]))
            .expect("projects"),
        )
        .expect("write projects");
        let sessions = state.join("sessions");
        fs::create_dir_all(sessions.join("p-a")).expect("session a");
        fs::create_dir_all(sessions.join("p-b")).expect("session b");
        fs::write(
            sessions.join("p-a").join("terminals.json"),
            serde_json::to_vec(&serde_json::json!({
                "tabLayout": [{
                    "label": "Shell",
                    "cmd": "bash",
                    "cwd": root_a.to_string_lossy(),
                    "kind": "shell",
                    "tmuxSession": concat!(crate::app_slug!(), "-p-a--shell-123456789"),
                }]
            }))
            .expect("session"),
        )
        .expect("write session a");
        fs::write(sessions.join("p-b").join("terminals.json"), b"{ not json").expect("corrupt b");

        let catalog = Catalog::load(state, &[7; 32])
            .expect("one unreadable session file must not fail the whole catalog");
        assert_eq!(catalog.projects.len(), 2);
        let a = catalog.projects.iter().find(|p| p.raw_id == "p-a").expect("A");
        let b = catalog.projects.iter().find(|p| p.raw_id == "p-b").expect("B");
        assert_eq!(a.tabs.len(), 1, "the healthy project keeps its tabs");
        assert!(b.tabs.is_empty(), "the corrupt one has none, and is still listed");
    }

    /// The cache is what keeps an idle phone from forking `tmux ls` twice a
    /// second, and it is also what could answer a poll with a tab the reader
    /// has just closed: the desktop rewrites the session file before it says
    /// "closed", so the only stale thing left is the snapshot's remaining TTL.
    /// The close route drops it (`invalidate`) and the next read goes to disk.
    #[test]
    fn an_invalidated_cache_re_reads_within_the_ttl() {
        let dir = tempfile::tempdir().expect("state dir");
        let state = dir.path();
        allow_shells(state);
        let root = state.join("p");
        fs::create_dir_all(&root).expect("root dir");
        fs::write(
            state.join("projects.json"),
            serde_json::to_vec(&serde_json::json!([{
                "id": "p-1",
                "name": "P",
                "status": "active",
                "directory": root.to_string_lossy(),
                concat!(crate::app_slug!(), "_mobile_access"): true,
            }]))
            .expect("projects"),
        )
        .expect("write projects");
        let sessions = state.join("sessions").join("p-1");
        fs::create_dir_all(&sessions).expect("session dir");
        let write_tabs = |tabs: serde_json::Value| {
            fs::write(
                sessions.join("terminals.json"),
                serde_json::to_vec(&serde_json::json!({ "tabLayout": tabs })).expect("session"),
            )
            .expect("write session");
        };
        write_tabs(serde_json::json!([{
            "label": "Shell",
            "cmd": "bash",
            "cwd": root.to_string_lossy(),
            "kind": "shell",
            "tmuxSession": concat!(crate::app_slug!(), "-p-1--shell-123456789"),
        }]));

        let mut cache = CatalogCache::default();
        let tabs = |catalog: &Catalog| catalog.projects[0].tabs.len();
        assert_eq!(tabs(&cache.load(state, &[7; 32]).expect("first read")), 1);

        // The close: the tab leaves the session file the catalog is read from.
        write_tabs(serde_json::json!([]));
        assert_eq!(
            tabs(&cache.load(state, &[7; 32]).expect("cached read")),
            1,
            "the snapshot is still young, so the closed tab is still in it"
        );
        cache.invalidate();
        assert_eq!(
            tabs(&cache.load(state, &[7; 32]).expect("re-read")),
            0,
            "an invalidated cache reads the file the close rewrote"
        );
    }

    /// A tab colour (#264) is published as the palette id the desktop stored, so
    /// the phone resolves it to the same hex — and an id this build does not have
    /// is dropped rather than passed on for the phone to guess at, which is the
    /// same posture `clean_tab_color` takes on the way in.
    #[test]
    fn a_tab_publishes_a_palette_colour_and_drops_anything_else() {
        let dir = tempfile::tempdir().expect("state dir");
        let state = dir.path();
        allow_shells(state);
        let root = state.join("p");
        fs::create_dir_all(&root).expect("root dir");
        fs::write(
            state.join("projects.json"),
            serde_json::to_vec(&serde_json::json!([{
                "id": "p-1",
                "name": "P",
                "status": "active",
                "directory": root.to_string_lossy(),
                concat!(crate::app_slug!(), "_mobile_access"): true,
            }]))
            .expect("projects"),
        )
        .expect("write projects");
        let sessions = state.join("sessions").join("p-1");
        fs::create_dir_all(&sessions).expect("session dir");
        let tab = |suffix: &str, color: serde_json::Value| {
            serde_json::json!({
                "label": format!("Shell {suffix}"),
                "cmd": "bash",
                "cwd": root.to_string_lossy(),
                "kind": "shell",
                "tmuxSession": format!("{SLUG}-p-1--shell-10000000{suffix}"),
                "color": color,
            })
        };
        fs::write(
            sessions.join("terminals.json"),
            serde_json::to_vec(&serde_json::json!({
                "tabLayout": [
                    tab("1", serde_json::json!("teal")),
                    tab("2", serde_json::json!("chartreuse")),
                    tab("3", serde_json::Value::Null),
                ]
            }))
            .expect("session"),
        )
        .expect("write session");

        let catalog = Catalog::load(state, &[7; 32]).expect("catalog");
        let project = catalog.projects.first().expect("project");
        let colors: Vec<Option<&str>> = project
            .tabs
            .iter()
            .map(|t| t.public.color.as_deref())
            .collect();
        assert_eq!(colors, vec![Some("teal"), None, None]);
    }

    /// The root console reaches the phone by its own switch and gate only
    /// (`root_open`) — never through a `projects.json` record hand-edited to
    /// take the root scope's id (and with it `sessions/root/`).
    #[test]
    fn the_root_scope_is_listed_by_its_switch_and_gate_alone() {
        let dir = tempfile::tempdir().expect("state dir");
        let state = dir.path();
        let root = state.join("root");
        fs::create_dir_all(&root).expect("root dir");
        fs::write(
            state.join("projects.json"),
            serde_json::to_vec(&serde_json::json!([{
                "id": "root",
                "name": "Borrowed",
                "status": "active",
                "directory": root.to_string_lossy(),
                concat!(crate::app_slug!(), "_mobile_access"): true,
            }]))
            .expect("projects"),
        )
        .expect("write projects");
        fs::create_dir_all(state.join("sessions").join("root")).expect("session dir");
        fs::write(
            state.join("sessions").join("root").join("terminals.json"),
            serde_json::to_vec(&serde_json::json!({
                "tabLayout": [{
                    "label": "Claude",
                    "cmd": "claude",
                    "cwd": root.to_string_lossy(),
                    "kind": "agent",
                    "sessionId": "s1",
                    "tmuxSession": concat!(crate::app_slug!(), "-root--agent-123456789"),
                }]
            }))
            .expect("session"),
        )
        .expect("write session");
        let fenced = RootEnv { dir: root.clone(), fenced: || true };
        let unfenced = RootEnv { dir: root.clone(), fenced: || false };
        let load = |settings: Option<serde_json::Value>, env: &RootEnv| {
            match settings {
                Some(value) => fs::write(state.join("settings.json"), value.to_string()).expect("settings"),
                None => { let _ = fs::remove_file(state.join("settings.json")); }
            }
            Catalog::load_with(state, &[7; 32], env, &HashMap::new()).expect("catalog").projects
        };
        let host = |on: bool| serde_json::json!({ "enabled": true, "root_access": on });

        // No settings, or the switch unset/off: the borrowed record is refused
        // and nothing else lists root.
        assert!(load(None, &fenced).is_empty());
        assert!(load(Some(serde_json::json!({ concat!(crate::app_slug!(), "_mobile_host"): { "enabled": true } })), &fenced).is_empty());
        assert!(load(Some(serde_json::json!({ concat!(crate::app_slug!(), "_mobile_host"): host(false) })), &fenced).is_empty());

        // Switched on, default review, fenced: one Root row — the gate's, not
        // the borrowed record's — with its tab and a pending count.
        let listed = load(Some(serde_json::json!({ concat!(crate::app_slug!(), "_mobile_host"): host(true) })), &fenced);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].public.kind, ScopeKind::Root);
        assert_eq!(listed[0].public.label, "Root");
        assert_eq!(listed[0].raw_id, "root");
        assert_eq!(listed[0].tabs.len(), 1);
        assert_eq!(listed[0].public.pending_reviews, Some(0));
        // An unknown review value reads as `all`, as it does for the tools.
        assert_eq!(load(Some(serde_json::json!({ concat!(crate::app_slug!(), "_mobile_host"): host(true), "root_mcp_review": "later" })), &fenced).len(), 1);

        // Tools on but writes not staged behind a fence: closed.
        assert!(load(Some(serde_json::json!({ concat!(crate::app_slug!(), "_mobile_host"): host(true) })), &unfenced).is_empty());
        for level in ["destructive", "off"] {
            assert!(
                load(Some(serde_json::json!({ concat!(crate::app_slug!(), "_mobile_host"): host(true), "root_mcp_review": level })), &fenced).is_empty(),
                "{level}"
            );
        }
        // Tools off: a root agent holds nothing extra, so neither matters.
        assert_eq!(
            load(Some(serde_json::json!({ concat!(crate::app_slug!(), "_mobile_host"): host(true), "root_mcp": false, "root_mcp_review": "off" })), &unfenced).len(),
            1
        );
        // Unreadable settings refuse.
        fs::write(state.join("settings.json"), b"{").expect("corrupt settings");
        assert!(Catalog::load_with(state, &[7; 32], &fenced, &HashMap::new()).expect("catalog").projects.is_empty());

        assert!(is_root_scope_id("root"));
        assert!(!is_root_scope_id("rooted"));
    }

    const CHAT_A: &str = "0b9d8f3e-2c1a-4e7b-9a55-3f6d1c2b7a10";
    const CHAT_B: &str = "1c9d8f3e-2c1a-4e7b-9a55-3f6d1c2b7a11";

    /// One saved assistant tab: `launch` is the strict block, `cwd` the folder.
    fn chat_tab(uid: &str, cwd: &Path, launch: serde_json::Value, tmux_tail: &str) -> serde_json::Value {
        serde_json::json!({
            "label": "Claude", "cmd": "claude", "cwd": cwd.to_string_lossy(), "kind": "agent",
            "sessionId": uid, "assistant": launch,
            "tmuxSession": format!("{}assistant--agent-{tmux_tail}", crate::brand::TMUX_PREFIX),
        })
    }

    fn assistant_state(settings: Option<serde_json::Value>, tabs: Vec<serde_json::Value>) -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("state dir");
        let state = dir.path();
        fs::write(state.join("projects.json"), "[]").expect("projects");
        if let Some(settings) = settings {
            fs::write(state.join("settings.json"), settings.to_string()).expect("settings");
        }
        let sessions = state.join("sessions").join("assistant");
        fs::create_dir_all(&sessions).expect("session dir");
        fs::write(sessions.join("terminals.json"), serde_json::json!({ "tabLayout": tabs }).to_string()).expect("session");
        dir
    }

    fn load_assistant(state: &Path) -> Vec<ResolvedProject> {
        let env = RootEnv { dir: state.join("root"), fenced: || true };
        Catalog::load_with(state, &[7; 32], &env, &HashMap::new()).expect("catalog").projects
    }

    /// The chat assistant reaches the phone by its switch and gate alone
    /// (`assistant_open`), as a scope of its own kind rooted in the work
    /// folder: listed before its folder exists (so the phone can start the
    /// first chat), with only the tabs that carry a valid launch and live in
    /// their own `work/<uid>` folder.
    #[test]
    fn the_assistant_scope_is_listed_by_its_gate_alone_and_keeps_only_chats() {
        let on = serde_json::json!({ "assistant": true });
        let work = |state: &Path| crate::services::assistant::work_root(state);
        let valid = serde_json::json!({ "cli": "claude" });

        // Off: the flag unset, or the Mobile switch off, or no settings, or an
        // unreadable file.
        for settings in [
            None,
            Some(serde_json::json!({})),
            Some(serde_json::json!({ "assistant": false })),
            Some(serde_json::json!({ "assistant": true, crate::brand::MOBILE_HOST_KEY: { "assistant_access": false } })),
        ] {
            let dir = assistant_state(settings, vec![]);
            assert!(load_assistant(dir.path()).is_empty());
        }
        let dir = assistant_state(None, vec![]);
        fs::write(dir.path().join("settings.json"), b"{").expect("corrupt");
        assert!(load_assistant(dir.path()).is_empty());

        // On, no work folder yet: one assistant row, no tab.
        let dir = assistant_state(Some(on.clone()), vec![]);
        let listed = load_assistant(dir.path());
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].public.kind, ScopeKind::Assistant);
        assert_eq!(listed[0].public.label, crate::brand::ASSISTANT_NAME);
        assert_eq!(listed[0].raw_id, "assistant");
        assert!(listed[0].tabs.is_empty());
        assert_eq!(listed[0].public.pending_reviews, None);
        assert_eq!(serde_json::to_value(&listed[0].public).unwrap()["kind"], "assistant");

        // Chats: A is good, the rest are each wrong in one way.
        let dir = assistant_state(Some(on.clone()), vec![]);
        let state = dir.path();
        let (a, b) = (work(state).join(CHAT_A), work(state).join(CHAT_B));
        fs::create_dir_all(&a).expect("chat a");
        fs::create_dir_all(&b).expect("chat b");
        let outside = state.join("elsewhere");
        fs::create_dir_all(&outside).expect("outside");
        let mut local = chat_tab(CHAT_A, &a, serde_json::json!({ "cli": "opencode_local", "model": "qwen3:8b" }), "ccccccccc1");
        local["cmd"] = "opencode".into();
        let mut shell = chat_tab(CHAT_A, &a, valid.clone(), "ccccccccc2");
        shell["kind"] = "shell".into();
        let mut local_launch = chat_tab(CHAT_A, &a, valid.clone(), "ccccccccc3");
        local_launch["localLaunch"] = serde_json::json!({ "driver": "claude", "model": "m", "args": [] });
        let mut sign_in = chat_tab(CHAT_A, &a, valid.clone(), "ccccccccc4");
        sign_in["signIn"] = true.into();
        let mut wrong_bin = chat_tab(CHAT_A, &a, valid.clone(), "ccccccccc5");
        wrong_bin["cmd"] = "codex".into();
        let mut no_block = chat_tab(CHAT_A, &a, valid.clone(), "ccccccccc6");
        no_block.as_object_mut().unwrap().remove("assistant");
        let tabs = vec![
            chat_tab(CHAT_A, &a, valid.clone(), "bbbbbbbbb1"),
            local,
            shell,
            local_launch,
            sign_in,
            wrong_bin,
            no_block,
            // An unknown key in the block, a bad model, an unoffered cli.
            chat_tab(CHAT_A, &a, serde_json::json!({ "cli": "claude", "args": ["--x"] }), "ddddddddd1"),
            chat_tab(CHAT_A, &a, serde_json::json!({ "cli": "claude", "model": "--evil" }), "ddddddddd2"),
            chat_tab(CHAT_A, &a, serde_json::json!({ "cli": "gemini" }), "ddddddddd3"),
            // Not uuid-shaped, another chat's folder, a folder elsewhere, a project folder.
            chat_tab("not-a-uuid", &a, valid.clone(), "eeeeeeeee1"),
            chat_tab(CHAT_A, &b, valid.clone(), "eeeeeeeee2"),
            chat_tab(CHAT_A, &outside, valid.clone(), "eeeeeeeee3"),
            chat_tab(CHAT_A, &work(state), valid.clone(), "eeeeeeeee4"),
            // A tmux name of another scope.
            {
                let mut other = chat_tab(CHAT_B, &b, valid.clone(), "fffffffff1");
                other["tmuxSession"] = format!("{}p1--agent-fffffffff1", crate::brand::TMUX_PREFIX).into();
                other
            },
            chat_tab(CHAT_B, &b, valid, "bbbbbbbbb2"),
        ];
        fs::write(
            state.join("sessions").join("assistant").join("terminals.json"),
            serde_json::json!({ "tabLayout": tabs }).to_string(),
        )
        .expect("session");
        let listed = load_assistant(state);
        assert_eq!(listed.len(), 1);
        let kept: Vec<_> = listed[0].tabs.iter().map(|t| (t.session_id.as_deref().unwrap(), t.cmd.as_str(), t.local_model)).collect();
        assert_eq!(kept, [(CHAT_A, "claude", false), (CHAT_A, "opencode", true), (CHAT_B, "claude", false)]);
        assert!(listed[0].tabs.iter().all(|t| t.public.kind == "agent"));
        // Each chat names its launch by the id `launch-options` lists for it.
        use crate::services::assistant::AssistantCli;
        let launches: Vec<_> = listed[0].tabs.iter().map(|t| t.public.assistant_launch.clone()).collect();
        assert_eq!(
            launches,
            [
                Some(super::super::assistant::launch_handle(&[7; 32], AssistantCli::Claude, None)),
                Some(super::super::assistant::launch_handle(&[7; 32], AssistantCli::OpenCodeLocal, Some("qwen3:8b"))),
                Some(super::super::assistant::launch_handle(&[7; 32], AssistantCli::Claude, None)),
            ]
        );
        assert_eq!(listed[0].root, work(state).canonicalize().unwrap());

        // A symlinked chat folder that points out is not "below" the work folder.
        #[cfg(unix)]
        {
            let link = work(state).join("1d9d8f3e-2c1a-4e7b-9a55-3f6d1c2b7a12");
            std::os::unix::fs::symlink(&outside, &link).expect("link");
            let linked = chat_tab("1d9d8f3e-2c1a-4e7b-9a55-3f6d1c2b7a12", &link, serde_json::json!({ "cli": "claude" }), "ggggggggg1");
            let mut tabs = tabs.clone();
            tabs.push(linked);
            fs::write(state.join("sessions").join("assistant").join("terminals.json"), serde_json::json!({ "tabLayout": tabs }).to_string()).expect("session");
            assert_eq!(load_assistant(state)[0].tabs.len(), 3);
        }
    }

    /// The raw-JSON gate and `Settings::assistant_phone_open` are one rule:
    /// every combination of the flag, Debug mode, the explicit marker and the
    /// Mobile switch, and a value of the wrong type (which fails the typed
    /// parse, so reads as off, and closes this reader too).
    #[test]
    fn the_raw_json_gate_agrees_with_the_typed_settings() {
        let dir = tempfile::tempdir().expect("state dir");
        let agree = |settings: serde_json::Value| {
            fs::write(dir.path().join("settings.json"), settings.to_string()).expect("settings");
            let typed = serde_json::from_value::<crate::schema::Settings>(settings.clone())
                .map(|s| s.assistant_phone_open())
                .unwrap_or(false);
            assert_eq!(assistant_open(dir.path()), typed, "{settings}");
            typed
        };
        let states = [None, Some(true), Some(false)];
        let mut opened = 0;
        for flag in states {
            for debug in states {
                for explicit in states {
                    for access in states {
                        let mut settings = serde_json::Map::new();
                        for (key, value) in [("assistant", flag), ("debug", debug), ("experimental_explicit", explicit)] {
                            if let Some(value) = value {
                                settings.insert(key.into(), value.into());
                            }
                        }
                        let mut host = serde_json::Map::from_iter([("enabled".to_string(), true.into())]);
                        if let Some(access) = access {
                            host.insert("assistant_access".into(), access.into());
                        }
                        settings.insert(crate::brand::MOBILE_HOST_KEY.into(), host.into());
                        opened += usize::from(agree(settings.into()));
                    }
                }
            }
        }
        assert!(opened > 0 && opened < 81);
        // No Mobile block at all.
        assert!(agree(serde_json::json!({ "assistant": true })));
        assert!(!agree(serde_json::json!({})));
        // A profile not yet marked explicit still follows Debug mode.
        assert!(agree(serde_json::json!({ "debug": true })));
        assert!(!agree(serde_json::json!({ "debug": true, "experimental_explicit": true })));
        // Wrong types close both.
        for bad in [
            serde_json::json!({ "assistant": "yes" }),
            serde_json::json!({ "assistant": true, "debug": 1 }),
            serde_json::json!({ "assistant": true, crate::brand::MOBILE_HOST_KEY: { "assistant_access": "no" } }),
        ] {
            assert!(!agree(bad));
        }
        // Missing and unreadable files refuse.
        fs::remove_file(dir.path().join("settings.json")).expect("remove");
        assert!(!assistant_open(dir.path()));
    }

    /// A phone-made prompt or schedule is checked against the same gate
    /// (`phone_origin`): the assistant scope reaches every paired phone while
    /// open, none once either switch is off, and is unknown (`Err`) while the
    /// settings file cannot be read. Spellings of its id never reach a project.
    #[test]
    fn scope_access_follows_the_assistant_gate() {
        let dir = assistant_state(Some(serde_json::json!({ "assistant": true })), vec![]);
        let env = RootEnv { dir: dir.path().join("root"), fenced: || true };
        let access = ScopeAccess::load_with(dir.path(), &env).expect("access");
        assert_eq!(access.reaches("assistant", "PHONE"), Ok(true));
        assert_eq!(access.reaches("Assistant", "PHONE"), Ok(false), "only the scope's own spelling is a scope id");
        fs::write(dir.path().join("settings.json"), serde_json::json!({ "assistant": true, crate::brand::MOBILE_HOST_KEY: { "assistant_access": false } }).to_string()).expect("off");
        let access = ScopeAccess::load_with(dir.path(), &env).expect("access");
        assert_eq!(access.reaches("assistant", "PHONE"), Ok(false));
        fs::write(dir.path().join("settings.json"), b"{").expect("corrupt");
        let access = ScopeAccess::load_with(dir.path(), &env).expect("access");
        assert!(access.reaches("assistant", "PHONE").is_err());
        assert!(is_assistant_scope_id("assistant") && is_assistant_scope_id(" Assistant ") && !is_assistant_scope_id("assistants"));
        assert!(valid_opaque_control_domain("assistant"));
    }

    /// An open chat terminal is granted by the catalog while the gate is open
    /// and loses the grant at the next load once either switch goes off —
    /// which is what `pty_bridge`'s five-second re-check closes it on
    /// (`recheck`: a catalog that no longer lists the tab is `access_revoked`).
    #[test]
    fn an_open_chat_loses_its_grant_when_the_gate_closes() {
        let tmux = format!("{}assistant--agent-bbbbbbbbb1", crate::brand::TMUX_PREFIX);
        let dir = assistant_state(Some(serde_json::json!({ "assistant": true })), vec![]);
        let state = dir.path();
        let chat = crate::services::assistant::work_root(state).join(CHAT_A);
        fs::create_dir_all(&chat).expect("chat folder");
        fs::write(
            state.join("sessions").join("assistant").join("terminals.json"),
            serde_json::json!({ "tabLayout": [chat_tab(CHAT_A, &chat, serde_json::json!({ "cli": "claude" }), "bbbbbbbbb1")] }).to_string(),
        )
        .expect("session");
        let live = HashMap::from([(tmux.clone(), LiveTmux { activity: 5, cwd: chat.canonicalize().unwrap() })]);
        let env = RootEnv { dir: state.join("root"), fenced: || true };
        let load = || Catalog::load_with(state, &[7; 32], &env, &live).expect("catalog");
        let open = load();
        let tab_id = open.projects[0].tabs[0].public.id.clone();
        assert!(open.grants(&tab_id, &tmux));
        assert!(open.projects[0].tabs[0].public.available);
        for off in [
            serde_json::json!({ "assistant": false }),
            serde_json::json!({ "assistant": true, crate::brand::MOBILE_HOST_KEY: { "assistant_access": false } }),
        ] {
            fs::write(state.join("settings.json"), off.to_string()).expect("off");
            let closed = load();
            assert!(!closed.grants(&tab_id, &tmux), "{off}");
            assert!(closed.projects.is_empty());
        }
    }

    /// A `projects.json` record that takes the chat assistant's id — or root's
    /// in another spelling — is listed by nobody: the catalog has no such
    /// source (until the assistant's own switch lists it), and the record does
    /// not borrow its session folder.
    #[test]
    fn a_project_record_cannot_borrow_a_reserved_scope() {
        let dir = tempfile::tempdir().expect("state dir");
        let state = dir.path();
        let folder = state.join("folder");
        fs::create_dir_all(&folder).expect("folder");
        let records: Vec<serde_json::Value> = ["assistant", "Assistant", "assistant ", "ASSISTANT", "Root"]
            .iter()
            .map(|id| {
                serde_json::json!({
                    "id": id, "name": "Borrowed", "status": "active",
                    "directory": folder.to_string_lossy(),
                    concat!(crate::app_slug!(), "_mobile_access"): true,
                })
            })
            .chain(std::iter::once(serde_json::json!({
                "id": "p1", "name": "Real", "status": "active",
                "directory": folder.to_string_lossy(),
                concat!(crate::app_slug!(), "_mobile_access"): true,
            })))
            .collect();
        fs::write(state.join("projects.json"), serde_json::to_vec(&records).expect("projects")).expect("write projects");
        let env = RootEnv { dir: folder, fenced: || true };
        let sources = scope_sources(state, &env).expect("sources");
        assert_eq!(sources.iter().map(|s| s.raw_id.as_str()).collect::<Vec<_>>(), ["p1"]);
    }

    /// A tab a headless create stamped reads only sessions begun since its
    /// launch; one started on `--continue`, or never stamped, reads the
    /// folder's newest.
    #[test]
    fn a_fresh_tab_reads_since_its_launch_unless_continued() {
        let saved = |args: Value, launched_at: Option<Value>| {
            serde_json::from_value::<SavedTab>(serde_json::json!({
                "label": "OpenCode", "cmd": "opencode", "cwd": "/p", "kind": "agent",
                "args": args, "launchedAt": launched_at,
            }))
            .expect("saved tab")
        };
        assert_eq!(fresh_since(&saved(serde_json::json!([]), Some(serde_json::json!(1_700_000_000_123_i64)))), Some(1_700_000_000_123));
        assert_eq!(fresh_since(&saved(serde_json::json!(["--continue"]), Some(serde_json::json!(5)))), None);
        for args in [serde_json::json!(["--resume", "latest"]), serde_json::json!(["-r", "latest"]), serde_json::json!(["-c"])] {
            assert_eq!(fresh_since(&saved(args, Some(serde_json::json!(5)))), None);
        }
        assert_eq!(fresh_since(&saved(serde_json::json!([]), None)), None);
        // An odd shape is no stamp, never a file that fails to parse.
        assert_eq!(fresh_since(&saved(serde_json::json!("x"), Some(serde_json::json!("soon")))), None);
    }

    /// The phone learns which agent a tab runs from the registry, not from the
    /// tab's label, so a renamed tab still says "Claude"; an unlisted agent
    /// keeps its label, and the command itself is never what is published.
    #[test]
    fn agent_label_names_the_cli_not_the_tab() {
        let tab = |label: &str, cmd: &str| SavedTab {
            label: label.to_string(),
            cmd: cmd.to_string(),
            cwd: String::new(),
            kind: "agent".to_string(),
            session_id: None,
            resume_args: None,
            tmux_session: None,
            tmux_attach: None,
            location: None,
            ephemeral: false,
            color: None,
            local_launch: None,
            schedule_target_id: None,
            sign_in: false,
            cloud: false,
            args: None,
            launched_at: None,
            assistant: None,
        };
        assert_eq!(agent_label_of(&tab("release review", "claude")), "Claude");
        assert_eq!(agent_label_of(&tab("Codex", "codex")), "Codex");
        assert_eq!(agent_label_of(&tab("My bot", "/opt/bot --x")), "My bot");
        // A local-model tab names its driver's CLI, not `ollama`.
        let mut local = tab("qwen3:8b · Claude Code", "ollama");
        local.local_launch = Some(serde_json::json!({ "driver": "claude" }));
        assert_eq!(agent_label_of(&local), "Claude");
    }

    /// A local-model tab driving OpenCode reads its transcript as `opencode`
    /// (found by folder); the other drivers keep `ollama`, whose Claude or
    /// Codex transcript needs a launch id the tab never has.
    #[test]
    fn a_local_opencode_tab_reads_as_opencode() {
        let local = |driver: &str| {
            serde_json::from_value::<SavedTab>(serde_json::json!({
                "label": "m · OpenCode", "cmd": "ollama", "cwd": "/p", "kind": "local_agent",
                "localLaunch": { "driver": driver, "model": "m", "args": ["launch", driver, "--model", "m"] },
            }))
            .expect("saved tab")
        };
        assert_eq!(transcript_cmd_of(&local("opencode")), "opencode");
        assert_eq!(transcript_cmd_of(&local("claude")), "ollama");
        let mut agent = local("opencode");
        agent.kind = "agent".into();
        assert_eq!(transcript_cmd_of(&agent), "ollama", "only a local-model tab is remapped");
    }

    /// Local-model tabs reach the phone as agent tabs (#31bl): Mistral's by its
    /// resumable session, the other drivers by a `localLaunch` line Tabtivity
    /// builds — never by one it does not, and never without the `agent` token
    /// every agent tab's tmux name carries.
    #[test]
    fn local_model_tabs_are_listed_as_agent_tabs() {
        let dir = tempfile::tempdir().expect("state dir");
        let state = dir.path();
        let root = state.join("p");
        fs::create_dir_all(&root).expect("root dir");
        fs::write(
            state.join("projects.json"),
            serde_json::to_vec(&serde_json::json!([{
                "id": "p-1",
                "name": "P",
                "status": "active",
                "directory": root.to_string_lossy(),
                concat!(crate::app_slug!(), "_mobile_access"): true,
            }]))
            .expect("projects"),
        )
        .expect("write projects");
        let sessions = state.join("sessions").join("p-1");
        fs::create_dir_all(&sessions).expect("session dir");
        let tab = |n: &str, cmd: &str, extra: serde_json::Value| {
            let mut row = serde_json::json!({
                "label": format!("Local {n}"),
                "cmd": cmd,
                "cwd": root.to_string_lossy(),
                "kind": "local_agent",
                "tmuxSession": format!("{SLUG}-p-1--agent-10000000{n}"),
            });
            row.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            row
        };
        let launch = |args: serde_json::Value| {
            serde_json::json!({ "localLaunch": { "driver": "claude", "model": "qwen3:8b", "args": args } })
        };
        // The wrong token.
        let mut wrong_token = tab("5", "vibe", serde_json::json!({ "sessionId": "s5" }));
        wrong_token["tmuxSession"] = serde_json::json!(concat!(crate::app_slug!(), "-p-1--local_agent-100000005"));
        fs::write(
            sessions.join("terminals.json"),
            serde_json::to_vec(&serde_json::json!({
                "tabLayout": [
                    tab("1", "vibe", serde_json::json!({ "sessionId": "s1" })),
                    tab("2", "ollama", launch(serde_json::json!(["launch", "claude", "--model", "qwen3:8b"]))),
                    // Not a line Tabtivity builds.
                    tab("3", "ollama", launch(serde_json::json!(["serve"]))),
                    // Neither resumable nor relaunchable.
                    tab("4", "ollama", serde_json::json!({})),
                    wrong_token,
                ]
            }))
            .expect("session"),
        )
        .expect("write session");

        let catalog = Catalog::load(state, &[7; 32]).expect("catalog");
        let tabs = &catalog.projects.first().expect("project").tabs;
        let listed: Vec<(&str, &str, Option<&str>)> = tabs
            .iter()
            .map(|t| (t.public.label.as_str(), t.public.kind.as_str(), t.public.agent_label.as_deref()))
            .collect();
        assert_eq!(
            listed,
            vec![("Local 1", "agent", Some("Mistral")), ("Local 2", "agent", Some("Claude"))]
        );
        // Flagged as local, so the phone shows the model and offers no list.
        for listed in tabs {
            let row = serde_json::to_value(&listed.public).expect("row");
            assert_eq!(row["local_model"], serde_json::json!(true));
        }
    }

    /// A sign-in tab and a cloud session have no session to resume, yet the
    /// phone that asked for one has to attach: the desktop saves it (flagged
    /// `signIn` / `cloud`) while it runs, and the catalog lists it. Only the
    /// sign-in flag reaches the phone, which opens that tab on its sign-in
    /// sheet. An agent tab with neither stays unlisted.
    #[test]
    fn sign_in_and_cloud_tabs_are_listed_without_a_session() {
        let dir = tempfile::tempdir().expect("state dir");
        let state = dir.path();
        let root = state.join("p");
        fs::create_dir_all(&root).expect("root dir");
        fs::write(
            state.join("projects.json"),
            serde_json::to_vec(&serde_json::json!([{
                "id": "p-1",
                "name": "P",
                "status": "active",
                "directory": root.to_string_lossy(),
                concat!(crate::app_slug!(), "_mobile_access"): true,
            }]))
            .expect("projects"),
        )
        .expect("write projects");
        let sessions = state.join("sessions").join("p-1");
        fs::create_dir_all(&sessions).expect("session dir");
        let tab = |n: &str, marker: serde_json::Value| {
            let mut row = serde_json::json!({
                "label": format!("Tab {n}"),
                "cmd": "claude",
                "cwd": root.to_string_lossy(),
                "kind": "agent",
                "tmuxSession": format!("{SLUG}-p-1--agent-10000000{n}"),
            });
            row.as_object_mut().unwrap().extend(marker.as_object().unwrap().clone());
            row
        };
        fs::write(
            sessions.join("terminals.json"),
            serde_json::to_vec(&serde_json::json!({ "tabLayout": [
                tab("1", serde_json::json!({ "signIn": true })),
                tab("2", serde_json::json!({ "cloud": true })),
                tab("3", serde_json::json!({ "signIn": false })),
            ] }))
            .expect("session"),
        )
        .expect("write session");

        let catalog = Catalog::load(state, &[7; 32]).expect("catalog");
        let tabs = &catalog.projects.first().expect("project").tabs;
        let listed: Vec<(&str, Option<&str>, bool)> = tabs
            .iter()
            .map(|t| (t.public.label.as_str(), t.public.agent_label.as_deref(), t.public.sign_in))
            .collect();
        assert_eq!(listed, vec![("Tab 1", Some("Claude"), true), ("Tab 2", Some("Claude"), false)]);
        let json = serde_json::to_value(&tabs[1].public).expect("public tab");
        assert!(json.get("sign_in").is_none(), "an unset flag is left out");
    }

    /// A mobile-enabled box is a scope of its own (#31aa): listed as `kind:
    /// box` under its own opaque id, with tabs from `sessions/box_<id>/` whose
    /// cwd is the box folder OR a member's phone folder. Its switch is the only
    /// consent consulted — a member's own Mobile bit is not — and every member
    /// contributes its folder (a remote member its mirror), except a VM
    /// without a mirror, which has none; a box with the bit off or no folder
    /// is not listed at all.
    #[test]
    fn a_mobile_enabled_box_is_a_scope_with_the_folder_and_member_roots() {
        let dir = tempfile::tempdir().expect("state dir");
        let state = dir.path();
        allow_shells(state);
        let folder = state.join("boxes").join("paper");
        let member = state.join("lib");
        let remote_mirror = state.join("mirror");
        for d in [&folder, &member, &remote_mirror] {
            fs::create_dir_all(d).expect("dir");
        }
        fs::write(
            state.join("projects.json"),
            serde_json::to_vec(&serde_json::json!([
                // The member has Mobile OFF itself: the box's switch covers it.
                { "id": "p-lib", "name": "Lib", "status": "inactive",
                  "directory": member.to_string_lossy() },
                { "id": "p-remote", "name": "Remote", "status": "active",
                  "directory": state.join("remote-projects").join("p-remote").to_string_lossy(),
                  "remote": { "host": "h" }, "mirror": remote_mirror.to_string_lossy() },
                // A VM project without a mirror has no folder to give.
                { "id": "p-vm", "name": "Vm", "status": "active",
                  "directory": state.join("remote-projects").join("p-vm").to_string_lossy(),
                  "remote": { "host": "h" }, "vm": { "enabled": true } },
            ]))
            .expect("projects"),
        )
        .expect("write projects");
        fs::write(
            state.join("boxes.json"),
            serde_json::to_vec(&serde_json::json!([
                { "id": "b1", "name": "Paper", "member_ids": ["p-lib", "p-remote", "p-vm", "p-gone"],
                  "folder": folder.to_string_lossy(), concat!(crate::app_slug!(), "_mobile_access"): true },
                { "id": "b2", "name": "Off", "folder": folder.to_string_lossy() },
                { "id": "b3", "name": "Unopened", concat!(crate::app_slug!(), "_mobile_access"): true },
            ]))
            .expect("boxes"),
        )
        .expect("write boxes");
        let sessions = state.join("sessions").join("box_b1");
        fs::create_dir_all(&sessions).expect("session dir");
        let tab = |label: &str, cwd: &Path, tmux: &str| {
            serde_json::json!({
                "label": label, "cmd": "bash", "kind": "shell",
                "cwd": cwd.to_string_lossy(), "tmuxSession": tmux,
            })
        };
        fs::write(
            sessions.join("terminals.json"),
            serde_json::to_vec(&serde_json::json!({ "tabLayout": [
                tab("Box shell", &folder, concat!(crate::app_slug!(), "-box_b1--shell-123456789")),
                tab("Lib shell", &member, concat!(crate::app_slug!(), "-box_b1--shell-223456789")),
                tab("Remote shell", &remote_mirror, concat!(crate::app_slug!(), "-box_b1--shell-323456789")),
                tab("Foreign", &folder, concat!(crate::app_slug!(), "-p-lib--shell-423456789")),
            ]}))
            .expect("session"),
        )
        .expect("write session");

        let catalog = Catalog::load(state, &[7; 32]).expect("catalog");
        assert_eq!(catalog.projects.len(), 1, "only the enabled, opened box is listed");
        let b = &catalog.projects[0];
        assert_eq!(b.raw_id, "box:b1");
        assert_eq!(b.public.kind, ScopeKind::Box);
        assert_eq!(b.public.label, "Paper");
        assert_eq!(b.public.status, "active");
        assert_eq!(b.root, folder.canonicalize().unwrap());
        assert_eq!(b.roots.len(), 3, "the folder, the local member and the remote member's mirror: {:?}", b.roots);
        assert!(b.roots.contains(&remote_mirror.canonicalize().unwrap()));
        assert_eq!((b.host, b.folder, b.create), (ProjectHost::Local, true, CreateVerdict::All));
        let labels: Vec<&str> = b.tabs.iter().map(|t| t.public.label.as_str()).collect();
        assert_eq!(labels, vec!["Box shell", "Lib shell", "Remote shell"]);
        assert!(!b.public.id.contains("b1"), "the opaque id must not carry the box id");
    }

    /// One project record per host type, each with Mobile on.
    fn typed_projects(state: &Path) -> Vec<serde_json::Value> {
        let access = crate::brand::MOBILE_ACCESS_KEY;
        let record = |id: &str, extra: serde_json::Value| {
            let mut record = serde_json::json!({
                "id": id, "name": id, "status": "active",
                "directory": state.join("dirs").join(id).to_string_lossy(), access: true,
            });
            for (key, value) in extra.as_object().expect("object") {
                record[key] = value.clone();
            }
            record
        };
        vec![
            record("p-local", serde_json::json!({})),
            record("p-box", serde_json::json!({ "sandbox": { "enabled": true } })),
            record("p-remote", serde_json::json!({ "remote": { "host": "h" } })),
            record(
                "p-moved",
                serde_json::json!({ "remote": { "host": "h" }, "mirror": state.join("moved").to_string_lossy() }),
            ),
            record("p-vm", serde_json::json!({ "remote": { "host": "h" }, "vm": { "enabled": true } })),
            record(
                "p-vm-mirror",
                serde_json::json!({
                    "remote": { "host": "h" }, "vm": { "enabled": true },
                    "mirror": state.join("vm-mirror").to_string_lossy(),
                }),
            ),
        ]
    }

    fn load_all(state: &Path, live: &HashMap<String, LiveTmux>) -> Vec<ResolvedProject> {
        let env = RootEnv { dir: state.join("root"), fenced: || true };
        Catalog::load_with(state, &[7; 32], &env, live).expect("catalog").projects
    }

    fn tab_json(label: &str, kind: &str, cwd: &Path, tmux: &str, extra: serde_json::Value) -> serde_json::Value {
        let mut tab = serde_json::json!({
            "label": label, "cmd": if kind == "shell" { "bash" } else { "claude" }, "kind": kind,
            "cwd": cwd.to_string_lossy(), "tmuxSession": tmux, "signIn": kind == "agent",
        });
        for (key, value) in extra.as_object().expect("object") {
            tab[key] = value.clone();
        }
        tab
    }

    fn write_session(state: &Path, id: &str, tabs: Vec<serde_json::Value>) {
        let sessions = state.join("sessions").join(id);
        fs::create_dir_all(&sessions).expect("session dir");
        fs::write(sessions.join("terminals.json"), serde_json::json!({ "tabLayout": tabs }).to_string())
            .expect("write session");
    }

    /// No project type is special (plan step 1): a local, container, remote
    /// and VM project each opted in are listed, with the folder their type
    /// gives the phone — the entry's `directory` for a local or container
    /// project, the mirror for a remote one (the default under the state dir,
    /// or the entry's `mirror`), a VM's only if it has opted into one — and
    /// the create verdict their type allows.
    #[test]
    fn every_project_type_is_listed_with_its_own_folder() {
        let dir = tempfile::tempdir().expect("state dir");
        let state = dir.path();
        let default_mirror = crate::services::remote_sync::default_mirror_dir_in(state, "p-remote");
        for d in [
            state.join("dirs").join("p-local"),
            state.join("dirs").join("p-box"),
            default_mirror.clone(),
            state.join("moved"),
            state.join("vm-mirror"),
        ] {
            fs::create_dir_all(d).expect("dir");
        }
        fs::write(state.join("projects.json"), serde_json::to_vec(&typed_projects(state)).expect("projects"))
            .expect("write projects");
        let listed = load_all(state, &HashMap::new());
        let row = |id: &str| listed.iter().find(|p| p.raw_id == id).unwrap_or_else(|| panic!("{id} is listed"));
        let canon = |p: &Path| p.canonicalize().expect("canonical");

        let local = row("p-local");
        assert_eq!((local.host, local.folder, local.create), (ProjectHost::Local, true, CreateVerdict::All));
        assert_eq!(local.root, canon(&state.join("dirs").join("p-local")));
        let container = row("p-box");
        assert_eq!((container.host, container.folder, container.create), (ProjectHost::Container, true, CreateVerdict::None));
        assert_eq!(container.root, canon(&state.join("dirs").join("p-box")));
        let remote = row("p-remote");
        assert_eq!((remote.host, remote.folder, remote.create), (ProjectHost::Remote, true, CreateVerdict::Agents));
        assert_eq!(remote.root, canon(&default_mirror), "not the entry's directory");
        let moved = row("p-moved");
        assert_eq!(moved.root, canon(&state.join("moved")), "an explicit mirror wins over the default");
        let vm = row("p-vm");
        assert_eq!((vm.host, vm.folder, vm.create), (ProjectHost::Vm, false, CreateVerdict::None));
        assert!(vm.roots.is_empty() && vm.tabs.is_empty());
        assert!(!vm.root.exists(), "a folder-less project's root names nothing that exists");
        let vm_mirror = row("p-vm-mirror");
        assert_eq!((vm_mirror.host, vm_mirror.folder, vm_mirror.create), (ProjectHost::Vm, true, CreateVerdict::None));
        assert_eq!(vm_mirror.root, canon(&state.join("vm-mirror")));
        assert_eq!(listed.len(), 6);

        // The per-phone check agrees with the catalog, for every type.
        let env = RootEnv { dir: state.join("root"), fenced: || true };
        let access = ScopeAccess::load_with(state, &env).expect("access");
        for id in ["p-local", "p-box", "p-remote", "p-moved", "p-vm", "p-vm-mirror"] {
            assert_eq!(access.reaches(id, "any-phone"), Ok(true), "{id}");
        }
    }

    /// A remote project whose mirror is not there yet (never opened on the
    /// desktop) and a VM project without one are listed, with no tab and no
    /// folder, so the Mobile switch shows on the phone. A local project whose
    /// folder is gone is still dropped.
    #[test]
    fn a_remote_project_without_a_mirror_is_listed_empty() {
        let dir = tempfile::tempdir().expect("state dir");
        let state = dir.path();
        allow_shells(state);
        fs::write(state.join("projects.json"), serde_json::to_vec(&typed_projects(state)).expect("projects"))
            .expect("write projects");
        // Saved tabs exist, but nothing can be checked against a missing root.
        let tmux = concat!(crate::app_slug!(), "-p-remote--agent-123456789");
        write_session(state, "p-remote", vec![tab_json("Agent", "agent", &state.join("dirs").join("p-remote"), tmux, serde_json::json!({}))]);
        let listed = load_all(state, &HashMap::new());
        let mut ids: Vec<&str> = listed.iter().map(|p| p.raw_id.as_str()).collect();
        ids.sort_unstable();
        assert_eq!(ids, ["p-moved", "p-remote", "p-vm", "p-vm-mirror"], "the local and container folders are missing: dropped");
        for p in &listed {
            assert!(!p.folder && !p.has_folder() && p.tabs.is_empty(), "{}", p.raw_id);
            assert_eq!(p.create, CreateVerdict::None, "{}", p.raw_id);
        }
        let remote = listed.iter().find(|p| p.raw_id == "p-remote").unwrap();
        assert_eq!(remote.root, crate::services::remote_sync::default_mirror_dir_in(state, "p-remote"));
    }

    /// A remote project's desktop-made agent is saved with `cwd` = the entry's
    /// state-dir `directory` (the window swaps the mirror in only at spawn):
    /// it is listed, and read as running in the mirror. Any other cwd must lie
    /// below the mirror; one that does not is dropped.
    #[test]
    fn a_remote_tab_saved_with_the_project_directory_is_read_in_the_mirror() {
        let dir = tempfile::tempdir().expect("state dir");
        let state = dir.path();
        allow_shells(state);
        let mirror = crate::services::remote_sync::default_mirror_dir_in(state, "p-remote");
        let directory = state.join("dirs").join("p-remote");
        for d in [&mirror, &directory, &mirror.join("src"), &state.join("elsewhere")] {
            fs::create_dir_all(d).expect("dir");
        }
        let projects = typed_projects(state).into_iter().filter(|p| p["id"] == "p-remote").collect::<Vec<_>>();
        fs::write(state.join("projects.json"), serde_json::to_vec(&projects).expect("projects")).expect("write projects");
        let name = |n: u32| format!("{}-p-remote--agent-{n}23456789", crate::app_slug!());
        write_session(
            state,
            "p-remote",
            vec![
                tab_json("Window made", "agent", &directory, &name(1), serde_json::json!({})),
                tab_json("In the mirror", "agent", &mirror.join("src"), &name(2), serde_json::json!({})),
                tab_json("Elsewhere", "agent", &state.join("elsewhere"), &name(3), serde_json::json!({})),
            ],
        );
        let listed = load_all(state, &HashMap::new());
        let remote = &listed[0];
        let tabs: Vec<(&str, PathBuf)> = remote.tabs.iter().map(|t| (t.public.label.as_str(), PathBuf::from(&t.cwd))).collect();
        assert_eq!(
            tabs,
            [
                ("Window made", remote.root.clone()),
                ("In the mirror", mirror.join("src")),
            ],
        );
    }

    /// A record from before `directory` was persisted names its folder only
    /// through `local_file` (`<dir>/project.json`), as the window's
    /// `resolveProjectDirectory` reads it: a remote project's window-made agent
    /// (saved with that folder as its `cwd`) is still read in the mirror, and a
    /// local one's root is that folder. A `local_file` that is not a
    /// `project.json` gives nothing.
    #[test]
    fn a_legacy_record_without_a_directory_key_still_names_its_folder() {
        let dir = tempfile::tempdir().expect("state dir");
        let state = dir.path();
        allow_shells(state);
        let mirror = crate::services::remote_sync::default_mirror_dir_in(state, "p-remote");
        let remote_dir = state.join("dirs").join("p-remote");
        let local_dir = state.join("dirs").join("p-local");
        for d in [&mirror, &remote_dir, &local_dir] {
            fs::create_dir_all(d).expect("dir");
        }
        let legacy = |id: &str, folder: &Path, extra: serde_json::Value| {
            let mut row = serde_json::json!({
                "id": id, "name": id, "status": "active",
                "local_file": folder.join("project.json").to_string_lossy(),
                crate::brand::MOBILE_ACCESS_KEY: true,
            });
            row.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            row
        };
        let projects = [
            legacy("p-remote", &remote_dir, serde_json::json!({ "remote": { "host": "h.invalid" } })),
            legacy("p-local", &local_dir, serde_json::json!({})),
        ];
        fs::write(state.join("projects.json"), serde_json::to_vec(&projects).expect("projects")).expect("write projects");
        write_session(
            state,
            "p-remote",
            vec![tab_json("Window made", "agent", &remote_dir, &format!("{}-p-remote--agent-123456789", crate::app_slug!()), serde_json::json!({}))],
        );
        let listed = load_all(state, &HashMap::new());
        let by_id = |id: &str| listed.iter().find(|p| p.raw_id == id).unwrap_or_else(|| panic!("{id} not listed"));
        let canon = |p: &Path| p.canonicalize().expect("canonical");
        let remote = by_id("p-remote");
        let cwds: Vec<PathBuf> = remote.tabs.iter().map(|t| PathBuf::from(&t.cwd)).collect();
        assert_eq!(cwds.len(), 1);
        assert_eq!(cwds[0], remote.root);
        assert_eq!(remote.root, canon(&mirror));
        assert_eq!(by_id("p-local").root, canon(&local_dir));
        // Only a `project.json` names a folder; a bare file name has no parent to give.
        let record = |local_file: &str| -> ProjectRecord {
            serde_json::from_value(serde_json::json!({ "id": "p", "name": "P", "status": "active", "local_file": local_file })).unwrap()
        };
        assert_eq!(record("/a/b/project.json").directory(), Some(PathBuf::from("/a/b")));
        for odd in ["/a/b/notes.json", "project.json", "/project.json", ""] {
            assert_eq!(record(odd).directory(), None, "{odd}");
        }
    }

    /// On a remote or VM project the catalog lists only the tabs the window
    /// runs locally: a location-less shell is remote, a `host:w1` or `remote`
    /// agent is on a host, a location-less agent is local. A container project
    /// drops what runs in the container — every agent, and a shell while the
    /// spec's scope is `all` — and lists a scope-`agents` spec's shells.
    #[test]
    fn only_tabs_with_a_local_session_are_listed_on_remote_vm_and_container_projects() {
        let dir = tempfile::tempdir().expect("state dir");
        let state = dir.path();
        allow_shells(state);
        let mut projects = typed_projects(state);
        projects.push(serde_json::json!({
            "id": "p-agents", "name": "p-agents", "status": "active",
            "directory": state.join("dirs").join("p-agents").to_string_lossy(),
            crate::brand::MOBILE_ACCESS_KEY: true,
            "sandbox": { "enabled": true, "scope": "agents" },
        }));
        fs::write(state.join("projects.json"), serde_json::to_vec(&projects).expect("projects")).expect("write projects");
        let dirs = state.join("dirs");
        let roots = [
            ("p-local", dirs.join("p-local")),
            ("p-box", dirs.join("p-box")),
            ("p-agents", dirs.join("p-agents")),
            ("p-vm-mirror", state.join("vm-mirror")),
            ("p-remote", crate::services::remote_sync::default_mirror_dir_in(state, "p-remote")),
        ];
        for (id, root) in &roots {
            fs::create_dir_all(root).expect("root");
            let n = |kind: &str, i: u32| format!("{}-{id}--{kind}-{i}23456789", crate::app_slug!());
            let tabs = vec![
                tab_json("agent", "agent", root, &n("agent", 1), serde_json::json!({})),
                tab_json("agent remote", "agent", root, &n("agent", 2), serde_json::json!({ "location": "remote" })),
                tab_json("agent w1", "agent", root, &n("agent", 3), serde_json::json!({ "location": "host:w1" })),
                tab_json("shell", "shell", root, &n("shell", 4), serde_json::json!({})),
                tab_json("shell local", "shell", root, &n("shell", 5), serde_json::json!({ "location": "local" })),
            ];
            write_session(state, id, tabs);
        }
        let listed = load_all(state, &HashMap::new());
        let labels = |id: &str| -> Vec<String> {
            listed.iter().find(|p| p.raw_id == id).unwrap_or_else(|| panic!("{id}")).tabs.iter().map(|t| t.public.label.clone()).collect()
        };
        assert_eq!(labels("p-local"), ["agent", "agent remote", "agent w1", "shell", "shell local"], "a local project is unfiltered");
        assert_eq!(labels("p-remote"), ["agent", "shell local"]);
        assert!(labels("p-vm-mirror").is_empty(), "a VM project is pinned to the VM");
        assert!(labels("p-box").is_empty(), "scope all: agents and shells run in the container");
        assert_eq!(labels("p-agents"), ["shell", "shell local"], "scope agents leaves the shells on the host");
    }

    /// The tab-locality rule is the window's `effectiveTabLocation`, pinned
    /// to it by one table both sides read
    /// (`src/__tests__/mobile/tabLocality.fixture.json`).
    #[test]
    fn the_tab_locality_rule_matches_the_windows_table() {
        let table: Vec<serde_json::Value> = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../src/__tests__/mobile/tabLocality.fixture.json"
        )))
        .expect("fixture");
        assert!(table.len() > 10);
        for row in table {
            let (kind, location, vm) = (row["kind"].as_str().unwrap(), row["location"].as_str(), row["vm"].as_bool().unwrap());
            assert_eq!(tab_is_local(kind, location, vm), row["local"].as_bool().unwrap(), "{row}");
        }
    }

    /// The project-type table the window's `projectTabHost` reads too
    /// (`src/__tests__/mobile/projectHostReach.fixture.json`): the host word,
    /// whether a tab of a kind and location runs on this machine, and the
    /// create verdict of a project with a folder.
    #[test]
    fn the_project_host_table_matches_the_windows() {
        let table: Vec<serde_json::Value> = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../src/__tests__/mobile/projectHostReach.fixture.json"
        )))
        .expect("fixture");
        assert!(table.len() > 50);
        for row in table {
            let mut record = serde_json::json!({ "id": "p", "name": "P", "status": "active" });
            for (key, value) in row["record"].as_object().expect("record") {
                record[key] = value.clone();
            }
            let project: ProjectRecord = serde_json::from_value(record).expect("record");
            let host = project_host(&project);
            assert_eq!(serde_json::to_value(host).unwrap(), row["host"], "{row}");
            let reach = runs_on_this_machine(host, container_shells(&project), row["kind"].as_str().unwrap(), row["location"].as_str());
            assert_eq!(reach, row["reach"].as_bool().unwrap(), "{row}");
            assert_eq!(serde_json::to_value(create_verdict(host, true)).unwrap(), row["create"], "{row}");
        }
    }

    /// The `mirror` key is read leniently: a string is the folder, anything
    /// else is none, and a record with an odd one still parses.
    #[test]
    fn the_mirror_key_is_read_leniently() {
        let project = |value: &str| -> ProjectRecord {
            serde_json::from_str(&format!(r#"{{"id":"p","name":"P","status":"active","mirror":{value}}}"#)).unwrap()
        };
        assert_eq!(project(r#""/m""#).mirror.as_deref(), Some("/m"));
        for odd in ["7", "null", "[]", r#"{"a":1}"#, "true"] {
            assert_eq!(project(odd).mirror, None, "{odd}");
        }
        let absent: ProjectRecord = serde_json::from_str(r#"{"id":"p","name":"P","status":"active"}"#).unwrap();
        assert_eq!(absent.mirror, None);
        // A blank mirror is no mirror: the default stands in.
        let blank = project(r#""  ""#);
        let state = Path::new("state");
        assert_eq!(mobile_root(state, &blank), None, "a local record keeps its directory rule");
        let remote = ProjectRecord { remote: Some(serde_json::json!({ "host": "h" })), ..blank };
        assert_eq!(mobile_root(state, &remote), Some(crate::services::remote_sync::default_mirror_dir_in(state, "p")));
    }

    /// The per-phone list, end to end through a load: absent reaches every
    /// phone, a list only its ids, an empty or malformed one none — and a
    /// malformed value costs that scope alone, never the rest of the file. A
    /// list on a scope whose switch is off opens nothing.
    #[test]
    fn a_scope_with_a_device_list_reaches_only_those_phones() {
        let dir = tempfile::tempdir().expect("state dir");
        let state = dir.path();
        let devices = crate::brand::MOBILE_DEVICES_KEY;
        let access = crate::brand::MOBILE_ACCESS_KEY;
        let folder = state.join("boxes").join("paper");
        fs::create_dir_all(&folder).expect("box folder");
        let mut projects = Vec::new();
        for id in ["p-all", "p-one", "p-empty", "p-bad", "p-off"] {
            let root = state.join(id);
            fs::create_dir_all(&root).expect("root");
            let mut record = serde_json::json!({
                "id": id, "name": id, "status": "active",
                "directory": root.to_string_lossy(), access: id != "p-off",
            });
            match id {
                "p-one" | "p-off" => record[devices] = serde_json::json!(["d1"]),
                "p-empty" => record[devices] = serde_json::json!([]),
                "p-bad" => record[devices] = serde_json::json!("d1"),
                _ => {}
            }
            projects.push(record);
        }
        fs::write(state.join("projects.json"), serde_json::to_vec(&projects).expect("projects"))
            .expect("write projects");
        fs::write(
            state.join("boxes.json"),
            serde_json::to_vec(&serde_json::json!([
                { "id": "b-all", "name": "All", "folder": folder.to_string_lossy(), access: true },
                { "id": "b-two", "name": "Two", "folder": folder.to_string_lossy(), access: true,
                  devices: ["d2"] },
                { "id": "b-bad", "name": "Bad", "folder": folder.to_string_lossy(), access: true,
                  devices: [1] },
            ]))
            .expect("boxes"),
        )
        .expect("write boxes");

        let catalog = Catalog::load(state, &[7; 32]).expect("a malformed list must not fail the load");
        let ids = |catalog: &Catalog| {
            let mut ids: Vec<String> = catalog.projects.iter().map(|p| p.raw_id.clone()).collect();
            ids.sort();
            ids
        };
        assert_eq!(
            ids(&catalog),
            ["box:b-all", "box:b-bad", "box:b-two", "p-all", "p-bad", "p-empty", "p-one"],
            "the unfiltered snapshot lists every opted-in scope"
        );
        assert_eq!(ids(&catalog.clone().for_device("d1")), ["box:b-all", "p-all", "p-one"]);
        assert_eq!(ids(&catalog.clone().for_device("d2")), ["box:b-all", "box:b-two", "p-all"]);
        assert_eq!(ids(&catalog.clone().for_device("d3")), ["box:b-all", "p-all"]);
        // A filtered-out scope answers like an unknown one.
        let one = catalog.projects.iter().find(|p| p.raw_id == "p-one").expect("p-one").public.id.clone();
        assert!(catalog.clone().for_device("d1").project(&one).is_some());
        assert!(catalog.for_device("d2").project(&one).is_none());
    }

    #[test]
    fn no_tmux_server_is_an_answer_and_any_other_failure_is_not() {
        // tmux's ways of saying "no server", i.e. zero sessions.
        for stderr in [
            "no server running on /tmp/tmux-1000/default",
            "error connecting to /tmp/tmux-1000/default (No such file or directory)",
            "error connecting to /tmp/tmux-1000/default (Connection refused)",
            "failed to connect to server: Connection refused",
        ] {
            let live = live_from_ls(false, b"", stderr.as_bytes());
            assert!(live.is_ok_and(|live| live.is_empty()), "{stderr}");
        }
        // tmux not answering: never "zero sessions".
        for stderr in [
            "error connecting to /tmp/tmux-1000/default (Permission denied)",
            "error connecting to /tmp/tmux-1000/default (Resource temporarily unavailable)",
            "server exited unexpectedly",
            "lost server",
            "",
        ] {
            assert!(live_from_ls(false, b"", stderr.as_bytes()).is_err(), "{stderr:?}");
        }
        // An answer: its rows, and a malformed one costs only itself.
        let live = live_from_ls(
            true,
            concat!(crate::app_slug!(), "-p--shell-1\t1700000000\t/home/u/p\nbroken row\nwork\t5\t/tmp\n").as_bytes(),
            b"",
        )
        .expect("listing");
        assert_eq!(live.len(), 2);
        assert_eq!(live[concat!(crate::app_slug!(), "-p--shell-1")].activity, 1_700_000_000);
        assert_eq!(live["work"].cwd, PathBuf::from("/tmp"));
        assert!(live_from_ls(true, b"", b"").expect("empty listing").is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn a_command_that_hangs_is_killed_at_its_deadline() {
        let mut hung = Command::new("sleep");
        hung.arg("30");
        let started = Instant::now();
        let error = output_within(hung, Duration::from_millis(150)).expect_err("deadline");
        assert_eq!(error.kind(), std::io::ErrorKind::TimedOut);
        assert!(started.elapsed() < Duration::from_secs(10), "returned at the deadline, not the child's exit");

        // One that answers in time is read whole, both pipes and its status.
        let mut quick = Command::new("sh");
        quick.args(["-c", "printf out; printf err >&2; exit 3"]);
        let out = output_within(quick, Duration::from_secs(10)).expect("output");
        assert_eq!(out.status.code(), Some(3));
        assert_eq!(out.stdout, b"out");
        assert_eq!(out.stderr, b"err");

        let missing = Command::new("no-such-binary-for-this-test");
        let error = output_within(missing, Duration::from_secs(1)).expect_err("spawn");
        assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
    }

    #[test]
    fn shell_tabs_are_off_the_phone_unless_switched_on() {
        let dir = tempfile::tempdir().expect("state dir");
        let state = dir.path();
        let (live, _) = live_tab_fixture(state);
        let kinds = |state: &Path| {
            Catalog::load_with(state, &[7; 32], &RootEnv { dir: state.join("root"), fenced: || true }, &live)
                .expect("catalog")
                .projects
                .iter()
                .flat_map(|p| p.tabs.iter().map(|t| t.public.kind.clone()))
                .collect::<Vec<_>>()
        };
        assert_eq!(kinds(state), vec!["shell"]);
        for settings in [
            serde_json::json!({ crate::brand::MOBILE_HOST_KEY: { "enabled": true } }),
            serde_json::json!({ crate::brand::MOBILE_HOST_KEY: { "enabled": true, "shell_tabs": false } }),
        ] {
            fs::write(state.join("settings.json"), settings.to_string()).expect("settings");
            assert!(kinds(state).is_empty(), "{settings}");
        }
        fs::write(state.join("settings.json"), b"{").expect("corrupt settings");
        assert!(kinds(state).is_empty(), "unreadable settings refuse");
        fs::remove_file(state.join("settings.json")).expect("remove");
        assert!(kinds(state).is_empty(), "no settings is the default");
    }

    /// Shell tabs are off the phone by default; the fixtures that list them
    /// switch them on.
    fn allow_shells(state: &Path) {
        fs::write(
            state.join("settings.json"),
            serde_json::json!({ crate::brand::MOBILE_HOST_KEY: { "enabled": true, "shell_tabs": true } }).to_string(),
        )
        .expect("settings");
    }

    /// One project with one shell tab, and the tmux row that makes it live.
    fn live_tab_fixture(state: &Path) -> (HashMap<String, LiveTmux>, impl Fn(bool) + '_) {
        const TMUX: &str = concat!(crate::app_slug!(), "-p-1--shell-123456789");
        allow_shells(state);
        let root = state.join("p");
        fs::create_dir_all(&root).expect("root dir");
        let sessions = state.join("sessions").join("p-1");
        fs::create_dir_all(&sessions).expect("session dir");
        fs::write(
            sessions.join("terminals.json"),
            serde_json::to_vec(&serde_json::json!({ "tabLayout": [{
                "label": "Shell",
                "cmd": "bash",
                "cwd": root.to_string_lossy(),
                "kind": "shell",
                "tmuxSession": TMUX,
            }] }))
            .expect("session"),
        )
        .expect("write session");
        let live = HashMap::from([(TMUX.to_string(), LiveTmux { activity: 7, cwd: root.clone() })]);
        let write_project = move |access: bool| {
            fs::write(
                state.join("projects.json"),
                serde_json::to_vec(&serde_json::json!([{
                    "id": "p-1",
                    "name": "P",
                    "status": "active",
                    "directory": root.to_string_lossy(),
                    crate::brand::MOBILE_ACCESS_KEY: access,
                }]))
                .expect("projects"),
            )
            .expect("write projects");
        };
        write_project(true);
        (live, write_project)
    }

    #[test]
    fn a_tmux_that_cannot_be_asked_changes_no_tabs_availability() {
        let dir = tempfile::tempdir().expect("state dir");
        let state = dir.path();
        let (live, write_project) = live_tab_fixture(state);
        const TMUX: &str = concat!(crate::app_slug!(), "-p-1--shell-123456789");
        let key = [7u8; 32];
        let mut cache = CatalogCache::default();
        let available = |catalog: &Catalog| catalog.projects[0].tabs[0].public.available;

        let first = cache
            .load_fresh_with(state, &key, || Ok(live.clone()))
            .expect("tmux answered");
        assert!(available(&first));
        let tab_id = first.projects[0].tabs[0].public.id.clone();
        assert!(first.grants(&tab_id, TMUX));
        assert!(!first.grants(&tab_id, concat!(crate::app_slug!(), "-p-1--shell-other6789")), "another session");
        assert!(!first.grants("no-such-tab", TMUX));

        // The fork failed, or the server hung: the tab is still what tmux last
        // said it was — and an open terminal on it is still granted.
        let next = cache
            .load_fresh_with(state, &key, || Err("tmux ls: timed out".into()))
            .expect("carried forward");
        assert!(available(&next));
        assert!(next.grants(&tab_id, TMUX));

        // Inside the retry window tmux is not asked again at all…
        let again = cache
            .load_fresh_with(state, &key, || panic!("asked a tmux that just failed"))
            .expect("carried forward");
        assert!(available(&again));
        // …but the files are still read: switching phone access off revokes
        // on time, wedged tmux or not.
        write_project(false);
        let revoked = cache
            .load_fresh_with(state, &key, || panic!("asked a tmux that just failed"))
            .expect("load");
        assert!(revoked.projects.is_empty());
        assert!(!revoked.grants(&tab_id, TMUX));
        write_project(true);

        // Once it may be asked again, its answer stands — including "no
        // sessions", which is an answer.
        cache.tmux_failed_at = None;
        let gone = cache
            .load_fresh_with(state, &key, || Ok(HashMap::new()))
            .expect("tmux answered");
        assert!(!available(&gone));
        assert!(!gone.grants(&tab_id, TMUX));
    }

    #[test]
    fn with_no_tmux_answer_yet_the_load_fails_rather_than_listing_every_session_as_gone() {
        let dir = tempfile::tempdir().expect("state dir");
        let state = dir.path();
        let (live, _write_project) = live_tab_fixture(state);
        let mut cache = CatalogCache::default();
        assert!(cache
            .load_fresh_with(state, &[7; 32], || Err("tmux ls: timed out".into()))
            .is_err());
        // The failure is not pinned past the retry window.
        cache.tmux_failed_at = None;
        let catalog = cache
            .load_fresh_with(state, &[7; 32], || Ok(live))
            .expect("tmux answered");
        assert!(catalog.projects[0].tabs[0].public.available);
    }

    #[test]
    fn cache_retains_last_valid_snapshot_during_partial_write() {
        let dir = tempfile::tempdir().expect("state dir");
        fs::write(dir.path().join("projects.json"), b"[]").expect("projects");
        let mut cache = CatalogCache::default();
        assert!(cache.load(dir.path(), &[7; 32]).is_ok());
        fs::write(dir.path().join("projects.json"), b"[").expect("partial projects");
        assert!(cache.load_fresh(dir.path(), &[7; 32]).is_ok());
    }

    #[test]
    fn repeat_loads_inside_the_ttl_do_not_touch_the_disk() {
        let dir = tempfile::tempdir().expect("state dir");
        fs::write(dir.path().join("projects.json"), b"[]").expect("projects");
        let mut cache = CatalogCache::default();
        cache.load(dir.path(), &[7; 32]).expect("first load");
        // Removing the file would fail an uncached load; the TTL must absorb it.
        fs::remove_file(dir.path().join("projects.json")).expect("remove");
        assert!(cache.load(dir.path(), &[7; 32]).is_ok());
        assert!(cache.load_fresh(dir.path(), &[7; 32]).is_ok());
    }
}
