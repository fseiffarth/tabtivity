//! Project containers (TODO #38): one closed Docker container per project.
//!
//! When a project's container toggle is on, every terminal/agent tab of the
//! project (`shell` and `agent` kinds) execs into a single long-lived container
//! named `tabtivity-<project-id>`. `local_only` tabs (e.g. Ollama `local_agent`)
//! stay on the host verbatim. The container mounts **only the project
//! directory** plus the minimal agent auth/state paths, so a process inside it
//! physically cannot reach unrelated host files.
//!
//! Lifecycle: container lifetime = **project session**. It is created on
//! activation (`project_runtime::switch`) or on the first containerized spawn,
//! and torn down on deactivation (unless tabs are still live inside it), at app
//! exit (`down_all`), and at startup (`sweep_orphans` — a previous run's
//! containers are by definition stale). Every session starts from a fresh
//! container; installed deps and dev servers are shared between tabs *within*
//! a session.
//!
//! ## Identical-path mounting (correctness-critical)
//!
//! The project directory stays on the host and is bind-mounted at its
//! **identical absolute path**; the container runs `--user <uid>:<gid>` with
//! `-e HOME=<host home>`. This is what keeps the file tree, git UI, viewers and
//! usage watcher reading host bytes unchanged, keeps `-w <cwd>` trivially
//! correct for subdir tabs, and — most importantly — keeps **agent session
//! resume** working: transcripts and the SessionStart hook record host-absolute
//! cwds, so the *same* session resumes correctly whether the toggle is on or
//! off.
//!
//! **Windows** is the one host where "identical" cannot be literal: a Linux
//! container has no `C:\`. Every host path crossing into the container goes
//! through [`container_path`], the fixed, invertible Docker Desktop spelling
//! (`C:\Users\a\p` → `/c/Users/a/p`), and it is applied at exactly one layer —
//! the argv builders — so every mount planner above them keeps reasoning in
//! host paths. `--user` is omitted there (Docker Desktop maps bind-mounted
//! files to the Windows user regardless of the in-container uid).
//!
//! ## What the container can reach (blast radius)
//!
//! Only these host paths are bind-mounted, each at its identical absolute path:
//! - the **project directory** (rw) — the sole project bytes exposed;
//! - the project's **Tabtivity-owned agent home** (`services::agent_home`) at
//!   `$HOME` (rw): the agents' config, transcripts and session stores live
//!   there, never in the user's own home, which the container never sees;
//! - `<state_dir>/live_sessions/<project-id>` (rw) — where the in-container
//!   SessionStart hook records a tab's live session id for resume. **Per project**,
//!   not the shared root: one flat directory let a contained agent overwrite
//!   another project's tab record and so choose which conversation another
//!   project's agent resumes;
//! - the shared login directories of `services::agent_auth` (rw);
//! - `<state_dir>/hooks` and `<state_dir>/bin` **read-only** (see below);
//! - the repo's git control files, re-mounted read-only (`services::git_guard`).
//!
//! Nothing else under `$HOME` or `state_dir` (notably `projects.json`,
//! `time_log.json`, or another project's `live_sessions` record) is mounted.
//!
//! ## Hook mounts
//!
//! The SessionStart hook *script* lives at `<state_dir>/hooks/…`, is shared by
//! every agent home, and is mounted **read-only**: a writable copy would let a
//! compromised agent rewrite it and have code run on the host next time an
//! agent starts. The registration files that point at it are in the scope's
//! own home, where a rewrite affects that scope alone.
//!
//! ## The exec step and the tab-kill contract
//!
//! Tabs are spawned as `docker exec -i -t -w <cwd> … <name> sh -c '…' sh <cmd>
//! <args…>`. Per-tab env (`opts.env`, `TERM`/`COLORTERM`) and **agent-auth env**
//! (`ssh_exec::AGENT_AUTH_ENV`, read off the host process at exec time so
//! rotated tokens are picked up per spawn) ride as `-e` flags — secrets as a
//! bare `-e NAME` whose value docker reads from the client's environment, since
//! `/proc/<pid>/cmdline` is world-readable (#864). The `sh -c`
//! wrapper records the process's pid into an in-container pidfile before
//! exec'ing the real command: Docker does **not** kill an exec'd process when
//! its client dies, so closing a tab would otherwise leave the agent running
//! inside the container until session end. `PtyRegistry::kill` calls
//! [`kill_tab_process`], which TERMs that recorded pid (group) best-effort.
//!
//! ## Hardening
//!
//! Every container is created with `--init` (PID 1 reaps zombies),
//! `--security-opt no-new-privileges`, `--cap-drop ALL`, a `--pids-limit`
//! (fork-bomb guard), and `--label tabtivity.owner=tabtivity` so anything we started
//! is enumerable (and sweepable). Optional per-project knobs (`SandboxSpec`):
//! `--memory`, `--cpus`, `--network` (e.g. `none` for no egress), and
//! `--read-only` rootfs (+ `--tmpfs /tmp`). Docker's own socket is never
//! mounted. Note the default bridge network still reaches host-bound services
//! via the gateway IP (Ollama, dev servers); "closed" users set `network: none`
//! (breaks cloud agents) or a custom allowlist network.
//!
//! All paths are built from Rust path helpers as absolute strings — never
//! relying on `$HOME` shell-expansion, because `docker` is exec'd directly.

use crate::brand::SLUG;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use serde::Serialize;

use crate::paths;
use crate::schema::project::{DetectedSpecKind, DetectedSpecSource, SandboxScope, SandboxSpec};
use crate::storage;
use crate::terminal::PtyOptions;

/// Default image used when a project does not override it. Building/providing
/// this image is the user's responsibility; the toggle-time preflight offers a
/// one-click build (see `preflight_report` / `docker/agent-sandbox/`).
pub const DEFAULT_IMAGE: &str = crate::brand::SANDBOX_IMAGE;

/// Default `--pids-limit` when a project does not override it. Generous enough
/// for node + git + ripgrep + child processes, tight enough to blunt a fork bomb.
pub const DEFAULT_PIDS_LIMIT: u32 = 1024;

/// `--label` marking every container Tabtivity starts, so anything we own is
/// enumerable (`docker ps --filter label=…`) and sweepable at startup/exit.
pub const OWNER_LABEL: &str = crate::brand::DOCKER_OWNER_LABEL;

/// The reference sandbox image's Dockerfile, embedded so an installed app (no
/// repo checkout) can still materialize it for the one-click build flow.
const REFERENCE_DOCKERFILE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../docker/agent-sandbox/Dockerfile"
));

/// Runtime hardening flags for a project container. Built from a project's
/// `SandboxSpec`; owns its strings so it has no lifetime ties to the spec.
#[derive(Debug, Clone)]
pub struct HardenOpts {
    pub pids_limit: u32,
    pub memory: Option<String>,
    pub cpus: Option<String>,
    pub network: Option<String>,
    pub readonly_rootfs: bool,
}

impl Default for HardenOpts {
    fn default() -> Self {
        HardenOpts {
            pids_limit: DEFAULT_PIDS_LIMIT,
            memory: None,
            cpus: None,
            network: None,
            readonly_rootfs: false,
        }
    }
}

// ── Naming ────────────────────────────────────────────────────────────────

/// Reduce an id to a docker-name/shell/path-safe key (`[A-Za-z0-9_-]`, never
/// empty). Shared by the container name, the per-project stage dir, and the
/// per-tab pidfile so all three stay derivable from the same id — and, via
/// [`crate::storage::project_key`], by the per-project session directory, so a
/// project's container and its session state are named by the same rule.
fn sanitize_key(id: &str) -> String {
    crate::storage::project_key(id)
}

/// Name of the session container for a project: `tabtivity-<sanitized-id>`.
pub fn container_name_for(project_id: &str) -> String {
    format!("{}{}", crate::brand::CONTAINER_PREFIX, sanitize_key(project_id))
}

/// Image tag to run for a project: a `dockerfile` spec builds a per-project tag,
/// otherwise the spec's `image` override, otherwise the built-in default.
pub fn image_for(project_id: &str, spec: Option<&SandboxSpec>) -> String {
    if spec.is_some_and(|s| s.dockerfile.is_some()) {
        return format!("{}{}:latest", crate::brand::CONTAINER_PREFIX, sanitize_key(project_id));
    }
    spec.and_then(|s| s.image.clone())
        .unwrap_or_else(|| DEFAULT_IMAGE.to_string())
}

// ── Fingerprint + up decision (pure) ──────────────────────────────────────

/// Stable FNV-1a hash of everything baked into `docker run` at create time
/// (image, mounts, hardening — i.e. the create argv built with no fingerprint
/// label). Stored on the container as `--label tabtivity.spec=<hash>` so `up` can
/// detect a stale container whose spec/mounts no longer match and recreate it.
/// Deliberately not `DefaultHasher` (unstable across Rust releases — a false
/// mismatch would needlessly recreate on every app upgrade… of the hasher).
pub fn spec_fingerprint(create_args: &[String]) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for a in create_args {
        for b in a.as_bytes() {
            h ^= u64::from(*b);
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
        // Separator step so ["ab","c"] and ["a","bc"] hash differently.
        h ^= 0x1f;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{h:016x}")
}

/// What `up` observed about the named container.
#[derive(Debug, Clone, Default)]
pub struct ContainerProbe {
    pub exists: bool,
    pub running: bool,
    /// The `tabtivity.spec` label recorded at create, when present.
    pub fingerprint: Option<String>,
}

/// What `up` should do, given a probe and the wanted fingerprint.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpAction {
    /// Running and the spec still matches — no-op.
    UseExisting,
    /// Exists but stopped, or the spec/mounts changed — `rm -f`, then create.
    /// (Also covers crash leftovers.)
    Recreate,
    /// No such container — create.
    Create,
}

/// The idempotent three-state decision at the heart of `up`.
pub fn up_decision(probe: &ContainerProbe, want_fingerprint: &str) -> UpAction {
    if !probe.exists {
        return UpAction::Create;
    }
    if probe.running && probe.fingerprint.as_deref() == Some(want_fingerprint) {
        return UpAction::UseExisting;
    }
    UpAction::Recreate
}

// ── Argv builders (pure, unit-testable) ───────────────────────────────────

/// Build the `docker run -d … <image> sleep infinity` argv that creates a
/// project's session container. Pure: all host-derived inputs are passed in.
/// `rw_mounts`/`ro_mounts` are `src:dst` pairs (the project dir is always
/// mounted rw regardless); each `ro_mounts` entry gets a `:ro` suffix appended.
/// `fingerprint` is `None` while computing the fingerprint itself (the argv is
/// its own hash input), then `Some` for the real create.
#[allow(clippy::too_many_arguments)]
pub fn docker_create_args(
    name: &str,
    project_id: &str,
    image: &str,
    home: &str,
    uid: u32,
    gid: u32,
    project_dir: &str,
    rw_mounts: &[String],
    ro_mounts: &[String],
    harden: &HardenOpts,
    fingerprint: Option<&str>,
) -> Vec<String> {
    let mut a = vec![
        "run".to_string(),
        "-d".to_string(),
        "--name".to_string(),
        name.to_string(),
        // PID 1 reaps zombies — tabs come and go for the container's whole life.
        "--init".to_string(),
        "--label".to_string(),
        OWNER_LABEL.to_string(),
        "--label".to_string(),
        format!("{}={project_id}", crate::brand::DOCKER_PROJECT_LABEL),
    ];
    if let Some(fp) = fingerprint {
        // Keep the label out of its own hash input: it is appended only on the
        // second, real build of this argv.
        a.push("--label".to_string());
        a.push(format!("{}={fp}", crate::brand::DOCKER_SPEC_LABEL));
    }
    // `--user` carries the host identity in so files the container writes are
    // the user's. On Windows there is no host uid to carry (`host_uid_gid` is
    // `(0, 0)`) and Docker Desktop maps bind-mounted files to the Windows user
    // anyway, so the flag is simply not passed.
    if (uid, gid) != (0, 0) {
        a.extend(["--user".to_string(), format!("{uid}:{gid}")]);
    }
    a.extend([
        // Hardening: no privilege escalation, no Linux capabilities, bounded
        // process count. Docker's socket is deliberately never mounted.
        "--security-opt".to_string(),
        "no-new-privileges".to_string(),
        "--cap-drop".to_string(),
        "ALL".to_string(),
        "--pids-limit".to_string(),
        harden.pids_limit.to_string(),
        "-e".to_string(),
        format!("HOME={}", container_path(home)),
        "-w".to_string(),
        container_path(project_dir),
    ]);
    if let Some(mem) = &harden.memory {
        a.push("--memory".to_string());
        a.push(mem.clone());
    }
    if let Some(cpus) = &harden.cpus {
        a.push("--cpus".to_string());
        a.push(cpus.clone());
    }
    if let Some(net) = &harden.network {
        a.push("--network".to_string());
        a.push(net.clone());
    }
    if harden.readonly_rootfs {
        a.push("--read-only".to_string());
        // Writable scratch so tools that need /tmp (npm cache, the per-tab
        // pidfiles below) still work under a read-only rootfs.
        a.push("--tmpfs".to_string());
        a.push("/tmp".to_string());
    }
    // The project dir (the only project bytes exposed), always mounted rw at
    // its identical path (its container spelling on Windows).
    a.push("-v".to_string());
    a.push(format!("{project_dir}:{}", container_path(project_dir)));
    for m in rw_mounts {
        a.push("-v".to_string());
        a.push(volume_arg(m, false));
    }
    // Read-only mounts (the hook script dir). A nested `:ro` file mount over an
    // rw parent dir works regardless of argv order: docker applies bind mounts
    // parent-first by destination depth.
    for m in ro_mounts {
        a.push("-v".to_string());
        a.push(volume_arg(m, true));
    }
    a.push(image.to_string());
    // The container's sole job is to exist; tabs are `docker exec`s into it.
    a.push("sleep".to_string());
    a.push("infinity".to_string());
    a
}

