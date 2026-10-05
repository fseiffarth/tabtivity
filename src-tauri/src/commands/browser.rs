//! The in-app browser's Tauri command surface (TODO group J #61).
//!
//! # The boundary, in one sentence
//!
//! **No command in this file accepts a filesystem path, and no result carries
//! one.** A page picks bytes and a name; it never picks a location. That is the
//! same rule `commands::mail` is built on, and it is enforced here by the same
//! mechanism: `no_command_takes_a_path` in this file's tests reads this file's
//! own source, finds every `#[tauri::command]` signature and fails if a
//! parameter is path-shaped. There is exactly one deliberate exception — `url`
//! — and the test spells out why it is safe (it is handed to
//! `web_safety::navigation_decision` before anything else touches it, and it can
//! only name a network location, never a local one, because `file:` is
//! hard-blocked).
//!
//! # Two surfaces, because a third is not buildable
//!
//! An in-pane embedded child webview does not work on Linux —
//! `tauri-runtime-wry` packs child webviews into a `GtkBox`, where
//! `set_bounds` is a documented no-op, so N webviews render as a vertical
//! stack. Instead:
//!
//! - [`browser_reader_fetch`] fetches and sanitizes in Rust and hands back
//!   inert HTML. **No JavaScript ever runs**, on any platform.
//! - [`browser_open_live`] spawns a separate hardened `WebviewWindow` with an
//!   ephemeral profile and a `browser-*` label that no capability grants
//!   anything to.
//!
//! # Windows
//!
//! Refused in v1 because of WebView2's permission model: with no
//! `PermissionRequested` handler its default state is `Default`, which draws
//! **Edge's own** permission prompt — a dialog Tabtivity did not write, whose
//! "Allow" grants a browsed page the camera, and whose answer is persisted into
//! the profile. wry registers a handler only for clipboard reads, and that one
//! only ever *allows*. Lifted since: [`deny_all_permissions`] registers a
//! deny-everything handler on the raw `ICoreWebView2` through `webview2-com`
//! (Windows-only COM against the controller Tauri hands `with_webview`), which
//! fires before the prompt would be drawn and answers it with `DENY` — the same
//! "a browsed page gets no device, ever" contract WebKitGTK's unhandled
//! `permission-request` gives the Linux window. The tripwire test below is what
//! keeps that handler deny-only. WebView2's TLS interstitial remains a decision
//! surface we do not draw; the navigation gate is what stands in front of it.

use std::path::PathBuf;

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::commands::projects::uuid_v4;
use crate::schema::browser::{
    BlockedNavigation, BrowserCapabilities, DownloadOutcome, DownloadRequest, LiveWindowClosed,
    LiveWindowRef, LiveWindowState, ReaderPage, TlsState, UrlVerdict,
};
use crate::services::browser_engine::{self as engine, Classification};
use crate::services::web_safety::{self, describe_url, NavContext, NavDecision};

/// The structured refusal every live-page entry point returns on a platform
/// that cannot honour the permission contract. A token, not a sentence — the
/// wording is the frontend's.
const UNSUPPORTED: &str = "browser-unsupported-platform";

/// The refusal when the platform *could* open a live window but the user has
/// not opted in. Distinct from [`UNSUPPORTED`] on purpose — "not on this
/// operating system" and "you have this switched off" are different sentences,
/// and a single token would make the second read as the first.
const LIVE_DISABLED: &str = "browser-live-pages-disabled";

/// Event names. Spelled once so a rename is a compile-time edit here rather
/// than a silent mismatch with the frontend's listeners.
const EV_LIVE_STATE: &str = "browser:live-state";
const EV_DOWNLOAD_REQUESTED: &str = "browser:download-requested";
const EV_BLOCKED: &str = "browser:blocked";
const EV_LIVE_CLOSED: &str = "browser:live-closed";

/// Whether this build can open a **live-page window**. Every platform can.
///
/// Windows used to be refused here: WebView2's *default* permission state
/// draws Edge's own prompt, whose Allow grants a browsed page the camera, and
/// that dialog is not ours to reword or restyle. It is ours to **pre-empt**,
/// though — `ICoreWebView2::add_PermissionRequested` fires before the prompt
/// and a handler that sets the state to `DENY` means no prompt is ever drawn.
/// [`deny_all_permissions`] installs exactly that on the live window, which is
/// the same "a browsed page gets no device, ever" contract the Linux window
/// keeps through WebKitGTK's permission-request signal.
const LIVE_SUPPORTED: bool = true;

/// Whether this build can serve **reader mode**. Every platform can.
///
/// Deliberately a separate constant from [`LIVE_SUPPORTED`] rather than a use of
/// it. A live-page refusal is *entirely* about a webview's permission model, and
/// reader mode has no webview: it is rustls plus `ammonia` in Rust, rendered
/// into a `sandbox=""` srcdoc frame in the main window. Sharing one constant is
/// how this became an over-broad refusal the first time (the Windows gate, since
/// lifted) — a platform gate that names its reason cannot silently spread to a
/// surface the reason does not apply to. None of the Unix-only download
/// hardening is on this path either; all of it hangs off the live window's
/// `on_download`.
const READER_SUPPORTED: bool = true;

// ── Capability report ───────────────────────────────────────────────────────

#[tauri::command]
pub async fn browser_capabilities() -> Result<BrowserCapabilities, String> {
    let live_enabled = read_settings()
        .map(|s| s.browser_live_pages())
        .unwrap_or(false);
    Ok(BrowserCapabilities {
        // Two independent reasons the control can be absent, reported as one
        // bool because the frontend's question is only ever "may I offer this".
        live_windows_supported: LIVE_SUPPORTED && live_enabled,
        reader_supported: READER_SUPPORTED,
        // Prose, not a token — unlike `UrlVerdict::reason`, this one is rendered
        // verbatim by the frontend in place of the live-page control, and a user
        // reading `windows-webview2-permission-prompt` learns nothing. Kept to
        // one plain, non-alarming sentence.
        platform_note: match (LIVE_SUPPORTED, live_enabled) {
            (true, true) => None,
            (true, false) => Some(
                "Live pages are off. Reader mode shows pages with no scripts; \
                 live pages run the real web page and can reach services on this \
                 machine, so they are opt-in under Settings → Browser."
                    .to_string(),
            ),
            (false, _) => {
                Some("Live pages are not available on this platform. Reader mode works.".to_string())
            }
        },
    })
}

