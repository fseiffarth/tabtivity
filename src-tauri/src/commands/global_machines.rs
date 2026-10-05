//! Global worker-machine registry (project-free, mirrors the VPN tunnel
//! registry's "machine-wide, not project-scoped" pattern).
//!
//! A [`GlobalMachine`] is authenticated once via the ordinary login mechanism
//! (`commands::ssh::ssh_connect`) with no `remote_path` — the caller does that
//! *before* calling [`global_machine_add`], which only persists the identity.
//! No connect/disconnect commands live here: `ssh_connect`/`ssh_probe` are
//! already project-free and host-identity keyed, so the frontend calls them
//! directly with a machine's `user`/`host`/`port`.

use crate::schema::GlobalMachine;
use crate::storage;
use serde::{Deserialize, Serialize};

fn global_machines_path() -> std::path::PathBuf {
    storage::state_dir().join("global_machines.json")
}

/// One machine as it crosses the import/export boundary. Deliberately a **subset**
/// of [`GlobalMachine`]: it carries the connection *address* (host/port) and the
/// display `label`, but **no `id`, no `auto_connect`, and — on export — no
/// `user`**. The export omits the username on purpose so the resulting file is
/// shareable between people who each log in as themselves (import supplies one
/// common username + password). `user` is still an *accepted* field on import so
/// a hand-authored file can pin a per-machine login; a file Tabtivity wrote never
/// has it. Passwords are never written to or read from this file — the whole
/// point of the "one common password at import" flow.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MachineIo {
    pub host: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
}

/// The on-disk shape of an exported machines file: a versioned wrapper around the
/// list, so a future format change can be detected rather than mis-parsed. Import
/// also tolerates a bare `[MachineIo]` array (a hand-written file), so the wrapper
/// is a convenience, not a requirement.
#[derive(Debug, Serialize, Deserialize)]
pub struct MachineExportFile {
    pub version: u32,
    pub machines: Vec<MachineIo>,
}

fn load_all() -> Vec<GlobalMachine> {
    storage::read_json(&global_machines_path()).unwrap_or_default()
}

/// Resolve one registered global machine by its stable UI id. Kept here so
/// commands that act on a project-free host (agent installation, monitoring)
/// never trust a frontend-supplied SSH address when the registry already owns
/// the target identity.
pub(crate) fn find_by_id(id: &str) -> Option<GlobalMachine> {
    load_all().into_iter().find(|machine| machine.id == id)
}

fn save_all(list: &[GlobalMachine]) -> Result<(), String> {
    storage::write_json(&global_machines_path(), &list.to_vec()).map_err(|e| e.to_string())
}

/// Every globally connected machine, for the header's Machines indicator.
#[tauri::command]
pub fn global_machines_list() -> Vec<GlobalMachine> {
    load_all()
}

/// Register a machine in the global list. The CALLER has already authenticated
/// it via `ssh_connect` — this command does no auth of its own, it only
/// persists the identity (mirrors how `RemoteMachinesWindow` already separates
/// "log in" from "add" for a project worker).
#[tauri::command]
pub fn global_machine_add(
    user: Option<String>,
    host: String,
    port: Option<u16>,
    label: Option<String>,
) -> Result<GlobalMachine, String> {
    let host = host.trim().to_string();
    if host.is_empty() {
        return Err("host must not be empty".to_string());
    }
    crate::services::ssh_common::validate_arg("host", &host)?;
    let user = user.map(|u| u.trim().to_string()).filter(|u| !u.is_empty());
    if let Some(u) = &user {
        crate::services::ssh_common::validate_arg("user", u)?;
    }
    let label = label
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty());
    let mut list = load_all();
    // Idempotent by target: a machine *is* its `(user, host, port)` identity, so a
    // second registration of the same host — the HPC-wizard login surfacing a
    // cluster the user may already have added by hand, or a repeat wizard run —
    // returns the existing row rather than stacking a duplicate. The caller has
    // just authenticated the same target, so nothing new needs persisting.
    if let Some(existing) = list
        .iter()
        .find(|m| m.user == user && m.host == host && m.port == port)
    {
        return Ok(existing.clone());
    }
    let machine = GlobalMachine {
        id: crate::commands::projects::uuid_v4(),
        user,
        host,
        port,
        label,
        auto_connect: None,
    };
    list.push(machine.clone());
    save_all(&list)?;
    Ok(machine)
}

