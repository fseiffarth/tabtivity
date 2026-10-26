use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, Instant},
};

use app_core::sync::LockExt;
use base64ct::{Base64UrlUnpadded, Encoding};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::Sha256;

use super::host_live::{HostLive, HostSsh, SharedHostLive};
use super::protocol::TAB_COLORS;
use crate::paths::output_within;
use crate::schema::project::{ComputeHost, RemoteSpec};

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
    /// A remote project's worker hosts (`ComputeHost`s), the entry's flattened
    /// `compute_hosts` key. Loose like `remote`: parsed where a host tab is
    /// placed (`ProjectHosts::of`), so an odd shape costs the workers, never
    /// the file.
    #[serde(default)]
    compute_hosts: Option<Value>,
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
    /// The tab runs a vendor cloud session (`SavedTab::cloud`): its CLI
    /// creates or opens the session and may exit at once, leaving only what it
    /// printed (the session's link), so the phone shows that screen rather
    /// than waiting for a local session that never comes.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub cloud: bool,
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
    /// The facts row's ⎇ branch chip can move this agent tab to another
    /// worktree of its project (`TabWorktrees`/`MoveWorktree`), as the desktop
    /// Reader's can: a resumable agent of a project on this machine (not
    /// remote, not a VM) — the window's own test in `agentWorktreeSwitch.ts`.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub worktree_movable: bool,
    /// The tab runs on its project's remote host, and the phone reaches it
    /// through the desktop's ssh master for that host
    /// (`docs/mobile_remote_host_tabs_plan.md`): the phone wears an "on host"
    /// chip and hides what would act on this machine (the inbox, desktop
    /// images, Mark up's Submit, sign-in). Only the flag crosses — never the
    /// host, worker, path or socket.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub on_host: bool,
    /// An `on_host` tab whose host the last round found no master for: the
    /// desktop is not connected to it. Without it, an unavailable `on_host` tab
    /// is one whose session ended on the host. A flag only; nothing raw.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub host_down: bool,
}

/// Where a listed tab's tmux session is: on this machine, or on its remote
/// project's host. Raw; never serialized.
#[derive(Debug, Clone)]
pub enum TabPlace {
    Here,
    /// On `spec`'s host. `control_path` is the desktop's master for it when
    /// the last liveness round found one (`host_live`); `None` is unreachable.
    Host { spec: Box<RemoteSpec>, control_path: Option<PathBuf> },
}

impl TabPlace {
    pub fn on_host(&self) -> bool {
        matches!(self, Self::Host { .. })
    }

    /// The host and master a host tab's attach rides, when one was found.
    pub fn host_ssh(&self) -> Option<HostSsh> {
        match self {
            Self::Host { spec, control_path: Some(path) } => Some(HostSsh { spec: spec.clone(), control_path: path.clone() }),
            _ => None,
        }
    }
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
    /// Where its session is. A host tab's `cwd` is empty and its `cmd` and
    /// `session_id` name nothing on this machine: every reader that would look
    /// them up in local files (transcript, readings, worktrees, git) skips it.
    pub place: TabPlace,
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
    /// local tabs) and the assistant, which has a work folder and no project folder.
    pub folder: bool,
    /// What the phone may create here ([`CreateVerdict`]).
    pub create: CreateVerdict,
    /// A remote (not VM) project's primary host, as its record names it: the
    /// remote side of the 📁 library (`host_files`). Raw; never crosses the
    /// browser API.
    pub primary_host: Option<RemoteSpec>,
    /// The machines a phone-made agent of a remote (not VM) project may start
    /// on instead of the mirror: the primary, then each worker, in the
    /// record's order. Empty unless the project wraps its host tabs in tmux
    /// (`persist_sessions`) and this build lists host tabs — a tab started
    /// anywhere else would never reach the phone's list. Raw; never crosses
    /// the browser API (the phone gets opaque ids).
    pub machines: Vec<HostMachine>,
}

/// One machine of a remote project, as the phone's ＋ offers it
/// ([`ResolvedProject::machines`]).
#[derive(Debug, Clone)]
pub struct HostMachine {
    /// The window's location word for a tab there: `"remote"` for the
    /// primary, `"host:<id>"` for a worker.
    pub location: String,
    pub spec: RemoteSpec,
    /// The record's display name, else the host name.
    pub label: String,
    pub primary: bool,
    /// The machine holds the code: the primary always; a worker that shares
    /// the primary's folder or keeps a synced copy (the window's
    /// `workerRunnable`). A worker with neither has no tree to run in.
    pub runnable: bool,
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
    /// A remote (not VM) project's hosts, from its record: where its host
    /// tabs run.
    hosts: Option<ProjectHosts>,
}

