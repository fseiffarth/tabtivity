//! The launch assembly every local spawn shares (headless owner plan, H1b):
//! what `commands::terminal::pty_spawn` did between receiving a tab's
//! `PtyOptions` and handing them to the PTY — cwd resolution, the
//! backend-authority re-derivation, the O#149 cwd gate, agent-session
//! resume, the fence roots and the fence itself, the root/schedule/help MCP
//! grants, Codex binding, Claude's remote-control and `--name` flags, the
//! docker/ssh wrap and the local tmux wrap — lives here so the Mobile
//! sidecar's headless spawn (`mobile_control::headless::create_tab`, a
//! detached `tmux new-session` through `tmux_local::spawn_detached_with`)
//! and the window's `pty_spawn` run the very same code. [`prepare`] is
//! `AppHandle`-free; everything it calls already was. The fence stays
//! fail-closed by construction: the same `agent_fence::decide`.
//!
//! [`PreparedLaunch::commit`] is the bookkeeping `pty_spawn` did after a
//! successful spawn; a `PreparedLaunch` dropped without it releases the MCP
//! token and the Codex resume claim, as a failed spawn always did.

use crate::brand::UPPER;
use crate::storage;
use crate::terminal::PtyOptions;

/// Read the global `agent_remote_control` setting, defaulting ON when the
/// settings file or key is absent. A cheap per-spawn JSON read (spawns are
/// infrequent), kept here so the spawn path has no `AppHandle` dependency.
fn settings_agent_remote_control() -> bool {
    let path = storage::state_dir().join("settings.json");
    if !path.exists() {
        return crate::schema::Settings::default().agent_remote_control();
    }
    storage::read_json::<crate::schema::Settings>(&path)
        .map(|s| s.agent_remote_control())
        .unwrap_or(true)
}

/// Whether Claude agent tabs of `project_id` should spawn with
/// `--remote-control` (O#59): a project's own override, from the
/// `projects.json` entry's flattened `extra["remote_control"]` — like
/// `services::sandbox`'s spec reads, the state-dir mirror is the ONLY trusted
/// copy, never `project.json` (inside the project tree, and a container's own
/// rw mount). Absent project id, missing entry, or an absent/unparseable
/// override falls back to the global setting.
fn resolve_agent_remote_control(project_id: Option<&str>) -> bool {
    let list_path = storage::state_dir().join("projects.json");
    let list =
        storage::read_json::<crate::schema::projects::ProjectsList>(&list_path).unwrap_or_default();
    agent_remote_control_effective(&list, project_id, settings_agent_remote_control())
}

/// The pure O#59 decision, split out of [`resolve_agent_remote_control`] so it
/// is testable with an in-memory `ProjectsList` — no `state_dir()`/env
/// isolation needed. A project's own `remote_control` override wins; absent
/// project id, missing entry, or a non-bool/absent value falls back to
/// `global_default`.
fn agent_remote_control_effective(
    list: &[crate::schema::projects::ProjectEntry],
    project_id: Option<&str>,
    global_default: bool,
) -> bool {
    let Some(id) = project_id else {
        return global_default;
    };
    let Some(entry) = list.iter().find(|p| p.id == id) else {
        return global_default;
    };
    entry
        .extra
        .get("remote_control")
        .and_then(|v| v.as_bool())
        .unwrap_or(global_default)
}

/// Append Claude's `--name=<name>` to a launch argv, unless there is no name
/// or the argv already names the session. Returns whether the argv now does.
///
/// The `=` form, so a name that starts with `-` is still read as the value.
/// Argv, never a shell line: this is only applied to a spawn that runs the
/// host's own binary, after the ssh/docker wrap has had its turn.
fn append_claude_name(args: &mut Vec<String>, name: Option<&str>) -> bool {
    let named = |a: &String| a == "-n" || a == "--name" || a.starts_with("--name=");
    if args.iter().any(named) {
        return true;
    }
    let Some(name) = name.map(str::trim).filter(|n| !n.is_empty()) else {
        return false;
    };
    args.push(format!("--name={name}"));
    true
}

/// Whether `cwd` sits inside `allowed`, compared component-wise (`Path::starts_with`)
/// so a sibling directory sharing a prefix (`…/proj2` vs `…/proj`) is never
/// mistaken for nesting. O#149's hard gate: mirrors `services::sandbox::cwd_is_within`
/// in shape, kept as a separate function because that one only ever *classifies*
/// a docker mount as rw/ro, while this one refuses the spawn outright.
fn cwd_within(cwd: &str, allowed: &std::path::Path) -> bool {
    std::path::Path::new(cwd).starts_with(allowed)
}

/// Select the scope's root independently of a tab's working subdirectory.
fn scope_root_for<'a>(local: &'a str, remote: Option<&'a str>, mirror: &'a str, box_folder: Option<&'a str>, local_only: bool) -> &'a str {
    if let Some(folder) = box_folder { folder }
    else if let Some(remote) = remote { if local_only { mirror } else { remote } }
    else { local }
}