/// Edit an existing machine's connection identity — `user`/`host`/`port`/`label`.
/// **Only the identity**: the SSH password is never held here (it lives in the OS
/// keychain, keyed by host target), so a password change is applied by the caller
/// re-running `ssh_connect` with the new target, not by this command. Validates
/// host/user exactly as [`global_machine_add`], and refuses a change that would
/// collide the machine onto another row's `(user, host, port)` target (which
/// `global_machine_add`'s idempotency would otherwise silently merge). Returns the
/// full updated list, like [`global_machine_remove`]/[`global_machine_reorder`].
///
/// Note the keychain consequence of changing the target: the saved password (if
/// any) was stored under the *old* `ssh_account` key and does not follow the
/// machine to a new user/host/port. The caller re-authenticates the new target.
#[tauri::command]
pub fn global_machine_update(
    id: String,
    user: Option<String>,
    host: String,
    port: Option<u16>,
    label: Option<String>,
) -> Result<Vec<GlobalMachine>, String> {
    let host = host.trim().to_string();
    if host.is_empty() {
        return Err("host must not be empty".to_string());
    }
    crate::services::ssh_common::validate_arg("host", &host)?;
    let user = user.map(|u| u.trim().to_string()).filter(|u| !u.is_empty());
    if let Some(u) = &user {
        crate::services::ssh_common::validate_arg("user", u)?;
    }
    let label = label
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty());
    let mut list = load_all();
    if !list.iter().any(|m| m.id == id) {
        return Err("machine not found".to_string());
    }
    // A machine *is* its `(user, host, port)` identity — refuse to point two rows
    // at the same target (rather than silently fold them, which `global_machine_add`
    // would do on a re-add but is surprising as the result of an edit).
    if list
        .iter()
        .any(|m| m.id != id && m.user == user && m.host == host && m.port == port)
    {
        return Err("another machine already uses that address".to_string());
    }
    for m in list.iter_mut() {
        if m.id == id {
            m.user = user.clone();
            m.host = host.clone();
            m.port = port;
            m.label = label.clone();
        }
    }
    save_all(&list)?;
    Ok(list)
}

/// Arm (or disarm) a machine for silent auto-connect on launch / VPN-up. Stores
/// `Some(true)` when enabled and drops the field entirely when disabled, so a
/// disarmed machine looks exactly like one from before the field existed. The
/// promise is kept on the *frontend* auto path (it probes before it connects, so
/// it never prompts); this only persists the opt-in.
#[tauri::command]
pub fn global_machine_set_auto_connect(
    id: String,
    enabled: bool,
) -> Result<Vec<GlobalMachine>, String> {
    let mut list = load_all();
    for m in list.iter_mut() {
        if m.id == id {
            m.auto_connect = if enabled { Some(true) } else { None };
        }
    }
    save_all(&list)?;
    Ok(list)
}

/// Drop a machine from the global list. Never touches the OS keychain — the
/// saved SSH credential (if any) is keyed by host identity
/// (`remote_credentials::ssh_account`), shared with any project that reaches
/// the same target, not by this registry. Never touches any project's
/// `compute_hosts` either: a `ComputeHost` is a value copy of the connection
/// info made at drop time, not a reference back here.
#[tauri::command]
pub fn global_machine_remove(id: String) -> Result<Vec<GlobalMachine>, String> {
    let mut list = load_all();
    list.retain(|m| m.id != id);
    save_all(&list)?;
    Ok(list)
}

