use crate::gpustat::GpuSample;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct AppResourceUsage {
    pub cpu_percent: f64,
    pub rss_bytes: u64,
    pub process_count: usize,
    /// VRAM (bytes) in use by local models loaded in Ollama's memory. `0` when
    /// the Ollama server is down or no model is resident on the GPU. This is
    /// Ollama's *share* of the GPU — one line of the readout's breakdown, and
    /// the whole readout only on a machine whose GPU we cannot read (`gpus`
    /// empty). It is not part of Tabtivity's own process tree.
    pub vram_bytes: u64,
    /// Every GPU in the machine and its memory, Ollama's models or not. Empty
    /// when no GPU can be read; see [`crate::gpustat`].
    pub gpus: Vec<GpuSample>,
}

/// Debug-only live resource usage for Tabtivity's own process tree.
///
/// In `tauri dev`, the useful total is the npm/tauri/vite tree that owns the
/// running app process. In a packaged build, this naturally resolves to the app
/// process and any descendants.
///
/// `gpu: false` skips the GPU half (`gpus` empty, `vram_bytes` 0): the header
/// polls this every few seconds, and with its GPU row hidden there is no reason
/// to ask Ollama's HTTP port or the GPU driver anything. Absent = true, so a
/// caller that predates the flag (the dev perf host) keeps the full answer.
///
/// Every read here is blocking I/O — a `/proc` walk, a stat read per pid, sysfs,
/// a loopback HTTP request — so it runs on the blocking pool, never on the async
/// workers that drive the PTY output batchers.
#[tauri::command]
pub async fn debug_app_resource_usage(gpu: Option<bool>) -> Result<AppResourceUsage, String> {
    use crate::sysstat;

    let (pids, t0) = tauri::async_runtime::spawn_blocking(|| {
        let root = app_process_root(std::process::id());
        let pids = sysstat::descendant_pids(&[root]);
        let t0 = sysstat::sum_jiffies(&pids);
        (pids, t0)
    })
    .await
    .map_err(|e| e.to_string())?;
    let interval = std::time::Duration::from_millis(300);
    tokio::time::sleep(interval).await;
    let with_gpu = gpu.unwrap_or(true);
    tauri::async_runtime::spawn_blocking(move || {
        let t1 = sysstat::sum_jiffies(&pids);
        let busy_secs = t1.saturating_sub(t0) as f64 / sysstat::clk_tck() as f64;
        let cpu_percent = busy_secs / interval.as_secs_f64() * 100.0;
        let rss_bytes = sysstat::sum_rss_kib(&pids) * 1024;

        AppResourceUsage {
            cpu_percent: (cpu_percent * 10.0).round() / 10.0,
            rss_bytes,
            process_count: pids.len(),
            vram_bytes: if with_gpu { crate::commands::ollama::total_vram_in_use() } else { 0 },
            gpus: if with_gpu { crate::gpustat::snapshot() } else { Vec::new() },
        }
    })
    .await
    .map_err(|e| e.to_string())
}

/// The short commit this binary was compiled from (see `build.rs`), shown
/// beside the version in the side panel; `None` outside a git checkout.
#[tauri::command]
pub fn app_build_commit() -> Option<&'static str> {
    option_env!(crate::app_env!("BUILD_COMMIT"))
}

/// The background "Tabtivity (dev)" freeze, for the header's dev-build chip; `None`
/// when this binary was not built from a checkout (see `services::dev_build`).
/// Blocking-pool, because it reads a log tail and runs `git rev-list`. Each
/// poll also queues a freeze of a HEAD the commit hook could not queue from
/// inside an agent fence (`dev_build::queue_if_behind`).
#[tauri::command]
pub async fn dev_build_status() -> Option<crate::services::dev_build::DevBuildStatus> {
    tauri::async_runtime::spawn_blocking(|| {
        crate::services::dev_build::queue_if_behind();
        crate::services::dev_build::status()
    })
        .await
        .ok()
        .flatten()
}

