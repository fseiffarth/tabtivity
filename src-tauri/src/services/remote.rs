//! Explicit remoteness + pooled SSH/SFTP connection for remote (SSH) projects.
//!
//! Phase 0 of the mount-free remote model (`docs/mountfree_remote_plan.md`).
//! Two responsibilities:
//!
//! 1. **Explicit remoteness.** [`remote_target_for`] is the single source of
//!    truth for "is this project remote, and where does it live?" — replacing
//!    the old infer-from-mountpoint-path signal (`ssh_exec::project_id_from_cwd`,
//!    which sniffed a cwd under `ssh_mount::mounts_root()`). It returns `Some`
//!    iff the project carries a [`RemoteSpec`]. Later phases (terminal, file
//!    browse, file I/O, git) dispatch on this rather than on a path convention.
//!
//! 2. **Pooled connection.** A single persistent SSH ControlMaster + SFTP session
//!    per active remote project, opened once on activation ([`connect`]) and
//!    reused by file browsing / I-O (and ridden by agent tabs / git over the
//!    shared master). This is the single-sign-on + performance linchpin:
//!    authentication happens once here, and every later channel rides the master
//!    with no re-auth and fast channel setup. Held in Tauri-managed state
//!    ([`RemotePoolState`]); torn down by [`disconnect`] / [`disconnect_all`].
//!
//! Password-auth hosts feed the password to the master via `SSHPASS`
//! (`sshpass -e`), never on argv. By default it is never stored; when the user
//! opts into "Save password", it is kept in the OS keychain (never our JSON) and
//! reused here for silent reconnect (see `services::remote_credentials`).

use std::collections::HashMap;
use std::sync::Arc;

use openssh_sftp_client::Sftp;
use tokio::process::Child;
use tokio::sync::Mutex;

use crate::schema::project::{ComputeHost, RemoteSpec};
use crate::schema::projects::{ProjectEntry, ProjectsList};

/// The implicit host id of a project's **primary** remote (`Project.remote`).
/// Extra "worker" hosts (`docs/multi_host_remote_plan.md`) carry their own stable
/// ids; the primary's is this constant so file/git/sync callers — which *are* the
/// primary subsystem — resolve it without threading an id.
pub const PRIMARY_HOST: &str = "primary";

/// Pool key for a `(project, host)` pair. Two hosts of one project → two entries,
/// so a worker connects/disconnects independently of the primary. The `\u{1}`
/// separator can't appear in a project or host id.
pub(crate) fn conn_key(project_id: &str, host_id: &str) -> String {
    format!("{project_id}\u{1}{host_id}")
}

/// The project id embedded in a [`conn_key`] (everything before the separator).
fn project_of_key(key: &str) -> &str {
    key.split('\u{1}').next().unwrap_or(key)
}

/// A resolved remote project: its [`RemoteSpec`] plus the owning project id.
/// The explicit replacement for inferring remoteness from a mountpoint path.
#[derive(Debug, Clone)]
pub struct RemoteTarget {
    pub spec: RemoteSpec,
    pub project_id: String,
}

/// `Some(target)` iff the project identified by `project_id` is remote; `None`
/// for a local project or any read failure (degrades to local-fs behavior).
///
/// The remote spec is read from the **always-local** `projects.json` entry's
/// flattened `extra["remote"]` (mirrored there at create/import time), NOT from
/// the per-project `project.json`: for a mount-free remote project that file
/// lives on the host and is not locally readable, whereas this global list is
/// always on the local disk. This keeps the resolver synchronous and fast.
pub fn remote_target_for(project_id: &str) -> Option<RemoteTarget> {
    let list = read_projects_list()?;
    let entry = list.iter().find(|e| e.id == project_id)?;
    spec_from_entry(entry).map(|spec| RemoteTarget {
        spec,
        project_id: project_id.to_string(),
    })
}