/// A remote project's hosts as its `projects.json` record names them — never
/// `remote::remote_target_for*`, which reads the global state dir.
#[derive(Debug, Clone, Default)]
struct ProjectHosts {
    /// `remote`, the `"remote"` location's host.
    primary: Option<RemoteSpec>,
    /// `compute_hosts`, each a `"host:<id>"` location's.
    workers: Vec<ComputeHost>,
    /// The window wraps a host tab in tmux only while `remote.persist_sessions`
    /// is not `false` (`persistSessionsEnabled`); otherwise no host session
    /// exists for the name the tab was minted.
    persist: bool,
}

impl ProjectHosts {
    fn of(project: &ProjectRecord) -> Option<Self> {
        if project_host(project) != ProjectHost::Remote {
            return None;
        }
        let remote = project.remote.as_ref()?;
        Some(Self {
            primary: crate::services::remote::spec_from_value(remote),
            workers: project
                .compute_hosts
                .as_ref()
                .map(crate::services::remote::compute_hosts_from_value)
                .unwrap_or_default(),
            persist: remote.get("persist_sessions").and_then(Value::as_bool) != Some(false),
        })
    }

    /// The host a tab at `location` runs on: `"remote"` or none (a shell's
    /// default) the primary, `"host:<id>"` that worker. A worker id that no
    /// longer resolves is no host: the session is wherever it last ran, and
    /// that is not guessed.
    /// [`ResolvedProject::machines`] for these hosts.
    fn machines(&self) -> Vec<HostMachine> {
        if !self.persist {
            return Vec::new();
        }
        let label_of = |spec: &RemoteSpec| {
            spec.label.as_deref().map(str::trim).filter(|label| !label.is_empty()).unwrap_or(&spec.host).chars().take(120).collect()
        };
        let primary = self.primary.iter().map(|spec| HostMachine {
            location: "remote".to_string(),
            spec: spec.clone(),
            label: label_of(spec),
            primary: true,
            runnable: true,
        });
        let workers = self.workers.iter().filter(|h| !h.id.is_empty()).map(|h| HostMachine {
            location: format!("host:{}", h.id),
            spec: h.spec.clone(),
            label: label_of(&h.spec),
            primary: false,
            runnable: h.shared_fs || h.sync_code,
        });
        primary.chain(workers).collect()
    }

    fn spec_for(&self, location: Option<&str>) -> Option<&RemoteSpec> {
        match host_location(location)? {
            HostLocation::Primary => self.primary.as_ref(),
            HostLocation::Worker(id) => self.workers.iter().find(|h| h.id == id).map(|h| &h.spec),
        }
    }
}

/// A non-local tab location, by the window's words.
#[derive(Debug, PartialEq, Eq)]
enum HostLocation<'a> {
    Primary,
    Worker(&'a str),
}

/// `location` as a host: absent or `"remote"` the primary, `"host:<id>"` a
/// worker; `"local"` and anything unknown are none.
fn host_location(location: Option<&str>) -> Option<HostLocation<'_>> {
    match location {
        None | Some("remote") => Some(HostLocation::Primary),
        Some(other) => other.strip_prefix("host:").filter(|id| !id.is_empty()).map(HostLocation::Worker),
    }
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
    /// The remote hosts' reachability, written by `host_live`'s refresher
    /// (set once in `host::run_with`). Cloned per load — the load itself never
    /// touches a socket. Absent: no host tab is reachable.
    host_live: Option<SharedHostLive>,
}

impl CatalogCache {
    /// A cache whose loads read the refresher's host snapshot from `live`.
    pub fn with_host_live(live: SharedHostLive) -> Self {
        Self { host_live: Some(live), ..Self::default() }
    }