/// Whether a tab variable's VALUE must stay off the `docker exec` argv (#864):
/// the forwarded agent credentials and Tabtivity's MCP bearer tokens. The docker
/// client stays alive for the tab's whole life, and `/proc/<pid>/cmdline` is
/// readable by every local user — not only this uid.
fn is_secret_exec_env(key: &str) -> bool {
    crate::services::ssh_exec::AGENT_AUTH_ENV.contains(&key)
        || [
            crate::services::root_mcp::TOKEN_ENV,
            crate::services::root_mcp::SCHEDULE_TOKEN_ENV,
            crate::services::root_mcp::GIT_TOKEN_ENV,
            crate::services::root_mcp::HELP_TOKEN_ENV,
            crate::services::root_mcp::MARKUP_TOKEN_ENV,
        ]
        .contains(&key)
}

/// The environment the `docker` CLIENT process must carry for
/// [`docker_exec_args`]: every secret it names as a bare `-e NAME`, which
/// docker resolves from its own environment (0400, same-uid) instead of argv.
/// `auth_env` wins a clash, as its later `-e` did when values rode the argv.
pub fn docker_exec_client_env(
    env: &BTreeMap<String, String>,
    auth_env: &BTreeMap<String, String>,
) -> BTreeMap<String, String> {
    env.iter()
        .filter(|(k, _)| is_secret_exec_env(k))
        .chain(auth_env.iter())
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
}

/// Build the `docker exec …` argv that runs a tab's command inside the session
/// container. Per-tab env rides as `-e K=V` flags (the exec inherits the
/// container env, notably `HOME`, from create) — except a secret (every
/// `auth_env` entry, and any [`is_secret_exec_env`] key of `env`), which rides
/// as a bare `-e NAME`: docker takes its value from the client's environment,
/// which the caller fills from [`docker_exec_client_env`] (#864). The `sh -c`
/// wrapper writes the process's pid to `pidfile` before exec'ing the real
/// command — the tab-kill contract (see the module doc and [`kill_tab_process`]).
pub fn docker_exec_args(
    name: &str,
    cwd: &str,
    env: &BTreeMap<String, String>,
    auth_env: &BTreeMap<String, String>,
    pidfile: &str,
    cmd: &str,
    cmd_args: &[String],
) -> Vec<String> {
    let mut a = vec![
        "exec".to_string(),
        "-i".to_string(),
        "-t".to_string(),
        "-w".to_string(),
        container_path(cwd),
        "-e".to_string(),
        "TERM=xterm-256color".to_string(),
        "-e".to_string(),
        "COLORTERM=truecolor".to_string(),
    ];
    for (k, v) in env {
        if auth_env.contains_key(k) {
            continue; // named once, below; the auth value wins as it always did
        }
        a.push("-e".to_string());
        if is_secret_exec_env(k) {
            a.push(k.clone());
            continue;
        }
        // The project dir is spelled for the container — under the variable's
        // old name too, when both are exported after a rename.
        let project_dir = k == crate::app_env!("PROJECT_DIR")
            || crate::brand::PAIR.legacy_env_name("PROJECT_DIR").as_deref() == Some(k.as_str());
        let value = if project_dir { container_path(v) } else { v.clone() };
        a.push(format!("{k}={value}"));
    }
    for k in auth_env.keys() {
        a.push("-e".to_string());
        a.push(k.clone());
    }
    a.push(name.to_string());
    a.push("sh".to_string());
    a.push("-c".to_string());
    // `pidfile` is built from sanitize_key output — shell-safe by construction.
    let bin = container_path(&crate::services::agent_bin::bin_dir().to_string_lossy());
    let bin = bin.replace('\'', "'\"'\"'");
    a.push(format!("export PATH='{bin}':\"$PATH\"; echo $$ > {pidfile}; exec \"$@\""));
    a.push("sh".to_string());
    a.push(cmd.to_string());
    a.extend(cmd_args.iter().cloned());
    a
}

// ── Authority resolution (pure) ───────────────────────────────────────────
//
// `PtyOptions.sandbox` and `PtyOptions.local_only` arrive from the renderer,
// which derives them from the tab store — and the tab store is rehydrated from a
// layout file that lives INSIDE the project tree (`.tabtivity/sessions/terminals.json`
// and `project.json`), i.e. inside the container's own writable mount and inside
// any cloned/imported repo. A persisted tab that declares `location: "local"`
// therefore used to defeat the container it was supposed to be confined by:
// `pty_spawn`'s gate is `if sandbox && !local_only { docker } else if !local_only
// { ssh }`, so `local_only == true` takes neither branch and the argv runs on the
// host.
//
// So the two flags are re-derived here from the trustworthy store (`projects.json`
// under `state_dir`, which is never mounted into a container) and the renderer's
// values are only honoured where they cannot lower authority.

/// The authority flags a spawn actually runs with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SpawnAuthority {
    pub sandbox: bool,
    pub local_only: bool,
}

/// Env var Tabtivity sets on every local-model tab (both the `vibe` per-model driver
/// and the `prepare_local_launch` drivers) to record which Ollama model it drives.
///
/// **A usage label, and nothing else.** It used to double as the marker that
/// granted a tab the right to skip the container, which was an authority decision
/// keyed on a telemetry string: `TabBar.tsx` sets it so the daily recap can break
/// local-agent tabs down by model, and *any* future surface that set it for a
/// display reason would silently have handed out container escapes. The authority
/// now comes from [`host_bound_marker_exists`].
pub const LOCAL_MODEL_ENV: &str = crate::app_env!("LOCAL_MODEL");

/// Directory of host-bound markers for a project:
/// `<state_dir>/sessions/<project key>/host_bound/`.
fn host_bound_dir(project_id: &str) -> std::path::PathBuf {
    crate::storage::project_session_dir(project_id).join("host_bound")
}