/// `Some(target)` iff the project whose stored `directory` equals `project_dir`
/// is remote; `None` for a local project, an unknown directory, or a read
/// failure.
///
/// The git/file commands receive a `project_dir` (not a `project_id`), so to
/// dispatch remote-vs-local without threading a `project_id` through every
/// frontend call site we reverse-look-up the owning project: the value the
/// frontend passes as `project_dir` is the project's stored `directory`, kept in
/// the `projects.json` entry's flattened `extra["directory"]`. For a remote
/// project `directory` is a local per-project state dir (no longer a mountpoint)
/// that simply keys the entry and holds its `project.json`; the actual tree lives
/// on `spec.remote_path` and is reached over SFTP/SSH.
pub fn remote_target_for_dir(project_dir: &str) -> Option<RemoteTarget> {
    let list = read_projects_list()?;
    let entry = list
        .iter()
        .find(|e| entry_directory(e) == Some(project_dir))?;
    spec_from_entry(entry).map(|spec| RemoteTarget {
        spec,
        project_id: entry.id.clone(),
    })
}

/// Parsed `projects.json` plus the `(mtime, len)` it was parsed from — the cache
/// behind [`read_projects_list`].
static PROJECTS_CACHE: std::sync::Mutex<Option<(std::time::SystemTime, u64, Arc<ProjectsList>)>> =
    std::sync::Mutex::new(None);

/// Read the global `projects.json` list, or `None` if absent/unparseable.
///
/// CACHED on the file's `(mtime, len)`, because this is one of the hottest paths
/// in the backend and it was re-reading and re-parsing the same file every time.
/// [`remote_target_for`] and [`remote_target_for_dir`] are *the* remoteness
/// oracle — every file, git, sync and SFTP call resolves through one of them, at
/// ~110 call sites — and each call did a full disk read plus a serde parse of a
/// document whose entries carry `#[serde(flatten)]` extras. Flattened
/// deserialization is buffered and quadratic-ish in field count, so it is
/// expensive out of proportion to the file's size. A `perf` profile of the
/// backend under ordinary use was dominated by exactly that: `parse_whitespace`,
/// `FlatMapAccess::next_value_seed`, `skip_to_escape`, spread across every tokio
/// worker, at ~175% of a core.
///
/// A `stat` replaces the read whenever nothing has changed. Tabtivity is the only
/// writer of this file, and every write goes through `storage::write_json`, so a
/// changed list always moves `mtime` (nanosecond precision on Linux) or `len`.
/// The value is an `Arc`, so a hit costs one clone of a pointer rather than of
/// the whole list.
fn read_projects_list() -> Option<Arc<ProjectsList>> {
    let list_path = crate::storage::state_dir().join("projects.json");
    let meta = std::fs::metadata(&list_path).ok()?;
    let stamp = (meta.modified().ok()?, meta.len());

    if let Ok(guard) = PROJECTS_CACHE.lock() {
        if let Some((mtime, len, list)) = guard.as_ref() {
            if *mtime == stamp.0 && *len == stamp.1 {
                return Some(Arc::clone(list));
            }
        }
    }

    let list: Arc<ProjectsList> = Arc::new(crate::storage::read_json(&list_path).ok()?);
    if let Ok(mut guard) = PROJECTS_CACHE.lock() {
        *guard = Some((stamp.0, stamp.1, Arc::clone(&list)));
    }
    Some(list)
}

/// A `projects.json` entry's stored `directory` (its flattened `extra` field).
pub(crate) fn entry_directory(entry: &ProjectEntry) -> Option<&str> {
    entry.extra.get("directory").and_then(|v| v.as_str())
}

/// The `directory` recorded for `project_id` in the always-local `projects.json`.
///
/// The forward lookup to [`remote_target_for_dir`]'s reverse one. For a LOCAL
/// project this is where its files are; for a REMOTE project it is the local
/// per-project state dir, not the tree (which lives on the host).
pub fn project_directory(project_id: &str) -> Option<String> {
    let list = read_projects_list()?;
    let entry = list.iter().find(|e| e.id == project_id)?;
    entry_directory(entry).map(str::to_string)
}

/// The `RemoteSpec` mirrored into a `projects.json` entry's flattened
/// `extra["remote"]`, or `None` for a local project. Pure, so the "remote iff a
/// spec is present" mapping is testable without the real state dir.
fn spec_from_entry(entry: &ProjectEntry) -> Option<RemoteSpec> {
    let value = entry.extra.get("remote")?;
    serde_json::from_value(value.clone()).ok()
}

