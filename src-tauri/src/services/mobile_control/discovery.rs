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
    #[serde(default)]
    remote: Option<Value>,
    #[serde(default)]
    sandbox: Option<Value>,
    #[serde(default)]
    vm: Option<Value>,
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
}

/// [`ResolvedTab::since`] off the saved record: its stamped launch moment,
/// unless it was started on `--continue` (the window's rule in
/// `agentReader.ts`).
fn fresh_since(tab: &SavedTab) -> Option<i64> {
    let continued = tab
        .args
        .as_ref()
        .and_then(Value::as_array)
        .is_some_and(|args| args.iter().any(|arg| arg.as_str() == Some("--continue")));
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
}

#[derive(Debug, Clone, Serialize)]
pub struct PublicProject {
    pub id: String,
    pub label: String,
    pub status: String,
    pub kind: ScopeKind,
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
}

#[derive(Debug, Clone)]
pub struct ResolvedProject {
    pub public: PublicProject,
    /// The desktop's own id for the scope: a project id, or a `box:<id>` scope
    /// id, which the desktop bridge resolves the same way.
    pub raw_id: String,
    /// The scope's home: the project folder, or the box folder. The inbox
    /// lives here.
    pub root: PathBuf,
    /// Every canonical directory a tab of this scope may run in — `root`
    /// first, then (for a box) each local member's root, because a box's
    /// per-member agent tab deliberately starts in that member's tree.
    pub roots: Vec<PathBuf>,
    pub tabs: Vec<ResolvedTab>,
    /// The paired phones this scope is open to: `None` is every phone, a list
    /// only those device ids (none when empty). Never crosses the browser API.
    pub devices: Option<Vec<String>>,
}

impl ResolvedProject {
    /// Whether the phone paired as `device_id` may see this scope at all.
    pub fn reaches(&self, device_id: &str) -> bool {
        self.devices
            .as_ref()
            .is_none_or(|devices| devices.iter().any(|id| id == device_id))
    }
}

/// One scope to resolve, before its session file and tmux rows are read.
struct ScopeSource {
    raw_id: String,
    label: String,
    status: String,
    kind: ScopeKind,
    /// Uncanonicalized; the first entry is the home and must exist, the rest
    /// are best-effort.
    roots: Vec<PathBuf>,
    /// [`ResolvedProject::devices`].
    devices: Option<Vec<String>>,
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
        "agent" | "request" | "task" | "mail" | "calendar" | "event" | "project" | "subtask"
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

/// The built-in agent CLIs whose tabs resume across a relaunch (the frontend's
/// `RESUMABLE_AGENTS`): what the phone may come back to, and — with no
/// window — what it may start (`headless::agents`).
pub(super) const RESUMABLE_BUILTINS: &[&str] = &[
    "claude",
    "codex",
    "qwen",
    "opencode",
    "copilot",
    "cursor-agent",
    "grok",
    "gemini",
    "agy",
    "vibe",
    "droid",
];

fn resumable(tab: &SavedTab) -> bool {
    tab.session_id.is_some()
        && (RESUMABLE_BUILTINS.contains(&tab.cmd.as_str())
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

fn canonical_below_any(path: &Path, roots: &[PathBuf]) -> bool {
    path.canonicalize()
        .ok()
        .is_some_and(|p| roots.iter().any(|root| p.starts_with(root)))
}

/// The trust-tier gate every mobile scope passes: a local project that is
/// neither a container nor a VM. A box
/// applies it to each member before that member's root may host a box tab.
fn mobile_local(project: &ProjectRecord) -> bool {
    project.remote.is_none()
        && !enabled(&project.sandbox)
        && !enabled(&project.vm)
}

/// `tmux ls` through Tabtivity's effective PATH, the one the desktop's own tmux
/// spawns use (`services::tmux_local`). A headless sidecar (launchd/systemd
/// user service) inherits a bare PATH, so a bare `tmux` misses Homebrew's on a
/// Mac, or picks `/usr/bin/tmux` against a server a `~/.local/bin/tmux` started
/// — and tmux refuses a client of another protocol version.
fn tmux_ls_command(format: &str) -> Command {
    let mut command = crate::paths::command_no_window("tmux");
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
    if cfg!(target_os = "windows") {
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
                // scope (docs/mobile_device_scoped_access_plan.md).
                devices: None,
            });
        }
        for project in &projects {
            if !project.app_mobile_access || !mobile_local(project) {
                continue;
            }
            // Root is listed above, by its own switch and gate, and is not a
            // project: this refuses a hand-edited record that would borrow its
            // session directory — and walk past that gate — by taking its id.
            if is_root_scope_id(&project.id) {
                continue;
            }
            let Some(root_raw) = project.directory.as_deref() else {
                continue;
            };
            sources.push(ScopeSource {
                raw_id: project.id.clone(),
                label: project.name.clone(),
                status: project.status.clone(),
                kind: ScopeKind::Project,
                roots: vec![PathBuf::from(root_raw)],
                devices: project.app_mobile_devices.clone(),
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
                // — which run locally, in the folder or a local member's root.
                // A remote/VM/container member contributes no root at all.
                if !mobile_local(member) {
                    continue;
                }
                if let Some(dir) = member.directory.as_deref() {
                    roots.push(PathBuf::from(dir));
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
            });
        }
        let shells = shells_open(state_dir);
        let resolved = sources
            .into_iter()
            .filter_map(|source| resolve_scope(state_dir, host_key, live, shells, source))
            .collect();
        Ok(Self { projects: resolved })
    }

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
    };
    ResolvedProject {
        public: PublicProject {
            id: "p".into(),
            label: "P".into(),
            status: "active".into(),
            kind: ScopeKind::Project,
            live_sessions: 1,
            last_activity: None,
            pending_reviews: None,
            git: None,
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
        }],
        devices,
    }
}