/// Whether `uid` is a well-formed marker name. A marker names a file, so it must
/// reduce to one path component and nothing else — this is the only validation
/// between a renderer-supplied string and a `join`.
fn valid_marker_uid(uid: &str) -> bool {
    !uid.is_empty()
        && uid.len() <= 64
        && uid
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Record that a tab was genuinely created as a host-bound local-model tab.
///
/// Written when the user opens one (`TabBar`/`NewTabMenu` → the
/// `register_host_bound_tab` command), into the state dir — which no container
/// mounts, unlike the persisted layout this decision used to be re-derived from.
/// The uid is the frontend-minted, layout-persisted `hostBoundUid`, stable across
/// a relaunch (the tab's key and PTY id are both regenerated on restore), so a
/// legitimately restored Ollama tab keeps its exemption.
pub fn register_host_bound_tab(project_id: &str, uid: &str) -> Result<(), String> {
    if !valid_marker_uid(uid) {
        return Err("invalid host-bound tab id".to_string());
    }
    let dir = host_bound_dir(project_id);
    std::fs::create_dir_all(&dir).map_err(|e| format!("create host_bound dir: {e}"))?;
    std::fs::write(dir.join(uid), b"1").map_err(|e| format!("write host_bound marker: {e}"))
}

/// Whether a marker exists for this (project, tab uid) pair.
pub fn host_bound_marker_exists(project_id: &str, uid: &str) -> bool {
    valid_marker_uid(uid) && host_bound_dir(project_id).join(uid).is_file()
}

/// Drop markers for tabs the project no longer has, so the directory does not
/// grow one file per local-model tab ever opened. Called after a layout save with
/// the uids the saved layout still carries.
pub fn prune_host_bound_markers(project_id: &str, keep: &std::collections::HashSet<String>) {
    let dir = host_bound_dir(project_id);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !keep.contains(&name) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// The commands a **host-bound** local-model tab can spawn: `vibe`, `ollama`
/// (`ollama launch <agent> --model …`) and the direct fallbacks of
/// `commands::ollama::LOCAL_DRIVERS`. These tabs must not be containerized even
/// when the project's toggle is on — they depend on the host's Ollama server,
/// `VIBE_HOME`, and each agent's host-side wiring, none of which exists inside the
/// image. Kept as an explicit allowlist rather than "trust whatever says it is
/// local": several of these names (`claude`, `codex`, …) are also ordinary agent
/// CLIs, which is exactly why a registered marker is required too.
pub const HOST_BOUND_LOCAL_AGENT_CMDS: &[&str] = &[
    "vibe", "ollama", "claude", "codex", "opencode", "droid", "openclaw",
];

/// Whether this spawn is one of the host-bound local-model driver tabs (see
/// [`HOST_BOUND_LOCAL_AGENT_CMDS`]): the command is a known driver **and** the tab
/// holds a registered host-bound marker.
///
/// `marker` is the caller's answer to "does this tab's uid have a marker file?",
/// injected so the policy stays pure and testable; the state-dir lookup is
/// [`host_bound_marker_exists`].
///
/// **What this buys, precisely.** It removes an authority decision that was keyed
/// on `TABTIVITY_LOCAL_MODEL` — a label `TabBar.tsx` sets for the usage recap, which
/// meant a display-only change elsewhere could hand out container escapes without
/// anyone noticing. It does *not* defend against a compromised renderer: the
/// registration is a command the renderer calls, so a renderer that can spawn can
/// also register. That case is the CSP's, and it is why the CSP is load-bearing.
pub fn is_host_bound_local_agent(cmd: &str, marker: bool) -> bool {
    marker && HOST_BOUND_LOCAL_AGENT_CMDS.contains(&cmd)
}

/// Whether a spawn's command launches an AI coding agent — the question
/// [`SandboxScope::Agents`] turns on. Mirrors `commands::agents::AGENTS` (the
/// registry the + menu lists) and the frontend's `AGENT_CMDS`; the three are the
/// same set by construction and `agent_registry_matches_classifier` fails if the
/// registry grows an entry this misses.
///
/// **Classified by the command that actually executes**, deliberately, and not by
/// a tab `kind` the renderer sends: `kind` is a label, `cmd` is the argv. A
/// renderer that lies about `cmd` does not win an exemption, it runs a different
/// program. The one thing this cannot see through is an agent launched
/// *indirectly* (`sh -c 'claude'`, a wrapper script), which under `Agents` runs on
/// the host — the same class of gap the host-bound marker documents, with the same
/// answer: it takes a renderer that can already spawn, which is the CSP's problem
/// and not this function's. Nothing in Tabtivity's own UI opens an agent that way.
///
/// Matched on the **basename**, so a pinned `/usr/local/bin/claude` or a
/// `~/.local/bin/codex` is still an agent.
pub fn is_agent_cmd(cmd: &str) -> bool {
    let base = cmd.rsplit(['/', '\\']).next().unwrap_or(cmd);
    let base = base.strip_suffix(".exe").unwrap_or(base);
    crate::commands::agents::agent_bins().contains(&base)
}

/// Re-derive a spawn's authority flags from the trustworthy project record.
///
/// - **No owning project** (root/global scope, connection terminals): pass through
///   — there is no project record to consult and no container to apply.
/// - **Remote project**: containers are local-only, so `sandbox` is forced off;
///   `local_only` is left to the renderer because it is a legitimate per-tab
///   choice there (run in the local mirror vs. on the host) and cannot escape a
///   container that was never going to apply.
/// - **Local project, toggle off**: `sandbox` forced off (the renderer must not be
///   able to invent a container spec); `local_only` is irrelevant — with no remote
///   to wrap, both values spawn on the host.
/// - **Local project, toggle on**: containerized, subject to `scope`. `local_only`
///   is ignored — the exceptions are a host-bound local-model driver tab, which
///   keeps running on the host exactly as before, and (under
///   [`SandboxScope::Agents`]) any spawn whose command is not an agent CLI.
///
/// **`scope` narrows, never widens.** It is read from the same trusted record as
/// `toggle_on` and is only ever consulted *after* the toggle has already said yes,
/// so a spec the renderer cannot write cannot be used to grant a container that
/// the project record does not.
pub fn resolve_spawn_authority(
    has_project: bool,
    is_remote: bool,
    toggle_on: bool,
    scope: SandboxScope,
    requested: SpawnAuthority,
    cmd: &str,
    host_bound_marker: bool,
) -> SpawnAuthority {
    if !has_project {
        return requested;
    }
    if is_remote || !toggle_on {
        return SpawnAuthority {
            sandbox: false,
            local_only: requested.local_only,
        };
    }
    if is_host_bound_local_agent(cmd, host_bound_marker) {
        return SpawnAuthority {
            sandbox: false,
            local_only: true,
        };
    }
    // Agents-only: a shell, a script, a viewer Run/Debug tab runs on the host with
    // the host's toolchain. `local_only` is left as the renderer asked, exactly as
    // in the toggle-off case — with no remote to wrap it changes nothing, and on a
    // remote project this branch is unreachable (handled above).
    if scope == SandboxScope::Agents && !is_agent_cmd(cmd) {
        return SpawnAuthority {
            sandbox: false,
            local_only: requested.local_only,
        };
    }
    SpawnAuthority {
        sandbox: true,
        local_only: false,
    }
}

/// State-dir-backed wrapper around [`resolve_spawn_authority`]: resolve the
/// project's remoteness and container toggle from `projects.json` and apply the
/// result to `opts` in place. Called from `pty_spawn` before any wrapping.
pub fn enforce_spawn_authority(opts: &mut PtyOptions) {
    let Some(project_id) = opts.project_id.clone() else {
        return;
    };
    // Box scopes (`box:<id>`) run local + uncontained by design (v1 trust
    // statement): a box has no container or VM of its own, and one member's
    // sandbox spec must not silently govern a tab that can also reach the
    // other members' trees — a half-applied boundary would read as a whole
    // one. The box editor surfaces the trust notice instead.
    if crate::commands::boxes::box_id_of_scope(&project_id).is_some() {
        if opts.sandbox {
            eprintln!(
                "sandbox: box-scoped tab '{}' resolved to sandbox: false (boxes run uncontained)",
                opts.id
            );
        }
        opts.sandbox = false;
        return;
    }
    let is_remote = crate::services::remote::remote_target_for(&project_id).is_some();
    let spec = sandbox_spec_for(&project_id);
    let toggle_on = spec.as_ref().is_some_and(|s| s.enabled);
    let scope = spec.as_ref().map(|s| s.scope).unwrap_or_default();
    // The container exemption is looked up in the state dir, never taken from the
    // spawn's own env — see `is_host_bound_local_agent`.
    let marker = opts
        .host_bound_uid
        .as_deref()
        .is_some_and(|uid| host_bound_marker_exists(&project_id, uid));
    let resolved = resolve_spawn_authority(
        true,
        is_remote,
        toggle_on,
        scope,
        SpawnAuthority {
            sandbox: opts.sandbox,
            local_only: opts.local_only,
        },
        &opts.cmd,
        marker,
    );
    if resolved.sandbox != opts.sandbox || resolved.local_only != opts.local_only {
        eprintln!(
            "sandbox: authority for tab '{}' resolved from the project record \
             (sandbox {} -> {}, local_only {} -> {})",
            opts.id, opts.sandbox, resolved.sandbox, opts.local_only, resolved.local_only
        );
    }
    opts.sandbox = resolved.sandbox;
    opts.local_only = resolved.local_only;
}

// ── Spawn-path entry point ────────────────────────────────────────────────

/// Rewrite `opts` to run its command inside the project's session container:
/// resolve the spec → `up()` (idempotent) → `docker exec`. No-op when
/// `opts.sandbox` is false. Errors (so `pty_spawn` surfaces the message in the
/// terminal) when docker, the daemon, or the image is unavailable, rather than
/// silently running the command on the host.
pub fn wrap_pty_options_docker(opts: &mut PtyOptions) -> Result<(), String> {
    if !opts.sandbox {
        return Ok(());
    }
    // Defence-in-depth: containers are local-only. Never docker-wrap a remote
    // project (resolved explicitly from the tab's owning project id).
    //
    // This is reachable with the toggle showing ON: a local project that had the
    // container enabled and was later `extend_project_to_remote`d keeps its
    // `sandbox.enabled` spec while every tab now runs on the remote host — possibly
    // an HPC login node. Refusing the spawn would break exactly those projects, so
    // the case stays a no-op, but it is no longer a *silent* one: it is logged and
    // surfaced to the frontend so the pill can say the container is not applied
    // (`enforce_spawn_authority` has already cleared `opts.sandbox` for the same
    // reason, so in practice this branch is the belt to that braces).
    if let Some(id) = opts.project_id.as_deref() {
        if crate::services::remote::remote_target_for(id).is_some() {
            eprintln!(
                "sandbox: project '{id}' has the container toggle ON but is a REMOTE project — \
                 the container is NOT applied and tab '{}' runs unsandboxed on the remote host. \
                 Clear the toggle to make the pill honest.",
                opts.id
            );
            return Ok(());
        }
    }
    let project_id = opts
        .project_id
        .clone()
        .ok_or_else(|| "Project container: this tab has no owning project.".to_string())?;

    let spec = sandbox_spec_for(&project_id);
    // The container mounts the project ROOT; a subdir tab keeps its cwd via -w.
    let project_dir = project_dir_for(&project_id).unwrap_or_else(|| opts.cwd.clone());
    let name = up(&project_id, spec.as_ref(), &project_dir)?;

    // A shell tab spawns with an empty cmd (host default shell) — resolve the
    // *in-container* shell instead: bash when the image has it, else sh.
    let (cmd, cmd_args) = if opts.cmd.is_empty() {
        (
            "sh".to_string(),
            vec![
                "-c".to_string(),
                "command -v bash >/dev/null 2>&1 && exec bash; exec sh".to_string(),
            ],
        )
    } else {
        (opts.cmd.clone(), opts.args.clone())
    };

    // opts.env is already resolved (TABTIVITY_TAB_UID, resume args' env, etc.).
    let env: BTreeMap<String, String> = opts.env.clone().into_iter().collect();
    // Auth env is read at exec (not create) so rotated tokens are picked up
    // per tab spawn.
    let auth_env = host_auth_env();
    let pidfile = register_exec_tab(&opts.id, &name);

    opts.args = docker_exec_args(&name, &opts.cwd, &env, &auth_env, &pidfile, &cmd, &cmd_args);
    opts.cmd = "docker".to_string();
    // Env now rides inside the docker argv as `-e` flags; the docker client
    // itself needs nothing from opts.env — except the secrets, which the argv
    // only names (`-e NAME`) and docker reads from the client's own env (#864).
    opts.env.clear();
    opts.env.extend(docker_exec_client_env(&env, &auth_env));
    Ok(())
}

// ── Host → container paths ────────────────────────────────────────────────

/// The container-side spelling of a host path.
///
/// Linux/macOS: the path itself (identical-path mounting). Windows: Docker
/// Desktop's convention — the drive letter becomes a lowercase root
/// directory and separators turn forward (`C:\Users\a` → `/c/Users/a`); a UNC
/// path `\\server\share\x` becomes `/server/share/x`. Pure over `windows`
/// so the mapping is tested on every OS; [`container_path`] passes the real
/// target.
pub(crate) fn container_path_for(host: &str, windows: bool) -> String {
    if !windows {
        return host.to_string();
    }
    let forward = host.replace('\\', "/");
    let bytes = forward.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
        let drive = (bytes[0] as char).to_ascii_lowercase();
        let rest = forward[2..].trim_start_matches('/');
        if rest.is_empty() {
            format!("/{drive}")
        } else {
            format!("/{drive}/{rest}")
        }
    } else if let Some(unc) = forward.strip_prefix("//") {
        format!("/{unc}")
    } else {
        forward
    }
}

pub(crate) fn container_path(host: &str) -> String {
    container_path_for(host, cfg!(windows))
}

/// Split a `src:dst` mount pair. Every planner writes the pair with a host
/// path on both sides, and on Windows both carry a drive colon, so the
/// separator is the first `:` that is followed by a path start (`/`, `\`, or
/// another `X:` drive) — never the one at index 1 of a drive path.
pub(crate) fn split_mount_pair(pair: &str) -> (&str, &str) {
    let bytes = pair.as_bytes();
    for (i, &b) in bytes.iter().enumerate() {
        if b != b':' || i < 2 {
            continue;
        }
        let next = bytes.get(i + 1).copied();
        let starts_path = matches!(next, Some(b'/') | Some(b'\\'))
            || (next.is_some_and(|c| c.is_ascii_alphabetic()) && bytes.get(i + 2) == Some(&b':'));
        if starts_path {
            return (&pair[..i], &pair[i + 1..]);
        }
    }
    // A pair with no recognisable separator (a plain POSIX `a:b` where `b` has
    // no leading slash): fall back to the first colon, the historical rule.
    pair.split_once(':').unwrap_or((pair, pair))
}

/// `-v` value for a planner pair: the host source verbatim, the destination in
/// the container's spelling.
fn volume_arg(pair: &str, read_only: bool) -> String {
    let (src, dst) = split_mount_pair(pair);
    let dst = container_path(dst);
    if read_only {
        format!("{src}:{dst}:ro")
    } else {
        format!("{src}:{dst}")
    }
}

// ── Container lifecycle ───────────────────────────────────────────────────

/// Serializes every create/remove so racing project switches (or a switch
/// racing a tab spawn) never interleave an `rm -f` with a `run` for the same
/// container.
fn lifecycle_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// Container names created by THIS app run — bounds who `down_for_project`
/// spawns docker for (a project that never went up needs no teardown attempt),
/// and whether exit needs a `down_all` at all.
fn created_set() -> &'static Mutex<HashSet<String>> {
    static SET: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    SET.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Idempotent "make the project's session container exist and match the spec".
/// Returns the container name. Three-state: running+fingerprint-match → no-op;
/// exists-but-stopped or fingerprint-mismatch → `rm -f` + create; missing →
/// create. Called from the activation warm-up and from every containerized
/// spawn (the fallback for tabs opened before activation completes).
pub fn up(
    project_id: &str,
    spec: Option<&SandboxSpec>,
    project_dir: &str,
) -> Result<String, String> {
    let _guard = lifecycle_lock().lock().unwrap();
    preflight_docker()?;
    preflight_daemon()?;

    let name = container_name_for(project_id);
    let home = paths::home_dir_string();
    let (uid, gid) = host_uid_gid();
    let state_dir = storage::state_dir();
    let live_sessions = state_dir.join("live_sessions");
    // This project's own slice of the live-session records — the only one the
    // container gets to see (see `rw_mounts`).
    let live_sessions_own = crate::services::agent_session::project_live_sessions_dir(project_id);
    let hooks_dir = state_dir.join("hooks");
    // Ensure the hook's write target exists so its bind mount maps a real host
    // path rather than a docker-auto-created (root-owned) one. Best effort.
    let _ = std::fs::create_dir_all(&live_sessions_own);

    // The scope's Tabtivity-owned agent home is the container's `$HOME`
    // (`services::agent_home`): the user's own home never enters it.
    let scope_home = crate::services::agent_home::prepare_scope_home(
        project_id,
        &[PathBuf::from(project_dir)],
    )
    .map_err(|e| format!("Project container: prepare agent home: {e}"))?
    .dir;
    // Parent first; Docker also sorts nested bind mounts by destination,
    // but preserving the relationship here keeps the pure argv obvious.
    let rw_mounts = vec![
        format!("{}:{home}", scope_home.to_string_lossy()),
        format!(
            "{}:{}",
            live_sessions_own.to_string_lossy(),
            live_sessions.to_string_lossy()
        ),
    ];
    let mut ro_mounts = ro_mounts_for_hooks(&hooks_dir);
    let bin = crate::services::agent_bin::bin_dir();
    std::fs::create_dir_all(&bin).map_err(|e| e.to_string())?;
    ro_mounts.push(format!("{0}:{0}", bin.to_string_lossy()));
    let harden = harden_opts(spec);
    let image = image_for(project_id, spec);

    // The create argv (sans fingerprint label) is its own fingerprint input —
    // deliberately WITHOUT the git-guard mounts below, whose set changes as the
    // agent works; a fingerprint mismatch means `rm -f` + recreate under the
    // live tabs. Mounts are fixed at create anyway.
    let base = docker_create_args(
        &name,
        project_id,
        &image,
        &home,
        uid,
        gid,
        project_dir,
        &rw_mounts,
        &ro_mounts,
        &harden,
        None,
    );
    let fingerprint = spec_fingerprint(&base);

    // The repo's git control files, re-mounted over the rw project (#158): a
    // contained agent can commit, but cannot plant a hook or `core.fsmonitor`
    // for the host's next git, nor swap `.git` for a `gitdir:` pointer. Kept out
    // of the fingerprint like the transcript mounts: which of them exist
    // changes as the agent works, and a mismatch would recreate the container
    // under its live tabs.
    let guard = crate::services::git_guard::guard_paths(&[PathBuf::from(project_dir)], None);
    let identical = |p: PathBuf| {
        let p = p.to_string_lossy().into_owned();
        format!("{p}:{p}")
    };
    let rw_mounts: Vec<String> = rw_mounts
        .into_iter()
        .chain(guard.pinned.into_iter().map(identical))
        .collect();
    let ro_mounts: Vec<String> = ro_mounts
        .into_iter()
        .chain(guard.read_only.into_iter().map(identical))
        .collect();

    match up_decision(&probe_container(&name), &fingerprint) {
        UpAction::UseExisting => {
            created_set().lock().unwrap().insert(name.clone());
            return Ok(name);
        }
        UpAction::Recreate => {
            let _ = docker(&["rm", "-f", &name]);
        }
        UpAction::Create => {}
    }

    ensure_image(spec, project_dir, &image)?;

    let args = docker_create_args(
        &name,
        project_id,
        &image,
        &home,
        uid,
        gid,
        project_dir,
        &rw_mounts,
        &ro_mounts,
        &harden,
        Some(&fingerprint),
    );
    let argv: Vec<&str> = args.iter().map(String::as_str).collect();
    let out = docker(&argv)?;
    if !out.status.success() {
        return Err(format!(
            "Project container: docker run failed: {}",
            stderr_tail(&out)
        ));
    }
    created_set().lock().unwrap().insert(name.clone());
    Ok(name)
}

/// Activation warm-up: `up()` for a project *iff* it is a container-toggled,
/// local project. `Ok(None)` when the toggle is off / the project is remote —
/// callers treat that as "nothing to do".
pub fn up_for_project(project_id: &str) -> Result<Option<String>, String> {
    if crate::services::remote::remote_target_for(project_id).is_some() {
        return Ok(None);
    }
    let Some(spec) = sandbox_spec_for(project_id) else {
        return Ok(None);
    };
    if !spec.enabled {
        return Ok(None);
    }
    let dir = project_dir_for(project_id)
        .ok_or_else(|| format!("project '{project_id}' has no directory"))?;
    up(project_id, Some(&spec), &dir).map(Some)
}

/// Tear down a project's session container (`rm -f` by name). Idempotent,
/// best-effort. Only spawns docker when this run actually created the container
/// or the toggle is currently on — a never-containerized project costs nothing.
pub fn down_for_project(project_id: &str) {
    let name = container_name_for(project_id);
    let created = created_set().lock().unwrap().contains(&name);
    if !created && !sandbox_spec_for(project_id).is_some_and(|s| s.enabled) {
        return;
    }
    let _guard = lifecycle_lock().lock().unwrap();
    let _ = docker(&["rm", "-f", &name]);
    created_set().lock().unwrap().remove(&name);
    exec_tabs()
        .lock()
        .unwrap()
        .retain(|_, t| t.container != name);
}

/// App-exit teardown: remove every tabtivity-owned container. Skipped entirely
/// when this run never created one (a crash's leftovers are `sweep_orphans`'s
/// job next startup).
pub fn down_all() {
    if created_set().lock().unwrap().is_empty() {
        return;
    }
    remove_all_owned();
    created_set().lock().unwrap().clear();
    exec_tabs().lock().unwrap().clear();
}

/// Startup: wipe the per-scope stage root (a previous run's private launcher
/// dirs and Seatbelt profiles). Nothing in it outlives a run.
pub fn clear_stage() {
    let _ = std::fs::remove_dir_all(storage::state_dir().join("sandbox-stage"));
}

/// Startup sweep: remove every container labelled `tabtivity.owner=tabtivity` (a
/// previous run's containers are by definition stale). The staged config
/// copies are cleared by [`clear_stage`], which must have run first
/// and synchronously. Best-effort; cheap no-op when docker is absent.
pub fn sweep_orphans() {
    // Containers run on every OS with Docker (Docker Desktop on Windows and
    // macOS), so a crashed or killed previous run can leave one behind anywhere.
    // What must not happen is a `docker --version`/`docker ps` spawn at every
    // startup on a machine with no Docker at all — hence the PATH walk first,
    // which spawns nothing.
    if !sweep_should_probe(crate::paths::binary_on_path("docker")) || preflight_docker().is_err() {
        return;
    }
    remove_all_owned();
}

/// Whether the startup sweep may spend a `docker` spawn at all: only when a
/// docker CLI resolves on Tabtivity's PATH. Pure so the gate is testable on any OS.
fn sweep_should_probe(docker_on_path: bool) -> bool {
    docker_on_path
}

/// `docker rm -f` every container carrying our owner label. Best-effort.
fn remove_all_owned() {
    let _guard = lifecycle_lock().lock().unwrap();
    // The owner label, and — after a rename — the one an older build put on
    // its containers: both are this app's, and both are stale.
    let pair = crate::brand::PAIR;
    for label in crate::services::brand_migration::docker::owner_labels(&pair) {
        let Ok(out) = docker(&["ps", "-aq", "--filter", &format!("label={label}")]) else {
            return;
        };
        let ids: Vec<&str> = std::str::from_utf8(&out.stdout)
            .unwrap_or("")
            .split_whitespace()
            .collect();
        if ids.is_empty() {
            continue;
        }
        crate::services::brand_migration::docker::swept_legacy(&pair, &label);
        let mut args = vec!["rm", "-f"];
        args.extend(ids);
        let _ = docker(&args);
    }
}

/// Inspect the named container: does it exist, is it running, and which spec
/// fingerprint was it created with?
fn probe_container(name: &str) -> ContainerProbe {
    let out = match docker(&[
        "inspect",
        "--format",
        &format!("{{{{.State.Running}}}}\t{{{{index .Config.Labels \"{}\"}}}}", crate::brand::DOCKER_SPEC_LABEL),
        name,
    ]) {
        Ok(o) if o.status.success() => o,
        _ => return ContainerProbe::default(),
    };
    let stdout = String::from_utf8_lossy(&out.stdout);
    let line = stdout.trim();
    let (running, fp) = line.split_once('\t').unwrap_or((line, ""));
    ContainerProbe {
        exists: true,
        running: running == "true",
        fingerprint: (!fp.is_empty()).then(|| fp.to_string()),
    }
}

/// Resolve a spec's `dockerfile` to an absolute path **inside** the project.
///
/// `docker build` runs the Dockerfile's `RUN` steps as **root** with default
/// capabilities and full network — a strictly larger blast radius than the session
/// container (`--user <uid>` / `--cap-drop ALL` / `no-new-privileges`). The value
/// was joined onto `project_dir` with no traversal check, so an absolute path or a
/// `../..` chain pointed the build at a file outside the project entirely. Refuse
/// both, then confine the canonicalized result against the project root so a
/// symlinked Dockerfile cannot smuggle the same escape.
fn resolve_spec_dockerfile(project_dir: &Path, df: &str) -> Result<PathBuf, String> {
    let rel = Path::new(df);
    if rel.is_absolute() || df.starts_with('/') || df.starts_with('\\') {
        return Err(format!(
            "Project container: Dockerfile '{df}' must be a path inside the project, not absolute."
        ));
    }
    if rel
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(format!(
            "Project container: Dockerfile '{df}' must not contain '..'."
        ));
    }
    let joined = project_dir.join(rel);
    // Canonicalize both sides so the prefix check compares resolved paths (the
    // Dockerfile must exist to be built, so canonicalization is expected to work).
    let root = project_dir
        .canonicalize()
        .unwrap_or_else(|_| project_dir.to_path_buf());
    let resolved = joined.canonicalize().map_err(|e| {
        format!(
            "Project container: Dockerfile '{}' is unreadable: {e}",
            joined.display()
        )
    })?;
    crate::commands::fs::enforce_confinement(&root, &resolved)
        .map_err(|e| format!("Project container: {e}"))?;
    Ok(resolved)
}