/// The extra "worker" hosts mirrored into a `projects.json` entry's flattened
/// `extra["compute_hosts"]`, or `[]` when absent/unparseable. Pure, so the
/// resolver is testable without the real state dir.
fn compute_hosts_from_entry(entry: &ProjectEntry) -> Vec<ComputeHost> {
    entry
        .extra
        .get("compute_hosts")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default()
}

/// The extra worker hosts declared for `project_id`, read from the always-local
/// `projects.json` (mirrored there by `commands::projects`). `[]` for a local or
/// single-host project.
pub fn compute_hosts_for(project_id: &str) -> Vec<ComputeHost> {
    read_projects_list()
        .and_then(|list| {
            list.iter()
                .find(|e| e.id == project_id)
                .map(compute_hosts_from_entry)
        })
        .unwrap_or_default()
}

/// Whether [`remote_target_for_host`] would find a target, over one
/// `projects.json` entry already read (`root_mcp::grant_lanes` reads its
/// entry from an explicit state dir).
pub(crate) fn entry_is_remote_for_host(entry: &ProjectEntry, host_id: &str) -> bool {
    if host_id == PRIMARY_HOST {
        spec_from_entry(entry).is_some()
    } else {
        compute_hosts_from_entry(entry).iter().any(|h| h.id == host_id)
    }
}

/// Resolve `(project_id, host_id)` to a [`RemoteTarget`]: the primary spec
/// ([`remote_target_for`]) for [`PRIMARY_HOST`], else the matching worker's spec.
/// `None` for a local project, an unknown host id, or a read failure.
pub fn remote_target_for_host(project_id: &str, host_id: &str) -> Option<RemoteTarget> {
    if host_id == PRIMARY_HOST {
        return remote_target_for(project_id);
    }
    compute_hosts_for(project_id)
        .into_iter()
        .find(|h| h.id == host_id)
        .map(|h| RemoteTarget {
            spec: h.spec,
            project_id: project_id.to_string(),
        })
}

// ── Pooled connection ──────────────────────────────────────────────────────

/// One pooled remote connection: the live SFTP session (shared via `Arc` so file
/// commands can clone it and run operations without holding the pool lock — see
/// [`pooled_sftp`]) and the `ssh` child whose lifetime keeps the session, and the
/// ControlMaster it established, alive. Dropping `child` would collapse the
/// connection, so it is owned here and killed explicitly on teardown.
struct PooledRemote {
    sftp: Arc<Sftp>,
    child: Child,
    /// The `cm-<hash>` socket this connection's ControlMaster owns, resolved at
    /// connect time (`ssh -G` expands `%C`, which nothing here can compute) so
    /// teardown can unlink it. See [`teardown_pooled`].
    control_path: Option<std::path::PathBuf>,
    /// The standing dial authorization this connection holds, as an RAII guard
    /// rather than a matching `forget_…` call at teardown. That distinction is
    /// load-bearing: `teardown_pooled` is **not** the only way a pool entry goes
    /// away — five sites (`connect_host`'s own dead-entry eviction,
    /// `pooled_sftp_host`, `connected_ids`, `is_connected_host`,
    /// `connected_targets`) reap a dead connection by simply removing it from the
    /// map. Each of those used to leak a refcount, and one leak permanently
    /// authorizes *every background* dial to that target for the rest of the
    /// process — disarming the HPC gate on precisely the hosts whose master dies
    /// most often. Held as a field, `Drop` covers every one of those paths.
    _dial: crate::services::ssh_common::UserDial,
}

/// Tauri-managed pool of live remote connections, keyed by [`conn_key`]
/// (`project\u{1}host`) so a project's primary and its extra worker hosts each
/// hold an independent connection.
#[derive(Default)]
pub struct RemotePool {
    conns: HashMap<String, PooledRemote>,
}

/// Managed-state handle to the pool. `tokio::sync::Mutex` because every access is
/// inside an async command and teardown awaits the child.
pub type RemotePoolState = Arc<Mutex<RemotePool>>;

/// Build a fresh, empty pool for `tauri::Builder::manage`.
pub fn new_pool() -> RemotePoolState {
    Arc::new(Mutex::new(RemotePool::default()))
}

