//! Connect to a server (hosted plan §7.2, P5), the window half: pair this
//! desktop with a Tabtivity server, open its **Connect** window, and bridge
//! that window's transport to the server's desktop socket
//! (`services::connect` holds the protocol; this module the window, the
//! socket tasks and the events).
//!
//! * The Connect window (label [`WINDOW`]) loads the app's own `index.html`
//!   with `?connect=1` — this binary's frontend, never code from the server —
//!   in a webview profile of its own (`<state>/connect/webview`) so its
//!   storage never mixes with the standalone workspace's.
//! * Every bridge command answers only that window: a socket opened for it
//!   emits its frames to it alone, on an event name the window chose before
//!   asking (so no frame is sent before it listens).
//! * Text frames pass as they are; binary frames as base64.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tokio_tungstenite::tungstenite::Message;

use crate::services::connect::{self, Paired};

/// The Connect window's label (and its webview's).
pub const WINDOW: &str = "connect";

#[derive(Default)]
pub struct ConnectBridge {
    next: AtomicU64,
    sockets: Mutex<HashMap<u64, tokio::sync::mpsc::UnboundedSender<Message>>>,
}

pub type ConnectBridgeState = Arc<ConnectBridge>;

impl ConnectBridge {
    /// Close every bridged socket: the window that owned them is gone or
    /// loading afresh. Its frames would otherwise go on arriving for nobody
    /// (an event to a missing window is no error), and the server would keep
    /// serving a client that no longer exists.
    pub fn close_all(&self) {
        for (_, sender) in self.sockets.lock().unwrap_or_else(PoisonError::into_inner).drain() {
            let _ = sender.send(Message::Close(None));
        }
    }
}

#[derive(Clone, Serialize)]
struct Frame {
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    binary: Option<String>,
}

fn only_connect(window: &tauri::Window) -> Result<(), String> {
    if window.label() == WINDOW {
        Ok(())
    } else {
        Err("only the Connect window talks to the server".into())
    }
}

/// An event name the window chose for its socket's frames.
fn valid_event(name: &str) -> bool {
    name.strip_prefix("connect-frame-").is_some_and(|rest| (1..=32).contains(&rest.len()) && rest.bytes().all(|b| b.is_ascii_alphanumeric()))
}

#[tauri::command]
pub fn connect_status() -> Option<Paired> {
    connect::paired_in(&crate::storage::state_dir())
}

#[tauri::command]
pub async fn connect_pair(origin: String, code: String, device_name: String) -> Result<Paired, String> {
    connect::pair_in(&crate::storage::state_dir(), &origin, &code, &device_name).await
}

#[tauri::command]
pub fn connect_forget(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(WINDOW) {
        let _ = window.close();
    }
    connect::forget_in(&crate::storage::state_dir())
}

/// Open (or focus) the Connect window for the paired server.
#[tauri::command]
pub fn connect_open(app: AppHandle) -> Result<(), String> {
    let state_dir = crate::storage::state_dir();
    let paired = connect::paired_in(&state_dir).ok_or("this computer is not paired with a server")?;
    if let Some(window) = app.get_webview_window(WINDOW) {
        let _ = window.set_focus();
        return Ok(());
    }
    let host = paired.origin.split_once("://").map(|(_, h)| h.to_string()).unwrap_or_default();
    let bridge = app.state::<ConnectBridgeState>().inner().clone();
    let reloaded = bridge.clone();
    #[allow(unused_mut)]
    let mut builder = WebviewWindowBuilder::new(&app, WINDOW, WebviewUrl::App("index.html?connect=1".into()))
        .title(format!("{} — {host}", crate::app_name!()))
        .inner_size(1280.0, 820.0)
        .decorations(true)
        // A reload starts the frontend afresh: the sockets the old page
        // opened are nobody's now.
        .on_page_load(move |_, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
                reloaded.close_all();
            }
        });
    // A profile of its own: the server's frontend state (local storage,
    // IndexedDB) never mixes with the standalone workspace's.
    #[cfg(any(target_os = "linux", target_os = "windows"))]
    {
        builder = builder.data_directory(connect::dir_in(&state_dir).join("webview"));
    }
    let window = builder.build().map_err(|e| format!("open the Connect window: {e}"))?;
    // The crash reporter hooks the windows that exist at setup only.
    crate::hook_webview_crash_reporter(&window);
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            bridge.close_all();
        }
    });
    Ok(())
}

