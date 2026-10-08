//! Filesystem fence for locally-running agent tabs (Linux and macOS).
//!
//! The project container remains the stronger, opt-in boundary.  For ordinary
//! local agent tabs this module wraps the agent in the OS's unprivileged
//! sandbox: `bubblewrap` on Linux (the host root is read-only, the scope's
//! Tabtivity-owned agent home (`services::agent_home`) is bound over `$HOME`,
//! `/tmp`, `/run` and `~/.cache` are private, and only the owning project plus
//! every box it belongs to is mounted read-write) and `sandbox-exec` on macOS
//! (a Seatbelt profile that denies writes outside the same roots and hides the
//! user's `$HOME` — see [`sandbox_exec_profile`] for what it can and cannot
//! mirror). The fence is the only mode: there is no per-project or global
//! "off". Remote-host tabs, containerized tabs and the explicit Host session
//! are not fenced and reported honestly by [`status_for_scope`]; Windows has no
//! fence and says so. A CLI typed into a shell tab reaches the same fence
//! through the shims in `agent_bin` (`--agent-shim`).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::Serialize;

use crate::schema::boxes::BoxesList;
use crate::schema::projects::{ProjectEntry, ProjectsList};
use crate::terminal::PtyOptions;
use crate::{paths, storage};

/// A package the fence may ask the user to install. Only bubblewrap for now: it
/// is the one missing tool that makes Tabtivity fail closed.
#[cfg(any(target_os = "linux", test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallPkg {
    Bubblewrap,
}

/// The distribution's own install command for `pkg`, chosen from an
/// `os-release` file: its `ID` first, then each `ID_LIKE` entry in order.
/// `None` for a distribution this does not recognize — the pill runs this
/// command with one click, and another package manager's command is worse than
/// no button.
#[cfg(any(target_os = "linux", test))]
pub fn package_install_cmd(os_release: &str, pkg: InstallPkg) -> Option<String> {
    let field = |key: &str| {
        os_release.lines().find_map(|line| {
            let (k, v) = line.split_once('=')?;
            (k.trim() == key)
                .then(|| v.trim().trim_matches(|c| c == '"' || c == '\'').to_ascii_lowercase())
        })
    };
    let mut ids: Vec<String> = field("ID").into_iter().collect();
    if let Some(like) = field("ID_LIKE") {
        ids.extend(like.split_whitespace().map(str::to_string));
    }
    let package = match pkg {
        InstallPkg::Bubblewrap => "bubblewrap",
    };
    ids.iter().find_map(|id| {
        let manager = match id.as_str() {
            "debian" | "ubuntu" | "linuxmint" | "pop" | "elementary" | "raspbian" | "kali"
            | "zorin" | "neon" => "sudo apt install -y",
            "fedora" | "rhel" | "centos" | "rocky" | "almalinux" | "nobara" => {
                "sudo dnf install -y"
            }
            "arch" | "manjaro" | "endeavouros" | "cachyos" => "sudo pacman -S --needed",
            "suse" | "sles" => "sudo zypper install -y",
            other if other.starts_with("opensuse") => "sudo zypper install -y",
            _ => return None,
        };
        Some(format!("{manager} {package}"))
    })
}

/// The install command for the fence tool on this machine, or `None` when there
/// is nothing honest to offer: not Linux (macOS ships `sandbox-exec`, Windows
/// has no fence), or a distribution [`package_install_cmd`] does not know.
pub fn fence_install_cmd() -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        static CMD: OnceLock<Option<String>> = OnceLock::new();
        CMD.get_or_init(|| {
            let release = std::fs::read_to_string("/etc/os-release")
                .or_else(|_| std::fs::read_to_string("/usr/lib/os-release"))
                .unwrap_or_default();
            package_install_cmd(&release, InstallPkg::Bubblewrap)
        })
        .clone()
    }
    #[cfg(not(target_os = "linux"))]
    {
        None
    }
}

/// The spawn refusal when the fence tool is missing — one wording for both
/// places that refuse (`pty_spawn`'s decision and the bubblewrap wrapper).
pub fn fence_unavailable_message() -> String {
    let tool = fence_tool_name();
    if cfg!(target_os = "macos") {
        return format!(
            "Agent sandbox: {tool} is unavailable on this Mac, so this agent was not started. Open the project in a container, or use a Host session from the root console."
        );
    }
    match fence_install_cmd() {
        Some(cmd) => format!(
            "Agent sandbox: {tool} is unavailable, so this agent was not started. Install it with `{cmd}`."
        ),
        None => format!(
            "Agent sandbox: {tool} is unavailable, so this agent was not started. Install the {tool} package with your distribution's package manager."
        ),
    }
}

/// The sandboxing tool this OS's fence is built on, for messages.
pub fn fence_tool_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "sandbox-exec"
    } else {
        "bubblewrap"
    }
}

/// Whether this OS has a fence implementation at all: Linux (bubblewrap) and
/// macOS (sandbox-exec). Windows has no fence: AppContainer is the one
/// unprivileged sandbox there, and it cuts loopback, which every Tabtivity MCP
/// endpoint, local model and agent sign-in needs (`docs/context/agent_authority.md`).
/// Agents there run unfenced, the pill says so, and the first one is refused
/// until the user accepts that ([`platform_accepted`]).
pub fn platform_fenceable() -> bool {
    cfg!(any(target_os = "linux", target_os = "macos"))
}

/// Whether the user has accepted, once, that agents on this fence-less
/// platform run with their full rights (`Settings::agent_fence_platform_accepted`).
pub fn platform_accepted() -> bool {
    settings().agent_fence_platform_accepted()
}

/// The marker `pty_spawn`'s refusal carries when a fence-less platform has not
/// been accepted yet. The frontend (`lib/agents/agentFence.ts`) matches it,
/// asks, and retries; no other refusal starts with it.
pub const PLATFORM_UNACCEPTED_SENTINEL: &str = crate::app_env!("FENCE_PLATFORM_UNACCEPTED");

/// The spawn refusal on a fence-less platform nobody has accepted yet.
pub fn platform_unaccepted_message() -> String {
    format!(
        "{PLATFORM_UNACCEPTED_SENTINEL} Agent sandbox: {} has no agent sandbox, so this agent would run with your full rights. Accept that once in the prompt {app} shows, or open the project in a container.",
        platform_reason(), app = crate::brand::DISPLAY
    )
}

/// The backend authority decision.  `Unavailable` is fail-closed at spawn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FenceDecision {
    Fenced { roots: Vec<PathBuf> },
    NotApplicable { reason: &'static str },
    /// No fence exists on this platform and the user has not yet accepted
    /// that agents run with their full rights. Refused at spawn, like
    /// `Unavailable`; the frontend asks and retries.
    PlatformUnaccepted,
    /// The fence tool is missing or unusable. The install advice is not carried
    /// here: it depends on the distribution, and [`fence_unavailable_message`]
    /// reads it, which keeps this decision pure.
    Unavailable,
}

// The mount/symlink planners below feed the bubblewrap fence (Linux) and the
// Seatbelt profile inputs (macOS, `sandbox_exec_inputs`); Windows has no fence.
#[cfg(any(target_os = "linux", target_os = "macos", test))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct BindMount {
    pub src: String,
    pub dst: String,
    pub read_only: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentFenceStatus {
    pub enforced: bool,
    pub reason: String,
    pub roots: Vec<String>,
    pub bwrap_available: bool,
    /// The one-click install for the missing fence tool on this distribution;
    /// `None` when the tool works or there is no command worth running.
    pub install_cmd: Option<String>,
}

/// Default read-only host paths made visible inside the otherwise-empty home.
pub const DEFAULT_PATHS: &[&str] = crate::schema::settings::DEFAULT_AGENT_FENCE_PATHS;

fn basename(cmd: &str) -> &str {
    let base = cmd.rsplit(['/', '\\']).next().unwrap_or(cmd);
    base.strip_suffix(".exe").unwrap_or(base)
}

pub fn is_agent(opts: &PtyOptions) -> bool {
    opts.agent
        || crate::services::sandbox::is_agent_cmd(&opts.cmd)
        || crate::services::sandbox::HOST_BOUND_LOCAL_AGENT_CMDS.contains(&basename(&opts.cmd))
}

/// The reason a Host session's decision carries (`docs/context/agent_authority.md`).
pub const HOST_SESSION_REASON: &str = "host session";

/// Pure decision matrix.  Root resolution and remote detection are passed in so
/// the policy is testable without touching the state directory. `fenceable` is
/// [`platform_fenceable`], `platform_ok` is [`platform_accepted`] (only read
/// when there is no fence to build) and `tool_ok` is [`bwrap_available`] (the
/// fence tool probe, whichever tool that is on this OS). There is no "off":
/// the fence is the only mode a local agent runs in, and the one unfenced
/// spawn is the explicit Host session of the root console.
pub fn decide(
    opts: &PtyOptions,
    roots: Vec<PathBuf>,
    remote_run: bool,
    fenceable: bool,
    platform_ok: bool,
    tool_ok: bool,
) -> FenceDecision {
    if !is_agent(opts) {
        return FenceDecision::NotApplicable { reason: "shell" };
    }
    if opts.sandbox {
        return FenceDecision::NotApplicable {
            reason: "container",
        };
    }
    if remote_run {
        return FenceDecision::NotApplicable {
            reason: "remote host",
        };
    }
    if opts.host_session && opts.project_id.is_none() {
        return FenceDecision::NotApplicable {
            reason: HOST_SESSION_REASON,
        };
    }
    if !fenceable {
        // A platform without a fence gets the choice, made once for the
        // machine rather than assumed.
        return if platform_ok {
            FenceDecision::NotApplicable { reason: "platform" }
        } else {
            FenceDecision::PlatformUnaccepted
        };
    }
    if !tool_ok {
        return FenceDecision::Unavailable;
    }
    FenceDecision::Fenced { roots }
}

pub(crate) fn entry_directory(entry: &ProjectEntry) -> Option<PathBuf> {
    if let Some(dir) = entry.extra.get("directory").and_then(|v| v.as_str()) {
        if !dir.trim().is_empty() {
            return Some(PathBuf::from(dir.trim()));
        }
    }
    entry
        .local_file
        .strip_suffix("/project.json")
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

pub(crate) fn entry_mirror(entry: &ProjectEntry) -> Option<PathBuf> {
    entry
        .extra
        .get("mirror")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

fn dedupe_paths(paths: impl IntoIterator<Item = PathBuf>) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    paths
        .into_iter()
        .filter(|p| seen.insert(p.clone()))
        .collect()
}

/// Pure root computation.  Explicit remote mirrors are included here; the
/// state-backed wrapper below adds legacy projects' derived default mirrors.
pub fn compute_fence_roots(
    boxes: &BoxesList,
    projects: &ProjectsList,
    scope_id: &str,
    local_only: bool,
) -> Option<Vec<PathBuf>> {
    if let Some(box_id) = crate::commands::boxes::box_id_of_scope(scope_id) {
        return crate::commands::boxes::compute_box_allowed_roots(boxes, projects, box_id)
            .map(dedupe_paths);
    }

    let project = projects.iter().find(|p| p.id == scope_id)?;
    let is_remote = project.extra.contains_key("remote");
    let own = if is_remote && local_only {
        entry_mirror(project).or_else(|| entry_directory(project))?
    } else {
        entry_directory(project)?
    };
    let mut roots = vec![own];
    for b in boxes
        .iter()
        .filter(|b| b.member_ids.iter().any(|id| id == scope_id))
    {
        if let Some(box_roots) =
            crate::commands::boxes::compute_box_allowed_roots(boxes, projects, &b.id)
        {
            roots.extend(box_roots);
        }
    }
    Some(dedupe_paths(roots))
}

/// The roots a fenced `local_only` tab of project `id` works in, from lists —
/// what `roots_for_scope(Some(id), true)` binds, for the mail `attach`
/// same-roots rule (`services::mail_attach`). A remote project's own root is
/// its local mirror (the explicit one, else the default under `state_dir`),
/// never its `directory`, which names a path on another machine and, in a
/// legacy entry, typically the user's home. Remote box members contribute
/// their mirrors and not their `directory` strings either: the root fence's
/// project view ([`root_project_read_only_paths`]) exposes neither, and this
/// must not be wider than what the calling root tab can read.
pub fn attach_roots(
    boxes: &BoxesList,
    projects: &ProjectsList,
    id: &str,
    state_dir: &Path,
) -> Option<Vec<PathBuf>> {
    if crate::commands::boxes::box_id_of_scope(id).is_some() {
        return None;
    }
    let mut roots = compute_fence_roots(boxes, projects, id, true)?;
    let mirror = |p: &ProjectEntry| {
        entry_mirror(p)
            .unwrap_or_else(|| crate::services::remote_sync::default_mirror_dir_in(state_dir, &p.id))
    };
    let project = projects.iter().find(|p| p.id == id)?;
    if project.extra.contains_key("remote") {
        roots[0] = mirror(project);
    }
    let remote_dirs: Vec<PathBuf> = projects
        .iter()
        .filter(|p| p.extra.contains_key("remote"))
        .filter_map(entry_directory)
        .collect();
    let own = roots.remove(0);
    roots.retain(|r| !remote_dirs.contains(r));
    for b in boxes.iter().filter(|b| b.member_ids.iter().any(|m| m == id)) {
        for m in &b.member_ids {
            if let Some(p) = projects.iter().find(|p| &p.id == m && p.extra.contains_key("remote")) {
                roots.push(mirror(p));
            }
        }
    }
    roots.insert(0, own);
    Some(dedupe_paths(roots))
}

fn read_lists() -> (BoxesList, ProjectsList) {
    let boxes = storage::read_json(&storage::state_dir().join("boxes.json")).unwrap_or_default();
    let projects =
        storage::read_json(&storage::state_dir().join("projects.json")).unwrap_or_default();
    (boxes, projects)
}

/// The scope id `commands::terminal` hands the wrappers for a root-console
/// spawn (`project_id` is `None`); a project id is a UUID, a box scope is
/// `box:<id>`, so the literal collides with neither.
pub const ROOT_SCOPE: &str = "root";

/// `Settings::root_fence_projects_readable`: what a **root** agent's fence
/// exposes read-only on top of `~/tabtivity/root` — every local project's
/// directory, every box folder, and every remote project's local mirror (the
/// explicit one, else the default under the state dir, which the private-state
/// mask keeps hidden). Pure, so the planner test drives it with lists.
///
/// Deliberately **not** routed through `roots_for_scope`: every root it
/// returns becomes a read-write `--bind`. These go down the read-only channel
/// (`extra_ro` on Linux, `readable` on macOS), and the masks are spliced after
/// all binds, so the state dir and credential masks still win. Empty while
/// the switch is off, and never consulted for a project scope.
pub fn root_project_read_only_paths(
    settings: &crate::schema::Settings,
    projects: &ProjectsList,
    boxes: &BoxesList,
    state_dir: &Path,
) -> Vec<String> {
    if !settings.root_fence_projects_readable() {
        return Vec::new();
    }
    let mut paths: Vec<PathBuf> = Vec::new();
    for p in projects {
        if p.extra.contains_key("remote") {
            paths.push(entry_mirror(p).unwrap_or_else(|| {
                crate::services::remote_sync::default_mirror_dir_in(state_dir, &p.id)
            }));
        } else if let Some(dir) = entry_directory(p) {
            paths.push(dir);
        }
    }
    paths.extend(boxes.iter().filter_map(|b| b.folder.as_deref()).map(PathBuf::from));
    dedupe_paths(paths)
        .into_iter()
        .filter(|p| p.is_absolute())
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
}

/// [`root_project_read_only_paths`] against the live state, for tab `tab`
/// spawning in `scope_id`; empty for any project or box scope. Records the
/// paths this argv binds ([`take_root_projects_granted`]), so the spawn path
/// hands the tab's MCP session exactly what its fence got rather than a second
/// read of a setting or a project list that may have changed in between.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn root_project_read_only_paths_for(tab: &str, scope_id: &str) -> Vec<String> {
    let mut grants = root_project_grants().lock().unwrap_or_else(|p| p.into_inner());
    grants.remove(tab);
    if scope_id != ROOT_SCOPE {
        return Vec::new();
    }
    let settings = settings();
    let (boxes, projects) = read_lists();
    let paths = root_project_read_only_paths(&settings, &projects, &boxes, &storage::state_dir());
    if settings.root_fence_projects_readable() {
        grants.insert(tab.to_string(), paths.iter().map(PathBuf::from).collect());
    }
    paths
}

fn root_project_grants() -> &'static Mutex<HashMap<String, Vec<PathBuf>>> {
    static GRANTS: OnceLock<Mutex<HashMap<String, Vec<PathBuf>>>> = OnceLock::new();
    GRANTS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The project paths the fence just built for root tab `tab` binds read-only,
/// consumed once by the spawn path; `None` when the switch was off. Also
/// `None` on a platform with no fence wrapper (the spawn path treats an
/// unfenced root agent separately).
pub fn take_root_projects_granted(tab: &str) -> Option<Vec<PathBuf>> {
    root_project_grants().lock().unwrap_or_else(|p| p.into_inner()).remove(tab)
}