/// Open (idempotently) the pooled SSH/SFTP connection for `project_id`. A no-op
/// for a local project or one already connected. `password` is used only for
/// password-auth hosts (fed to `sshpass` over `SSHPASS`, never stored / on argv);
/// `None` uses key/agent auth. The connection is opened OUTSIDE the pool lock so
/// a slow handshake never blocks other pool access.
///
/// By contract of the caller (the UI invokes this fire-and-forget on activation)
/// a failure must never block activation: it is returned as `Err` for the caller
/// to log, and the project simply has no pooled connection (later access falls
/// back to a one-shot session, exactly as before).
pub async fn connect(
    pool: &RemotePoolState,
    project_id: &str,
    password: Option<&str>,
) -> Result<(), String> {
    connect_host(pool, project_id, PRIMARY_HOST, password).await
}

/// Open (idempotently) the pooled connection for a specific `(project, host)`.
/// [`PRIMARY_HOST`] is the project's primary remote (and mints the local mirror);
/// any other id is an extra worker host resolved from `compute_hosts`. A no-op for
/// a local project, an unknown host id, or one already connected. See [`connect`]
/// for the password/auth contract.
pub async fn connect_host(
    pool: &RemotePoolState,
    project_id: &str,
    host_id: &str,
    password: Option<&str>,
) -> Result<(), String> {
    let Some(target) = remote_target_for_host(project_id, host_id) else {
        return Ok(()); // local project or unknown host — nothing to pool
    };
    // SSH-sync Phase 1: ensure the local mirror twin exists for a connected
    // remote project (covers projects created before the mirror was minted at
    // create time). Only the PRIMARY owns the mirror — a worker never does.
    if host_id == PRIMARY_HOST {
        let _ = std::fs::create_dir_all(crate::services::remote_sync::mirror_dir(project_id));
    }
    let key = conn_key(project_id, host_id);
    // A live entry whose ControlMaster socket has gone missing: reopen it, and
    // swap the fresh connection in only once it is actually up (see below).
    let mut refreshing = false;
    {
        // Liveness-checked, not mere presence: a pooled ssh child can have exited
        // long after connect (keepalive kill on a dropped VPN/network, laptop
        // sleep, an HPC job's long queue wait past `ControlPersist`) while the
        // pool entry lingers. Every other reader here (`is_connected_host`,
        // `pooled_sftp_host`, etc.) reaps a corpse before answering; this one
        // must too, or a dead entry blocks reconnection forever and every later
        // tab on that host falls through to its own unauthenticated raw `ssh`.
        let mut guard = pool.lock().await;
        let dead = guard
            .conns
            .get_mut(&key)
            .map(|conn| matches!(conn.child.try_wait(), Ok(Some(_))));
        match dead {
            Some(true) => {
                guard.conns.remove(&key);
            }
            Some(false) => {
                // Alive is not the same as *usable by anything but this entry*.
                // The pooled SFTP rides a channel that is already open, so it
                // keeps working even after the master's socket is gone from disk
                // — but the socket is what every OTHER consumer finds the master
                // by (`ssh_pty_args`, git-over-ssh, sync, the SLURM/tmux probes),
                // and its absence turns each of them into its own login, i.e. a
                // key-passphrase prompt on a project reporting itself connected.
                //
                // It goes missing for reasons outside this entry's control: any
                // sibling pool entry on the same SSH target used to unlink it on
                // teardown (fixed there), and a `-O exit` / manual cleanup can do
                // it at any time. Treating "child alive" as the whole liveness
                // test meant this — the call `pty_spawn` makes before every remote
                // tab — returned `Ok` and the prompt was permanent for the run.
                //
                // A plain `stat` is all it takes and it is cheap enough to hold
                // the lock across; `ssh -O check` (a spawn) belongs nowhere near
                // here (see the `ssh -G` note below).
                let lost = guard
                    .conns
                    .get(&key)
                    .and_then(|conn| conn.control_path.as_deref())
                    .is_some_and(|path| !path.exists());
                if !lost {
                    return Ok(()); // already connected and alive
                }
                refreshing = true;
            }
            None => {}
        }
    }

    let spec = &target.spec;
    // Silent reconnect: the activation path calls this with `None`. Before falling
    // back to key/agent auth, use a saved password for this host target if the user
    // opted to remember one (see `services::remote_credentials`).
    //
    // An *empty* password counts as "none given", not as "authenticate with the
    // empty string": the Connect modal sends a blank field when the user is relying
    // on the saved credential, and taking that literally made the pooled connect
    // fail with a saved password sitting right there in the keychain (`ssh_connect`
    // filters it, so the probe passed and only this leg failed).
    let supplied = password.filter(|p| !p.is_empty()).map(str::to_string);
    let password = if supplied.is_some() {
        supplied
    } else {
        let account =
            crate::services::remote_credentials::ssh_account(&spec.user, &spec.host, spec.port);
        // Secret Service can block for seconds while its collection is locked.
        // Keep that bounded/blocking read off Tokio's async worker threads.
        tokio::task::spawn_blocking(move || crate::services::remote_credentials::get(&account))
            .await
            .unwrap_or(None)
    };
    let (sftp, child) = crate::services::sftp::open_pooled_session(
        &spec.user,
        &spec.host,
        spec.port,
        password.as_deref(),
    )
    .await?;

    // Resolve the master's socket path now, while nothing is held: it spawns a
    // local `ssh -G` (see `ssh_exec::resolve_control_path`), which must not run
    // on a tokio worker under the pool lock. Recorded so teardown can unlink it.
    let control_path = {
        let spec = spec.clone();
        tokio::task::spawn_blocking(move || crate::services::ssh_exec::resolve_control_path(&spec))
            .await
            .unwrap_or(None)
    };

    let mut guard = pool.lock().await;
    // A concurrent connect may have won the race while we were handshaking. If so
    // keep theirs and tear ours down rather than leaking a second ssh child.
    // `refreshing` is the deliberate exception: the entry sitting there is the one
    // whose master we are replacing, so finding it is the expected case, not a
    // lost race. Reopening BEFORE evicting it is what keeps a failed refresh
    // harmless — a host we cannot re-authenticate (no saved credential) leaves the
    // working SFTP session in place instead of trading it for nothing.
    if !refreshing && guard.conns.contains_key(&key) {
        drop(guard);
        teardown_session(sftp, child).await;
        return Ok(());
    }
    // The connection is live and the user's: hold a standing dial authorization
    // for as long as it is pooled. Work that rides a master a person opened — a
    // shell tab, a `git status`, a Sessions listing — is not Tabtivity reaching out
    // by itself, so it must not be refused on a host tagged HPC. The guard lives
    // *in* the pool entry, so it is released however that entry dies.
    let dial = crate::services::ssh_common::user_dial(&spec.user, &spec.host, spec.port);
    let replaced = guard.conns.insert(
        key,
        PooledRemote {
            sftp: Arc::new(sftp),
            child,
            control_path,
            _dial: dial,
        },
    );
    drop(guard);
    // The socketless entry this refresh replaced. Torn down after the swap and
    // outside the lock: its `ssh` client is still holding a channel on the
    // orphaned master, and nothing else will ever reach that one again. The
    // teardown's own socket check now sees the master we just opened at the same
    // path and so leaves the *new* socket alone.
    if let Some(prev) = replaced {
        teardown_pooled(prev).await;
    }
    Ok(())
}

