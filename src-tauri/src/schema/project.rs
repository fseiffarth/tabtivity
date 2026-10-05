use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Per-extension file count and byte total inside `file_type_stats`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileTypeStat {
    pub count: i64,
    pub bytes: i64,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

/// One item in `time["recent_sessions"]`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecentSession {
    /// "YYYY-MM-DD"
    pub date: String,
    /// "YYYY-MM-DD HH:MM"
    pub start: String,
    pub duration_s: f64,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

/// `project.json["time"]` block.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimeInfo {
    pub total_s: f64,
    pub recent_sessions: Vec<RecentSession>,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

/// One entry in `project.json["open_apps"]`.
/// Fields are optional because the model evolved; older records may omit mode/pid.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenApp {
    pub exec: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    /// "standalone" | "embedded" — how the app was opened
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opened_at: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<i64>,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

/// One entry in `project.json["tab_layout"]`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TabEntry {
    /// The window's own handle, re-minted by every window that loads the
    /// tab (`loadFromLayout`); defaulted so a record written without one (an
    /// older or hand-made file) still loads.
    #[serde(default)]
    pub key: String,
    pub label: String,
    pub cmd: String,
    pub cwd: String,
    /// Agent session UUID for resumable agent tabs (e.g. Claude's
    /// `--session-id <uuid>`), persisted so the session can be resumed on
    /// restore via `--resume <uuid>`. Absent for shell/files tabs and
    /// non-resumable agents. Serialized as `sessionId`.
    #[serde(rename = "sessionId", skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

/// Remote (SSH) location metadata. A project is "remote" iff this is present;
/// the explicit "is this project remote?" resolver is
/// `services::remote::remote_target_for` (replacing the old infer-from-mountpoint
/// signal). The bytes live on `host:remote_path`.
///
/// In the mount-free remote model (`docs/mountfree_remote_plan.md`) the project's
/// `directory` is **not** a real local path for a remote project — file, git, and
/// terminal commands resolve `host:remote_path` directly over SSH/SFTP, never the
/// local fs. (During the sshfs→SFTP transition `directory` may still hold a legacy
/// mountpoint; it is ignored for fs purposes once a phase routes that op remote.)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteSpec {
    /// SSH user, e.g. "alice"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    /// SSH host, e.g. "build.example.com"
    pub host: String,
    /// SSH port; None = default 22
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    /// Absolute path on the remote host that is the project root
    pub remote_path: String,
    /// Optional OpenVPN tunnel to bring up before reaching `host`. When present,
    /// the tunnel is connected (password prompted at activation, never stored)
    /// before the sshfs mount / ssh sessions.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub openvpn: Option<OpenVpnSpec>,
    /// Opt-in: connect this project automatically (launch + activation) instead of
    /// waiting for the user to bring it up from the pill's connection lamp. Only
    /// offered when the connection can complete with no prompt — a saved SSH
    /// password, or `key_auth` below. The auto-connect never prompts: if it can't
    /// authenticate silently it stops with a red lamp.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_connect: Option<bool>,
    /// Recorded (not user-set): the last successful connect to `host` used no
    /// password at all, so it authenticated via key/agent. This is the only way to
    /// know a host is passwordless without connecting, and it is what makes
    /// auto-connect available to key-auth projects (which have nothing in the
    /// keychain to check). Written by `remote_connect`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_auth: Option<bool>,
    /// Run this project's remote shell/script tabs inside a **tmux** session on
    /// the host (TODO #85), so a long run survives an SSH drop, a laptop sleep, or
    /// Tabtivity quitting — the session keeps running and the tab reattaches on
    /// reconnect/relaunch. **Default ON** for a remote project: `None` and
    /// `Some(true)` both mean enabled; only an explicit `Some(false)` opts out (the
    /// pill's toggle). Agent tabs are excluded regardless — they resume via their
    /// own session. The frontend reads this to set each spawn's `tmux_session`
    /// name; the backend wraps in `ssh_exec::wrap_pty_options`. Mirrored into the
    /// `projects.json` entry's `extra["remote"]`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub persist_sessions: Option<bool>,
    /// This spec reaches a **project VM** Tabtivity itself booted
    /// (`docs/vm_projects_plan.md`): `host` is loopback and `port` the QEMU
    /// slirp forward, rewritten by `services::vm` on every boot. The marker is
    /// what authorizes the per-VM SSH identity/known_hosts handling (a
    /// recreated VM has a new host key; the user's real `~/.ssh/known_hosts`
    /// must never collect `[127.0.0.1]:<port>` entries) and what turns the
    /// spawn path's remote→local fallback into a hard refusal — for this tier
    /// a downgrade to a host shell is the untrusted agent stepping outside the
    /// boundary, not a perf surprise. Written at creation, never user-set.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vm: Option<bool>,
    /// Display name for this machine, e.g. "gpu-2"; falls back to `host`. Shown
    /// wherever a project's hosts are listed side by side (the System Monitor's
    /// source picker, the pill's connection lamps, `hostsForProject`) so a host is
    /// identifiable by more than its raw address. Distinct from the *project*
    /// name: this labels the machine `host` reaches, not the project itself — the
    /// primary (`Project.remote.label`) and every `ComputeHost` (flattened into
    /// its `spec`, so the JSON key stays the same one worker labels already used)
    /// share this one field.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

fn default_true() -> bool {
    true
}

/// An additional SSH machine a project runs experiments on (`docs/multi_host_remote_plan.md`).
/// Its code is kept in one-way sync from the canonical source (the local mirror);
/// its files are read-only (edits forbidden). It never owns git/sync/mirror state
/// of its own — the primary [`RemoteSpec`] (`Project.remote`) does. `id` is stable
/// (referenced by tab locations + the pool key + the fan-out state); `label` is the
/// pill/tab display name. Reusing `RemoteSpec` verbatim (flattened) means every
/// existing execution helper (`ssh_exec`, `sftp`, monitor/disk/gpu/python) works
/// unchanged — they already take `&RemoteSpec`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComputeHost {
    /// Stable id, e.g. "h1"; the primary is the implicit "primary".
    pub id: String,
    /// Keep this worker's tracked tree synced to the source HEAD (default true).
    /// Ignored when [`shared_fs`](Self::shared_fs) is set (there is no copy to sync).
    #[serde(default = "default_true")]
    pub sync_code: bool,
    /// Pull this worker's experiment OUTPUTS back on demand only, never
    /// automatically (default false — outputs stay on the worker).
    #[serde(default)]
    pub pull_outputs: bool,
    /// This machine reaches the project over a **shared filesystem**: it already
    /// sees the primary's project folder at `spec.remote_path`, so Tabtivity copies
    /// **no** code to it and **never runs git on it** — shells just `cd` into the
    /// shared tree and run there (`docs/multi_host_remote_plan.md`, shared-fs mode).
    /// Mutually exclusive with the whole one-way sync path: when set, connect does
    /// no bootstrap, commits do no fan-out, and "Sync code"/"Pull outputs" are
    /// meaningless (the folder *is* the primary's, kept in step by the primary's
    /// own sync). Default false — a machine is a synced-copy worker unless it opts
    /// into sharing.
    #[serde(default)]
    pub shared_fs: bool,
    /// user/host/port/remote_path/openvpn/auto_connect/key_auth.
    #[serde(flatten)]
    pub spec: RemoteSpec,
}