/// State-backed roots used by spawn.  Unknown project/box scopes return `None`
/// and are refused by the caller.
pub fn roots_for_scope(scope_id: Option<&str>, local_only: bool) -> Option<Vec<PathBuf>> {
    let Some(scope_id) = scope_id else {
        return Some(vec![storage::root_work_dir()]);
    };
    let (boxes, projects) = read_lists();
    let mut roots = compute_fence_roots(&boxes, &projects, scope_id, local_only)?;

    if let Some(box_id) = crate::commands::boxes::box_id_of_scope(scope_id) {
        roots = crate::commands::boxes::box_allowed_roots(box_id)?;
    } else {
        let project = projects.iter().find(|p| p.id == scope_id)?;
        if local_only && project.extra.contains_key("remote") {
            roots[0] = crate::services::remote_sync::mirror_dir(scope_id);
        }
        for b in boxes
            .iter()
            .filter(|b| b.member_ids.iter().any(|id| id == scope_id))
        {
            roots.extend(crate::commands::boxes::box_allowed_roots(&b.id)?);
        }
    }
    Some(dedupe_paths(roots))
}

fn settings() -> crate::schema::Settings {
    storage::read_json(&storage::state_dir().join("settings.json")).unwrap_or_default()
}

/// Whether a local agent started now runs fenced on this machine: a fence
/// exists here and its tool works. What `root_mcp_status`'s `review_enforced`
/// and the phone's root access ask.
pub fn enforced_here() -> bool {
    platform_fenceable() && bwrap_available()
}

pub fn configured_read_only_paths() -> Vec<String> {
    let home = paths::home_dir();
    let settings = settings();
    let mut seen = HashSet::new();
    settings
        .agent_fence_paths()
        .into_iter()
        .filter_map(|raw| {
            let value = raw.trim();
            if value.is_empty() {
                return None;
            }
            let path = if value == "~" {
                home.clone()
            } else if let Some(rest) = value.strip_prefix("~/") {
                home.join(rest)
            } else {
                PathBuf::from(value)
            };
            path.is_absolute()
                .then(|| path.to_string_lossy().into_owned())
        })
        .filter(|p| seen.insert(p.clone()))
        .collect()
}

/// Directories the fence must restore read-only for `cmd` to be launchable
/// at all: the directory the command is found in on `path_dirs`, plus the
/// directory of every symlink hop down to the real executable. The empty home
/// tmpfs hides everything under `home`, so an installer's `~/.local/bin/claude`
/// → `~/.local/share/claude/versions/<v>` link would otherwise dangle inside
/// the sandbox and `bwrap` fails with `execvp claude: No such file or
/// directory`. Only hops under `home` matter (the host root is already visible
/// read-only), and directories already covered by `visible` are skipped.
///
/// A script's `#!` interpreter is followed the same way, and a Python entry
/// point in a venv (`uv tool`, pipx — Mistral's `vibe`) brings the whole venv
/// plus the base interpreter's prefix from `pyvenv.cfg`: the venv's
/// `bin/python` links into `~/.local/share/uv/python/…`, and without it the
/// kernel reports the missing interpreter as the script itself not found.
///
/// Pure over the filesystem: it reads links but never mounts anything, and a
/// command that cannot be found on the host yields nothing — bubblewrap then
/// reports the same not-found error the shell would.
#[cfg(any(target_os = "linux", target_os = "macos", all(test, unix)))]
pub(crate) fn command_bind_paths(
    cmd: &str,
    path_dirs: &[PathBuf],
    home: &Path,
    visible: &[String],
) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    collect_command_bind_paths(cmd, path_dirs, home, visible, &mut out, 0);
    // A venv root makes its own `bin/` hop redundant.
    let all = out.clone();
    out.retain(|d| !all.iter().any(|o| o != d && Path::new(d).starts_with(o)));
    out
}

#[cfg(any(target_os = "linux", target_os = "macos", all(test, unix)))]
fn collect_command_bind_paths(
    cmd: &str,
    path_dirs: &[PathBuf],
    home: &Path,
    visible: &[String],
    out: &mut Vec<String>,
    depth: usize,
) {
    let start = if cmd.contains('/') {
        Some(PathBuf::from(cmd))
    } else {
        path_dirs
            .iter()
            .map(|dir| dir.join(cmd))
            .find(|cand| cand.is_file())
    };
    let Some(mut cur) = start else {
        return;
    };
    let push = |dir: &Path, out: &mut Vec<String>| {
        let covered = visible
            .iter()
            .any(|v| dir == Path::new(v) || dir.starts_with(v));
        if dir.starts_with(home) && dir != home && !covered {
            let dir = dir.to_string_lossy().into_owned();
            if !out.contains(&dir) {
                out.push(dir);
            }
        }
    };
    // A symlink loop is not launchable anyway; bound the walk instead of hanging.
    for _ in 0..40 {
        if let Some(dir) = cur.parent() {
            push(dir, out);
        }
        match std::fs::read_link(&cur) {
            Ok(target) if target.is_absolute() => cur = target,
            Ok(target) => {
                cur = normalize_lexically(
                    &cur.parent().map(|d| d.join(&target)).unwrap_or(target),
                );
            }
            Err(_) => break,
        }
    }
    if let Some(venv) = python_venv_root(&cur) {
        push(&venv, out);
        if let Some(prefix) = venv_base_prefix(&venv, home) {
            push(&prefix, out);
        }
    }
    // `#!/usr/bin/env node` → `node`; an interpreter chain deeper than this
    // is not something an installer writes.
    if depth < 4 {
        if let Some(interp) = shebang_interpreter(&cur) {
            collect_command_bind_paths(&interp, path_dirs, home, visible, out, depth + 1);
        }
    }
}

/// `<venv>` when `exe` sits in `<venv>/bin` next to a `pyvenv.cfg`.
#[cfg(any(target_os = "linux", target_os = "macos", all(test, unix)))]
fn python_venv_root(exe: &Path) -> Option<PathBuf> {
    let bin = exe.parent()?;
    let venv = bin.parent()?;
    (bin.file_name()? == "bin" && venv.join("pyvenv.cfg").is_file()).then(|| venv.to_path_buf())
}

/// The base interpreter's install prefix (`home = <prefix>/bin` in
/// `pyvenv.cfg`): its stdlib sits in `<prefix>/lib`. Never the home itself or
/// `~/.local`, which a venv made from a `pip --user` Python would name.
#[cfg(any(target_os = "linux", target_os = "macos", all(test, unix)))]
fn venv_base_prefix(venv: &Path, home: &Path) -> Option<PathBuf> {
    let cfg = std::fs::read_to_string(venv.join("pyvenv.cfg")).ok()?;
    let bin = cfg.lines().find_map(|line| {
        let (key, value) = line.split_once('=')?;
        (key.trim() == "home").then(|| PathBuf::from(value.trim()))
    })?;
    let prefix = if bin.file_name()? == "bin" { bin.parent()? } else { &bin };
    (prefix.is_absolute() && prefix != home && prefix != home.join(".local"))
        .then(|| prefix.to_path_buf())
}

/// The interpreter a `#!` script names, as a path or (behind `env`) a bare
/// command for `path_dirs`. Anything that is not a script yields nothing.
#[cfg(any(target_os = "linux", target_os = "macos", all(test, unix)))]
fn shebang_interpreter(exe: &Path) -> Option<String> {
    use std::io::Read;
    let mut head = [0u8; 256];
    let n = std::fs::File::open(exe).ok()?.read(&mut head).ok()?;
    let line = head[..n].strip_prefix(b"#!")?;
    let line = &line[..line.iter().position(|b| *b == b'\n').unwrap_or(line.len())];
    let line = std::str::from_utf8(line).ok()?;
    let mut words = line.split_whitespace();
    let interp = words.next()?;
    if basename(interp) == "env" {
        words.find(|w| !w.starts_with('-') && !w.contains('=')).map(str::to_string)
    } else {
        Some(interp.to_string())
    }
}

/// Collapse `.` and `..` without touching the filesystem, so a relative link
/// target like `../share/claude/versions/2.1.251` yields a clean mount path.
#[cfg(any(target_os = "linux", target_os = "macos", all(test, unix)))]
fn normalize_lexically(path: &Path) -> PathBuf {
    use std::path::Component;
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// PATH as the fenced command will see it: an explicit per-tab override wins,
/// otherwise the launcher-augmented PATH the PTY is spawned with.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn command_search_dirs(opts: &PtyOptions) -> Vec<PathBuf> {
    let path = opts
        .env
        .get("PATH")
        .map(std::ffi::OsString::from)
        .or_else(paths::effective_path)
        .unwrap_or_default();
    // The shell-tab shims are not the CLI; the real install is what gets bound.
    let shims = crate::services::agent_bin::bin_dir();
    std::env::split_paths(&path).filter(|d| *d != shims).collect()
}

/// Cache successful probes only: installing/unblocking the tool must let the
/// next tab start without restarting Tabtivity. Serialize probes across callers.
#[cfg(any(target_os = "linux", target_os = "macos", test))]
fn probe_until_available(cache: &Mutex<bool>, probe: impl FnOnce() -> bool) -> bool {
    let mut available = cache.lock().unwrap_or_else(|e| e.into_inner());
    if !*available {
        *available = probe();
    }
    *available
}

/// Probe the actual unprivileged sandbox operation, rather than merely
/// checking that a binary named `bwrap` exists. On macOS the probe is the
/// equivalent `sandbox-exec` no-op profile (the tool ships with the OS, but a
/// managed Mac can have it policy-blocked). The name is kept for the frontend's
/// `bwrap_available` field, which on macOS means "sandbox-exec works".
pub fn bwrap_available() -> bool {
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        false
    }
    #[cfg(target_os = "macos")]
    {
        static AVAILABLE: Mutex<bool> = Mutex::new(false);
        probe_until_available(&AVAILABLE, || {
            crate::paths::command_no_window("/usr/bin/sandbox-exec")
                .args(["-p", "(version 1)(allow default)", "/usr/bin/true"])
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        })
    }
    #[cfg(target_os = "linux")]
    {
        static AVAILABLE: Mutex<bool> = Mutex::new(false);
        probe_until_available(&AVAILABLE, || {
            // Root-owned system copy only (#861): a `bwrap` planted in a
            // user-writable PATH dir would be the fence itself. None: closed.
            let Some(bwrap) = crate::paths::system_executable("bwrap") else {
                return false;
            };
            let probe = crate::paths::command_no_window(bwrap)
                .args([
                    "--ro-bind",
                    "/",
                    "/",
                    "--dev",
                    "/dev",
                    "--proc",
                    "/proc",
                    "--unshare-pid",
                    "--die-with-parent",
                    "--",
                    "/bin/true",
                ])
                .output();
            match probe {
                Ok(out) if out.status.success() => true,
                Ok(out) => {
                    report_probe_failure(&String::from_utf8_lossy(&out.stderr));
                    false
                }
                Err(e) => {
                    report_probe_failure(&e.to_string());
                    false
                }
            }
        })
    }
}

/// Say once per process why a `bwrap` that *exists* still could not sandbox —
/// on stderr, which is the window's log or the sidecar's journal. The refusal
/// the user sees stays the install advice, which is right for the common case;
/// this is for the other one, where the binary is fine and the *process* is
/// not, and nothing else in the log would ever say so.
#[cfg(target_os = "linux")]
fn report_probe_failure(stderr: &str) {
    static REPORTED: std::sync::Once = std::sync::Once::new();
    REPORTED.call_once(|| {
        let label = std::fs::read_to_string("/proc/self/attr/current").ok();
        eprintln!("agent_fence: {}", probe_failure_note(stderr, label.as_deref()));
    });
}

/// The log line for a failed probe: bwrap's own words and this process's
/// AppArmor label. A label under Ubuntu's `unprivileged_userns` profile is
/// named for what it is — the process already sits in a user namespace that
/// denies every capability (a systemd unit with a mount-namespace directive
/// puts a user service there, see `commands::mobile_control::systemd_unit`),
/// so no bwrap it spawns can ever create a sandbox, whatever is installed.
#[cfg(any(target_os = "linux", test))]
pub(crate) fn probe_failure_note(stderr: &str, apparmor_label: Option<&str>) -> String {
    let detail = match stderr.trim() {
        "" => "no output",
        words => words,
    };
    let label = apparmor_label
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .unwrap_or("unknown");
    let mut note = format!(
        "bubblewrap is installed but its probe failed (AppArmor label of this process: {label}): {detail}"
    );
    if label.contains("unprivileged_userns") {
        note.push_str(
            " — this process already runs inside a user namespace AppArmor confines, so nothing it starts can create a sandbox; a systemd user unit with a mount-namespace directive (ProtectSystem=, ProtectHome=, PrivateTmp=, …) lands there on Ubuntu",
        );
    }
    note
}

#[cfg(any(target_os = "linux", target_os = "macos", all(test, unix)))]
fn mount_pair(pair: &str, read_only: bool) -> Option<BindMount> {
    let (src, dst) = pair.split_once(':')?;
    Some(BindMount {
        src: src.to_string(),
        dst: dst.to_string(),
        read_only,
    })
}

/// The local-model tabs' own state: `<state_dir>/vibe_local`, where
/// `commands::ollama::prepare_local_agent` writes one `VIBE_HOME` per model
/// (`config.toml` naming the Ollama provider and the active model, `logs/`,
/// `.env`).
///
/// Unmounted it is hidden like everything else under the `$HOME` tmpfs, and a
/// fenced Mistral/vibe tab found no config at all: it fell back to vibe's cloud
/// default and opened asking for `MISTRAL_API_KEY` — "the local model doesn't
/// work", on every fenced scope, most visibly the root console, which has no
/// per-project fence override to turn off.
///
/// Only the spawn's **own** home, and only for a spawn whose `VIBE_HOME` names
/// one ([`local_model_home`]). Mounting the whole directory into every fenced
/// tab let any agent — a Claude tab in some project — plant a hook, tool or
/// config there that the next local-model tab ran, possibly unfenced or in the
/// root console's fence (threat model gap 7). Inside the home, everything
/// vibe loads code, hooks, env, instructions or config from is read-only
/// ([`LOCAL_MODEL_CONTROL`]); vibe keeps writing its logs, history, cache and
/// trusted-folder list beside them.
#[cfg(any(target_os = "linux", target_os = "macos", test))]
pub(crate) fn local_model_mounts(home: Option<&Path>) -> Result<(Vec<BindMount>, Vec<ControlPin>), String> {
    let Some(home) = home else {
        return Ok((Vec::new(), Vec::new()));
    };
    // Tabtivity's hook alone, whatever an earlier tab left in the file. First:
    // the write replaces `hooks.toml`'s inode, and the pins below record the
    // inode that is mounted.
    if let Err(e) = crate::services::agent_session::register_vibe_hook_in(home) {
        eprintln!("agent_fence: reset local vibe hooks: {e}");
    }
    let pins = local_model_control_paths(home)?;
    let path = home.to_string_lossy().into_owned();
    let mut mounts = vec![BindMount {
        src: path.clone(),
        dst: path,
        read_only: false,
    }];
    // Placed after the home mount, so they shadow it.
    mounts.extend(pins.iter().map(|pin| {
        let p = pin.path.to_string_lossy().into_owned();
        BindMount {
            src: p.clone(),
            dst: p,
            read_only: true,
        }
    }));
    Ok((mounts, pins))
}

/// What vibe reads from `VIBE_HOME` that makes it run or trust something:
/// `config.toml` (MCP servers, enabled tools), `hooks.toml`, `.env`,
/// `AGENTS.md`, and the user tool/plugin/skill/agent/prompt dirs.
#[cfg(any(target_os = "linux", target_os = "macos", test))]
const LOCAL_MODEL_CONTROL: &[(&str, bool)] = &[
    ("config.toml", false),
    ("hooks.toml", false),
    (".env", false),
    ("AGENTS.md", false),
    ("tools", true),
    ("plugins", true),
    ("skills", true),
    ("agents", true),
    ("prompts", true),
];

/// One [`LOCAL_MODEL_CONTROL`] path as [`local_model_control_paths`] left it,
/// with the `(device, inode)` its handle saw (`None` on Windows, where this
/// only runs in tests).
#[cfg(any(target_os = "linux", target_os = "macos", test))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ControlPin {
    pub path: PathBuf,
    ino: Option<(u64, u64)>,
}

/// Every [`LOCAL_MODEL_CONTROL`] path in `home`, created empty where missing:
/// a path that doesn't exist can't be mounted read-only, and one the agent
/// could create would be as good as writable. An empty `.env` or `AGENTS.md`
/// changes nothing (vibe skips a blank instructions file).
///
/// Another running tab of the same model can write this folder while the
/// spawn sets it up (gap 30), so every step goes through a handle on `home`
/// (`services::home_io`): a link, FIFO or socket at a control name is
/// unlinked relative to the handle — never followed — and the file or folder
/// made with `O_CREAT | O_NOFOLLOW` / `mkdirat`. Each path's identity comes
/// from a handle opened on it, for [`verify_control_pins`] to compare just
/// before the fence argv is built. Any path that cannot be set up refuses the
/// spawn: an unmounted control path would stay writable to the agent.
#[cfg(any(target_os = "linux", target_os = "macos", test))]
pub(crate) fn local_model_control_paths(home: &Path) -> Result<Vec<ControlPin>, String> {
    let refuse = |what: &Path, why: &dyn std::fmt::Display| {
        format!(
            "Agent sandbox: could not prepare the local model's {} ({why}), so this agent was not started.",
            what.display()
        )
    };
    let dir = crate::services::home_io::HomeDir::open_existing(home, "")
        .ok_or_else(|| refuse(home, &"not a folder"))?;
    let mut out = Vec::new();
    for &(name, is_dir) in LOCAL_MODEL_CONTROL {
        let file = dir.file(name).ok_or_else(|| refuse(&home.join(name), &"bad name"))?;
        let meta = file.ensure(is_dir).map_err(|e| refuse(&file.path(), &e))?;
        out.push(ControlPin { path: file.path(), ino: meta.ino });
    }
    Ok(out)
}