/// Close and remove the pooled PRIMARY connection for `project_id` (no-op if none).
pub async fn disconnect(pool: &RemotePoolState, project_id: &str) {
    disconnect_host(pool, project_id, PRIMARY_HOST).await;
}

/// Close and remove the pooled connection for a specific `(project, host)`.
pub async fn disconnect_host(pool: &RemotePoolState, project_id: &str, host_id: &str) {
    let removed = pool
        .lock()
        .await
        .conns
        .remove(&conn_key(project_id, host_id));
    if let Some(conn) = removed {
        teardown_pooled(conn).await;
    }
}

/// Close and remove **every** pooled connection for `project_id` — its primary and
/// all worker hosts. Used on project deactivation so no host outlives the view.
pub async fn disconnect_project(pool: &RemotePoolState, project_id: &str) {
    let removed: Vec<PooledRemote> = {
        let mut guard = pool.lock().await;
        let keys: Vec<String> = guard
            .conns
            .keys()
            .filter(|k| project_of_key(k) == project_id)
            .cloned()
            .collect();
        keys.into_iter()
            .filter_map(|k| guard.conns.remove(&k))
            .collect()
    };
    for conn in removed {
        teardown_pooled(conn).await;
    }
}

/// Tear down every pooled connection. Used at app exit so no ssh ControlMaster
/// child outlives Tabtivity.
pub async fn disconnect_all(pool: &RemotePoolState) {
    let conns: Vec<PooledRemote> = {
        let mut guard = pool.lock().await;
        guard.conns.drain().map(|(_, c)| c).collect()
    };
    for conn in conns {
        teardown_pooled(conn).await;
    }
}