impl ComputeHost {
    /// The display label for this worker (its `spec.label`, or the bare host).
    pub fn display_label(&self) -> &str {
        self.spec.label.as_deref().unwrap_or(&self.spec.host)
    }
}

/// Optional OpenVPN tunnel for reaching a remote project's host. The client
/// config path and (for `auth-user-pass` configs) the auth username are
/// persisted; the password/passphrase is prompted each time the tunnel is
/// brought up and is never written to disk (unless the user opts into the OS
/// keychain via "Save password").
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenVpnSpec {
    /// Absolute path to the local `.ovpn` client config file.
    pub config: String,
    /// Auth username for configs that use `auth-user-pass` (server-side
    /// username+password auth). Persisted (it is not a secret, like the SSH
    /// `user`); the matching password is still prompted/keychained separately and
    /// never written here. `None` for configs that don't need a username (e.g.
    /// certificate-only or encrypted-key-passphrase configs).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

/// Which of a project's tabs the container actually applies to.
///
/// The distinction exists because the container's job is to keep **the agent**
/// away from the rest of the machine, and a project's other tabs are the user's
/// own hands. `All` is the strict reading and stays the default; `Agents` says
/// "contain what the model drives, leave my shell alone", which is what makes a
/// host toolchain (a `.venv` whose interpreter is a host symlink, a conda env, a
/// pyenv build — none of which exist inside the image) usable again without
/// turning the container off altogether.
///
/// What `Agents` costs is worth stating plainly: an agent still writes into the
/// project directory, and a script it wrote is one ▶ click from running
/// unconfined. What it does *not* cost is a path the agent can take by itself —
/// an in-project file is never read back as a host spawn (`terminal_service`'s
/// export-only rule, `docs/sandbox_hardening_plan.md` Phase 1), so crossing the
/// line takes a human. For code that is expected to be hostile rather than
/// merely unreviewed, the answer is the VM tier (`docs/vm_projects_plan.md`),
/// which shares no filesystem at all — not a stricter container.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum SandboxScope {
    /// Every shell/agent tab of the project (the pre-existing behaviour, and
    /// what an older `sandbox` object with no `scope` key deserializes to).
    #[default]
    All,
    /// Agent tabs only; shells, scripts and viewer Run/Debug tabs stay on the host.
    Agents,
}