    /// The literal socket of the desktop's master for `spec`'s host as the
    /// refresher's last round found it; `None` when that host was not probed
    /// or not reached. Never touches a socket.
    pub fn host_control_path(&self, spec: &RemoteSpec) -> Option<PathBuf> {
        self.host_live.as_ref()?.lock_ok().reach(spec).map(|reach| reach.control_path.clone())
    }

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
        let hosts = self
            .host_live
            .as_ref()
            .map(|slot| slot.lock_ok().clone())
            .unwrap_or_default();
        let loaded = self
            .live(ask_tmux)
            .and_then(|live| Catalog::load_with(state_dir, host_key, &RootEnv::live(), &live, &hosts, host_tabs_here()));
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
/// on (unset is on) and `[MOBILE_HOST_KEY].assistant_access` not `false` (unset is on — it
/// holds no right a phone should not reach). Read per catalog load, like
/// [`root_open`], so turning either off unlists the scope and an open chat
/// detaches at `pty_bridge`'s next re-check. Raw JSON, the sidecar's way;
/// [`crate::schema::Settings::assistant_phone_open`] is the same rule on the
/// typed settings and a test holds the two together. The flag is on by
/// default (unset → on). Missing or unreadable settings refuse.
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
    // `experimental_explicit` and `debug` no longer decide (the assistant is on
    // by default), but a wrong-typed value still fails the typed parse, so it
    // still closes this reader.
    let (Some(flag_on), Some(_), Some(_)) = (flag("assistant"), flag("experimental_explicit"), flag("debug")) else {
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
    flag_on.unwrap_or(true) && access != Some(false)
}

/// The assistant scope's per-phone list, `[MOBILE_HOST_KEY].assistant_devices`:
/// absent is every phone (also those paired later), a list only those device
/// ids, and an empty one — or any value that is not a list of strings, or
/// settings that cannot be read now — no phone, as for a project or box
/// ([`crate::schema::projects::mobile_device_list`]). Meaningful only while
/// [`assistant_open`] holds.
pub fn assistant_devices(state_dir: &Path) -> Option<Vec<String>> {
    let Some(settings) = fs::read(state_dir.join("settings.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
    else {
        return Some(Vec::new());
    };
    settings
        .get(crate::brand::MOBILE_HOST_KEY)
        .and_then(|host| host.get("assistant_devices"))
        .map(crate::schema::projects::mobile_device_list)
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
        Self::load_with(state_dir, host_key, &RootEnv::live(), &live_tmux().unwrap_or_default(), &HostLive::default(), host_tabs_here())
    }

    /// `hosts`: the remote hosts' reachability (`host_live`); `host_tabs`:
    /// whether this build lists host tabs at all ([`host_tabs_here`]).
    fn load_with(
        state_dir: &Path,
        host_key: &[u8],
        root: &RootEnv,
        live: &HashMap<String, LiveTmux>,
        hosts: &HostLive,
        host_tabs: bool,
    ) -> Result<Self, String> {
        let sources = scope_sources(state_dir, root)?;
        let shells = shells_open(state_dir);
        let listing = Listing { live, hosts, shells, host_tabs };
        let resolved = sources
            .into_iter()
            .filter_map(|source| resolve_scope(state_dir, host_key, &listing, source))
            .collect();
        Ok(Self { projects: resolved })
    }
}

/// What one catalog load joins the saved tabs against.
struct Listing<'a> {
    /// The live local tmux sessions.
    live: &'a HashMap<String, LiveTmux>,
    /// The remote hosts' reachability.
    hosts: &'a HostLive,
    /// [`shells_open`].
    shells: bool,
    /// [`host_tabs_here`].
    host_tabs: bool,
}

/// Whether this build lists remote-host tabs: where its own tabs reach the
/// phone through tmux (not Windows, which has no ControlMaster either).
fn host_tabs_here() -> bool {
    host_tabs_on(terminals_support())
}

/// [`host_tabs_here`] for a `terminals_support_on` answer, so the Windows
/// answer has a test on every OS.
fn host_tabs_on(terminals: &str) -> bool {
    terminals == TERMINALS_TMUX
}

/// The remote host a saved tab of `source` runs on, when the phone lists it
/// as a host tab: a remote (not VM) project's tab that is not local
/// ([`tab_is_local`]) — an agent that resumes (no sign-in, no cloud session)
/// or, behind `shell_tabs`, a shell — not ephemeral, not attached to a
/// foreign session, carrying the tmux name its scope mints, on a host its
/// record still names, and only while the project persists sessions. The
/// one rule behind the catalog's listing and the refresher's targets
/// ([`host_probe_targets`]), so the two cannot drift.
fn host_of_tab<'a>(source: &'a ScopeSource, tab: &SavedTab, shells: bool, host_tabs: bool) -> Option<&'a RemoteSpec> {
    if !host_tabs || tab_on_this_machine(source, tab) {
        return None;
    }
    let hosts = source.hosts.as_ref().filter(|hosts| hosts.persist)?;
    let location = tab.location.as_ref().and_then(Value::as_str);
    let listed_kind = match tab.kind.as_str() {
        "agent" => resumable(tab) && !tab.sign_in && !tab.cloud,
        "shell" => shells,
        _ => false,
    };
    if !listed_kind || tab.ephemeral || tab.tmux_attach.is_some() || tab_is_local(&tab.kind, location, false) {
        return None;
    }
    let tmux = tab.tmux_session.as_deref()?;
    if !expected_tmux(&source.raw_id, &tab.kind, tmux) || !crate::services::ssh_exec::valid_tmux_session_name(tmux) {
        return None;
    }
    hosts.spec_for(location)
}