/// Persist a new display order for the global machines list — the frontend
/// (drag-and-drop in `MachinesIndicator`) computes the reordered id sequence
/// client-side (splice, mirrors `stores::projects`' `reorderProjects`) and this
/// only rewrites the file to match it. There's no separate position field:
/// array order in `global_machines.json` **is** the order. Any id missing from
/// `ids` (a stale snapshot racing a concurrent add/remove) keeps its original
/// relative place, appended after the given ones, so a reorder can never
/// silently drop a machine.
#[tauri::command]
pub fn global_machine_reorder(ids: Vec<String>) -> Result<Vec<GlobalMachine>, String> {
    let list = load_all();
    let mut reordered: Vec<GlobalMachine> = ids
        .iter()
        .filter_map(|id| list.iter().find(|m| &m.id == id).cloned())
        .collect();
    for m in &list {
        if !reordered.iter().any(|r| r.id == m.id) {
            reordered.push(m.clone());
        }
    }
    save_all(&reordered)?;
    Ok(reordered)
}

/// Write the selected machines to a shareable JSON file at `path`. `ids` is the
/// caller's selection **in display order**; the file preserves that order. Only
/// host/port/label cross — never the username (so the file works for whoever
/// imports it) and never a password (secrets live in the OS keychain, keyed by
/// host, and are never serialized). The path comes from a native save dialog on
/// the frontend, so it can be anywhere the user chose.
#[tauri::command]
pub fn global_machines_export(ids: Vec<String>, path: String) -> Result<(), String> {
    let list = load_all();
    let by_id: std::collections::HashMap<&str, &GlobalMachine> =
        list.iter().map(|m| (m.id.as_str(), m)).collect();
    let machines: Vec<MachineIo> = ids
        .iter()
        .filter_map(|id| by_id.get(id.as_str()).copied())
        .map(|m| MachineIo {
            host: m.host.clone(),
            port: m.port,
            label: m.label.clone(),
            user: None, // deliberately dropped — see `MachineIo`.
        })
        .collect();
    if machines.is_empty() {
        return Err("no machines selected to export".to_string());
    }
    let file = MachineExportFile {
        version: 1,
        machines,
    };
    let json = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| format!("failed to write {path}: {e}"))?;
    Ok(())
}

/// Read and validate a machines file at `path`, returning the importable entries
/// **without** connecting or persisting anything — the frontend previews them,
/// collects one shared username + password, then connects+adds each via the
/// ordinary `ssh_connect` + `global_machine_add` pair (so status lamps and the
/// idempotent-by-target de-dup both apply). Accepts either the
/// [`MachineExportFile`] wrapper Tabtivity writes or a bare `[MachineIo]` array.
/// Entries are trimmed; those with an empty or shell-unsafe host/user are dropped
/// (the same `validate_arg` gate `global_machine_add` applies), so a malformed
/// file yields fewer rows rather than an unsafe add later.
#[tauri::command]
pub fn global_machines_import_read(path: String) -> Result<Vec<MachineIo>, String> {
    let content =
        std::fs::read_to_string(&path).map_err(|e| format!("failed to read {path}: {e}"))?;
    let raw = match serde_json::from_str::<MachineExportFile>(&content) {
        Ok(f) => f.machines,
        // Fall back to a bare array (a hand-written file) before giving up.
        Err(_) => serde_json::from_str::<Vec<MachineIo>>(&content).map_err(|_| {
            "not a machines export file (expected {version, machines} or a JSON array)".to_string()
        })?,
    };
    let mut out = Vec::new();
    for m in raw {
        let host = m.host.trim().to_string();
        if host.is_empty() || crate::services::ssh_common::validate_arg("host", &host).is_err() {
            continue;
        }
        let user = m
            .user
            .map(|u| u.trim().to_string())
            .filter(|u| !u.is_empty());
        if let Some(u) = &user {
            if crate::services::ssh_common::validate_arg("user", u).is_err() {
                continue;
            }
        }
        // The label is the string this machine is *picked by* in the hub's list,
        // and it is the one imported field with no `validate_arg` behind it —
        // nothing downstream execs it, so refusing the row would be the wrong
        // trade. It is still attacker-chosen display text from a shared file, so
        // it gets the treatment mail and browser titles get: bidi overrides and
        // zero-width characters removed, so a label cannot render as one machine
        // while sitting beside another's address.
        let label = m
            .label
            .map(|l| crate::services::web_safety::strip_format_controls(l.trim()))
            .filter(|l| !l.is_empty());
        out.push(MachineIo {
            host,
            port: m.port,
            label,
            user,
        });
    }
    if out.is_empty() {
        return Err("no valid machines found in file".to_string());
    }
    Ok(out)
}