/// Pause (cancelling a running compile) or resume the background "Tabtivity
/// (dev)" auto-builds, from the dev-build chip's switch. User-clicked only.
#[tauri::command]
pub async fn dev_build_set_paused(paused: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || crate::services::dev_build::set_paused(paused))
        .await
        .map_err(|e| e.to_string())?
}

/// Build HEAD once while the background "Tabtivity (dev)" auto-builds stay
/// paused, from the dev-build chip's "Build now"; a no-op when the installed
/// snapshot already is HEAD. User-clicked only.
#[tauri::command]
pub async fn dev_build_now() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(crate::services::dev_build::build_now)
        .await
        .map_err(|e| e.to_string())?
}

/// Close this frozen "Tabtivity (dev)" window and reopen it on the newest
/// snapshot: a detached helper waits for the exit and runs the launcher, which
/// adopts the snapshot. The close goes through the main window, so the quit is
/// the ordinary one (layout flush, tmux reap, `RunEvent::Exit`) and tabs
/// restore as after any relaunch. User-clicked only; refused outside the
/// frozen binary.
#[tauri::command]
pub async fn dev_build_relaunch(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    tauri::async_runtime::spawn_blocking(crate::services::dev_build::spawn_relauncher)
        .await
        .map_err(|e| e.to_string())??;
    match app.get_webview_window("main") {
        Some(main) => main.close().map_err(|e| e.to_string()),
        None => {
            app.exit(0);
            Ok(())
        }
    }
}

/// The checkout's todo groups for the side panel's Todo view; `None` outside a
/// dev build, which hides the view (see `services::dev_todo`).
#[tauri::command]
pub async fn dev_todo_groups() -> Result<Option<Vec<crate::services::dev_todo::TodoGroup>>, String> {
    tauri::async_runtime::spawn_blocking(crate::services::dev_todo::list)
        .await
        .map_err(|e| e.to_string())?
        .transpose()
}

#[tauri::command]
pub async fn dev_todo_read(name: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || crate::services::dev_todo::read(&name))
        .await
        .map_err(|e| e.to_string())?
}

/// A checkbox click's write-back: lands only while the file still reads
/// `expected`, else returns what is on disk now.
#[tauri::command]
pub async fn dev_todo_write(
    name: String,
    expected: String,
    next: String,
) -> Result<crate::services::dev_todo::WriteOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::services::dev_todo::write(&name, &expected, &next)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Resident size (KiB) of the largest webview *renderer* process under the app.
///
/// The renderer (WebKitWebProcess on Linux) holds the whole UI's JS heap in a
/// child process, and WebKitGTK does not implement `performance.memory`, so the
/// renderer cannot measure its own heap — the memory watchdog
/// (`src/lib/window/rendererWatchdog.ts`) reads it from the backend and reloads before
/// it OOMs. Returns the MAX rather than the sum: the failure mode is one runaway
/// renderer growing without bound (a 44 GB JS-heap leak observed 2026-07-31 in
/// a long HMR-heavy dev session, which then OOM-aborted and got amplified by
/// apport into a multi-GB core dump). `0` means no renderer was found — an
/// unsupported platform, or a tree not yet resolvable — which the caller treats
/// as "nothing to act on", never as "healthy".
///
/// **Unattributed** — it cannot say *which window's* renderer this is, and that
/// is why [`webview_renderer_rss`] superseded it for the watchdog: with a popout
/// open there are two renderers, and a main window reloading itself because the
/// *popout's* renderer was over the ceiling frees nothing and fires again 30 s
/// later (observed 2026-09-01: a 4.7 GB `win-1` renderer, and the main window
/// reloading every poll). Kept as the fallback a frontend uses when it is served
/// ahead of its backend — the hot-reloaded dev window against a stale binary.
///
/// This and the other `webview_renderer_*` commands are `async` on purpose: a
/// synchronous command runs on the main (GTK) thread, and each of these walks
/// the whole process table and reads a command line per descendant — a stall
/// of the very event loop that pumps every window's IPC, taken every couple of
/// seconds by the debug footer and every 30 s by each window's watchdog.
#[tauri::command]
pub async fn webview_rss_kib() -> u64 {
    tauri::async_runtime::spawn_blocking(largest_renderer_rss_kib)
        .await
        .unwrap_or(0)
}