/// The VM tier's spawn-refusal decision (`docs/vm_projects_plan.md`), pure so
/// the no-local-fallback guard is testable: for a VM project a local spawn is
/// refused outright (the untrusted agent stepping outside the boundary, never
/// a downgrade), and a spawn while the VM is down refuses with the
/// `TABTIVITY_VM_DOWN` sentinel the frontend turns into a boot action. `None`
/// (spawn proceeds) for every non-VM project.
fn vm_spawn_refusal(
    is_vm: bool,
    vm_running: bool,
    local_only: bool,
    tab_id: &str,
) -> Option<String> {
    if !is_vm {
        return None;
    }
    if local_only {
        return Some(
            "This project lives inside its VM — tabs never run on the host. \
             Open the tab on the VM instead."
                .to_string(),
        );
    }
    if !vm_running {
        return Some(format!(
            "{UPPER}_VM_DOWN: the VM for this project is not running; tab '{tab_id}' was not spawned. Boot the VM (activate the project or click its lamp) and retry."
        ));
    }
    None
}

/// What [`prepare`] hands back: the rewritten options, ready for the PTY (or
/// a detached tmux client), and the bookkeeping to keep once the process
/// exists.
pub struct PreparedLaunch {
    pub opts: PtyOptions,
    /// The session name rode in on the launch argv (Claude's `--name`).
    pub named: bool,
    /// The tab's previous process died mid-turn (`agent_turn::bind_tab`).
    pub interrupted: bool,
    mcp_spawn_guard: Option<crate::services::root_mcp::SpawnTokenGuard>,
    resume_claim: Option<crate::services::codex_bind::ResumeClaim>,
    fenced_registration: Option<(String, String)>,
    host_agent_tab: Option<crate::services::agent_fence::HostAgentTab>,
    spawned_tab_id: String,
}

impl PreparedLaunch {
    /// Whether the spawn was handed a root/push MCP token (the sessions fold
    /// lists live tokens; the window emits its event on that).
    pub fn mcp_token_handed_out(&self) -> bool {
        self.mcp_spawn_guard.as_ref().is_some_and(|g| g.holds_token())
    }

    /// The process exists: keep the MCP token and the Codex resume claim,
    /// register a fenced tab, and track/untrack it as a host agent tab.
    pub fn commit(mut self) {
        if let Some(guard) = self.mcp_spawn_guard.as_mut() {
            guard.keep();
        }
        if let Some(claim) = self.resume_claim.take() {
            claim.keep();
        }
        if let Some((tab_id, scope_id)) = self.fenced_registration.take() {
            crate::services::agent_fence::register_tab(&tab_id, &scope_id);
        }
        match self.host_agent_tab.take() {
            Some(tab) => crate::services::agent_fence::track_host_agent_tab(&self.spawned_tab_id, tab),
            None => crate::services::agent_fence::untrack_host_agent_tab(&self.spawned_tab_id),
        }
    }
}