/// Re-`lstat` each pinned control path and refuse unless the inode there is
/// still the one set up (fail closed). bubblewrap and Seatbelt take the paths
/// by name, so this runs as the last step before the fence argv is built; the
/// window between it and the sandbox opening the path remains (gap 30's
/// residual).
#[cfg(any(target_os = "linux", target_os = "macos", test))]
pub(crate) fn verify_control_pins(pins: &[ControlPin]) -> Result<(), String> {
    for pin in pins {
        let now = std::fs::symlink_metadata(&pin.path).ok();
        let same = now.is_some_and(|m| {
            #[cfg(unix)]
            let ino = {
                use std::os::unix::fs::MetadataExt;
                Some((m.dev(), m.ino()))
            };
            #[cfg(not(unix))]
            let ino = None;
            !m.file_type().is_symlink() && ino == pin.ino
        });
        if !same {
            return Err(format!(
                "Agent sandbox: the local model's {} changed while this tab was starting, so this agent was not started. Start it again; if this keeps happening, close the model's other tabs first.",
                pin.path.display()
            ));
        }
    }
    Ok(())
}

/// The spawn's own local-model home: its `VIBE_HOME`, when that is a direct
/// child of `<state_dir>/vibe_local` and an existing directory. The value comes
/// from the renderer, so this is the only shape a read-write mount is built
/// from; anything else mounts nothing.
#[cfg(any(target_os = "linux", target_os = "macos", test))]
pub(crate) fn local_model_home(
    env: &std::collections::HashMap<String, String>,
    state_dir: &Path,
) -> Option<PathBuf> {
    let candidate = PathBuf::from(env.get("VIBE_HOME")?);
    let child = candidate.strip_prefix(state_dir.join("vibe_local")).ok()?;
    let mut parts = child.components();
    let one = matches!(parts.next(), Some(std::path::Component::Normal(_))) && parts.next().is_none();
    let real_dir = std::fs::symlink_metadata(&candidate).is_ok_and(|m| m.is_dir());
    (one && real_dir).then_some(candidate)
}

/// The support mounts every fenced tab gets on top of its scope home
/// (`services::agent_home`, bound over `$HOME`): the scope's own live-session
/// slice at the canonical path the hook script writes, the hook scripts and
/// Tabtivity's commands read-only and the spawn's own local-model home.
/// Everything else an agent keeps — config, transcripts, session stores, its
/// copy of the shared logins — is simply in the home.
#[cfg(any(target_os = "linux", target_os = "macos", all(test, unix)))]
fn agent_state_mounts(
    scope_id: &str,
    env: &std::collections::HashMap<String, String>,
) -> Result<(Vec<BindMount>, Vec<ControlPin>), String> {
    let state_dir = storage::state_dir();
    let live_root = crate::services::agent_session::live_sessions_dir();
    let live_own = crate::services::agent_session::project_live_sessions_dir(scope_id);
    let _ = std::fs::create_dir_all(&live_own);
    let mut mounts = vec![BindMount {
        src: live_own.to_string_lossy().into_owned(),
        dst: live_root.to_string_lossy().into_owned(),
        read_only: false,
    }];
    mounts.extend(
        crate::services::sandbox::ro_mounts_for_hooks(&state_dir.join("hooks"))
            .into_iter()
            .filter_map(|m| mount_pair(&m, true)),
    );
    let (local, pins) = local_model_mounts(local_model_home(env, &state_dir).as_deref())?;
    mounts.extend(local);
    let bin = crate::services::agent_bin::bin_dir();
    let _ = std::fs::create_dir_all(&bin);
    let bin = bin.to_string_lossy().into_owned();
    mounts.push(BindMount { src: bin.clone(), dst: bin, read_only: true });
    // Logins are per-home copies in the home itself (`services::agent_auth`);
    // nothing shared is bound in.
    add_install_mount(&mut mounts, &state_dir);
    Ok((mounts, pins))
}

/// Installs live inside private state, so they must be explicit support mounts
/// restored after the final state mask, not just entries in the early allowlist.
#[cfg(any(target_os = "linux", target_os = "macos", test))]
fn add_install_mount(mounts: &mut Vec<BindMount>, state_dir: &Path) {
    let root = crate::services::agent_install::install_root_in(state_dir);
    if root.is_dir() {
        let root = root.to_string_lossy().into_owned();
        mounts.push(BindMount { src: root.clone(), dst: root, read_only: true });
    }
}

/// Both Cargo credential spellings, including an explicit CARGO_HOME and
/// canonical aliases. Read-only toolchain mounts must not disclose tokens.
#[cfg(any(target_os = "linux", target_os = "macos", test))]
fn cargo_credential_paths(home: &Path, cargo_home: Option<&Path>, cwd: &Path, allow_credentials: bool) -> Vec<String> {
    if allow_credentials {
        return Vec::new();
    }
    let mut homes = vec![home.join(".cargo")];
    if let Some(path) = cargo_home {
        homes.push(if path.is_absolute() { path.to_owned() } else { cwd.join(path) });
    }
    let mut paths = Vec::new();
    for home in homes {
        for name in ["credentials", "credentials.toml"] {
            let path = home.join(name);
            paths.push(path.clone());
            if let Ok(canonical) = path.canonicalize() {
                paths.push(canonical);
            }
        }
    }
    dedupe_paths(paths).into_iter().map(|p| p.to_string_lossy().into_owned()).collect()
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn hidden_cargo_credentials(opts: &PtyOptions) -> Vec<String> {
    let cargo_home = opts.env.get("CARGO_HOME").map(PathBuf::from)
        .or_else(|| std::env::var_os("CARGO_HOME").map(PathBuf::from));
    cargo_credential_paths(&paths::home_dir(), cargo_home.as_deref(), Path::new(&opts.cwd),
        settings().agent_fence_cargo_credentials.unwrap_or(false))
}

#[cfg(any(target_os = "linux", test))]
fn mask_cargo_credentials(args: &mut Vec<String>, hidden: Vec<String>) {
    let separator = args.iter().position(|arg| arg == "--").unwrap();
    let masks = hidden.into_iter()
        .filter(|p| Path::new(p).is_file())
        .flat_map(|path| ["--ro-bind".to_string(), "/dev/null".to_string(), path]);
    args.splice(separator..separator, masks);
}

/// Re-mount the repo's git control files over the read-write roots (#158):
/// each pinned `.git` onto itself first (a mount point cannot be renamed away
/// and replaced by a `gitdir:` pointer), then the control files read-only, so
/// the agent can commit but cannot plant a hook or a `core.fsmonitor` for the
/// next unsandboxed git to run. Placed before `--`, after every root bind.
#[cfg(any(target_os = "linux", test))]
fn guard_git_control(args: &mut Vec<String>, guard: crate::services::git_guard::GuardPaths) {
    let separator = args.iter().position(|arg| arg == "--").unwrap();
    let path = |p: std::path::PathBuf| p.to_string_lossy().into_owned();
    let pins = guard.pinned.into_iter().map(path).flat_map(|p| ["--bind".to_string(), p.clone(), p]);
    let read_only = guard
        .read_only
        .into_iter()
        .map(path)
        .flat_map(|p| ["--ro-bind".to_string(), p.clone(), p]);
    let binds: Vec<String> = pins.chain(read_only).collect();
    args.splice(separator..separator, binds);
}

/// `(audit arch, nr mask, [add_key, request_key, keyctl])` for the native
/// architecture and the 32-bit one its kernel also runs: a 32-bit binary
/// reaches the same keyring through the compat table. x32 is x86-64's `arch`
/// with bit 30 set in `nr` and shares its numbers, hence the mask.
#[cfg(all(any(target_os = "linux", all(test, unix)), target_arch = "x86_64"))]
const KEYRING_SYSCALLS: &[(u32, u32, [u32; 3])] = &[
    (0xC000_003E, 0xBFFF_FFFF, [248, 249, 250]),
    (0x4000_0003, u32::MAX, [286, 287, 288]),
];
#[cfg(all(any(target_os = "linux", all(test, unix)), target_arch = "aarch64"))]
const KEYRING_SYSCALLS: &[(u32, u32, [u32; 3])] = &[
    (0xC000_00B7, u32::MAX, [217, 218, 219]),
    (0x4000_0028, u32::MAX, [309, 310, 311]),
];
#[cfg(all(any(target_os = "linux", all(test, unix)), target_arch = "riscv64"))]
const KEYRING_SYSCALLS: &[(u32, u32, [u32; 3])] = &[(0xC000_00F3, u32::MAX, [217, 218, 219])];
#[cfg(all(
    any(target_os = "linux", all(test, unix)),
    not(any(target_arch = "x86_64", target_arch = "aarch64", target_arch = "riscv64"))
))]
const KEYRING_SYSCALLS: &[(u32, u32, [u32; 3])] = &[];

/// The seccomp program every fenced agent runs under (bwrap `--seccomp`): the
/// kernel keyring syscalls `add_key`, `request_key` and `keyctl` fail with
/// `EPERM`; everything else is allowed. `None` on an architecture without a
/// table, which the fence refuses rather than launching without it.
///
/// Only Tabtivity needs the keyring. Its saved secrets (`remote_credentials`) are
/// cached there in front of the Secret Service, in the login session keyring
/// every process inherits, bubblewrap included. The private `/run` hides the
/// Secret Service's socket but nothing reached by syscall, so without this a
/// fenced agent could read every saved SSH, VPN and mail password and the mail
/// store key. No agent gets a keyring of its own either.
///
/// Classic BPF over `seccomp_data` (`nr` at offset 0, `arch` at 4). An
/// architecture outside the table gets `EPERM` for every syscall.
#[cfg(any(target_os = "linux", all(test, unix)))]
pub(crate) fn keyring_seccomp_filter() -> Option<Vec<u8>> {
    const LD_W_ABS: u16 = 0x20;
    const ALU_AND_K: u16 = 0x54;
    const JMP_JEQ_K: u16 = 0x15;
    const RET_K: u16 = 0x06;
    const ALLOW: u32 = 0x7fff_0000;
    // SECCOMP_RET_ERRNO | EPERM (1). A literal: `libc` is a Unix-only dependency
    // and this also compiles into the Windows test build.
    const EPERM: u32 = 0x0005_0000 | 1;
    fn op(code: u16, jt: u8, jf: u8, k: u32) -> [u8; 8] {
        let mut out = [0u8; 8];
        out[..2].copy_from_slice(&code.to_ne_bytes());
        out[2] = jt;
        out[3] = jf;
        out[4..].copy_from_slice(&k.to_ne_bytes());
        out
    }
    if KEYRING_SYSCALLS.is_empty() {
        return None;
    }
    let mut prog = vec![op(LD_W_ABS, 0, 0, 4)];
    for (arch, mask, nrs) in KEYRING_SYSCALLS {
        let mut body = vec![op(LD_W_ABS, 0, 0, 0)];
        if *mask != u32::MAX {
            body.push(op(ALU_AND_K, 0, 0, *mask));
        }
        // Each match jumps over the checks after it and the allow, onto the deny.
        for (i, nr) in nrs.iter().enumerate() {
            body.push(op(JMP_JEQ_K, (nrs.len() - i) as u8, 0, *nr));
        }
        body.push(op(RET_K, 0, 0, ALLOW));
        body.push(op(RET_K, 0, 0, EPERM));
        // Another architecture skips this block with `arch` still loaded.
        prog.push(op(JMP_JEQ_K, 0, body.len() as u8, *arch));
        prog.extend(body);
    }
    prog.push(op(RET_K, 0, 0, EPERM));
    Some(prog.concat())
}

/// The shell script that hands bwrap the filter: bwrap takes a seccomp program
/// only as a descriptor, and no spawn path here can pass one (portable-pty
/// closes inherited descriptors, tmux starts the command from its server), so
/// the shell opens it at the last moment and `exec`s: the process is bwrap from
/// then on. `$1` is the filter file, `$0` the program, the rest its argv.
#[cfg(any(target_os = "linux", all(test, unix)))]
const SECCOMP_LAUNCHER: &str = "f=$1; shift; exec \"$0\" \"$@\" 9<\"$f\"";

/// `(cmd, args)` that run bwrap with `argv` under [`keyring_seccomp_filter`],
/// through `step` — Tabtivity's binary and its mode, [`launcher_step`] — when
/// there is one; the step execs bwrap with descriptor 9 still open.
#[cfg(any(target_os = "linux", all(test, unix)))]
pub(crate) fn seccomp_launcher(
    bwrap: &str,
    step: Option<(&str, &str)>,
    filter: &Path,
    argv: Vec<String>,
) -> (String, Vec<String>) {
    let filter = filter.to_string_lossy().into_owned();
    let mut args = vec!["-c".to_string(), SECCOMP_LAUNCHER.to_string()];
    match step {
        Some((helper, mode)) => args.extend([helper.to_string(), filter, mode.to_string(), bwrap.to_string()]),
        None => args.extend([bwrap.to_string(), filter]),
    }
    args.extend(["--seccomp".to_string(), "9".to_string()]);
    args.extend(argv);
    ("/bin/sh".to_string(), args)
}

/// The step in front of bwrap, as `(binary, mode)`: `--fence-scope` where this
/// kernel and bwrap take the Landlock scope (it maps carriers too), else
/// `--agent-exec` when the spawn carries a secret for `agent_exec` to map,
/// else none. `scope_helper` is `fence_scope::helper_for`'s answer.
#[cfg(any(target_os = "linux", test))]
pub(crate) fn launcher_step(
    scope_helper: Option<String>,
    carries: bool,
    running_binary: impl FnOnce() -> String,
) -> Option<(String, &'static str)> {
    match scope_helper {
        Some(helper) => Some((helper, "--fence-scope")),
        None if carries => Some((running_binary(), crate::services::agent_exec::MODE_FLAG)),
        None => None,
    }
}

/// Write the filter where the launcher reads it: in the state dir, which the
/// fence masks, rewritten atomically at every spawn so a file edited on disk
/// never becomes the next agent's filter. Fails closed.
#[cfg(target_os = "linux")]
fn write_keyring_filter() -> Result<PathBuf, String> {
    use std::io::Write as _;
    let prog = keyring_seccomp_filter()
        .ok_or_else(|| "Agent sandbox: no keyring filter for this CPU architecture".to_string())?;
    let dir = storage::state_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("Agent sandbox: {e}"))?;
    let path = dir.join("agent-fence-seccomp.bpf");
    let mut tmp = tempfile::NamedTempFile::new_in(&dir).map_err(|e| format!("Agent sandbox: keyring filter: {e}"))?;
    tmp.write_all(&prog).map_err(|e| format!("Agent sandbox: keyring filter: {e}"))?;
    tmp.persist(&path).map_err(|e| format!("Agent sandbox: keyring filter: {e}"))?;
    Ok(path)
}

/// Pure bubblewrap argv builder.  Later mounts intentionally shadow earlier
/// ones: the scope home (or, with no `home_src`, an empty tmpfs) replaces the
/// user's home and hides everything in it, selected toolchain paths and
/// Tabtivity's support dirs are restored, and project/box roots finally become
/// read-write. `~/.cache` is a tmpfs over the home either way.
#[cfg(any(target_os = "linux", test))]
#[allow(clippy::too_many_arguments)]
pub(crate) fn bwrap_args(
    home: &str,
    home_src: Option<&str>,
    cwd: &str,
    cmd: &str,
    cmd_args: &[String],
    roots: &[PathBuf],
    extra_ro: &[String],
    mounts: &[BindMount],
) -> Vec<String> {
    let mut args = vec![
        "--ro-bind".into(),
        "/".into(),
        "/".into(),
        "--dev".into(),
        "/dev".into(),
        "--proc".into(),
        "/proc".into(),
        // The keyring's names (logins, hosts) are listed here even where the
        // seccomp filter denies every keyring call.
        "--ro-bind".into(),
        "/dev/null".into(),
        "/proc/keys".into(),
        "--ro-bind".into(),
        "/dev/null".into(),
        "/proc/key-users".into(),
        "--tmpfs".into(),
        "/tmp".into(),
        "--tmpfs".into(),
        "/run".into(),
        "--ro-bind-try".into(),
        "/run/systemd/resolve".into(),
        "/run/systemd/resolve".into(),
    ];
    match home_src {
        Some(src) => args.extend(["--bind".into(), src.into(), home.into()]),
        None => args.extend(["--tmpfs".into(), home.into()]),
    }
    args.extend(["--tmpfs".into(), format!("{home}/.cache")]);
    for path in extra_ro {
        args.extend(["--ro-bind-try".into(), path.clone(), path.clone()]);
    }
    for mount in mounts {
        args.push(if mount.read_only {
            "--ro-bind".into()
        } else {
            "--bind".into()
        });
        args.push(mount.src.clone());
        args.push(mount.dst.clone());
    }
    for root in roots {
        let root = root.to_string_lossy().into_owned();
        args.extend(["--bind-try".into(), root.clone(), root]);
    }
    args.extend([
        "--unshare-pid".into(),
        "--die-with-parent".into(),
        "--chdir".into(),
        cwd.into(),
        "--".into(),
        cmd.into(),
    ]);
    args.extend(cmd_args.iter().cloned());
    args
}