/// Read one scope's saved tabs and join them to the live tmux rows. `None`
/// when the scope's home directory does not resolve — a scope with no home has
/// nowhere for an inbox and nothing a tab could be checked against.
fn resolve_scope(
    state_dir: &Path,
    host_key: &[u8],
    live: &HashMap<String, LiveTmux>,
    shells: bool,
    source: ScopeSource,
) -> Option<ResolvedProject> {
    let mut roots: Vec<PathBuf> = Vec::new();
    for (index, raw) in source.roots.iter().enumerate() {
        match raw.canonicalize() {
            Ok(root) => roots.push(root),
            // The home must exist; a member root that does not simply hosts
            // no box tab, exactly as the fence's root list treats it.
            Err(_) if index == 0 => return None,
            Err(_) => {}
        }
    }
    let root = roots.first()?.clone();
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
        let eligible_kind = (shells && tab.kind == "shell")
            || (agent && (resumable(&tab) || tab.sign_in || tab.cloud))
            || (local_agent
                && tab.local_launch.as_ref().is_some_and(|launch| {
                    crate::services::terminal_service::local_launch_ok(launch, &tab.cmd)
                }));
        if !eligible_kind
            || tab.ephemeral
            || tab.tmux_attach.is_some()
            || !canonical_below_any(Path::new(&tab.cwd), &roots)
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
        };
        tabs.push(ResolvedTab {
            public,
            tmux_name: tmux.to_string(),
            session_id: tab.session_id.clone(),
            schedule_target_id: tab.schedule_target_id.clone(),
            cmd: tab.cmd.clone(),
            cwd: tab.cwd.clone(),
            since: fresh_since(&tab),
        });
    }
    let last_activity = tabs.iter().filter_map(|t| t.public.last_activity).max();
    let public = PublicProject {
        id: key_id(host_key, "project", &[&source.raw_id]),
        label: source.label.chars().take(120).collect(),
        status: source.status,
        kind: source.kind,
        live_sessions: tabs.iter().filter(|t| t.public.available).count(),
        last_activity,
        pending_reviews: (source.kind == ScopeKind::Root)
            .then(|| crate::services::root_mcp_review::pending_count(state_dir)),
        git: None,
    };
    Some(ResolvedProject {
        public,
        raw_id: source.raw_id,
        root,
        roots,
        tabs,
        devices: source.devices,
    })
}

#[cfg(test)]
mod tests {
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
        ] {
            assert!(valid_opaque_control_domain(domain), "{domain}");
        }
        assert!(!valid_opaque_control_domain("filesystem_path"));
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
            ephemeral: false,
            color: None,
            local_launch: None,
            schedule_target_id: None,
            sign_in: false,
            cloud: false,
            args: None,
            launched_at: None,
        };
        assert_eq!(agent_label_of(&tab("release review", "claude")), "Claude");
        assert_eq!(agent_label_of(&tab("Codex", "codex")), "Codex");
        assert_eq!(agent_label_of(&tab("My bot", "/opt/bot --x")), "My bot");
        // A local-model tab names its driver's CLI, not `ollama`.
        let mut local = tab("qwen3:8b · Claude Code", "ollama");
        local.local_launch = Some(serde_json::json!({ "driver": "claude" }));
        assert_eq!(agent_label_of(&local), "Claude");
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
    /// cwd is the box folder OR a local member's root. Its switch is the only
    /// consent consulted — a member's own Mobile bit is not — while a member
    /// outside the trust tiers contributes no root, and a box with the bit
    /// off or no folder is not listed at all.
    #[test]
    fn a_mobile_enabled_box_is_a_scope_with_the_folder_and_local_member_roots() {
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
                  "directory": remote_mirror.to_string_lossy(),
                  "remote": { "host": "h" } },
            ]))
            .expect("projects"),
        )
        .expect("write projects");
        fs::write(
            state.join("boxes.json"),
            serde_json::to_vec(&serde_json::json!([
                { "id": "b1", "name": "Paper", "member_ids": ["p-lib", "p-remote", "p-gone"],
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
        assert_eq!(b.roots.len(), 2, "the folder and the one local member: {:?}", b.roots);
        let labels: Vec<&str> = b.tabs.iter().map(|t| t.public.label.as_str()).collect();
        assert_eq!(labels, vec!["Box shell", "Lib shell"]);
        assert!(!b.public.id.contains("b1"), "the opaque id must not carry the box id");
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