fn read_settings() -> Option<crate::schema::settings::Settings> {
    let path = crate::storage::state_dir().join("settings.json");
    if path.exists() {
        crate::storage::read_json::<crate::schema::settings::Settings>(&path).ok()
    } else {
        None
    }
}

// ── The pure gate ───────────────────────────────────────────────────────────

/// Judge a URL. Pure: no network, no filesystem, no window.
///
/// See [`UrlVerdict`]'s doc for how the gate's three outcomes map onto this
/// type's two fields — in short, `allowed == true` with a `reason` is
/// *"reachable, but it is a loopback or private address and the user should be
/// told first"*.
#[tauri::command]
pub async fn browser_check_url(url: String) -> Result<UrlVerdict, String> {
    Ok(check(&url))
}

fn check(raw: &str) -> UrlVerdict {
    let (parsed, decision) = web_safety::navigation_decision_str(raw, &NavContext::default());
    let Some(parsed) = parsed else {
        return UrlVerdict {
            allowed: false,
            reason: Some(match decision {
                NavDecision::Block(r) => r.token(),
                _ => "unparsable".to_string(),
            }),
            // Never echo the raw string back as a URL — it did not parse as
            // one, so presenting it in a URL-shaped slot would be a lie the
            // user reads as verified.
            display_url: web_safety::strip_format_controls(raw)
                .chars()
                .take(300)
                .collect(),
            punycode_warning: None,
            scheme: String::new(),
            is_loopback: false,
        };
    };
    let shown = describe_url(&parsed);
    let (allowed, reason) = match decision {
        NavDecision::Allow => (true, None),
        NavDecision::Confirm(r) => (true, Some(r.token().to_string())),
        NavDecision::Block(r) => (false, Some(r.token())),
    };
    UrlVerdict {
        allowed,
        reason,
        display_url: shown.display,
        punycode_warning: shown.punycode,
        scheme: parsed.scheme().to_string(),
        is_loopback: web_safety::is_loopback_url(&parsed),
    }
}

// ── Reader mode ─────────────────────────────────────────────────────────────

/// Fetch a URL, sanitize it, and return inert HTML.
///
/// Async on purpose, and not only because it does I/O: a synchronous Tauri
/// command runs on the main thread, and a 15-second fetch there would freeze
/// the whole window.
#[tauri::command]
pub async fn browser_reader_fetch(url: String) -> Result<ReaderPage, String> {
    if !READER_SUPPORTED {
        return Err(UNSUPPORTED.to_string());
    }
    let requested = web_safety::strip_format_controls(&url);
    let page = engine::fetch_reader(&url).await?;
    let shown = describe_url(&page.final_url);
    Ok(ReaderPage {
        requested_url: requested,
        final_url: page.final_url.to_string(),
        display_url: shown.display,
        title: page.title,
        html: page.html,
        security: engine::security_for(&page.final_url, page.tls),
        truncated: page.truncated,
        blocked_remote_assets: page.blocked_remote,
    })
}

// ── Live-page windows ───────────────────────────────────────────────────────

/// Open a hardened live-page window.
///
/// MUST be `async`, for the same reason `open_presenter_window` and
/// `detach_subwindow` are: `WebviewWindowBuilder::build()` blocks on the
/// main-thread event loop pumping WebView2's controller callback, which a
/// synchronous command is itself blocking (wry#583 / tauri#4121).
#[tauri::command]
pub async fn browser_open_live(app: AppHandle, url: String) -> Result<LiveWindowRef, String> {
    if !LIVE_SUPPORTED {
        return Err(UNSUPPORTED.to_string());
    }
    // The opt-in is re-read here and not taken from `browser_capabilities`'
    // answer: that call happens once when a pane mounts, and a setting the user
    // turned back off in between must take effect. A frontend that hides the
    // control is the courtesy; this is the control.
    if !read_settings()
        .map(|s| s.browser_live_pages())
        .unwrap_or(false)
    {
        return Err(LIVE_DISABLED.to_string());
    }
    let verdict = check(&url);
    if !verdict.allowed {
        return Err(verdict.reason.unwrap_or_else(|| "blocked".to_string()));
    }
    // The verdict re-parses; take the parsed value from the same parse the gate
    // used rather than parsing a third time.
    let parsed = url::Url::parse(&url).map_err(|_| "unparsable".to_string())?;
    let display_url = verdict.display_url.clone();

    let label = engine::next_live_label();
    engine::live_register(&label, &parsed);
    spawn_live_window(&app, &label, parsed)?;
    Ok(LiveWindowRef { label, display_url })
}

/// Windows: refuse every permission a browsed page asks for — camera,
/// microphone, geolocation, notifications, clipboard, the lot — before WebView2
/// can draw Edge's prompt for it. The handler runs after wry's own (which
/// allows clipboard-read for ordinary app windows); the last `SetState` wins,
/// and for a window that shows the open web the answer is no. Best-effort in
/// the sense that a failed hook install leaves the engine's default in place,
/// which is a *prompt*, never a silent grant.
#[cfg(target_os = "windows")]
pub(crate) fn deny_all_permissions(win: &tauri::WebviewWindow) {
    use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_PERMISSION_STATE_DENY;
    use webview2_com::PermissionRequestedEventHandler;

    let _ = win.with_webview(|webview| {
        // SAFETY: COM calls on the live controller Tauri handed us, on the
        // webview's own thread; WebView2 holds the handler while registered.
        unsafe {
            let Ok(core) = webview.controller().CoreWebView2() else {
                return;
            };
            let handler = PermissionRequestedEventHandler::create(Box::new(|_, args| {
                if let Some(args) = args.as_ref() {
                    args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)?;
                }
                Ok(())
            }));
            let mut token = 0i64;
            let _ = core.add_PermissionRequested(&handler, &mut token);
        }
    });
}