/// Shadow the whole Tabtivity state tree, including its canonical alias. Explicit
/// tool mounts are restored afterwards; future private files stay hidden too.
#[cfg(any(target_os = "linux", target_os = "macos", test))]
pub(crate) fn private_state_paths(state_dir: &Path) -> Vec<PathBuf> {
    let mut paths = vec![state_dir.to_path_buf()];
    if let Ok(real) = state_dir.canonicalize() { paths.push(real); }
    // A private store may itself be a symlink outside the state tree.
    for name in ["calendar.json", "projects.json", "settings.json", "boxes.json", "root_mcp", "mail",
        "time_summary.json", "usage_stats.json", "remote-projects", "sessions",
        crate::services::agent_global::GLOBAL_DIR] {
        paths.push(state_dir.join(name));
        if let Ok(real) = state_dir.join(name).canonicalize() { paths.push(real); }
    }
    paths.sort(); paths.dedup();
    paths
}

#[cfg(any(target_os = "linux", test))]
fn mask_private_state(args: &mut Vec<String>, state_dir: &Path, mounts: &[BindMount]) {
    let mut mask = Vec::new();
    for path in private_state_paths(state_dir) {
        if path.is_dir() { mask.extend(["--tmpfs".into(), path.to_string_lossy().into_owned()]); }
        else if path.exists() { mask.extend(["--ro-bind".into(), "/dev/null".into(), path.to_string_lossy().into_owned()]); }
    }
    // Only Tabtivity's explicit agent support mounts may pierce the state mask.
    // Project roots and user allowlists are intentionally never restored here.
    for m in mounts.iter().filter(|m| Path::new(&m.dst).starts_with(state_dir)) {
        mask.extend([if m.read_only { "--ro-bind" } else { "--bind" }.into(), m.src.clone(), m.dst.clone()]);
    }
    let separator = args.iter().position(|s| s == "--").unwrap_or(args.len());
    args.splice(separator..separator, mask);
}

/// Rewrite a local agent spawn into its outer bubblewrap boundary.
///
/// The agent's argv passes through untouched. Codex in particular gets no
/// sandbox-backend override: its own bubblewrap cannot nest under this fence
/// on Ubuntu (the stacked `unpriv_bwrap` AppArmor profile denies the uid-map
/// write of a second user namespace), and the Landlock fallback that used to
/// be forced here (`features.use_legacy_landlock`) is deprecated upstream and
/// warns on every start, so Codex is left to report the failed sandbox and
/// ask, as it does anywhere else its sandbox cannot spawn.
#[cfg(target_os = "linux")]
pub fn wrap_pty_options_bwrap(
    opts: &mut PtyOptions,
    roots: &[PathBuf],
    scope_id: &str,
    scope_home: &Path,
) -> Result<(), String> {
    if !bwrap_available() {
        return Err(fence_unavailable_message());
    }
    let bwrap = crate::paths::system_executable("bwrap").ok_or_else(fence_unavailable_message)?;
    // Before `opts.cmd` and `opts.args` become bwrap's below.
    let agent_cmd = opts.cmd.clone();
    let copilot = basename(&agent_cmd) == "copilot";
    let subcommand = runs_subcommand(&opts.args);
    let local_model = crate::services::agent_api_keys::is_local_model(opts);
    let (mounts, control_pins) = agent_state_mounts(scope_id, &opts.env)?;
    let support_mounts = mounts.clone();
    let mut extra_ro = configured_read_only_paths();
    // A root agent's read-only view of the projects (a switch, default off):
    // the same channel as the allowlist, so the state mask below still wins.
    extra_ro.extend(root_project_read_only_paths_for(&opts.id, scope_id));
    let search_dirs = command_search_dirs(opts);
    // The CLI's own install — Tabtivity's (`agent_install`) or the host's — is
    // read-only in the fence, every hop of it: a payload one scope's agent
    // could rewrite would run in every other scope and the user's own shell
    // next. Updates run through Manage CLIs (a reinstall) or outside Tabtivity;
    // the CLI's own updater is switched off below where it has a switch.
    let visible = extra_ro.clone();
    extra_ro.extend(command_bind_paths(
        &agent_cmd,
        &search_dirs,
        &paths::home_dir(),
        &visible,
    ));
    let mut args = bwrap_args(
        &paths::home_dir_string(),
        Some(&scope_home.to_string_lossy()),
        &opts.cwd,
        &opts.cmd,
        &opts.args,
        roots,
        &extra_ro,
        &mounts,
    );
    // Final masks follow every allowlist/project bind, so none re-exposes a
    // token. Missing files need no mask (their parent is read-only/hidden).
    mask_cargo_credentials(&mut args, hidden_cargo_credentials(opts));
    guard_git_control(
        &mut args,
        crate::services::git_guard::guard_paths(roots, Some(Path::new(&opts.cwd))),
    );
    // Last: overlapping roots and allowlists must not reopen private stores.
    mask_private_state(&mut args, &storage::state_dir(), &support_mounts);
    let filter = write_keyring_filter()?;
    opts.env
        .insert(crate::app_env!("AGENT_FENCE").to_string(), "1".to_string());
    // Keep the CLI's login in its file: the keyring is not reachable here.
    crate::services::agent_auth::apply_fence_env(&agent_cmd, &mut opts.env);
    crate::services::agent_install::apply_fence_env(&agent_cmd, &mut opts.env);
    // The fence hides the keyring Copilot signs in through; Tabtivity holds the
    // sign-in for it instead (`copilot_auth`).
    if copilot {
        crate::services::copilot_auth::inject_env(&mut opts.env);
    }
    // A proxy token and base URL for a CLI the user switched on for a key
    // (`agent_api_keys`, `api_proxy`), the token under its app-named carrier.
    // The step in front of bwrap maps it to the CLI's variable (`agent_exec`);
    // bwrap keeps the environment and the launcher `exec`s, so it reaches the
    // CLI. Hence the launcher last: the step is needed whenever the
    // environment carries something.
    let (tab, tmux) = (opts.id.clone(), crate::services::api_proxy::tmux_binding(opts.tmux_session.as_deref()));
    let binding = crate::services::agent_api_keys::Binding { tab: &tab, scope: scope_id, tmux: tmux.as_deref() };
    crate::services::agent_api_keys::inject_env(&agent_cmd, subcommand, local_model, binding, &mut opts.env);
    let step = launcher_step(
        crate::services::fence_scope::helper_for(&bwrap),
        crate::services::agent_exec::has_carriers(&opts.env),
        crate::services::fence_scope::running_binary,
    );
    // Last before the argv: the local model's control paths still hold the
    // inodes set up above (gap 30).
    verify_control_pins(&control_pins)?;
    (opts.cmd, opts.args) = seccomp_launcher(
        &bwrap.to_string_lossy(),
        step.as_ref().map(|(helper, mode)| (helper.as_str(), *mode)),
        &filter,
        args,
    );
    Ok(())
}

/// Everything the macOS profile needs to know, resolved by
/// [`sandbox_exec_inputs`] and rendered by [`sandbox_exec_profile`] — split so
/// the rendering is pure and its invariants are unit tested on any OS.
#[cfg(any(target_os = "macos", test))]
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct SeatbeltInputs {
    pub home: String,
    /// Read-write roots: the project / box member trees.
    pub roots: Vec<String>,
    /// Read-write directories and files outside the roots (agent state the
    /// resume machinery needs, the live-session record, temp dirs).
    pub writable: Vec<String>,
    /// Read-only paths inside `$HOME` that stay visible (everything else under
    /// home is hidden, like the empty home tmpfs on Linux).
    pub readable: Vec<String>,
    /// Paths that must never be written even though a broader allow covers
    /// them: the agents' hook-registration files and the hook scripts.
    pub protected: Vec<String>,
    /// Final read/write denials, after all broad toolchain/root grants.
    pub hidden: Vec<String>,
    /// The scope's own agent home, allowed last: it sits inside the hidden
    /// `agent-homes/` tree, which keeps every other scope's home unreadable.
    pub own_home: Option<String>,
}

/// `HOME` and the pass-throughs a fence that cannot redirect a path sets
/// (macOS Seatbelt, Windows): the agent's home is the scope home, while git's
/// global config and the toolchain homes stay the user's, read-only where the
/// platform can say so. Only variables the user has not set themselves.
pub fn home_env(scope_home: &Path, user_home: &Path) -> Vec<(String, String)> {
    let mut env = vec![("HOME".to_string(), scope_home.to_string_lossy().into_owned())];
    if cfg!(windows) {
        env.push(("USERPROFILE".to_string(), scope_home.to_string_lossy().into_owned()));
    }
    for (var, rel) in [
        ("GIT_CONFIG_GLOBAL", ".gitconfig"),
        ("CARGO_HOME", ".cargo"),
        ("RUSTUP_HOME", ".rustup"),
        ("DOCKER_CONFIG", ".docker"),
    ] {
        let path = user_home.join(rel);
        if path.exists() && std::env::var_os(var).is_none() {
            env.push((var.to_string(), path.to_string_lossy().into_owned()));
        }
    }
    env
}

/// Quote a path for the Seatbelt profile language: a Scheme string literal.
#[cfg(any(target_os = "macos", test))]
fn sbpl_string(path: &str) -> String {
    let mut out = String::with_capacity(path.len() + 2);
    out.push('"');
    for c in path.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Render the Seatbelt profile. Pure.
///
/// What it mirrors from the bubblewrap fence, and what it cannot:
/// - **Writes** are denied everywhere except the roots, the agent's own state
///   dirs, temp, and the live-session record — the same set Linux bind-mounts
///   read-write. Rules are evaluated last-match-wins, so the per-file
///   `protected` denials come after the directory allows that would otherwise
///   cover them.
/// - **Reads** under `$HOME` are denied except the listed `readable` paths and
///   the roots, which is the empty-home posture Linux gets from a tmpfs. The
///   home directory's own metadata stays readable so path resolution works.
/// - **Not mirrored:** the writable *shadow copies* of the hook-registration
///   files. Seatbelt can allow or deny a path but cannot redirect one, so those
///   files are simply read-only here — an agent that tries to rewrite its own
///   `settings.json` gets `EPERM` and carries on, rather than writing into a
///   throwaway copy. The hook scripts they point at are read-only in both.
/// - **Devices** fall under the write denial like any other path, except the
///   handful every ordinary tool writes to: `/dev/null` and `/dev/zero`, the
///   controlling terminal `/dev/tty` (git and ssh prompt through it),
///   `/dev/dtracehelper`, and `/dev/fd/*` (process substitution). Other
///   terminals' `/dev/ttys*` stay denied on purpose — allowing them would let a
///   fenced agent write into *another* tab's terminal. The agent's own PTY is an
///   inherited descriptor and needs no path rule.
/// - Network and process spawning are left at the platform default, as
///   bubblewrap leaves them (it unshares only the pid namespace).
#[cfg(any(target_os = "macos", test))]
const SEATBELT_DEVICE_WRITES: &str = "(allow file-write* (literal \"/dev/null\") (literal \"/dev/zero\") (literal \"/dev/tty\") (literal \"/dev/dtracehelper\") (subpath \"/dev/fd\"))\n";

#[cfg(any(target_os = "macos", test))]
pub(crate) fn sandbox_exec_profile(inputs: &SeatbeltInputs) -> String {
    let mut p = String::from("(version 1)\n(allow default)\n");
    // Reads: hide $HOME, then restore what the agent needs to see.
    p.push_str(&format!(
        "(deny file-read* (subpath {}))\n(allow file-read-metadata (literal {}))\n",
        sbpl_string(&inputs.home),
        sbpl_string(&inputs.home)
    ));
    for path in inputs.readable.iter().chain(&inputs.roots).chain(&inputs.writable) {
        p.push_str(&format!("(allow file-read* (subpath {}))\n", sbpl_string(path)));
    }
    // Writes: nothing, then the roots and the agent's own state.
    p.push_str("(deny file-write*)\n");
    p.push_str(SEATBELT_DEVICE_WRITES);
    for path in inputs.roots.iter().chain(&inputs.writable) {
        p.push_str(&format!("(allow file-write* (subpath {}))\n", sbpl_string(path)));
    }
    // Last, so they win over the directory allows above.
    for path in &inputs.protected {
        p.push_str(&format!(
            "(deny file-write* (subpath {}))\n",
            sbpl_string(path)
        ));
    }
    for path in &inputs.hidden {
        p.push_str(&format!("(deny file-read* file-write* (subpath {}))\n", sbpl_string(path)));
    }
    if let Some(home) = &inputs.own_home {
        p.push_str(&format!("(allow file-read* file-write* (subpath {}))\n", sbpl_string(home)));
    }
    p
}

/// Resolve the profile inputs for a scope from the same mount planners the
/// bubblewrap fence uses, so the two fences agree on what an agent may touch.
#[cfg(target_os = "macos")]
fn sandbox_exec_inputs(
    opts: &PtyOptions,
    roots: &[PathBuf],
    scope_id: &str,
    scope_home: &Path,
) -> Result<(SeatbeltInputs, Vec<ControlPin>), String> {
    let home = paths::home_dir_string();
    let state_dir = storage::state_dir();
    let (mounts, control_pins) = agent_state_mounts(scope_id, &opts.env)?;
    let mut writable: Vec<String> = Vec::new();
    let mut readable: Vec<String> = Vec::new();
    let mut protected: Vec<String> = Vec::new();
    for mount in &mounts {
        // Seatbelt cannot substitute a path: the agent reaches the store dirs
        // through the symlinks `agent_auth` puts in its home, so the sources
        // are what needs allowing.
        if mount.read_only {
            readable.push(mount.src.clone());
        } else {
            writable.push(mount.src.clone());
        }
    }
    protected.push(state_dir.join("hooks").to_string_lossy().into_owned());
    // A local-model home is writable, its control files are not (gap 7):
    // Seatbelt has no mount order, so a read-only path inside a writable one
    // has to be denied explicitly. The same paths `agent_state_mounts` set up.
    protected.extend(control_pins.iter().map(|pin| pin.path.to_string_lossy().into_owned()));
    protected.push(crate::services::agent_bin::bin_dir().to_string_lossy().into_owned());
    // Temp dirs: macOS gives each user a private one under /var/folders.
    for tmp in ["/private/tmp", "/tmp", "/private/var/folders", "/var/folders"] {
        writable.push(tmp.to_string());
    }
    if let Some(dir) = std::env::var_os("TMPDIR") {
        writable.push(dir.to_string_lossy().into_owned());
    }
    readable.extend(configured_read_only_paths());
    readable.extend(root_project_read_only_paths_for(&opts.id, scope_id));
    readable.extend(crate::services::agent_install::fence_read_only_paths());
    let search_dirs = command_search_dirs(opts);
    // The CLI's own install is read-only here as on Linux, whoever installed
    // it; its updater is switched off where it has a switch.
    let visible = readable.clone();
    readable.extend(command_bind_paths(
        &opts.cmd,
        &search_dirs,
        &paths::home_dir(),
        &visible,
    ));
    let homes_root = crate::services::agent_home::homes_root_in(&state_dir);
    let inputs = SeatbeltInputs {
        home,
        roots: roots.iter().map(|r| r.to_string_lossy().into_owned()).collect(),
        writable,
        readable,
        protected,
        hidden: hidden_cargo_credentials(opts).into_iter().chain(
            private_state_paths(&state_dir).into_iter().filter(|p| {
                // Deny private children on macOS: Seatbelt cannot restore a
                // tool mount through a final deny of the whole state directory.
                p != &state_dir && state_dir.canonicalize().as_ref().ok() != Some(p)
            }).map(|p| p.to_string_lossy().into_owned())
        ).chain(std::iter::once(homes_root.to_string_lossy().into_owned())).collect(),
        own_home: Some(scope_home.to_string_lossy().into_owned()),
    };
    Ok((inputs, control_pins))
}

/// Rewrite a local agent spawn into its `sandbox-exec` boundary (macOS). The
/// profile is written per scope under the sandbox stage dir and handed to
/// `sandbox-exec -f`; the command is resolved to an absolute path first so the
/// exec inside the sandbox never depends on PATH lookup.
#[cfg(target_os = "macos")]
pub fn wrap_pty_options_sandbox_exec(
    opts: &mut PtyOptions,
    roots: &[PathBuf],
    scope_id: &str,
    scope_home: &Path,
) -> Result<(), String> {
    if !bwrap_available() {
        return Err(
            "Agent sandbox: sandbox-exec is unavailable on this Mac, so this agent was not started. Open the project in a container, or use a Host session from the root console."
                .to_string(),
        );
    }
    // Before `opts.args` becomes sandbox-exec's below.
    let subcommand = runs_subcommand(&opts.args);
    let local_model = crate::services::agent_api_keys::is_local_model(opts);
    let (inputs, control_pins) = sandbox_exec_inputs(opts, roots, scope_id, scope_home)?;
    let profile = sandbox_exec_profile(&inputs);
    let stage = crate::services::sandbox::stage_dir(scope_id);
    std::fs::create_dir_all(&stage).map_err(|e| format!("Agent sandbox: {e}"))?;
    let profile_path = stage.join("fence.sb");
    std::fs::write(&profile_path, profile).map_err(|e| format!("Agent sandbox: {e}"))?;
    let resolved = if opts.cmd.contains('/') {
        PathBuf::from(&opts.cmd)
    } else {
        paths::resolve_executable(&opts.cmd).unwrap_or_else(|| PathBuf::from(&opts.cmd))
    };
    // Last before the argv: the local model's control paths still hold the
    // inodes set up above (gap 30).
    verify_control_pins(&control_pins)?;
    let mut args = vec![
        "-f".to_string(),
        profile_path.to_string_lossy().into_owned(),
        resolved.to_string_lossy().into_owned(),
    ];
    args.extend(opts.args.iter().cloned());
    let agent_cmd = opts.cmd.clone();
    opts.cmd = "/usr/bin/sandbox-exec".to_string();
    opts.args = args;
    opts.env
        .insert(crate::app_env!("AGENT_FENCE").to_string(), "1".to_string());
    // Seatbelt cannot redirect a path: the agent's home is the scope home by
    // environment, with the user's git config and toolchains passed through.
    for (k, v) in home_env(scope_home, &paths::home_dir()) {
        opts.env.entry(k).or_insert(v);
    }
    crate::services::agent_auth::apply_fence_env(&agent_cmd, &mut opts.env);
    crate::services::agent_install::apply_fence_env(&agent_cmd, &mut opts.env);
    // A proxy token and base URL for a CLI the user switched on for a key
    // (`agent_api_keys`, `api_proxy`), the token under its app-named carrier;
    // `agent_exec` in front of sandbox-exec maps it to the CLI's variable, and
    // sandbox-exec passes the environment through. The step runs outside the
    // Seatbelt profile, which need not grant Tabtivity's binary.
    let (tab, tmux) = (opts.id.clone(), crate::services::api_proxy::tmux_binding(opts.tmux_session.as_deref()));
    let binding = crate::services::agent_api_keys::Binding { tab: &tab, scope: scope_id, tmux: tmux.as_deref() };
    crate::services::agent_api_keys::inject_env(&agent_cmd, subcommand, local_model, binding, &mut opts.env);
    crate::services::agent_exec::wrap(opts)?;
    Ok(())
}

/// Whether an agent launch runs one of the CLI's subcommands (`claude auth
/// login`, a sign-in tab) rather than a session: its first argument is not a
/// flag. The session flags Tabtivity adds (`--add-dir`, `--remote-control`,
/// `--name`) belong to the session command, and a subcommand refuses them.
pub fn runs_subcommand(args: &[String]) -> bool {
    args.first().is_some_and(|arg| !arg.starts_with('-'))
}

pub fn box_root_arg(cmd: &str) -> Option<&'static str> {
    match basename(cmd) {
        "claude" => Some("--add-dir"),
        "gemini" => Some("--include-directories"),
        _ => None,
    }
}