/// Docker networks a project spec may name.
///
/// `bridge`/`none` are the two meaningful built-ins; a user-created network is any
/// `[A-Za-z0-9_.-]+` name. **`host` is refused**: it removes network isolation
/// outright (the container shares the host's stack, reaching every loopback-bound
/// service), and the spec can be written by a compromised renderer or — before the
/// `project.json` fallback was removed — from inside the project tree. Docker's own
/// `container:<id>` and `ns:<path>` forms are refused for the same reason.
pub fn validate_network(net: &str) -> Result<(), String> {
    let net = net.trim();
    if net.is_empty() {
        return Err("Project container: network name cannot be empty.".to_string());
    }
    if net.eq_ignore_ascii_case("host") {
        return Err(
            "Project container: network 'host' is not allowed — it removes the container's \
             network isolation. Use 'bridge', 'none', or a custom docker network."
                .to_string(),
        );
    }
    if net
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-')
    {
        Ok(())
    } else {
        Err(format!(
            "Project container: '{net}' is not a valid docker network name."
        ))
    }
}

/// Make the image runnable: build it from the project's in-repo Dockerfile when
/// the spec says so, otherwise require it to already exist locally.
fn ensure_image(spec: Option<&SandboxSpec>, project_dir: &str, image: &str) -> Result<(), String> {
    if let Some(df) = spec.and_then(|s| s.dockerfile.as_deref()) {
        let df_path = resolve_spec_dockerfile(Path::new(project_dir), df)?;
        let df_path = df_path.as_path();
        let out = docker(&[
            "build",
            "-t",
            image,
            "-f",
            &df_path.to_string_lossy(),
            project_dir,
        ])?;
        if !out.status.success() {
            return Err(format!(
                "Project container: building '{df}' failed: {}",
                stderr_tail(&out)
            ));
        }
        return Ok(());
    }
    if image_exists(image) {
        return Ok(());
    }
    Err(format!(
        "Project container: image '{image}' not found. Toggle the container off and on again \
         to get a one-click build, or provide the image yourself (`docker build -t {image} \
         docker/agent-sandbox` from the {app} repo, or `docker pull` for a registry image).", app = crate::brand::DISPLAY
    ))
}

// ── Preflight ─────────────────────────────────────────────────────────────

/// `docker` binary present and runnable?
fn preflight_docker() -> Result<(), String> {
    match crate::paths::command_no_window("docker")
        .arg("--version")
        .output()
    {
        Ok(o) if o.status.success() => Ok(()),
        _ => Err(
            "Project container: 'docker' not found. Install Docker, or turn the container \
             toggle off for this project."
                .to_string(),
        ),
    }
}

/// Daemon actually up? `docker --version` succeeds daemon-less, so a dead
/// daemon must be diagnosed separately — "image missing" and "Docker isn't
/// running" are different user actions.
fn preflight_daemon() -> Result<(), String> {
    match docker(&["info", "--format", "{{.ServerVersion}}"]) {
        Ok(o) if o.status.success() => Ok(()),
        _ => Err(if cfg!(target_os = "linux") {
            "Project container: Docker isn't running. Start the Docker service (e.g. \
             `systemctl start docker`), or turn the container toggle off for this project."
                .to_string()
        } else {
            "Project container: Docker isn't running. Start Docker Desktop, or turn the \
             container toggle off for this project."
                .to_string()
        }),
    }
}

fn image_exists(image: &str) -> bool {
    let exists = |image: &str| {
        docker(&["image", "inspect", image])
            .map(|o| o.status.success())
            .unwrap_or(false)
    };
    // The stock image an older build pulled or built carries the app's old
    // name: it is tagged with the current one instead of being rebuilt. One
    // `inspect`, as before, while the name is unchanged.
    crate::services::brand_migration::docker::adopt_legacy_image(&crate::brand::PAIR, image, exists, |from, to| {
        docker(&["tag", from, to]).map(|o| o.status.success()).unwrap_or(false)
    })
}

/// Toggle-time preflight verdict, surfaced to the frontend so a missing image
/// becomes a one-click open-new-tab-paste-run build (house convention — never a
/// copy-it-yourself message) instead of an error at the next tab spawn.
#[derive(Debug, Clone, Serialize)]
pub struct PreflightReport {
    /// "ok" | "no_docker" | "daemon_down" | "image_missing"
    pub status: String,
    pub image: String,
    /// For "image_missing": the shell command that provides the image — a
    /// `docker build` of the in-repo/embedded reference Dockerfile for tabtivity
    /// images, a `docker pull` for registry images.
    pub build_command: Option<String>,
}

/// Run the preflight for a project and describe the outcome (never errors —
/// the caller renders the status).
pub fn preflight_report(project_id: &str) -> PreflightReport {
    let spec = sandbox_spec_for(project_id);
    let image = image_for(project_id, spec.as_ref());
    let report = |status: &str, build: Option<String>| PreflightReport {
        status: status.to_string(),
        image: image.clone(),
        build_command: build,
    };
    if preflight_docker().is_err() {
        return report("no_docker", None);
    }
    if preflight_daemon().is_err() {
        return report("daemon_down", None);
    }
    // A dockerfile spec builds at `up`; nothing to pre-provide.
    if spec.as_ref().is_some_and(|s| s.dockerfile.is_some()) {
        return report("ok", None);
    }
    if image_exists(&image) {
        return report("ok", None);
    }
    let build = build_command(project_id, &image);
    report("image_missing", build)
}

/// The command that provides a missing image. Tabtivity's own images build from
/// `docker/agent-sandbox` when the project carries a checkout, else from an
/// embedded copy of the reference Dockerfile materialized under the state dir
/// (an installed app has no repo checkout). Anything else is a registry pull.
fn build_command(project_id: &str, image: &str) -> Option<String> {
    if image != DEFAULT_IMAGE && !image.starts_with(crate::brand::CONTAINER_PREFIX) {
        return Some(format!("docker pull {image}"));
    }
    let windows = cfg!(target_os = "windows");
    if let Some(dir) = project_dir_for(project_id) {
        let in_repo = Path::new(&dir).join("docker").join("agent-sandbox");
        if in_repo.join("Dockerfile").is_file() {
            return Some(format!(
                "docker build -t {image} {}",
                install_shell_quote(&in_repo.to_string_lossy(), windows)
            ));
        }
    }
    let stage = storage::state_dir().join("agent-sandbox");
    std::fs::create_dir_all(&stage).ok()?;
    std::fs::write(stage.join("Dockerfile"), REFERENCE_DOCKERFILE).ok()?;
    Some(format!(
        "docker build -t {image} {}",
        install_shell_quote(&stage.to_string_lossy(), windows)
    ))
}