fn largest_renderer_rss_kib() -> u64 {
    let root = app_process_root(std::process::id());
    crate::sysstat::descendant_pids(&[root])
        .into_iter()
        .filter(|&pid| is_webview_renderer(pid))
        .map(|pid| crate::sysstat::sum_rss_kib(&[pid]))
        .max()
        .unwrap_or(0)
}

/// One webview renderer process, with the window that has claimed it.
#[derive(Debug, Clone, Serialize)]
pub struct RendererRss {
    /// Tauri window label (`main`, `detached-…`) of the window whose page this
    /// process renders — as **claimed** by that window (see
    /// [`webview_renderer_claim`]). Empty until a window has claimed it.
    pub label: String,
    /// The claiming window's title, for a readout: a label is not a name a
    /// user recognises, "Tabtivity win-1" is. Empty when unclaimed.
    pub title: String,
    pub pid: u32,
    pub rss_kib: u64,
}

/// What one renderer's resident memory is made of — the watchdog's answer to
/// "4 GB of *what*?", written into crash.log beside the ceiling report.
#[derive(Debug, Clone, Serialize)]
pub struct RendererMemory {
    pub pid: u32,
    pub rss_kib: u64,
    pub anon_kib: u64,
    pub file_kib: u64,
    pub shmem_kib: u64,
    /// The largest mappings by resident size, by kernel name (`[anon]`,
    /// `[heap]`, a library, `memfd:…`), largest first.
    pub top: Vec<MappingRss>,
    /// The process's thread count, where `/proc` says. Beside the mapping
    /// names because they cannot tell a leaked Worker from a canvas — both are
    /// `[anon]` — and a renderer with hundreds of threads is exactly that: the
    /// main window was found holding 303 `WebCore: Worker` threads, one per
    /// pdf.js load that had failed mid-compile and was never destroyed
    /// (2026-09-08).
    pub threads: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MappingRss {
    pub name: String,
    pub rss_kib: u64,
}

/// The memory breakdown of one of this app's renderer processes. Only a pid
/// that [`webview_renderer_rss`] would list is read — a made-up pid gets `None`,
/// as does any platform without `/proc`.
#[tauri::command]
pub async fn webview_renderer_memory(pid: u32) -> Option<RendererMemory> {
    tauri::async_runtime::spawn_blocking(move || renderer_memory(pid))
        .await
        .ok()
        .flatten()
}

fn renderer_memory(pid: u32) -> Option<RendererMemory> {
    let root = app_process_root(std::process::id());
    let ours = crate::sysstat::descendant_pids(&[root]).contains(&pid) && is_webview_renderer(pid);
    if !ours {
        return None;
    }
    let (b, top) = crate::sysstat::process_memory(pid, 8)?;
    Some(RendererMemory {
        pid,
        rss_kib: b.rss_kib,
        anon_kib: b.anon_kib,
        file_kib: b.file_kib,
        shmem_kib: b.shmem_kib,
        top: top.into_iter().map(|(name, rss_kib)| MappingRss { name, rss_kib }).collect(),
        threads: crate::sysstat::process_threads(pid),
    })
}

/// Which window each renderer pid belongs to, as the windows reported it.
static RENDERER_CLAIMS: std::sync::Mutex<Vec<(u32, String)>> = std::sync::Mutex::new(Vec::new());

/// Resident size of **every** webview renderer under the app, each tagged with
/// the window that claimed it.
///
/// The per-window attribution is the whole point (see [`webview_rss_kib`] for
/// the loop it ends): each window's watchdog acts on its *own* renderer and
/// reloads *itself*, and the debug readout can name the window that is holding
/// 4 GB. The attribution is **not** something the engine will tell us — the
/// WebKitGTK API for it (`webkit_web_view_get_web_process_identifier`) is not
/// exported by the 2.52 library this builds against, and WebView2/WKWebView
/// have no equivalent — so the *windows* work it out themselves
/// (`src/lib/window/rendererWatchdog.ts`): a window allocates and touches a large
/// buffer while sampling this list before and after, and the one pid whose
/// RSS jumped by that much is its own. It then records the answer here so every
/// other window's readout can name it too. A claim is dropped the moment its
/// pid is no longer a live renderer (the process was replaced after a crash),
/// and a window that finds its claim gone simply probes again.
#[tauri::command]
pub async fn webview_renderer_rss(app: tauri::AppHandle) -> Vec<RendererRss> {
    tauri::async_runtime::spawn_blocking(move || renderer_rss(&app))
        .await
        .unwrap_or_default()
}

fn renderer_rss(app: &tauri::AppHandle) -> Vec<RendererRss> {
    use tauri::Manager;

    let root = app_process_root(std::process::id());
    let mut pids: Vec<u32> = crate::sysstat::descendant_pids(&[root])
        .into_iter()
        .filter(|&pid| is_webview_renderer(pid))
        .collect();
    pids.sort_unstable();

    let claims: Vec<(u32, String)> = {
        let mut guard = RENDERER_CLAIMS.lock().unwrap_or_else(|e| e.into_inner());
        guard.retain(|(pid, _)| pids.contains(pid));
        guard.clone()
    };

    pids.into_iter()
        .map(|pid| {
            let label = claims
                .iter()
                .find(|(p, _)| *p == pid)
                .map(|(_, l)| l.clone())
                .unwrap_or_default();
            let title = if label.is_empty() {
                String::new()
            } else {
                app.get_webview_window(&label)
                    .and_then(|w| w.title().ok())
                    .unwrap_or_default()
            };
            RendererRss {
                label,
                title,
                pid,
                rss_kib: crate::sysstat::sum_rss_kib(&[pid]),
            }
        })
        .collect()
}

/// A window reporting which renderer pid is its own (see
/// [`webview_renderer_rss`]). The label is taken from the calling window, never
/// from the payload, so a window can only ever speak for itself; a pid that is
/// not a live renderer under the app is refused. One claim per window and one
/// per pid — a re-probe after a crash replaces both sides.
#[tauri::command]
pub async fn webview_renderer_claim(window: tauri::WebviewWindow, pid: u32) -> Result<(), String> {
    let label = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || claim_renderer(label, pid))
        .await
        .map_err(|e| e.to_string())?
}