/// Add agent-native working roots without duplicating an existing flag/value.
/// Codex's `--add-dir` asks for extra writable roots and is ignored with a
/// warning under read-only or managed permissions. Its mode belongs to Codex,
/// so the outer fence supplies box access without adding that flag.
pub fn add_box_root_args(opts: &mut PtyOptions, roots: &[PathBuf], own_dir: &Path) {
    if roots.len() <= 1 || runs_subcommand(&opts.args) {
        return;
    }
    let Some(flag) = box_root_arg(&opts.cmd) else {
        return;
    };
    for root in roots.iter().filter(|root| root.as_path() != own_dir) {
        let value = root.to_string_lossy().into_owned();
        let already = opts
            .args
            .windows(2)
            .any(|pair| pair[0] == flag && pair[1] == value);
        if !already {
            opts.args.push(flag.to_string());
            opts.args.push(value);
        }
    }
}

fn platform_reason() -> &'static str {
    if cfg!(windows) {
        "Windows"
    } else {
        "this platform"
    }
}

pub fn status_for_scope(scope_id: &str) -> AgentFenceStatus {
    let mut opts = PtyOptions {
        id: "agent-fence-status".to_string(),
        cmd: "claude".to_string(),
        args: Vec::new(),
        env: HashMap::new(),
        cwd: String::new(),
        cols: 80,
        rows: 24,
        local_only: false,
        sandbox: false,
        agent: true,
        project_id: Some(scope_id.to_string()),
        remote_host_id: None,
        tmux_session: None,
        tmux_attach: None,
        host_bound_uid: None,
        local_model: false,
        schedule_target_id: None,
        host_session: false,
    };
    crate::services::sandbox::enforce_spawn_authority(&mut opts);
    let remote_run =
        !opts.local_only && crate::services::remote::remote_target_for(scope_id).is_some();
    let roots = roots_for_scope(Some(scope_id), opts.local_only);
    let root_strings = roots
        .as_ref()
        .map(|r| r.iter().map(|p| p.to_string_lossy().into_owned()).collect())
        .unwrap_or_default();
    let available = bwrap_available();
    let install_cmd = if available { None } else { fence_install_cmd() };
    let Some(roots) = roots else {
        return AgentFenceStatus {
            enforced: false,
            reason: "unknown project or box".to_string(),
            roots: root_strings,
            bwrap_available: available,
            install_cmd,
        };
    };
    let decision = decide(
        &opts,
        roots,
        remote_run,
        platform_fenceable(),
        platform_accepted(),
        available,
    );
    let (enforced, reason) = match decision {
        FenceDecision::Fenced { .. } => (true, "enforced".to_string()),
        // Accepted or not, the pill states the same fact; the acceptance is
        // asked for at spawn, where declining still has a tab to write into.
        FenceDecision::NotApplicable { reason: "platform" }
        | FenceDecision::PlatformUnaccepted => (false, platform_reason().to_string()),
        FenceDecision::NotApplicable { reason } => (false, reason.to_string()),
        FenceDecision::Unavailable => (false, format!("{} unavailable", fence_tool_name())),
    };
    AgentFenceStatus {
        enforced,
        reason,
        roots: root_strings,
        bwrap_available: available,
        install_cmd,
    }
}

/// One PTY id's spawn generations (gap 18). Ids are reused: a pane remount
/// respawns the same id while the unmount's kill may still be on its way, and
/// that kill's teardown used to clear the respawn's fence registration, its
/// API proxy tokens and its turn binding. Every spawn now gets a sequence
/// number when [`begin_spawn`] runs (in `launch_prep::prepare`, before any
/// grant), and every teardown names the spawn it ends ([`on_tab_gone`]).
#[derive(Default)]
struct TabSpawns {
    /// The newest spawn begun for the id, committed or not.
    latest: u64,
    /// The spawn whose process exists ([`register_tab`]).
    live: Option<LiveSpawn>,
}

struct LiveSpawn {
    seq: u64,
    /// The fence scope it runs in; `None` for an unfenced tab.
    scope_id: Option<String>,
}

fn tab_spawns() -> &'static Mutex<HashMap<String, TabSpawns>> {
    static TABS: OnceLock<Mutex<HashMap<String, TabSpawns>>> = OnceLock::new();
    TABS.get_or_init(|| Mutex::new(HashMap::new()))
}

static SPAWN_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// A fresh spawn sequence number, never 0. The PTY's output route uses the
/// same number (`terminal::spawn_pty`), so the reader task's end names the
/// spawn it belonged to.
pub fn next_spawn_seq() -> u64 {
    SPAWN_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1
}

/// A spawn of `tab_id` starts: from here on a teardown of any earlier spawn
/// of the id leaves the shared per-tab state alone. Returns the spawn's
/// sequence number, which the PTY entry, [`register_tab`] and the teardown
/// carry. A spawn that never commits hands it back through [`abandon_spawn`].
pub fn begin_spawn(tab_id: &str) -> u64 {
    let seq = next_spawn_seq();
    tab_spawns()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .entry(tab_id.to_string())
        .or_default()
        .latest = seq;
    seq
}

/// The process of spawn `seq` exists; `scope_id` is the fence scope it runs
/// in (`None`: unfenced). Whether `seq` is still the tab's newest spawn —
/// `false` when it was torn down already or a newer spawn has begun, and then
/// nothing is recorded.
pub fn register_tab(tab_id: &str, scope_id: Option<&str>, seq: u64) -> bool {
    match tab_spawns().lock().unwrap_or_else(|e| e.into_inner()).get_mut(tab_id) {
        Some(spawns) if spawns.latest == seq => {
            spawns.live = Some(LiveSpawn { seq, scope_id: scope_id.map(str::to_string) });
            true
        }
        _ => false,
    }
}

/// Whether spawn `seq` is still the newest one begun for `tab_id` and not torn
/// down. A spawn that is not may not put its process in the PTY registry
/// (`PtyRegistry::insert_current_spawn`): a newer spawn of the id owns the
/// tab's grants.
pub fn is_current_spawn(tab_id: &str, seq: u64) -> bool {
    tab_spawns()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(tab_id)
        .is_some_and(|s| s.latest == seq)
}

/// Spawn `seq` failed before its process existed: the id falls back to the
/// spawn still live under it, or, with none, is gone (its proxy tokens too).
/// Whether the id is gone — then the caller ends its MCP tokens and turn
/// binding as well (`launch_prep::SpawnGeneration`), as no later kill finds a
/// PTY to tear down.
pub fn abandon_spawn(tab_id: &str, seq: u64) -> bool {
    let mut map = tab_spawns().lock().unwrap_or_else(|e| e.into_inner());
    let Some(spawns) = map.get_mut(tab_id) else { return false };
    if spawns.latest != seq {
        return false;
    }
    if let Some(live) = spawns.live.as_ref().map(|l| l.seq) {
        spawns.latest = live;
        return false;
    }
    map.remove(tab_id);
    drop(map);
    untrack_host_agent_tab(tab_id);
    crate::services::api_proxy::on_tab_gone(tab_id);
    true
}

/// The scope the live spawn of a fenced tab runs in.
#[cfg(test)]
pub(crate) fn fenced_scope_of_tab(tab_id: &str) -> Option<String> {
    tab_spawns()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(tab_id)
        .and_then(|s| s.live.as_ref())
        .and_then(|l| l.scope_id.clone())
}

/// A one-shot command inside the fence of `scope_id`, for work Tabtivity runs on
/// a fenced tab's behalf (an agent-requested push's `pre-push` preflight,
/// `services::git_push_mcp`). Built from the same primitives as the tab's own
/// boundary — project and box roots read-write, the allowlist read-only, the
/// git control files guarded, Cargo credentials and the private state masked —
/// but *narrower*: no agent home, live-session or launcher mounts, and none of
/// the per-tab registry state the PTY wrapper keeps. Fails closed like the
/// rest of the fence: no working bubblewrap, no command. Linux only; other
/// platforms answer the same refusal.
#[cfg(target_os = "linux")]
pub fn one_shot_command(scope_id: &str, cmd: &str, args: &[String], cwd: &Path) -> Result<std::process::Command, String> {
    if !bwrap_available() {
        return Err(fence_unavailable_message());
    }
    let bwrap = crate::paths::system_executable("bwrap").ok_or_else(fence_unavailable_message)?;
    let roots = roots_for_scope((scope_id != ROOT_SCOPE).then_some(scope_id), false)
        .ok_or_else(|| format!("Agent sandbox: unknown project or box scope '{scope_id}'"))?;
    let extra_ro = configured_read_only_paths();
    let home = paths::home_dir();
    let mut argv = bwrap_args(
        &paths::home_dir_string(),
        None,
        &cwd.to_string_lossy(),
        cmd,
        args,
        &roots,
        &extra_ro,
        &[],
    );
    let cargo_home = std::env::var_os("CARGO_HOME").map(PathBuf::from);
    mask_cargo_credentials(&mut argv, cargo_credential_paths(&home, cargo_home.as_deref(), cwd,
        settings().agent_fence_cargo_credentials.unwrap_or(false)));
    guard_git_control(&mut argv, crate::services::git_guard::guard_paths(&roots, Some(cwd)));
    mask_private_state(&mut argv, &storage::state_dir(), &[]);
    let filter = write_keyring_filter()?;
    let scope = crate::services::fence_scope::helper_for(&bwrap);
    let step = scope.as_deref().map(|helper| (helper, "--fence-scope"));
    let (cmd, argv) = seccomp_launcher(&bwrap.to_string_lossy(), step, &filter, argv);
    let mut command = crate::paths::command_no_window(cmd);
    command.args(argv);
    command.env(crate::app_env!("AGENT_FENCE"), "1");
    Ok(command)
}

#[cfg(not(target_os = "linux"))]
pub fn one_shot_command(_scope_id: &str, _cmd: &str, _args: &[String], _cwd: &Path) -> Result<std::process::Command, String> {
    Err(fence_unavailable_message())
}

/// Spawn `seq` of `tab_id` is gone (closed, exited, or the app is quitting).
/// Only the tab's newest spawn takes the shared per-tab state with it: its
/// registration, its host-agent tracking and its API proxy tokens. A stale
/// teardown — a kill that lands after a respawn of the same id began — only
/// forgets its own registration and answers `false`, and the caller then
/// leaves the tab's MCP tokens and turn binding alone too
/// (`launch_prep::on_tab_gone`). An id with nothing registered counts as
/// current: no spawn of it is in flight.
pub fn on_tab_gone(tab_id: &str, seq: u64) -> bool {
    let removed = {
        let mut map = tab_spawns().lock().unwrap_or_else(|e| e.into_inner());
        match map.get_mut(tab_id) {
            None => None,
            Some(spawns) if spawns.latest == seq => map.remove(tab_id).and_then(|s| s.live),
            Some(spawns) => {
                if spawns.live.as_ref().is_some_and(|l| l.seq == seq) {
                    spawns.live = None;
                }
                return false;
            }
        }
    };
    let was_fenced = removed.is_some_and(|l| l.scope_id.is_some());
    untrack_host_agent_tab(tab_id);
    // Its API proxy tokens go with it (those of a tmux-held agent once the
    // session is gone too).
    crate::services::api_proxy::on_tab_gone(tab_id);
    // A tab's end is when a login it made lands in its home: carry it to the
    // other scopes now rather than at the keeper's next tick. Off-thread —
    // this runs on the PTY's teardown path.
    if was_fenced {
        std::thread::spawn(crate::services::agent_auth::reconcile_now);
    }
    true
}

/// A local agent tab whose agent runs on the host — not in a container, not on
/// a remote — tracked whatever the spawn decided about the fence. The decision
/// is not the answer: a respawn onto a surviving local tmux session
/// (`new-session -A`) reattaches the process already running there, so a tab
/// started before the fence was switched on stays unfenced through every
/// relaunch. [`live_unfenced_by_scope`] asks the process itself.
#[derive(Debug, Clone)]
pub struct HostAgentTab {
    pub scope_id: String,
    /// The agent command before any wrapping, matched against the processes
    /// under the tab.
    pub agent_cmd: String,
    pub tmux_session: Option<String>,
}

fn host_agent_tabs() -> &'static Mutex<HashMap<String, HostAgentTab>> {
    static TABS: OnceLock<Mutex<HashMap<String, HostAgentTab>>> = OnceLock::new();
    TABS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn track_host_agent_tab(tab_id: &str, tab: HostAgentTab) {
    host_agent_tabs().lock().unwrap().insert(tab_id.to_string(), tab);
}

/// A respawn under the same id that no longer runs an agent on the host (it
/// moved into a container, or became a shell) must stop being counted.
pub fn untrack_host_agent_tab(tab_id: &str) {
    host_agent_tabs().lock().unwrap().remove(tab_id);
}

/// What one tab's agent process turned out to be.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LiveFence {
    Fenced,
    Unfenced,
    /// No process of the agent under the tab: it exited, or it has not
    /// started yet. Not counted either way.
    Idle,
}

/// One process under a tab's root, reduced to what [`classify_live`] reads.
#[derive(Debug, Clone)]
pub struct ProcView {
    pub argv0: String,
    pub argv1: Option<String>,
    /// Whether it runs in Tabtivity's own mount namespace. bubblewrap always
    /// unshares it, so a fenced agent never does.
    pub host_ns: bool,
}

/// Interpreters that run an agent as their first argument (`node …/bin/gemini`).
const AGENT_INTERPRETERS: &[&str] = &["node", "bun", "deno", "python", "python3", "sh", "bash"];

fn runs_agent(agent: &str, proc_: &ProcView) -> bool {
    let first = basename(&proc_.argv0);
    first == agent
        || (AGENT_INTERPRETERS.contains(&first)
            && proc_.argv1.as_deref().is_some_and(|a| basename(a) == agent))
}

/// Judge a tab by its **agent** process, not by the tree around it: the fence's
/// own `bwrap` parent sits in the host namespace, and an unfenced agent may
/// start sandboxed children of its own (Codex does), which sit outside it.
/// Any copy of the agent in the host namespace makes the tab unfenced.
pub fn classify_live(agent_cmd: &str, procs: &[ProcView]) -> LiveFence {
    let agent = basename(agent_cmd);
    let mut found = false;
    for proc_ in procs.iter().filter(|p| runs_agent(agent, p)) {
        if proc_.host_ns {
            return LiveFence::Unfenced;
        }
        found = true;
    }
    if found {
        LiveFence::Fenced
    } else {
        LiveFence::Idle
    }
}

/// Parse `tmux list-panes -a -F '#{session_name}\t#{pane_pid}'`. A session
/// with several panes keeps its first, which is the one Tabtivity created.
pub fn parse_tmux_pane_pids(out: &str) -> HashMap<String, u32> {
    let mut panes = HashMap::new();
    for line in out.lines() {
        if let Some((session, pid)) = line.split_once('\t') {
            if let Ok(pid) = pid.trim().parse() {
                panes.entry(session.to_string()).or_insert(pid);
            }
        }
    }
    panes
}