/// Quote `path` as one argument for the shell the frontend runs the build in:
/// PowerShell on Windows, bash elsewhere (`ProjectPill`/`ProjectDialog` pick the
/// matching shell). Both take `'…'` literally, but they escape an apostrophe
/// differently — doubled in PowerShell, `'\''` in POSIX shells. cmd.exe is never
/// the target: it does not treat `'` as a quote at all, so a path with a space
/// would split.
pub(crate) fn install_shell_quote(path: &str, windows: bool) -> String {
    if windows {
        format!("'{}'", path.replace('\'', "''"))
    } else {
        format!("'{}'", path.replace('\'', "'\\''"))
    }
}

// ── Tab-kill contract ─────────────────────────────────────────────────────

/// A containerized tab's kill handle: which container it execs into and the
/// in-container pidfile its kill-wrapper wrote.
#[derive(Debug, Clone)]
struct ExecTab {
    container: String,
    pidfile: String,
}

fn exec_tabs() -> &'static Mutex<HashMap<String, ExecTab>> {
    static MAP: OnceLock<Mutex<HashMap<String, ExecTab>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Register a containerized tab at spawn and mint its per-spawn pidfile path.
/// The nonce keeps a respawn's pidfile distinct from its predecessor's, so
/// killing the OLD process (below) can never race the NEW spawn's pidfile
/// write. A previous registration for the same tab id (this is a respawn) is
/// killed here — Docker does not kill an exec'd process when its client dies.
fn register_exec_tab(tab_id: &str, container: &str) -> String {
    static NONCE: AtomicU64 = AtomicU64::new(0);
    let n = NONCE.fetch_add(1, Ordering::Relaxed);
    let pidfile = format!("/tmp/{SLUG}-tab-{}-{n}.pid", sanitize_key(tab_id));
    let tab = ExecTab {
        container: container.to_string(),
        pidfile: pidfile.clone(),
    };
    if let Some(old) = exec_tabs().lock().unwrap().insert(tab_id.to_string(), tab) {
        spawn_kill(old);
    }
    pidfile
}

/// Kill the in-container process of a (possibly former) containerized tab.
/// Called from `PtyRegistry::kill` on tab close — killing the PTY child only
/// kills the `docker exec` *client*; the agent inside would otherwise keep
/// running until session end. Cheap no-op for tabs that never containerized.
pub fn kill_tab_process(tab_id: &str) {
    if let Some(tab) = exec_tabs().lock().unwrap().remove(tab_id) {
        spawn_kill(tab);
    }
}

/// TERM the recorded pid (preferring its process group) inside the container,
/// then drop the pidfile. Own thread + best-effort: the container may already
/// be gone, which is fine — teardown is what bounds stragglers.
fn spawn_kill(tab: ExecTab) {
    std::thread::spawn(move || {
        let script = format!(
            "p=$(cat {pf} 2>/dev/null); [ -n \"$p\" ] && \
             (kill -TERM -- \"-$p\" 2>/dev/null || kill -TERM \"$p\" 2>/dev/null); rm -f {pf}",
            pf = tab.pidfile
        );
        let _ = docker(&["exec", &tab.container, "sh", "-c", &script]);
    });
}

// ── Spec / project resolution ─────────────────────────────────────────────

/// Read the sandbox spec for `project_id` from the always-local `projects.json`
/// entry's flattened `extra["sandbox"]`. `None` when unknown/unparseable — the
/// caller then falls back to defaults. Mirrors `remote::remote_target_for`.
pub fn sandbox_spec_for(project_id: &str) -> Option<SandboxSpec> {
    let entry_value = project_entry_value(project_id, "sandbox")?;
    serde_json::from_value(entry_value).ok()
}