/// Full system-monitor snapshot for one global machine — the header's Machines
/// menu opens `GlobalMachineMonitorDialog` (`components/monitoring/
/// SystemMonitorPane` in its ad-hoc `globalMachine` mode) on this, in place of
/// the old small per-row usage bar. The direct analog of
/// `commands::monitor::system_monitor_snapshot` for a project-free host: a
/// global machine has no `project_id` to resolve through
/// `remote_target_for_host`, so this authenticates **ad-hoc** instead —
/// `run_ssh_auth`'s saved-password/key-agent branching (the same one
/// `ssh_connect`/`ssh_probe` use), no pooled ControlMaster — then runs the same
/// whole-`/proc` `REMOTE_SNAPSHOT_SCRIPT` / `parse_remote_snapshot` pair
/// `system_monitor_snapshot` uses for a project's remote host, so the two
/// surfaces read identically field-for-field. One SSH round trip, heavier than
/// a pooled poll, so the frontend should only sample this while the dialog is
/// open.
#[tauri::command]
pub async fn global_machine_monitor_snapshot(
    user: Option<String>,
    host: String,
    port: Option<u16>,
    careful: Option<bool>,
    background: Option<bool>,
) -> Result<crate::sysstat::SystemSnapshot, String> {
    tokio::task::spawn_blocking(move || {
        use crate::services::remote_credentials as creds;
        // `background` per `ssh_common`'s second shape: opening the monitor is a
        // gesture, its repeat poll is not, and both land here.
        let _dial = crate::services::ssh_common::declared_dial(background, &user, &host, port);
        let account = creds::ssh_account(&user, &host, port);
        let password = creds::get(&account);
        // `careful` is the machine's stored mode (careful by default for every
        // remote machine, normal where the user said this one is theirs), keyed
        // by the same SSH target this command already is — see
        // `commands::monitor::system_monitor_snapshot`. With no answer to pass,
        // fall back to what earlier probes of this target found; the host's own
        // SLURM check covers a first sample either way.
        let key = crate::services::ssh_common::target_key(user.as_deref(), &host, port);
        let mode =
            careful.or_else(|| crate::services::hpc_mode::is_known_careful(&key).then_some(true));
        let script = crate::sysstat::remote_snapshot_script(mode);
        let stdout = crate::commands::ssh::run_ssh_auth(
            &user,
            &host,
            port,
            password.as_deref(),
            &[&script],
        )?;
        if stdout.trim().is_empty() {
            return Err("system monitor probe returned no output".to_string());
        }
        let snap = crate::sysstat::parse_remote_snapshot(&stdout);
        crate::services::hpc_mode::remember(&key, snap.careful);
        Ok(snap)
    })
    .await
    .map_err(|e| format!("system monitor probe task failed: {e}"))?
}