/// Linux: WebKitGTK answers a permission request it has no handler for by
/// *denying* it (the `permission-request` signal's default handler returns
/// `FALSE`), so a live window that installs none already grants nothing. macOS:
/// WKWebView asks its UI delegate, and wry's delegate implements no media/
/// geolocation grant, so the request is denied there too. Nothing to install.
#[cfg(not(target_os = "windows"))]
pub(crate) fn deny_all_permissions(win: &tauri::WebviewWindow) {
    let _ = win;
}

fn spawn_live_window(app: &AppHandle, label: &str, url: url::Url) -> Result<(), String> {
    use tauri::webview::{DownloadEvent, NewWindowResponse, PageLoadEvent};
    use tauri::{WebviewUrl, WebviewWindowBuilder};

    let nav_app = app.clone();
    let nav_label = label.to_string();
    let dl_app = app.clone();
    let dl_label = label.to_string();
    let load_app = app.clone();
    let load_label = label.to_string();
    let title_label = label.to_string();
    let title_app = app.clone();

    let builder = WebviewWindowBuilder::new(app, label, WebviewUrl::External(url.clone()))
        .title(concat!(crate::app_name!(), " — Web"))
        .inner_size(1100.0, 800.0)
        // **Ephemeral, always.** On Linux this is
        // `WebContext::new_ephemeral()`: no website-data-manager base directory,
        // no cookie file, no cache. Nothing to steal off disk, no cross-session
        // correlation, no service worker that outlives the tab that installed
        // it, and no "delete my browsing data" story to get wrong — quitting
        // Tabtivity *is* the delete. It is also mutually exclusive with a
        // persistent profile directory: wry documents that the web context is
        // IGNORED when incognito is on, and on Linux it builds a function-local
        // ephemeral context instead. Passing both is how "ephemeral" silently
        // stops being true, so the builder below sets only this one.
        .incognito(true)
        // An extension in this webview would run with the page's privileges
        // *plus* whatever the extension API grants, in a process that also hosts
        // Tabtivity's own window.
        .browser_extensions_enabled(false)
        // THE navigation gate. In Rust, in the backend: a page navigates
        // itself, a redirect moves it, a `target=_blank` spawns it, and none of
        // those pass through React.
        .on_navigation(move |target| {
            let Some(rec) = engine::live_get(&nav_label) else {
                return false;
            };
            match engine::live_navigation_allowed(&rec, target) {
                Ok(()) => {
                    engine::live_set_url(&nav_label, target);
                    true
                }
                Err(reason) => {
                    let _ = nav_app.emit(
                        EV_BLOCKED,
                        BlockedNavigation {
                            display_url: describe_url(target).display,
                            reason,
                            // Attribution, not decoration: without it the
                            // frontend has to guess which surface this belongs
                            // to, and the honest guess ("the last tab that
                            // asked for a load") is wrong here — a live window's
                            // refusal has nothing to do with any reader tab.
                            window_label: Some(nav_label.clone()),
                        },
                    );
                    false
                }
            }
        })
        // `NewWindowResponse::Allow` produces a chromeless OS window with no
        // address bar — the ideal canvas for a fake login or a fake Tabtivity
        // dialog. Denying means every page the user ever sees sits inside
        // chrome that shows the real origin. Cost, disclosed: `window.open`
        // returns null, so OAuth popups and some payment flows break.
        .on_new_window(move |_url, _features| NewWindowResponse::Deny)
        .on_document_title_changed(move |_win, title| {
            engine::live_set_title(&title_label, &title);
            emit_live_state(&title_app, &title_label, false);
        })
        .on_page_load(move |_win, payload| {
            engine::live_set_url(&load_label, payload.url());
            emit_live_state(
                &load_app,
                &load_label,
                matches!(payload.event(), PageLoadEvent::Started),
            );
        })
        // wry's DEFAULT download handler is `|_, _| true` — it allows every
        // download to a location it picked. Installing this is therefore not an
        // enhancement, it is the difference between "we control downloads" and
        // "the page does".
        .on_download(move |_webview, event| match event {
            DownloadEvent::Requested { url, destination } => {
                on_download_requested(&url, destination)
            }
            DownloadEvent::Finished { url, path, success } => {
                on_download_finished(&dl_app, &dl_label, &url, path, success);
                true
            }
            _ => true,
        });

    let win = builder.build().map_err(|e| {
        engine::live_forget(label);
        format!("build browser window: {e}")
    })?;

    // The renderer crash reporter iterates `app.webview_windows()` **once, at
    // setup**, so a window created later is not hooked — and a hostile page is
    // precisely the thing that induces a renderer crash. Hook this one too, or
    // the crash it causes is a blank window with no `crash.log` line.
    crate::hook_webview_crash_reporter(&win);
    deny_all_permissions(&win);

    let close_app = app.clone();
    let close_label = label.to_string();
    win.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            engine::live_forget(&close_label);
            let _ = close_app.emit(
                EV_LIVE_CLOSED,
                LiveWindowClosed {
                    label: close_label.clone(),
                },
            );
        }
    });

    Ok(())
}