/// Clone the pooled SFTP session for `project_id`, if one is connected. Later
/// phases (file browse / I-O) call this and run operations on the returned
/// `Arc<Sftp>` without holding the pool lock. `None` when the project is not
/// connected — the caller then opens a one-shot session or surfaces a
/// "disconnected" state rather than hanging.
#[allow(dead_code)] // consumed by Phase 2/3 (remote file browse + I/O)
pub async fn pooled_sftp(pool: &RemotePoolState, project_id: &str) -> Option<Arc<Sftp>> {
    pooled_sftp_host(pool, project_id, PRIMARY_HOST).await
}

/// Clone the pooled SFTP session for a specific `(project, host)`, if connected.
pub async fn pooled_sftp_host(
    pool: &RemotePoolState,
    project_id: &str,
    host_id: &str,
) -> Option<Arc<Sftp>> {
    let key = conn_key(project_id, host_id);
    let mut guard = pool.lock().await;
    let conn = guard.conns.get_mut(&key)?;
    // If the ssh child has already exited — the keepalive killed it after a
    // network drop (ServerAliveInterval/CountMax), or the remote closed the
    // connection — the pooled session is dead and every SFTP op on it would fail
    // against a closed pipe. Evict the corpse so the caller falls back to a
    // one-shot session (which can ride a still-live master, or surface a clean
    // disconnected state) instead of looping on the dead entry forever.
    if matches!(conn.child.try_wait(), Ok(Some(_))) {
        guard.conns.remove(&key);
        return None;
    }
    Some(Arc::clone(&conn.sftp))
}

/// The **distinct project ids** with any pooled SSH connection currently live
/// (primary or any worker host). Evicts any whose ssh child has already exited
/// (same corpse-reaping as [`is_connected`]) so the background traffic sampler
/// never samples a dead ControlMaster. Order is unspecified. Traffic accounting
/// sums a project's hosts under one project bucket (plan §3.4), so this collapses
/// the composite keys back to project ids.
pub async fn connected_ids(pool: &RemotePoolState) -> Vec<String> {
    let mut guard = pool.lock().await;
    let dead: Vec<String> = guard
        .conns
        .iter_mut()
        .filter_map(|(key, conn)| match conn.child.try_wait() {
            Ok(Some(_)) => Some(key.clone()),
            _ => None,
        })
        .collect();
    for key in &dead {
        guard.conns.remove(key);
    }
    let mut ids: Vec<String> = guard
        .conns
        .keys()
        .map(|k| project_of_key(k).to_string())
        .collect();
    ids.sort();
    ids.dedup();
    ids
}

/// Whether a project's PRIMARY pooled SSH connection is live.
pub async fn is_connected(pool: &RemotePoolState, project_id: &str) -> bool {
    is_connected_host(pool, project_id, PRIMARY_HOST).await
}

/// Whether a specific `(project, host)` pooled SSH connection is live. Like
/// [`pooled_sftp`], this evicts a child that has already exited so read-only
/// observers never launch a fallback connection merely to discover it is offline.
pub async fn is_connected_host(pool: &RemotePoolState, project_id: &str, host_id: &str) -> bool {
    let key = conn_key(project_id, host_id);
    let mut guard = pool.lock().await;
    let Some(conn) = guard.conns.get_mut(&key) else {
        return false;
    };
    if matches!(conn.child.try_wait(), Ok(Some(_))) {
        guard.conns.remove(&key);
        return false;
    }
    true
}