/// Per-project container config (TODO #38). When present and `enabled`, every
/// terminal/agent tab of this project execs into ONE session-lived,
/// capability-dropped Docker container (`tabtivity-<id>`) that mounts only the
/// project directory plus the minimal agent auth/state paths (see
/// `services::sandbox`), so a process inside cannot reach unrelated host files.
/// Absent (the default) = tabs run on the host exactly as before. Local
/// projects only. (Serde key stays `sandbox` so projects that enabled the old
/// per-tab agent sandbox upgrade in place — no migration.)
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SandboxSpec {
    /// Whether this project's tabs run inside the container.
    pub enabled: bool,
    /// Which tabs the container applies to. Defaults to [`SandboxScope::All`],
    /// so a spec written before this field existed keeps containing everything.
    #[serde(default)]
    pub scope: SandboxScope,
    /// Optional image override; falls back to the built-in default image when
    /// absent (and is ignored while `dockerfile` is set).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    /// In-repo Dockerfile (path relative to the project dir); when set, `up`
    /// builds `tabtivity-<id>:latest` from it instead of pulling/expecting `image`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dockerfile: Option<String>,
    /// Max number of processes inside the container (`--pids-limit`). Guards
    /// against a fork-bombing agent. Falls back to a generous built-in default
    /// when absent (see `services::sandbox`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pids_limit: Option<u32>,
    /// Optional hard memory cap (`--memory`, e.g. "4g"). Absent = unlimited, so
    /// heavy in-container builds are not OOM-killed unless the user opts in.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory: Option<String>,
    /// Optional CPU cap (`--cpus`, e.g. "2"). Absent = unlimited.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpus: Option<String>,
    /// Optional docker network (`--network`, e.g. "none" for no egress, or a
    /// custom allowlist network). Absent = the default bridge (full egress).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub network: Option<String>,
    /// Run the container with a read-only root filesystem (`--read-only` +
    /// `--tmpfs /tmp`). Off by default because it breaks agents that write
    /// outside the mounted dirs (e.g. `~/.cache`); opt-in hardening.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub readonly_rootfs: bool,
    /// Hash of the in-repo `Dockerfile`/devcontainer `image` the user was last
    /// asked to confirm (O#143): a content hash, not a boolean, so a changed
    /// `Dockerfile` re-triggers the confirm dialog instead of silently reusing
    /// a decision made about different `RUN` steps. Set on both an adopt and a
    /// decline — a decline must stick until the file actually changes, or every
    /// enable re-asks. See `services::sandbox::detect_spec_source`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spec_source_hash: Option<String>,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

/// Egress policy for a project VM (`docs/vm_projects_plan.md`). Three-valued
/// and explicit because a truly no-egress VM cannot run a cloud agent — the
/// knob states plainly which channel stays open rather than pretending.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum VmEgress {
    /// slirp `restrict=on`, no proxy: the guest reaches nothing, including the
    /// host. Local-model / pure build-test isolation only; agent tabs are
    /// unavailable with the reason.
    Off,
    /// slirp `restrict=on` plus a guestfwd channel to Tabtivity's allowlisting
    /// HTTP CONNECT proxy. Default: agents reach their APIs, denied CONNECTs
    /// are logged and surfaced (an exfiltration tripwire). The honest caveat,
    /// stated in the UI: the agent can still exfiltrate *to the allowed
    /// endpoints* — Proxy narrows the channel, it cannot close it.
    #[default]
    Proxy,
    /// slirp default NAT — full egress, for work that needs the network
    /// (package installs, integration tests). One click back to Proxy.
    Open,
}

fn default_vm_memory() -> u32 {
    4096
}
fn default_vm_cpus() -> u32 {
    2
}
fn default_vm_disk() -> u32 {
    32
}