fn claim_renderer(label: String, pid: u32) -> Result<(), String> {
    let root = app_process_root(std::process::id());
    let live = crate::sysstat::descendant_pids(&[root])
        .into_iter()
        .any(|p| p == pid && is_webview_renderer(p));
    if !live {
        return Err(format!("pid {pid} is not a webview renderer of this app"));
    }
    let mut guard = RENDERER_CLAIMS.lock().unwrap_or_else(|e| e.into_inner());
    guard.retain(|(p, l)| *p != pid && *l != label);
    guard.push((pid, label));
    Ok(())
}

/// When each window last had its renderer replaced by [`webview_renderer_restart`].
static RENDERER_RESTARTS: std::sync::Mutex<Vec<(String, std::time::Instant)>> =
    std::sync::Mutex::new(Vec::new());

/// A window that just had its renderer replaced is refused another one for this
/// long. The frontend keeps the same cooldown in `sessionStorage`, but that
/// storage may not outlive the very process this replaces — and a window whose
/// renderer attribution is wrong (it is watching another window's pid) would
/// otherwise replace its own healthy renderer every poll, for as long as the
/// other one stays big. Held here, the loop is bounded by the process that
/// cannot lose count.
const RENDERER_RESTART_COOLDOWN: std::time::Duration = std::time::Duration::from_secs(10 * 60);