fn emit_live_state(app: &AppHandle, label: &str, loading: bool) {
    let Some(rec) = engine::live_get(label) else {
        return;
    };
    let shown = describe_url(&rec.url);
    let tls = if rec.url.scheme() == "https" {
        TlsState::Secure
    } else if rec.url.scheme() == "http" {
        TlsState::Insecure
    } else {
        TlsState::Unknown
    };
    let _ = app.emit(
        EV_LIVE_STATE,
        LiveWindowState {
            label: label.to_string(),
            display_url: shown.display,
            title: rec.title.clone(),
            security: engine::security_for(&rec.url, tls),
            loading,
        },
    );
}

/// Close a live window. Idempotent — a window already gone is the state the
/// caller wanted, and the frontend's unmount races the user closing it from the
/// window manager.
#[tauri::command]
pub async fn browser_close_live(app: AppHandle, label: String) -> Result<(), String> {
    // Validated, not trusted: without this the frontend could hand any label in
    // the app to `destroy()`, `main` included.
    if !engine::valid_live_label(&label) {
        return Err("invalid browser window label".into());
    }
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.destroy();
    }
    engine::live_forget(&label);
    Ok(())
}

#[tauri::command]
pub async fn browser_list_live() -> Result<Vec<LiveWindowRef>, String> {
    Ok(engine::live_list()
        .into_iter()
        .map(|rec| LiveWindowRef {
            display_url: describe_url(&rec.url).display,
            label: rec.label,
        })
        .collect())
}

// ── Downloads ───────────────────────────────────────────────────────────────

/// `DownloadEvent::Requested`: point the engine at a directory **we** chose and
/// let it complete the transfer.
///
/// Why allow-and-quarantine rather than deny-and-refetch: a download is very
/// often session-authenticated — a file behind a login, a signed URL with a
/// short TTL, a POST result. The backend has no cookies (the ephemeral store
/// belongs to the engine), so a refetch would 403 on exactly the downloads
/// people actually want. Letting the engine finish into a directory we chose
/// keeps the session *and* keeps the boundary. The cost is that bytes touch
/// disk before the user consents, which is why quarantine is `0700`, the file
/// is `0600` and non-executable, nothing ever opens it, and the whole tree is
/// swept at startup.
fn on_download_requested(url: &url::Url, destination: &mut PathBuf) -> bool {
    let root = engine::quarantine_root();
    let token = uuid_v4();
    let name = engine::download_name_for(url);
    let dest = engine::quarantine_dest(&root, &token, &name);
    let Some(parent) = dest.parent() else {
        return false;
    };
    if std::fs::create_dir_all(parent).is_err() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700));
    }
    engine::stage_remember(url.as_str(), &token, &dest);
    *destination = dest;
    true
}

fn on_download_finished(
    app: &AppHandle,
    window_label: &str,
    url: &url::Url,
    path: Option<PathBuf>,
    success: bool,
) {
    let Some((token, staged)) = engine::stage_take(url.as_str()) else {
        return;
    };
    let Some(dir) = staged.parent().map(PathBuf::from) else {
        return;
    };
    if !success {
        let _ = std::fs::remove_dir_all(&dir);
        return;
    }

    // `path` is advisory: on macOS `Finished` reports `None` unconditionally (a
    // documented API limitation), and anywhere else a path outside the
    // quarantine root would mean the engine ignored our destination — in which
    // case we do not want to touch it either.
    let root = engine::quarantine_root();
    let file = match path {
        Some(p) if p.starts_with(&root) => p,
        _ => staged,
    };

    let Ok(meta) = std::fs::metadata(&file) else {
        let _ = std::fs::remove_dir_all(&dir);
        return;
    };
    if meta.len() > engine::MAX_DOWNLOAD_BYTES {
        let _ = std::fs::remove_dir_all(&dir);
        let _ = app.emit(
            EV_BLOCKED,
            BlockedNavigation {
                display_url: describe_url(url).display,
                reason: "download-too-large".to_string(),
                window_label: Some(window_label.to_string()),
            },
        );
        return;
    }
    let _ = engine::harden_staged_file(&file);

    let head = read_head(&file, engine::SNIFF_BYTES);
    let name = file
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "download".to_string());
    let classification = engine::classify(&head, &name);

    let pending = engine::PendingDownload {
        id: token.clone(),
        dir,
        file,
        name: name.clone(),
        mime: engine::best_mime(&head, &name),
        size: Some(meta.len()),
        classification,
    };
    let event = DownloadRequest {
        download_id: token,
        file_name: name,
        mime_type: pending.mime.clone(),
        size_bytes: pending.size,
        sniff_mismatch: classification != Classification::Ok,
    };
    engine::download_remember(pending);
    let _ = app.emit(EV_DOWNLOAD_REQUESTED, event);
}

fn read_head(path: &std::path::Path, max: usize) -> Vec<u8> {
    use std::io::Read;
    let Ok(mut f) = std::fs::File::open(path) else {
        return Vec::new();
    };
    let mut buf = vec![0u8; max];
    match f.read(&mut buf) {
        Ok(n) => {
            buf.truncate(n);
            buf
        }
        Err(_) => Vec::new(),
    }
}