/// Per-project VM config (`docs/vm_projects_plan.md`) — the third trust tier,
/// above the Docker container: the whole project lives inside a locally booted
/// QEMU/KVM VM reached exclusively over SSH/SFTP, **no shared filesystem**.
/// Present iff the project was created as a VM project (chosen at creation,
/// not a flip-anytime toggle — the boundary is the absence of a shared
/// filesystem, and flipping it would be a data move). Mirrored into the
/// `projects.json` entry's `extra["vm"]`, the always-local copy
/// `services::vm` trusts. Mutually exclusive with `sandbox`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VmSpec {
    /// Whether this project's tree/tabs live inside the VM. (Kept for schema
    /// symmetry with `SandboxSpec`; a VM project is created with `true` and
    /// there is no in-place disable — see the type doc.)
    pub enabled: bool,
    /// Guest memory in MiB.
    #[serde(default = "default_vm_memory")]
    pub memory_mb: u32,
    /// Guest vCPUs.
    #[serde(default = "default_vm_cpus")]
    pub cpus: u32,
    /// Overlay disk's virtual size in GiB (qcow2 grows on demand).
    #[serde(default = "default_vm_disk")]
    pub disk_gb: u32,
    /// Egress policy (see [`VmEgress`]).
    #[serde(default)]
    pub egress: VmEgress,
    /// Extra allowlisted hosts for [`VmEgress::Proxy`], each an exact hostname
    /// or a `.suffix` matching any subdomain. Adds to the built-in agent-API
    /// list (`services::vm_proxy::DEFAULT_ALLOW`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allow_hosts: Vec<String>,
    /// Allow `github.com` (and its API/raw hosts) through the proxy. Opt-in,
    /// default off — for an untrusted import, cloning happens once at creation
    /// through a *temporary* allow, and a standing hole to a code-hosting site
    /// is exactly the exfiltration channel the tier narrows.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub allow_github: bool,
    /// This VM is a **contained mail reader** (`services::mail_reader`): its
    /// agent tabs are served the root MCP's mail read tools, for as long as the
    /// box stays at the default proxy allowlist. Trusted only from the
    /// `projects.json` mirror — an in-folder `project.json` grants nothing.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub mail_reader: bool,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

impl Default for VmSpec {
    fn default() -> Self {
        Self {
            enabled: true,
            memory_mb: default_vm_memory(),
            cpus: default_vm_cpus(),
            disk_gb: default_vm_disk(),
            egress: VmEgress::default(),
            allow_hosts: Vec::new(),
            allow_github: false,
            mail_reader: false,
            extra: HashMap::new(),
        }
    }
}

/// What an in-repo `Dockerfile`/devcontainer `image` declares, reported by
/// `services::sandbox::detect_spec_source` for the O#143 confirm dialog —
/// detection only, never auto-applied to a `SandboxSpec`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DetectedSpecKind {
    Dockerfile,
    DevcontainerImage,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetectedSpecSource {
    pub kind: DetectedSpecKind,
    /// The `Dockerfile` path (relative) or the devcontainer `image` string.
    pub value: String,
    /// SHA-256 hex of the deciding content (the Dockerfile's bytes, or the
    /// image string itself) — what a re-ask compares against.
    pub hash: String,
}

/// The frontend's answer to a `NeedsConfirmation` outcome: `hash` must match
/// the currently detected source (a stale dialog answering about a
/// Dockerfile that has since changed underneath it is refused, not silently
/// applied to the new one), `adopt` is the user's yes/no.
#[derive(Debug, Clone, Deserialize)]
pub struct SandboxSourceDecision {
    pub hash: String,
    pub adopt: bool,
}

/// `set_project_sandbox`'s result: either the spec was applied, or a detected
/// repo-supplied container source still needs an explicit decision before
/// anything is written.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum SandboxToggleOutcome {
    Applied { spec: SandboxSpec },
    NeedsConfirmation { source: DetectedSpecSource },
}