/// The tmux sessions running on one global machine — the "is someone actually
/// working here?" probe behind the **busy** (pulsing green) lamp in the header
/// Machines menu, the project pill and the Remote-machines hub. A connected lamp
/// only says the host authenticates; this says a run is alive on it.
///
/// The project-scoped twin is `commands::remote::remote_tmux_list`, which
/// resolves a `project_id`/`host_id` and rides that project's pooled
/// ControlMaster. A global machine has no project to resolve through, so this
/// authenticates **ad-hoc** via `run_ssh_auth` — exactly as
/// `global_machine_monitor_snapshot` and `global_machine_usage_check` do — and
/// then runs the *same* `tmux_ls_script` through the *same* `parse_tmux_ls`, so
/// a global machine's busy state and a project host's are the same reading.
///
/// An absent tmux, or a host with no server running, yields an **empty** list
/// rather than an error (`tmux_ls_script` ends in `|| true`): "no sessions" and
/// "no tmux" both mean *not busy*, and neither should redden a lamp.
///
/// One SSH round trip per call, so the frontend fires it only while the menu or
/// hub that shows the lamp is open — never on a background poll.
#[tauri::command]
pub async fn global_machine_tmux_list(
    user: Option<String>,
    host: String,
    port: Option<u16>,
    background: Option<bool>,
) -> Result<Vec<crate::services::ssh_exec::TmuxSession>, String> {
    tokio::task::spawn_blocking(move || {
        use crate::services::remote_credentials as creds;
        // `background` per `ssh_common`'s second shape. The doc above already
        // says this fires "only while the menu is open" — but a menu that opens
        // on hover is not a decision, so the sweep behind it is background and
        // only a row the user acted on passes `Some(false)`.
        let _dial = crate::services::ssh_common::declared_dial(background, &user, &host, port);
        let account = creds::ssh_account(&user, &host, port);
        let password = creds::get(&account);
        let stdout = crate::commands::ssh::run_ssh_auth(
            &user,
            &host,
            port,
            password.as_deref(),
            &[crate::services::ssh_exec::tmux_ls_script()],
        )?;
        Ok(crate::services::ssh_exec::parse_tmux_ls(&stdout))
    })
    .await
    .map_err(|e| format!("tmux probe task failed: {e}"))?
}