/// Per scope, how many live host agent tabs run outside the fence right now.
/// `pid_of` answers the registry's leader pid for a tab id, and `None` for a
/// tab that is no longer live. Linux only: elsewhere there is no namespace to
/// read, and an empty answer is "unknown", never "all fenced" — the pill still
/// shows a scope whose policy is off.
#[cfg(target_os = "linux")]
pub fn live_unfenced_by_scope(pid_of: impl Fn(&str) -> Option<u32>) -> HashMap<String, u32> {
    let tabs: Vec<(String, HostAgentTab)> = host_agent_tabs()
        .lock()
        .unwrap()
        .iter()
        .map(|(id, tab)| (id.clone(), tab.clone()))
        .collect();
    let mut counts = HashMap::new();
    if tabs.is_empty() {
        return counts;
    }
    // A tmux tab's registry pid is the tmux *client*; its agent lives under
    // the server's pane.
    let panes = if tabs.iter().any(|(_, t)| t.tmux_session.is_some()) {
        paths::command_no_window("tmux")
            .args(["list-panes", "-a", "-F", "#{session_name}\t#{pane_pid}"])
            .output()
            .ok()
            .map(|o| parse_tmux_pane_pids(&String::from_utf8_lossy(&o.stdout)))
            .unwrap_or_default()
    } else {
        HashMap::new()
    };
    let Ok(own_ns) = std::fs::read_link("/proc/self/ns/mnt") else {
        return counts;
    };
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for (pid, ppid) in crate::sysstat::parent_map() {
        children.entry(ppid).or_default().push(pid);
    }
    for (tab_id, tab) in tabs {
        let Some(leader) = pid_of(&tab_id) else {
            continue;
        };
        let root = tab
            .tmux_session
            .as_deref()
            .and_then(|s| panes.get(s).copied())
            .unwrap_or(leader);
        let mut procs = Vec::new();
        let mut queue = vec![root];
        let mut seen = HashSet::new();
        while let Some(pid) = queue.pop() {
            if !seen.insert(pid) {
                continue;
            }
            if let Some(view) = proc_view(pid, &own_ns) {
                procs.push(view);
            }
            if let Some(kids) = children.get(&pid) {
                queue.extend(kids);
            }
        }
        if classify_live(&tab.agent_cmd, &procs) == LiveFence::Unfenced {
            *counts.entry(tab.scope_id).or_insert(0) += 1;
        }
    }
    counts
}

#[cfg(not(target_os = "linux"))]
pub fn live_unfenced_by_scope(_pid_of: impl Fn(&str) -> Option<u32>) -> HashMap<String, u32> {
    HashMap::new()
}

#[cfg(target_os = "linux")]
fn proc_view(pid: u32, own_ns: &Path) -> Option<ProcView> {
    let raw = std::fs::read(format!("/proc/{pid}/cmdline")).ok()?;
    let mut argv = raw
        .split(|b| *b == 0)
        .map(|a| String::from_utf8_lossy(a).into_owned());
    let argv0 = argv.next().filter(|a| !a.is_empty())?;
    let ns = std::fs::read_link(format!("/proc/{pid}/ns/mnt")).ok()?;
    Some(ProcView {
        argv0,
        argv1: argv.next(),
        host_ns: ns == own_ns,
    })
}

/// The project pill's fence marker: what the running tabs actually are.
#[derive(Debug, Clone, Serialize)]
pub struct AgentFenceMark {
    /// Live agent tabs whose agent process runs outside the fence right now
    /// (started before the fence became the only mode, and kept alive by a
    /// tmux reattach).
    pub live_unfenced: u32,
}