/// Assemble a tab's launch from its `PtyOptions`. `session_name` is Claude's
/// `--name` (the window's `TerminalView` supplies it; the sidecar has none).
/// `pool` is the window's remote pool, which a remote project's ssh wrap
/// dials through; `None` refuses such a spawn — the headless path only ever
/// starts local tabs. Async only for that dial.
pub async fn prepare(
    mut opts: PtyOptions,
    session_name: Option<String>,
    pool: Option<&crate::services::remote::RemotePoolState>,
) -> Result<PreparedLaunch, String> {
    // Resolve empty cwd to Tabtivity's root workspace directory.
    if opts.cwd.is_empty() {
        let root_dir = storage::root_work_dir();
        std::fs::create_dir_all(&root_dir).map_err(|e| {
            format!(
                "create root workspace '{}': {e}",
                root_dir.to_string_lossy()
            )
        })?;
        opts.cwd = root_dir.to_string_lossy().into_owned();
    }

    // A tab saved by an older build names the app's variables by the old
    // prefix; everything below reads the current names. Nothing to move while
    // the prefix is unchanged.
    crate::brand::PAIR.adopt_legacy_env(&mut opts.env);

    // The renderer's two authority flags (`sandbox`, `local_only`) are re-derived
    // here from `projects.json` in the state dir — the one project record a
    // containerized agent cannot write, unlike the persisted tab layout the
    // renderer rehydrates them from (which lives inside the project tree). Without
    // this a planted layout entry declaring `location: "local"` skipped both the
    // docker wrap and the ssh wrap and ran its argv on the host. Runs first, so
    // every step below sees the enforced values.
    crate::services::sandbox::enforce_spawn_authority(&mut opts);

    // VM-tier hard refusals (`docs/vm_projects_plan.md`): for a VM project the
    // remote→local fallback that exists elsewhere is not a perf surprise but
    // the untrusted agent stepping outside the boundary — so a local spawn is
    // refused outright, and a spawn while the VM is down refuses with a
    // sentinel (the frontend offers a boot action) rather than downgrading to
    // a host shell. Checked against the state-dir `projects.json` (the record
    // an in-VM agent cannot write), like the authority flags above.
    if let Some(pid) = opts.project_id.as_deref() {
        let is_vm = crate::services::remote::remote_target_for(pid)
            .is_some_and(|t| crate::services::vm::is_vm_spec(&t.spec));
        if let Some(refusal) = vm_spawn_refusal(
            is_vm,
            is_vm && crate::services::vm::is_running(pid),
            opts.local_only,
            &opts.id,
        ) {
            return Err(refusal);
        }
    }

    // SSH-sync Phase 1: a LOCAL-running tab on a REMOTE project runs in the
    // project's local mirror — it can't reach the remote tree. Resolve the cwd to
    // the mirror here (authoritative, OS-correct path) and ensure it exists, so a
    // local agent/shell tab spawns in the synced twin rather than a stale cwd.
    if opts.local_only {
        if let Some(pid) = opts.project_id.clone() {
            if crate::services::remote::remote_target_for(&pid).is_some() {
                let mirror = crate::services::remote_sync::mirror_dir(&pid);
                let _ = std::fs::create_dir_all(&mirror);
                opts.cwd = mirror.to_string_lossy().into_owned();
            }
        }
    }

    // O#149: `cwd` is caller-supplied and, unlike `sandbox`/`local_only` above,
    // was never checked against the project it claims to belong to — a tab could
    // carry a trusted `project_id` (which decides sandbox/local_only, and rides
    // into the resume/remote-control logic below) next to a `cwd` naming an
    // unrelated path, and nothing stopped it from spawning there with that
    // project's authority. Exempt only a truly-remote, non-`local_only` tab:
    // its `cwd` names a path on the far host, which this process has no way to
    // check (the ssh-wrapped command below does the `cd` on that side).
    if let Some(pid) = opts.project_id.clone() {
        // Box scope (`box:<id>`): the tab may live in the box folder, any member
        // project's root, or a remote member's local mirror — the co-accessible
        // set the box exists to create. An unknown box fails closed, same
        // posture as an unknown project below.
        if let Some(box_id) = crate::commands::boxes::box_id_of_scope(&pid) {
            let roots = crate::commands::boxes::box_allowed_roots(box_id)
                .ok_or_else(|| format!("terminal: unknown box scope '{pid}'"))?;
            if !roots.iter().any(|root| cwd_within(&opts.cwd, root)) {
                return Err(format!(
                    "terminal: refusing to spawn tab '{}' at '{}' — outside box scope '{pid}' (allowed: box folder + member roots)",
                    opts.id, opts.cwd
                ));
            }
        } else {
            let is_remote = crate::services::remote::remote_target_for(&pid).is_some();
            if !is_remote || opts.local_only {
                let allowed: std::path::PathBuf = if is_remote {
                    // local_only tab of a remote project: cwd was just resolved
                    // above to exactly this, so this only ever rejects a caller
                    // that skipped that resolution and supplied its own cwd.
                    crate::services::remote_sync::mirror_dir(&pid)
                } else {
                    crate::services::sandbox::project_dir_for(&pid)
                        .map(std::path::PathBuf::from)
                        .ok_or_else(|| {
                            format!("terminal: project '{pid}' has no known directory")
                        })?
                };
                if !cwd_within(&opts.cwd, &allowed) {
                    return Err(format!(
                        "terminal: refusing to spawn tab '{}' at '{}' — outside project '{pid}''s directory ({})",
                        opts.id,
                        opts.cwd,
                        allowed.display()
                    ));
                }
            }
        }
    }

    // The tab's scope, for the agent shims a shell tab may run
    // (`services::agent_shim`): its project or box, else the root console.
    opts.env
        .entry(crate::app_env!("SCOPE").into())
        .or_insert_with(|| crate::services::agent_home::scope_of(opts.project_id.as_deref()));
    if let Some(pid) = opts.project_id.as_deref() {
        let box_folder = crate::commands::boxes::box_id_of_scope(pid).and_then(|id|
            crate::commands::boxes::get_boxes().ok()?.into_iter().find(|b| b.id == id)?.folder);
        let remote = crate::services::remote::remote_target_for(pid);
        let local = crate::services::sandbox::project_dir_for(pid).unwrap_or_default();
        let mirror = crate::services::remote_sync::mirror_dir(pid).to_string_lossy().into_owned();
        let root = scope_root_for(&local, remote.as_ref().map(|r| r.spec.remote_path.as_str()), &mirror, box_folder.as_deref(), opts.local_only);
        if !root.is_empty() {
            opts.env.entry(crate::app_env!("PROJECT_DIR").into()).or_insert_with(|| root.into());
        }
    }

    // Resolve agent-session resume args (Claude `--resume`, Codex `resume …`)
    // BEFORE any ssh wrapping. `wrap_pty_options` rewrites `opts.cmd` to "ssh",
    // after which the resolver (which dispatches on `cmd == "claude"|"codex"`)
    // would no longer recognise the tab — so a remote agent tab would never get
    // its resume args. Resolving here keeps remote Claude/Codex tabs resumable;
    // the resolved `--resume`/`resume` args ride along into the remote command
    // string built by `wrap_pty_options`. (For local tabs this is the same
    // resolution `spawn_pty` used to do; it no longer does, to avoid resolving
    // twice.)
    opts = crate::services::agent_session::resolve_agent_session(opts);

    // Resolve the fourth authority axis while cmd/cwd still describe the agent
    // itself.  A local project member gets its own root plus the union of every
    // box it belongs to; a box-scoped tab gets that box's roots.  Remote agents
    // are reported as not applicable (local paths mean nothing on the far host).
    // Root resolution is backend-owned and unknown scopes fail closed.
    let remote_agent_run = !opts.local_only
        && opts
            .project_id
            .as_deref()
            .is_some_and(|id| crate::services::remote::remote_target_for(id).is_some());
    let resume_claim = if opts.cmd == "codex" && !remote_agent_run {
        crate::services::codex_bind::reserve_resume(&mut opts)
    } else {
        None
    };
    let agent_spawn = crate::services::agent_fence::is_agent(&opts);
    let fence_roots = if agent_spawn && !remote_agent_run {
        Some(
            crate::services::agent_fence::roots_for_scope(
                opts.project_id.as_deref(),
                opts.local_only,
            )
            .ok_or_else(|| {
                format!(
                    "Agent sandbox: unknown project or box scope '{}'; agent '{}' was not started.",
                    opts.project_id.as_deref().unwrap_or("root"),
                    opts.id
                )
            })?,
        )
    } else {
        None
    };

    // Agent-native working-root flags are portable metadata, not the OS
    // boundary: pass them on every platform for local multi-root runs.  Pick the
    // root containing cwd as "own" so box-scoped member tabs do not receive a
    // redundant flag for the directory they already started in.
    if let Some(roots) = fence_roots.as_deref() {
        let own = roots
            .iter()
            .filter(|root| std::path::Path::new(&opts.cwd).starts_with(root))
            .max_by_key(|root| root.components().count())
            .cloned()
            .unwrap_or_else(|| std::path::PathBuf::from(&opts.cwd));
        crate::services::agent_fence::add_box_root_args(&mut opts, roots, &own);
    }

    // The root console's extra rights (`services::root_mcp`): a LOCAL agent in
    // the ROOT scope — and no other spawn — is handed the MCP endpoint and its
    // per-run token. Decided here from the same `project_id` that picks the
    // fence roots above, while `cmd`/`args` still describe the agent itself, so
    // the config rides into the bubblewrap argv unchanged.
    //
    // The contained reader (`services::mail_reader`): an agent spawn into a VM
    // project whose TRUSTED record carries `mail_reader` gets a per-tab token of
    // class `Reader` and the guest-side URL, riding the remote command's
    // environment. Every other local project agent gets the schedule and push
    // lanes, every local agent the read-only help lane. All of it is decided
    // in `grant_lanes` against this process's listener (`runtime()`: the
    // window's, or the Mobile host's, which serves no root or reader lane).
    let root_agent = crate::services::root_mcp::grant_lanes(
        &mut opts,
        agent_spawn,
        crate::services::root_mcp::runtime(),
        crate::services::root_mcp::tokens(),
        &storage::state_dir(),
    );
    let mcp_spawn_guard = agent_spawn
        .then(|| crate::services::root_mcp::SpawnTokenGuard::new(&opts));

    // A local OpenCode is offered exactly the models Ollama has loaded (see
    // `commands::ollama::opencode_loaded_models_config`) — handed over as an
    // inline config, never written into OpenCode's own. A remote run's OpenCode
    // talks to the far host's Ollama, and an inline config the user set wins.
    const OPENCODE_INLINE: &str = "OPENCODE_CONFIG_CONTENT";
    if !remote_agent_run
        && !opts.env.contains_key(OPENCODE_INLINE)
        && std::env::var_os(OPENCODE_INLINE).is_none()
    {
        if let Some(requested) = crate::commands::ollama::opencode_spawn_model(&opts.cmd, &opts.args) {
            if let Some(cfg) =
                crate::commands::ollama::opencode_loaded_models_config(requested.as_deref())
            {
                opts.env.insert(OPENCODE_INLINE.into(), cfg);
            }
        }
    }

    // The agent's hooks report its turn state under its tab uid; bind that uid
    // to this PTY so the report reaches the tab's own marks, and drop any
    // record a previous run of the same tab left behind (see agent_turn).
    let interrupted = match opts.env.get(crate::app_env!("TAB_UID")).cloned() {
        Some(uid) => crate::services::agent_turn::bind_tab(&uid, &opts.id, opts.project_id.as_deref()),
        None => false,
    };

    // Codex resume, without the hook. Codex will not run Tabtivity's SessionStart
    // hook until the user trusts it (`/hooks`), and an untrusted hook fails
    // silently — so nothing recorded a tab's live session id and every restored
    // Codex tab came back blank. Follow Codex's own rollout logs instead and
    // record the id in the same place the hook would have; `resolve_codex_session`
    // above then picks it up on the next spawn, unchanged. Tracked here, while
    // `cmd`/`cwd`/`env` still describe the tab itself — after the wrapping below
    // they describe `docker`/`ssh`.
    if opts.cmd == "codex" && crate::services::agent_session::codex_binder_enabled(opts.project_id.as_deref()) {
        // A remote tab's Codex runs on the far host, so its rollouts (and its
        // cwd) are over there; the local sessions tree would only mis-attribute
        // someone else's. `local_only` tabs of a remote project are the exception
        // — they run here, in the local mirror cwd resolved above.
        let is_remote = !opts.local_only
            && opts
                .project_id
                .as_deref()
                .is_some_and(|id| crate::services::remote::remote_target_for(id).is_some());
        if let Some(uid) = opts
            .env
            .get(crate::app_env!("TAB_UID"))
            .filter(|_| !is_remote)
            .cloned()
        {
            // Args at this point are `["resume", <id>]` iff we just resumed a
            // recorded session — hand that id over so the binder claims it for
            // this tab rather than offering it to a sibling.
            let resumed = opts
                .args
                .iter()
                .position(|a| a == "resume")
                .and_then(|i| opts.args.get(i + 1))
                .cloned();
            crate::services::codex_bind::track(
                &opts.id,
                &uid,
                std::path::Path::new(&opts.cwd),
                opts.project_id.as_deref(),
                resumed,
            );
        }
    }

    // Claude remote control (global setting `agent_remote_control`, default ON,
    // overridable per project — O#59): spawn `claude` agent tabs with
    // `--remote-control` so the running session can be monitored/steered from
    // the Claude app/web. Only Claude has this flag. Applied here — after
    // session resolution but before ssh/docker wrapping — so it rides into the
    // wrapped command for remote/sandboxed tabs too. Guarded against
    // duplicates so a re-spawn never stacks the flag.
    // Never for the root console: `--remote-control` is what puts a session in
    // the Claude phone app, and the root scope's rights must not be reachable
    // from a phone by any route (it is absent from Tabtivity Mobile's catalog too).
    // Nor for a subcommand (`claude auth login`, a sign-in tab), which refuses
    // the session's flags.
    if opts.cmd == "claude"
        && !root_agent
        && !crate::services::agent_fence::runs_subcommand(&opts.args)
        && resolve_agent_remote_control(opts.project_id.as_deref())
        && !opts.args.iter().any(|a| a == "--remote-control")
    {
        opts.args.push("--remote-control".to_string());
    }

    // Container (Docker) and ssh-remote wrapping are mutually exclusive: the
    // project container is local-only. When `opts.sandbox` is set (frontend
    // marks shell+agent tabs of a container-toggled local project), rewrite the
    // resolved command into a `docker exec` into the project's session-lived
    // container (created on demand); otherwise fall back to ssh wrapping for
    // remote projects. Both run after agent-session resolution so resume
    // args/env ride into whichever wrapper applies. `local_only` tabs (e.g.
    // Ollama `local_agent`) must run on the host verbatim, so they take neither
    // path — the `local_only` guard on the container branch preserves that
    // invariant even if a tab were ever marked both `sandbox` and `local_only`.
    if !opts.sandbox {
        // A respawn of a tab that was containerized before the toggle flipped
        // off: its old in-container process outlives the docker-exec client the
        // respawn replaces — reap it (cheap no-op for never-containerized tabs).
        crate::services::sandbox::kill_tab_process(&opts.id);
    }
    // What runs in the tab may still read the app's variables by their old
    // names (a hook an older build registered in a config the app does not
    // own, a user's script): export both, here before a wrapper turns the
    // environment into an argv, and once more before the spawn for what the
    // wrappers add. A no-op while the prefix is unchanged.
    crate::brand::PAIR.export_both(&mut opts.env);
    if opts.sandbox && !opts.local_only {
        // Every host, Windows included: the mount destinations and `-w` are
        // spelled for the container by `sandbox::container_path`, so a `C:\`
        // project lands at `/c/…` inside the Linux container.
        crate::services::sandbox::wrap_pty_options_docker(&mut opts)?;
    } else if !opts.local_only {
        // `wrap_pty_options` below spawns a bare `ssh` with no BatchMode and no
        // askpass — it only ever rides an already-authenticated ControlMaster.
        // The pool is normally primed at project activation, but that master can
        // die quietly (keepalive kill on a dropped VPN/laptop sleep, or an HPC
        // job's long queue wait past `ControlPersist`) long before this tab opens.
        // Re-run the same silent connect used at activation here, best-effort:
        // on a healthy headless host this re-authenticates via the saved
        // password/askpass with no prompt, so the tab's own ssh always has a live
        // master to ride; on a genuinely unreachable host it fails harmlessly and
        // today's raw-ssh fallback (with its native prompt) still applies.
        if let Some(project_id) = opts.project_id.clone() {
            let host_id = opts
                .remote_host_id
                .clone()
                .unwrap_or_else(|| crate::services::remote::PRIMARY_HOST.to_string());
            // …but that convenience is also an unattended dial. This same call
            // runs for a tab *restored at relaunch*, where nobody has asked for
            // anything: it would open a ControlMaster on the host and, for a
            // tmux-wrapped tab, a tmux server with it. On a machine tagged HPC
            // that is precisely what the tag forbids, so refuse with the
            // `HPC_GUARD` sentinel and let the frontend offer "connect and open".
            // Once the user *has* connected the project the pool holds a standing
            // authorization (`services::remote::connect_host`), so a tab opened
            // by hand after that is allowed — which is the only distinction this
            // seam can make: `pty_spawn` receives identical options for a restore
            // and for a click.
            if let Some(target) =
                crate::services::remote::remote_target_for_host(&project_id, &host_id)
            {
                let spec = &target.spec;
                crate::services::ssh_common::authorize_dial(
                    &spec.user,
                    &spec.host,
                    spec.port,
                    crate::services::ssh_common::ambient_intent(&spec.user, &spec.host, spec.port),
                )?;
                // Only a remote project needs the pool. A local one has nothing
                // to dial, and a headless spawn (no window, `pool` is `None`)
                // must still start it.
                let Some(pool) = pool else {
                    return Err(format!(
                        "terminal: tab '{}' needs a window's remote pool to reach project '{project_id}'",
                        opts.id
                    ));
                };
                let _ = crate::services::remote::connect_host(pool, &project_id, &host_id, None).await;
            }
        }
        crate::services::ssh_exec::wrap_pty_options(&mut opts)?;
    }

    // The tab's session name (the Remote Control title too), set at launch with
    // Claude's `--name` rather than a `/rename` line typed a few seconds in —
    // which is what anything the user typed meanwhile ran into. Only a spawn
    // still running `claude` here reaches this, i.e. the host's own binary
    // (fenced or not), the one whose version Tabtivity has read; a container or
    // remote host has its own, and an older one exits on the unknown option.
    // Those, and a host CLI that is too old or not read yet, keep the typed line.
    let named = opts.cmd == "claude"
        && session_name.is_some()
        && !crate::services::agent_fence::runs_subcommand(&opts.args)
        && crate::commands::agents::claude_takes_name_flag()
        && append_claude_name(&mut opts.args, session_name.as_deref());

    // A compatible host Codex TUI stays in-process: its detached app-server
    // daemon would put a socket in this tab's private fence /tmp, which a
    // sibling tab cannot reach. Older releases do not accept this flag.
    if opts.cmd == "codex"
        && crate::services::agent_versions::codex_runs_tui(&opts.args)
        && !opts.args.iter().any(|a| a == "--no-daemon")
        && crate::commands::agents::codex_takes_no_daemon()
    {
        opts.args.push("--no-daemon".to_string());
    }

    // Apply the outer fence boundary (bubblewrap on Linux, sandbox-exec on
    // macOS) after docker/ssh selection but before local tmux.  This keeps the
    // tmux server on the host while the command *inside* its session is
    // fenced.  A missing/blocked fence tool fails closed.
    let mut fenced_registration: Option<(String, String)> = None;
    // Every agent tab that runs on the host, fenced or not, for the pill's
    // live check (`agent_fence::live_unfenced_by_scope`). Taken before the
    // fence and tmux rewrites replace `cmd`.
    let host_agent_tab = (fence_roots.is_some()
        && !opts.sandbox
        && opts.cmd != "ssh"
        && opts.cmd != "docker")
        .then(|| crate::services::agent_fence::HostAgentTab {
            scope_id: opts.project_id.clone().unwrap_or_else(|| "root".to_string()),
            agent_cmd: opts.cmd.clone(),
            tmux_session: opts.tmux_session.clone(),
        });
    let spawned_tab_id = opts.id.clone();
    // What the root tab's MCP session records as its projects grant: the
    // paths the fence argv bound when fenced, everything when the agent runs
    // unfenced (it already reads everything).
    let mut root_projects = crate::services::root_mcp::ProjectsGrant::All;
    if let Some(roots) = fence_roots.as_deref() {
        let decision = crate::services::agent_fence::decide(
            &opts,
            roots.to_vec(),
            remote_agent_run,
            crate::services::agent_fence::platform_fenceable(),
            crate::services::agent_fence::platform_accepted(),
            crate::services::agent_fence::bwrap_available(),
        );
        let local_agent = opts.cmd != "ssh" && opts.cmd != "docker";
        let scope_id = crate::services::agent_home::scope_of(opts.project_id.as_deref());
        match decision {
            crate::services::agent_fence::FenceDecision::Fenced { .. } if local_agent => {
                // The scope's Tabtivity-owned home (`services::agent_home`), the
                // agent's `$HOME` from here on: bound by the Linux fence, set
                // by environment where the fence cannot redirect a path.
                let home = crate::services::agent_home::prepare_scope_home(&scope_id, roots)
                    .map_err(|e| format!("Agent home: {e}"))?;
                #[cfg(target_os = "linux")]
                crate::services::agent_fence::wrap_pty_options_bwrap(
                    &mut opts, roots, &scope_id, &home.dir,
                )?;
                #[cfg(target_os = "macos")]
                crate::services::agent_fence::wrap_pty_options_sandbox_exec(
                    &mut opts, roots, &scope_id, &home.dir,
                )?;
                // Unreachable where no fence exists (`decide` never answers
                // `Fenced` there); the home is still prepared for symmetry.
                #[cfg(not(any(target_os = "linux", target_os = "macos")))]
                let _ = &home;
                root_projects = match crate::services::agent_fence::take_root_projects_granted(&opts.id) {
                    Some(paths) => crate::services::root_mcp::ProjectsGrant::Paths(paths),
                    None => crate::services::root_mcp::ProjectsGrant::Hidden,
                };
                fenced_registration = Some((opts.id.clone(), scope_id));
            }
            // The root console's Host session: unfenced, in Tabtivity's own
            // `host` home, sharing the logins. Never a project's default.
            crate::services::agent_fence::FenceDecision::NotApplicable {
                reason: crate::services::agent_fence::HOST_SESSION_REASON,
            } if local_agent => {
                let home = crate::services::agent_home::prepare_host_home()
                    .map_err(|e| format!("Host session home: {e}"))?;
                for (k, v) in crate::services::agent_fence::home_env(&home.dir, &crate::paths::home_dir()) {
                    opts.env.entry(k).or_insert(v);
                }
                crate::services::agent_auth::apply_fence_env(&opts.cmd, &mut opts.env);
                opts.env.insert(crate::app_env!("HOST_SESSION").into(), "1".into());
            }
            // No fence on this platform (Windows): the same Tabtivity-owned home
            // and shared logins, by environment; the rights are the user's.
            crate::services::agent_fence::FenceDecision::NotApplicable { reason: "platform" }
                if local_agent =>
            {
                let home = crate::services::agent_home::prepare_scope_home(&scope_id, roots)
                    .map_err(|e| format!("Agent home: {e}"))?;
                for (k, v) in crate::services::agent_fence::home_env(&home.dir, &crate::paths::home_dir()) {
                    opts.env.entry(k).or_insert(v);
                }
                crate::services::agent_auth::apply_fence_env(&opts.cmd, &mut opts.env);
            }
            // Fail closed on a fence-less platform too: the tab that asked
            // shows the acceptance prompt and retries once it is given.
            crate::services::agent_fence::FenceDecision::PlatformUnaccepted => {
                return Err(crate::services::agent_fence::platform_unaccepted_message());
            }
            crate::services::agent_fence::FenceDecision::Unavailable => {
                return Err(crate::services::agent_fence::fence_unavailable_message());
            }
            _ => {}
        }
    }

    // Before the agent process exists, so no tool call can see the default.
    if root_agent && root_projects != crate::services::root_mcp::ProjectsGrant::Hidden {
        crate::services::root_mcp::mark_tab_projects_readable(&opts.id, root_projects);
    }

    // Persistent LOCAL (tmux) sessions (TODO #85): a tab that resolved to a LOCAL
    // spawn — i.e. ssh/docker wrapping did NOT rewrite it — and carries a
    // `tmux_session` name is wrapped in a tmux session on this machine, so the run
    // survives a Tabtivity crash and the tab reattaches on restart. A remote tab is
    // now `cmd == "ssh"` (its tmux is inside the remote command) and a container tab
    // is `cmd == "docker"`, so both are skipped. No-op on Windows / without tmux.
    crate::brand::PAIR.export_both(&mut opts.env);
    #[cfg(unix)]
    if opts.tmux_session.is_some() && opts.cmd != "ssh" && opts.cmd != "docker" {
        crate::services::tmux_local::wrap_pty_options_local(&mut opts);
    }

    Ok(PreparedLaunch {
        opts,
        named,
        interrupted,
        mcp_spawn_guard,
        resume_claim,
        fenced_registration,
        host_agent_tab,
        spawned_tab_id,
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn scope_root_is_not_the_tab_cwd() {
        assert_eq!(super::scope_root_for("local", None, "mirror", None, false), "local");
        assert_eq!(super::scope_root_for("local", Some("host"), "mirror", None, false), "host");
        assert_eq!(super::scope_root_for("local", Some("host"), "mirror", None, true), "mirror");
        assert_eq!(super::scope_root_for("member", None, "mirror", Some("box"), false), "box");
    }

    use super::*;
    use crate::schema::projects::ProjectEntry;
    use std::collections::HashMap;
    use std::path::Path;

    // ── vm_spawn_refusal: the VM tier's no-local-fallback guard ────────────

    #[test]
    fn non_vm_projects_spawn_freely() {
        assert_eq!(vm_spawn_refusal(false, false, true, "t1"), None);
        assert_eq!(vm_spawn_refusal(false, false, false, "t1"), None);
    }

    #[test]
    fn vm_local_spawn_is_refused_even_with_the_vm_up() {
        // The refusal is about the boundary, not availability: a host shell
        // for a VM project is never a fallback, running VM or not.
        assert!(vm_spawn_refusal(true, true, true, "t1").is_some());
        assert!(vm_spawn_refusal(true, false, true, "t1").is_some());
    }

    #[test]
    fn vm_down_refuses_with_the_boot_sentinel() {
        let msg = vm_spawn_refusal(true, false, false, "t1").unwrap();
        assert!(msg.starts_with(concat!(crate::app_upper!(), "_VM_DOWN:")), "{msg}");
    }

    #[test]
    fn vm_up_remote_spawn_proceeds() {
        assert_eq!(vm_spawn_refusal(true, true, false, "t1"), None);
    }

    #[test]
    fn cwd_within_accepts_project_dir_and_subdirs() {
        assert!(cwd_within("/home/u/proj", Path::new("/home/u/proj")));
        assert!(cwd_within(
            concat!("/home/u/proj/.", crate::app_slug!(), "/worktrees/feature-x"),
            Path::new("/home/u/proj")
        ));
    }

    #[test]
    fn cwd_within_rejects_sibling_and_unrelated_paths() {
        assert!(!cwd_within("/home/u/proj2", Path::new("/home/u/proj")));
        assert!(!cwd_within("/etc", Path::new("/home/u/proj")));
    }

    #[test]
    fn claude_name_rides_the_argv_once() {
        let mut args = vec!["--session-id".to_string(), "u".to_string()];
        assert!(append_claude_name(&mut args, Some(" Proj (feature) ")));
        assert_eq!(args.last().map(String::as_str), Some("--name=Proj (feature)"));
        // A respawn with the name already there does not stack a second one.
        assert!(append_claude_name(&mut args, Some("Other")));
        assert_eq!(args.iter().filter(|a| a.starts_with("--name")).count(), 1);
        // A leading dash stays the flag's value.
        let mut dashed = Vec::new();
        assert!(append_claude_name(&mut dashed, Some("-x")));
        assert_eq!(dashed, vec!["--name=-x".to_string()]);
    }

    #[test]
    fn no_name_no_flag() {
        let mut args = Vec::new();
        assert!(!append_claude_name(&mut args, None));
        assert!(!append_claude_name(&mut args, Some("   ")));
        assert!(args.is_empty());
    }

    fn entry(id: &str, remote_control: Option<bool>) -> ProjectEntry {
        let mut extra = HashMap::new();
        if let Some(v) = remote_control {
            extra.insert("remote_control".to_string(), serde_json::Value::Bool(v));
        }
        ProjectEntry {
            id: id.to_string(),
            name: id.to_string(),
            status: "inactive".to_string(),
            position: 0,
            local_file: String::new(),
            extra,
        }
    }

    #[test]
    fn no_project_id_falls_back_to_global() {
        assert!(agent_remote_control_effective(&[], None, true));
        assert!(!agent_remote_control_effective(&[], None, false));
    }

    #[test]
    fn unknown_project_falls_back_to_global() {
        let list = vec![entry("p1", Some(false))];
        assert!(agent_remote_control_effective(&list, Some("p2"), true));
    }

    #[test]
    fn project_override_wins_over_global_in_both_directions() {
        let list = vec![entry("p1", Some(false)), entry("p2", Some(true))];
        assert!(!agent_remote_control_effective(&list, Some("p1"), true));
        assert!(agent_remote_control_effective(&list, Some("p2"), false));
    }

    #[test]
    fn no_override_inherits_the_global_default() {
        let list = vec![entry("p1", None)];
        assert!(agent_remote_control_effective(&list, Some("p1"), true));
        assert!(!agent_remote_control_effective(&list, Some("p1"), false));
    }
}