/// Sign in and open the server's desktop socket for the Connect window; its
/// frames are emitted to that window as `event`.
#[tauri::command]
pub async fn connect_ws_open(app: AppHandle, window: tauri::Window, bridge: tauri::State<'_, ConnectBridgeState>, event: String, resume: Option<String>) -> Result<u64, String> {
    only_connect(&window)?;
    if !valid_event(&event) {
        return Err("bad event name".into());
    }
    let state_dir = crate::storage::state_dir();
    let session = connect::sign_in(&state_dir).await?;
    let socket = connect::open_socket(&session, resume.as_deref()).await?;
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Message>();
    let bridge = bridge.inner().clone();
    let id = bridge.next.fetch_add(1, Ordering::Relaxed) + 1;
    bridge.sockets.lock().unwrap_or_else(PoisonError::into_inner).insert(id, tx);
    tauri::async_runtime::spawn(async move {
        while let Some(message) = rx.recv().await {
            let closing = matches!(message, Message::Close(_));
            if sink.send(message).await.is_err() || closing {
                break;
            }
        }
        let _ = sink.close().await;
    });
    let target = tauri::EventTarget::webview_window(WINDOW);
    tauri::async_runtime::spawn(async move {
        while let Some(Ok(message)) = stream.next().await {
            let frame = match message {
                Message::Text(text) => Frame { kind: "text", text: Some(text.to_string()), binary: None },
                Message::Binary(bytes) => Frame { kind: "binary", text: None, binary: Some(base64::engine::general_purpose::STANDARD.encode(&bytes)) },
                Message::Close(_) => break,
                _ => continue,
            };
            if app.emit_to(target.clone(), &event, frame).is_err() {
                break;
            }
        }
        bridge.sockets.lock().unwrap_or_else(PoisonError::into_inner).remove(&id);
        let _ = app.emit_to(target, &event, Frame { kind: "close", text: None, binary: None });
    });
    Ok(id)
}

#[tauri::command]
pub fn connect_ws_send(window: tauri::Window, bridge: tauri::State<'_, ConnectBridgeState>, id: u64, text: Option<String>, binary: Option<String>) -> Result<(), String> {
    only_connect(&window)?;
    let message = match (text, binary) {
        (Some(text), None) => Message::Text(text.into()),
        (None, Some(b64)) => Message::Binary(base64::engine::general_purpose::STANDARD.decode(b64).map_err(|_| "bad binary frame")?.into()),
        _ => return Err("one of text or binary".into()),
    };
    let sockets = bridge.sockets.lock().unwrap_or_else(PoisonError::into_inner);
    let sender = sockets.get(&id).ok_or("the socket is closed")?;
    sender.send(message).map_err(|_| "the socket is closed".to_string())
}

#[tauri::command]
pub fn connect_ws_close(window: tauri::Window, bridge: tauri::State<'_, ConnectBridgeState>, id: u64) -> Result<(), String> {
    only_connect(&window)?;
    if let Some(sender) = bridge.sockets.lock().unwrap_or_else(PoisonError::into_inner).remove(&id) {
        let _ = sender.send(Message::Close(None));
    }
    Ok(())
}

/// Open a server file on this machine (§7.2 "open-outside after a
/// download"): the ticket URL the server minted is downloaded into the
/// user's Downloads folder and opened with the system's default app — only
/// an inert viewer type (`connect::opens_as_inert_viewer`); anything else is
/// shown in its folder instead, and the answer says why.
#[tauri::command]
pub async fn connect_open_download(window: tauri::Window, url: String) -> Result<String, String> {
    only_connect(&window)?;
    let paired = connect::paired_in(&crate::storage::state_dir()).ok_or("this computer is not paired with a server")?;
    let dir = crate::paths::home_dir().join("Downloads");
    let path = connect::download_ticket(&paired.origin, &url, &dir).await?;
    #[cfg(windows)]
    connect::mark_of_the_web(&path, &paired.origin);
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default();
    if !connect::opens_as_inert_viewer(name) {
        if let Some(folder) = path.parent() {
            let _ = opener::open(folder);
        }
        let why = if connect::opens_as_program(name) { "it would run as a program on this computer" } else { "only documents, pictures and plain text are opened directly" };
        return Err(format!("Saved to {} and shown in its folder; not opened, because {why}", path.display()));
    }
    opener::open(&path).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    /// P5 review: a closed or reloaded Connect window takes its sockets
    /// with it.
    #[test]
    fn closing_the_bridge_closes_every_socket_it_holds() {
        use tokio_tungstenite::tungstenite::Message;
        let bridge = super::ConnectBridge::default();
        let (a, mut a_rx) = tokio::sync::mpsc::unbounded_channel();
        let (b, mut b_rx) = tokio::sync::mpsc::unbounded_channel();
        bridge.sockets.lock().unwrap().extend([(1, a), (2, b)]);
        bridge.close_all();
        assert!(bridge.sockets.lock().unwrap().is_empty());
        assert!(matches!(a_rx.try_recv(), Ok(Message::Close(None))) && matches!(b_rx.try_recv(), Ok(Message::Close(None))));
    }

    #[test]
    fn frame_event_names_are_the_windows_own_and_bounded() {
        assert!(super::valid_event("connect-frame-a1B2"));
        for bad in ["connect-frame-", "connect-frame-a/b", "other-a1", &format!("connect-frame-{}", "a".repeat(33))] {
            assert!(!super::valid_event(bad), "{bad}");
        }
    }
}