/// The catalog's listing rule at the window's table level
/// (`phoneListsTab` in `lib/projectTabHost.ts`, the fixture's `lists`): a tab
/// that runs here, or one on a remote (not VM) project's host. The per-tab
/// facts ([`host_of_tab`]: kind, tmux name, persist flag, a worker that
/// resolves) are the catalog's alone.
#[cfg(test)]
fn phone_lists_tab(host: ProjectHost, shells_in_container: bool, kind: &str, location: Option<&str>) -> bool {
    runs_on_this_machine(host, shells_in_container, kind, location)
        || (host == ProjectHost::Remote && matches!(kind, "agent" | "shell") && host_location(location).is_some())
}

/// One scope's saved tabs (`sessions/<key>/terminals.json`). A file that does
/// not parse is no tabs — see `resolve_scope` for why it never fails more.
fn read_session(state_dir: &Path, raw_id: &str) -> SessionFile {
    let path = state_dir.join("sessions").join(project_key(raw_id)).join("terminals.json");
    fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<SessionFile>(&bytes).ok())
        .unwrap_or(SessionFile { tab_layout: vec![] })
}

/// The hosts `host_live`'s refresher probes: those of Mobile-enabled remote
/// projects with at least one listable host tab, by [`host_of_tab`] — the
/// catalog's own rule. Each host once (by `target_key`). Empty where host
/// tabs are not listed at all, or the projects file cannot be read.
pub fn host_probe_targets(state_dir: &Path) -> Vec<RemoteSpec> {
    if !host_tabs_here() {
        return Vec::new();
    }
    // Only project sources carry hosts; the root and assistant gates are not
    // asked about here.
    let root = RootEnv { dir: PathBuf::new(), fenced: || false };
    let Ok(sources) = scope_sources(state_dir, &root) else {
        return Vec::new();
    };
    let shells = shells_open(state_dir);
    let mut seen = std::collections::HashSet::new();
    let mut targets = Vec::new();
    for source in sources.iter().filter(|source| source.hosts.is_some()) {
        // project-tree-read: ok — the state-dir terminal-session snapshot.
        for tab in read_session(state_dir, &source.raw_id).tab_layout {
            if let Some(spec) = host_of_tab(source, &tab, shells, true) {
                let key = crate::services::ssh_common::target_key(spec.user.as_deref(), &spec.host, spec.port);
                if seen.insert(key) {
                    targets.push(spec.clone());
                }
            }
        }
    }
    targets
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
            hosts: None,
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
            // The switch, and a per-phone list of its own (decision D9, gap
            // 57): no more every-phone-by-default than a project or box.
            devices: assistant_devices(state_dir),
            host: ProjectHost::Local,
            cwd_alias: None,
            shells_in_container: false,
            hosts: None,
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
            hosts: ProjectHosts::of(project),
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
            hosts: None,
        });
    }
    Ok(sources)
}

