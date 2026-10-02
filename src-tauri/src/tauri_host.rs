//! The desktop app as a host of `app_core` (docs/tabtivity_hosted_plan.md
//! §3.2): Tauri's event system as the core's [`EventSink`], and a [`CoreCtx`]
//! every command can take as an argument in place of `AppHandle` / `State` /
//! `Window`.
//!
//! Converted command bodies and services see only the core types. This module
//! is the one place that knows a client is a Tauri window and an event is a
//! Tauri event.

use std::ops::Deref;
use std::sync::Arc;

use app_core::{Caller, ClientId, CoreCtx, CoreState, EventSink};
use tauri::ipc::{CommandArg, CommandItem, InvokeError};
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// Tauri as an event sink. `emit` reaches every webview (Tauri's own
/// semantics: each listener, whatever its target); `emit_to` reaches the
/// window whose label is the client id. The payload is already JSON, so
/// `emit_str` forwards it without a second serialization.
pub struct TauriEvents(AppHandle);

impl EventSink for TauriEvents {
    fn emit_json(&self, event: &str, payload: String) {
        let _ = self.0.emit_str(event, payload);
    }

    fn emit_json_to(&self, client: &ClientId, event: &str, payload: String) {
        let _ = self.0.emit_str_to(client.as_str(), event, payload);
    }
}

/// Build the desktop's system context from the managed singletons and make
/// Tauri hold it: every command extracts its own [`Ctx`] from it, and code
/// that still has an `AppHandle` reaches it through [`system_ctx`]. Also
/// points the core's runtime seam at Tauri's runtime, so `rt::spawn` from any
/// thread lands where `tauri::async_runtime::spawn` would.
pub fn install(app: &AppHandle, state: CoreState) -> CoreCtx {
    app_core::rt::install(tauri::async_runtime::handle().inner().clone());
    let events: Arc<dyn EventSink> = Arc::new(TauriEvents(app.clone()));
    let ctx = CoreCtx::system(Arc::new(state), events);
    app.manage(ctx.clone());
    ctx
}

/// The system context (caller `System`) for code that holds an `AppHandle`:
/// `lib.rs` hooks, and commands not yet converted that call into converted
/// services. Panics before [`install`] ran, like any `State` read would.
pub fn system_ctx(app: &AppHandle) -> CoreCtx {
    app.state::<CoreCtx>().inner().clone()
}

/// [`CoreCtx`] as a `#[tauri::command]` argument: the system context with the
/// calling window as [`Caller::Local`]. A newtype because the orphan rule
/// forbids implementing Tauri's `CommandArg` for the core's type here; it
/// derefs, so a body reads `ctx.state`, `ctx.emit(…)` as if it held the core
/// type, and a body that moves to the core takes `ctx.0`.
///
/// The window label is taken from the CALLING webview, never from the
/// payload — the rule `pty_set_visible` and `webview_renderer_claim` rely on.
pub struct Ctx(pub CoreCtx);

impl Deref for Ctx {
    type Target = CoreCtx;

    fn deref(&self) -> &CoreCtx {
        &self.0
    }
}

impl<'de, R: Runtime> CommandArg<'de, R> for Ctx {
    fn from_command(command: CommandItem<'de, R>) -> Result<Self, InvokeError> {
        let webview = command.message.webview();
        let system = webview.state::<CoreCtx>();
        Ok(Ctx(system.with_caller(Caller::Local(ClientId::new(webview.label())))))
    }
}

/// The `commands/*.rs` files whose bodies are Tauri-free: nothing of `tauri`
/// but the `#[tauri::command]` attribute itself, so each takes [`Ctx`] (or
/// nothing) and can be dispatched by a host that is not Tauri. Grows one file
/// per conversion (hosted plan §3.2); `converted_command_files_stay_tauri_free`
/// keeps a converted file from sliding back.
pub const CONVERTED_COMMAND_FILES: &[&str] = &[
    "agent_prompts.rs",
    "agent_tasks.rs",
    "boxes.rs",
    "brand_migration.rs",
    "caldav.rs",
    "calendar.rs",
    "crash.rs",
    "credentials.rs",
    "default_apps.rs",
    "disk_usage.rs",
    "exec_trust.rs",
    "format.rs",
    "fs_watch.rs",
    "git.rs",
    "git_fork.rs",
    "git_hosting.rs",
    "git_peer.rs",
    "git_publish.rs",
    "git_pull.rs",
    "global_machines.rs",
    "hpc_ws.rs",
    "local_loss.rs",
    "markdown.rs",
    "monitor.rs",
    "net_usage.rs",
    "network.rs",
    "power.rs",
    "project_runtime.rs",
    "projects.rs",
    "python.rs",
    "remote.rs",
    "search.rs",
    "settings.rs",
    "sheets.rs",
    "skills.rs",
    "slurm.rs",
    "sqlite.rs",
    "ssh.rs",
    "sync.rs",
    "synctex.rs",
    "terminal.rs",
    "timer.rs",
    "usage_stats.rs",
];

#[cfg(test)]
mod tests {
    use super::CONVERTED_COMMAND_FILES;

    /// Every line of a converted file that is not a comment and not the
    /// `#[tauri::command]` attribute must be free of the word `tauri` — the
    /// `use tauri::…` line is what every `State`, `AppHandle` or `Window`
    /// parameter needs, so its absence is the whole check. (`src-tauri` in a
    /// path string does not count.)
    #[test]
    fn converted_command_files_stay_tauri_free() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/commands");
        let mut offenders = Vec::new();
        for file in CONVERTED_COMMAND_FILES {
            let text = std::fs::read_to_string(dir.join(file))
                .unwrap_or_else(|e| panic!("{file}: {e}"));
            for (n, line) in text.lines().enumerate() {
                let code = match line.find("//") {
                    Some(i) if !line.contains("://") => &line[..i],
                    _ => line,
                };
                let trimmed = code.trim();
                if trimmed.starts_with("#[tauri::command") {
                    continue;
                }
                let names_tauri = code.match_indices("tauri").any(|(i, _)| {
                    let before = code[..i].chars().next_back();
                    let after = code[i + 5..].chars().next();
                    !before.is_some_and(|c| c.is_alphanumeric() || c == '_' || c == '-')
                        && !after.is_some_and(|c| c.is_alphanumeric() || c == '_')
                });
                if names_tauri {
                    offenders.push(format!("{file}:{}: {}", n + 1, line.trim()));
                }
            }
        }
        assert!(
            offenders.is_empty(),
            "converted command files reach for Tauri again:\n{}",
            offenders.join("\n")
        );
    }

    #[test]
    fn converted_list_has_no_duplicates_and_names_real_files() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/commands");
        let mut seen = std::collections::HashSet::new();
        for file in CONVERTED_COMMAND_FILES {
            assert!(seen.insert(*file), "{file} listed twice");
            assert!(dir.join(file).is_file(), "{file} is not a command file");
        }
    }
}