/// The `(project_id, host_id)` pairs whose pooled SSH connection is currently live.
/// The per-host granular form of [`connected_ids`], for the frontend to reconcile
/// each lamp against reality. Evicts dead children like the others.
pub async fn connected_targets(pool: &RemotePoolState) -> Vec<(String, String)> {
    let mut guard = pool.lock().await;
    let dead: Vec<String> = guard
        .conns
        .iter_mut()
        .filter_map(|(key, conn)| match conn.child.try_wait() {
            Ok(Some(_)) => Some(key.clone()),
            _ => None,
        })
        .collect();
    for key in &dead {
        guard.conns.remove(key);
    }
    guard
        .conns
        .keys()
        .filter_map(|k| {
            let mut parts = k.split('\u{1}');
            let pid = parts.next()?;
            let hid = parts.next().unwrap_or(PRIMARY_HOST);
            Some((pid.to_string(), hid.to_string()))
        })
        .collect()
}

/// Tear down a pooled connection: gracefully close the SFTP session (sends
/// `SSH_FXP_CLOSE`, matching [`teardown_session`]) when we hold its only
/// reference, then kill the `ssh` child, which collapses the channel and the
/// ControlMaster it owned. If a file op is still borrowing the `Arc<Sftp>`, we
/// can't take ownership to `close()` it, so we drop our reference and let its own
/// `Drop` close the local side once that borrow finishes.
/// Also unlinks the control socket, and releases the standing dial authorization
/// [`connect_host`] took out — both paired one-for-one with the pool entry, so
/// they cannot outlive the connection they describe.
///
/// The socket matters because `child.kill()` is not `ssh -O exit`: the master dies
/// but leaves its `cm-<hash>` behind, and OpenSSH answers the *next* connection to
/// a stale socket with "ControlSocket … already exists, disabling multiplexing" —
/// after which every command that was supposed to ride one authenticated master
/// opens its own login instead. On a host with a saved password that is silent; on
/// a cluster login node it is a login per file read.
async fn teardown_pooled(conn: PooledRemote) {
    // `_dial` is dropped with the rest of the struct at the end of this function,
    // releasing the standing authorization — the same thing that happens when a
    // dead entry is reaped without ever reaching here.
    let PooledRemote {
        sftp,
        mut child,
        control_path,
        _dial,
    } = conn;
    match Arc::try_unwrap(sftp) {
        Ok(sftp) => {
            let _ = sftp.close().await;
        }
        Err(arc) => drop(arc),
    }
    let _ = child.kill().await;
    // The socket is NOT this entry's to delete just because this entry is going
    // away, and both halves of that sentence were once wrong here.
    //
    // It is keyed by *SSH target* (`cm-%C` hashes user/host/port) while the pool
    // is keyed by `(project, host)`, so several pooled entries — four projects on
    // one lab machine, a worker shared by two of them — name the same file. It
    // also outlives the child we just killed: with `ControlMaster=auto` +
    // `ControlPersist`, `ssh` forks a *separate* backgrounded master (`ssh: …
    // [mux]`, reparented to init) and the client we own is merely its first
    // channel. So an unconditional unlink here deleted a live master's socket and
    // left the master itself running, unreachable — every later `ssh` to that
    // host (a shell tab, git, sync) then found no socket, opened its own login,
    // and asked for the key passphrase on a project whose lamp was green.
    //
    // Ask the master instead. Nothing listening ⇒ a genuine leftover (the master
    // was killed by signal / a crash), which is what the unlink is for; a master
    // that answers is left alone and cleans up its own socket when it exits.
    #[cfg(not(target_os = "windows"))]
    if let Some(path) = control_path {
        // `ssh -O check` is a process spawn, so it goes off the async worker.
        let _ = tokio::task::spawn_blocking(move || {
            if !crate::services::ssh_exec::control_master_alive(&path) {
                let _ = std::fs::remove_file(&path);
            }
        })
        .await;
    }
    #[cfg(target_os = "windows")]
    let _ = control_path;
}