/// Per-project `project.json` file.
///
/// Most fields are optional because projects created by older app versions may
/// not have all fields, and this struct must survive forward-compatibility reads
/// (newer Python app wrote fields the Rust model doesn't know about → `extra`).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub directory: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_type: Option<String>,
    /// Per-project git-hosting profile URL (e.g. `https://github.com/me`) that
    /// overrides the global `settings.git_profile_url` for this project's push /
    /// publish. Non-secret, so it lives here; the matching token is kept in the
    /// OS keyring (see `services::git_credentials`), never in this file (which is
    /// inside the project's committed git tree).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_profile_url: Option<String>,
    /// Hosting provider this project was published to (`"github"` / `"gitlab"`),
    /// recorded at publish time so the UI can label the pill and pick the right
    /// CLI. Absent until the project is published to a remote.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_type_stats: Option<HashMap<String, FileTypeStat>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time_today_s: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time_total_s: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_updated: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_apps: Option<HashMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time: Option<TimeInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_tasks: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub open_apps: Option<Vec<OpenApp>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_layout: Option<Vec<TabEntry>>,
    /// Serialized split/group layout tree (opaque to the backend — the frontend
    /// owns its shape; `Value` round-trips it safely). Absent for legacy
    /// projects, in which case the frontend rebuilds a single root group.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_groups: Option<serde_json::Value>,
    /// Session UUIDs of agent tabs that were open (e.g. Claude's
    /// `--session-id <uuid>`), persisted so a session can be resumed later.
    /// The restore path does not consume this yet — it only keeps the UUIDs
    /// durable. Opaque shape owned by the frontend (round-tripped via `Value`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub open_tab_sessions: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote: Option<RemoteSpec>,
    /// Extra SSH machines this project runs experiments on (`docs/multi_host_remote_plan.md`).
    /// The primary is still `remote`; these are one-way, read-only "workers". Mirrored
    /// into the `projects.json` entry's `extra["compute_hosts"]`. Migration-free
    /// (`#[serde(default)]` → `[]` for existing projects).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub compute_hosts: Vec<ComputeHost>,
    /// For a remote (SSH) project, the local mirror root — the paired local
    /// working copy synced from the host. Chosen at import (defaults to a
    /// `<name>` subfolder of the top-level `tabtivity/projects-ssh/` root) and relocatable via the
    /// pill's "Show on disk" when the mirror has been deleted. Absent for local
    /// projects and for remote projects predating configurable mirrors, which
    /// fall back to the default under the state dir. Mirrored into the
    /// `projects.json` entry's `extra["mirror"]`, which `remote_sync::mirror_dir`
    /// reads as the always-local source of truth.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mirror: Option<String>,
    /// Docker sandbox config for agent tabs. Absent = run agents on the host.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sandbox: Option<SandboxSpec>,
    /// Project-VM config (`docs/vm_projects_plan.md`): present iff this project
    /// lives inside a locally booted VM (which also carries a synthesized
    /// `remote` spec pointing at the forwarded loopback port). Mutually
    /// exclusive with `sandbox`. Mirrored into `projects.json` `extra["vm"]`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vm: Option<VmSpec>,
    /// The interpreter the code viewer's Run/Debug buttons use for this project
    /// (#87). Absent = **auto-detect** (see `commands::python`), which is what the
    /// overwhelming majority of projects want; this pins it for the ones auto-detect
    /// cannot see — a conda env, a Poetry venv outside the tree, a second venv.
    /// Stored as the command/path verbatim (relative paths resolve against the
    /// project root, which is the run tab's cwd). Mirrored into the `projects.json`
    /// entry's `extra["python_interpreter"]`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub python_interpreter: Option<String>,
    /// Per-project override of the global `Settings.agent_remote_control`
    /// (O#59): `Some(true)`/`Some(false)` force Claude agent tabs of THIS
    /// project to spawn with/without `--remote-control`; `None` (the default)
    /// inherits the global setting, so an untouched project's behavior never
    /// changes. Mirrored into the `projects.json` entry's
    /// `extra["remote_control"]`, which `commands::terminal::pty_spawn` reads
    /// as the authoritative copy — like `sandbox`, this field is never trusted
    /// out of `project.json` at spawn time, since that file lives inside the
    /// project tree (and a container's own rw mount).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_control: Option<bool>,
    /// Per-project override of the global default-on agent filesystem fence.
    /// Mirrored into the trusted projects.json entry's `extra["agent_fence"]`;
    /// this project-tree copy is display/export only at spawn time.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_fence: Option<bool>,
    /// Which machine shells launched from this project run on — the choice made in
    /// the `RunHostPicker`, persisted so it survives a relaunch (a Run/Debug or a
    /// new shell tab lands on it instead of the primary). A `TabLocation` string:
    /// `"local"` (the mirror), `"remote"` (the primary host), or `"host:<id>"` (a
    /// worker). Absent = the shell default (the primary). Mirrored into the
    /// `projects.json` entry's `extra["run_host"]`, which is what the frontend
    /// seeds its live preference store from on load.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_host: Option<String>,
    /// The HPC **workspace** this project's tree lives in, plus the small anchor
    /// folder kept in the user's cluster home (`docs/hpc_workspace_plan.md`).
    /// Recorded because **none of it can be re-derived once the workspace
    /// expires**: the tooling's recovery path (`ws_restore`) is keyed by the
    /// workspace *name*, and the host tree that would have told you which one it
    /// was is exactly what got deleted. Mirrored into the `projects.json` entry's
    /// `extra["hpc"]`. Absent for every project that isn't in a workspace.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hpc: Option<HpcInfo>,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

