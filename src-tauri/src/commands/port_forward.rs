//! Port forwards for a remote tab's local servers (`services::port_forward`,
//! `docs/localhost_viewer_plan.md`).
//!
//! Desktop window only: each command is `Off` in server mode, since a forward
//! binds the *daemon's* loopback, not the browser user's, and there is no phone
//! route at all (a raw port never crosses `mobile_control`). The renderer
//! names a project, a host id, a tab and the remote end; the ssh target comes
//! from `projects.json` through `remote_target_for_host`, the control socket
//! from `ssh -G`, and the local end is always `127.0.0.1` on a port picked
//! here.

use crate::services::port_forward::{self, ForwardRow, Opened, PortForwardError};
use crate::services::remote::{self, RemotePoolState, PRIMARY_HOST};
use crate::tauri_host::Ctx;

/// Forward `remote_host:remote_port` of a remote project's host to this
/// machine's loopback and answer with the local port. Never dials: the
/// project's host must be connected (`not-connected` otherwise). `tab_uid` is
/// the PTY id of the tab that printed the URL (`TerminalView`'s `id`), or the
/// window's own marker for a forward the user typed in; the forward ends with
/// it.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn port_forward_open(
    ctx: Ctx,
    project_id: String,
    host_id: Option<String>,
    tab_uid: String,
    remote_host: String,
    remote_port: u16,
) -> Result<Opened, String> {
    let host_id = host_id.filter(|h| !h.is_empty()).unwrap_or_else(|| PRIMARY_HOST.to_string());
    if !port_forward::SUPPORTED {
        return Err(PortForwardError::UnsupportedOs.wire());
    }
    // Gate on connected before anything spawns (a dead session freezes the window).
    let pool = ctx.get::<RemotePoolState>();
    if !remote::is_connected_host(pool, &project_id, &host_id).await {
        return Err(PortForwardError::NotConnected.wire());
    }
    app_core::rt::blocking("port-forward", move || {
        open_blocking(&project_id, &host_id, &tab_uid, &remote_host, remote_port)
    })
    .await?
}

/// The `ssh` half of [`port_forward_open`]: the spec is resolved here, from the
/// project id, never taken from the caller.
fn open_blocking(
    project_id: &str,
    host_id: &str,
    tab_uid: &str,
    remote_host: &str,
    remote_port: u16,
) -> Result<Opened, String> {
    if crate::storage::is_reserved_scope(project_id) || tab_uid.trim().is_empty() {
        return Err(PortForwardError::NotRemote.wire());
    }
    let target = remote::remote_target_for_host(project_id, host_id).ok_or_else(|| PortForwardError::NotRemote.wire())?;
    let control_path =
        crate::services::ssh_exec::resolve_control_path(&target.spec).ok_or_else(|| PortForwardError::NotConnected.wire())?;
    port_forward::open(&target.spec, control_path, project_id, host_id, tab_uid, remote_host, remote_port)
        .map_err(|e| e.wire())
}

/// Every active forward: host label, remote end, local port. No paths, no tokens.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn port_forward_list() -> Result<Vec<ForwardRow>, String> {
    Ok(port_forward::list())
}

/// Stop one forward by the id `port_forward_list` gave. Whether it was still there.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn port_forward_close(id: String) -> Result<bool, String> {
    app_core::rt::blocking("port-forward", move || port_forward::close_id(&id)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The lib's `RunEvent::Exit` arm, the part that tears things down.
    fn exit_arm() -> String {
        let lib = include_str!("../lib.rs");
        let at = lib.find("if let tauri::RunEvent::Exit = event").expect("the Exit arm");
        lib[at..].to_string()
    }

    #[test]
    fn the_exit_teardown_cancels_every_forward_before_the_connections_go() {
        let arm = exit_arm();
        let close = arm.find("services::port_forward::close_all()").expect("Exit must call port_forward::close_all");
        // `ssh -O cancel` needs the master alive: it runs before the pool teardown.
        let pool = arm.find("services::remote::disconnect_all").expect("the pool teardown");
        assert!(close < pool, "close_all must come before the pooled connections are torn down");
    }

    #[test]
    fn a_tabs_end_and_a_masters_teardown_close_their_forwards() {
        let terminal = include_str!("../terminal/mod.rs");
        assert!(
            terminal.matches("services::port_forward::close_for_tab(&id)").count() >= 2,
            "both the explicit kill and the child's own exit must close the tab's forwards"
        );
        let remote = include_str!("../services/remote.rs");
        assert!(remote.contains("port_forward::close_for_master"), "a master's teardown closes its forwards");
    }

    #[test]
    fn the_commands_take_no_spec_bind_address_or_control_path_from_the_renderer() {
        let src = include_str!("port_forward.rs");
        let open = &src[src.find("pub async fn port_forward_open").unwrap()..];
        let signature = &open[..open.find(") -> Result").unwrap()];
        for forbidden in ["spec", "bind", "control", "RemoteSpec", "path", "AppHandle"] {
            assert!(!signature.contains(forbidden), "port_forward_open takes {forbidden}");
        }
    }

    #[test]
    fn the_commands_are_off_in_server_mode() {
        use crate::services::command_class::{class_of, CommandClass};
        for name in ["port_forward_open", "port_forward_list", "port_forward_close"] {
            assert!(matches!(class_of(name), Some(CommandClass::Off(_))), "{name} must be Off");
        }
    }

    #[test]
    fn a_reserved_scope_and_an_unknown_project_are_refused_before_ssh() {
        for project in ["root", "assistant", "no-such-project"] {
            let err = open_blocking(project, "primary", "tab", "localhost", 8888).unwrap_err();
            assert_eq!(err, "port-forward:not-remote", "{project}");
        }
    }
}
