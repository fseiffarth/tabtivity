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