/// The project's directory (the bind-mount root), from the `projects.json`
/// entry's flattened `extra["directory"]`, falling back to the parent of its
/// `local_file` (always `<directory>/project.json`) for legacy entries. Never the
/// `directory` *inside* `project.json`: that file sits in the container's own rw
/// mount, and a value read from it would let the contained process choose what
/// the next container mounts.
pub fn project_dir_for(project_id: &str) -> Option<String> {
    if let Some(v) = project_entry_value(project_id, "directory") {
        if let Some(s) = v.as_str() {
            if !s.is_empty() {
                return Some(s.to_string());
            }
        }
    }
    let list_path = storage::state_dir().join("projects.json");
    let list: crate::schema::projects::ProjectsList = storage::read_json(&list_path).ok()?;
    let entry = list.iter().find(|e| e.id == project_id)?;
    Path::new(&entry.local_file)
        .parent()
        .map(|p| p.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
}

/// The project id whose tabs at `project_dir` would run **inside a container** —
/// i.e. the id to run an in-container probe against, or `None` when a tab opened
/// there runs on the host.
///
/// The reverse lookup is `remote_target_for_dir`'s (an entry's stored
/// `extra["directory"]`, matched verbatim), because the callers that need this
/// are the same ones: they hold a `project_dir`, not an id.
///
/// Three conditions, and the third is the point: the toggle is on, the project is
/// local (a container never applies to a remote one), **and** the scope is
/// [`SandboxScope::All`]. Under `Agents` a shell tab — which is what the viewer's
/// Run/Debug is — spawns on the host, so probing the container would answer a
/// question about the wrong machine. The rule that decides where the tab runs is
/// therefore the same rule that decides where we look for its interpreter, rather
/// than two conditions that can drift apart.
pub fn containerized_project_for_dir(project_dir: &str) -> Option<String> {
    let list_path = storage::state_dir().join("projects.json");
    let list: crate::schema::projects::ProjectsList = storage::read_json(&list_path).ok()?;
    let entry = list.iter().find(|e| {
        e.extra
            .get("directory")
            .and_then(|v| v.as_str())
            .is_some_and(|d| d == project_dir)
    })?;
    if crate::services::remote::remote_target_for(&entry.id).is_some() {
        return None;
    }
    let spec = sandbox_spec_for(&entry.id)?;
    (spec.enabled && spec.scope == SandboxScope::All).then(|| entry.id.clone())
}

/// Run a **constant** POSIX-`sh` script inside a project's session container and
/// return its stdout — the `docker exec` twin of
/// `ssh_exec::run_remote_script`, and bound by the same contract: nothing may be
/// interpolated into `script`, because it is handed to `sh -c` verbatim.
///
/// Deliberately **does not `up()` the container.** This serves probes (which
/// interpreter is in there?), and a probe must not be able to pull a multi-second
/// image start into a dialog that is merely being opened — nor start a container
/// for a project the user is only inspecting. A container that is not running
/// answers `None`, and the caller falls back rather than waiting.
pub fn run_in_container(project_id: &str, cwd: &str, script: &str) -> Option<String> {
    let name = container_name_for(project_id);
    if !probe_container(&name).running {
        return None;
    }
    let out = docker(&["exec", "-w", cwd, &name, "sh", "-c", script]).ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn project_entry_value(project_id: &str, key: &str) -> Option<serde_json::Value> {
    let list_path = storage::state_dir().join("projects.json");
    let list: crate::schema::projects::ProjectsList = storage::read_json(&list_path).ok()?;
    let entry = list.iter().find(|e| e.id == project_id)?;
    entry.extra.get(key).cloned()
}

/// Detect in-repo container sources for a project: a root `Dockerfile` wins,
/// else a `.devcontainer/devcontainer.json` `image` field. Returns `None` when
/// neither is present. Pure detection — reports what the repo declares, never
/// applies it (O#143: `commands::projects::set_project_sandbox` is the only
/// caller allowed to write a detected source into a spec, and only after an
/// explicit user decision).
pub fn detect_spec_source(project_dir: &Path) -> Option<DetectedSpecSource> {
    if project_dir.join("Dockerfile").is_file() {
        // Reuse the traversal-safe resolver so a symlinked/escaping Dockerfile
        // is refused here too rather than only at build time.
        let path = resolve_spec_dockerfile(project_dir, "Dockerfile").ok()?;
        let bytes = std::fs::read(&path).ok()?;
        return Some(DetectedSpecSource {
            kind: DetectedSpecKind::Dockerfile,
            value: "Dockerfile".to_string(),
            hash: sha256_hex(&bytes),
        });
    }
    let devcontainer = project_dir.join(".devcontainer").join("devcontainer.json");
    let text = std::fs::read_to_string(&devcontainer).ok()?;
    // devcontainer.json is JSONC; strip line comments so serde can parse the
    // common case. (A devcontainer that only names a Dockerfile/compose setup
    // has no `image` and is simply not detected.)
    let stripped: String = text
        .lines()
        .filter(|l| !l.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n");
    let v: serde_json::Value = serde_json::from_str(&stripped).ok()?;
    let image = v
        .get("image")
        .and_then(|i| i.as_str())
        .filter(|s| !s.is_empty())?;
    Some(DetectedSpecSource {
        kind: DetectedSpecKind::DevcontainerImage,
        value: image.to_string(),
        hash: sha256_hex(image.as_bytes()),
    })
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

/// Test/back-compat shim over [`detect_spec_source`]: writes straight into a
/// `SandboxSpec` the way the pre-#143 auto-adopt path did. Production code
/// no longer calls this — `commands::projects::set_project_sandbox` calls
/// `detect_spec_source` directly and gates the write on a user decision.
#[cfg(test)]
fn detect_spec_sources(project_dir: &Path, spec: &mut SandboxSpec) {
    match detect_spec_source(project_dir) {
        Some(DetectedSpecSource {
            kind: DetectedSpecKind::Dockerfile,
            value,
            ..
        }) => spec.dockerfile = Some(value),
        Some(DetectedSpecSource {
            kind: DetectedSpecKind::DevcontainerImage,
            value,
            ..
        }) => spec.image = Some(value),
        None => {}
    }
}

// ── Mounts / identity (shared helpers) ────────────────────────────────────


// ── Claude transcript dirs: which scope they belong to ─────────────────────

/// How many transcript files / how many of each file's leading lines are read
/// when asking a transcript dir which cwd it belongs to. Bounded because a
/// single transcript line can carry a large tool result.
const TRANSCRIPT_PROBE_FILES: usize = 3;
const TRANSCRIPT_PROBE_LINES: usize = 32;

/// Whether the transcript dir `dir` (named `name`) belongs to one of `roots`:
/// by the cwd its sessions record, else by the name. What
/// `agent_home::seed_claude_transcripts` copies into a new scope home.
pub(crate) fn transcript_dir_belongs_to(dir: &Path, name: &str, roots: &[String]) -> bool {
    match transcript_cwd(dir) {
        Some(cwd) => roots.iter().any(|root| cwd_is_within(&cwd, root)),
        None => roots.iter().any(|root| transcript_name_matches(name, root)),
    }
}

/// The absolute cwd a transcript dir's sessions were recorded in, read out of a
/// transcript rather than decoded from the directory name.
///
/// The name is Claude's own encoding of the cwd and it is **lossy** — both `/`
/// and `.` become `-`, so `…-KeyboardLayouts-modular-panel` is either a
/// subdirectory `panel/` of the `modular` project or the *sibling* project
/// `modular-panel`, and nothing in the name says which. The transcript itself
/// carries the real `cwd`, so that is what decides.
fn transcript_cwd(dir: &Path) -> Option<String> {
    use std::io::BufRead as _;
    let entries = std::fs::read_dir(dir).ok()?;
    let mut logs: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "jsonl"))
        .collect();
    logs.sort();
    for log in logs.iter().take(TRANSCRIPT_PROBE_FILES) {
        let Ok(file) = std::fs::File::open(log) else {
            continue;
        };
        for line in std::io::BufReader::new(file)
            .lines()
            .take(TRANSCRIPT_PROBE_LINES)
            .map_while(Result::ok)
        {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            if let Some(cwd) = v.get("cwd").and_then(serde_json::Value::as_str) {
                return Some(cwd.to_string());
            }
        }
    }
    None
}

/// Whether a recorded cwd is the project dir or something inside it. Compared
/// **component-wise** (`Path::starts_with`), so a sibling `…/proj2` is not read
/// as being inside `…/proj`.
fn cwd_is_within(cwd: &str, project_dir: &str) -> bool {
    Path::new(cwd).starts_with(Path::new(project_dir))
}

/// Name-only fallback for a transcript dir with no readable `cwd` (empty, or
/// a truncated log): Claude's encoding applied to the project dir, matched at a
/// `-` boundary. Lossy by construction (see [`transcript_cwd`]) — used only when
/// there is no transcript to ask, where the stake is a dir holding nothing.
fn transcript_name_matches(name: &str, project_dir: &str) -> bool {
    let encoded: String = project_dir
        .chars()
        .map(|c| {
            if c == '/' || c == '\\' || c == '.' {
                '-'
            } else {
                c
            }
        })
        .collect();
    name == encoded
        || name
            .strip_prefix(&encoded)
            .is_some_and(|rest| rest.starts_with('-'))
}

/// Read-only identical-path mounts: just the hook *script* dir, which is shared
/// with host-run agents and so must be immutable from inside the container (see
/// the module doc). Mounted only when it exists on the host.
pub(crate) fn ro_mounts_for_hooks(hooks_dir: &Path) -> Vec<String> {
    let mut m = Vec::new();
    if hooks_dir.is_dir() {
        let h = hooks_dir.to_string_lossy();
        m.push(format!("{h}:{h}"));
    }
    m
}

/// Per-project staging dir for the writable hook-config copies:
/// `<state_dir>/sandbox-stage/<sanitized project id>`. One dir per project
/// (mounts are fixed at create), refreshed at each `up` — no per-tab leak.
#[cfg(target_os = "macos")]
pub(crate) fn stage_dir(project_id: &str) -> PathBuf {
    storage::state_dir()
        .join("sandbox-stage")
        .join(sanitize_key(project_id))
}

/// Whether Claude will skip its trust dialog in `cwd` for scope `scope_id`:
/// its answer is recorded in the scope home's `.claude.json`. A scope whose
/// home does not exist yet is seeded from the user's file, so that is read
/// then. Read-only. The caller is the frontend's auto-`/rename`, which must
/// not type a blind Enter into a launch that is about to ask a question — the
/// default answer is `No, exit`.
pub fn claude_folder_trusted(cwd: &str, scope_id: Option<&str>) -> bool {
    let home = crate::services::agent_home::scope_home(scope_id);
    let candidates = if home.join(".claude.json").exists() {
        vec![home.join(".claude.json")]
    } else {
        let user = paths::home_dir();
        vec![user.join(".claude.json"), user.join(".claude").join(".claude.json")]
    };
    candidates
        .iter()
        .filter_map(|candidate| std::fs::read(candidate).ok())
        .filter_map(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .any(|value| trust_accepted_for(&value, cwd))
}

/// Pure core of [`claude_folder_trusted`].
fn trust_accepted_for(value: &serde_json::Value, cwd: &str) -> bool {
    value
        .get("projects")
        .and_then(|projects| projects.get(cwd))
        .and_then(|entry| entry.get("hasTrustDialogAccepted"))
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
}

/// Build the runtime hardening flags from a project's spec, applying built-in
/// defaults (always-on `--pids-limit`; other caps opt-in).
fn harden_opts(spec: Option<&SandboxSpec>) -> HardenOpts {
    HardenOpts {
        pids_limit: spec
            .and_then(|s| s.pids_limit)
            .unwrap_or(DEFAULT_PIDS_LIMIT),
        memory: spec.and_then(|s| s.memory.clone()),
        cpus: spec.and_then(|s| s.cpus.clone()),
        // A rejected network falls back to docker's default bridge rather than
        // failing the spawn: dropping it is the fail-CLOSED direction (the value
        // being refused is one that would *remove* isolation), and the loud
        // rejection lives at the point the spec is written
        // (`commands::projects::set_project_sandbox_spec`).
        network: spec
            .and_then(|s| s.network.clone())
            .filter(|n| match validate_network(n) {
                Ok(()) => true,
                Err(e) => {
                    eprintln!("sandbox: ignoring spec network '{n}': {e}");
                    false
                }
            }),
        readonly_rootfs: spec.map(|s| s.readonly_rootfs).unwrap_or(false),
    }
}

/// Agent-auth env vars present on the host process, forwarded into the
/// container at exec time (which inherits none of the host env). Sorted for
/// determinism.
fn host_auth_env() -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for &k in crate::services::ssh_exec::AGENT_AUTH_ENV {
        if let Ok(v) = std::env::var(k) {
            if !v.is_empty() {
                out.insert(k.to_string(), v);
            }
        }
    }
    out
}

fn docker(args: &[&str]) -> Result<std::process::Output, String> {
    crate::paths::command_no_window("docker")
        .args(args)
        .output()
        .map_err(|e| format!("run docker: {e}"))
}

/// Last non-empty stderr line — docker's errors are one-liners at the tail.
fn stderr_tail(out: &std::process::Output) -> String {
    String::from_utf8_lossy(&out.stderr)
        .lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("(no error output)")
        .to_string()
}

#[cfg(unix)]
fn host_uid_gid() -> (u32, u32) {
    // Safe: geteuid/getegid have no preconditions and cannot fail.
    unsafe { (libc::geteuid(), libc::getegid()) }
}

#[cfg(not(unix))]
fn host_uid_gid() -> (u32, u32) {
    (0, 0)
}

#[cfg(test)]
mod tests {

    #[test]
    fn host_trust_is_read_per_exact_folder() {
        let value = serde_json::json!({"projects": {
            "/p/a": {"hasTrustDialogAccepted": true},
            "/p/b": {"hasTrustDialogAccepted": false},
            "/p/c": {}
        }});
        assert!(trust_accepted_for(&value, "/p/a"));
        assert!(!trust_accepted_for(&value, "/p/b"));
        assert!(!trust_accepted_for(&value, "/p/c"));
        assert!(!trust_accepted_for(&value, "/p/missing"));
        assert!(!trust_accepted_for(&serde_json::json!({}), "/p/a"));
    }
    use super::*;

    #[test]
    fn orphan_sweep_probes_only_when_docker_is_on_path() {
        assert!(sweep_should_probe(true));
        assert!(!sweep_should_probe(false));
    }

    #[test]
    fn install_shell_quote_posix_flavor() {
        assert_eq!(install_shell_quote("/home/a/x", false), "'/home/a/x'");
        assert_eq!(install_shell_quote("/home/a/my dir", false), "'/home/a/my dir'");
        assert_eq!(install_shell_quote("/home/o'brien/x", false), "'/home/o'\\''brien/x'");
    }

    #[test]
    fn install_shell_quote_powershell_flavor() {
        assert_eq!(
            install_shell_quote(concat!(r"C:\Users\a\AppData\Local\", crate::app_slug!(), r"\agent-sandbox"), true),
            concat!(r"'C:\Users\a\AppData\Local\", crate::app_slug!(), r"\agent-sandbox'")
        );
        assert_eq!(
            install_shell_quote(r"C:\Users\Jane Doe\p", true),
            r"'C:\Users\Jane Doe\p'"
        );
        assert_eq!(install_shell_quote(r"C:\Users\o'brien\p", true), r"'C:\Users\o''brien\p'");
    }

    fn env(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn args(strs: &[&str]) -> Vec<String> {
        strs.iter().map(|s| s.to_string()).collect()
    }

    /// Index of `needle` in `v`, or None.
    fn pos(v: &[String], needle: &str) -> Option<usize> {
        v.iter().position(|s| s == needle)
    }

    /// True if `v` contains the consecutive pair `flag value`.
    fn has_flag_value(v: &[String], flag: &str, value: &str) -> bool {
        v.windows(2).any(|w| w[0] == flag && w[1] == value)
    }

    /// Standard rw/ro mount sets used by the argv tests. `rw` includes a staged
    /// (writable copy) settings.json mount whose dst is the container path.
    fn rw(home: &str) -> Vec<String> {
        vec![
            format!("{home}/.claude:{home}/.claude"),
            format!("{home}/.codex:{home}/.codex"),
            "/state/live_sessions:/state/live_sessions".to_string(),
            format!("/state/sandbox-stage/p1/_home_alice_.claude_settings.json:{home}/.claude/settings.json"),
        ]
    }
    fn ro() -> Vec<String> {
        vec!["/state/hooks:/state/hooks".to_string()]
    }

    fn create(fingerprint: Option<&str>) -> Vec<String> {
        docker_create_args(
            concat!(crate::app_slug!(), "-p1"),
            "p1",
            "img:latest",
            "/home/alice",
            1000,
            1000,
            concat!("/home/alice/", crate::app_slug!(), "/projects/p1"),
            &rw("/home/alice"),
            &ro(),
            &HardenOpts::default(),
            fingerprint,
        )
    }

    // ── Host → container paths ────────────────────────────────────────────

    #[test]
    fn windows_host_paths_take_docker_desktops_spelling() {
        assert_eq!(container_path_for(r"C:\Users\a\p", true), "/c/Users/a/p");
        assert_eq!(container_path_for(r"D:\", true), "/d");
        assert_eq!(container_path_for("C:/Users/a", true), "/c/Users/a");
        assert_eq!(container_path_for(r"\\srv\share\x", true), "/srv/share/x");
        // Unix hosts are identical-path.
        assert_eq!(container_path_for("/home/a/p", false), "/home/a/p");
        assert_eq!(container_path_for(r"C:\odd", false), r"C:\odd");
    }

    #[test]
    fn mount_pairs_split_around_drive_colons() {
        assert_eq!(split_mount_pair("/a/b:/a/b"), ("/a/b", "/a/b"));
        assert_eq!(
            split_mount_pair(r"C:\Users\a\.claude:C:\Users\a\.claude"),
            (r"C:\Users\a\.claude", r"C:\Users\a\.claude")
        );
        // A staged copy under the state dir mounted over a home path.
        assert_eq!(
            split_mount_pair(r"C:\state\stage\x.json:C:\Users\a\.claude\settings.json"),
            (r"C:\state\stage\x.json", r"C:\Users\a\.claude\settings.json")
        );
        // Already-translated destination.
        assert_eq!(
            split_mount_pair(r"C:\Users\a\p:/c/Users/a/p"),
            (r"C:\Users\a\p", "/c/Users/a/p")
        );
    }

    #[test]
    fn create_argv_without_a_host_identity_omits_user() {
        let out = docker_create_args(
            concat!(crate::app_slug!(), "-p1"),
            "p1",
            "img:latest",
            "/home/alice",
            0,
            0,
            concat!("/home/alice/", crate::app_slug!(), "/projects/p1"),
            &rw("/home/alice"),
            &ro(),
            &HardenOpts::default(),
            None,
        );
        assert!(!out.contains(&"--user".to_string()));
        assert!(has_flag_value(&out, "--cap-drop", "ALL"), "hardening stays");
    }

    // ── Naming / fingerprint ──────────────────────────────────────────────

    #[test]
    fn container_name_is_sanitized_and_prefixed() {
        assert_eq!(container_name_for("p1"), concat!(crate::app_slug!(), "-p1"));
        assert_eq!(container_name_for("my proj/α"), concat!(crate::app_slug!(), "-my_proj__"));
        assert_eq!(container_name_for(""), concat!(crate::app_slug!(), "-x"));
    }

    #[test]
    fn fingerprint_is_stable_and_input_sensitive() {
        let a = spec_fingerprint(&create(None));
        let b = spec_fingerprint(&create(None));
        assert_eq!(a, b, "same argv must hash identically");
        assert_eq!(a.len(), 16);

        let mut other = create(None);
        let img = pos(&other, "img:latest").unwrap();
        other[img] = "img:v2".to_string();
        assert_ne!(
            a,
            spec_fingerprint(&other),
            "image change must change the hash"
        );

        // Boundary sensitivity: ["ab","c"] vs ["a","bc"].
        assert_ne!(
            spec_fingerprint(&args(&["ab", "c"])),
            spec_fingerprint(&args(&["a", "bc"]))
        );
    }

    // ── up decision table ─────────────────────────────────────────────────

    #[test]
    fn up_decision_table() {
        let fp = "abc123";
        let missing = ContainerProbe::default();
        assert_eq!(up_decision(&missing, fp), UpAction::Create);

        let running_match = ContainerProbe {
            exists: true,
            running: true,
            fingerprint: Some(fp.to_string()),
        };
        assert_eq!(up_decision(&running_match, fp), UpAction::UseExisting);

        let stopped = ContainerProbe {
            exists: true,
            running: false,
            fingerprint: Some(fp.to_string()),
        };
        assert_eq!(up_decision(&stopped, fp), UpAction::Recreate);

        let mismatch = ContainerProbe {
            exists: true,
            running: true,
            fingerprint: Some("other".to_string()),
        };
        assert_eq!(up_decision(&mismatch, fp), UpAction::Recreate);

        let unlabeled = ContainerProbe {
            exists: true,
            running: true,
            fingerprint: None,
        };
        assert_eq!(up_decision(&unlabeled, fp), UpAction::Recreate);
    }

    // ── create argv ───────────────────────────────────────────────────────

    #[test]
    fn create_argv_has_mounts_identity_hardening_labels_and_sleeps() {
        let out = create(Some("deadbeef00000000"));

        assert_eq!(out[0], "run");
        assert!(out.contains(&"-d".to_string()));
        assert!(out.contains(&"--init".to_string()));
        assert!(has_flag_value(&out, "--name", concat!(crate::app_slug!(), "-p1")));
        assert!(has_flag_value(&out, "--label", OWNER_LABEL));
        assert!(has_flag_value(&out, "--label", concat!(crate::app_slug!(), ".project=p1")));
        assert!(has_flag_value(
            &out,
            "--label",
            concat!(crate::app_slug!(), ".spec=deadbeef00000000")
        ));
        assert!(has_flag_value(&out, "--user", "1000:1000"));
        assert!(has_flag_value(&out, "-e", "HOME=/home/alice"));
        assert!(has_flag_value(&out, "-w", concat!("/home/alice/", crate::app_slug!(), "/projects/p1")));
        // Hardening always on.
        assert!(has_flag_value(&out, "--security-opt", "no-new-privileges"));
        assert!(has_flag_value(&out, "--cap-drop", "ALL"));
        assert!(has_flag_value(
            &out,
            "--pids-limit",
            &DEFAULT_PIDS_LIMIT.to_string()
        ));
        // Project dir always mounted rw at its identical path.
        assert!(has_flag_value(
            &out,
            "-v",
            concat!("/home/alice/", crate::app_slug!(), "/projects/p1:/home/alice/", crate::app_slug!(), "/projects/p1")
        ));
        // rw auth mounts.
        assert!(has_flag_value(
            &out,
            "-v",
            "/home/alice/.claude:/home/alice/.claude"
        ));
        assert!(has_flag_value(
            &out,
            "-v",
            "/state/live_sessions:/state/live_sessions"
        ));
        // The hook script dir is read-only (:ro suffix)...
        assert!(has_flag_value(&out, "-v", "/state/hooks:/state/hooks:ro"));
        // ...but settings.json is a writable per-PROJECT copy shadowing the
        // host path: mounted rw (no :ro), source is the staged copy.
        assert!(has_flag_value(
            &out,
            "-v",
            "/state/sandbox-stage/p1/_home_alice_.claude_settings.json:/home/alice/.claude/settings.json"
        ));
        assert!(
            !out.iter().any(|s| s.ends_with(
                "/home/alice/.claude/settings.json:/home/alice/.claude/settings.json:ro"
            )),
            "host settings.json must not be mounted read-only in place"
        );
        // The container's sole job is to exist: image, then `sleep infinity`.
        let img = pos(&out, "img:latest").expect("image present");
        assert_eq!(&out[img + 1..], &["sleep", "infinity"]);
        // No `--rm`: lifetime is owned by up/down, not by process exit.
        assert!(pos(&out, "--rm").is_none());
    }

    #[test]
    fn create_argv_without_fingerprint_omits_spec_label_only() {
        let bare = create(None);
        let labeled = create(Some("feedface00000000"));
        assert!(!bare.iter().any(|s| s.starts_with(concat!(crate::app_slug!(), ".spec="))));
        assert_eq!(
            labeled.len(),
            bare.len() + 2,
            "fingerprint adds exactly --label + value"
        );
        assert!(has_flag_value(
            &labeled,
            "--label",
            concat!(crate::app_slug!(), ".spec=feedface00000000")
        ));
    }

    #[test]
    fn optional_resource_and_network_caps_appear_only_when_set() {
        let none = create(None);
        assert!(pos(&none, "--memory").is_none());
        assert!(pos(&none, "--cpus").is_none());
        assert!(pos(&none, "--network").is_none());
        assert!(pos(&none, "--read-only").is_none());

        let harden = HardenOpts {
            pids_limit: 256,
            memory: Some("4g".to_string()),
            cpus: Some("2".to_string()),
            network: Some("none".to_string()),
            readonly_rootfs: true,
        };
        let out = docker_create_args(
            concat!(crate::app_slug!(), "-p1"),
            "p1",
            "img",
            "/h",
            1,
            1,
            "/p",
            &[],
            &[],
            &harden,
            None,
        );
        assert!(has_flag_value(&out, "--pids-limit", "256"));
        assert!(has_flag_value(&out, "--memory", "4g"));
        assert!(has_flag_value(&out, "--cpus", "2"));
        assert!(has_flag_value(&out, "--network", "none"));
        assert!(has_flag_value(&out, "--tmpfs", "/tmp"));
        assert!(out.contains(&"--read-only".to_string()));
    }

    // ── exec argv ─────────────────────────────────────────────────────────

    #[test]
    fn exec_argv_has_cwd_env_killwrapper_and_preserves_resume_args() {
        let envs = env(&[(crate::app_env!("TAB_UID"), "tab-1")]);
        let auth = env(&[("ANTHROPIC_API_KEY", "sk-test")]);
        let out = docker_exec_args(
            concat!(crate::app_slug!(), "-p1"),
            concat!("/home/alice/", crate::app_slug!(), "/projects/p1/sub"),
            &envs,
            &auth,
            concat!("/tmp/", crate::app_slug!(), "-tab-t1-0.pid"),
            "claude",
            &args(&["--resume", "uuid-1"]),
        );

        assert_eq!(out[0], "exec");
        assert!(out.contains(&"-i".to_string()));
        assert!(out.contains(&"-t".to_string()));
        // Per-tab cwd (subdir tabs stay correct under identical-path mounting).
        assert!(has_flag_value(
            &out,
            "-w",
            concat!("/home/alice/", crate::app_slug!(), "/projects/p1/sub")
        ));
        assert!(has_flag_value(&out, "-e", "TERM=xterm-256color"));
        assert!(has_flag_value(&out, "-e", concat!(crate::app_upper!(), "_TAB_UID=tab-1")));
        // Auth env rides at exec (rotated tokens per spawn), before the name —
        // by NAME only; the value is in the docker client's env (#864).
        assert!(has_flag_value(&out, "-e", "ANTHROPIC_API_KEY"));
        let key = out
            .iter()
            .position(|s| s == "ANTHROPIC_API_KEY")
            .unwrap();
        let name = pos(&out, concat!(crate::app_slug!(), "-p1")).unwrap();
        assert!(key < name, "env must precede the container name");
        // Kill-wrapper shape: name, sh -c '<pidfile script>' sh <cmd> <args…>.
        assert_eq!(out[name + 1], "sh");
        assert_eq!(out[name + 2], "-c");
        assert!(out[name + 3].starts_with("export PATH='"));
        assert!(out[name + 3].contains("/bin"));
        assert!(out[name + 3].ends_with(concat!("echo $$ > /tmp/", crate::app_slug!(), "-tab-t1-0.pid; exec \"$@\"")));
        assert_eq!(out[name + 4], "sh");
        // Original command + resume args preserved in order after the wrapper.
        assert_eq!(&out[name + 5..], &["claude", "--resume", "uuid-1"]);
    }

    #[test]
    fn exec_argv_carries_no_secret_value() {
        // #864: `/proc/<pid>/cmdline` is world-readable and the docker client
        // lives as long as the tab — a key or token VALUE must be on no argv item.
        let envs = env(&[
            (crate::app_env!("TAB_UID"), "tab-1"),
            (crate::services::root_mcp::TOKEN_ENV, "root-s3cret"),
            ("OPENAI_API_KEY", "tab-s3cret"),
        ]);
        let auth = env(&[("ANTHROPIC_API_KEY", "auth-s3cret"), ("OPENAI_API_KEY", "auth-wins-s3cret")]);
        let out = docker_exec_args(concat!(crate::app_slug!(), "-p1"), "/p", &envs, &auth, "/tmp/x.pid", "claude", &[]);
        assert!(!out.iter().any(|a| a.contains("s3cret")), "{out:?}");
        for name in [crate::services::root_mcp::TOKEN_ENV, "ANTHROPIC_API_KEY", "OPENAI_API_KEY"] {
            assert_eq!(out.iter().filter(|a| *a == name).count(), 1, "{name} named once: {out:?}");
            assert!(has_flag_value(&out, "-e", name));
        }
        assert!(has_flag_value(&out, "-e", concat!(crate::app_upper!(), "_TAB_UID=tab-1")));
        // …and the values reach the docker client's own environment instead.
        let client = docker_exec_client_env(&envs, &auth);
        assert_eq!(client.get(crate::services::root_mcp::TOKEN_ENV).map(String::as_str), Some("root-s3cret"));
        assert_eq!(client.get("ANTHROPIC_API_KEY").map(String::as_str), Some("auth-s3cret"));
        assert_eq!(client.get("OPENAI_API_KEY").map(String::as_str), Some("auth-wins-s3cret"));
        assert!(!client.contains_key(crate::app_env!("TAB_UID")));
    }

    #[test]
    fn exec_argv_codex_resume_order_preserved() {
        let out = docker_exec_args(
            concat!(crate::app_slug!(), "-p1"),
            "/p",
            &BTreeMap::new(),
            &BTreeMap::new(),
            concat!("/tmp/", crate::app_slug!(), "-tab-t2-1.pid"),
            "codex",
            &args(&["resume", "live-id"]),
        );
        // `-c <script> sh` precede the real command ($0 is the literal "sh").
        let sh = pos(&out, "-c").unwrap();
        assert_eq!(out[sh + 2], "sh");
        assert_eq!(&out[sh + 3..], &["codex", "resume", "live-id"]);
    }

    // ── stage dir ─────────────────────────────────────────────────────────

    // ── spec sources ──────────────────────────────────────────────────────

    #[test]
    fn detect_spec_sources_prefers_dockerfile_then_devcontainer_image() {
        let base = std::env::temp_dir().join(format!(concat!(crate::app_slug!(), "-det-{}"), std::process::id()));
        std::fs::create_dir_all(&base).unwrap();

        // Nothing present → spec untouched.
        let mut spec = SandboxSpec::default();
        detect_spec_sources(&base, &mut spec);
        assert_eq!(spec.dockerfile, None);
        assert_eq!(spec.image, None);

        // devcontainer image (JSONC comments tolerated).
        let dc = base.join(".devcontainer");
        std::fs::create_dir_all(&dc).unwrap();
        std::fs::write(
            dc.join("devcontainer.json"),
            b"{\n  // dev image\n  \"image\": \"mcr.example/devbox:1\"\n}",
        )
        .unwrap();
        let mut spec = SandboxSpec::default();
        detect_spec_sources(&base, &mut spec);
        assert_eq!(spec.image.as_deref(), Some("mcr.example/devbox:1"));
        assert_eq!(spec.dockerfile, None);

        // A root Dockerfile wins over the devcontainer.
        std::fs::write(base.join("Dockerfile"), b"FROM debian:stable").unwrap();
        let mut spec = SandboxSpec::default();
        detect_spec_sources(&base, &mut spec);
        assert_eq!(spec.dockerfile.as_deref(), Some("Dockerfile"));
        assert_eq!(spec.image, None);

        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn image_for_prefers_dockerfile_tag_then_override_then_default() {
        assert_eq!(image_for("p1", None), DEFAULT_IMAGE);
        let with_image = SandboxSpec {
            image: Some("python:3.12".to_string()),
            ..Default::default()
        };
        assert_eq!(image_for("p1", Some(&with_image)), "python:3.12");
        let with_df = SandboxSpec {
            image: Some("python:3.12".to_string()),
            dockerfile: Some("Dockerfile".to_string()),
            ..Default::default()
        };
        assert_eq!(image_for("p1", Some(&with_df)), concat!(crate::app_slug!(), "-p1:latest"));
    }

    // ── wrap ──────────────────────────────────────────────────────────────

    #[test]
    fn wrap_is_noop_when_sandbox_disabled() {
        let mut opts = PtyOptions {
            id: "t".to_string(),
            cmd: "claude".to_string(),
            args: args(&["--session-id", "x"]),
            env: Default::default(),
            cwd: "/proj".to_string(),
            cols: 80,
            rows: 24,
            local_only: false,
            sandbox: false,
            agent: true,
            project_id: None,
            remote_host_id: None,
            tmux_session: None,
            tmux_attach: None,
            host_bound_uid: None,
            schedule_target_id: None,
            host_session: false,
        };
        wrap_pty_options_docker(&mut opts).unwrap();
        assert_eq!(opts.cmd, "claude");
        assert_eq!(opts.args, args(&["--session-id", "x"]));
    }

    #[test]
    fn box_scope_never_resolves_sandboxed() {
        // A `box:<id>` tab is local + uncontained by design; the branch returns
        // before any state-dir read, so this is safe to exercise in a test.
        let mut opts = PtyOptions {
            id: "t".to_string(),
            cmd: "claude".to_string(),
            args: vec![],
            env: Default::default(),
            cwd: concat!("/home/u/", crate::app_slug!(), "/boxes/b").to_string(),
            cols: 80,
            rows: 24,
            local_only: false,
            sandbox: true,
            agent: true,
            project_id: Some("box:abc".to_string()),
            remote_host_id: None,
            tmux_session: None,
            tmux_attach: None,
            host_bound_uid: None,
            schedule_target_id: None,
            host_session: false,
        };
        enforce_spawn_authority(&mut opts);
        assert!(!opts.sandbox, "box tabs must never spawn containerized");
        assert!(!opts.local_only, "local_only is left as requested");
    }

    // ── Authority resolution (S-2 / S-6) ──────────────────────────────────

    fn want(sandbox: bool, local_only: bool) -> SpawnAuthority {
        SpawnAuthority {
            sandbox,
            local_only,
        }
    }

    /// `resolve_spawn_authority` under the default (contain everything) scope —
    /// the shape every pre-`scope` test was written against.
    fn resolve_all(
        has_project: bool,
        is_remote: bool,
        toggle_on: bool,
        requested: SpawnAuthority,
        cmd: &str,
        marker: bool,
    ) -> SpawnAuthority {
        resolve_spawn_authority(
            has_project,
            is_remote,
            toggle_on,
            SandboxScope::All,
            requested,
            cmd,
            marker,
        )
    }

    #[test]
    fn a_toggled_local_project_containerizes_regardless_of_the_renderers_flags() {
        // The S-2 escape: a persisted tab declaring itself local (which makes
        // `pty_spawn` skip BOTH the docker and the ssh wrap) is overruled.
        let resolved = resolve_all(true, false, true, want(false, true), "bash", false);
        assert_eq!(resolved, want(true, false));

        // …including when it also claims to be a `local_agent` kind by naming an
        // agent CLI, but holds no registered host-bound marker.
        let resolved = resolve_all(true, false, true, want(false, true), "claude", false);
        assert_eq!(resolved, want(true, false));
    }

    #[test]
    fn host_bound_local_model_tabs_still_run_on_the_host() {
        for cmd in HOST_BOUND_LOCAL_AGENT_CMDS {
            let resolved = resolve_all(true, false, true, want(false, true), cmd, true);
            assert_eq!(resolved, want(false, true), "{cmd} must stay on the host");
        }
        // The marker alone is not enough — the command must be a known driver.
        let resolved = resolve_all(true, false, true, want(false, true), "/tmp/pwn.sh", true);
        assert_eq!(resolved, want(true, false));
        // …and a known driver alone is not enough either. This is #150: the grant
        // used to be the tab's `TABTIVITY_LOCAL_MODEL` env var, which is a label the
        // usage recap sets, so anything that set it for a display reason handed
        // out a container escape. It is now a file in the state dir.
        assert!(!is_host_bound_local_agent("vibe", false));
        assert!(is_host_bound_local_agent("vibe", true));
    }

    #[test]
    fn a_host_bound_marker_is_a_single_path_component() {
        // The uid names a file, and it arrives from the renderer.
        for bad in ["", "../../etc/passwd", "a/b", "a\\b", "..", "x y", "é"] {
            assert!(
                !host_bound_marker_exists("p1", bad),
                "{bad:?} must not resolve"
            );
            assert!(
                register_host_bound_tab("p1", bad).is_err(),
                "{bad:?} must be refused"
            );
        }
        assert!(register_host_bound_tab("p1", &"x".repeat(65)).is_err());
    }

    #[test]
    fn toggle_off_and_remote_projects_can_never_be_told_they_are_sandboxed() {
        // Toggle off: the renderer cannot invent a container.
        assert_eq!(
            resolve_all(true, false, false, want(true, false), "bash", false),
            want(false, false)
        );
        // Remote project: containers are local-only, but `local_only` is a real
        // per-tab choice there (mirror vs. host) and is left alone.
        assert_eq!(
            resolve_all(true, true, true, want(true, true), "claude", false),
            want(false, true)
        );
        assert_eq!(
            resolve_all(true, true, true, want(true, false), "claude", false),
            want(false, false)
        );
    }

    #[test]
    fn a_projectless_spawn_passes_through_untouched() {
        // Root scope / connection terminals: no project record to consult.
        let requested = want(false, true);
        assert_eq!(
            resolve_all(false, false, false, requested, "", false),
            requested
        );
    }

    // ── Agents-only scope ─────────────────────────────────────────────────

    fn resolve_agents_only(cmd: &str) -> SpawnAuthority {
        resolve_spawn_authority(
            true,
            false,
            true,
            SandboxScope::Agents,
            want(false, false),
            cmd,
            false,
        )
    }

    #[test]
    fn agents_only_contains_the_agent_and_leaves_the_shell_alone() {
        // The whole point of the scope: the model's tab is boxed, the user's is not.
        for agent in ["claude", "codex", "gemini", "aider"] {
            assert_eq!(resolve_agents_only(agent), want(true, false), "{agent}");
        }
        // A shell tab spawns with an EMPTY cmd (the host default shell) — the case
        // that has to work, since it is what every `+ Shell` and every viewer
        // Run/Debug tab is.
        for host_side in ["", "bash", "sh", "python3", "/usr/bin/make", "npm"] {
            assert_eq!(
                resolve_agents_only(host_side),
                want(false, false),
                "{host_side:?} must run on the host"
            );
        }
    }

    #[test]
    fn agents_only_matches_an_agent_by_basename_not_by_the_bare_word() {
        // A pinned absolute path is still that agent; PATH layout is not a
        // containment decision.
        assert!(is_agent_cmd("/home/u/.local/bin/claude"));
        assert!(is_agent_cmd("claude.exe"));
        assert!(is_agent_cmd(r"C:\tools\codex.exe"));
        // …and a lookalike is not.
        assert!(!is_agent_cmd("claude-wrapper"));
        assert!(!is_agent_cmd("myclaude"));
        assert!(!is_agent_cmd(""));
    }

    #[test]
    fn the_scope_can_only_narrow_never_grant() {
        // Toggle off + agents-only must not containerize an agent: `scope` is read
        // only after the toggle already said yes.
        assert_eq!(
            resolve_spawn_authority(
                true,
                false,
                false,
                SandboxScope::Agents,
                want(true, false),
                "claude",
                false
            ),
            want(false, false)
        );
        // A remote project is still never docker-wrapped, whatever the scope says.
        assert_eq!(
            resolve_spawn_authority(
                true,
                true,
                true,
                SandboxScope::Agents,
                want(true, false),
                "claude",
                false
            ),
            want(false, false)
        );
    }

    #[test]
    fn a_host_bound_local_model_tab_outranks_the_scope() {
        // Both exemptions point the same way; check they compose rather than one
        // shadowing the other into a container.
        assert_eq!(
            resolve_spawn_authority(
                true,
                false,
                true,
                SandboxScope::Agents,
                want(false, true),
                "vibe",
                true
            ),
            want(false, true)
        );
    }

    #[test]
    fn an_older_spec_with_no_scope_key_still_contains_everything() {
        // The migration-free promise: a `sandbox` object written before `scope`
        // existed must not silently drop to agents-only on upgrade.
        let spec: SandboxSpec =
            serde_json::from_str(r#"{"enabled":true,"network":"none"}"#).unwrap();
        assert_eq!(spec.scope, SandboxScope::All);
        assert_eq!(
            resolve_spawn_authority(
                true,
                false,
                spec.enabled,
                spec.scope,
                want(false, true),
                "bash",
                false
            ),
            want(true, false)
        );
    }

    #[test]
    fn agent_registry_matches_classifier() {
        // `is_agent_cmd` reads `commands::agents::AGENTS`; this is the tripwire for
        // the frontend's `AGENT_CMDS`, which is a hand-kept copy of the same set.
        // An agent missing from the classifier runs OUTSIDE the container under
        // agents-only scope, which is exactly the silent failure worth a test.
        for bin in crate::commands::agents::agent_bins() {
            assert!(
                is_agent_cmd(bin),
                "{bin} is in the registry but not classified"
            );
        }
        // The registry is non-empty (a `Vec::new()` refactor would make every
        // assertion above vacuous and every agent escape the container).
        assert!(crate::commands::agents::agent_bins().len() >= 10);
    }

    // ── Mount narrowing (S-3) ─────────────────────────────────────────────

    // ── Claude transcripts: read all, write ours ──────────────────────────

    /// A transcript dir holding one log whose first line records `cwd`.
    fn transcript_dir(root: &Path, name: &str, cwd: Option<&str>) {
        let dir = root.join(name);
        std::fs::create_dir_all(&dir).unwrap();
        if let Some(cwd) = cwd {
            // First line without a `cwd` on purpose: real logs open with a
            // summary/title record, so the probe has to read past it.
            let log = format!(
                "{{\"type\":\"summary\",\"sessionId\":\"s\"}}\n{{\"type\":\"user\",\"cwd\":{}}}\n",
                serde_json::to_string(cwd).unwrap()
            );
            std::fs::write(dir.join("11111111-2222-3333-4444-555555555555.jsonl"), log).unwrap();
        }
    }

    #[test]
    fn a_transcript_dir_belongs_to_a_scope_by_its_recorded_cwd_then_by_name() {
        let tmp = tempfile::tempdir().unwrap();
        let projects = tmp.path().join("projects");
        let project = "/work/proj".to_string();
        transcript_dir(&projects, "ours", Some(&project));
        transcript_dir(&projects, "-work-proj-sub", Some("/work/proj/sub"));
        transcript_dir(&projects, "elsewhere", Some("/somewhere/else"));
        transcript_dir(&projects, "-work-proj", None);
        transcript_dir(&projects, "-work-proj2", None);
        let roots = vec![project];
        let belongs = |name: &str| transcript_dir_belongs_to(&projects.join(name), name, &roots);
        assert!(belongs("ours"));
        assert!(belongs("-work-proj-sub"));
        assert!(!belongs("elsewhere"));
        // No transcript to ask: the name decides, at a `-` boundary.
        assert!(belongs("-work-proj"));
        assert!(!belongs("-work-proj2"));
    }

    #[test]
    fn the_name_fallback_matches_at_a_separator_boundary_only() {
        // Claude's encoding of `/home/u/proj`.
        assert!(transcript_name_matches("-home-u-proj", "/home/u/proj"));
        // A subdirectory of it.
        assert!(transcript_name_matches("-home-u-proj-src", "/home/u/proj"));
        // A sibling whose name merely *starts* with ours — the `GNNGED` vs
        // `GNNGEDAnalysis` case.
        assert!(!transcript_name_matches(
            "-home-u-projAnalysis",
            "/home/u/proj"
        ));
        assert!(!transcript_name_matches("-home-u-other", "/home/u/proj"));
        // A dotted segment encodes like a separator does.
        assert!(transcript_name_matches(
            "-home-u-proj--hidden",
            "/home/u/proj"
        ));
    }

    #[test]
    fn cwd_containment_is_component_wise() {
        assert!(cwd_is_within("/home/u/proj", "/home/u/proj"));
        assert!(cwd_is_within("/home/u/proj/sub", "/home/u/proj"));
        // Not a string prefix match — this is the sibling that used to slip in.
        assert!(!cwd_is_within("/home/u/proj2", "/home/u/proj"));
    }

    // ── Dockerfile confinement + network allowlist (S-8) ──────────────────

    #[test]
    fn spec_dockerfile_must_stay_inside_the_project() {
        let base = std::env::temp_dir().join(format!(concat!(crate::app_slug!(), "-df-{}"), std::process::id()));
        let proj = base.join("proj");
        std::fs::create_dir_all(proj.join("docker")).unwrap();
        std::fs::write(proj.join("Dockerfile"), b"FROM debian:stable").unwrap();
        std::fs::write(
            proj.join("docker").join("Dockerfile"),
            b"FROM debian:stable",
        )
        .unwrap();
        std::fs::write(base.join("evil.Dockerfile"), b"FROM debian\nRUN pwn").unwrap();

        assert!(resolve_spec_dockerfile(&proj, "Dockerfile").is_ok());
        assert!(resolve_spec_dockerfile(&proj, "docker/Dockerfile").is_ok());
        // Traversal out of the project — the build runs as root, so this mattered.
        assert!(resolve_spec_dockerfile(&proj, "../evil.Dockerfile").is_err());
        assert!(resolve_spec_dockerfile(&proj, "docker/../../evil.Dockerfile").is_err());
        // Absolute paths are refused outright.
        assert!(resolve_spec_dockerfile(&proj, "/etc/passwd").is_err());
        // A path that doesn't exist can't be built either.
        assert!(resolve_spec_dockerfile(&proj, "missing.Dockerfile").is_err());

        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn network_allowlist_refuses_host_and_accepts_real_network_names() {
        assert!(validate_network("none").is_ok());
        assert!(validate_network("bridge").is_ok());
        assert!(validate_network("my-allowlist_net.1").is_ok());
        // The one value that removes the container's network isolation.
        assert!(validate_network("host").is_err());
        assert!(validate_network("HOST").is_err());
        // Docker's other isolation-sharing forms carry characters we reject.
        assert!(validate_network("container:deadbeef").is_err());
        assert!(validate_network("ns:/proc/1/ns/net").is_err());
        assert!(validate_network("").is_err());
        // And a rejected spec value falls back to docker's default bridge.
        let spec = SandboxSpec {
            network: Some("host".to_string()),
            ..Default::default()
        };
        assert_eq!(harden_opts(Some(&spec)).network, None);
        let spec = SandboxSpec {
            network: Some("none".to_string()),
            ..Default::default()
        };
        assert_eq!(harden_opts(Some(&spec)).network.as_deref(), Some("none"));
    }

    #[test]
    fn register_exec_tab_mints_unique_pidfiles_per_respawn() {
        let a = register_exec_tab("tab/α:1", concat!(crate::app_slug!(), "-p1"));
        let b = register_exec_tab("tab/α:1", concat!(crate::app_slug!(), "-p1"));
        assert_ne!(a, b, "a respawn must never reuse its predecessor's pidfile");
        assert!(a.starts_with(concat!("/tmp/", crate::app_slug!(), "-tab-tab___1-")));
        assert!(a.ends_with(".pid"));
        // Cleanup so other tests never see this entry.
        exec_tabs().lock().unwrap().remove("tab/α:1");
    }
}