/// Replace the calling window's renderer process — the memory watchdog's second
/// step, for memory a reload did not free.
///
/// A `location.reload()` drops the page's JS heap, and on 2026-09-07 that was
/// not where the memory was: the main window, holding nothing but agent
/// terminals, climbed at ~150 MB/min, and a reload took it from 6.7 GB to
/// 4.8 GB — the rest was anonymous memory owned by the WebKitWebProcess itself
/// (allocator retention, compositor and canvas buffers, whatever the engine
/// keeps across documents), which no page-level action can reach. The one
/// thing that frees a web process's memory for certain is a new web process:
/// WebKit's `terminate_web_process` ends it the way a crash would, and the
/// reload that follows spawns a fresh one and loads the page into it. Tabs
/// restore and the backend-owned PTYs reattach exactly as after a reload; the
/// cost is the same ~1 s blink plus a cold engine. The crash reporter's
/// handler sees `TerminatedByApi` and stays out of it (that reload is ours,
/// and it must not count against the crash-reload cap).
///
/// Linux only: WebView2 and WKWebView expose no way to end a content process.
/// There the command fails and the window holds as before. Refused inside
/// [`RENDERER_RESTART_COOLDOWN`] of the window's previous replacement.
#[tauri::command]
pub fn webview_renderer_restart(window: tauri::WebviewWindow) -> Result<(), String> {
    let label = window.label().to_string();
    {
        let now = std::time::Instant::now();
        let mut guard = RENDERER_RESTARTS.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((_, at)) = guard.iter().find(|(l, _)| *l == label) {
            if now.duration_since(*at) < RENDERER_RESTART_COOLDOWN {
                return Err(format!(
                    "renderer of '{label}' was already replaced {} s ago; not again within {} min",
                    now.duration_since(*at).as_secs(),
                    RENDERER_RESTART_COOLDOWN.as_secs() / 60
                ));
            }
        }
        guard.retain(|(l, _)| *l != label);
        guard.push((label.clone(), now));
    }
    restart_renderer(&window, &label)
}

#[cfg(target_os = "linux")]
fn restart_renderer(window: &tauri::WebviewWindow, label: &str) -> Result<(), String> {
    crate::crash_log_append(&format!(
        "=== WEBVIEW '{label}' RENDERER REPLACED {} (memory watchdog: a reload did not free it) ===",
        crate::iso_now()
    ));
    window
        .with_webview(|webview| {
            use webkit2gtk::WebViewExt;
            let view = webview.inner();
            view.terminate_web_process();
            // The reload goes through the main loop once, so the termination
            // (and its `web-process-terminated` signal) has fully settled before
            // a new process is asked for.
            let view = view.clone();
            gtk::glib::idle_add_local_once(move || view.reload());
        })
        .map_err(|e| e.to_string())
}

#[cfg(not(target_os = "linux"))]
fn restart_renderer(_window: &tauri::WebviewWindow, label: &str) -> Result<(), String> {
    Err(format!(
        "cannot replace the renderer of '{label}': this engine exposes no way to end a content process"
    ))
}

/// A webview *content* process, across the engines Tabtivity ships on: WebKitGTK
/// (Linux), WebKit (macOS: `com.apple.WebKit.WebContent`), WebView2 (Windows:
/// `msedgewebview2`). Matched on the command line, not `comm` — Linux truncates
/// the latter to 15 bytes (`WebKitWebProces`), so a `comm` match would miss it.
fn is_webview_renderer(pid: u32) -> bool {
    crate::sysstat::cmdline(pid).is_some_and(|cmd| {
        cmd.contains("WebKitWebProcess")
            || cmd.contains("WebContent")
            || cmd.contains("msedgewebview2")
    })
}

/// Walk up to the process that owns the running app. In `tauri dev` the useful
/// total is the npm/tauri/vite tree, so we climb to the highest ancestor whose
/// command line names the dev runner. Where the backend can't read command lines
/// (Windows, and packaged builds), no ancestor matches and this returns `pid`
/// itself — which is exactly the app process in a packaged build.
fn app_process_root(pid: u32) -> u32 {
    let mut current = pid;
    let mut best = pid;

    for _ in 0..16 {
        let Some(ppid) = crate::sysstat::ppid(current) else {
            break;
        };
        if ppid <= 1 {
            break;
        }

        let cmd = crate::sysstat::cmdline(ppid).unwrap_or_default();
        if cmd.contains("tauri dev") || cmd.contains("npm run tauri") {
            best = ppid;
        }
        current = ppid;
    }

    best
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn process_root_includes_current_process() {
        assert!(app_process_root(std::process::id()) > 0);
    }
}