pub fn marks_for_scopes(
    scope_ids: &[String],
    live_unfenced: &HashMap<String, u32>,
) -> HashMap<String, AgentFenceMark> {
    scope_ids
        .iter()
        .map(|id| {
            let mark = AgentFenceMark {
                live_unfenced: live_unfenced.get(id).copied().unwrap_or(0),
            };
            (id.clone(), mark)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::boxes::ProjectBox;
    use serde_json::{json, Value};

    // ── spawn generations (gap 18) ──────────────────────────────────────────

    #[test]
    fn a_stale_teardown_leaves_the_respawns_registration_and_proxy_tokens() {
        let tab = "gen-p:stale";
        let old = begin_spawn(tab);
        assert!(register_tab(tab, Some("gen-p"), old));
        // The unmount's kill took the old PTY; the remount's spawn begins and
        // is handed its proxy token before the kill's teardown lands.
        let new = begin_spawn(tab);
        let token = crate::services::api_proxy::issue_for_test("gen-p", tab).unwrap();
        assert!(!on_tab_gone(tab, old), "a teardown of the older spawn is stale");
        assert!(crate::services::api_proxy::token_live(&token));
        assert!(register_tab(tab, Some("gen-p"), new), "the respawn commits");
        assert!(!on_tab_gone(tab, old), "still stale after the commit");
        assert_eq!(fenced_scope_of_tab(tab).as_deref(), Some("gen-p"));
        assert!(crate::services::api_proxy::token_live(&token));
        // The respawn's own teardown takes it all.
        assert!(on_tab_gone(tab, new));
        assert_eq!(fenced_scope_of_tab(tab), None);
        assert!(!crate::services::api_proxy::token_live(&token));
        // Nothing registered any more: a repeat teardown counts as current.
        assert!(on_tab_gone(tab, new));
    }

    #[test]
    fn a_kill_of_an_uncommitted_spawn_beats_its_commit() {
        let tab = "gen-p:uncommitted";
        let seq = begin_spawn(tab);
        assert!(on_tab_gone(tab, seq));
        assert!(!register_tab(tab, Some("gen-p"), seq), "the process is gone already");
        assert_eq!(fenced_scope_of_tab(tab), None);
    }

    #[test]
    fn an_abandoned_spawn_falls_back_to_the_live_one() {
        let tab = "gen-p:abandon";
        let live = begin_spawn(tab);
        assert!(register_tab(tab, Some("gen-p"), live));
        let failed = begin_spawn(tab);
        abandon_spawn(tab, failed);
        assert_eq!(fenced_scope_of_tab(tab).as_deref(), Some("gen-p"));
        assert!(on_tab_gone(tab, live), "the live spawn is the newest again");
        // A first spawn that fails leaves nothing, its proxy token included.
        let only = begin_spawn(tab);
        let token = crate::services::api_proxy::issue_for_test("gen-p", tab).unwrap();
        abandon_spawn(tab, only);
        assert!(!crate::services::api_proxy::token_live(&token));
        assert!(!register_tab(tab, None, only));
    }

    #[test]
    fn an_unfenced_spawn_registers_without_a_scope() {
        let tab = "gen-p:unfenced";
        let seq = begin_spawn(tab);
        assert!(register_tab(tab, None, seq));
        assert_eq!(fenced_scope_of_tab(tab), None);
        assert!(on_tab_gone(tab, seq));
    }

    #[test]
    fn a_failed_probe_under_the_userns_profile_names_the_namespace_not_the_package() {
        // The Mobile sidecar's case: bwrap installed and root-owned, the
        // window fencing fine, and the probe still failing because systemd put
        // the service in a user namespace Ubuntu's AppArmor confines.
        let note = probe_failure_note(
            "bwrap: No permissions to create a new namespace\n",
            Some("unprivileged_userns (enforce)\n"),
        );
        assert!(note.contains("unprivileged_userns (enforce)"), "{note}");
        assert!(note.contains("No permissions to create a new namespace"), "{note}");
        assert!(note.contains("mount-namespace directive"), "{note}");
        // An unconfined process that fails gets bwrap's words and no such guess.
        let plain = probe_failure_note("", Some("unconfined\n"));
        assert!(plain.contains("unconfined"), "{plain}");
        assert!(plain.contains("no output"), "{plain}");
        assert!(!plain.contains("mount-namespace"), "{plain}");
        assert!(probe_failure_note("x", None).contains("label of this process: unknown"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn the_keyring_table_matches_the_native_syscall_numbers() {
        let (_, _, native) = KEYRING_SYSCALLS[0];
        assert_eq!(
            native.map(i64::from),
            [libc::SYS_add_key, libc::SYS_request_key, libc::SYS_keyctl].map(i64::from)
        );
    }

    /// Loads the real program into a child and calls the keyring from there:
    /// every keyring syscall is refused, and the `exec` and shell that follow
    /// (everything else) still run.
    #[cfg(target_os = "linux")]
    #[test]
    fn the_keyring_filter_denies_the_keyring_and_nothing_else() {
        use std::os::unix::process::CommandExt;
        let prog = keyring_seccomp_filter().expect("a filter for this architecture");
        let mut cmd = std::process::Command::new("/bin/sh");
        cmd.args(["-c", "exit 7"]);
        // SAFETY: only syscalls between fork and exec; `prog` was built before.
        unsafe {
            cmd.pre_exec(move || {
                let fprog = libc::sock_fprog {
                    len: (prog.len() / 8) as u16,
                    filter: prog.as_ptr() as *mut libc::sock_filter,
                };
                if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0
                    || libc::prctl(libc::PR_SET_SECCOMP, libc::SECCOMP_MODE_FILTER, &fprog) != 0
                {
                    return Err(std::io::Error::last_os_error());
                }
                let denied = |r: libc::c_long| {
                    r == -1 && std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
                };
                let session: libc::c_long = -3; // KEY_SPEC_SESSION_KEYRING
                let calls = [
                    libc::syscall(libc::SYS_keyctl, 0 as libc::c_long, session, 0 as libc::c_long),
                    libc::syscall(libc::SYS_add_key, c"user".as_ptr(), c"probe".as_ptr(), c"x".as_ptr(), 1usize, session),
                    libc::syscall(libc::SYS_request_key, c"user".as_ptr(), c"probe".as_ptr(), 0usize, 0 as libc::c_long),
                ];
                if calls.iter().all(|r| denied(*r)) {
                    Ok(())
                } else {
                    Err(std::io::Error::from_raw_os_error(libc::EBADMSG))
                }
            });
        }
        let status = cmd.status().expect("the filtered child refused a keyring call and exec'd");
        assert_eq!(status.code(), Some(7));
    }

    #[cfg(unix)]
    #[test]
    fn the_seccomp_launcher_hands_bwrap_the_filter_on_fd_9() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let filter = dir.path().join("filter.bpf");
        std::fs::write(&filter, b"program bytes").unwrap();
        let fake = dir.path().join("bwrap");
        std::fs::write(&fake, "#!/bin/sh\ncat <&9 >\"$OUT/fd9\"\nprintf '%s\\n' \"$@\" >\"$OUT/args\"\n").unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        let argv = vec!["--ro-bind".to_string(), "/a b".to_string(), "--".to_string(), "it's".to_string()];
        let (cmd, args) = seccomp_launcher(&fake.to_string_lossy(), None, &filter, argv.clone());
        assert_eq!(cmd, "/bin/sh");
        let status = std::process::Command::new(cmd).args(args).env("OUT", dir.path()).status().unwrap();
        assert!(status.success());
        assert_eq!(std::fs::read(dir.path().join("fd9")).unwrap(), b"program bytes");
        assert_eq!(
            std::fs::read_to_string(dir.path().join("args")).unwrap(),
            "--seccomp\n9\n--ro-bind\n/a b\n--\nit's\n"
        );
        // With a step, it runs first and is handed its mode, bwrap and fd 9.
        for mode in ["--fence-scope", crate::services::agent_exec::MODE_FLAG] {
            std::fs::remove_file(dir.path().join("fd9")).unwrap();
            let fake = fake.to_string_lossy();
            let (cmd, args) = seccomp_launcher("/usr/bin/bwrap", Some((&fake, mode)), &filter, argv.clone());
            let status = std::process::Command::new(cmd).args(args).env("OUT", dir.path()).status().unwrap();
            assert!(status.success());
            assert_eq!(std::fs::read(dir.path().join("fd9")).unwrap(), b"program bytes");
            assert_eq!(
                std::fs::read_to_string(dir.path().join("args")).unwrap(),
                format!("{mode}\n/usr/bin/bwrap\n--seccomp\n9\n--ro-bind\n/a b\n--\nit's\n")
            );
        }
    }

    #[test]
    fn a_carried_secret_gets_the_exec_step_even_without_the_scope() {
        let bin = || "/opt/app/bin".to_string();
        // The scope's helper maps carriers too, so it is the one step.
        assert_eq!(
            launcher_step(Some("/proc/1/exe".into()), true, bin),
            Some(("/proc/1/exe".to_string(), "--fence-scope"))
        );
        assert_eq!(
            launcher_step(Some("/proc/1/exe".into()), false, bin),
            Some(("/proc/1/exe".to_string(), "--fence-scope"))
        );
        // No Landlock scope here: a carried secret still gets mapped.
        assert_eq!(
            launcher_step(None, true, bin),
            Some(("/opt/app/bin".to_string(), crate::services::agent_exec::MODE_FLAG))
        );
        // Nothing to map, nothing in front of bwrap (as before).
        assert_eq!(launcher_step(None, false, || unreachable!()), None);
    }

    #[test]
    fn bwrap_masks_the_keyring_listing() {
        let out = bwrap_args("/home/u", None, "/p", "sh", &[], &[], &[], &[]);
        for file in ["/proc/keys", "/proc/key-users"] {
            let at = out.iter().position(|a| a == file).unwrap();
            assert_eq!(&out[at - 2..at], ["--ro-bind", "/dev/null"]);
        }
        let proc_mount = out.windows(2).position(|p| p == ["--proc", "/proc"]).unwrap();
        assert!(proc_mount < out.iter().position(|a| a == "/proc/keys").unwrap());
    }

    fn proc_(argv0: &str, argv1: Option<&str>, host_ns: bool) -> ProcView {
        ProcView {
            argv0: argv0.to_string(),
            argv1: argv1.map(str::to_string),
            host_ns,
        }
    }

    #[test]
    fn a_host_namespace_agent_is_unfenced() {
        // The shape of a tab started while the fence was off: tmux's pane shell
        // runs the agent directly.
        let procs = [
            proc_("bash", Some("-c"), true),
            proc_("claude", Some("--session-id"), true),
        ];
        assert_eq!(classify_live("claude", &procs), LiveFence::Unfenced);
    }

    #[test]
    fn a_fenced_agent_is_judged_by_itself_not_by_its_bwrap_parent() {
        let procs = [
            proc_("bash", Some("-c"), true),
            proc_("bwrap", Some("--ro-bind"), true),
            proc_("bwrap", Some("--ro-bind"), false),
            proc_("/home/u/.local/bin/claude", Some("--resume"), false),
        ];
        assert_eq!(classify_live("claude", &procs), LiveFence::Fenced);
    }

    #[test]
    fn an_unfenced_agents_own_sandboxed_child_does_not_make_it_fenced() {
        let procs = [
            proc_("codex", None, true),
            proc_("codex", Some("--sandbox-child"), false),
        ];
        assert_eq!(classify_live("codex", &procs), LiveFence::Unfenced);
    }

    #[test]
    fn an_interpreter_run_agent_is_recognised() {
        let procs = [proc_("node", Some("/home/u/.nvm/bin/gemini"), true)];
        assert_eq!(classify_live("/usr/bin/gemini", &procs), LiveFence::Unfenced);
    }

    #[test]
    fn a_tab_whose_agent_exited_counts_neither_way() {
        // The pane falls back to a login shell once the agent quits.
        let procs = [proc_("-bash", None, true), proc_("vim", Some("notes"), true)];
        assert_eq!(classify_live("claude", &procs), LiveFence::Idle);
        assert_eq!(classify_live("claude", &[]), LiveFence::Idle);
    }

    #[test]
    fn tmux_pane_pids_parse_and_keep_the_first_pane() {
        let panes = parse_tmux_pane_pids(concat!(crate::app_slug!(), "-a--agent-1\t100\n", crate::app_slug!(), "-a--agent-1\t200\nbad line\nx\tnope\n"));
        assert_eq!(panes.get(concat!(crate::app_slug!(), "-a--agent-1")), Some(&100));
        assert_eq!(panes.len(), 1);
    }

    #[test]
    fn an_unavailable_tool_is_retried_and_success_is_cached() {
        let cache = Mutex::new(false);
        assert!(!probe_until_available(&cache, || false));
        assert!(probe_until_available(&cache, || true));
        assert!(probe_until_available(&cache, || panic!("successful probe must be cached")));
    }

    /// `root_fence_projects_readable`: on, every project directory, box folder
    /// and remote mirror reaches a root spawn's argv as `--ro-bind-try` and
    /// never as a `--bind`; off, none of them appears; a project scope's roots
    /// are the same either way. Unix paths: the fence exists on Linux/macOS only.
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn the_root_fence_exposes_projects_read_only_only_when_switched_on() {
        let projects: ProjectsList = serde_json::from_str(
            r#"[{"id":"p1","name":"Alpha","status":"active","position":0,"local_file":"","directory":"/w/alpha"},
                {"id":"p2","name":"Beta","status":"active","position":1,"local_file":"","remote":{"host":"h"},"mirror":"/w/beta-mirror"},
                {"id":"p3","name":"Gamma","status":"active","position":2,"local_file":"","remote":{"host":"h"}}]"#,
        )
        .unwrap();
        let boxes: BoxesList = serde_json::from_str(
            r#"[{"id":"b1","name":"Box","member_ids":["p1"],"position":0,"folder":"/w/box"}]"#,
        )
        .unwrap();
        let state = Path::new("/state");
        let off = crate::schema::Settings::default();
        assert!(root_project_read_only_paths(&off, &projects, &boxes, state).is_empty());
        let on: crate::schema::Settings =
            serde_json::from_str(r#"{"root_fence_projects_readable":true}"#).unwrap();
        let paths = root_project_read_only_paths(&on, &projects, &boxes, state);
        assert_eq!(
            paths,
            ["/w/alpha", "/w/beta-mirror", "/state/remote-projects/p3/mirror", "/w/box"],
            "a remote project's mirror, never its remote directory string"
        );
        let args = bwrap_args("/home/u", None, concat!("/home/u/", crate::app_slug!(), "/root"), "claude", &[], &[PathBuf::from(concat!("/home/u/", crate::app_slug!(), "/root"))], &paths, &[]);
        for p in &paths {
            assert!(args.windows(3).any(|w| w[0] == "--ro-bind-try" && w[1] == *p && w[2] == *p), "{p} not read-only: {args:?}");
            assert!(!args.windows(2).any(|w| (w[0] == "--bind" || w[0] == "--bind-try") && w[1] == *p), "{p} bound read-write");
        }
        let plain = bwrap_args("/home/u", None, concat!("/home/u/", crate::app_slug!(), "/root"), "claude", &[], &[PathBuf::from(concat!("/home/u/", crate::app_slug!(), "/root"))], &[], &[]);
        assert!(!plain.iter().any(|a| a == "/w/alpha"));
        // A project scope: the flag changes nothing about its roots.
        assert_eq!(compute_fence_roots(&boxes, &projects, "p1", true), Some(vec![PathBuf::from("/w/alpha"), PathBuf::from("/w/box")]));
    }

    /// #158: the pin and the read-only control binds land after the root's
    /// read-write grant (bubblewrap applies mounts in argv order, later wins)
    /// and before `--`, pin first so the read-only binds sit inside it.
    #[test]
    fn git_control_files_are_rebound_read_only_after_the_root_grant() {
        let mut args = bwrap_args("/home/u", None, "/p", "claude", &[], &[PathBuf::from("/p")], &[], &[]);
        guard_git_control(
            &mut args,
            crate::services::git_guard::GuardPaths {
                pinned: vec![PathBuf::from("/p/.git")],
                read_only: vec![PathBuf::from("/p/.git/config"), PathBuf::from("/p/.git/hooks")],
            },
        );
        let at = |flag: &str, path: &str| {
            args.windows(3)
                .position(|w| w[0] == flag && w[1] == path && w[2] == path)
                .unwrap_or_else(|| panic!("{flag} {path} missing: {args:?}"))
        };
        let grant = at("--bind-try", "/p");
        let pin = at("--bind", "/p/.git");
        let config = at("--ro-bind", "/p/.git/config");
        let hooks = at("--ro-bind", "/p/.git/hooks");
        let separator = args.iter().position(|a| a == "--").unwrap();
        assert!(grant < pin && pin < config && config < hooks && hooks < separator);
        assert_eq!(args[separator + 1], "claude");
    }

    #[test]
    fn cargo_tokens_are_masked_after_root_grants_and_opt_in_removes_masks() {
        let home = tempfile::tempdir().unwrap();
        let cargo = home.path().join(".cargo");
        std::fs::create_dir(&cargo).unwrap();
        for name in ["credentials", "credentials.toml"] {
            std::fs::write(cargo.join(name), "fixture registry token").unwrap();
        }
        let hidden = cargo_credential_paths(home.path(), Some(Path::new("custom-cargo")), home.path(), false);
        // Joined per component: a literal "custom-cargo/credentials.toml" keeps its `/`
        // on Windows, where the function under test produces a `\` path.
        assert!(hidden.contains(&home.path().join("custom-cargo").join("credentials.toml").to_string_lossy().into_owned()));
        let mut args = bwrap_args("/home/u", None, "/p", "codex", &[], &[home.path().to_owned()], &[], &[]);
        mask_cargo_credentials(&mut args, hidden.clone());
        let grant = args.iter().position(|a| a == "--bind-try").unwrap();
        for name in ["credentials", "credentials.toml"] {
            let path = cargo.join(name).to_string_lossy().into_owned();
            let mask = args.iter().position(|a| a == &path).unwrap();
            assert!(mask > grant);
            assert_eq!(&args[mask - 2..mask], &["--ro-bind", "/dev/null"]);
            assert_eq!(std::fs::read_to_string(cargo.join(name)).unwrap(), "fixture registry token");
        }
        assert!(cargo_credential_paths(home.path(), Some(&cargo), home.path(), true).is_empty());
        let profile = sandbox_exec_profile(&SeatbeltInputs {
            home: home.path().to_string_lossy().into_owned(),
            readable: vec![cargo.to_string_lossy().into_owned()],
            hidden,
            ..Default::default()
        });
        assert!(profile.rfind("(deny file-read* file-write*").unwrap() > profile.rfind("(allow file-read*").unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn cargo_masks_include_symlink_targets() {
        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir(home.path().join(".cargo")).unwrap();
        let target = home.path().join("registry-secret");
        std::fs::write(&target, "fixture").unwrap();
        std::os::unix::fs::symlink(&target, home.path().join(".cargo/credentials.toml")).unwrap();
        let paths = cargo_credential_paths(home.path(), None, home.path(), false);
        assert!(paths.contains(&target.canonicalize().unwrap().to_string_lossy().into_owned()));
    }

    #[test]
    fn state_is_masked_after_overlapping_project_grants() {
        let dir = tempfile::tempdir().unwrap();
        let state = dir.path().join("state");
        std::fs::create_dir_all(state.join("hooks")).unwrap();
        std::fs::write(state.join("calendar.json"), "secret").unwrap();
        let mut args = vec!["--bind".into(), dir.path().display().to_string(), dir.path().display().to_string(), "--".into(), "agent".into()];
        let hook = state.join("hooks").display().to_string();
        mask_private_state(&mut args, &state, &[BindMount { src: hook.clone(), dst: hook.clone(), read_only: true }]);
        let mask = args.iter().position(|a| a == "--tmpfs").unwrap();
        assert!(mask > 2);
        assert!(args.iter().rposition(|a| a == &hook).unwrap() > mask);
        assert!(args.iter().position(|a| a == "--").unwrap() > mask);
        assert!(private_state_paths(&state).contains(&state.join("calendar.json")));
    }

    #[test]
    fn owned_installs_survive_the_final_state_mask_read_only() {
        let dir = tempfile::tempdir().unwrap();
        let state = dir.path().join("state");
        let install = crate::services::agent_install::install_root_in(&state);
        let command = install.join("bin/agent");
        std::fs::create_dir_all(command.parent().unwrap()).unwrap();
        std::fs::write(&command, "fixture").unwrap();
        std::fs::create_dir_all(state.join("agent-global")).unwrap();
        let mut support = Vec::new();
        add_install_mount(&mut support, &state);
        let mut args = bwrap_args(
            "/home/u", None, "/p", &command.to_string_lossy(), &[],
            std::slice::from_ref(&state), &[], &support,
        );
        mask_private_state(&mut args, &state, &support);
        let state_s = state.to_string_lossy();
        let install_s = install.to_string_lossy();
        let mask = args.windows(2).rposition(|w| w[0] == "--tmpfs" && w[1] == state_s).unwrap();
        let restored = args.windows(3).rposition(|w| {
            w[0] == "--ro-bind" && w[1] == install_s && w[2] == install_s
        }).unwrap();
        assert!(restored > mask);
        assert!(!args.windows(2).any(|w| w[0] == "--bind" && w[1] == install_s));
        assert!(args.iter().position(|a| a == "--").unwrap() > restored);
        // A missing install does not create a mount point on the host.
        let mut missing = Vec::new();
        add_install_mount(&mut missing, &dir.path().join("missing"));
        assert!(missing.is_empty());
    }

    fn project(id: &str, dir: &str) -> ProjectEntry {
        let mut extra = HashMap::new();
        extra.insert("directory".into(), Value::String(dir.into()));
        ProjectEntry {
            id: id.into(),
            name: id.into(),
            status: "active".into(),
            position: 0,
            local_file: format!("{dir}/project.json"),
            extra,
        }
    }

    fn opts(cmd: &str) -> PtyOptions {
        PtyOptions {
            id: "p:t".into(),
            cmd: cmd.into(),
            args: Vec::new(),
            env: HashMap::new(),
            cwd: "/p".into(),
            cols: 80,
            rows: 24,
            local_only: false,
            sandbox: false,
            agent: false,
            project_id: Some("p".into()),
            remote_host_id: None,
            tmux_session: None,
            tmux_attach: None,
            host_bound_uid: None,
            local_model: false,
            schedule_target_id: None,
            host_session: false,
        }
    }

    #[test]
    fn seatbelt_profile_denies_writes_then_restores_roots_and_protects_hooks() {
        let inputs = SeatbeltInputs {
            home: "/Users/a".into(),
            roots: vec![concat!("/Users/a/", crate::app_slug!(), "/projects/p").into()],
            writable: vec!["/Users/a/.claude".into(), "/private/tmp".into()],
            readable: vec!["/Users/a/.gitconfig".into()],
            protected: vec![
                "/Users/a/.claude/settings.json".into(),
                concat!("/Users/a/.local/share/", crate::app_slug!(), "/hooks").into(),
            ],
            hidden: Vec::new(),
            own_home: None,
        };
        let profile = sandbox_exec_profile(&inputs);
        let lines: Vec<&str> = profile.lines().collect();
        assert_eq!(lines[0], "(version 1)");
        assert_eq!(lines[1], "(allow default)");
        let pos = |needle: &str| {
            lines
                .iter()
                .position(|l| l.contains(needle))
                .unwrap_or_else(|| panic!("missing: {needle}"))
        };
        // Home is hidden before anything under it is restored.
        assert!(pos("(deny file-read* (subpath \"/Users/a\"))") < pos("(allow file-read* (subpath \"/Users/a/.gitconfig\"))"));
        assert!(profile.contains("(allow file-read-metadata (literal \"/Users/a\"))"));
        // Writes are denied globally, then the root and the agent state come back.
        assert!(pos("(deny file-write*)") < pos(concat!("(allow file-write* (subpath \"/Users/a/", crate::app_slug!(), "/projects/p\"))")));
        assert!(pos("(deny file-write*)") < pos("(allow file-write* (subpath \"/Users/a/.claude\"))"));
        // The device allowlist comes right after the global deny, before any
        // protected deny, and never opens other terminals' ttys.
        let devices = pos("(literal \"/dev/null\")");
        assert_eq!(devices, pos("(deny file-write*)") + 1);
        for dev in ["/dev/zero", "/dev/tty\"", "/dev/dtracehelper"] {
            assert!(lines[devices].contains(dev), "missing {dev}");
        }
        assert!(lines[devices].contains("(subpath \"/dev/fd\")"));
        assert!(devices < pos("(deny file-write* (subpath \"/Users/a/.claude/settings.json\"))"));
        assert!(!profile.contains("ttys"), "no /dev/ttys* rule");
        // The protected paths are denied LAST so they win over the .claude allow.
        let hook_deny = pos("(deny file-write* (subpath \"/Users/a/.claude/settings.json\"))");
        assert!(hook_deny > pos("(allow file-write* (subpath \"/Users/a/.claude\"))"));
        assert_eq!(lines.last().unwrap(), &concat!("(deny file-write* (subpath \"/Users/a/.local/share/", crate::app_slug!(), "/hooks\"))"));
        // Quoting: a path with a quote or backslash stays one Scheme string.
        assert_eq!(sbpl_string("/a/b\"c\\d"), "\"/a/b\\\"c\\\\d\"");
    }

    #[test]
    fn fence_install_command_follows_the_distribution() {
        let cmd = |release: &str| package_install_cmd(release, InstallPkg::Bubblewrap);
        assert_eq!(
            cmd("NAME=\"Ubuntu\"\nID=ubuntu\nID_LIKE=debian\n").as_deref(),
            Some("sudo apt install -y bubblewrap")
        );
        assert_eq!(cmd("ID=debian\n").as_deref(), Some("sudo apt install -y bubblewrap"));
        assert_eq!(cmd("ID=fedora\n").as_deref(), Some("sudo dnf install -y bubblewrap"));
        assert_eq!(cmd("ID=arch\n").as_deref(), Some("sudo pacman -S --needed bubblewrap"));
        assert_eq!(
            cmd("ID=\"opensuse-tumbleweed\"\nID_LIKE=\"opensuse suse\"\n").as_deref(),
            Some("sudo zypper install -y bubblewrap")
        );
        // An unrecognized ID falls through to ID_LIKE, in its order.
        assert_eq!(
            cmd("ID=\"someforge\"\nID_LIKE=\"rhel fedora\"\n").as_deref(),
            Some("sudo dnf install -y bubblewrap")
        );
        // ID wins over ID_LIKE.
        assert_eq!(
            cmd("ID=ubuntu\nID_LIKE=\"arch\"\n").as_deref(),
            Some("sudo apt install -y bubblewrap")
        );
        // Unknown distributions and an empty file offer nothing to run.
        assert_eq!(cmd("ID=nixos\n"), None);
        assert_eq!(cmd("ID=gentoo\n"), None);
        assert_eq!(cmd(""), None);
    }

    #[test]
    fn decision_matrix() {
        let roots = vec![PathBuf::from("/p")];
        assert_eq!(
            decide(&opts("bash"), roots.clone(), false, true, true, true),
            FenceDecision::NotApplicable { reason: "shell" }
        );
        let mut container = opts("claude");
        container.sandbox = true;
        assert_eq!(
            decide(&container, roots.clone(), false, true, true, true),
            FenceDecision::NotApplicable {
                reason: "container"
            }
        );
        assert_eq!(
            decide(&opts("claude"), roots.clone(), true, true, true, true),
            FenceDecision::NotApplicable {
                reason: "remote host"
            }
        );
        let mut local_mirror = opts("claude");
        local_mirror.local_only = true;
        assert!(matches!(
            decide(&local_mirror, vec![PathBuf::from("/mirror/p")], false, true, true, true),
            FenceDecision::Fenced { roots }
                if roots == vec![PathBuf::from("/mirror/p")]
        ));
        // The fence has no "off": the one unfenced local agent is the root
        // console's explicit Host session, and only there.
        let mut host = opts("claude");
        host.host_session = true;
        assert!(matches!(
            decide(&host, roots.clone(), false, true, true, true),
            FenceDecision::Fenced { .. }
        ));
        host.project_id = None;
        assert_eq!(
            decide(&host, roots.clone(), false, true, true, true),
            FenceDecision::NotApplicable { reason: HOST_SESSION_REASON }
        );
        assert!(matches!(
            decide(&opts("claude"), roots.clone(), false, true, true, false),
            FenceDecision::Unavailable
        ));
        // No fence on this platform: refused until accepted once, then plain
        // "not applicable" — whatever the policy or the (irrelevant) tool says.
        assert_eq!(
            decide(&opts("claude"), roots.clone(), false, false, true, false),
            FenceDecision::NotApplicable { reason: "platform" }
        );
        // Shells, containers and remote runs never ask: nothing of the user's
        // machine is at stake that isn't already.
        assert_eq!(
            decide(&opts("bash"), roots.clone(), false, false, false, false),
            FenceDecision::NotApplicable { reason: "shell" }
        );
        assert_eq!(
            decide(&opts("claude"), roots.clone(), true, false, false, false),
            FenceDecision::NotApplicable {
                reason: "remote host"
            }
        );
        assert!(platform_unaccepted_message().starts_with(PLATFORM_UNACCEPTED_SENTINEL));
        let mut custom = opts("my-agent-wrapper");
        custom.agent = true;
        assert!(matches!(
            decide(&custom, roots, false, true, true, true),
            FenceDecision::Fenced { .. }
        ));
    }

    #[test]
    fn roots_cover_plain_multi_box_and_box_scope() {
        let p1 = project("p1", "/work/p1");
        let mut p2 = project("p2", "/remote/p2");
        p2.extra.insert("remote".into(), json!({"host":"h"}));
        p2.extra.insert("mirror".into(), json!("/mirrors/p2"));
        let boxes = vec![
            ProjectBox {
                id: "a".into(),
                name: "A".into(),
                member_ids: vec!["p1".into(), "p2".into()],
                folder: Some("/boxes/a".into()),
                ..ProjectBox::default()
            },
            ProjectBox {
                id: "b".into(),
                name: "B".into(),
                member_ids: vec!["p1".into()],
                folder: Some("/boxes/b".into()),
                ..ProjectBox::default()
            },
        ];
        let projects = vec![p1, p2];
        assert_eq!(
            compute_fence_roots(&Vec::new(), &projects, "p2", true).unwrap(),
            vec![PathBuf::from("/mirrors/p2")]
        );
        let p1_roots = compute_fence_roots(&boxes, &projects, "p1", false).unwrap();
        for expected in [
            "/work/p1",
            "/boxes/a",
            "/remote/p2",
            "/mirrors/p2",
            "/boxes/b",
        ] {
            assert!(p1_roots.contains(&PathBuf::from(expected)), "{p1_roots:?}");
        }
        let box_roots = compute_fence_roots(&boxes, &projects, "box:a", false).unwrap();
        assert!(box_roots.contains(&PathBuf::from("/boxes/a")));
        assert!(compute_fence_roots(&boxes, &projects, "ghost", false).is_none());
        assert!(compute_fence_roots(&boxes, &projects, "box:ghost", false).is_none());
    }

    #[test]
    fn bwrap_argv_orders_home_mounts_roots_and_command() {
        let roots = vec![PathBuf::from("/home/u/work/p")];
        let mounts = vec![BindMount {
            src: "/state/live_sessions/p".into(),
            dst: "/state/live_sessions".into(),
            read_only: false,
        }];
        let out = bwrap_args(
            "/home/u",
            Some("/state/agent-homes/p"),
            "/home/u/work/p",
            "codex",
            &["resume".into(), "abc".into()],
            &roots,
            &["/home/u/.cargo".into()],
            &mounts,
        );
        // The scope home replaces the user's home, and its cache is a tmpfs.
        let home = out
            .windows(3)
            .position(|p| p == ["--bind", "/state/agent-homes/p", "/home/u"])
            .unwrap();
        let cache = out
            .windows(2)
            .position(|p| p == ["--tmpfs", "/home/u/.cache"])
            .unwrap();
        assert!(!out.windows(2).any(|p| p == ["--tmpfs", "/home/u"]));
        let cargo = out.iter().position(|p| p == "/home/u/.cargo").unwrap();
        let live = out.iter().position(|p| p == "/state/live_sessions").unwrap();
        let root = out.iter().rposition(|p| p == "/home/u/work/p").unwrap();
        assert!(home < cache && cache < cargo && cargo < live && live < root);
        assert!(!out.iter().any(|p| p == "--new-session" || p == "--symlink"));
        let separator = out.iter().position(|p| p == "--").unwrap();
        assert_eq!(&out[separator + 1..], &["codex", "resume", "abc"]);
        assert_eq!(out[separator - 2], "--chdir");
        assert_eq!(out[separator - 1], "/home/u/work/p");
        // Without a scope home (a one-shot command) the home is an empty tmpfs.
        let one_shot = bwrap_args("/home/u", None, "/p", "sh", &[], &roots, &[], &[]);
        assert!(one_shot.windows(2).any(|p| p == ["--tmpfs", "/home/u"]));
    }

    #[cfg(unix)]
    #[test]
    fn command_bind_paths_follow_installer_symlinks_under_home() {
        let tmp = std::env::temp_dir().join(format!(
            concat!(crate::app_slug!(), "-fence-bind-{}-{}"),
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let home = tmp.join("home");
        let bin = home.join(".local/bin");
        let versions = home.join(".local/share/claude/versions");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::create_dir_all(&versions).unwrap();
        let real = versions.join("2.1.251");
        std::fs::write(&real, "#!/bin/sh\n").unwrap();
        // ~/.local/bin/claude -> ../share/claude/versions/2.1.251 (relative hop)
        std::os::unix::fs::symlink("../share/claude/versions/2.1.251", bin.join("claude"))
            .unwrap();
        // /usr/bin-style link outside home -> under home (absolute hop)
        let usr_bin = tmp.join("usr/bin");
        std::fs::create_dir_all(&usr_bin).unwrap();
        std::os::unix::fs::symlink(bin.join("claude"), usr_bin.join("claude")).unwrap();
        let dirs = vec![usr_bin.clone(), bin.clone()];

        let bin_s = bin.to_string_lossy().into_owned();
        let versions_s = versions.to_string_lossy().into_owned();
        // Nothing visible yet: both home-side hops are restored, the usr hop is
        // already covered by the read-only host root and stays out.
        assert_eq!(
            command_bind_paths("claude", &dirs, &home, &[]),
            vec![bin_s.clone(), versions_s.clone()]
        );
        // The default allowlist already covers ~/.local/bin; only the target is added.
        assert_eq!(
            command_bind_paths("claude", &dirs, &home, std::slice::from_ref(&bin_s)),
            vec![versions_s.clone()]
        );
        // An ancestor in the allowlist covers the whole chain.
        let share = home.join(".local/share").to_string_lossy().into_owned();
        assert_eq!(
            command_bind_paths("claude", &dirs, &home, &[bin_s.clone(), share]),
            Vec::<String>::new()
        );
        // Explicit path and an unknown command.
        assert_eq!(
            command_bind_paths(&bin.join("claude").to_string_lossy(), &[], &home, &[]),
            vec![bin_s, versions_s]
        );
        assert!(command_bind_paths("no-such-agent", &dirs, &home, &[]).is_empty());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// Mistral's installer is `uv tool install mistral-vibe`: `~/.local/bin/vibe`
    /// links to a script in the tool's venv, whose `#!` interpreter links into
    /// uv's managed Python. Binding only the hop directories left the
    /// interpreter dangling and the new tab failed with `vibe` not found.
    #[cfg(unix)]
    #[test]
    fn command_bind_paths_bring_a_uv_tool_venv_and_its_python() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let bin = home.join(".local/bin");
        let venv = home.join(".local/share/uv/tools/mistral-vibe");
        let python = home.join(".local/share/uv/python/cpython-3.12.9-linux-x86_64-gnu");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::create_dir_all(venv.join("bin")).unwrap();
        std::fs::create_dir_all(venv.join("lib/python3.12/site-packages")).unwrap();
        std::fs::create_dir_all(python.join("bin")).unwrap();
        std::fs::write(python.join("bin/python3.12"), b"\x7fELF").unwrap();
        std::os::unix::fs::symlink(python.join("bin/python3.12"), venv.join("bin/python")).unwrap();
        std::fs::write(
            venv.join("pyvenv.cfg"),
            format!("home = {}\nimplementation = CPython\n", python.join("bin").display()),
        )
        .unwrap();
        std::fs::write(
            venv.join("bin/vibe"),
            format!("#!{}\nimport sys\n", venv.join("bin/python").display()),
        )
        .unwrap();
        std::os::unix::fs::symlink(venv.join("bin/vibe"), bin.join("vibe")).unwrap();

        let s = |p: &Path| p.to_string_lossy().into_owned();
        assert_eq!(
            command_bind_paths("vibe", std::slice::from_ref(&bin), &home, std::slice::from_ref(&s(&bin))),
            vec![s(&venv), s(&python)]
        );
        // `#!/usr/bin/env node` resolves the interpreter on PATH.
        let node_bin = home.join(".nvm/versions/node/v22/bin");
        std::fs::create_dir_all(&node_bin).unwrap();
        std::fs::write(node_bin.join("node"), b"\x7fELF").unwrap();
        let pkg = home.join(".npm-global/lib/node_modules/cli");
        std::fs::create_dir_all(&pkg).unwrap();
        std::fs::write(pkg.join("cli.js"), "#!/usr/bin/env -S node --no-warnings\n").unwrap();
        std::os::unix::fs::symlink(pkg.join("cli.js"), bin.join("cli")).unwrap();
        assert_eq!(
            command_bind_paths("cli", &[bin.clone(), node_bin.clone()], &home, &[s(&bin)]),
            vec![s(&pkg), s(&node_bin)]
        );
    }

    /// A CLI installed on the host by its native installer — a launcher link
    /// in `~/.local/bin` into a payload under `~/.local/share/<tool>` — is
    /// bound into the fence read-only, every hop of it. Until 2026-09-26 the
    /// payload root came back read-write for the CLI's self-update, which let
    /// one scope's agent replace the binary every other scope and the user's
    /// own shell run next (agent_authority reevaluation, item 2).
    #[cfg(unix)]
    #[test]
    fn a_host_installed_cli_is_read_only_in_the_fence() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let bin = home.join(".local/bin");
        let versions = home.join(".local/share/claude/versions");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::create_dir_all(&versions).unwrap();
        std::fs::write(versions.join("2.1.270"), "#!/bin/sh\n").unwrap();
        std::os::unix::fs::symlink(versions.join("2.1.270"), bin.join("claude")).unwrap();
        let dirs = vec![bin.clone()];
        let hops = command_bind_paths("claude", &dirs, &home, &[]);
        assert!(hops.iter().any(|h| Path::new(h) == bin));
        assert!(hops.iter().any(|h| Path::new(h) == versions));
        let args = bwrap_args("/home/u", None, "/p", "claude", &[], &[], &hops, &[]);
        let home_s = home.to_string_lossy().into_owned();
        // Each bind is `<flag> <src> <dst>` with src == dst; count the flags
        // ahead of every src under the home.
        let mut n = 0;
        for i in 1..args.len() - 1 {
            if args[i].starts_with(&home_s) && args[i + 1] == args[i] {
                assert_eq!(args[i - 1], "--ro-bind-try", "{} bound writable: {args:?}", args[i]);
                n += 1;
            }
        }
        assert_eq!(n, 2, "{args:?}");
    }

    #[test]
    fn later_rw_mount_shadows_the_allowlist_read_only_bin() {
        let bin = "/home/u/.local/bin".to_string();
        let mounts = vec![BindMount {
            src: "/state/sandbox-stage/p/private/local-bin".to_string(),
            dst: bin.clone(),
            read_only: false,
        }];
        let out = bwrap_args(
            "/home/u",
            None,
            "/p",
            "claude",
            &[],
            &[],
            std::slice::from_ref(&bin),
            &mounts,
        );
        let ro = out
            .iter()
            .position(|a| a == "--ro-bind-try")
            .expect("allowlist bind");
        let rw = out
            .iter()
            .enumerate()
            .position(|(i, a)| a == "--bind" && out.get(i + 2) == Some(&bin))
            .expect("read-write bind");
        // bubblewrap applies mounts in order: an explicit support mount of a
        // path the allowlist already restored read-only is the one the agent
        // sees, which is what lets the state masks be re-opened selectively.
        assert!(rw > ro, "{out:?}");
    }

    #[test]
    fn only_the_spawns_own_local_model_home_is_mounted() {
        let state = tempfile::tempdir().unwrap();
        let root = state.path().join("vibe_local");
        std::fs::create_dir_all(root.join("gemma4-e4b")).unwrap();
        std::fs::create_dir_all(root.join("qwen3-coder")).unwrap();
        let env = |v: &str| std::collections::HashMap::from([("VIBE_HOME".to_string(), v.to_string())]);

        // Not a local-model tab (a Claude tab, the root console's agent): nothing.
        assert_eq!(local_model_home(&Default::default(), state.path()), None);
        assert!(local_model_mounts(None).unwrap().0.is_empty());
        // The renderer names the home; only a direct, existing child counts.
        for bad in [
            root.to_string_lossy().into_owned(),
            root.join("gemma4-e4b/logs").to_string_lossy().into_owned(),
            root.join("../vibe_local/gemma4-e4b").to_string_lossy().into_owned(),
            root.join("missing").to_string_lossy().into_owned(),
            "/home/u/.vibe".to_string(),
        ] {
            assert_eq!(local_model_home(&env(&bad), state.path()), None, "{bad}");
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(state.path(), root.join("link")).unwrap();
            let link = root.join("link").to_string_lossy().into_owned();
            assert_eq!(local_model_home(&env(&link), state.path()), None);
        }

        let own = root.join("gemma4-e4b");
        let home = local_model_home(&env(&own.to_string_lossy()), state.path()).unwrap();
        let (mounts, pins) = local_model_mounts(Some(&home)).unwrap();
        assert_eq!(pins.len(), LOCAL_MODEL_CONTROL.len());
        verify_control_pins(&pins).unwrap();
        let own_str = own.to_string_lossy().into_owned();
        // The home itself, writable — vibe keeps its logs and history there —
        // and never the sibling models' homes or the directory above.
        assert_eq!(
            mounts[0],
            BindMount { src: own_str.clone(), dst: own_str.clone(), read_only: false }
        );
        assert!(mounts.iter().all(|m| Path::new(&m.dst).starts_with(&own)));
        // Every control path is shadowed read-only, created where missing.
        for &(name, is_dir) in LOCAL_MODEL_CONTROL {
            let path = own.join(name);
            assert_eq!(path.is_dir(), is_dir, "{name}");
            let dst = path.to_string_lossy().into_owned();
            let pos = mounts.iter().position(|m| m.dst == dst).unwrap_or_else(|| panic!("{name}"));
            assert!(mounts[pos].read_only, "{name}");
            assert!(pos > 0, "{name} must come after the home mount");
        }
        // Vibe's own state stays writable: no mount for logs/ or vibehistory.
        assert!(!mounts.iter().any(|m| m.dst.ends_with("/logs") || m.dst.ends_with("vibehistory")));
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_control_path_is_replaced_not_followed() {
        let state = tempfile::tempdir().unwrap();
        let home = state.path().join("vibe_local/gemma4-e4b");
        std::fs::create_dir_all(&home).unwrap();
        let outside = state.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, home.join("tools")).unwrap();
        std::os::unix::fs::symlink(outside.join("x.toml"), home.join("hooks.toml")).unwrap();
        local_model_control_paths(&home).unwrap();
        assert!(!std::fs::symlink_metadata(home.join("tools")).unwrap().file_type().is_symlink());
        assert!(home.join("tools").is_dir());
        assert!(!std::fs::symlink_metadata(home.join("hooks.toml")).unwrap().file_type().is_symlink());
        assert!(!outside.join("x.toml").exists());
    }

    /// Gap 30: the swap another tab of the model makes *after* setup — a link
    /// in place of a pinned file or folder — refuses the spawn.
    #[cfg(unix)]
    #[test]
    fn a_control_path_swapped_after_setup_refuses_the_spawn() {
        let state = tempfile::tempdir().unwrap();
        let home = state.path().join("vibe_local/gemma4-e4b");
        std::fs::create_dir_all(&home).unwrap();
        let outside = state.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        let pins = local_model_control_paths(&home).unwrap();
        verify_control_pins(&pins).unwrap();
        // A raced link where a file was.
        std::fs::remove_file(home.join("config.toml")).unwrap();
        std::os::unix::fs::symlink(outside.join("c.toml"), home.join("config.toml")).unwrap();
        let err = verify_control_pins(&pins).unwrap_err();
        assert!(err.contains("config.toml"), "{err}");
        // Set up again: the link is replaced and the new pins hold.
        let pins = local_model_control_paths(&home).unwrap();
        verify_control_pins(&pins).unwrap();
        // A raced link where a folder was.
        std::fs::remove_dir(home.join("plugins")).unwrap();
        std::os::unix::fs::symlink(&outside, home.join("plugins")).unwrap();
        assert!(verify_control_pins(&pins).unwrap_err().contains("plugins"));
        // A different real file (a new inode) is a swap too.
        let pins = local_model_control_paths(&home).unwrap();
        std::fs::remove_file(home.join(".env")).unwrap();
        std::fs::write(home.join(".env"), "").unwrap();
        assert!(verify_control_pins(&pins).unwrap_err().contains(".env"));
        // Gone altogether: refused.
        let pins = local_model_control_paths(&home).unwrap();
        std::fs::remove_file(home.join("AGENTS.md")).unwrap();
        assert!(verify_control_pins(&pins).is_err());
    }

    /// A FIFO planted at a control name is replaced without blocking the spawn,
    /// and a home that is not a plain folder refuses it.
    #[cfg(unix)]
    #[test]
    fn a_fifo_at_a_control_path_is_replaced_without_blocking() {
        let state = tempfile::tempdir().unwrap();
        let home = state.path().join("vibe_local/gemma4-e4b");
        std::fs::create_dir_all(&home).unwrap();
        crate::services::home_io::mkfifo(&home.join("config.toml"));
        crate::services::home_io::mkfifo(&home.join("tools"));
        let at = home.clone();
        let pins = crate::services::home_io::within_deadline(move || local_model_control_paths(&at)).unwrap();
        verify_control_pins(&pins).unwrap();
        assert!(std::fs::symlink_metadata(home.join("config.toml")).unwrap().is_file());
        assert!(std::fs::symlink_metadata(home.join("tools")).unwrap().is_dir());
        let missing = state.path().join("vibe_local/missing");
        assert!(local_model_control_paths(&missing).is_err());
    }

    #[test]
    fn add_dir_flags_are_agent_specific_and_idempotent() {
        let roots = vec![PathBuf::from("/p"), PathBuf::from("/sibling")];
        let mut claude = opts("claude");
        add_box_root_args(&mut claude, &roots, Path::new("/p"));
        add_box_root_args(&mut claude, &roots, Path::new("/p"));
        assert_eq!(claude.args, vec!["--add-dir", "/sibling"]);
        let mut gemini = opts("gemini");
        add_box_root_args(&mut gemini, &roots, Path::new("/p"));
        assert_eq!(gemini.args, vec!["--include-directories", "/sibling"]);
        let mut shell = opts("bash");
        add_box_root_args(&mut shell, &roots, Path::new("/p"));
        assert!(shell.args.is_empty());
        let mut one = opts("codex");
        add_box_root_args(&mut one, &roots, Path::new("/p"));
        assert!(one.args.is_empty());
        // A sign-in tab runs a subcommand, which takes no session flags.
        let mut login = opts("claude");
        login.args = vec!["auth".into(), "login".into(), "--claudeai".into()];
        add_box_root_args(&mut login, &roots, Path::new("/p"));
        assert_eq!(login.args, vec!["auth", "login", "--claudeai"]);
        assert!(runs_subcommand(&login.args));
        assert!(!runs_subcommand(&["--resume".to_string(), "id".to_string()]));
        assert!(!runs_subcommand(&[]));
    }
}