/// Every local folder a drop box (inbox, outbox) may sit in: each project's
/// phone folder ([`mobile_root`]), each box folder and root's work folder —
/// whatever their Mobile switch says, since an agent fills the outbox with
/// the phone off too. What `drop_sweep` walks; an unreadable registry lists
/// nothing of its own. `root_dir` is `paths::root_work_dir()`.
pub(super) fn drop_box_roots(state_dir: &Path, root_dir: &Path) -> Vec<PathBuf> {
    fn read<T: serde::de::DeserializeOwned>(path: &Path) -> Vec<T> {
        fs::read(path).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default()
    }
    let projects: Vec<ProjectRecord> = read(&state_dir.join("projects.json"));
    let boxes: Vec<BoxRecord> = read(&state_dir.join("boxes.json"));
    let mut roots = vec![root_dir.to_path_buf()];
    roots.extend(
        projects
            .iter()
            .filter(|p| !is_root_scope_id(&p.id) && !is_assistant_scope_id(&p.id) && !crate::storage::is_reserved_scope(&p.id))
            .filter_map(|p| mobile_root(state_dir, p)),
    );
    roots.extend(boxes.iter().filter_map(|b| b.folder.as_deref()).map(PathBuf::from));
    let mut seen = std::collections::HashSet::new();
    roots.retain(|root| seen.insert(root.clone()));
    roots
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
        cloud: false,
        local_model: false,
        turn_started_at: None,
        worktree: None,
        subagent_worktrees: Vec::new(),
        assistant_launch: None,
        worktree_movable: false,
        on_host: false,
        host_down: false,
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
            place: TabPlace::Here,
        }],
        devices,
        host: ProjectHost::Local,
        folder: true,
        create: CreateVerdict::All,
        primary_host: None,
        machines: Vec::new(),
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
/// exceptions are listed with no local tab and `folder: false` (a remote
/// project's host tabs need no folder and are listed all the same): the assistant (until
/// its first chat makes the work folder), and a remote or VM project, whose
/// mirror may not be there yet (or, for a VM, at all) while its Mobile switch
/// must still show on the phone.
fn resolve_scope(
    state_dir: &Path,
    host_key: &[u8],
    listing: &Listing,
    source: ScopeSource,
) -> Option<ResolvedProject> {
    let (live, shells) = (listing.live, listing.shells);
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
    // One scope's session file is that scope's problem, not the catalog's.
    // The desktop writes it atomically, so a file that does not parse is real
    // corruption or a shape this build does not read — and it used to fail
    // the whole load, which the cache then answered from its last valid
    // snapshot on every request, forever: one bad file froze every project
    // the phone could see, with nothing anywhere to say why. Such a scope
    // simply has no attachable tabs until the desktop rewrites the file.
    //
    // No root, no local tab: nothing could be checked against one. A remote
    // project's host tabs need none (their sessions run in the host's
    // `remote_path` whatever cwd was saved), so its file is read regardless.
    let session = if roots.is_empty() && source.hosts.is_none() {
        SessionFile { tab_layout: vec![] }
    } else {
        read_session(state_dir, &source.raw_id)
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
        //
        // A host tab is placed by its record alone ([`host_of_tab`]); its saved
        // cwd says nothing about where it runs and is never read.
        let on_host = host_of_tab(&source, &tab, shells, listing.host_tabs).cloned();
        let cwd = match &source.cwd_alias {
            _ if on_host.is_some() => String::new(),
            Some(alias) if same_dir(Path::new(&tab.cwd), alias) => root.to_string_lossy().into_owned(),
            _ => tab.cwd.clone(),
        };
        if on_host.is_none()
            && (!eligible_kind
                || tab.ephemeral
                || tab.tmux_attach.is_some()
                || !tab_on_this_machine(&source, &tab)
                || !canonical_below_any(Path::new(&cwd), &roots))
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
            .filter(|row| on_host.is_none() && canonical_below_any(&row.cwd, &roots));
        // A host tab is available while the last round found its host's
        // master, and — where that host's tmux was asked — its session.
        let host_reach = on_host.as_ref().and_then(|spec| listing.hosts.reach(spec));
        let available = match &on_host {
            Some(_) => host_reach.is_some_and(|reach| reach.has_session(tmux)),
            None => live_row.is_some(),
        };
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
            available,
            viewer_busy: false,
            last_activity: live_row.map(|r| r.activity),
            color: tab
                .color
                .as_deref()
                .filter(|id| TAB_COLORS.contains(id))
                .map(str::to_string),
            sign_in: agent && tab.sign_in,
            cloud: agent && tab.cloud,
            local_model: local_agent || chat.as_ref().is_some_and(|launch| launch.cli.is_local()),
            worktree: None,
            subagent_worktrees: Vec::new(),
            assistant_launch: chat
                .as_ref()
                .map(|launch| super::assistant::launch_handle(host_key, launch.cli, launch.model.as_deref())),
            worktree_movable: tab.kind == "agent"
                && chat.is_none()
                && resumable(&tab)
                && source.kind == ScopeKind::Project
                && matches!(source.host, ProjectHost::Local | ProjectHost::Container),
            on_host: on_host.is_some(),
            host_down: on_host.is_some() && host_reach.is_none(),
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
            place: match on_host {
                Some(spec) => TabPlace::Host { spec: Box::new(spec), control_path: host_reach.map(|reach| reach.control_path.clone()) },
                None => TabPlace::Here,
            },
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
        machines: source
            .hosts
            .as_ref()
            .filter(|_| listing.host_tabs)
            .map(ProjectHosts::machines)
            .unwrap_or_default(),
        primary_host: source.hosts.and_then(|hosts| hosts.primary),
    })
}

#[cfg(test)]
mod tests;