/// What a project remembers about its HPC workspace and home anchor. Every field
/// is optional: a project may have a workspace but no anchor (or the reverse,
/// after a workspace expired and was released), and a site's tooling may not
/// report a filesystem name.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct HpcInfo {
    /// The workspace id (`ws_allocate <id>`) — the handle `ws_extend`/`ws_release`
    /// /`ws_restore` take, and the only one that survives the directory.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    /// Its absolute path on the host at the time it was recorded.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_path: Option<String>,
    /// The workspace filesystem (`-F`), which `ws_extend` must be given again.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filesystem: Option<String>,
    /// The per-project folder in the user's cluster home (logs + workspace link +
    /// the append-only record). Outside the project root, so nothing syncs it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anchor_dir: Option<String>,
    /// The same folder as the `$HOME`-relative path it was created from. Kept
    /// beside the absolute one because re-anchoring (a move to another workspace)
    /// must pass the *rel* back — deriving it by chopping segments off
    /// `anchor_dir` guesses wrong the moment the user picks a path that isn't two
    /// segments deep.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anchor_rel: Option<String>,
    /// `<anchor_dir>/logs` — where `#SBATCH --output` points, and the fallback
    /// `slurm_job_out` uses for a job `scontrol` has already forgotten.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub logs_dir: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse<T: serde::de::DeserializeOwned>(json: &str) -> T {
        serde_json::from_str(json).expect("parse")
    }

    fn json<T: Serialize>(value: &T) -> Value {
        serde_json::to_value(value).expect("serialize")
    }

    /// The three required keys are the whole floor: a `project.json` written by
    /// the earliest app version loads, and writing it back adds no key it did not
    /// have (no `null`s, no `[]` for `compute_hosts`).
    #[test]
    fn a_minimal_project_loads_and_writes_back_only_its_three_keys() {
        let p: Project = parse(r#"{"id":"p1","name":"One","directory":"/tmp/one"}"#);
        assert!(p.remote.is_none() && p.sandbox.is_none() && p.vm.is_none());
        assert!(p.compute_hosts.is_empty());
        assert!(p.extra.is_empty());
        let out = json(&p);
        let keys: Vec<&str> = out.as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(keys.len(), 3, "unexpected keys written: {keys:?}");
        assert!(out.get("compute_hosts").is_none());
    }

    /// Fields the Python app wrote and the Rust model never learned about ride
    /// through `extra` unchanged, at the top level and inside the nested blocks.
    #[test]
    fn python_era_unknown_fields_round_trip_through_extra() {
        let raw = r#"{
            "id":"p1","name":"One","directory":"/tmp/one",
            "favorite": true,
            "time": {"total_s": 12.5, "recent_sessions": [
                {"date":"2026-07-08","start":"2026-07-08 09:00","duration_s":600,"note":"pair"}
            ], "streak_days": 3},
            "open_apps": [{"exec":"code","legacy_flag":1}]
        }"#;
        let p: Project = parse(raw);
        assert_eq!(p.extra["favorite"], Value::Bool(true));
        let time = p.time.as_ref().unwrap();
        assert_eq!(time.extra["streak_days"], Value::from(3));
        assert_eq!(time.recent_sessions[0].extra["note"], Value::from("pair"));
        let app = &p.open_apps.as_ref().unwrap()[0];
        assert!(app.mode.is_none() && app.pid.is_none(), "legacy record has no mode/pid");
        assert_eq!(app.extra["legacy_flag"], Value::from(1));

        let back: Project = parse(&serde_json::to_string(&p).unwrap());
        assert_eq!(back.extra["favorite"], Value::Bool(true));
        assert_eq!(back.time.unwrap().extra["streak_days"], Value::from(3));
        assert_eq!(back.open_apps.unwrap()[0].extra["legacy_flag"], Value::from(1));
    }

    /// `sessionId` is the wire spelling the frontend reads for `--resume`; the
    /// snake_case spelling is *not* an alias and would ride in `extra` — a tab
    /// layout hand-edited that way silently loses its resume.
    #[test]
    fn tab_entry_session_id_is_camel_case_on_the_wire() {
        let e: TabEntry = parse(
            r#"{"key":"t1","label":"claude","cmd":"claude","cwd":"/p","sessionId":"abc"}"#,
        );
        assert_eq!(e.session_id.as_deref(), Some("abc"));
        let out = json(&e);
        assert_eq!(out["sessionId"], "abc");
        assert!(out.get("session_id").is_none());

        let shell: TabEntry = parse(r#"{"key":"t2","label":"sh","cmd":"bash","cwd":"/p"}"#);
        assert!(shell.session_id.is_none());
        assert!(json(&shell).get("sessionId").is_none(), "absent, not null");

        let snake: TabEntry =
            parse(r#"{"key":"t3","label":"x","cmd":"x","cwd":"/p","session_id":"abc"}"#);
        assert!(snake.session_id.is_none());
        assert_eq!(snake.extra["session_id"], "abc");
    }

    /// A remote spec needs only `host` + `remote_path`; every knob is absent
    /// rather than null on the way back out, so an older reader keeps its
    /// defaults (tmux persistence stays ON while the key is missing).
    #[test]
    fn remote_spec_minimal_shape_and_omitted_options() {
        let r: RemoteSpec = parse(r#"{"host":"build.example","remote_path":"/srv/p"}"#);
        assert!(r.user.is_none() && r.port.is_none() && r.openvpn.is_none());
        assert!(r.persist_sessions.is_none() && r.vm.is_none() && r.label.is_none());
        let out = json(&r);
        assert_eq!(
            out.as_object().unwrap().len(),
            2,
            "only host + remote_path written: {out}"
        );

        let full: RemoteSpec = parse(
            r#"{"user":"alice","host":"h","port":2222,"remote_path":"/p",
                "openvpn":{"config":"/etc/x.ovpn"},"persist_sessions":false,"vm":true}"#,
        );
        assert_eq!(full.port, Some(2222));
        assert_eq!(full.persist_sessions, Some(false));
        assert_eq!(full.vm, Some(true));
        let vpn = full.openvpn.as_ref().unwrap();
        assert_eq!(vpn.config, "/etc/x.ovpn");
        assert!(vpn.username.is_none());
        assert!(json(vpn).get("username").is_none());
    }

    /// A worker is `{id, flags…}` with the `RemoteSpec` flattened in: `label`
    /// sits at the top level of the JSON (the same key worker labels always
    /// used), `sync_code` defaults ON and the other two flags OFF.
    #[test]
    fn compute_host_flattens_its_spec_and_defaults_its_flags() {
        let h: ComputeHost = parse(r#"{"id":"h1","host":"gpu-2.example","remote_path":"/w"}"#);
        assert!(h.sync_code);
        assert!(!h.pull_outputs);
        assert!(!h.shared_fs);
        assert_eq!(h.display_label(), "gpu-2.example");

        let labelled: ComputeHost = parse(
            r#"{"id":"h2","host":"192.0.2.2","remote_path":"/w","label":"gpu-2","shared_fs":true}"#,
        );
        assert_eq!(labelled.display_label(), "gpu-2");
        assert!(labelled.shared_fs);
        let out = json(&labelled);
        assert_eq!(out["label"], "gpu-2", "label is flattened, not nested: {out}");
        assert!(out.get("spec").is_none());
        assert_eq!(out["host"], "192.0.2.2");
    }

    /// A `sandbox` object written before `scope` existed keeps containing every
    /// tab, and `readonly_rootfs` is written only when it is on.
    #[test]
    fn sandbox_spec_without_scope_reads_as_all() {
        let s: SandboxSpec = parse(r#"{"enabled":true}"#);
        assert_eq!(s.scope, SandboxScope::All);
        assert!(!s.readonly_rootfs);
        let out = json(&s);
        assert_eq!(out["scope"], "all");
        assert!(out.get("readonly_rootfs").is_none());
        assert!(out.get("image").is_none());

        let agents: SandboxSpec =
            parse(r#"{"enabled":true,"scope":"agents","readonly_rootfs":true}"#);
        assert_eq!(agents.scope, SandboxScope::Agents);
        let out = json(&agents);
        assert_eq!(out["scope"], "agents");
        assert_eq!(out["readonly_rootfs"], true);
        assert!(serde_json::from_str::<SandboxSpec>(r#"{"enabled":true,"scope":"Agents"}"#).is_err());
    }

    /// A VM spec needs only `enabled`: sizes fall back to 4 GiB / 2 vCPU /
    /// 32 GiB, egress to `proxy`, and the opt-in GitHub hole stays closed —
    /// and none of those defaults is written back as a list or a `false`.
    #[test]
    fn vm_spec_defaults_and_egress_wire_names() {
        let v: VmSpec = parse(r#"{"enabled":true}"#);
        assert_eq!((v.memory_mb, v.cpus, v.disk_gb), (4096, 2, 32));
        assert_eq!(v.egress, VmEgress::Proxy);
        assert!(!v.allow_github);
        assert!(v.allow_hosts.is_empty());
        let out = json(&v);
        assert!(out.get("allow_hosts").is_none());
        assert!(out.get("allow_github").is_none());
        assert_eq!(out["egress"], "proxy");
        for (variant, name) in [(VmEgress::Off, "off"), (VmEgress::Proxy, "proxy"), (VmEgress::Open, "open")] {
            assert_eq!(json(&variant), Value::from(name));
            assert_eq!(parse::<VmEgress>(&format!("\"{name}\"")), variant);
        }
        let d = VmSpec::default();
        assert!(d.enabled, "a VM project is created enabled");
        assert_eq!(d.memory_mb, v.memory_mb);
    }

    /// The toggle result is tagged by `outcome`, and a detected source names
    /// its kind in snake_case — what the confirm dialog switches on.
    #[test]
    fn sandbox_toggle_outcome_is_tagged_by_outcome() {
        let applied = SandboxToggleOutcome::Applied {
            spec: SandboxSpec::default(),
        };
        let out = json(&applied);
        assert_eq!(out["outcome"], "applied");
        assert_eq!(out["spec"]["enabled"], false);

        let ask = SandboxToggleOutcome::NeedsConfirmation {
            source: DetectedSpecSource {
                kind: DetectedSpecKind::DevcontainerImage,
                value: "ghcr.io/x/y:1".into(),
                hash: "abc".into(),
            },
        };
        let out = json(&ask);
        assert_eq!(out["outcome"], "needs_confirmation");
        assert_eq!(out["source"]["kind"], "devcontainer_image");
        assert_eq!(json(&DetectedSpecKind::Dockerfile), "dockerfile");

        let decision: SandboxSourceDecision = parse(r#"{"hash":"abc","adopt":false}"#);
        assert_eq!(decision.hash, "abc");
        assert!(!decision.adopt);
    }

    /// Every HPC field is optional, an empty record is `{}` on disk, and a
    /// partial one (workspace released, anchor kept) survives the round trip.
    #[test]
    fn hpc_info_writes_only_what_it_knows() {
        assert_eq!(json(&HpcInfo::default()), serde_json::json!({}));
        let partial = HpcInfo {
            anchor_dir: Some(concat!("/home/u/", crate::app_slug!(), "-anchors/p").into()),
            anchor_rel: Some(concat!(crate::app_slug!(), "-anchors/p").into()),
            ..Default::default()
        };
        let out = json(&partial);
        assert_eq!(out.as_object().unwrap().len(), 2);
        let back: HpcInfo = parse(&out.to_string());
        assert_eq!(back, partial);

        let p: Project = parse(
            r#"{"id":"p","name":"n","directory":"/d","hpc":{"workspace_id":"ws1","filesystem":"lustre"}}"#,
        );
        let hpc = p.hpc.unwrap();
        assert_eq!(hpc.workspace_id.as_deref(), Some("ws1"));
        assert!(hpc.workspace_path.is_none());
    }

    /// `file_type_stats` keeps its Python shape: a map keyed by extension whose
    /// values carry count/bytes plus whatever else was recorded.
    #[test]
    fn file_type_stats_keep_their_python_shape() {
        let p: Project = parse(
            r#"{"id":"p","name":"n","directory":"/d",
                "file_type_stats":{"py":{"count":3,"bytes":1200,"lines":80},"md":{"count":1,"bytes":5}},
                "default_apps":{"pdf":"okular"}}"#,
        );
        let stats = p.file_type_stats.as_ref().unwrap();
        assert_eq!(stats["py"].count, 3);
        assert_eq!(stats["py"].extra["lines"], Value::from(80));
        assert_eq!(p.default_apps.as_ref().unwrap()["pdf"], "okular");
        let back: Project = parse(&serde_json::to_string(&p).unwrap());
        assert_eq!(back.file_type_stats.unwrap()["py"].extra["lines"], Value::from(80));
    }

    /// The opaque frontend-owned trees (`tab_groups`, `open_tab_sessions`) are
    /// carried byte-for-byte whatever their shape, and `agent_tasks` stays a
    /// list of untyped values.
    #[test]
    fn opaque_frontend_trees_round_trip_verbatim() {
        let raw = r#"{"id":"p","name":"n","directory":"/d",
            "tab_groups":{"kind":"split","dir":"h","children":[{"kind":"group","tabs":["a"]}]},
            "open_tab_sessions":["u1","u2"],
            "agent_tasks":[{"id":"t","anything":null}]}"#;
        let p: Project = parse(raw);
        let back: Project = parse(&serde_json::to_string(&p).unwrap());
        let expected: Value = parse(raw);
        assert_eq!(back.tab_groups.unwrap(), expected["tab_groups"]);
        assert_eq!(back.open_tab_sessions.unwrap(), expected["open_tab_sessions"]);
        assert_eq!(back.agent_tasks.unwrap()[0], expected["agent_tasks"][0]);
    }

    /// The per-project overrides are tri-state: absent inherits the global
    /// setting, and an explicit `false` must be written back as `false` (it is
    /// the user's "off"), never normalized to absent.
    #[test]
    fn per_project_overrides_keep_an_explicit_false() {
        let p: Project = parse(
            r#"{"id":"p","name":"n","directory":"/d","remote_control":false,"agent_fence":false,"run_host":"host:h1"}"#,
        );
        assert_eq!(p.remote_control, Some(false));
        assert_eq!(p.agent_fence, Some(false));
        let out = json(&p);
        assert_eq!(out["remote_control"], false);
        assert_eq!(out["agent_fence"], false);
        assert_eq!(out["run_host"], "host:h1");
        let plain: Project = parse(r#"{"id":"p","name":"n","directory":"/d"}"#);
        assert!(plain.remote_control.is_none() && plain.agent_fence.is_none());
    }
}