/// Usage report (who's logged in, CPU/load/memory/GPU, top processes) for one
/// global machine — what the header Machines menu's on-demand "Remote host
/// usage…" dialog shows for every machine in the list, in list order.
///
/// The project-scoped twin is `commands::remote::remote_usage_check`, which
/// resolves a `project_id`/`host_id` to a spec and rides that project's pooled
/// ControlMaster. A global machine has no project to resolve through and pools
/// nothing, so this authenticates **ad-hoc** via `run_ssh_auth`'s saved-password
/// /key-agent branching — exactly as `global_machine_monitor_snapshot` does —
/// and then runs the *same* `remote_usage::probe_script` through the *same*
/// `parse_report`, so a global machine's section and a project host's section of
/// that dialog read identically field-for-field.
///
/// One SSH round trip per call, so the frontend only fires it when the dialog is
/// opened or its "Recheck" is pressed — never on a poll.
#[tauri::command]
pub async fn global_machine_usage_check(
    user: Option<String>,
    host: String,
    port: Option<u16>,
    background: Option<bool>,
) -> Result<crate::services::remote_usage::RemoteUsageReport, String> {
    tokio::task::spawn_blocking(move || {
        use crate::services::remote_credentials as creds;
        // `background` per `ssh_common`'s second shape — the project-scoped twin
        // `remote::remote_usage_check` takes the same parameter with the same
        // polarity, since the one dialog drives both.
        let _dial = crate::services::ssh_common::declared_dial(background, &user, &host, port);
        let account = creds::ssh_account(&user, &host, port);
        let password = creds::get(&account);
        let script = crate::services::remote_usage::probe_script();
        let stdout = crate::commands::ssh::run_ssh_auth(
            &user,
            &host,
            port,
            password.as_deref(),
            &[script.as_str()],
        )?;
        if stdout.trim().is_empty() {
            return Err("usage probe returned no output".to_string());
        }
        Ok(crate::services::remote_usage::parse_report(&stdout))
    })
    .await
    .map_err(|e| format!("usage probe task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(dir: &tempfile::TempDir, name: &str, content: &str) -> String {
        let path = dir.path().join(name);
        std::fs::write(&path, content).unwrap();
        path.to_string_lossy().into_owned()
    }

    /// The export shape: a versioned wrapper whose rows carry host/port/label
    /// and, on the way out, never a username; import accepts the wrapper and
    /// a bare array alike, in file order.
    #[test]
    fn import_reads_the_versioned_wrapper_and_a_bare_array_in_order() {
        let dir = tempfile::tempdir().unwrap();
        let wrapped = file(
            &dir,
            "machines.json",
            r#"{"version":1,"machines":[{"host":"b.example","label":"B"},{"host":"a.example","port":2222}]}"#,
        );
        let rows = global_machines_import_read(wrapped).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].host, "b.example");
        assert_eq!(rows[0].label.as_deref(), Some("B"));
        assert_eq!(rows[1].port, Some(2222));
        assert!(rows[1].user.is_none());

        let bare = file(&dir, "bare.json", r#"[{"host":"c.example","user":"me"}]"#);
        let rows = global_machines_import_read(bare).unwrap();
        assert_eq!(rows[0].user.as_deref(), Some("me"));
    }

    /// Rows are trimmed, and a row whose host or user would be unsafe as an
    /// ssh argument is dropped rather than carried to a later add.
    #[test]
    fn import_trims_rows_and_drops_unsafe_hosts_and_users() {
        let dir = tempfile::tempdir().unwrap();
        let path = file(
            &dir,
            "m.json",
            "[{\"host\":\"  ok.example  \",\"user\":\"  \"},\
              {\"host\":\"-oProxyCommand=evil\"},\
              {\"host\":\"ctl\\u0007.example\"},\
              {\"host\":\"fine.example\",\"user\":\"-bad\"},\
              {\"host\":\"\"},\
              {\"host\":\"last.example\",\"user\":\" root \"}]",
        );
        let rows = global_machines_import_read(path).unwrap();
        let hosts: Vec<&str> = rows.iter().map(|r| r.host.as_str()).collect();
        assert_eq!(hosts, vec!["ok.example", "last.example"]);
        assert!(rows[0].user.is_none(), "a blank user is dropped, not kept as spaces");
        assert_eq!(rows[1].user.as_deref(), Some("root"));
    }

    /// The label is display text from a shared file: bidi overrides and
    /// zero-width characters are stripped instead of refusing the row, and a
    /// label that was nothing but controls is dropped.
    #[test]
    fn import_strips_format_controls_from_labels_instead_of_refusing_the_row() {
        let dir = tempfile::tempdir().unwrap();
        let path = file(
            &dir,
            "m.json",
            "[{\"host\":\"a.example\",\"label\":\"\\u202egpu\\u200b-2\"},\
              {\"host\":\"b.example\",\"label\":\"\\u200b\\u200b\"}]",
        );
        let rows = global_machines_import_read(path).unwrap();
        assert_eq!(rows[0].label.as_deref(), Some("gpu-2"));
        assert!(rows[1].label.is_none());
    }

    /// A file that parses but yields nothing usable, and one that is not a
    /// machines file at all, each fail with their own message.
    #[test]
    fn import_distinguishes_no_valid_rows_from_not_a_machines_file() {
        let dir = tempfile::tempdir().unwrap();
        let empty = file(&dir, "empty.json", r#"{"version":1,"machines":[{"host":"-x"}]}"#);
        assert_eq!(
            global_machines_import_read(empty).unwrap_err(),
            "no valid machines found in file"
        );
        let garbage = file(&dir, "garbage.json", r#"{"hosts":["a"]}"#);
        assert!(global_machines_import_read(garbage).unwrap_err().starts_with("not a machines export file"));
        let missing = dir.path().join("nope.json").to_string_lossy().into_owned();
        assert!(global_machines_import_read(missing).unwrap_err().starts_with("failed to read"));
    }

    /// An exported row omits every absent field — and `user` is `None` on the
    /// way out by construction, so a file Tabtivity wrote never names a login.
    #[test]
    fn machine_io_omits_absent_fields_on_export() {
        let row = MachineIo {
            host: "h.example".into(),
            port: None,
            label: Some("H".into()),
            user: None,
        };
        assert_eq!(
            serde_json::to_value(&row).unwrap(),
            serde_json::json!({"host":"h.example","label":"H"})
        );
        let export = MachineExportFile {
            version: 1,
            machines: vec![row],
        };
        let back: MachineExportFile =
            serde_json::from_str(&serde_json::to_string(&export).unwrap()).unwrap();
        assert_eq!(back.version, 1);
        assert_eq!(back.machines[0].host, "h.example");
        assert!(back.machines[0].user.is_none());
    }
}