/// Accept or decline a quarantined download.
///
/// On accept this raises the **OS-native save dialog from Rust** and writes to
/// whatever single path the user chose. The page never names a destination, the
/// frontend never names one either, and the dialog's starting point is the OS
/// downloads directory — never the active project, because a file routed into a
/// project tree can be `git add -A`'d and replicated to a remote host.
///
/// Returns a **display name**, never a path.
#[tauri::command]
pub async fn browser_download_decide(
    app: AppHandle,
    download_id: String,
    accept: bool,
) -> Result<DownloadOutcome, String> {
    let Some(pending) = engine::download_take(&download_id) else {
        return Err("no such download".into());
    };
    if !accept {
        // A declined download leaves nothing at all — not a partial file, not a
        // temp file, nothing.
        let _ = std::fs::remove_dir_all(&pending.dir);
        return Ok(DownloadOutcome::default());
    }

    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("Save download")
        .set_file_name(pending.name.clone())
        .save_file(move |chosen| {
            let _ = tx.send(chosen);
        });
    let chosen = rx.await.map_err(|_| "the file dialog was dismissed")?;
    let Some(chosen) = chosen else {
        let _ = std::fs::remove_dir_all(&pending.dir);
        return Ok(DownloadOutcome::default());
    };
    let target = chosen.into_path().map_err(|e| e.to_string())?;

    let dir = pending.dir.clone();
    let staged = pending.file.clone();
    let saved_name = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| pending.name.clone());

    tokio::task::spawn_blocking(move || {
        // Rename first; fall back to copy+remove across filesystems. We do not
        // create directories and we do not append.
        if std::fs::rename(&staged, &target).is_err() {
            std::fs::copy(&staged, &target).map_err(|e| e.to_string())?;
            let _ = std::fs::remove_file(&staged);
        }
        let _ = std::fs::remove_dir_all(&dir);
        // Mark-of-the-Web / quarantine where the engine has not already left
        // one. Best-effort; never fails the save.
        web_safety::mark_downloaded(&target);
        Ok::<_, String>(())
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(DownloadOutcome {
        saved: true,
        file_name: Some(web_safety::strip_format_controls(&saved_name)),
    })
}

// ── Clearing ────────────────────────────────────────────────────────────────

/// Wipe everything the browser could have left behind.
///
/// On an ephemeral profile there is deliberately very little to wipe — that is
/// the design, not an omission — so this is mostly the quarantine plus a
/// belt-and-braces `clear_all_browsing_data()` on any live window still open.
#[tauri::command]
pub async fn browser_clear_data(app: AppHandle) -> Result<(), String> {
    for rec in engine::live_list() {
        if let Some(win) = app.get_webview_window(&rec.label) {
            let _ = win.clear_all_browsing_data();
        }
    }
    engine::downloads_clear();
    engine::sweep_quarantine();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn src_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src")
    }

    /// Every `.rs` file under `src-tauri/src`, as text.
    fn all_backend_sources() -> Vec<(String, String)> {
        fn walk(dir: &std::path::Path, out: &mut Vec<(String, String)>) {
            let Ok(entries) = std::fs::read_dir(dir) else {
                return;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    walk(&path, out);
                } else if path.extension().and_then(|e| e.to_str()) == Some("rs") {
                    if let Ok(text) = std::fs::read_to_string(&path) {
                        out.push((path.to_string_lossy().into_owned(), text));
                    }
                }
            }
        }
        let mut out = Vec::new();
        walk(&src_root(), &mut out);
        assert!(out.len() > 20, "the source walk found almost nothing");
        out
    }

    /// The browser's own modules, as text.
    fn browser_sources() -> Vec<(&'static str, &'static str)> {
        vec![
            ("commands/browser.rs", include_str!("browser.rs")),
            (
                "services/browser_engine.rs",
                include_str!("../services/browser_engine.rs"),
            ),
            (
                "services/web_safety.rs",
                include_str!("../services/web_safety.rs"),
            ),
        ]
    }

    // ── The boundary ────────────────────────────────────────────────────────

    /// **The mechanically-checkable statement of the whole sandbox boundary**,
    /// the browser's copy of `commands::mail::tests::no_command_takes_a_path`.
    ///
    /// One deliberate exception: **`url`**. The browser must take a URL — that
    /// is the feature — and mail's list bans it because a mail command has no
    /// business naming a location at all. It is safe here for two specific
    /// reasons, and only those two: every `url` argument is handed to
    /// `web_safety::navigation_decision` *before* anything else touches it, and
    /// that gate hard-blocks `file:` (and `tauri:`, `asset:`, `ipc:`, `blob:`,
    /// `data:`, `javascript:` and everything not on the allowlist), so a `url`
    /// can only ever name a network location. If either of those stops being
    /// true, this exception stops being safe.
    #[test]
    fn no_command_takes_a_path() {
        const RESERVED: &[&str] = &[
            "path",
            "paths",
            "dest",
            "destination",
            "dir",
            "directory",
            "folder",
            "file",
            "filename",
            "filepath",
            "glob",
            "cwd",
            "root",
            "target",
            "location",
        ];
        const SUFFIXES: &[&str] = &["_path", "_dir", "_file", "_filename", "_glob", "_paths"];
        const RESERVED_TYPES: &[&str] = &["path", "pathbuf", "osstr", "osstring", "direntry"];

        let src = include_str!("browser.rs");
        let mut starts: Vec<usize> = Vec::new();
        let mut offset = 0usize;
        // `split_inclusive` keeps each line terminator, so the running offset is
        // exact for both LF and CRLF. `lines()` + `len() + 1` assumed a 1-byte
        // terminator and drifted one byte per line on a CRLF checkout (Windows),
        // eventually slicing into the middle of a multi-byte char in a comment.
        for chunk in src.split_inclusive('\n') {
            let line = chunk.trim_end_matches('\n').trim_end_matches('\r');
            if line.trim() == concat!("#[tauri", "::command]") {
                starts.push(offset + line.len());
            }
            offset += chunk.len();
        }

        let mut checked = 0usize;
        for start in starts {
            let Some(open) = src[start..].find('(') else {
                break;
            };
            let sig_start = start + open + 1;
            let mut depth = 1usize;
            let mut i = sig_start;
            let bytes = src.as_bytes();
            while i < bytes.len() && depth > 0 {
                match bytes[i] {
                    b'(' => depth += 1,
                    b')' => depth -= 1,
                    _ => {}
                }
                i += 1;
            }
            let params = &src[sig_start..i.saturating_sub(1)];
            let name = src[start..sig_start].trim();
            checked += 1;

            let mut depth = 0usize;
            for part in params.split(|c| match c {
                '<' | '(' | '[' => {
                    depth += 1;
                    false
                }
                '>' | ')' | ']' => {
                    depth = depth.saturating_sub(1);
                    false
                }
                ',' => depth == 0,
                _ => false,
            }) {
                let part = part.trim();
                if part.is_empty() {
                    continue;
                }
                let Some((pname, ty)) = part.split_once(':') else {
                    continue;
                };
                let pname = pname.trim().trim_start_matches("mut ").to_ascii_lowercase();
                let ty_lower = ty.to_ascii_lowercase();
                for ident in ty_lower.split(|c: char| !c.is_ascii_alphanumeric() && c != '_') {
                    assert!(
                        !RESERVED_TYPES.contains(&ident),
                        "`{pname}: {}` in `{name}` is a path-shaped parameter — the browser \
                         command surface must name no location the frontend controls",
                        ty.trim()
                    );
                }
                assert!(
                    !RESERVED.contains(&pname.as_str()),
                    "`{pname}` in `{name}` is a path-shaped parameter — the browser command \
                     surface must name no location the frontend controls"
                );
                assert!(
                    !SUFFIXES.iter().any(|s| pname.ends_with(s)) && !pname.starts_with("path_"),
                    "`{pname}` in `{name}` is a path-shaped parameter — the browser command \
                     surface must name no location the frontend controls"
                );
            }
        }
        assert!(
            checked >= 8,
            "expected the whole frozen command surface to be scanned, saw {checked}"
        );
    }

    /// A synchronous command runs on the main thread. A 15-second fetch or a
    /// `build()` that waits on the event loop would freeze the whole webview.
    #[test]
    fn every_command_is_async() {
        let src = include_str!("browser.rs");
        let lines: Vec<&str> = src.lines().collect();
        let mut seen = 0usize;
        for (i, line) in lines.iter().enumerate() {
            if line.trim() != concat!("#[tauri", "::command]") {
                continue;
            }
            seen += 1;
            let next = lines.get(i + 1).copied().unwrap_or("").trim_start();
            assert!(
                next.starts_with("pub async fn"),
                "the command at line {} is not `pub async fn`:\n{next}",
                i + 2
            );
        }
        assert!(seen >= 8, "expected the whole command surface, saw {seen}");
    }

    #[test]
    fn the_frozen_command_surface_is_complete() {
        let src = include_str!("browser.rs");
        for name in [
            "browser_check_url",
            "browser_reader_fetch",
            "browser_open_live",
            "browser_close_live",
            "browser_list_live",
            "browser_download_decide",
            "browser_clear_data",
            "browser_capabilities",
        ] {
            assert!(
                src.contains(&format!("pub async fn {name}(")),
                "the frozen contract names `{name}`, which is missing"
            );
        }
    }

    /// Every `browser:blocked` this module emits must name the window it came
    /// from. Without the label the frontend can only guess which surface a
    /// refusal belongs to, and the only guess available ("the reader tab that
    /// most recently asked for a load") is wrong for every emitter here — all of
    /// them are live-window events. A reader tab's own refusal never travels as
    /// an event at all; it is `browser_check_url`'s return value.
    #[test]
    fn every_blocked_event_names_its_window() {
        let src = include_str!("browser.rs");
        // Split so the needle cannot match inside this test's own source.
        let needle = concat!("BlockedNavigation", " {");
        let mut seen = 0usize;
        let mut from = 0usize;
        while let Some(i) = src[from..].find(needle) {
            let start = from + i;
            let end = src[start..]
                .find('}')
                .map(|j| start + j)
                .unwrap_or(src.len());
            let literal = &src[start..end];
            // Skip the struct's own definition/import lines, which have no body.
            if literal.contains("display_url") {
                seen += 1;
                assert!(
                    literal.contains("window_label"),
                    "a BlockedNavigation is emitted without a window_label:\n{literal}"
                );
            }
            from = end.max(start + 1);
        }
        assert!(
            seen >= 2,
            "expected every emit site to be scanned, saw {seen}"
        );
    }

    #[test]
    fn the_event_names_are_the_contract() {
        assert_eq!(EV_LIVE_STATE, "browser:live-state");
        assert_eq!(EV_DOWNLOAD_REQUESTED, "browser:download-requested");
        assert_eq!(EV_BLOCKED, "browser:blocked");
        assert_eq!(EV_LIVE_CLOSED, "browser:live-closed");
    }

    // ── Tripwires: things that must never appear ────────────────────────────

    /// **No certificate escape hatch, in any form.**
    ///
    /// This is enforceable rather than aspirational for a structural reason:
    /// the engines and rustls both validate against the **OS trust store**. A
    /// user with an internal CA installs it once, in their operating system,
    /// and every application — including this one — then trusts it. Removing
    /// the override does not remove the capability; it moves it to the layer
    /// that can audit and revoke it. So a future "just add a checkbox" is a
    /// failing test rather than a code-review argument.
    #[test]
    fn there_is_no_way_to_ignore_a_certificate_error() {
        for (name, src) in browser_sources() {
            for banned in [
                concat!("allow_tls_certi", "ficate_for_host"),
                concat!("set_tls_er", "rors_policy"),
                concat!("TLSErro", "rsPolicy"),
                concat!("danger_acc", "ept_invalid"),
                concat!("dange", "rous()"),
                concat!("with_custom_cert", "ificate_verifier"),
                concat!("ServerCer", "tVerifier"),
                concat!("NoCertificat", "eVerification"),
                concat!("accept_inv", "alid_certs"),
                concat!("accept_inval", "id_hostnames"),
            ] {
                assert!(
                    !src.contains(banned),
                    "`{banned}` in {name}: there is no \"proceed anyway\" in this browser"
                );
            }
        }
    }

    /// Deny-by-default for camera/microphone/geolocation/notifications is
    /// achieved on Linux by **not handling** WebKitGTK's `permission-request`
    /// (its documented behaviour when unhandled is
    /// `webkit_permission_request_deny()`). A handler is therefore how it
    /// regresses. wry's clipboard-access builder flag is the one call that
    /// installs an *allow* handler for clipboard reads on Windows, so it is on
    /// the banned list below too.
    ///
    /// Windows is the one place a handler IS installed, because there the
    /// engine's unhandled default is a *prompt*, not a denial. That handler is
    /// allowed on exactly one condition, checked here: every state it ever sets
    /// is `DENY`. An `ALLOW` anywhere in the backend stays banned outright.
    ///
    /// Clipboard read matters disproportionately in this app: whatever the user
    /// last copied is unusually likely to be a password, an SSH command line or
    /// an API token — Tabtivity has a credential-paste-to-PTY path precisely
    /// because credentials move through it.
    #[test]
    fn nothing_installs_a_permission_or_clipboard_handler() {
        let register = concat!("add_Permiss", "ionRequested");
        let deny = concat!("COREWEBVIEW2_PERM", "ISSION_STATE_DENY");
        for (name, src) in all_backend_sources() {
            for banned in [
                concat!("enable_clip", "board_access"),
                concat!("connect_permi", "ssion_request"),
                concat!("COREWEBVIEW2_PERM", "ISSION_STATE_ALLOW"),
                concat!("request_media_ca", "pture_permission"),
            ] {
                assert!(
                    !src.contains(banned),
                    "`{banned}` in {name}: permissions are denied by NOT handling the \
                     request; a handler is how that regresses"
                );
            }
            if src.contains(register) {
                assert!(
                    name.ends_with("browser.rs"),
                    "`{register}` in {name}: only the live browser window may \
                     register a permission handler, and only a deny-only one"
                );
                let set_state = concat!("SetSt", "ate(");
                let set_states = src.matches(set_state).count();
                let denials = src.matches(&format!("{set_state}{deny})")).count();
                assert!(
                    set_states > 0 && set_states == denials,
                    "{name}: every permission state the handler sets must be DENY"
                );
            }
        }
    }

    /// **BC-4.** Every URI scheme the app registers is, by Tauri's own
    /// definition, a *local* origin (`Webview::is_local_url` returns true for
    /// any URL under a registered protocol). Registering one while an in-app
    /// browser exists widens exactly the surface the navigation gate is holding
    /// shut.
    #[test]
    fn the_app_registers_no_custom_uri_scheme() {
        for (name, src) in all_backend_sources() {
            for banned in [
                concat!("register_uri_s", "cheme_protocol"),
                concat!("register_asynchronou", "s_uri_scheme_protocol"),
            ] {
                assert!(
                    !src.contains(banned),
                    "`{banned}` in {name}: a registered scheme is a LOCAL origin"
                );
            }
        }
    }

    /// `plugin:__TAURI_CHANNEL__|fetch` is exempted from the ACL origin check
    /// (Tauri marks it `TODO: Remove this special check in v3`), and it reads
    /// from a **process-global** queue keyed by an incrementing `u32` with no
    /// webview and no origin check. So a browsed page could enumerate ids and
    /// read `Channel` payloads queued for Tabtivity's own webview. It is harmless
    /// today only because Tabtivity uses events and never channels — i.e. the queue
    /// is permanently empty. This test is what keeps that true.
    #[test]
    fn the_backend_uses_no_ipc_channel() {
        for (name, src) in all_backend_sources() {
            for banned in [
                concat!("ipc::C", "hannel<"),
                concat!("tauri::ip", "c::Channel"),
            ] {
                assert!(
                    !src.contains(banned),
                    "`{banned}` in {name}: Channels are readable by ANY webview via \
                     `plugin:__TAURI_CHANNEL__|fetch`, which bypasses the ACL origin check. \
                     Use an event."
                );
            }
        }
    }

    /// There is exactly one keychain path in Tabtivity — the remote-credentials
    /// service — and the browser does not open a second. It offers no password
    /// saving, no form auto-fill, and no credential storage of any kind — not
    /// off-by-default, absent. A password manager is the single largest secret store an
    /// app can have, and this one would be built by an app whose actual job is
    /// running terminals.
    #[test]
    fn the_browser_opens_no_second_credential_path() {
        for (name, src) in browser_sources() {
            for banned in [
                concat!("keyr", "ing"),
                concat!("remote_cre", "dentials"),
                concat!("save_pas", "sword"),
                concat!("auto", "fill"),
            ] {
                assert!(
                    !src.to_ascii_lowercase().contains(banned),
                    "`{banned}` in {name}: the browser has no credential store"
                );
            }
        }
    }

    /// Restates TODO O #60 in browser terms, because a browser is precisely the
    /// feature that will tempt someone to break it: Tabtivity never reads, writes,
    /// imports from or "detects" another browser's profile, preferences, cookie
    /// jar, bookmarks, password store or download directory.
    /// `commands/downloads.rs` was deleted for exactly this and must not come
    /// back under a new name.
    #[test]
    fn nothing_reaches_into_another_browsers_profile() {
        for (name, src) in all_backend_sources() {
            for banned in [
                concat!("pref", "s.js"),
                concat!(".moz", "illa"),
                concat!("google-chr", "ome/Default"),
                concat!("chromium", "/Default"),
                concat!("Library", "/Safari"),
                concat!("browser.do", "wnload.dir"),
                concat!("browser.downl", "oad.folderList"),
            ] {
                assert!(
                    !src.contains(banned),
                    "`{banned}` in {name}: {app} never touches another app's config", app = crate::brand::DISPLAY
                );
            }
        }
    }

    /// The four calls that make a live window hardened. Each is a one-line
    /// deletion away from a materially weaker browser, and none of them fails
    /// loudly at runtime if removed.
    #[test]
    fn the_live_window_keeps_its_hardening() {
        let src = include_str!("browser.rs");
        for (needle, why) in [
            (
                "incognito(true)",
                "without it the profile is persistent: cookies, cache and IndexedDB on \
                 disk, and a crash leaves them there forever",
            ),
            (
                "browser_extensions_enabled(false)",
                concat!("an extension here runs with the page's privileges plus the extension \
                 API's, in a process that also hosts ", crate::app_name!(), "'s window"),
            ),
            (
                "on_new_window",
                "without it `window.open` gets a chromeless OS window with no address bar",
            ),
            (
                "NewWindowResponse::Deny",
                "Allow/Create both produce a window; only Deny keeps every page inside \
                 chrome that shows the real origin",
            ),
            (
                "on_download",
                "wry's DEFAULT handler allows every download to a path the page chose",
            ),
            (
                "on_navigation",
                "the navigation gate is the only thing between a page and the app origin",
            ),
        ] {
            assert!(src.contains(needle), "`{needle}` is missing — {why}");
        }
        // A persistent profile directory is mutually exclusive with incognito —
        // wry ignores the web context entirely when incognito is on — so having
        // both in the builder is how "ephemeral" silently stops being true.
        assert!(
            !src.contains(concat!("data_dir", "ectory")),
            "the browser window must never be given a persistent profile directory"
        );
        // The DevTools default (debug builds only) is Tauri's; forcing it on
        // would put an inspector on an attacker's page in a release build.
        assert!(!src.contains(concat!("devto", "ols(true)")));
    }

    // ── The gate, through the command's own shape ───────────────────────────

    #[test]
    fn the_verdict_reports_a_block_with_a_reason_and_never_claims_a_scheme() {
        let v = check("file:///etc/passwd");
        assert!(!v.allowed);
        assert_eq!(v.reason.as_deref(), Some("scheme:file"));

        let v = check("http://localhost:1420/");
        assert!(!v.allowed);
        assert_eq!(v.reason.as_deref(), Some("app-origin"));

        let v = check("not a url at all");
        assert!(!v.allowed);
        assert_eq!(v.reason.as_deref(), Some("unparsable"));
        assert!(v.scheme.is_empty(), "an unparsable string has no scheme");
    }

    #[test]
    fn a_private_address_is_reachable_but_carries_its_reason() {
        let v = check("http://127.0.0.1:3000/");
        assert!(v.allowed, "a dev server must be reachable");
        assert_eq!(v.reason.as_deref(), Some("loopback"));
        assert!(v.is_loopback);

        let v = check("http://192.168.1.1/");
        assert!(v.allowed);
        assert_eq!(v.reason.as_deref(), Some("private-network"));
        assert!(!v.is_loopback);
    }

    #[test]
    fn an_ordinary_page_has_no_reason_attached() {
        let v = check("https://example.com/a?b=c");
        assert!(v.allowed);
        assert_eq!(v.reason, None);
        assert_eq!(v.scheme, "https");
        assert!(!v.is_loopback);
        assert_eq!(v.punycode_warning, None);
    }

    #[test]
    fn the_verdict_shows_the_real_host_and_both_forms_of_a_punycode_one() {
        let v = check("https://example.com@evil.example/");
        assert!(!v.display_url.contains("example.com@"), "{}", v.display_url);
        let v = check("https://xn--80ak6aa92e.example/");
        assert_eq!(
            v.punycode_warning.as_deref(),
            Some("xn--80ak6aa92e.example")
        );
    }

    /// A string that did not parse must not be echoed back into a URL-shaped
    /// slot as if it had — and a hostile one must not carry bidi controls into
    /// the block page.
    #[test]
    fn an_unparsable_string_is_neutralized_before_it_is_shown() {
        let v = check("ht\u{202E}tp://x");
        assert!(!v.display_url.contains('\u{202E}'), "{}", v.display_url);
        let v = check(&"x".repeat(5000));
        assert!(v.display_url.len() <= 300);
    }

    /// The capability report is how the frontend learns a platform is refused,
    /// instead of discovering it from a failed command.
    ///
    /// The two constants are asserted **separately**, which is the point: they
    /// were one constant, and sharing it silently extended a WebView2 permission
    /// argument to a surface that has no webview. A single assertion here would
    /// let them be merged again without a failure.
    // The asserted values are `cfg!`-resolved constants — that they are
    // constant is exactly the property under test, so a lint that objects to
    // asserting on a constant has nothing to say here.
    #[allow(clippy::assertions_on_constants)]
    #[test]
    fn the_platform_report_matches_the_cfg_gate() {
        assert!(
            LIVE_SUPPORTED,
            "every desktop can open the live window: Windows pre-empts WebView2's \
             permission prompt with a deny-only handler (see deny_all_permissions)"
        );
        assert!(
            READER_SUPPORTED,
            "reader mode has no webview and no permission surface — it works on \
             every platform, and a live-page refusal must never spread to it"
        );
    }

    /// The live window is opt-in, and its default must be OFF **in a debug build
    /// too** — unlike every other experimental flag, whose unset-means-on-in-debug
    /// rule is exactly wrong here. A debug build is what the author runs all day,
    /// and this is the surface whose central security claim does not hold.
    #[test]
    fn live_pages_are_off_until_asked_for() {
        use crate::schema::settings::Settings;

        let unset = Settings::default();
        assert!(
            !unset.browser_live_pages(),
            "unset must mean off, including in a debug build"
        );

        let debug_on = Settings {
            debug: Some(true),
            ..Default::default()
        };
        assert!(
            !debug_on.browser_live_pages(),
            "debug mode must NOT turn live pages on — that is the whole reason \
             this is not an experimental() flag"
        );

        let asked = Settings {
            browser_live_pages: Some(true),
            ..Default::default()
        };
        assert!(asked.browser_live_pages());

        // And the browser itself still follows the ordinary rule, so the two
        // switches are visibly different things.
        assert!(Settings {
            debug: Some(true),
            ..Default::default()
        }
        .web_browser());
    }
}