/// Gracefully close a freshly-opened, not-yet-pooled session (the lost-race path
/// in [`connect`]). Here we still own the `Sftp` outright, so the consuming
/// `Sftp::close` can run before the child is killed.
async fn teardown_session(sftp: Sftp, mut child: Child) {
    let _ = sftp.close().await;
    let _ = child.kill().await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn spec() -> RemoteSpec {
        RemoteSpec {
            user: Some("alice".to_string()),
            host: "host.example".to_string(),
            port: None,
            remote_path: "/srv/project".to_string(),
            openvpn: None,
            auto_connect: None,
            key_auth: None,
            persist_sessions: None,
            vm: None,
            label: None,
            extra: HashMap::new(),
        }
    }

    /// A `projects.json` entry, optionally remote (its spec mirrored into
    /// `extra["remote"]` exactly as `commands::projects::project_extra` does).
    fn entry(id: &str, directory: Option<&str>, remote: Option<RemoteSpec>) -> ProjectEntry {
        let mut extra = HashMap::new();
        if let Some(d) = directory {
            extra.insert(
                "directory".to_string(),
                serde_json::Value::String(d.to_string()),
            );
        }
        if let Some(r) = remote {
            extra.insert("remote".to_string(), serde_json::to_value(&r).unwrap());
        }
        ProjectEntry {
            id: id.to_string(),
            name: id.to_string(),
            status: "active".to_string(),
            position: 0,
            local_file: format!("/state/{id}.json"),
            extra,
        }
    }

    #[test]
    fn spec_from_entry_some_for_remote_project() {
        let e = entry("p1", Some("/state/remote-projects/p1"), Some(spec()));
        let resolved = spec_from_entry(&e).expect("remote entry resolves a spec");
        assert_eq!(resolved.host, "host.example");
        assert_eq!(resolved.remote_path, "/srv/project");
    }

    #[test]
    fn spec_from_entry_none_for_local_project() {
        let e = entry("p1", Some(concat!("/home/u/", crate::app_slug!(), "/projects/alpha")), None);
        assert!(spec_from_entry(&e).is_none());
    }

    #[test]
    fn entry_directory_reads_extra() {
        let e = entry("p1", Some("/some/dir"), None);
        assert_eq!(entry_directory(&e), Some("/some/dir"));
        let e2 = entry("p2", None, None);
        assert_eq!(entry_directory(&e2), None);
    }

    fn compute_host(id: &str, host: &str) -> ComputeHost {
        ComputeHost {
            id: id.to_string(),
            sync_code: true,
            pull_outputs: false,
            shared_fs: false,
            spec: RemoteSpec {
                user: Some("alice".to_string()),
                host: host.to_string(),
                port: None,
                remote_path: "/srv/worker".to_string(),
                openvpn: None,
                auto_connect: None,
                key_auth: None,
                persist_sessions: None,
                vm: None,
                label: None,
                extra: HashMap::new(),
            },
        }
    }

    #[test]
    fn conn_key_is_unique_per_host() {
        let a = conn_key("p1", PRIMARY_HOST);
        let b = conn_key("p1", "h1");
        let c = conn_key("p2", "h1");
        assert_ne!(a, b);
        assert_ne!(b, c);
        assert_ne!(a, c);
        // The project id is recoverable from the composite key.
        assert_eq!(project_of_key(&a), "p1");
        assert_eq!(project_of_key(&b), "p1");
        assert_eq!(project_of_key(&c), "p2");
    }

    #[test]
    fn compute_hosts_from_entry_parses_mirror() {
        let mut e = entry("p1", Some("/state/p1"), Some(spec()));
        e.extra.insert(
            "compute_hosts".to_string(),
            serde_json::to_value(vec![compute_host("h1", "gpu-2.example")]).unwrap(),
        );
        let hosts = compute_hosts_from_entry(&e);
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].id, "h1");
        assert_eq!(hosts[0].spec.host, "gpu-2.example");
        assert!(hosts[0].sync_code); // serde default_true survives a round trip
    }

    #[test]
    fn compute_hosts_from_entry_empty_when_absent() {
        let e = entry("p1", Some("/state/p1"), Some(spec()));
        assert!(compute_hosts_from_entry(&e).is_empty());
    }

    #[test]
    fn display_label_falls_back_to_host() {
        let mut h = compute_host("h1", "gpu-2.example");
        assert_eq!(h.display_label(), "gpu-2.example");
        h.spec.label = Some("trainer".to_string());
        assert_eq!(h.display_label(), "trainer");
    }

    #[test]
    fn new_pool_starts_empty() {
        let pool = new_pool();
        // The pool is async-locked; a blocking check here is fine in a sync test
        // since nothing else holds the lock.
        let guard = pool.try_lock().expect("uncontended");
        assert!(guard.conns.is_empty());
    }
}
