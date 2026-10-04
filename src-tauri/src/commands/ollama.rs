use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::{Duration, Instant};

// ── Detailed model info ───────────────────────────────────────────────────

/// Full details for a locally installed Ollama model.
#[derive(serde::Serialize, Clone)]
pub struct OllamaModelInfo {
    pub name: String,
    /// Total disk size in bytes
    pub size: u64,
    /// e.g. "8B"
    pub parameter_size: Option<String>,
    /// e.g. "Q4_0"
    pub quantization: Option<String>,
    /// e.g. "llama"
    pub family: Option<String>,
    /// Currently loaded in memory
    pub running: bool,
    /// VRAM bytes in use (non-zero → GPU)
    pub size_vram: u64,
    /// Ollama's own capability list for this model — `"completion"`, `"tools"`,
    /// `"vision"`, `"thinking"`, `"embedding"`. Empty means *we could not ask*
    /// (server down mid-read, an Ollama too old to report them), never "none":
    /// every consumer treats an empty list as unknown, because hiding a working
    /// agent is a worse failure than offering one that then errors.
    pub capabilities: Vec<String>,
    /// The manifest digest `/api/tags` reports. Load-bearing twice over: it is
    /// what [`model_capabilities`] caches against (capabilities are a property
    /// of the manifest, so the cache can only go stale when this changes, i.e.
    /// on a re-pull), and it is the *same* value the registry answers for
    /// `<name>:<tag>`, which is what makes an update check one HEAD request.
    pub digest: String,
    /// Bytes the model holds while resident (`/api/ps` `size`, which is not
    /// the disk size: it includes the KV cache). `0` unless `running`.
    pub loaded_size: u64,
    /// `/api/ps` `expires_at`, verbatim. `None` unless `running`.
    pub expires_at: Option<String>,
    /// Resident with no expiry in sight — the `keep_alive: -1` loads, which
    /// Ollama reports as an `expires_at` centuries away. See [`keep_alive_of`].
    pub pinned: bool,
    /// Whole seconds until Ollama unloads it; `None` when pinned, idle, or the
    /// expiry is unreadable or already past.
    pub expires_in_secs: Option<u64>,
    /// An Ollama cloud model (its `/api/tags` entry names a `remote_host` /
    /// `remote_model`): listed, but there is nothing on this machine to load.
    pub remote: bool,
}

/// An entry in the built-in catalog of installable models.
#[derive(serde::Serialize, Clone)]
pub struct CatalogEntry {
    pub name: String,
    pub description: String,
    /// Available size tags e.g. ["1b", "3b", "7b"]
    pub tags: Vec<String>,
    /// Human-readable disk-size hint e.g. "1.3 GB – 2 GB"
    pub size_hint: String,
}

// ── Where the server is ───────────────────────────────────────────────────

/// The endpoint every request here uses when `Settings::ollama_host` says
/// nothing — which is what it said for every install that predates #201a.
const DEFAULT_OLLAMA_ADDR: &str = "127.0.0.1:11434";
const DEFAULT_OLLAMA_PORT: u16 = 11434;

/// The `host:port` this module connects to, per `Settings::ollama_host`.
///
/// Read on every call rather than cached: a settings write is not an event this
/// module hears, and the alternative is a stale endpoint that survives until
/// relaunch. It is one small JSON read against a file the app already keeps hot.
fn ollama_addr() -> Result<String, String> {
    let settings = read_settings();
    resolve_ollama_addr(
        settings.as_ref().and_then(|s| s.ollama_host.as_deref()),
        settings
            .as_ref()
            .and_then(|s| s.ollama_allow_remote_host)
            .unwrap_or(false),
    )
}

fn read_settings() -> Option<crate::schema::Settings> {
    let path = crate::storage::state_dir().join("settings.json");
    path.exists()
        .then(|| crate::storage::read_json::<crate::schema::Settings>(&path).ok())
        .flatten()
}

/// The user's chosen `OLLAMA_MODELS` directory (`Settings::ollama_models_path`),
/// trimmed and dropped when empty. Read on every use for `ollama_addr`'s reason:
/// a settings write is not an event this module hears.
fn configured_models_dir() -> Option<std::path::PathBuf> {
    read_settings()
        .and_then(|s| s.ollama_models_path)
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .map(std::path::PathBuf::from)
}

/// The pure core of [`ollama_addr`]: what the user wrote → what we dial.
///
/// Liberal about spelling (Ollama's own `OLLAMA_HOST` accepts most of these, and
/// the value is usually copied from there) and strict about the two things that
/// change what the feature *is*:
///
/// * **`https://` is an error, never a downgrade.** This transport is a raw
///   `TcpStream` speaking HTTP/1.0; it has no TLS and cannot grow one here.
///   Connecting in the clear to an endpoint the user wrote as TLS would put
///   their prompts on the wire unencrypted while the setting says otherwise —
///   the one failure worth refusing to start for.
/// * **A non-loopback host needs `allow_remote`.** Judged on the literal, not on
///   a resolution: the question is what the user stated, and a name that
///   resolves to loopback today is not a promise about tomorrow. The
///   conservative direction is the safe one — the worst it costs is an opt-in
///   for a hostname that was local anyway.
///
/// `0.0.0.0`/`::` are *bind* addresses, and are the likeliest thing to be pasted
/// in from an `OLLAMA_HOST` that was written for the server side; they are read
/// as loopback rather than refused, since that is both what they mean here and
/// what dialling them would do anyway.
///
/// The result is interpolated into a request line and a `Host:` header, so a
/// host carrying a control character is rejected outright — this builds HTTP by
/// string concatenation, and that is header injection.
pub(crate) fn resolve_ollama_addr(raw: Option<&str>, allow_remote: bool) -> Result<String, String> {
    let raw = raw.map(str::trim).unwrap_or("");
    if raw.is_empty() {
        return Ok(DEFAULT_OLLAMA_ADDR.to_string());
    }

    let rest = if let Some(r) = raw.strip_prefix("http://") {
        r
    } else if let Some(r) = raw.strip_prefix("https://") {
        let _ = r;
        return Err(format!(
            "Ollama host `{raw}` asks for HTTPS, which {app}'s Ollama transport \
             cannot speak — it would have to connect in the clear instead, and \
             sending prompts unencrypted to an address written as `https://` is \
             not something to do quietly. Use `http://` (or drop the scheme) for \
             a server on this machine.", app = crate::brand::DISPLAY
        ));
    } else if let Some((scheme, _)) = raw.split_once("://") {
        return Err(format!(
            "Ollama host `{raw}` names the `{scheme}` scheme; only `http://` (or \
             no scheme at all) is supported."
        ));
    } else {
        raw
    };

    // Drop a path or trailing slash — `http://127.0.0.1:11434/` is what a browser
    // hands you when you copy the address of a running server.
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("").trim();

    // A bare number is a port, not a host — `OLLAMA_HOST=11500` is a spelling
    // Ollama itself documents, so it is the one most likely to be copied across.
    if let Ok(port) = authority.parse::<u16>() {
        return Ok(format!("127.0.0.1:{port}"));
    }

    let (host, port) = split_host_port(authority)
        .ok_or_else(|| format!("Ollama host `{raw}` is not a `host:port` address."))?;

    let host = match host {
        "" => "127.0.0.1",
        // Bind-all pasted into a connect field.
        "0.0.0.0" => "127.0.0.1",
        "::" => "::1",
        h => h,
    };

    if host.is_empty()
        || host
            .chars()
            .any(|c| c.is_control() || c.is_whitespace() || c == '\\')
    {
        return Err(format!(
            "Ollama host `{raw}` contains characters a host cannot have."
        ));
    }

    if !host_is_loopback(host) && !allow_remote {
        return Err(format!(
            "Ollama host `{host}` is another machine, so every prompt and every \
             file an agent reads would leave this one. That is off by default for \
             a local-model feature — set `ollama_allow_remote_host` to true in \
             settings.json if it is what you want."
        ));
    }

    Ok(if host.contains(':') {
        // IPv6 literal — the brackets are what keep the port unambiguous.
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    })
}

/// Split an authority into host and port, understanding the bracketed IPv6 form.
/// `None` when the port is present but not a port.
fn split_host_port(authority: &str) -> Option<(&str, u16)> {
    if let Some(rest) = authority.strip_prefix('[') {
        let (host, after) = rest.split_once(']')?;
        return match after {
            "" => Some((host, DEFAULT_OLLAMA_PORT)),
            p => Some((host, p.strip_prefix(':')?.parse().ok()?)),
        };
    }
    // An unbracketed value with more than one colon is a bare IPv6 literal;
    // there is no port in it to find.
    if authority.matches(':').count() > 1 {
        return Some((authority, DEFAULT_OLLAMA_PORT));
    }
    match authority.split_once(':') {
        None => Some((authority, DEFAULT_OLLAMA_PORT)),
        Some((host, "")) => Some((host, DEFAULT_OLLAMA_PORT)),
        Some((host, port)) => Some((host, port.parse().ok()?)),
    }
}

/// How long to wait for the TCP handshake. Nothing to do with the 600 s *read*
/// timeout beside it, which covers a model pull between chunks.
///
/// It exists because `ollama_host` can now name another machine, and a bare
/// `TcpStream::connect` at a host that is off, firewalled or simply mistyped
/// blocks for the OS TCP timeout — minutes — inside a `#[tauri::command]`,
/// which is the window-freeze this repo has already paid for twice (a locked
/// keyring, a disconnected remote project's git reads). A loopback port that
/// nothing is listening on refuses instantly and never reaches this bound, so
/// the default configuration is unchanged.
const OLLAMA_CONNECT_TIMEOUT: Duration = Duration::from_secs(4);

/// Open a connection to an already-resolved `host:port`, bounded.
fn connect_ollama(addr: &str) -> Result<TcpStream, String> {
    use std::net::ToSocketAddrs;
    // `not_running` for every failure, resolution included: it is the sentinel
    // the whole 🧠 surface already branches on, and "the name does not resolve"
    // and "nothing answers" are the same thing to a caller that wants a model.
    addr.to_socket_addrs()
        .ok()
        .and_then(|mut it| {
            it.find_map(|sa| TcpStream::connect_timeout(&sa, OLLAMA_CONNECT_TIMEOUT).ok())
        })
        .ok_or_else(|| "not_running".to_string())
}

/// Whether a host *literal* names this machine. Deliberately no DNS: see
/// [`resolve_ollama_addr`].
pub(crate) fn host_is_loopback(host: &str) -> bool {
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    match host.parse::<std::net::IpAddr>() {
        Ok(ip) => ip.is_loopback() || ip.is_unspecified(),
        // `foo.localhost` resolves to loopback by convention (RFC 6761).
        Err(_) => host.to_ascii_lowercase().ends_with(".localhost"),
    }
}

// ── HTTP helper ───────────────────────────────────────────────────────────

/// Send a request to the local Ollama REST API and return the response body.
/// Uses HTTP/1.0 to avoid chunked transfer encoding.
pub(crate) fn ollama_http(
    method: &str,
    path: &str,
    json_body: Option<&str>,
) -> Result<String, String> {
    let addr = ollama_addr()?;
    let mut stream = connect_ollama(&addr)?;
    // 10-minute timeout accommodates large model pulls
    stream
        .set_read_timeout(Some(Duration::from_secs(600)))
        .map_err(|e| format!("set timeout: {e}"))?;

    let req = match json_body {
        Some(body) => format!(
            "{method} {path} HTTP/1.0\r\nHost: {addr}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        ),
        None => format!("{method} {path} HTTP/1.0\r\nHost: {addr}\r\n\r\n"),
    };

    stream
        .write_all(req.as_bytes())
        .map_err(|e| format!("write: {e}"))?;

    let mut raw = String::new();
    stream
        .read_to_string(&mut raw)
        .map_err(|e| format!("read: {e}"))?;

    let status: u16 = raw
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|s| s.parse().ok())
        .unwrap_or(200);

    let body = raw.split("\r\n\r\n").nth(1).unwrap_or("").to_owned();

    if status >= 400 {
        let msg = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| v["error"].as_str().map(String::from))
            .unwrap_or_else(|| format!("HTTP {status}"));
        return Err(friendly_ollama_error(&msg));
    }

    Ok(body)
}

/// Rewrite a raw Ollama error into a clearer, actionable message for the failure
/// modes that otherwise surface as an opaque HTTP 500 / "internal server error"
/// (e.g. when driven through vibe). Currently detects a broken install whose
/// inference runner (`llama-server`) is missing: Ollama answers API requests but
/// cannot load any model, so every generate/chat call 500s. Unrecognised errors
/// pass through unchanged. Pure + tested.
fn friendly_ollama_error(raw: &str) -> String {
    let lower = raw.to_ascii_lowercase();
    if lower.contains("llama-server") && lower.contains("not found") {
        let cmd = ollama_install_cmd();
        return format!(
            "Ollama's inference runner (llama-server) is missing, so Ollama can \
            serve its API but cannot load any model — the install is incomplete. \
            Reinstall Ollama with `{cmd}`."
        );
    }
    raw.to_string()
}

// ── New management commands ───────────────────────────────────────────────

// PATH lookups go through the shared, cross-platform `crate::paths::binary_on_path`
// (`where` on Windows, `which` elsewhere); see that module for the rationale.
use crate::paths::binary_on_path;

/// True when the `ollama` binary is available. Checks PATH first, then (on
/// Windows) the well-known per-user install location, since winget/the GUI
/// installer drop `ollama.exe` under `%LOCALAPPDATA%\Programs\Ollama` and a
/// running Tabtivity's inherited PATH won't pick it up until a new session.
#[tauri::command]
pub async fn ollama_is_installed() -> bool {
    if binary_on_path("ollama") {
        return true;
    }
    if cfg!(target_os = "windows") {
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            if std::path::Path::new(&local)
                .join("Programs")
                .join("Ollama")
                .join("ollama.exe")
                .exists()
            {
                return true;
            }
        }
    }
    false
}

/// The manual download page, offered as a last-resort fallback on every OS.
pub const OLLAMA_DOWNLOAD_URL: &str = "https://ollama.com/download";

/// The recommended Ollama install command for the host OS. Kept here so the
/// backend installer, the error messages, and the UI's copy-to-clipboard
/// fallback all stay in sync with whatever the installer actually runs.
///
/// - Windows: winget (present on all supported Windows 10/11 builds).
/// - Linux/macOS: the official distro-agnostic install script.
pub fn ollama_install_cmd() -> &'static str {
    if cfg!(target_os = "windows") {
        "winget install --id Ollama.Ollama -e --silent --accept-source-agreements --accept-package-agreements"
    } else {
        "curl -fsSL https://ollama.com/install.sh | sh"
    }
}

/// Install Ollama using the host OS's native package mechanism, streaming its
/// combined stdout+stderr to the frontend line-by-line via
/// `ollama-install-progress` events (`{ line }`) so the UI can show live progress.
///
/// Per-OS strategy (see [`ollama_install_cmd`]):
/// - **Windows**: `winget install --id Ollama.Ollama …` (silent, per-user). winget
///   ships with all supported Windows 10/11 builds; if it is absent or fails, the
///   UI falls back to the manual command + the ollama.com download link.
/// - **Linux/macOS**: the official `curl … install.sh | sh` script. It needs root
///   to drop the binary and register the systemd service; it invokes `sudo` itself,
///   so a non-interactive run only succeeds with passwordless sudo or as root.
///
/// Returns the install log on success, or the tail of the output on failure.
#[tauri::command]
pub async fn install_ollama(app: tauri::AppHandle) -> Result<String, String> {
    use std::io::{BufRead, BufReader};
    use tauri::Emitter;

    if ollama_is_installed().await {
        return Ok("Ollama is already installed.".to_string());
    }

    let cmd = ollama_install_cmd();

    // Build the OS-native invocation. We merge stderr into stdout (`2>&1`) at the
    // shell level so a single reader sees every line in order. On unsupported
    // platforms there is no automated path — point at the manual download.
    let (program, args): (&str, Vec<String>) = if cfg!(target_os = "windows") {
        ("cmd", vec!["/C".into(), format!("{cmd} 2>&1")])
    } else if cfg!(any(target_os = "linux", target_os = "macos")) {
        ("sh", vec!["-c".into(), format!("{cmd} 2>&1")])
    } else {
        return Err(format!(
            "Automatic install isn't supported on this OS. Download Ollama from {OLLAMA_DOWNLOAD_URL}."
        ));
    };

    // Per-OS hint appended to failure messages (the likely reason it didn't take).
    let fail_hint: &str = if cfg!(target_os = "windows") {
        "It may need winget (App Installer) or administrator rights"
    } else {
        "It likely needs sudo"
    };

    let emit = |line: &str| {
        let _ = app.emit(
            "ollama-install-progress",
            serde_json::json!({ "line": line }),
        );
    };
    emit("Starting Ollama installer…");

    // `command_no_window` suppresses the transient console window the `cmd`/`sh`
    // wrapper would otherwise pop on Windows; progress is surfaced in-app via the
    // piped stdout below.
    let mut child = crate::paths::command_no_window(program)
        .args(&args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to launch installer: {e}"))?;

    let mut lines: Vec<String> = Vec::new();
    if let Some(stdout) = child.stdout.take() {
        for line in BufReader::new(stdout).lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => break,
            };
            emit(&line);
            lines.push(line);
        }
    }

    let status = child
        .wait()
        .map_err(|e| format!("installer did not finish: {e}"))?;
    let combined = lines.join("\n");
    let combined = combined.trim().to_string();

    if !status.success() {
        let tail: Vec<&str> = combined.lines().rev().take(20).collect();
        let tail = tail.into_iter().rev().collect::<Vec<_>>().join("\n");
        return Err(if tail.is_empty() {
            format!(
                "installer exited unsuccessfully ({status}). {fail_hint} — \
                run `{cmd}` in a terminal."
            )
        } else {
            tail
        });
    }

    // The post-install check is the real source of truth: an installer can print a
    // warning to stderr yet still have placed the binary, or vice versa.
    if !ollama_is_installed().await {
        return Err(format!(
            "installer ran but `ollama` is still not detected. {fail_hint}, or it \
            may need a fresh session so the install dir is on PATH — run `{cmd}` in \
            a terminal.\n\n{combined}"
        ));
    }

    emit("Done.");
    Ok(if combined.is_empty() {
        "Ollama installed.".to_string()
    } else {
        combined
    })
}

/// OS-appropriate install guidance for the frontend, so the UI can render the
/// right command and wording without hardcoding a platform. `auto` is true when
/// [`install_ollama`] can drive the install itself on this OS.
#[derive(serde::Serialize, Clone)]
pub struct OllamaInstallStrategy {
    /// "windows" | "macos" | "linux" | "unknown".
    pub os: String,
    /// The exact command Tabtivity runs / the user can copy-paste.
    pub command: String,
    /// Whether one-click `install_ollama` is supported on this OS.
    pub auto: bool,
    /// Manual download page, always provided as a last resort.
    pub download_url: String,
}

/// Report the OS-dependent Ollama install strategy (detect OS + suggest command).
#[tauri::command]
pub async fn ollama_install_strategy() -> OllamaInstallStrategy {
    let os = if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "unknown"
    };
    OllamaInstallStrategy {
        os: os.to_string(),
        command: ollama_install_cmd().to_string(),
        auto: cfg!(any(
            target_os = "windows",
            target_os = "linux",
            target_os = "macos"
        )),
        download_url: OLLAMA_DOWNLOAD_URL.to_string(),
    }
}

// ── Vibe (local-model agent runtime) ──────────────────────────────────────
//
// Local Ollama models are driven through Mistral's `vibe` CLI (the Local Model
// tab spawns `vibe` with a per-model VIBE_HOME). Vibe is a separate install
// from Ollama itself, so without it the tab fails with "unable to spawn vibe".
// We surface install/detection here, alongside the Ollama installer, so the
// Ollama settings window can guide the user through the full prerequisite.

/// The official Vibe install command for the host OS. Kept here so the backend
/// installer, the error messages, and the UI's copy-to-clipboard fallback all
/// stay in sync with whatever the installer actually runs. Both paths install
/// per-user (no administrator rights / `sudo`).
///
/// - **Windows**: install Astral's `uv` (per-user, into `%USERPROFILE%\.local\bin`)
///   via its PowerShell installer, then `uv tool install mistral-vibe`, which drops
///   `vibe.exe` alongside it. uv isn't on `PATH` in the same session that just
///   installed it, so the command invokes `uv.exe` by full path to work in one shot.
/// - **Linux/macOS**: the official `curl … install.sh | bash` script (installs via
///   `uv` into `~/.local/bin`).
pub fn vibe_install_cmd() -> &'static str {
    if cfg!(target_os = "windows") {
        // PowerShell. The second statement calls uv by full path because the
        // freshly-installed uv is not yet on this session's PATH.
        "irm https://astral.sh/uv/install.ps1 | iex; & \"$env:USERPROFILE\\.local\\bin\\uv.exe\" tool install mistral-vibe"
    } else {
        "curl -LsSf https://mistral.ai/vibe/install.sh | bash"
    }
}

/// True when the `vibe` binary is reachable. Checks `PATH` (cross-platform, via
/// `where`/`which`) and the well-known user install locations the installer uses,
/// since Tabtivity's inherited `PATH` may omit `~/.local/bin` even when a login shell
/// would include it.
#[tauri::command]
pub async fn vibe_is_installed() -> bool {
    if binary_on_path("vibe") {
        return true;
    }
    let home = crate::paths::home_dir();
    [".local/bin/vibe", ".cargo/bin/vibe"].iter().any(|rel| {
        let base = home.join(rel);
        if base.exists() {
            return true;
        }
        // On Windows the install dir holds `vibe.exe` (the uv tool shim), which
        // the bare extensionless relative path misses.
        cfg!(target_os = "windows")
            && ["exe", "cmd", "bat", "ps1"]
                .iter()
                .any(|ext| base.with_extension(ext).exists())
    })
}

/// Install the Vibe CLI via its official per-user install command (see
/// [`vibe_install_cmd`]).
///
/// Streams the installer's combined stdout+stderr to the frontend line-by-line via
/// `vibe-install-progress` events (`{ line }`) so the UI can show live progress. The
/// install is per-user (no `sudo` / administrator rights), so this runs
/// non-interactively. Returns the install log on success, or the tail of the output
/// on failure.
///
/// Per-OS the command is driven through the native shell: PowerShell on Windows
/// (uv → `uv tool install mistral-vibe`), the POSIX shell on Linux/macOS.
#[tauri::command]
pub async fn install_vibe(app: tauri::AppHandle) -> Result<String, String> {
    use std::io::{BufRead, BufReader};
    use tauri::Emitter;

    if vibe_is_installed().await {
        return Ok("Vibe is already installed.".to_string());
    }

    let cmd = vibe_install_cmd();

    // Build the OS-native invocation, merging stderr into stdout (`2>&1`) so a
    // single reader sees every line in order.
    let (program, args): (&str, Vec<String>) = if cfg!(target_os = "windows") {
        (
            "powershell",
            vec![
                "-NoProfile".into(),
                "-ExecutionPolicy".into(),
                "Bypass".into(),
                "-Command".into(),
                format!("{cmd} 2>&1"),
            ],
        )
    } else if cfg!(any(target_os = "linux", target_os = "macos")) {
        ("sh", vec!["-c".into(), format!("{cmd} 2>&1")])
    } else {
        return Err("Automatic install isn't supported on this OS. \
            See https://docs.mistral.ai/getting-started/quickstarts/vibe-code/install-cli."
            .to_string());
    };

    let emit = |line: &str| {
        let _ = app.emit("vibe-install-progress", serde_json::json!({ "line": line }));
    };
    emit("Starting Vibe installer…");

    // `command_no_window` suppresses the transient console window the PowerShell/
    // `sh` wrapper would otherwise pop on Windows; progress is surfaced in-app.
    let mut child = crate::paths::command_no_window(program)
        .args(&args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to launch installer: {e}"))?;

    let mut lines: Vec<String> = Vec::new();
    if let Some(stdout) = child.stdout.take() {
        for line in BufReader::new(stdout).lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => break,
            };
            emit(&line);
            lines.push(line);
        }
    }

    let status = child
        .wait()
        .map_err(|e| format!("installer did not finish: {e}"))?;
    let combined = lines.join("\n").trim().to_string();

    if !status.success() {
        let tail: Vec<&str> = combined.lines().rev().take(20).collect();
        let tail = tail.into_iter().rev().collect::<Vec<_>>().join("\n");
        return Err(if tail.is_empty() {
            format!("installer exited unsuccessfully ({status}). Run `{cmd}` in a terminal.")
        } else {
            tail
        });
    }

    // The post-install check is the real source of truth.
    if !vibe_is_installed().await {
        return Err(format!(
            "installer ran but `vibe` is still not detected. It may need a new shell so \
            the install dir (`~/.local/bin`) is on PATH — run `{cmd}` in a terminal.\n\n{combined}"
        ));
    }

    emit("Done.");
    Ok(if combined.is_empty() {
        "Vibe installed.".to_string()
    } else {
        combined
    })
}

/// OS-appropriate Vibe install guidance for the frontend, so the UI renders the
/// right command and wording without hardcoding a platform. `auto` is true when
/// [`install_vibe`] can drive the install itself on this OS.
#[derive(serde::Serialize, Clone)]
pub struct VibeInstallStrategy {
    /// "windows" | "macos" | "linux" | "unknown".
    pub os: String,
    /// The exact command Tabtivity runs / the user can copy-paste.
    pub command: String,
    /// Whether one-click `install_vibe` is supported on this OS.
    pub auto: bool,
    /// Docs URL, always provided as a last resort.
    pub docs: String,
}

/// Report the OS-dependent Vibe install strategy (detect OS + suggest command).
#[tauri::command]
pub async fn vibe_install_strategy() -> VibeInstallStrategy {
    let os = if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "unknown"
    };
    VibeInstallStrategy {
        os: os.to_string(),
        command: vibe_install_cmd().to_string(),
        auto: cfg!(any(
            target_os = "windows",
            target_os = "linux",
            target_os = "macos"
        )),
        docs: "https://docs.mistral.ai/getting-started/quickstarts/vibe-code/install-cli"
            .to_string(),
    }
}

/// Capability lists keyed by *manifest digest*, not by model name. A model's
/// capabilities are fixed by its manifest, so a digest that has been read once
/// can never need re-reading — and a re-pull (the one thing that changes them)
/// changes the digest, which misses the cache by construction. Without this,
/// `list_ollama_models_detailed` — called on every hover of the 🧠 menu, by the
/// editor's autocomplete and by the autoload store — would spend one `/api/show`
/// round trip per installed model per call.
static CAPABILITY_CACHE: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<String, Vec<String>>>,
> = std::sync::OnceLock::new();

/// Ollama's capability list for `model`, cached against `digest`.
///
/// An empty vec is returned for every failure — an unreachable server, an
/// Ollama predating the `capabilities` field, a malformed body. That is
/// deliberate and every caller must honour it: **empty means "we could not
/// ask", never "this model supports nothing"**. Treating the two alike is what
/// would make a transient probe failure silently hide every agent in the
/// new-tab menu.
fn model_capabilities(model: &str, digest: &str) -> Vec<String> {
    let cache = CAPABILITY_CACHE.get_or_init(Default::default);
    if !digest.is_empty() {
        if let Ok(map) = cache.lock() {
            if let Some(hit) = map.get(digest) {
                return hit.clone();
            }
        }
    }

    let body = serde_json::json!({ "model": model }).to_string();
    let caps: Vec<String> = ollama_http("POST", "/api/show", Some(&body))
        .ok()
        .and_then(|b| serde_json::from_str::<serde_json::Value>(&b).ok())
        .and_then(|v| v["capabilities"].as_array().cloned())
        .unwrap_or_default()
        .iter()
        .filter_map(|c| c.as_str().map(String::from))
        .collect();

    // Only a positive answer is cached: caching an empty list would freeze a
    // transient failure in for the rest of the session.
    if !digest.is_empty() && !caps.is_empty() {
        if let Ok(mut map) = cache.lock() {
            map.insert(digest.to_string(), caps.clone());
        }
    }
    caps
}

/// The installed models that *do* support tool calls, for the "pick one of
/// these instead" half of a refusal. Read off this machine rather than a
/// hardcoded example list, which would age as the registry moves.
fn tool_capable_models() -> Vec<String> {
    ollama_http("GET", "/api/tags", None)
        .ok()
        .and_then(|b| serde_json::from_str::<serde_json::Value>(&b).ok())
        .and_then(|v| v["models"].as_array().cloned())
        .unwrap_or_default()
        .iter()
        .filter_map(|m| {
            let name = m["name"].as_str()?;
            let digest = m["digest"].as_str().unwrap_or("");
            model_capabilities(name, digest)
                .iter()
                .any(|c| c == "tools")
                .then(|| name.to_string())
        })
        .collect()
}

/// Whether `model` carries `cap` — `Some(false)` only when Ollama positively
/// said so. `None` is "could not tell", which every caller reads as "let it
/// through": see [`model_capabilities`].
fn model_has_capability(model: &str, cap: &str) -> Option<bool> {
    let digest = ollama_http("GET", "/api/tags", None)
        .ok()
        .and_then(|b| serde_json::from_str::<serde_json::Value>(&b).ok())
        .and_then(|v| v["models"].as_array().cloned())
        .unwrap_or_default()
        .iter()
        .find(|m| m["name"].as_str() == Some(model))
        .and_then(|m| m["digest"].as_str().map(String::from))
        .unwrap_or_default();

    let caps = model_capabilities(model, &digest);
    if caps.is_empty() {
        return None;
    }
    Some(caps.iter().any(|c| c == cap))
}

/// Ollama's capability list for `model`, resolved through one `/api/tags` read
/// for the manifest digest and the digest-keyed [`model_capabilities`] cache.
///
/// **Empty means "could not ask", never "supports nothing"** — the same rule
/// [`model_capabilities`] documents. `services::mail_ai` reads it to refuse an
/// embedding-only model, and honours the empty-is-unknown contract by allowing
/// through anything it cannot classify.
pub(crate) fn capabilities_of(model: &str) -> Vec<String> {
    let digest = ollama_http("GET", "/api/tags", None)
        .ok()
        .and_then(|b| serde_json::from_str::<serde_json::Value>(&b).ok())
        .and_then(|v| v["models"].as_array().cloned())
        .unwrap_or_default()
        .iter()
        .find(|m| m["name"].as_str() == Some(model))
        .and_then(|m| m["digest"].as_str().map(String::from))
        .unwrap_or_default();
    model_capabilities(model, &digest)
}

/// Whether `model` can drive tool/function calls.
fn model_supports_tools(model: &str) -> Option<bool> {
    model_has_capability(model, "tools")
}

/// Whether `model` can *think* — i.e. Ollama will accept a request carrying a
/// reasoning field. A model without it is not merely non-reasoning: Ollama
/// **rejects the whole request** with `"<model>" does not support thinking`, so
/// an agent that sends a reasoning effort by default (Codex does — its
/// `model_reasoning_effort` defaults to `medium`, and the user's own
/// `~/.codex/config.toml` usually sets it explicitly) dies on its first turn.
fn model_supports_thinking(model: &str) -> Option<bool> {
    model_has_capability(model, "thinking")
}

/// Return detailed info for every locally installed model, cross-referenced
/// with the running-models list from /api/ps.
#[tauri::command]
pub async fn list_ollama_models_detailed() -> Result<Vec<OllamaModelInfo>, String> {
    let tags_body = ollama_http("GET", "/api/tags", None)?;
    let tags: serde_json::Value =
        serde_json::from_str(&tags_body).map_err(|e| format!("tags json: {e}"))?;

    // What is resident, keyed by name; an /api/ps error reads as "nothing".
    let running = ollama_http("GET", "/api/ps", None)
        .map(|b| ps_entries(&b))
        .unwrap_or_default();

    let models = tags["models"]
        .as_array()
        .ok_or("no models field in /api/tags")?;

    let now = chrono::Utc::now();
    Ok(models
        .iter()
        .map(|m| {
            let name = m["name"].as_str().unwrap_or("").to_owned();
            let size = m["size"].as_u64().unwrap_or(0);
            let details = &m["details"];
            let ps = running.get(&name);
            let digest = m["digest"].as_str().unwrap_or("").to_owned();
            // One `/api/show` per model on a cold cache, none afterwards.
            let capabilities = model_capabilities(&name, &digest);
            let expires_at = ps.and_then(|p| p.expires_at.clone());
            let (pinned, expires_in_secs) = match ps {
                Some(_) => keep_alive_of(expires_at.as_deref(), now),
                None => (false, None),
            };
            OllamaModelInfo {
                size,
                parameter_size: details["parameter_size"].as_str().map(String::from),
                quantization: details["quantization_level"].as_str().map(String::from),
                family: details["family"].as_str().map(String::from),
                running: ps.is_some(),
                size_vram: ps.map_or(0, |p| p.vram),
                capabilities,
                digest,
                loaded_size: ps.map_or(0, |p| p.size),
                expires_at,
                pinned,
                expires_in_secs,
                remote: is_remote_entry(m),
                name,
            }
        })
        .collect())
}

/// One resident model as `/api/ps` reports it.
#[derive(Debug, Clone, Default, PartialEq)]
struct PsEntry {
    /// `size_vram`: the bytes of it on the GPU.
    vram: u64,
    /// `size`: the bytes it holds in memory overall.
    size: u64,
    /// `expires_at`, verbatim (RFC 3339).
    expires_at: Option<String>,
}

/// The resident models in an `/api/ps` body, keyed by name. A body that is not
/// one reads as "nothing resident". Pure + tested.
fn ps_entries(ps_body: &str) -> std::collections::HashMap<String, PsEntry> {
    serde_json::from_str::<serde_json::Value>(ps_body)
        .ok()
        .and_then(|v| v["models"].as_array().cloned())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|m| {
            let name = m["name"].as_str()?.to_owned();
            Some((
                name,
                PsEntry {
                    vram: m["size_vram"].as_u64().unwrap_or(0),
                    size: m["size"].as_u64().unwrap_or(0),
                    expires_at: m["expires_at"].as_str().map(String::from),
                },
            ))
        })
        .collect()
}

/// An expiry further out than this is "stays loaded": Ollama has no "never" in
/// `/api/ps` and reports a `keep_alive: -1` load as expiring centuries away.
const PINNED_AFTER_SECS: i64 = 365 * 24 * 60 * 60;

/// `(pinned, seconds left)` for a resident model's `expires_at`. More than a
/// year away is pinned; a past or unreadable expiry is `(false, None)` — say
/// nothing rather than a wrong countdown. Pure + tested.
fn keep_alive_of(
    expires_at: Option<&str>,
    now: chrono::DateTime<chrono::Utc>,
) -> (bool, Option<u64>) {
    let Some(at) = expires_at.and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok()) else {
        return (false, None);
    };
    let secs = (at.with_timezone(&chrono::Utc) - now).num_seconds();
    if secs > PINNED_AFTER_SECS {
        (true, None)
    } else if secs > 0 {
        (false, Some(secs as u64))
    } else {
        (false, None)
    }
}

/// Whether an `/api/tags` entry is an Ollama cloud model: one that names the
/// remote it runs on. Nothing about it is on this machine to load. Pure + tested.
fn is_remote_entry(entry: &serde_json::Value) -> bool {
    ["remote_host", "remote_model"]
        .iter()
        .any(|k| entry[*k].as_str().is_some_and(|s| !s.trim().is_empty()))
}

/// The installed model `wanted` names, as `/api/tags` lists it: an exact match,
/// or `wanted:latest` for an untagged name — never a prefix (`qwen3` is not
/// `qwen3.5:9b`). `Err("model_not_installed")` when nothing matches (an
/// unreadable body included: fail closed), `Err("model_not_local")` for a cloud
/// entry. Returning the *listed* spelling matters: it is the key the load's
/// progress events carry. Pure + tested.
fn installed_match(tags_body: &str, wanted: &str) -> Result<String, &'static str> {
    let tags = serde_json::from_str::<serde_json::Value>(tags_body)
        .map_err(|_| "model_not_installed")?;
    let entries = tags["models"].as_array().ok_or("model_not_installed")?;
    let latest = (!wanted.contains(':')).then(|| format!("{wanted}:latest"));
    let found = entries.iter().find(|m| {
        m["name"]
            .as_str()
            .is_some_and(|n| n == wanted || latest.as_deref() == Some(n))
    });
    match found {
        None => Err("model_not_installed"),
        Some(m) if is_remote_entry(m) => Err("model_not_local"),
        Some(m) => Ok(m["name"].as_str().unwrap_or(wanted).to_owned()),
    }
}

/// Unload a model from memory without deleting it (sets keep_alive=0).
#[tauri::command]
pub async fn stop_ollama_model(model: String) -> Result<(), String> {
    let body = serde_json::json!({"model": model, "keep_alive": 0}).to_string();
    ollama_http("POST", "/api/generate", Some(&body))?;
    Ok(())
}

// ── Interrupted-pull tracking ─────────────────────────────────────────────
// A pull that is in flight is recorded in a small JSON file so that if Tabtivity
// exits or crashes mid-download the model can be resumed on the next launch
// (Ollama's /api/pull continues a partially-fetched model). The entry is added
// when a pull starts and removed only on success; a caught error or a crash
// leaves it behind so the UI can offer "Continue".

fn pending_pulls_path() -> std::path::PathBuf {
    crate::storage::state_dir().join("ollama_pending_pulls.json")
}

fn read_pending_pulls() -> Vec<String> {
    crate::storage::read_json::<Vec<String>>(&pending_pulls_path()).unwrap_or_default()
}

fn mark_pending_pull(model: &str, active: bool) {
    let mut list = read_pending_pulls();
    let existed = list.iter().any(|m| m == model);
    if active {
        if existed {
            return;
        }
        list.push(model.to_string());
    } else {
        if !existed {
            return;
        }
        list.retain(|m| m != model);
    }
    let _ = crate::storage::write_json(&pending_pulls_path(), &list);
}

/// Model refs whose download was interrupted (Tabtivity closed/crashed mid-pull).
/// The UI reconciles these against the installed list and offers to resume them.
#[tauri::command]
pub async fn list_pending_ollama_pulls() -> Vec<String> {
    read_pending_pulls()
}

/// An orphaned partial layer left in Ollama's blob cache by an interrupted pull.
/// Ollama keys blobs by content digest with no on-disk name link, so a partial
/// whose manifest was never written can't be mapped back to a model — we can
/// only surface it (size) and offer to delete it to reclaim space.
#[derive(serde::Serialize)]
pub struct PartialBlob {
    /// Short content digest, e.g. "6e9f90f02bb3".
    pub digest: String,
    /// Bytes on disk for the resumable partial layer.
    pub size: u64,
    /// Absolute path of the main `-partial` file (passed back to delete it).
    pub path: String,
}

/// Ollama blob directories to scan (env override, user home, system service),
/// de-duplicated and filtered to those that exist.
fn ollama_blob_dirs() -> Vec<std::path::PathBuf> {
    let override_dir = std::env::var_os("OLLAMA_MODELS").map(std::path::PathBuf::from);
    let mut dirs = ollama_model_dir_candidates(
        crate::paths::OsKind::current(),
        &crate::paths::home_dir(),
        override_dir.as_deref(),
    )
    .into_iter()
    .map(|dir| dir.join("blobs"))
    .collect::<Vec<_>>();
    // The user's configured dir belongs here too: it is where a server *Tabtivity*
    // spawns downloads to, but it is not on this process's `OLLAMA_MODELS`, so
    // the env-var candidate above would miss it and a paused download in the
    // custom dir would have no resumable partial to find.
    if let Some(cfg) = configured_models_dir() {
        dirs.push(cfg.join("blobs"));
    }
    if let Some(system) = system_ollama_models_dir() {
        dirs.push(system.join("blobs"));
    }
    let mut seen = std::collections::HashSet::new();
    dirs.into_iter()
        .filter(|d| d.is_dir() && seen.insert(d.clone()))
        .collect()
}

fn ollama_model_dir_candidates(
    os: crate::paths::OsKind,
    home: &std::path::Path,
    override_dir: Option<&std::path::Path>,
) -> Vec<std::path::PathBuf> {
    let mut dirs = Vec::new();
    if let Some(path) = override_dir.filter(|path| !path.as_os_str().is_empty()) {
        dirs.push(path.to_path_buf());
    }
    dirs.push(home.join(".ollama").join("models"));
    if os == crate::paths::OsKind::Unix {
        dirs.extend([
            std::path::PathBuf::from("/usr/share/ollama/.ollama/models"),
            std::path::PathBuf::from("/var/lib/ollama/.ollama/models"),
            std::path::PathBuf::from("/var/lib/ollama/models"),
        ]);
    }
    dirs
}

/// Orphaned partial download layers sitting in Ollama's blob cache, largest
/// first. Each is an interrupted download with no recoverable model name.
#[tauri::command]
pub async fn list_orphan_partial_blobs() -> Vec<PartialBlob> {
    let mut out: Vec<PartialBlob> = Vec::new();
    for dir in ollama_blob_dirs() {
        let rd = match std::fs::read_dir(&dir) {
            Ok(r) => r,
            Err(_) => continue,
        };
        for entry in rd.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            // The main data file ends exactly in "-partial"; per-chunk metadata
            // files are "-partial-<N>", so counting only the former lists each
            // interrupted layer once.
            if !name.ends_with("-partial") {
                continue;
            }
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            let digest = name
                .strip_suffix("-partial")
                .unwrap_or(&name)
                .strip_prefix("sha256-")
                .unwrap_or(&name)
                .chars()
                .take(12)
                .collect::<String>();
            out.push(PartialBlob {
                digest,
                size,
                path: entry.path().to_string_lossy().to_string(),
            });
        }
    }
    out.sort_by_key(|m| std::cmp::Reverse(m.size));
    out
}

/// Delete an orphaned partial layer (the main `-partial` file plus its per-chunk
/// `-partial-<N>` siblings) to reclaim disk. Validated to a file named `*-partial`
/// inside one of the known Ollama blob directories, so it can't be used to remove
/// anything else — the check matters because the removal may run elevated.
#[tauri::command]
pub async fn delete_partial_blob(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    let name = p
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("invalid path")?
        .to_string();
    if !name.ends_with("-partial") {
        return Err("not a partial blob".into());
    }
    let dir = p.parent().ok_or("no parent directory")?;
    let canon = |d: &std::path::Path| std::fs::canonicalize(d).unwrap_or_else(|_| d.to_path_buf());
    let dir_canon = canon(dir);
    if !ollama_blob_dirs().iter().any(|d| canon(d) == dir_canon) {
        return Err("not inside an Ollama blobs directory".into());
    }
    let files: Vec<std::path::PathBuf> = std::fs::read_dir(&dir_canon)
        .map_err(|e| e.to_string())?
        .flatten()
        .filter(|entry| is_partial_file_of(&entry.file_name().to_string_lossy(), &name))
        .map(|entry| entry.path())
        .collect();
    if files.is_empty() {
        return Err("nothing to remove".into());
    }
    remove_blob_files(&files)
}

/// `fname` is the main `<stem>-partial` file or one of its `-partial-<N>` chunk
/// records.
fn is_partial_file_of(fname: &str, partial_name: &str) -> bool {
    fname == partial_name
        || fname
            .strip_prefix(partial_name)
            .and_then(|rest| rest.strip_prefix('-'))
            .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

/// Remove Ollama blob files, escalating once for the ones this user may not
/// delete. The system service (`ollama.service`) keeps its cache under
/// `/usr/share/ollama`, owned by the `ollama` user with a `755` blobs dir, so a
/// plain unlink gets EACCES and the partial reappears on every listing. Only
/// ever reached from an explicit Delete click, so the one `pkexec` prompt is
/// the user's own action, never a background one.
fn remove_blob_files(files: &[std::path::PathBuf]) -> Result<(), String> {
    let mut denied: Vec<&std::path::PathBuf> = Vec::new();
    let mut last_err: Option<String> = None;
    for f in files {
        match std::fs::remove_file(f) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => denied.push(f),
            Err(e) => last_err = Some(e.to_string()),
        }
    }
    if !denied.is_empty() {
        remove_blob_files_elevated(&denied)?;
    }
    match last_err {
        Some(e) => Err(e),
        None => Ok(()),
    }
}

#[cfg(target_os = "linux")]
fn remove_blob_files_elevated(files: &[&std::path::PathBuf]) -> Result<(), String> {
    if !crate::paths::binary_on_path("pkexec") {
        return Err(
            "permission denied: these files belong to the Ollama system service, and pkexec is not available to remove them".into(),
        );
    }
    let status = std::process::Command::new("pkexec")
        .arg("rm")
        .arg("-f")
        .arg("--")
        .args(files)
        .status()
        .map_err(|e| format!("pkexec: {e}"))?;
    match status.code() {
        Some(0) => Ok(()),
        // pkexec: 126 = the auth dialog was dismissed, 127 = not authorized.
        Some(126) | Some(127) => Err(
            "permission denied: these files belong to the Ollama system service, and authorization was not granted".into(),
        ),
        _ => Err(format!("removing the partial layer failed ({status})")),
    }
}

#[cfg(not(target_os = "linux"))]
fn remove_blob_files_elevated(_files: &[&std::path::PathBuf]) -> Result<(), String> {
    Err("permission denied: these files belong to another user (the Ollama service)".into())
}

/// Forget an interrupted pull (e.g. the user dismisses it, or it finished).
#[tauri::command]
pub async fn clear_pending_ollama_pull(model: String) {
    mark_pending_pull(&model, false);
}

// ── Pausable pulls ────────────────────────────────────────────────────────
// Ollama's /api/pull has no native pause, but dropping the connection mid-stream
// leaves the partial blobs on disk, and a later /api/pull continues from them. We
// implement "pause" as a cooperative cancel: `pause_ollama_pull` records a model
// ref, and the streaming loop in `pull_ollama_model` notices it on its next chunk,
// stops reading, and returns — keeping the pending-pull record so the UI can offer
// Resume (re-pull) or Delete (drop the partials).

fn paused_pulls() -> &'static std::sync::Mutex<std::collections::HashSet<String>> {
    static S: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<String>>> =
        std::sync::OnceLock::new();
    S.get_or_init(|| std::sync::Mutex::new(std::collections::HashSet::new()))
}

/// Request that an in-flight pull of `model` pause at the next streamed chunk.
/// The partial download is preserved so it can be resumed later.
#[tauri::command]
pub async fn pause_ollama_pull(model: String) {
    if let Ok(mut set) = paused_pulls().lock() {
        set.insert(model);
    }
}

/// True (consuming the flag) if a pause was requested for `model`.
fn take_pause_request(model: &str) -> bool {
    paused_pulls()
        .lock()
        .map(|mut set| set.remove(model))
        .unwrap_or(false)
}

/// Delete a paused/interrupted download: clear its pending record, remove the
/// partial blobs it left in Ollama's cache, and delete any committed model of the
/// same ref. Best-effort — the partial blobs are resolved from the registry
/// manifest's layer digests, so a missing network leaves them for the orphan-blob
/// cleanup to reclaim instead. Always clears the pending record so the UI settles.
#[tauri::command]
pub async fn delete_ollama_pull(model: String) -> Result<(), String> {
    mark_pending_pull(&model, false);
    // Drop any committed manifest/blobs (no-op 404 if the pull never got that far).
    let body = serde_json::json!({ "model": model }).to_string();
    let _ = ollama_http("DELETE", "/api/delete", Some(&body));
    // Remove the partial layers this model's pull was fetching.
    if let Ok(digests) = registry_layer_digests(&model) {
        delete_partials_for_digests(&digests);
    }
    Ok(())
}

/// The set of blob digests (`sha256:<hex>`) a model ref is composed of — its
/// config plus every layer — read from the Ollama registry manifest. Used to map
/// a paused download back to the specific `-partial` files it created.
fn registry_layer_digests(model: &str) -> Result<Vec<String>, String> {
    let v = fetch_registry_manifest(model)?;
    let mut out: Vec<String> = Vec::new();
    if let Some(d) = v["config"]["digest"].as_str() {
        out.push(d.to_string());
    }
    if let Some(arr) = v["layers"].as_array() {
        for l in arr {
            if let Some(d) = l["digest"].as_str() {
                out.push(d.to_string());
            }
        }
    }
    Ok(out)
}

/// Delete the `*-partial` (and per-chunk `*-partial-<N>`) files matching any of
/// the given `sha256:<hex>` digests, across all known blob directories. Files the
/// system service owns go through [`remove_blob_files`]'s one elevated retry —
/// this runs only from the user's Delete on a paused download.
fn delete_partials_for_digests(digests: &[String]) {
    // Blob files are named `sha256-<hex>`; the manifest gives `sha256:<hex>`.
    let stems: std::collections::HashSet<String> =
        digests.iter().map(|d| d.replace(':', "-")).collect();
    let mut files = Vec::new();
    for dir in ollama_blob_dirs() {
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in rd.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let Some(rest) = name.strip_suffix("-partial").or_else(|| {
                // per-chunk metadata file: `<stem>-partial-<N>`
                name.rsplit_once("-partial-").map(|(head, _)| head)
            }) else {
                continue;
            };
            if stems.contains(rest) {
                files.push(entry.path());
            }
        }
    }
    if !files.is_empty() {
        let _ = remove_blob_files(&files);
    }
}

/// Which processor a load should put the model on.
///
/// The three values are genuinely three, not a bool with a default: `Auto` is
/// *Ollama's* decision (it weighs the model against free VRAM and may split the
/// layers), while `Gpu` and `Cpu` are the user's, and overriding a scheduler is
/// not the same act as deferring to it. They map onto the one option llama.cpp
/// exposes for this, `num_gpu` — the number of layers to offload:
///
/// * `Cpu`  → `0`, the only value that means "none of it", i.e. a real CPU run.
/// * `Gpu`  → [`MAX_GPU_LAYERS`], "as many as there are". Ollama clamps it to
///   the model's own layer count, so an over-large number is the documented way
///   to say *all* without having to know how many a model has.
/// * `Auto` → the option is **omitted**. Sending a computed number here would
///   be this app second-guessing the scheduler with strictly less information
///   than it has (it knows what else is resident; we do not).
///
/// `Gpu` is a *request*, and the honest limit is worth stating: it can only
/// distribute layers across the devices Ollama registered at startup. If the
/// server dropped the machine's only GPU (see [`ollama_gpu_status`]) there is no
/// device to offload to and the load still lands on the CPU — no per-request
/// option can undo a discovery-time decision.
#[derive(serde::Deserialize, Clone, Copy, Default, PartialEq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum LoadDevice {
    #[default]
    Auto,
    Gpu,
    Cpu,
}

/// Stand-in for "every layer". Larger than any published model's layer count,
/// and clamped by Ollama, which is the documented way to ask for full offload.
const MAX_GPU_LAYERS: i64 = 999;

impl LoadDevice {
    /// The `num_gpu` option this device implies, or `None` to omit it entirely.
    fn num_gpu(self) -> Option<i64> {
        match self {
            LoadDevice::Auto => None,
            LoadDevice::Gpu => Some(MAX_GPU_LAYERS),
            LoadDevice::Cpu => Some(0),
        }
    }
}

/// Load a model into memory now (an empty `/api/generate` warms it) and keep it
/// resident until explicitly unloaded (`keep_alive: -1`), so the user controls
/// residency by button rather than relying on first use to trigger the load.
///
/// `device` is optional and defaults to [`LoadDevice::Auto`], so every existing
/// call site (the autoload store, the settings list) keeps its old meaning
/// exactly — a missing field deserializes to the default rather than to a
/// choice nobody made.
///
/// Ollama's warm-up call returns only once the model is fully resident and streams
/// no load percentage, so progress here is coarse: an `ollama-load-progress` event
/// (`{ model, status }`, status `loading`→`success`/`error`) is emitted around the
/// blocking call so any surface (the brain menu, the settings panel) can show a
/// live "Loading into memory…" indicator for a load started anywhere.
#[tauri::command]
pub async fn load_ollama_model(
    app: tauri::AppHandle,
    model: String,
    device: Option<LoadDevice>,
) -> Result<(), String> {
    run_load(&app, &model, device.unwrap_or_default())
}

/// The load itself, shared by [`load_ollama_model`] and
/// [`load_installed_ollama_model`]: `ollama-load-progress` `loading`, the
/// blocking warm-up with `keep_alive: -1`, then `success`/`error` — all keyed by
/// `model` exactly as given.
fn run_load(app: &tauri::AppHandle, model: &str, device: LoadDevice) -> Result<(), String> {
    use tauri::Emitter;

    let _ = app.emit(
        "ollama-load-progress",
        serde_json::json!({ "model": model, "status": "loading" }),
    );
    let mut payload = serde_json::json!({"model": model, "keep_alive": -1});
    if let Some(n) = device.num_gpu() {
        payload["options"] = serde_json::json!({ "num_gpu": n });
    }
    let body = payload.to_string();
    let result = ollama_http("POST", "/api/generate", Some(&body));
    let _ = app.emit(
        "ollama-load-progress",
        match &result {
            Ok(_) => serde_json::json!({ "model": model, "status": "success" }),
            Err(e) => serde_json::json!({ "model": model, "status": "error", "error": e }),
        },
    );
    result?;
    Ok(())
}

/// Models a phone-started load ([`load_installed_ollama_model`]) is warming
/// right now. A second request for one of them starts nothing, which bounds the
/// blocking threads a phone can hold open (each may sit in a 600 s read) at one
/// per installed model.
fn phone_loads() -> &'static std::sync::Mutex<std::collections::HashSet<String>> {
    static S: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<String>>> =
        std::sync::OnceLock::new();
    S.get_or_init(Default::default)
}

/// A claim on one [`phone_loads`] entry, released on drop — so a load that
/// errors or panics can never leave its model stuck as "already loading".
struct PhoneLoadClaim(String);

impl PhoneLoadClaim {
    /// Claim `model`, or `None` when a phone load of it is already running.
    fn claim(model: &str) -> Option<Self> {
        let mut set = phone_loads()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        set.insert(model.to_owned())
            .then(|| PhoneLoadClaim(model.to_owned()))
    }
}

impl Drop for PhoneLoadClaim {
    fn drop(&mut self) {
        phone_loads()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&self.0);
    }
}

/// Load an **installed** model into memory (Ollama picks the device, kept
/// resident with `keep_alive: -1`) without waiting for it: the answer comes as
/// soon as the request checks out, and the load runs on a detached thread,
/// reporting through the same `ollama-load-progress` events as
/// [`load_ollama_model`]. Made for the phone, whose bridge deadline is seconds
/// while a load can take minutes.
///
/// The name must be one `/api/tags` lists (see [`installed_match`]) — that is the
/// no-download guarantee: whatever Ollama might do with an unknown name, this
/// never sends one. Refusals are bare codes: `ollama_not_running`,
/// `model_not_installed`, `model_not_local`. A model a phone load is already
/// warming is not loaded twice. Returns the name as listed (`llama3` →
/// `llama3:latest`), the key the progress events use.
///
/// Exit does not wait for the load thread; an owned server torn down at exit
/// makes its read fail.
#[tauri::command]
pub async fn load_installed_ollama_model(
    app: tauri::AppHandle,
    model: String,
) -> Result<String, String> {
    validate_model_name(&model)?;
    let wanted = model.trim().to_owned();
    tokio::task::spawn_blocking(move || {
        let tags = ollama_http("GET", "/api/tags", None).map_err(|e| {
            if e == "not_running" {
                "ollama_not_running".to_owned()
            } else {
                e
            }
        })?;
        let listed = installed_match(&tags, &wanted).map_err(str::to_owned)?;
        if let Some(claim) = PhoneLoadClaim::claim(&listed) {
            let name = listed.clone();
            std::thread::Builder::new()
                .name("ollama-phone-load".into())
                .spawn(move || {
                    let _claim = claim;
                    let _ = run_load(&app, &name, LoadDevice::Auto);
                })
                .map_err(|e| format!("could not start the load: {e}"))?;
        }
        Ok(listed)
    })
    .await
    .map_err(|e| format!("load task failed: {e}"))?
}

/// Pull (download or update) a model from the Ollama registry, streaming
/// download progress to the frontend. Emits `ollama-pull-progress` events
/// (`{ model, status, completed, total }`) line-by-line as Ollama reports
/// them so the UI can show a live percentage. Blocks until complete — may
/// take minutes for large models.
#[tauri::command]
pub async fn pull_ollama_model(app: tauri::AppHandle, model: String) -> Result<(), String> {
    use std::io::{BufRead, BufReader};
    use tauri::Emitter;

    let body = serde_json::json!({"model": model, "stream": true}).to_string();

    let addr = ollama_addr()?;
    let stream = connect_ollama(&addr)?;
    // 10-minute read timeout accommodates large model pulls between chunks.
    stream
        .set_read_timeout(Some(Duration::from_secs(600)))
        .map_err(|e| format!("set timeout: {e}"))?;

    let req = format!(
        "POST /api/pull HTTP/1.0\r\nHost: {addr}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    );
    let mut writer = stream.try_clone().map_err(|e| format!("clone: {e}"))?;
    writer
        .write_all(req.as_bytes())
        .map_err(|e| format!("write: {e}"))?;

    // Record this as an in-flight pull; a crash/exit now leaves the entry behind
    // so the next launch can offer to resume it. Removed only on success below.
    mark_pending_pull(&model, true);
    // Consume any stale pause flag from a previous run so this fresh pull (e.g. a
    // resume) isn't cancelled before it starts.
    take_pause_request(&model);

    let mut reader = BufReader::new(stream);

    // Consume the HTTP status line + headers up to the blank separator,
    // capturing the status code so a 4xx/5xx can surface as an error.
    let mut status_code = 200u16;
    let mut header = String::new();
    reader
        .read_line(&mut header)
        .map_err(|e| format!("read: {e}"))?;
    if let Some(code) = header
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
    {
        status_code = code;
    }
    loop {
        let mut h = String::new();
        let n = reader.read_line(&mut h).map_err(|e| format!("read: {e}"))?;
        if n == 0 || h == "\r\n" || h == "\n" {
            break;
        }
    }

    // Stream the newline-delimited JSON body, forwarding each progress line.
    let mut last_err: Option<String> = None;
    loop {
        // Cooperative pause: if the user asked to pause this pull, stop reading and
        // drop the connection. Ollama keeps the partial blobs, and the pending-pull
        // record is left in place so the UI can offer Resume or Delete.
        if take_pause_request(&model) {
            let _ = app.emit(
                "ollama-pull-progress",
                serde_json::json!({ "model": model, "status": "paused" }),
            );
            return Ok(());
        }
        let mut line = String::new();
        let n = reader
            .read_line(&mut line)
            .map_err(|e| format!("read: {e}"))?;
        if n == 0 {
            break;
        }
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
            if let Some(err) = v["error"].as_str() {
                last_err = Some(err.to_string());
                continue;
            }
            let _ = app.emit(
                "ollama-pull-progress",
                serde_json::json!({
                    "model": model,
                    "status": v["status"].as_str().unwrap_or_default(),
                    "completed": v["completed"].as_u64().unwrap_or(0),
                    "total": v["total"].as_u64().unwrap_or(0),
                }),
            );
        }
    }

    if let Some(err) = last_err {
        return Err(friendly_ollama_error(&err));
    }
    if status_code >= 400 {
        return Err(format!("HTTP {status_code}"));
    }
    // Completed cleanly — drop it from the interrupted-pull record.
    mark_pending_pull(&model, false);
    Ok(())
}

// ── Update checks ─────────────────────────────────────────────────────────
//
// Ollama has no "is there a newer version of this model" API: `ollama pull`
// simply re-resolves the tag and downloads whatever it now points at, which
// means the only way to *ask* without transferring gigabytes is to compare
// manifest digests. `/api/tags` reports the digest of the manifest on disk and
// the registry answers the same value in the `ollama-content-digest` response
// header, so one HEAD per model settles it.
//
// This is the one part of the local-model feature that reaches the network
// without a model being installed or run, so it is **on demand only** — a
// button in the 🧠 menu. It is deliberately not run on hover, on a timer, or at
// launch: a menu that phones a registry every time the pointer crosses the
// header is exactly the standing background traffic Energy Saver and the HPC
// tag exist to remove.

/// What an update check found for one installed model.
#[derive(serde::Serialize, Clone)]
pub struct OllamaModelUpdate {
    pub model: String,
    /// The digest of the manifest on disk, per `/api/tags`.
    pub local_digest: String,
    /// The digest the registry currently serves for the same `name:tag`.
    /// Empty when the registry could not be reached or did not answer with one.
    pub remote_digest: String,
    /// True only when both digests are known *and* differ. An unreachable
    /// registry reports `false` with an `error` — "we could not tell" must never
    /// render as an update badge the user cannot act on.
    pub update_available: bool,
    /// Unix seconds the registry says the current manifest was published
    /// (`ollama-push-time`), so the UI can say *how old* the new version is.
    pub pushed_at: Option<i64>,
    /// Why this model could not be checked, when it could not be.
    pub error: Option<String>,
}

/// Ask the registry for one model's current manifest digest and push time.
/// `curl -sSI`, matching `fetch_registry_manifest`'s transport (no shell, args
/// passed directly, `validate_model_name` already restricting the characters
/// that reach the URL).
fn registry_head(model: &str) -> Result<(String, Option<i64>), String> {
    let url = registry_manifest_url(model)?;
    let output = crate::paths::command_no_window("curl")
        .args(["-sSI", "--max-time", "15", &url])
        .output()
        .map_err(|e| format!("failed to query registry: {e}"))?;
    if !output.status.success() {
        return Err("registry unreachable".to_string());
    }
    let head = String::from_utf8_lossy(&output.stdout);
    Ok((
        header_value(&head, "ollama-content-digest").unwrap_or_default(),
        header_value(&head, "ollama-push-time").and_then(|v| v.parse().ok()),
    ))
}

/// Pull one header out of a raw HTTP response head. Case-insensitive on the
/// name (HTTP/2 lowercases them, HTTP/1.1 does not) and tolerant of the several
/// head blocks a redirect leaves behind — the **last** occurrence wins, since
/// that is the response that actually carried the manifest.
fn header_value(head: &str, name: &str) -> Option<String> {
    head.lines()
        .filter_map(|line| {
            let (k, v) = line.split_once(':')?;
            k.trim()
                .eq_ignore_ascii_case(name)
                .then(|| v.trim().to_string())
        })
        .rfind(|v| !v.is_empty())
}

/// Check the given installed models for a newer published version, or every
/// installed model when `models` is empty.
///
/// One HEAD request per model, run only when the user asks. A model the
/// registry can't answer for comes back with `error` set and
/// `update_available: false` rather than being dropped, so the menu can say
/// "couldn't check" instead of silently implying "up to date".
#[tauri::command]
pub async fn ollama_check_updates(models: Vec<String>) -> Result<Vec<OllamaModelUpdate>, String> {
    let installed = list_ollama_models_detailed().await?;
    let wanted: Vec<(String, String)> = installed
        .into_iter()
        .filter(|m| models.is_empty() || models.iter().any(|w| w == &m.name))
        .map(|m| (m.name, m.digest))
        .collect();

    tokio::task::spawn_blocking(move || wanted_updates(wanted))
        .await
        .map_err(|e| format!("update check failed: {e}"))
}

/// The blocking half of [`ollama_check_updates`] — `curl` per model, off the
/// async runtime's shoulders.
fn wanted_updates(models: Vec<(String, String)>) -> Vec<OllamaModelUpdate> {
    models
        .into_iter()
        .map(|(model, local_digest)| match registry_head(&model) {
            Ok((remote_digest, pushed_at)) if !remote_digest.is_empty() => {
                // A local digest we never read is not evidence of anything;
                // comparing it to a real remote one would report an update for
                // every model.
                let update_available = !local_digest.is_empty() && local_digest != remote_digest;
                OllamaModelUpdate {
                    model,
                    local_digest,
                    remote_digest,
                    update_available,
                    pushed_at,
                    error: None,
                }
            }
            Ok(_) => OllamaModelUpdate {
                model,
                local_digest,
                remote_digest: String::new(),
                update_available: false,
                pushed_at: None,
                error: Some("the registry didn't report a digest".to_string()),
            },
            Err(e) => OllamaModelUpdate {
                model,
                local_digest,
                remote_digest: String::new(),
                update_available: false,
                pushed_at: None,
                error: Some(e),
            },
        })
        .collect()
}

// ── The Ollama server's own version ───────────────────────────────────────
//
// Distinct from a *model* update and worth its own surface: a server several
// minor versions back is missing whole features rather than weights. The case
// that prompted this — `ollama launch`, which is the only wiring that stands up
// an Anthropic-compatible endpoint for Claude Code — simply does not exist
// before v0.15, so on an older server that agent is absent from the new-tab
// menu with nothing anywhere saying why.
//
// Same discipline as the model check: the **installed** version is free (a local
// `ollama --version`) and read whenever the menu opens; the **latest** version
// is a network request and happens only when the user clicks.

/// Where the newest published version is read from: GitHub's releases rather
/// than ollama.com (whose `/api/version` answers `0.0.0`) — the same source the
/// project's own installer consults. The release page's redirect comes first
/// (`agent_latest::github_latest_page`): the REST API's unauthenticated quota is
/// 60 an hour per IP, and once spent every check failed with "couldn't reach the
/// release feed" (2026-10-02). The API stays as the fallback.
const OLLAMA_REPO: &str = "ollama/ollama";
const OLLAMA_RELEASES_URL: &str = "https://api.github.com/repos/ollama/ollama/releases/latest";

/// The newest Ollama release tag, e.g. `v0.35.1`: the release page's redirect,
/// else the API. `None` when neither answered with one.
fn latest_ollama_tag() -> Option<String> {
    use crate::services::agent_latest::{github_latest_page, tag_from_release_redirect};
    let from_redirect = crate::paths::command_no_window("curl")
        .args(["-sSI", "--max-time", "15", &github_latest_page(OLLAMA_REPO)])
        .output()
        .ok()
        .filter(|out| out.status.success())
        .and_then(|out| header_value(&String::from_utf8_lossy(&out.stdout), "location"))
        .and_then(|location| tag_from_release_redirect(&location));
    if from_redirect.is_some() {
        return from_redirect;
    }
    // GitHub rejects a request with no User-Agent, so one is sent. It names
    // the app and nothing else — no token, no account, no machine detail.
    crate::paths::command_no_window("curl")
        .args([
            "-fsSL",
            "--max-time",
            "15",
            "-H",
            concat!("User-Agent: ", crate::app_name!()),
            "-H",
            "Accept: application/vnd.github+json",
            OLLAMA_RELEASES_URL,
        ])
        .output()
        .ok()
        .filter(|out| out.status.success())
        .and_then(|out| serde_json::from_slice::<serde_json::Value>(&out.stdout).ok())
        .and_then(|v| v["tag_name"].as_str().map(String::from))
}

/// The installed and newest-published Ollama versions.
#[derive(serde::Serialize, Clone, Default)]
pub struct OllamaVersionStatus {
    /// The installed version, e.g. `"0.14.3"`. Empty when Ollama isn't
    /// installed, or answered something we couldn't parse.
    pub current: String,
    /// The newest published version, e.g. `"0.32.5"`. Empty whenever the remote
    /// half didn't run or didn't answer — never a stand-in for `current`.
    pub latest: String,
    /// True only when both versions parsed *and* `latest` is genuinely newer.
    /// An unreadable version on either side is not an update.
    pub update_available: bool,
    /// The one-click upgrade command. Deliberately the *install* command: both
    /// installers (winget, `install.sh`) upgrade in place, and a second command
    /// string would be a second thing to keep correct.
    pub install_cmd: String,
    /// Which shell `install_cmd` needs, for `runInstallInTab`.
    pub shell_kind: String,
    /// Why the newest version couldn't be read, when it couldn't.
    pub error: Option<String>,
}

/// Parse a version out of `ollama --version` output, or out of a release tag.
///
/// The command prints `ollama version is 0.14.3`, and prefixes a warning line
/// when the server isn't running — so this scans for the first token that
/// actually looks like a version rather than trusting a field position. A tag
/// arrives as `v0.32.5`; the `v` is stripped.
fn parse_version(text: &str) -> Option<String> {
    text.split(|c: char| c.is_whitespace() || c == '"' || c == ',')
        .filter_map(|tok| {
            let t = tok.trim().trim_start_matches('v');
            let core = t.split('-').next().unwrap_or(t);
            let looks_like = core.split('.').count() >= 2
                && core
                    .split('.')
                    .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()));
            looks_like.then(|| t.to_string())
        })
        .next()
}

/// Compare two dotted versions numerically. `None` when either side doesn't
/// parse — which the caller reports as "couldn't tell", never as an update.
///
/// Numeric and not lexical, which is the entire reason this exists rather than
/// a `<` on the strings: `"0.9.0" > "0.14.3"` as text, so a string compare
/// would announce a *downgrade* as an update for most of Ollama's history.
/// A pre-release suffix (`0.15.0-rc1`) is dropped before comparing rather than
/// ranked, because we only ever compare against the *latest stable* release.
fn version_is_newer(candidate: &str, current: &str) -> Option<bool> {
    fn parts(v: &str) -> Option<Vec<u64>> {
        let core = v.trim_start_matches('v').split('-').next()?;
        core.split('.').map(|p| p.parse::<u64>().ok()).collect()
    }
    let (a, b) = (parts(candidate)?, parts(current)?);
    let len = a.len().max(b.len());
    for i in 0..len {
        // A missing component is zero: 0.15 and 0.15.0 are the same version.
        let (x, y) = (
            a.get(i).copied().unwrap_or(0),
            b.get(i).copied().unwrap_or(0),
        );
        if x != y {
            return Some(x > y);
        }
    }
    Some(false)
}

/// The installed Ollama version, and — only when `check_remote` — the newest
/// published one.
///
/// `check_remote: false` touches no network at all, so the menu can show what is
/// installed the moment it opens. `true` is the "Check for updates" click and
/// costs one unauthenticated GitHub request.
#[tauri::command]
pub async fn ollama_version_status(check_remote: bool) -> OllamaVersionStatus {
    tokio::task::spawn_blocking(move || {
        // Deliberately NOT pointed at `ollama_host`: this reads the version of
        // the **installed binary**, which is what the feature gate above is
        // about (`ollama launch` exists from v0.15), and the whole contract of
        // `check_remote: false` is that it touches no network. Handing it an
        // `OLLAMA_HOST` makes the CLI try to reach that server first — which for
        // an unreachable one blocks on the kernel's TCP retries for over two
        // minutes, inside a command the 🧠 menu calls on every open. The
        // server-unreachable case is already handled: `ollama --version` prints
        // a warning line and then the client version, which is exactly what
        // `parse_version` scans past.
        let current = crate::paths::command_no_window("ollama")
            .arg("--version")
            .output()
            .ok()
            .filter(|o| o.status.success())
            .and_then(|o| {
                let text = format!(
                    "{}{}",
                    String::from_utf8_lossy(&o.stdout),
                    String::from_utf8_lossy(&o.stderr)
                );
                parse_version(&text)
            })
            .unwrap_or_default();

        let mut status = OllamaVersionStatus {
            current,
            install_cmd: ollama_install_cmd().to_string(),
            shell_kind: if cfg!(target_os = "windows") {
                "powershell"
            } else {
                "bash"
            }
            .to_string(),
            ..Default::default()
        };
        if !check_remote {
            return status;
        }

        match latest_ollama_tag().as_deref().map(parse_version) {
            Some(Some(latest)) => {
                status.update_available =
                    version_is_newer(&latest, &status.current).unwrap_or(false);
                status.latest = latest;
            }
            Some(None) => status.error = Some("couldn't read the latest version".to_string()),
            None => status.error = Some("couldn't reach the release feed".to_string()),
        }
        status
    })
    .await
    .unwrap_or_default()
}

/// Permanently delete a locally installed model.
#[tauri::command]
pub async fn delete_ollama_model(model: String) -> Result<(), String> {
    let body = serde_json::json!({"model": model}).to_string();
    ollama_http("DELETE", "/api/delete", Some(&body))?;
    Ok(())
}

/// Fetch the Ollama registry manifest (config + layers) for a model ref. Shells
/// out to `curl` (no Rust TLS dep); `model` may be `name`, `name:tag`, or
/// `namespace/name:tag`, with an absent tag defaulting to `latest`. Shared by the
/// size hint and the paused-download partial-blob resolver.
/// Split a model ref into its registry repo path and tag, applying the implicit
/// `library/` namespace and defaulting the tag to `latest`. Shared by the
/// manifest and config-blob fetches so both address the exact same repo.
fn registry_repo_tag(model: &str) -> Result<(String, String), String> {
    validate_model_name(model)?;

    let (name, tag) = match model.split_once(':') {
        Some((n, t)) => (n, t),
        None => (model, "latest"),
    };
    // Bare names live under the implicit `library/` namespace on the registry.
    let repo = if name.contains('/') {
        name.to_string()
    } else {
        format!("library/{name}")
    };
    Ok((repo, tag.to_string()))
}

fn registry_manifest_url(model: &str) -> Result<String, String> {
    let (repo, tag) = registry_repo_tag(model)?;
    Ok(format!(
        "https://registry.ollama.ai/v2/{repo}/manifests/{tag}"
    ))
}

fn fetch_registry_manifest(model: &str) -> Result<serde_json::Value, String> {
    let url = registry_manifest_url(model)?;

    // No shell — args are passed directly, and `validate_model_name` already
    // restricts the characters that reach the URL. `command_no_window` keeps
    // `curl` from flashing a console window on Windows (Win10/11 ship curl.exe).
    let output = crate::paths::command_no_window("curl")
        .args([
            "-fsSL",
            "-H",
            "Accept: application/vnd.docker.distribution.manifest.v2+json",
            &url,
        ])
        .output()
        .map_err(|e| format!("failed to query registry: {e}"))?;

    if !output.status.success() {
        return Err(format!("registry returned no manifest for {model}"));
    }

    serde_json::from_slice(&output.stdout).map_err(|e| format!("manifest json: {e}"))
}

/// Total download size in bytes for an installable model tag, read from the
/// Ollama registry manifest. Used to show a model's size on hover before the
/// user commits to a pull. Sums the manifest's config + layer sizes.
#[tauri::command]
pub async fn ollama_registry_size(model: String) -> Result<u64, String> {
    let v = fetch_registry_manifest(&model)?;

    let layers_total: u64 = v["layers"]
        .as_array()
        .map(|arr| arr.iter().filter_map(|l| l["size"].as_u64()).sum())
        .unwrap_or(0);
    let config_size = v["config"]["size"].as_u64().unwrap_or(0);
    let total = layers_total + config_size;

    if total == 0 {
        return Err(format!("no size info in manifest for {model}"));
    }
    Ok(total)
}

/// Fetch a registry blob (here: a manifest's config object) by digest. The
/// `repo` comes from `registry_repo_tag` (already `validate_model_name`d) and the
/// digest is checked to be a bare `sha256:<hex>`, so nothing user-typed reaches
/// the URL unvalidated — the same no-shell, argv-only `curl` the manifest uses.
fn fetch_registry_blob(repo: &str, digest: &str) -> Result<serde_json::Value, String> {
    let hex = digest
        .strip_prefix("sha256:")
        .filter(|h| !h.is_empty() && h.chars().all(|c| c.is_ascii_hexdigit()))
        .ok_or_else(|| "invalid config digest".to_string())?;
    let url = format!("https://registry.ollama.ai/v2/{repo}/blobs/sha256:{hex}");
    let output = crate::paths::command_no_window("curl")
        .args(["-fsSL", &url])
        .output()
        .map_err(|e| format!("failed to query registry: {e}"))?;
    if !output.status.success() {
        return Err("registry returned no config blob".to_string());
    }
    serde_json::from_slice(&output.stdout).map_err(|e| format!("config json: {e}"))
}

/// A registry tag's headline facts, shown in the browse-registry list before a
/// pull so a model's fit can be judged in advance: its download size, its
/// parameter count and quantization, and whether it is a cloud model.
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
pub struct RegistryDetails {
    /// Total local download size in bytes. `0` for a cloud model, whose weights
    /// live on Ollama's servers (its manifest carries no layers).
    pub size_bytes: u64,
    /// Parameter count as the registry states it, e.g. "8B", "756B". `None` when
    /// the config blob does not name one.
    pub params: Option<String>,
    /// Quantization / file type, e.g. "Q4_K_M". `None`/empty on cloud models.
    pub quant: Option<String>,
    /// True when the model runs remotely (no local weights to download).
    pub cloud: bool,
}

/// Size + parameter count + quantization for one installable tag, read from the
/// registry manifest (layer sizes) and its config blob (`model_type`/`file_type`).
/// This is what lets the browse list show the parameters and size of a model
/// that carries no size badge on the search card — including a cloud model,
/// whose parameter count (e.g. 756B) is the real "will it fit" answer even
/// though it has nothing to download. Two small HTTP reads, fetched lazily.
#[tauri::command]
pub async fn ollama_registry_details(model: String) -> Result<RegistryDetails, String> {
    let (repo, _tag) = registry_repo_tag(&model)?;
    let manifest = fetch_registry_manifest(&model)?;

    // Only the layer bytes are the download; the config blob is a few hundred
    // bytes of metadata, and for a cloud model it is the *only* object — so
    // summing it in would report ~290 B as the "size" of a 756B model.
    let size_bytes: u64 = manifest["layers"]
        .as_array()
        .map(|arr| arr.iter().filter_map(|l| l["size"].as_u64()).sum())
        .unwrap_or(0);
    let cloud = manifest["layers"]
        .as_array()
        .map(|a| a.is_empty())
        .unwrap_or(false);

    let (mut params, mut quant) = (None, None);
    if let Some(digest) = manifest["config"]["digest"].as_str() {
        if let Ok(cfg) = fetch_registry_blob(&repo, digest) {
            params = cfg["model_type"]
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(String::from);
            quant = cfg["file_type"]
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(String::from);
        }
    }

    Ok(RegistryDetails {
        size_bytes,
        params,
        quant,
        cloud,
    })
}

// ── Live registry browse (ollama.com/search) ─────────────────────────────────
//
// Ollama exposes no JSON catalog API, only its server-rendered search page. It
// used to carry `x-test-*` hooks, but a 2026 redesign dropped them, so we now
// key off the one anchor the page has always had: each result card's title
// links to `/library/<name>`. We fetch it with `curl` (no TLS dep, same as
// `ollama_registry_size`) and parse that. This surfaces *every*
// model in the registry — far beyond the curated `list_installable_models` — and
// supports Ollama's own filters: free-text query, capability filter, sort, and
// pagination for lazy loading. NB: Ollama provides no country/year metadata, so
// "recency" comes only from its relative `updated` label and the `newest` sort.

/// One model row parsed from an ollama.com/search results page.
#[derive(serde::Serialize, Clone, PartialEq, Debug)]
pub struct RegistryModel {
    pub name: String,
    pub description: String,
    /// Capability badges: e.g. "tools", "vision", "thinking", "embedding", "audio".
    pub capabilities: Vec<String>,
    /// Parameter-size tags e.g. ["8b", "70b"] (also "e2b" for Gemma-3n variants).
    pub sizes: Vec<String>,
    /// Human pull count as shown, e.g. "65.8K".
    pub pulls: String,
    /// Relative update label as shown, e.g. "1 week ago".
    pub updated: String,
}

/// Percent-encode a search query for safe inclusion in the URL's query string.
/// Keeps RFC-3986 unreserved characters; everything else becomes %XX.
fn percent_encode_query(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push('%');
            out.push_str(&format!("{b:02X}"));
        }
    }
    out
}

/// Minimal HTML-entity unescape for the text fragments we extract (names,
/// descriptions). Covers the entities Ollama's templates actually emit.
fn html_unescape(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
        .replace("&nbsp;", " ")
}

/// Text content right after an attribute marker: find `marker`, then the next
/// '>', then return text up to the following '<' (unescaped, trimmed).
fn tag_text_after(card: &str, marker: &str) -> Option<String> {
    let i = card.find(marker)?;
    let rest = &card[i + marker.len()..];
    let gt = rest.find('>')?;
    let after = &rest[gt + 1..];
    let lt = after.find('<')?;
    Some(html_unescape(after[..lt].trim()))
}

/// The capability/size badge texts within a single card. Each badge is a
/// `<span class="… rounded-md bg-… ">text</span>`; the exact Tailwind colour
/// (indigo/cyan for a capability, a blue for a size) is churn we don't lean on —
/// the text is partitioned by shape instead (`looks_like_size`).
fn badge_texts(card: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut pos = 0;
    while let Some(i) = card[pos..].find("rounded-md bg-") {
        let start = pos + i;
        let Some(gt) = card[start..].find('>') else {
            break;
        };
        let after = start + gt + 1;
        let Some(lt) = card[after..].find('<') else {
            break;
        };
        let text = html_unescape(card[after..after + lt].trim());
        if !text.is_empty() {
            out.push(text);
        }
        pos = after + lt;
    }
    out
}

/// Whether a badge is a parameter-size tag (`8b`, `1.8b`, `405b`, `e2b`, `335m`)
/// rather than a capability word (`tools`, `vision`, `thinking`, `embedding`).
/// Classifying by shape keeps a *new* capability from being mistaken for a size.
fn looks_like_size(badge: &str) -> bool {
    let t = badge.to_ascii_lowercase();
    // Gemma-3n variants are "e2b"/"e4b"; every other size is plain digits.
    let core = t.strip_prefix('e').unwrap_or(&t);
    let Some(num) = core.strip_suffix('b').or_else(|| core.strip_suffix('m')) else {
        return false;
    };
    !num.is_empty() && num.chars().all(|c| c.is_ascii_digit() || c == '.')
}

/// Text of the value `<span>` immediately *before* a label — the "65.8K" in
/// `<span>65.8K</span> <span>…Pulls</span>`.
fn value_before_label(card: &str, label: &str) -> Option<String> {
    let li = card.find(label)?;
    let before = &card[..li];
    let close = before.rfind("</span>")?;
    let gt = before[..close].rfind('>')?;
    Some(html_unescape(before[gt + 1..close].trim()))
}

/// Text of the value `<span>` immediately *after* a label — the "1 week ago" in
/// `<span>Updated…</span> <span>1 week ago</span>`.
fn value_after_label(card: &str, label: &str) -> Option<String> {
    let li = card.find(label)?;
    let after = &card[li + label.len()..];
    let close = after.find("</span>")?;
    let rest = &after[close + "</span>".len()..];
    let gt = rest.find('>')?;
    let lt = rest[gt + 1..].find('<')?;
    Some(html_unescape(rest[gt + 1..gt + 1 + lt].trim()))
}

/// Parse the ollama.com/search HTML into model rows. Pure + tested: each result
/// card's title links to `/library/<name>`, so we split on that href — the one
/// anchor the page has always had, unlike the `x-test-*` hooks it dropped in a
/// 2026 redesign. The first chunk is the page chrome before any card, so skip it.
fn parse_search_html(html: &str) -> Vec<RegistryModel> {
    html.split("href=\"/library/")
        .skip(1)
        .filter_map(|card| {
            // The name is the href slug, up to the closing quote.
            let name_end = card.find('"')?;
            let name = html_unescape(card[..name_end].trim());
            if name.is_empty() {
                return None;
            }
            // Description is the first <p> with the max-w-lg class.
            let description = tag_text_after(card, "class=\"max-w-lg").unwrap_or_default();
            let (sizes, capabilities): (Vec<String>, Vec<String>) = badge_texts(card)
                .into_iter()
                .partition(|b| looks_like_size(b));
            Some(RegistryModel {
                name,
                description,
                capabilities,
                sizes,
                pulls: value_before_label(card, "Pulls").unwrap_or_default(),
                updated: value_after_label(card, "Updated").unwrap_or_default(),
            })
        })
        .collect()
}

/// Browse the full Ollama registry via its search page. Returns one page
/// (~20 rows) of results so the frontend can lazy-load; an empty vec means no
/// more pages. `capability` filters by a single capability ("" = any);
/// `sort` is "newest" or anything else (popular, the default). `page` is 1-based.
#[tauri::command]
pub async fn search_ollama_registry(
    query: String,
    capability: String,
    sort: String,
    page: u32,
) -> Result<Vec<RegistryModel>, String> {
    let page = page.max(1);
    let mut url = format!(
        "https://ollama.com/search?q={}&page={page}",
        percent_encode_query(query.trim())
    );
    // Only forward a capability we recognise, so we never inject arbitrary params.
    const CAPS: [&str; 6] = ["tools", "vision", "thinking", "embedding", "audio", "cloud"];
    if CAPS.contains(&capability.as_str()) {
        url.push_str(&format!("&c={capability}"));
    }
    if sort == "newest" {
        url.push_str("&o=newest");
    }

    // No shell — args passed directly; the URL is built only from a validated
    // capability/sort and a percent-encoded query. `command_no_window` avoids a
    // console-window flash on Windows.
    let output = crate::paths::command_no_window("curl")
        .args(["-fsSL", &url])
        .output()
        .map_err(|e| format!("failed to query registry: {e}"))?;

    if !output.status.success() {
        return Err("ollama.com search request failed".to_string());
    }

    let html = String::from_utf8_lossy(&output.stdout);
    Ok(parse_search_html(&html))
}

/// Return the built-in catalog of popular installable models.
#[tauri::command]
pub async fn list_installable_models() -> Vec<CatalogEntry> {
    vec![
        CatalogEntry {
            name: "llama3.2".into(),
            description: "Meta Llama 3.2 — fast, lightweight instruction model".into(),
            tags: vec!["1b".into(), "3b".into()],
            size_hint: "1.3 GB – 2.0 GB".into(),
        },
        CatalogEntry {
            name: "llama3.1".into(),
            description: "Meta Llama 3.1 — strong general-purpose model".into(),
            tags: vec!["8b".into(), "70b".into(), "405b".into()],
            size_hint: "4.7 GB – 229 GB".into(),
        },
        CatalogEntry {
            name: "qwen2.5".into(),
            description: "Alibaba Qwen 2.5 — multilingual, strong coding & reasoning".into(),
            tags: vec![
                "0.5b".into(),
                "1.5b".into(),
                "3b".into(),
                "7b".into(),
                "14b".into(),
                "32b".into(),
                "72b".into(),
            ],
            size_hint: "0.4 GB – 47 GB".into(),
        },
        CatalogEntry {
            name: "qwen2.5-coder".into(),
            description: "Alibaba Qwen 2.5 Coder — specialized code generation".into(),
            tags: vec![
                "0.5b".into(),
                "1.5b".into(),
                "3b".into(),
                "7b".into(),
                "14b".into(),
                "32b".into(),
            ],
            size_hint: "397 MB – 20 GB".into(),
        },
        CatalogEntry {
            name: "qwen3.5".into(),
            description: "Alibaba Qwen 3.5 — current multimodal model family".into(),
            tags: vec![
                "0.8b".into(),
                "2b".into(),
                "4b".into(),
                "9b".into(),
                "27b".into(),
                "35b".into(),
                "122b".into(),
            ],
            size_hint: "1.0 GB – 81 GB".into(),
        },
        CatalogEntry {
            name: "qwen3-coder".into(),
            description: "Alibaba Qwen3 Coder — coding model for agentic workflows".into(),
            tags: vec!["30b".into(), "480b".into()],
            size_hint: "19 GB – 290 GB".into(),
        },
        CatalogEntry {
            name: "qwen3-coder-next".into(),
            description: "Alibaba Qwen3 Coder Next — coding-focused local development model".into(),
            tags: vec!["q4_K_M".into(), "q8_0".into()],
            size_hint: "52 GB – 85 GB".into(),
        },
        CatalogEntry {
            name: "deepseek-r1".into(),
            description: "DeepSeek R1 — chain-of-thought reasoning model".into(),
            tags: vec![
                "1.5b".into(),
                "7b".into(),
                "8b".into(),
                "14b".into(),
                "32b".into(),
                "70b".into(),
                "671b".into(),
            ],
            size_hint: "1.1 GB – 404 GB".into(),
        },
        CatalogEntry {
            name: "deepseek-coder".into(),
            description: "DeepSeek Coder — code model trained on code and natural language".into(),
            tags: vec!["1.3b".into(), "6.7b".into(), "33b".into()],
            size_hint: "776 MB – 18 GB".into(),
        },
        CatalogEntry {
            name: "gemma3".into(),
            description: "Google Gemma 3 — efficient open model from Google".into(),
            tags: vec!["1b".into(), "4b".into(), "12b".into(), "27b".into()],
            size_hint: "815 MB – 17 GB".into(),
        },
        CatalogEntry {
            name: "gemma3n".into(),
            description: "Google Gemma 3n — efficient multimodal model for low-resource devices"
                .into(),
            tags: vec!["e2b".into(), "e4b".into()],
            size_hint: "5.6 GB – 7.5 GB".into(),
        },
        CatalogEntry {
            name: "phi4".into(),
            description: "Microsoft Phi-4 — small but capable reasoning model".into(),
            tags: vec!["14b".into()],
            size_hint: "9.1 GB".into(),
        },
        CatalogEntry {
            name: "mistral".into(),
            description: "Mistral 7B — fast European foundation model".into(),
            tags: vec!["7b".into()],
            size_hint: "4.1 GB".into(),
        },
        CatalogEntry {
            name: "mistral-large".into(),
            description: "Mistral Large 2 — flagship model for code, math, and reasoning".into(),
            tags: vec!["123b".into()],
            size_hint: "69 GB".into(),
        },
        CatalogEntry {
            name: "ministral-3".into(),
            description: "Mistral Ministral 3 — edge-oriented models with vision and tool support"
                .into(),
            tags: vec!["3b".into(), "8b".into(), "14b".into()],
            size_hint: "3.0 GB – 9.1 GB".into(),
        },
        CatalogEntry {
            name: "codellama".into(),
            description: "Meta Code Llama — code generation and completion".into(),
            tags: vec!["7b".into(), "13b".into(), "34b".into(), "70b".into()],
            size_hint: "3.8 GB – 39 GB".into(),
        },
        CatalogEntry {
            name: "granite3.3".into(),
            description: "IBM Granite 3.3 — compact enterprise-oriented language model".into(),
            tags: vec!["2b".into(), "8b".into()],
            size_hint: "1.5 GB – 4.9 GB".into(),
        },
        CatalogEntry {
            name: "olmo2".into(),
            description: "Allen AI OLMo 2 — fully open model family".into(),
            tags: vec!["7b".into(), "13b".into()],
            size_hint: "4.5 GB – 8.2 GB".into(),
        },
        CatalogEntry {
            name: "cogito".into(),
            description: "Deep Cogito — hybrid reasoning models across small and large sizes"
                .into(),
            tags: vec![
                "3b".into(),
                "8b".into(),
                "14b".into(),
                "32b".into(),
                "70b".into(),
            ],
            size_hint: "2.0 GB – 43 GB".into(),
        },
        CatalogEntry {
            name: "smollm2".into(),
            description: "HuggingFace SmolLM2 — ultra-small on-device model".into(),
            tags: vec!["135m".into(), "360m".into(), "1.7b".into()],
            size_hint: "90 MB – 1.8 GB".into(),
        },
        CatalogEntry {
            name: "nomic-embed-text".into(),
            description: "Nomic Embed Text — high-quality text embeddings".into(),
            tags: vec!["latest".into()],
            size_hint: "274 MB".into(),
        },
        CatalogEntry {
            name: "mxbai-embed-large".into(),
            description: "mxbai-embed-large — best-in-class English embeddings".into(),
            tags: vec!["latest".into()],
            size_hint: "670 MB".into(),
        },
        CatalogEntry {
            name: "llava".into(),
            description: "LLaVA — vision + language model for image understanding".into(),
            tags: vec!["7b".into(), "13b".into(), "34b".into()],
            size_hint: "4.5 GB – 20 GB".into(),
        },
    ]
}

/// True when the Ollama server is reachable on its default port. Cheap enough
/// (200 ms TCP connect) to poll from the UI for a live status indicator.
#[tauri::command]
pub async fn ollama_is_running() -> bool {
    ollama_listening()
}

/// Three-state health of the local Ollama server for the header status lamp:
/// - `"stopped"` — server unreachable (lamp red),
/// - `"idle"` — server up but no model loaded in memory (lamp yellow),
/// - `"loaded"` — at least one model currently loaded in memory (lamp green).
///
/// One round trip: `/api/ps` lists the models resident in memory, and a
/// successful response also proves the server is reachable, so it doubles as
/// the running check.
#[tauri::command]
pub async fn ollama_status() -> &'static str {
    match ollama_http("GET", "/api/ps", None) {
        Err(_) => "stopped",
        Ok(body) => {
            let loaded = serde_json::from_str::<serde_json::Value>(&body)
                .ok()
                .and_then(|v| v["models"].as_array().map(|a| !a.is_empty()))
                .unwrap_or(false);
            if loaded {
                "loaded"
            } else {
                "idle"
            }
        }
    }
}

/// Total VRAM (bytes) currently in use across all models resident in Ollama's
/// memory, summed from `/api/ps`'s `size_vram`. Returns `0` when the server is
/// unreachable or no model is loaded on the GPU, so callers can treat it as a
/// plain "GPU bytes in use" gauge that degrades to zero rather than erroring.
pub fn total_vram_in_use() -> u64 {
    ollama_http("GET", "/api/ps", None)
        .ok()
        .and_then(|b| serde_json::from_str::<serde_json::Value>(&b).ok())
        .and_then(|v| v["models"].as_array().cloned())
        .unwrap_or_default()
        .iter()
        .map(|m| m["size_vram"].as_u64().unwrap_or(0))
        .sum()
}

// ── Is Ollama actually using the GPU? ─────────────────────────────────────
//
// Ollama ≥0.32 **drops integrated GPUs by default**, logging "dropping
// integrated GPU; to enable, set OLLAMA_IGPU_ENABLE=1" and then reporting `cpu`
// as its only inference device. On a machine whose sole GPU is the APU that
// turns every model into a CPU model on the next update, and the only trace in
// the API is a `size_vram` of 0 — which is *also* what a model too large to fit
// looks like. So the diagnosis is never one fact: it is a resident model with
// nothing on the GPU, **and** a GPU that exists, **and** every GPU here being
// integrated, **and** a server old enough to still offer the flag. Reporting on
// less than all four would be the app blaming a setting for an ordinary
// out-of-VRAM, which is worse than saying nothing.

/// The environment variable that turns integrated GPUs back on.
const IGPU_ENABLE_VAR: &str = "OLLAMA_IGPU_ENABLE";

/// Whether Ollama is answering on the CPU while this machine holds a GPU it
/// could be using — and, when the integrated-GPU gate explains it, how to lift
/// it.
#[derive(serde::Serialize, Clone, Default)]
pub struct OllamaGpuStatus {
    /// This machine has at least one GPU Tabtivity can read (`gpustat`). The
    /// frontend gates the whole CPU/GPU choice on this: with no GPU there is no
    /// choice to offer.
    pub gpu_present: bool,
    /// Every GPU here is **integrated** — it maps its pool out of system RAM
    /// (`shared_total > 0`), which on a discrete card is 0. False when no GPU
    /// was found at all, so it can never stand in for `gpu_present`.
    pub integrated_only: bool,
    /// A model is resident and *none* of it is on the GPU. False when nothing
    /// is loaded: an empty server is not a CPU one, and saying so would put a
    /// warning on the menu of anyone who simply hasn't loaded a model yet.
    pub model_on_cpu: bool,
    /// The installed server understands [`IGPU_ENABLE_VAR`], read from its own
    /// `ollama serve --help`. Asked rather than inferred from a version number,
    /// which would be a guess about when the flag landed.
    pub igpu_flag_supported: bool,
    /// All four facts line up: this is the integrated-GPU gate, not an ordinary
    /// out-of-VRAM. The only field the UI should raise a notice on.
    pub igpu_dropped: bool,
    /// The server runs as a systemd unit, so the variable has to reach *that*
    /// unit — a shell export or a login-session variable would not be read.
    pub systemd_service: bool,
    /// The one-click fix, for `runInstallInTab`. Empty when we have nothing
    /// honest to offer (no supported flag, or a server Tabtivity itself spawns and
    /// already sets the variable for), in which case the UI states the variable
    /// rather than running something that would not help.
    pub fix_cmd: String,
    /// Which shell `fix_cmd` needs.
    pub shell_kind: String,
}

/// Ask the installed server whether it still has the integrated-GPU flag.
///
/// `ollama serve --help` prints its environment variables, so this is the
/// server's own answer rather than a version comparison — one small spawn, and
/// it stays right across an Ollama update mid-session, which is precisely the
/// situation this whole diagnosis exists for.
fn igpu_flag_supported() -> bool {
    let bin = crate::paths::resolve_offpath_binary("ollama")
        .map(std::ffi::OsString::from)
        .unwrap_or_else(|| "ollama".into());
    crate::paths::command_no_window(&bin)
        .args(["serve", "--help"])
        .output()
        .ok()
        .map(|o| {
            let text = format!(
                "{}{}",
                String::from_utf8_lossy(&o.stdout),
                String::from_utf8_lossy(&o.stderr)
            );
            text.contains(IGPU_ENABLE_VAR)
        })
        .unwrap_or(false)
}

/// The systemd drop-in that puts the variable on the *service*, plus the reload
/// and restart that make it take effect.
///
/// A drop-in rather than an edit of `ollama.service`: the unit file belongs to
/// the Ollama installer and is rewritten by the next update, while a drop-in is
/// additive, survives it, and is undone by deleting one file. It is handed to a
/// terminal for the user to run — it needs a root password, and a command that
/// reconfigures a system service is one they are entitled to read first.
#[cfg(target_os = "linux")]
fn igpu_fix_command(systemd: bool) -> (String, String) {
    if !systemd {
        // Tabtivity's own `ollama serve` already sets the variable (see
        // `ensure_ollama_running`), so there is nothing to install — restarting
        // the server is the whole fix, and that is not ours to do behind the
        // user's back while their models are resident.
        return (String::new(), String::new());
    }
    (
        format!(
            "sudo mkdir -p /etc/systemd/system/ollama.service.d && \
             printf '[Service]\\nEnvironment=\"{IGPU_ENABLE_VAR}=1\"\\n' | \
             sudo tee /etc/systemd/system/ollama.service.d/{dropin} && \
             {drop_old}sudo systemctl daemon-reload && sudo systemctl restart ollama",
            dropin = crate::brand::OLLAMA_IGPU_DROPIN,
            drop_old = crate::services::brand_migration::compat::ollama_dropin_cleanup(
                &crate::brand::PAIR,
                crate::brand::Name::OLLAMA_IGPU_DROPIN,
            ),
        ),
        "bash".to_string(),
    )
}

#[cfg(target_os = "macos")]
fn igpu_fix_command(_systemd: bool) -> (String, String) {
    // The macOS app reads its environment from launchd, so a shell export would
    // not reach it; it has to be restarted afterwards to pick the value up.
    (
        format!("launchctl setenv {IGPU_ENABLE_VAR} 1"),
        "bash".to_string(),
    )
}

#[cfg(target_os = "windows")]
fn igpu_fix_command(_systemd: bool) -> (String, String) {
    (
        format!("setx {IGPU_ENABLE_VAR} 1"),
        "powershell".to_string(),
    )
}

/// Whether the local Ollama runs as a systemd service (Linux only).
fn ollama_under_systemd() -> bool {
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("systemctl")
            .args(["is-active", "--quiet", "ollama"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}

/// Report whether Ollama is running its models on the GPU, and diagnose the
/// integrated-GPU gate when it isn't.
///
/// On demand only — it spawns processes (`systemctl`, `ollama serve --help`),
/// so it belongs to a menu opening, never to a poll.
#[tauri::command]
pub async fn ollama_gpu_status() -> OllamaGpuStatus {
    tokio::task::spawn_blocking(|| {
        let gpus = crate::gpustat::snapshot();
        let mut status = OllamaGpuStatus {
            gpu_present: !gpus.is_empty(),
            integrated_only: !gpus.is_empty() && gpus.iter().all(|g| g.shared_total > 0),
            ..Default::default()
        };

        // A resident model with no GPU bytes anywhere. `/api/ps` unreachable, or
        // an empty one, leaves this false — "nothing loaded" is not "on the CPU".
        let loaded = ollama_http("GET", "/api/ps", None)
            .ok()
            .and_then(|b| serde_json::from_str::<serde_json::Value>(&b).ok())
            .and_then(|v| v["models"].as_array().cloned())
            .unwrap_or_default();
        status.model_on_cpu = !loaded.is_empty()
            && loaded
                .iter()
                .all(|m| m["size_vram"].as_u64().unwrap_or(0) == 0);

        // Everything below costs a process spawn, so it is only paid once the
        // symptom is actually present.
        if !(status.model_on_cpu && status.integrated_only) {
            return status;
        }
        status.igpu_flag_supported = igpu_flag_supported();
        status.igpu_dropped = status.igpu_flag_supported;
        if status.igpu_dropped {
            status.systemd_service = ollama_under_systemd();
            let (cmd, shell) = igpu_fix_command(status.systemd_service);
            status.fix_cmd = cmd;
            status.shell_kind = shell;
        }
        status
    })
    .await
    .unwrap_or_default()
}

/// Whether a chosen models path can be embedded in the terminal command that
/// reconfigures the *service* (a systemd drop-in). A directory carrying a double
/// quote, a `%`, a backslash or a control character is refused rather than
/// escaped through three nested quoting layers (shell → `printf` → systemd
/// `Environment="…"`, where `%` is a specifier): such a path is not a real
/// Ollama models directory, so the honest answer is to withhold the drop-in and
/// leave the setting itself — which reaches a Tabtivity-spawned server through a
/// plain `Command::env`, with no shell — unaffected.
fn models_path_is_safe(path: &str) -> bool {
    !path.is_empty()
        && !path
            .chars()
            .any(|c| c.is_control() || matches!(c, '"' | '%' | '\\'))
}

/// POSIX single-quote a string so it survives as one shell word.
fn sh_single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// The terminal command that points the **running service** at `path`, plus the
/// shell it needs. Empty when there is nothing to run — no service (a server
/// Tabtivity spawns already honours the setting via `ensure_ollama_running`), or a
/// path too exotic to embed (`models_path_is_safe`).
///
/// A systemd drop-in, mirroring `igpu_fix_command`: additive, survives the
/// installer rewriting `ollama.service`, undone by deleting one file, and handed
/// to a terminal because it needs a root password and reconfigures a system
/// service the user is entitled to read first. The service user is read from the
/// unit itself (`systemctl show -p User`) rather than assumed, so the new dir is
/// chowned to whoever `ollama.service` actually runs as; existing models are
/// **not** moved — the panel says so.
fn models_dir_service_command(path: &str, systemd: bool) -> (String, String) {
    if !systemd || !models_path_is_safe(path) {
        return (String::new(), String::new());
    }
    let q = sh_single_quote(path);
    (
        format!(
            "svc_user=$(systemctl show -p User --value ollama); \
             svc_user=${{svc_user:-ollama}}; \
             sudo mkdir -p /etc/systemd/system/ollama.service.d && \
             printf '[Service]\\nEnvironment=\"OLLAMA_MODELS=%s\"\\n' {q} | \
             sudo tee /etc/systemd/system/ollama.service.d/{dropin} && \
             sudo mkdir -p {q} && sudo chown \"$svc_user\": {q} && \
             {drop_old}sudo systemctl daemon-reload && sudo systemctl restart ollama",
            dropin = crate::brand::OLLAMA_MODELS_DROPIN,
            drop_old = crate::services::brand_migration::compat::ollama_dropin_cleanup(
                &crate::brand::PAIR,
                crate::brand::Name::OLLAMA_MODELS_DROPIN,
            ),
        ),
        "bash".to_string(),
    )
}

/// What the Settings panel needs to render the "Model download location" row:
/// the default it stands in for, whether the running server is systemd-managed
/// (so the setting cannot reach it on its own), and the one-click command that
/// makes it.
#[derive(serde::Serialize, Clone, Default)]
pub struct OllamaModelsDirPlan {
    /// Ollama's own default (`~/.ollama/models`), for the field's placeholder.
    pub default_dir: String,
    /// The local Ollama runs as a systemd unit; the drop-in below is the only way
    /// a chosen location reaches it.
    pub systemd_service: bool,
    /// The "apply to the running service" command, for `runInstallInTab`. Empty
    /// when there is nothing to run — see [`models_dir_service_command`].
    pub service_cmd: String,
    /// Which shell `service_cmd` needs.
    pub shell_kind: String,
}

/// Describe how a chosen models directory would be applied. `path` is the
/// setting as it stands (or as the user just picked); an empty/absent one yields
/// no service command, since there is nothing to point anywhere.
///
/// On demand only — it spawns `systemctl` to learn whether the server is a unit,
/// so it belongs to the Settings panel opening, never to a poll.
#[tauri::command]
pub async fn ollama_models_dir_plan(path: Option<String>) -> OllamaModelsDirPlan {
    tokio::task::spawn_blocking(move || {
        let default_dir = crate::paths::home_dir()
            .join(".ollama")
            .join("models")
            .to_string_lossy()
            .into_owned();
        let systemd = ollama_under_systemd();
        let chosen = path.map(|p| p.trim().to_string()).filter(|p| !p.is_empty());
        let (service_cmd, shell_kind) = chosen
            .as_deref()
            .map(|p| models_dir_service_command(p, systemd))
            .unwrap_or_default();
        OllamaModelsDirPlan {
            default_dir,
            systemd_service: systemd,
            service_cmd,
            shell_kind,
        }
    })
    .await
    .unwrap_or_default()
}

fn ollama_listening() -> bool {
    let Ok(addr) = ollama_addr() else {
        // A misconfigured endpoint is not a server that is down: say "not
        // listening" and let the caller's own resolve surface the reason.
        return false;
    };
    // `connect_timeout` needs a resolved `SocketAddr`, so a hostname is resolved
    // here — unlike the loopback judgement, which is about the literal.
    use std::net::ToSocketAddrs;
    addr.to_socket_addrs()
        .map(|mut it| {
            it.any(|sa| TcpStream::connect_timeout(&sa, Duration::from_millis(200)).is_ok())
        })
        .unwrap_or(false)
}

// ── What Tabtivity started, and therefore may stop ───────────────────────────

/// How the Ollama server currently answering came to be running — recorded by
/// [`ensure_ollama_running`] and read by nothing but [`shutdown_owned_server`].
///
/// The whole point is the *absence* of a third variant: a server that was
/// already listening when Tabtivity asked, or one running on another machine, is
/// never recorded, so exit-time teardown cannot reach it. Ollama is a machine
/// service as often as it is a Tabtivity detail — a terminal running `ollama run`,
/// another editor's completion plugin, a unit the user enabled at boot — and
/// killing one Tabtivity merely *used* would take those down with it.
enum OwnedServer {
    /// An `ollama serve` this process spawned (`spawn_reaped`, so the pid is
    /// ours and its subtree is walkable).
    Process(u32),
    /// The systemd unit, which was **inactive** until this run started it. Only
    /// recorded on Linux and only for the default address — the same two
    /// conditions under which it is started.
    #[cfg(target_os = "linux")]
    SystemdUnit,
}

static OWNED_SERVER: std::sync::Mutex<Option<OwnedServer>> = std::sync::Mutex::new(None);

fn record_owned_server(owned: OwnedServer) {
    if let Ok(mut slot) = OWNED_SERVER.lock() {
        // A previous entry can only be a server that has since died (we reach
        // the start paths at all only when nothing is listening), so replacing
        // it is right: the live one is the one worth stopping.
        *slot = Some(owned);
    }
}

/// Stop the Ollama server **this run started**, if any. Called once from
/// `RunEvent::Exit`; a server Tabtivity only talked to is left alone (see
/// [`OwnedServer`]).
///
/// A spawned server is TERMed with its whole subtree — the `ollama runner` child
/// holding the weights is a separate process, and it is the one actually sitting
/// on several GB of VRAM — and given a short blocking grace before SIGKILL, so
/// the ordinary case is a clean shutdown rather than a killed server that leaves
/// its runner behind. The unit is stopped with `--no-block`: exit must not wait
/// on systemd's job queue, and the elevation was already granted on the start
/// that this undoes.
pub fn shutdown_owned_server() {
    let owned = match OWNED_SERVER.lock() {
        Ok(mut slot) => slot.take(),
        Err(_) => return,
    };
    match owned {
        None => {}
        Some(OwnedServer::Process(pid)) => {
            crate::terminal::reap_child_subtree(
                pid,
                crate::terminal::ReapMode::GracefulBlocking(Duration::from_millis(1500)),
            );
        }
        #[cfg(target_os = "linux")]
        Some(OwnedServer::SystemdUnit) => {
            let _ = std::process::Command::new("systemctl")
                .args(["stop", "--no-block", "ollama"])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status();
        }
    }
}

/// Whether the systemd unit is already active. Asked *before* `systemctl start`
/// so ownership is recorded only when this run genuinely brought the unit up: a
/// unit that was active but not answering at the address we were waiting on (a
/// half-started service, a unit bound elsewhere) is the machine's, not ours.
#[cfg(target_os = "linux")]
fn systemd_ollama_active() -> bool {
    std::process::Command::new("systemctl")
        .args(["is-active", "--quiet", "ollama"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Ensure the Ollama server is running, starting it in the background if not.
/// Prefers the system service (`systemctl start ollama`) so that all models
/// installed by the system user are visible. Falls back to spawning
/// `ollama serve` with `OLLAMA_MODELS` pointing to the system models
/// directory when detected.
/// Waits up to 8 seconds for the server to become reachable.
///
/// Whatever it starts is recorded in [`OWNED_SERVER`] so that exactly that much
/// is torn down again at exit — see [`shutdown_owned_server`].
#[tauri::command]
pub async fn ensure_ollama_running() -> Result<(), String> {
    ensure_running(true)
}

/// [`ensure_ollama_running`] for a start nobody is sitting at the desktop for
/// (the phone): the systemd step runs `systemctl --no-ask-password start`, so it
/// fails rather than popping a polkit dialog, and the owned `ollama serve`
/// fallback — torn down at exit like any other — takes over. Runs off the async
/// runtime: it can block for 16 s or more.
#[tauri::command]
pub async fn ensure_ollama_running_unattended() -> Result<(), String> {
    tokio::task::spawn_blocking(|| ensure_running(false))
        .await
        .map_err(|e| format!("start task failed: {e}"))?
}

/// The `systemctl` arguments that start the Ollama unit. Without
/// `ask_password`, `--no-ask-password` makes a start that needs authorization
/// fail instead of prompting. Pure + tested.
#[cfg(target_os = "linux")]
fn systemctl_start_args(ask_password: bool) -> &'static [&'static str] {
    if ask_password {
        &["start", "ollama"]
    } else {
        &["--no-ask-password", "start", "ollama"]
    }
}

/// Held across a whole [`ensure_running`]. Without it two starts that overlap
/// (the autoload store and a local tab at launch, or a phone Start racing a
/// desktop one) both see nothing listening and both spawn `ollama serve`; the
/// loser exits on the taken port, but its pid replaces the winner's in
/// [`OWNED_SERVER`], and the live server then outlives the quit. Serialized,
/// the second caller waits and finds the first one's server listening.
static START_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// The core of [`ensure_ollama_running`] / [`ensure_ollama_running_unattended`].
/// `ask_password` only matters to the Linux systemd step.
fn ensure_running(ask_password: bool) -> Result<(), String> {
    #[cfg(not(target_os = "linux"))]
    let _ = ask_password;

    // Resolve first, so a misconfigured `ollama_host` reports *that* instead of
    // "started but did not become reachable" eight seconds later.
    let addr = ollama_addr()?;

    let _one_start = START_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);

    if ollama_listening() {
        return Ok(());
    }

    // A server on another machine is not ours to start, and starting a local one
    // would answer a question nobody asked — the caller would then talk to a
    // second server at an address it was not pointed at.
    if !addr_is_loopback(&addr) {
        return Err(format!(
            "No Ollama server is answering at {addr}. It is on another machine, \
             so {app} cannot start it — start it there.", app = crate::brand::DISPLAY
        ));
    }

    // Try the system service first (Linux only) — it runs as the ollama user and
    // sees all system-wide models (e.g. /usr/share/ollama/.ollama/models). Only
    // for the default address: the unit binds whatever *it* is configured with,
    // so starting it to satisfy a request for port 11500 would report success
    // for a server that is not the one being waited on.
    #[cfg(target_os = "linux")]
    if addr == DEFAULT_OLLAMA_ADDR {
        let was_active = systemd_ollama_active();
        let service_started = std::process::Command::new("systemctl")
            .args(systemctl_start_args(ask_password))
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);

        if service_started {
            let deadline = Instant::now() + Duration::from_secs(8);
            if wait_for_ollama(deadline) {
                if !was_active {
                    record_owned_server(OwnedServer::SystemdUnit);
                }
                return Ok(());
            }
        }
    }

    // Fall back to spawning a user process, but point it at the system models
    // directory if it exists so models installed via the system service are
    // visible. Resolve `ollama` to an absolute path: on Windows the winget/GUI
    // installer drops `ollama.exe` under %LOCALAPPDATA%\Programs\Ollama, which is
    // detected by `ollama_is_installed` but is not on this process's PATH.
    let ollama_bin = crate::paths::resolve_offpath_binary("ollama")
        .map(std::ffi::OsString::from)
        .unwrap_or_else(|| "ollama".into());
    let mut cmd = crate::paths::command_no_window(&ollama_bin);
    cmd.arg("serve")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());

    // The user's chosen download location wins over the system dir: they asked
    // for it explicitly, and this is the one server whose `OLLAMA_MODELS` Tabtivity
    // controls. Create it first — Ollama would otherwise fail its first pull
    // against a directory that does not exist. A systemd-managed server never
    // reaches this branch (it is started via the unit above), which is what the
    // Settings panel's "Apply to the service" drop-in is for.
    if let Some(dir) = configured_models_dir() {
        let _ = std::fs::create_dir_all(&dir);
        cmd.env("OLLAMA_MODELS", dir);
    } else if let Some(sys_models) = system_ollama_models_dir() {
        cmd.env("OLLAMA_MODELS", sys_models);
    }

    // Bind where we are about to look. Without this a non-default `ollama_host`
    // spawns a server on 11434, waits 8 s for the configured port, and reports a
    // timeout for a server that came up perfectly.
    if addr != DEFAULT_OLLAMA_ADDR {
        cmd.env("OLLAMA_HOST", &addr);
    }

    // Ollama ≥0.32 drops **integrated** GPUs unless this is set, and answers on
    // the CPU instead — which on a machine whose only GPU is the APU turns every
    // model that ran on the GPU yesterday into a CPU one after an update, with
    // nothing but a `size_vram: 0` to say so. A server *Tabtivity* starts is one we
    // are entitled to configure, so it opts in. An explicit value in the
    // environment is left alone: a user who set `0` meant it (an iGPU that is
    // genuinely slower than the CPU is a real machine, just not this one).
    if std::env::var_os(IGPU_ENABLE_VAR).is_none() {
        cmd.env(IGPU_ENABLE_VAR, "1");
    }

    let pid = crate::paths::spawn_reaped(cmd)
        .map_err(|e| format!("failed to start ollama serve: {e}"))?;
    // Recorded before the wait, not after: a server that came up too slowly for
    // the 8 s deadline is still *ours* and still running, and forgetting it here
    // is precisely how one outlives the app.
    record_owned_server(OwnedServer::Process(pid));

    let deadline = Instant::now() + Duration::from_secs(8);
    if wait_for_ollama(deadline) {
        return Ok(());
    }

    Err("ollama serve started but did not become reachable within 8 s".to_string())
}

/// Whether an already-resolved `host:port` points at this machine. Takes the
/// output of [`resolve_ollama_addr`], so the host half is whatever survived its
/// checks — including a bracketed IPv6 literal.
fn addr_is_loopback(addr: &str) -> bool {
    split_host_port(addr).is_some_and(|(host, _)| host_is_loopback(host))
}

/// `"local"` or `"remote"` for an already-resolved address. Pure + tested.
fn server_kind(addr: &str) -> &'static str {
    if addr_is_loopback(addr) {
        "local"
    } else {
        "remote"
    }
}

/// Whether the configured Ollama server is on this machine (`"local"`) or
/// another (`"remote"`); a bad `ollama_host` is the `Err`. Lets the phone
/// bridge tell a stopped local server (startable) from one it can do nothing
/// about, without re-implementing [`resolve_ollama_addr`].
#[tauri::command]
pub async fn ollama_server_kind() -> Result<&'static str, String> {
    Ok(server_kind(&ollama_addr()?))
}

fn wait_for_ollama(deadline: Instant) -> bool {
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(300));
        if ollama_listening() {
            return true;
        }
    }
    false
}

/// Returns the path to the system-wide Ollama models directory if it exists
/// and contains at least one model manifest.
fn system_ollama_models_dir() -> Option<std::path::PathBuf> {
    #[cfg(target_os = "linux")]
    {
        for path in [
            "/usr/share/ollama/.ollama/models",
            "/var/lib/ollama/.ollama/models",
            "/var/lib/ollama/models",
        ] {
            let p = std::path::Path::new(path);
            if p.join("manifests").exists() {
                return Some(p.to_owned());
            }
        }
    }
    None
}

/// Query the Ollama REST API and return all installed model names.
/// Returns Err("not_running") when the Ollama server is not reachable.
#[tauri::command]
pub async fn list_ollama_models() -> Result<Vec<String>, String> {
    let body = ollama_http("GET", "/api/tags", None)?;
    let v: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("ollama json: {e}"))?;

    let models = v["models"]
        .as_array()
        .ok_or("no models field in ollama response")?;

    Ok(models
        .iter()
        .filter_map(|m| Some(m["name"].as_str()?.to_owned()))
        .collect())
}

// ── Local code/text autocomplete (TODO Group M #45) ──────────────────────────
//
// Opt-in completion uses the configured, policy-checked Ollama endpoint, with
// no cloud fallback. Native insert-capable models use /api/generate; chat models
// use a dedicated system role. Both streams are cancellable at the socket.

/// System message that turns a general instruct/chat model into a fill-in-the-
/// middle completion engine: it must INSERT between BEFORE and AFTER (not author a
/// fresh reply). How *much* to insert is left to the per-request TASK hint (see
/// [`CompletionMode`]) so the same engine serves sentence, block, and whole-scope
/// completions. Verified against llama3.2:3b. Pure + sent as the chat `system` role.
const COMPLETION_SYSTEM: &str = "You are a fill-in-the-middle autocomplete engine inside a code/text \
editor. You receive the text BEFORE the cursor and the text AFTER the cursor. Output ONLY the raw text \
to INSERT at the cursor so that BEFORE + your insertion + AFTER reads as one correct, natural, continuous \
piece of text. Continue directly from the end of BEFORE and join smoothly into the start of AFTER. Insert \
exactly what the TASK asks for and no more. Never repeat, rewrite, or quote any text from BEFORE or AFTER. \
Keep the natural language of the surrounding document; never translate it. \
No preamble, no quotes, no code fences, no explanations, no labels.";

/// How much of a completion to generate (#45 modes). Chosen per file type in
/// settings and cycled live with Shift+Tab while a suggestion is showing. Drives
/// both the TASK hint in [`completion_prompt`] and the `num_predict` output cap.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum CompletionMode {
    /// Finish the current word/sentence/line only (default; least intrusive).
    Sentence,
    /// Finish the current code block / paragraph (may span several lines).
    Block,
    /// Complete the whole enclosing function or scope.
    Scope,
}

impl CompletionMode {
    /// Parse the frontend's mode string; anything unknown/absent falls back to the
    /// conservative `Sentence` mode.
    fn parse(s: &str) -> Self {
        match s {
            "block" => Self::Block,
            "scope" => Self::Scope,
            _ => Self::Sentence,
        }
    }

    /// Output cap (tokens). Larger modes need more room, but each stays bounded so
    /// a local model can't run away generating the rest of the file.
    fn num_predict(self) -> u32 {
        match self {
            Self::Sentence => 128,
            Self::Block => 256,
            Self::Scope => 512,
        }
    }
}

/// True when the cursor sits in the middle of a sentence — i.e. the last
/// non-space/tab character of `prefix` is a word/comma rather than a sentence
/// terminator, a newline, or the start of the document. Used to bias the model
/// toward finishing the current sentence first. Pure + tested.
fn is_mid_sentence(prefix: &str) -> bool {
    match prefix.trim_end_matches([' ', '\t']).chars().last() {
        None => false,
        Some(c) => !matches!(c, '.' | '!' | '?' | ':' | ';' | '\n'),
    }
}

/// Prose needs chat instructions even when the loaded model supports FIM.
fn is_completion_prose(language: &str) -> bool {
    matches!(language.to_ascii_lowercase().as_str(), "" | "text" | "plain" | "txt" | "markdown" | "md" | "mdx" | "tex" | "latex" | "rst")
}

/// Byte boundary of the first line/sentence end. Wait for lookahead after a
/// period so a decimal split across stream chunks is not cut in half.
fn completion_stop(text: &str, prose: bool, done: bool) -> Option<usize> {
    for (at, ch) in text.char_indices() {
        if ch == '\n' || ch == '\r' { return Some(at); }
        if prose && matches!(ch, '.' | '!' | '?' | '。' | '！' | '？') {
            let end = at + ch.len_utf8();
            let next = text[end..].chars().next();
            if matches!(ch, '。' | '！' | '？')
                || next.is_some_and(char::is_whitespace)
                || (done && next.is_none())
            {
                return Some(end);
            }
        }
    }
    None
}

/// Line-comment tokens used to recognise code-intent comments. Prose headings
/// are not comments; unknown code languages use the two most common tokens.
fn line_comment_tokens(language: &str) -> &'static [&'static str] {
    match language.to_ascii_lowercase().as_str() {
        "rust" | "c" | "cpp" | "c++" | "h" | "hpp" | "java" | "javascript" | "js" | "jsx"
        | "typescript" | "ts" | "tsx" | "go" | "swift" | "kotlin" | "kt" | "scala" | "dart"
        | "php" | "csharp" | "cs" | "c#" | "objc" | "objectivec" | "groovy" | "rust-objc" => {
            &["//"]
        }
        "python" | "py" | "ruby" | "rb" | "bash" | "sh" | "shell" | "zsh" | "perl" | "pl" | "r"
        | "yaml" | "yml" | "toml" | "makefile" | "make" | "dockerfile" | "elixir" | "ex"
        | "nix" => &["#"],
        "sql" | "lua" | "haskell" | "hs" | "ada" | "elm" => &["--"],
        "lisp" | "clojure" | "clj" | "scheme" | "racket" | "asm" => &[";"],
        "tex" | "latex" | "matlab" | "erlang" | "erl" => &["%"],
        // Prose / unknown-empty: do not treat any line as a code-intent comment.
        "" | "markdown" | "md" | "mdx" | "text" | "plain" | "txt" | "rst" | "html" | "xml"
        | "css" => &[],
        // Some other named code-ish language we don't have a table entry for.
        _ => &["//", "#"],
    }
}

/// If `line` is a single comment line, return its human-readable body (comment
/// token, any repeated token chars like `///`/`##`, surrounding `/* */`, and
/// whitespace stripped); otherwise `None`. Pure + tested.
fn strip_comment_line(line: &str, tokens: &[&str]) -> Option<String> {
    let t = line.trim();
    // Single-line block comment `/* … */` (C-family only).
    if tokens.contains(&"//") && t.starts_with("/*") {
        let body = t.trim_start_matches("/*").trim_end_matches("*/").trim();
        return Some(body.to_string());
    }
    for tok in tokens {
        if let Some(rest) = t.strip_prefix(tok) {
            // Drop extra repeats of the token's first char (`///`, `##`, `--!`).
            let lead = tok.chars().next().unwrap_or(' ');
            return Some(rest.trim_start_matches(lead).trim().to_string());
        }
    }
    None
}

/// Detect an "intent comment" sitting immediately before the caret and return its
/// combined text, so [`completion_prompt`] can switch from continuing prose to
/// *implementing the comment as code*. Fires when the caret is on a fresh (blank or
/// indent-only) line directly below a run of comment lines, or at the end of a
/// comment line itself; consecutive comment lines above are merged into one
/// instruction. Returns `None` for non-code languages, when there is no comment, or
/// when the text doesn't read like an instruction (needs ≥2 words and ≥3 letters,
/// so a lone `//` or a `// ----` divider never triggers). Pure + tested.
fn trailing_comment_intent(prefix: &str, language: &str) -> Option<String> {
    let tokens = line_comment_tokens(language);
    if is_completion_prose(language) || tokens.is_empty() {
        return None;
    }
    let lines: Vec<&str> = prefix.split('\n').collect();
    let n = lines.len();
    if n == 0 {
        return None;
    }
    // Index of the last comment line of the block to read.
    let last = if lines[n - 1].trim().is_empty() {
        // Caret on its own fresh line: the comment block is just above it.
        if n < 2 {
            return None;
        }
        n - 2
    } else if strip_comment_line(lines[n - 1], tokens).is_some() {
        // Caret at the end of a comment line itself.
        n - 1
    } else {
        return None;
    };
    // Walk up the consecutive run of comment lines ending at `last`.
    let mut texts = Vec::new();
    let mut i = last as isize;
    while i >= 0 {
        match strip_comment_line(lines[i as usize], tokens) {
            Some(t) => texts.push(t),
            None => break,
        }
        i -= 1;
    }
    texts.reverse();
    let intent = texts
        .iter()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let letters = intent.chars().filter(|c| c.is_alphabetic()).count();
    if letters >= 3 && intent.split_whitespace().count() >= 2 {
        Some(intent)
    } else {
        None
    }
}

/// A reference file the user attached to inform a completion (#45 context files).
/// Its `content` is included (size-capped) as read-only CONTEXT in the prompt so
/// the local model can draw on sibling project files when completing the current
/// one. Deserialized from the frontend's `context` array.
#[derive(serde::Deserialize)]
pub struct ContextFile {
    pub name: String,
    pub content: String,
}

/// Per-file and total caps (bytes) on attached context, so a few large files can't
/// blow past a small local model's context window. Each file is truncated to the
/// per-file cap; files are included in order until the total cap is reached.
const MAX_CONTEXT_PER_FILE: usize = 6000;
const MAX_CONTEXT_TOTAL: usize = 24000;

/// Truncate `s` to at most `max` bytes, backing off to the nearest char boundary
/// so the result is always valid UTF-8. Pure.
fn truncate_chars(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].to_string()
}

/// Build the read-only CONTEXT preamble from attached reference files, size-capped
/// (see [`MAX_CONTEXT_PER_FILE`]/[`MAX_CONTEXT_TOTAL`]). Each file becomes a labelled
/// `--- <name> ---` block; empty/whitespace-only files are skipped. Returns an empty
/// string when there is nothing to include, so [`completion_prompt`] can omit the
/// section entirely. Pure + tested.
fn build_context_block(files: &[ContextFile]) -> String {
    let mut out = String::new();
    let mut total = 0usize;
    for f in files {
        if total >= MAX_CONTEXT_TOTAL {
            break;
        }
        let cap = MAX_CONTEXT_PER_FILE.min(MAX_CONTEXT_TOTAL - total);
        let body = truncate_chars(f.content.trim(), cap);
        if body.is_empty() {
            continue;
        }
        total += body.len();
        out.push_str("--- ");
        out.push_str(f.name.trim());
        out.push_str(" ---\n");
        out.push_str(&body);
        out.push_str("\n\n");
    }
    out
}

/// Build the user message paired with [`COMPLETION_SYSTEM`]: a per-caret TASK hint
/// plus the text before the caret (`prefix`) and after it (`suffix`) as labelled
/// sections, so the model inserts at the cursor rather than rewriting the document.
/// The TASK is selected by `mode`: `Sentence` keeps the insertion to the current
/// word/sentence/line (and, when mid-sentence, biases toward finishing it first),
/// `Block` completes the current block/paragraph, and `Scope` the whole enclosing
/// function or scope. When `context` is non-empty it is inserted as a read-only
/// REFERENCE FILES section before BEFORE/AFTER. Pure + tested.
fn completion_prompt(
    prefix: &str,
    suffix: &str,
    language: &str,
    mode: CompletionMode,
    context: &str,
) -> String {
    let lang = if language.is_empty() {
        "text"
    } else {
        language
    };
    // When the caret sits just after a natural-language comment, switch from
    // continuing text to *implementing that comment as code* (#45 intent comments).
    let task: String = if let Some(desc) = trailing_comment_intent(prefix, language) {
        format!(
            "TASK: The comment line(s) immediately above the cursor describe the code to write \
next: \"{desc}\". Output the {lang} code that implements that description, starting on a new line \
below the comment, matching the surrounding indentation and style, and joining smoothly into AFTER. \
Write only that code — do not repeat, rewrite, or extend the comment, and add no explanations."
        )
    } else {
        match mode {
            CompletionMode::Sentence => {
                if is_mid_sentence(prefix) {
                    "TASK: The cursor is in the middle of a sentence. Output only what completes the \
current word and sentence so it joins smoothly into AFTER. Keep it to a single sentence or line; do \
not begin a new paragraph."
                } else {
                    "TASK: Continue from the end of BEFORE with a brief, on-topic insertion that leads \
into AFTER. Keep it to one sentence or line; do not begin a new paragraph or topic."
                }
            }
            CompletionMode::Block => {
                "TASK: Continue from the end of BEFORE, completing the current line and the rest of the \
current code block, statement, or paragraph. You may span several lines, but stop at the end of that \
block — do not write the remainder of the document."
            }
            CompletionMode::Scope => {
                "TASK: Continue from the end of BEFORE, completing the entire enclosing function, block, \
or scope — its full body, with balanced brackets and indentation — so it joins into AFTER. Stop at \
the end of that function or scope; do not continue past it."
            }
        }
        .to_string()
    };
    let reference = if context.is_empty() {
        String::new()
    } else {
        format!(
            "REFERENCE FILES (read-only context from the project — use only to inform the \
insertion; never output, quote, or repeat them):\n{context}\n"
        )
    };
    let prose = if is_completion_prose(language) {
        "Continue prose in the natural language of BEFORE and AFTER, even when references use another language. Preserve Markdown/LaTeX markup. Do not translate or switch to English.\n"
    } else { "" };
    format!("Language: {lang}\n{prose}{task}\n\n{reference}BEFORE:\n{prefix}\n\nAFTER:\n{suffix}")
}

/// Strip wrapping artefacts a chat model sometimes adds around a raw completion:
/// a leading conversational preamble line ("Here is the continuation:") and
/// leading/trailing code fences. Conservative — a preamble line is dropped only
/// when it clearly reads as a preface AND ends with ':', so real first lines are
/// never eaten. Pure + tested.
fn clean_completion(raw: &str) -> String {
    let mut s = raw.trim_matches('\n').to_string();

    // Defense in depth (the system prompt already forbids it): drop a leading
    // preamble line if the model added one anyway.
    if let Some(nl) = s.find('\n') {
        let first = s[..nl].trim();
        let lower = first.to_ascii_lowercase();
        let is_preamble = first.ends_with(':')
            && [
                "here is",
                "here's",
                "here are",
                "sure",
                "certainly",
                "of course",
                "the continuation",
                "continuation",
                "the reformatted",
                "the completed",
            ]
            .iter()
            .any(|p| lower.starts_with(p));
        if is_preamble {
            s = s[nl + 1..].trim_start_matches('\n').to_string();
        }
    }

    // Drop a leading ```lang fence and a trailing ``` if the model wrapped it.
    if s.starts_with("```") {
        if let Some(nl) = s.find('\n') {
            s = s[nl + 1..].to_string();
        }
        if let Some(idx) = s.rfind("```") {
            s = s[..idx].to_string();
        }
    }
    s
}

/// Smallest overlap we bother trimming, in chars — short enough to catch a
/// repeated word/operator ("fox", "a +") but above incidental 1–2 char matches.
const MIN_SEAM_OVERLAP: usize = 3;

/// Largest number of leading chars of `b` that are also a suffix of `a` (aligned
/// on char boundaries); 0 when there is no overlap. Completions are short, so the
/// quadratic scan is cheap. Pure + tested.
fn overlap_len(a: &str, b: &str) -> usize {
    let max = a.len().min(b.len());
    for k in (1..=max).rev() {
        if b.is_char_boundary(k) && a.is_char_boundary(a.len() - k) && a[a.len() - k..] == b[..k] {
            return k;
        }
    }
    0
}

/// Remove text the model echoed from the surrounding context, so only the genuinely
/// new insertion remains. Small models often repeat the word/line just before the
/// cursor (BEFORE "…return " → completion "return a + b") or pre-echo the text just
/// after it. Trims a leading run of `completion` that repeats the tail of `prefix`
/// and a trailing run that repeats the head of `suffix`, ignoring whitespace at the
/// seam. Pure + tested.
fn trim_context_overlap(prefix: &str, suffix: &str, completion: &str) -> String {
    // Leading overlap with the end of BEFORE.
    let head = completion.trim_start();
    let p = prefix.trim_end();
    let mut c = match overlap_len(p, head) {
        n if n >= MIN_SEAM_OVERLAP => head[n..].trim_start(),
        _ => completion,
    };

    // Trailing overlap with the start of AFTER.
    let tail = c.trim_end();
    let s = suffix.trim_start();
    if overlap_len(tail, s) >= MIN_SEAM_OVERLAP {
        let m = overlap_len(tail, s);
        c = tail[..tail.len() - m].trim_end();
    }
    c.to_string()
}

/// Reserve before starting so a frontend abort can cancel even before the
/// generation command has arrived. Reservations expire if the caller disappears.
#[tauri::command]
pub fn prepare_text_completion() -> Result<String, String> {
    crate::services::text_completion::reserve()
}

#[tauri::command]
pub fn cancel_text_completion(request_id: String) {
    crate::services::text_completion::cancel(&request_id);
}

/// Preserve native FIM whitespace. Chat output still needs conservative wrapper
/// cleanup; withhold incomplete fence/preamble lines while tokens arrive.
fn completion_preview(raw: &str, fim: bool, done: bool, prefix: &str, suffix: &str) -> String {
    if fim {
        return raw.to_string();
    }
    if !done && !raw.contains('\n') {
        let first = raw.trim_start().to_ascii_lowercase();
        if first.starts_with('`')
            || [
                "here is",
                "here's",
                "here are",
                "sure",
                "certainly",
                "of course",
                "continuation",
                "the continuation",
                "the completed",
                "the reformatted",
            ]
            .iter()
            .any(|p| p.starts_with(&first) || first.starts_with(p))
        {
            return String::new();
        }
    }
    let cleaned = clean_completion(raw);
    // Do not flicker by removing a suffix match that may still grow. The final
    // snapshot applies both seams before the frontend marks it finished.
    trim_context_overlap(prefix, if done { suffix } else { "" }, &cleaned)
}

fn completion_body(
    prefix: &str,
    suffix: &str,
    model: &str,
    language: &str,
    mode: CompletionMode,
    context: &str,
    fim: bool,
) -> serde_json::Value {
    let intent = trailing_comment_intent(prefix, language).is_some();
    let cap = if intent {
        mode.num_predict().max(CompletionMode::Block.num_predict())
    } else {
        mode.num_predict()
    };
    let mut body = serde_json::json!({
        "model": model, "stream": true, "think": false,
        "options": { "temperature": 0.1, "num_predict": cap }
    });
    if fim {
        body["prompt"] = prefix.into();
        body["suffix"] = suffix.into();
        if mode == CompletionMode::Sentence && !intent {
            body["options"]["stop"] = serde_json::json!(["\n"]);
        }
    } else {
        body["messages"] = serde_json::json!([
            { "role": "system", "content": COMPLETION_SYSTEM },
            { "role": "user", "content": completion_prompt(prefix, suffix, language, mode, context) }
        ]);
    }
    body
}

/// Streaming completion through the configured Ollama endpoint. Insert support
/// comes from /api/show capabilities, carried by list_ollama_models_detailed.
/// Attached references stay on the chat path to avoid injecting prose into raw
/// source. Unsupported FIM falls back to chat before any ghost is published.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn complete_text(
    window: tauri::WebviewWindow,
    prefix: String,
    suffix: String,
    model: String,
    language: String,
    mode: Option<String>,
    context: Option<Vec<ContextFile>>,
    insert: Option<bool>,
    request_id: String,
    candidate: Option<u32>,
    project_id: Option<String>,
) -> Result<String, String> {
    use crate::services::text_completion;
    use tauri::Emitter;
    let event = format!("text-completion-{request_id}");
    text_completion::run(request_id, async move {
        let settings = read_settings().unwrap_or_default();
        let local_only = project_id.as_ref().and_then(|id| settings.completion_project_policies.as_ref()?.get(id))
            .is_some_and(|policy| policy.local_only);
        let addr = resolve_ollama_addr(settings.ollama_host.as_deref(),
            !local_only && settings.ollama_allow_remote_host.unwrap_or(false))?;
        let client = text_completion::client()?;
        let mode = CompletionMode::parse(mode.as_deref().unwrap_or("sentence"));
        let context = context
            .as_deref()
            .map(build_context_block)
            .unwrap_or_default();
        // Bound independently of the UI for callers other than the text viewer.
        let prefix = bounded_completion_prefix(&prefix);
        let suffix = truncate_chars(&suffix, 4096);
        let prose = is_completion_prose(&language);
        let sentence = mode == CompletionMode::Sentence && trailing_comment_intent(&prefix, &language).is_none();
        // Prose always uses chat so language/markup instructions are effective.
        let fim = !prose && insert == Some(true) && context.is_empty() && !suffix.is_empty();
        for use_fim in if fim { vec![true, false] } else { vec![false] } {
            let mut body =
                completion_body(&prefix, &suffix, &model, &language, mode, &context, use_fim);
            let candidate = candidate.unwrap_or(0).min(2);
            body["options"]["seed"] = serde_json::json!(candidate + 1);
            if candidate > 0 {
                body["options"]["temperature"] = serde_json::json!(0.5);
            }
            let endpoint = if use_fim { "generate" } else { "chat" };
            let mut published = false;
            let result = text_completion::stream(
                &client,
                &format!("http://{addr}/api/{endpoint}"),
                &body,
                |raw, done| {
                    let mut text = completion_preview(raw, use_fim, done, &prefix, &suffix);
                    let stop = sentence.then(|| completion_stop(&text, prose, done)).flatten();
                    if let Some(end) = stop { text.truncate(end); }
                    published |= !text.is_empty();
                    // Target only the requesting editor window. IPC Channels bypass
                    // the embedded browser's origin ACL (see browser.rs tests).
                    window
                        .emit_to(window.label(), &event, text)
                        .map_err(|e| e.to_string())?;
                    Ok(stop.is_some())
                },
            )
            .await;
            match result {
                Ok(raw) => {
                    let mut text = completion_preview(&raw, use_fim, true, &prefix, &suffix);
                    if sentence {
                        if let Some(end) = completion_stop(&text, prose, true) { text.truncate(end); }
                    }
                    return Ok(text);
                }
                Err(e)
                    if use_fim
                        && !published
                        && (e.contains("400") || e.contains("does not support insert")) =>
                {
                    continue
                }
                Err(e) => return Err(e),
            }
        }
        unreachable!("chat always returns")
    })
    .await
}

fn bounded_completion_prefix(prefix: &str) -> String {
    let mut start = prefix.len().saturating_sub(16_384);
    while !prefix.is_char_boundary(start) {
        start += 1;
    }
    prefix[start..].to_string()
}

/// Result of preparing a local Ollama agent for vibe.
#[derive(serde::Serialize)]
pub struct LocalAgentPrep {
    /// Path to the dedicated per-model VIBE_HOME directory. Pass as `VIBE_HOME=<vibe_home>`.
    pub vibe_home: String,
    /// Model alias — also set as `VIBE_ACTIVE_MODEL=<alias>` for redundancy.
    pub alias: String,
}

/// Prepare a dedicated per-model VIBE_HOME for a local Ollama tab.
///
/// Creates `~/.local/share/tabtivity/vibe_local/{alias}/config.toml` with:
/// - `active_model = "{alias}"` so vibe selects the correct model even when
///   the `VIBE_ACTIVE_MODEL` env var is shadowed by the global `~/.vibe/config.toml`.
/// - `enabled_tools = ["__no_tools__"]` to disable tool calls for local models.
///   A root-console tab whose model wears the 🧠 menu's "MCP" chip gets the
///   root MCP tools back through Vibe's env layer (`services::root_mcp`).
/// - A single provider + model block for this Ollama model.
///
/// Each Ollama tab gets its own VIBE_HOME subdirectory so there is no shared
/// mutable config state and `active_model` is always unambiguous.
#[tauri::command]
pub async fn prepare_local_agent(model: String) -> Result<LocalAgentPrep, String> {
    validate_model_name(&model)?;
    let alias = sanitize_alias(&model);
    let vibe_home = app_vibe_local_dir_for(&alias)?;
    std::fs::create_dir_all(&vibe_home).map_err(|e| format!("create vibe_local dir: {e}"))?;

    let config_path = vibe_home.join("config.toml");

    let mut cfg = format!("active_model = \"{alias}\"\nenabled_tools = [\"__no_tools__\"]\n");
    cfg.push_str(&ollama_provider_block());
    cfg.push_str(&ollama_model_block(&model, &alias));

    std::fs::write(&config_path, cfg).map_err(|e| format!("write vibe_local config: {e}"))?;
    crate::services::agent_session::register_vibe_hook_in(&vibe_home)
        .map_err(|e| format!("register vibe session hook: {e}"))?;

    Ok(LocalAgentPrep {
        vibe_home: vibe_home.to_string_lossy().into_owned(),
        alias,
    })
}

/// Ensure the Ollama provider and the given model are registered in
/// `~/.vibe/config.toml` so that `VIBE_ACTIVE_MODEL=<alias>` works.
/// Returns the alias string to pass as `VIBE_ACTIVE_MODEL`.
#[tauri::command]
pub async fn ensure_vibe_ollama_model(model: String) -> Result<String, String> {
    validate_model_name(&model)?;
    let alias = sanitize_alias(&model);

    let config_path = dirs_vibe_config()?;

    let content = std::fs::read_to_string(&config_path).unwrap_or_default();

    let mut appended = String::new();

    if !content.contains("name = \"ollama\"") {
        appended.push_str(&ollama_provider_block());
    }

    let model_marker = format!("alias = \"{}\"", alias);
    if !content.contains(&model_marker) {
        appended.push_str(&ollama_model_block(&model, &alias));
    }

    if !appended.is_empty() {
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&config_path)
            .map_err(|e| format!("open vibe config: {e}"))?;
        file.write_all(appended.as_bytes())
            .map_err(|e| format!("write vibe config: {e}"))?;
    }

    Ok(alias)
}

// ── Local-model coding agents (ollama launch + fallbacks) ─────────────────────
//
// Beyond Mistral's `vibe` (see `prepare_local_agent`), the single active local
// Ollama model can drive other coding agents. The preferred path is Ollama's own
// `ollama launch <agent> --model <model>` (shipped v0.15): it wires Claude Code,
// Codex, OpenCode and Droid to the local server — including Claude Code's
// Anthropic-compatible endpoint, which we can't hand-roll the way vibe gets an
// OpenAI one. When `ollama launch` is unavailable we fall back to a direct
// invocation for the agents that natively accept a local Ollama endpoint.

/// A coding agent that can drive the local Ollama model.
#[derive(Clone, Copy)]
struct LocalDriver {
    /// Stable id used by the frontend picker and `prepare_local_launch`.
    id: &'static str,
    /// Human-readable label.
    label: &'static str,
    /// The agent's own binary name. The driver is only offered when this is
    /// actually installed — `ollama launch <sub>` still drives the agent's CLI,
    /// so a missing binary means the tab can't run regardless of `launch`.
    bin: &'static str,
    /// `ollama launch <sub> --model <model>` subcommand, when supported.
    launch_sub: Option<&'static str>,
    /// Direct fallback when `ollama launch` is unavailable: the binary to spawn
    /// and its args (with the `{model}` placeholder substituted). `None` means
    /// the agent can only be wired up by `ollama launch` itself.
    fallback: Option<(&'static str, &'static [&'static str])>,
    /// True when the agent drives the model through **tool/function calls**, so
    /// a model with no `tools` capability cannot run it at all — Ollama refuses
    /// the very first request with `does not support tools` and the tab is dead
    /// on arrival. Every entry below is `true`, because every entry is a coding
    /// agent; the flag is explicit rather than assumed because `vibe` — which is
    /// deliberately *not* in this list — takes the opposite route and turns
    /// tools off (`enabled_tools = ["__no_tools__"]` in `prepare_local_agent`),
    /// which is exactly why it still works on a completion-only model.
    needs_tools: bool,
    /// Extra **fallback** args that switch the agent's reasoning off, for the
    /// agents that send a reasoning effort whether or not the model can take
    /// one. `Some` carries a second meaning that matters more than the args:
    /// this driver must **bypass `ollama launch`** on a model with no
    /// `thinking` capability. `ollama launch <agent>` forwards nothing — it
    /// rejects any extra flag with `unknown shorthand flag` — so the override
    /// can only ride the direct invocation, and `launch`'s own wiring (a
    /// generated `~/.codex/model.json` + profile) does not turn reasoning off
    /// on the user's behalf. `None` means the agent sends no reasoning field
    /// and runs on a non-thinking model unchanged.
    non_thinking_args: Option<&'static [&'static str]>,
    /// True when the agent needs a **model-metadata catalog** written for it on
    /// the direct-invocation path — the other thing `ollama launch` was doing
    /// (it generates `~/.codex/model.json` and points Codex at it). Without one
    /// Codex falls back to built-in metadata and reasons about the context
    /// window from a guess. See [`write_local_catalog`].
    wants_local_catalog: bool,
    /// True when the agent wraps every turn in a **large system prompt built for
    /// a frontier model** — tool schemas, sandbox and patch policy, the user's
    /// own `~/.codex` / `~/.claude` configuration and any MCP servers declared
    /// there. It is not a capability the model reports and there is no probe for
    /// it; it is a property of the *agent*, which is why it lives in this
    /// registry beside the launch wiring rather than being derived.
    ///
    /// It exists because the `tools` gate above is a gate against a tab that
    /// **cannot start**, and this is the other failure — a tab that starts and
    /// then answers badly. Measured on `qwen3-coder:latest`, which reports
    /// `tools` and passes every other check here: the plain Ollama chat endpoint
    /// answers `"test"` sensibly in 27 tokens, while Codex's harness put 5128
    /// tokens in front of the same model and it ran away past 4100 tokens
    /// without stopping. Nothing about the model's advertised capabilities
    /// predicts that.
    ///
    /// It is deliberately **not** a reason to withhold the driver. Which local
    /// models cope is a fact about the model, the machine and the task, and the
    /// only honest thing to do with an unprobeable risk is to say so and let the
    /// user try it — the alternative, hiding the agent, is what the `thinking`
    /// capability was considered for and rejected: no model on the reporting
    /// machine carried both `tools` and `thinking`, so gating on it would have
    /// emptied the group entirely rather than steered anyone to a better model.
    ///
    /// Every entry below is `true`, because every entry is a general-purpose
    /// coding-agent CLI written against hosted frontier models. The flag is a
    /// per-row decision anyway, so a driver added later that is built for local
    /// models (as Mistral's `vibe` is — which is exactly why it is *not* in this
    /// list) states that by setting it `false`.
    heavy_harness: bool,
}

/// Registry of local-model coding agents, in picker order. `vibe` is intentionally
/// absent — it keeps its bespoke per-model VIBE_HOME path in `prepare_local_agent`.
const LOCAL_DRIVERS: &[LocalDriver] = &[
    LocalDriver {
        id: "claude",
        label: "Claude Code",
        bin: "claude",
        launch_sub: Some("claude"),
        // Claude Code needs an Anthropic-compatible endpoint, which only
        // `ollama launch` stands up — no reliable hand-rolled fallback.
        fallback: None,
        needs_tools: true,
        non_thinking_args: None,
        wants_local_catalog: false,
        heavy_harness: true,
    },
    LocalDriver {
        id: "codex",
        label: "Codex",
        bin: "codex",
        launch_sub: Some("codex"),
        // `codex --oss -m <model>` talks to the local Ollama server directly.
        // `oss_provider` is named because Codex ≥0.146 refuses `--oss` with
        // "No default OSS provider configured" unless one is set; it goes
        // through `-c` rather than the `--local-provider` flag that error
        // suggests, because an unknown *config key* is ignored by an older
        // Codex while an unknown *flag* is a hard argv error.
        fallback: Some((
            "codex",
            &["--oss", "-c", "oss_provider=\"ollama\"", "-m", "{model}"],
        )),
        needs_tools: true,
        non_thinking_args: Some(&["-c", "model_reasoning_effort=\"none\""]),
        wants_local_catalog: true,
        heavy_harness: true,
    },
    LocalDriver {
        id: "opencode",
        label: "OpenCode",
        bin: "opencode",
        // Never `ollama launch`: it sets its own `OPENCODE_CONFIG_CONTENT`
        // (clobbering the loaded-models list `pty_spawn` hands every OpenCode —
        // see `opencode_loaded_models_config`) and appends each launched model
        // to the user's opencode.jsonc for good.
        launch_sub: None,
        // The `ollama` provider — named by the user's config or by the inline
        // one `pty_spawn` injects; `--model ollama/<model>` selects it.
        fallback: Some(("opencode", &["--model", "ollama/{model}"])),
        needs_tools: true,
        non_thinking_args: None,
        wants_local_catalog: false,
        heavy_harness: true,
    },
    LocalDriver {
        id: "droid",
        label: "Droid",
        bin: "droid",
        launch_sub: Some("droid"),
        // Droid is configured via ~/.factory/config.json; only `ollama launch`
        // writes that wiring for us.
        fallback: None,
        needs_tools: true,
        non_thinking_args: None,
        wants_local_catalog: false,
        heavy_harness: true,
    },
    LocalDriver {
        id: "openclaw",
        label: "OpenClaw",
        bin: "openclaw",
        launch_sub: Some("openclaw"),
        // Launch-only: `ollama launch openclaw` installs OpenClaw if missing and
        // stands up its gateway against the local Ollama endpoint. There's no
        // documented standalone flag to point `openclaw` at a local server, so
        // no hand-rolled fallback.
        fallback: None,
        needs_tools: true,
        non_thinking_args: None,
        wants_local_catalog: false,
        heavy_harness: true,
    },
];

/// True when the installed Ollama exposes the `launch` subcommand (v0.15+).
/// Cheap probe: `ollama launch --help` exits 0 only when the subcommand exists.
fn ollama_has_launch() -> bool {
    crate::paths::command_no_window("ollama")
        .args(["launch", "--help"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Build the fallback launch spec for a driver, substituting `{model}` and
/// appending `extra` (the reasoning-off override, when one is needed). Pure +
/// tested; `prepare_local_launch` uses it when `ollama launch` is missing — or
/// when `extra` is non-empty, since `launch` cannot carry it.
fn fallback_spec(driver: &LocalDriver, model: &str, extra: &[&str]) -> Option<LocalLaunchSpec> {
    driver.fallback.map(|(bin, args)| LocalLaunchSpec {
        cmd: bin.to_string(),
        args: args
            .iter()
            .chain(extra.iter())
            .map(|a| a.replace("{model}", model))
            .collect(),
    })
}

/// Whether `cmd args` is a launch line [`prepare_local_launch`] can have
/// produced for `driver` and `model` — the check a persisted local-model tab
/// (`localLaunch` in `terminals.json`) passes before a restore may run it again
/// (`services::terminal_service`), and before the phone may attach to it
/// (`services::mobile_control::discovery`).
///
/// It enumerates the forms instead of re-resolving: `ollama launch`, the direct
/// fallback with or without the reasoning-off override, and Codex's catalog
/// pair after either. So it probes nothing, and a line written while
/// `ollama launch` existed stays valid after a downgrade — it then fails at
/// spawn, exactly as a fresh launch would. A model that could read as a flag
/// is refused although `validate_model_name` lets a leading `-` through.
pub(crate) fn local_launch_line_ok(driver: &str, model: &str, cmd: &str, args: &[String]) -> bool {
    let Some(driver) = LOCAL_DRIVERS.iter().find(|d| d.id == driver) else {
        return false;
    };
    if validate_model_name(model).is_err() || model != model.trim() || model.starts_with('-') {
        return false;
    }
    if let Some(sub) = driver.launch_sub {
        if cmd == "ollama" && args == ["launch", sub, "--model", model] {
            return true;
        }
    }
    let catalog = driver
        .wants_local_catalog
        .then(|| catalog_arg_pair(&local_catalog_path(model)));
    [&[][..], driver.non_thinking_args.unwrap_or(&[])]
        .iter()
        .filter_map(|extra| fallback_spec(driver, model, extra))
        .any(|spec| {
            spec.cmd == cmd
                && (args == spec.args
                    || catalog.as_ref().is_some_and(|pair| {
                        args.len() == spec.args.len() + pair.len()
                            && args[..spec.args.len()] == spec.args[..]
                            && args[spec.args.len()..] == pair[..]
                    }))
        })
}

/// The CLI a local driver runs (`claude` for `"claude"`), for naming the agent
/// of a persisted local-model tab whose own `cmd` may be `ollama`.
pub(crate) fn local_driver_bin(driver: &str) -> Option<&'static str> {
    LOCAL_DRIVERS.iter().find(|d| d.id == driver).map(|d| d.bin)
}

/// The extra args this driver needs for `model`, and whether they force the
/// direct invocation. Pure so the rule is testable without an Ollama:
/// `thinking` is the already-narrowed [`model_supports_thinking`] answer, so
/// "could not tell" arrives as `None` and changes nothing — an agent that
/// errors is recoverable, one silently stripped of reasoning is not.
fn non_thinking_override(driver: &LocalDriver, thinking: Option<bool>) -> &[&'static str] {
    match (driver.non_thinking_args, thinking) {
        (Some(args), Some(false)) => args,
        _ => &[],
    }
}

// ── OpenCode: the loaded Ollama models, handed over at launch ─────────────────
//
// OpenCode's `ollama` provider lists whatever models its config names — a list
// that goes stale the moment another model is loaded (`ollama launch opencode`
// appends to it and never prunes). Tabtivity never edits OpenCode's config, so an
// OpenCode spawn gets `OPENCODE_CONFIG_CONTENT` instead: an inline config
// OpenCode deep-merges over the user's own, naming the models resident in
// Ollama right now and whitelisting only those.

/// The model an OpenCode spawn asks for, or `None` when `cmd`/`args` do not
/// start OpenCode at all. The inner `Option` is the requested **Ollama** model
/// — `opencode --model ollama/<m>` (the direct fallback) or `ollama launch
/// opencode --model <m>` — which is whitelisted even when not loaded yet, since
/// Ollama loads it on the first request and hiding it would kill the tab.
pub(crate) fn opencode_spawn_model(cmd: &str, args: &[String]) -> Option<Option<String>> {
    let bin = std::path::Path::new(cmd)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(cmd);
    let via_launch = match bin {
        "opencode" => false,
        "ollama" if args.first().map(String::as_str) == Some("launch")
            && args.get(1).map(String::as_str) == Some("opencode") =>
        {
            true
        }
        _ => return None,
    };
    let model = args.iter().enumerate().find_map(|(i, a)| {
        a.strip_prefix("--model=")
            .map(str::to_string)
            .or_else(|| (a == "--model" || a == "-m").then(|| args.get(i + 1).cloned()).flatten())
    });
    Some(model.and_then(|m| {
        if via_launch {
            Some(m)
        } else {
            m.strip_prefix("ollama/").map(str::to_string)
        }
    }))
}

/// Model names from an `/api/ps` body, or `None` when the body is not one.
fn loaded_model_names(ps_body: &str) -> Option<Vec<String>> {
    let v = serde_json::from_str::<serde_json::Value>(ps_body).ok()?;
    Some(
        v["models"]
            .as_array()?
            .iter()
            .filter_map(|m| m["name"].as_str().or_else(|| m["model"].as_str()))
            .map(str::to_string)
            .collect(),
    )
}

/// The inline OpenCode config: the `ollama` provider pointed at `addr`, carrying
/// `loaded` (plus `requested`) as its models and whitelisting exactly those, so
/// models the user's config names but Ollama has not loaded drop out of the
/// picker. An empty list is kept deliberately: nothing loaded means no Ollama
/// models to offer. Pure + tested.
fn opencode_ollama_config(addr: &str, loaded: &[String], requested: Option<&str>) -> String {
    let mut names: Vec<&str> = loaded.iter().map(String::as_str).collect();
    if let Some(r) = requested.filter(|r| !r.is_empty() && !names.contains(r)) {
        names.push(r);
    }
    let models: serde_json::Map<String, serde_json::Value> = names
        .iter()
        .map(|n| (n.to_string(), serde_json::json!({ "name": n })))
        .collect();
    serde_json::json!({
        "provider": {
            "ollama": {
                "npm": "@ai-sdk/openai-compatible",
                "name": "Ollama (local)",
                "options": { "baseURL": format!("http://{addr}/v1") },
                "models": models,
                "whitelist": names,
            }
        }
    })
    .to_string()
}

/// `OPENCODE_CONFIG_CONTENT` for an OpenCode spawn asking for `requested`, or
/// `None` when Ollama cannot be asked — an unreachable server leaves the user's
/// own config alone rather than emptying its model list on a guess.
pub(crate) fn opencode_loaded_models_config(requested: Option<&str>) -> Option<String> {
    let loaded = loaded_model_names(&ollama_http("GET", "/api/ps", None).ok()?)?;
    let addr = ollama_addr().ok()?;
    Some(opencode_ollama_config(&addr, &loaded, requested))
}

/// One local-model driver plus whether Tabtivity currently has a way to launch it.
#[derive(serde::Serialize)]
pub struct LocalDriverInfo {
    pub id: String,
    pub label: String,
    /// True when the agent's binary is installed, Tabtivity has a way to wire it to
    /// the local model (`ollama launch` supports it, or a direct fallback
    /// exists), **and** the model given to [`list_local_drivers`] can actually
    /// drive it. The menu hides drivers that aren't available.
    pub available: bool,
    /// Set when the *only* thing standing in the way is the model: the agent is
    /// installed and wireable, but the model has no `tools` capability. It
    /// separates "you don't have this agent" from "this agent can't run on the
    /// model you picked", which are different problems with different fixes.
    pub needs_tools_unsupported: bool,
    /// [`LocalDriver::heavy_harness`], passed through so the menu can caution
    /// that this agent's prompt was built for a frontier model. Never a reason
    /// to hide the row — `available` is the only field that withholds one.
    pub heavy_harness: bool,
}

/// List the local-model coding agents (Claude Code, Codex, OpenCode, Droid) with
/// their availability, so the Local Model menu can offer them alongside
/// Mistral/vibe. Probes `ollama launch` once.
///
/// `model` is the local model the tab would run — the active one, as chosen in
/// the 🧠 menu. Passing it is what lets an agent be withheld from a model that
/// cannot drive it: these are all tool-calling agents, and Ollama answers the
/// first request against a completion-only model (`llama3` is one) with
/// `does not support tools`, i.e. the tab dies on arrival with an error only a
/// reader of the raw API response could act on. Omitting `model` skips that
/// filter entirely rather than guessing.
///
/// The gate is **`tools` capability and nothing else**, which is narrower than
/// the question "will this model be any good at driving an agent". Ollama's own
/// launcher asks the second one and has its own opinion: `ollama launch claude
/// --model deepseek-r1` puts up an interactive "does not work well with Claude
/// Code … Launch anyway?" menu, even though that model advertises `tools` and so
/// passes here. Both `deepcoder` and `deepseek-r1` are in that gap — they report
/// `tools`, this gate lets them through, and the launcher then asks. That is
/// deliberately left alone: the prompt lands in a real PTY the user can answer,
/// and the only lever `ollama launch` offers is a blanket `-y` that would also
/// auto-accept its "Upgrade to use <agent>?" prompt, i.e. silently upgrade the
/// user's agent CLI. Mirroring the launcher's list here instead would mean
/// hardcoding models, which is the thing [`prepare_local_launch`] already
/// refuses to do because such a list ages.
///
/// The filter runs on **positive knowledge only**. If Ollama is down, or too old
/// to report capabilities, the model's list comes back empty and every driver
/// stays offered — an agent that errors is a worse outcome than a menu that is
/// briefly wrong, but an agent that silently vanishes because a probe timed out
/// is worse than both.
#[tauri::command]
pub async fn list_local_drivers(model: Option<String>) -> Vec<LocalDriverInfo> {
    let has_launch = ollama_has_launch();
    // `None` — no model given, or Ollama couldn't say — means "don't filter".
    let tools = model
        .as_deref()
        .filter(|m| !m.trim().is_empty())
        .and_then(model_supports_tools);
    let model_lacks_tools = tools == Some(false);

    LOCAL_DRIVERS
        .iter()
        .map(|d| {
            // Both must hold: the agent itself is installed, and we have a wiring
            // path (ollama launch or a direct fallback). A driver whose binary is
            // missing (e.g. Droid) is no longer offered.
            let wireable = crate::commands::agents::binary_is_installed(d.bin)
                && ((d.launch_sub.is_some() && has_launch) || d.fallback.is_some());
            let (available, needs_tools_unsupported) =
                driver_verdict(d.needs_tools, wireable, model_lacks_tools);
            LocalDriverInfo {
                id: d.id.to_string(),
                label: d.label.to_string(),
                available,
                needs_tools_unsupported,
                heavy_harness: d.heavy_harness,
            }
        })
        .collect()
}

/// `(available, needs_tools_unsupported)` for one driver. Pure, so the rule the
/// menu depends on is testable without an Ollama: an agent is withheld **only**
/// when it is otherwise launchable and the model is positively known to lack
/// tools — `model_lacks_tools` is already the narrowed form of
/// [`model_supports_tools`]'s `Option`, so "couldn't tell" arrives here as
/// `false` and changes nothing.
fn driver_verdict(needs_tools: bool, wireable: bool, model_lacks_tools: bool) -> (bool, bool) {
    let blocked_by_model = needs_tools && model_lacks_tools;
    (wireable && !blocked_by_model, wireable && blocked_by_model)
}

/// The command + args to spawn for a local-model agent tab.
#[derive(serde::Serialize)]
pub struct LocalLaunchSpec {
    pub cmd: String,
    pub args: Vec<String>,
}

/// Resolve how to drive the local Ollama `model` through `agent` (one of the
/// [`LOCAL_DRIVERS`] ids). Prefers `ollama launch <agent> --model <model>`; falls
/// back to a direct invocation when launch is unavailable. Errors when the agent
/// is unknown, or it is launch-only and `ollama launch` is missing. The model is
/// validated and passed as a discrete arg (no shell), so it can't inject.
#[tauri::command]
pub async fn prepare_local_launch(agent: String, model: String) -> Result<LocalLaunchSpec, String> {
    validate_model_name(&model)?;
    let driver = LOCAL_DRIVERS
        .iter()
        .find(|d| d.id == agent)
        .ok_or_else(|| format!("unknown local driver: {agent}"))?;

    // The menu already withholds a tool-calling agent from a model that has no
    // `tools` capability, but the menu is a cache: it is built once and the
    // active model changes under it. Refusing here is what makes the guard true
    // rather than merely usually true — and the message has to name the fix,
    // because Ollama's own (`… does not support tools`) reaches the user as a
    // raw JSON error inside a terminal tab that then just sits there.
    if driver.needs_tools && model_supports_tools(&model) == Some(false) {
        // Name the models that *would* work rather than a fixed list of ones
        // that wouldn't: which models are tool-capable is a fact about this
        // machine's installed set, and a hardcoded example list would age.
        let usable = tool_capable_models();
        let suggestion = if usable.is_empty() {
            "None of the models installed here support them — pull one that does \
             (its Ollama page lists `tools` under Capabilities)."
                .to_string()
        } else {
            format!(
                "Pick one of these in the 🧠 menu instead: {}.",
                usable.join(", ")
            )
        };
        return Err(format!(
            "{} drives a model through tool calls, and '{model}' doesn't support them. \
             {suggestion}",
            driver.label
        ));
    }

    // The second thing a model can refuse. Unlike `tools` this is not a reason
    // to withhold the agent — the agent runs fine, it just must not *ask* for
    // reasoning — so it changes the launch line instead of raising an error.
    let thinking = model_supports_thinking(&model);
    let extra = non_thinking_override(driver, thinking);

    if let Some(sub) = driver.launch_sub {
        // `ollama launch` is preferred but forwards nothing to the agent, so it
        // cannot carry the reasoning-off override. When one is needed, the
        // direct invocation is the *only* working path, not a downgrade.
        if extra.is_empty() && ollama_has_launch() {
            return Ok(LocalLaunchSpec {
                cmd: "ollama".to_string(),
                args: vec![
                    "launch".to_string(),
                    sub.to_string(),
                    "--model".to_string(),
                    model,
                ],
            });
        }
    }

    let mut spec = fallback_spec(driver, &model, extra).ok_or_else(|| {
        format!(
            "{} can only drive a local model through `ollama launch`, which isn't \
             available. Update Ollama (v0.15+) to enable it.",
            driver.label
        )
    })?;

    // The other half of what `ollama launch` did for us. Best-effort by
    // construction: a catalog we could not write costs a warning and worse
    // context accounting, so it must never turn into a refusal to open the tab.
    if driver.wants_local_catalog {
        spec.args.extend(local_catalog_args(&model, thinking));
    }
    Ok(spec)
}

/// The catalog `-c` args for a direct Codex launch, or nothing if we couldn't
/// write one. See [`write_local_catalog`].
fn local_catalog_args(model: &str, thinking: Option<bool>) -> Vec<String> {
    match write_local_catalog(model, thinking) {
        Ok(path) => catalog_arg_pair(&path),
        Err(_) => Vec::new(),
    }
}

/// `-c model_catalog_json=<toml string>` for `path`. A JSON string literal is
/// a valid TOML basic string, and serde does the escaping — the path is
/// Tabtivity's own but it descends from `$HOME`, which we do not get to assume is
/// free of quotes or backslashes.
fn catalog_arg_pair(path: &std::path::Path) -> Vec<String> {
    vec![
        "-c".to_string(),
        format!(
            "model_catalog_json={}",
            serde_json::Value::from(path.to_string_lossy().as_ref())
        ),
    ]
}

/// Where [`write_local_catalog`] keeps `model`'s catalog.
fn local_catalog_path(model: &str) -> std::path::PathBuf {
    crate::storage::home_share_dir()
        .join("codex_local")
        .join(sanitize_alias(model))
        .join("model.json")
}

/// Write the model-metadata catalog Codex asks for, into **Tabtivity's own** state
/// dir — never `~/.codex`, which is another application's to manage.
///
/// Without it Codex prints `Model metadata for '<model>' not found. Defaulting
/// to fallback metadata` and then reasons about the context window from a
/// built-in guess: it does not know that `qwen3-coder` holds 262 144 tokens, so
/// it compacts against the wrong number — either throwing away context that
/// still fit, or overrunning the model's window and getting a truncation Ollama
/// never reports back as one. `ollama launch` generates exactly this file
/// (`~/.codex/model.json`); the direct invocation that a non-thinking model
/// forces us onto is what left the agent without it.
///
/// The field set is Ollama's own for that generated file — the shape its
/// authors established Codex accepts — with the two model-dependent facts read
/// off `/api/show` rather than assumed: the context window, and whether any
/// reasoning level may be offered at all.
fn write_local_catalog(model: &str, thinking: Option<bool>) -> Result<std::path::PathBuf, String> {
    validate_model_name(model)?;
    let path = local_catalog_path(model);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("catalog dir: {e}"))?;
    }

    let body = local_catalog_json(
        model,
        thinking,
        model_context_length(model),
        model_has_capability(model, "vision") == Some(true),
    );
    std::fs::write(&path, body).map_err(|e| format!("catalog write: {e}"))?;
    Ok(path)
}

/// The catalog document itself — pure, so the shape Codex is handed is a unit
/// test rather than a thing only observable by launching an agent.
fn local_catalog_json(
    model: &str,
    thinking: Option<bool>,
    context_window: Option<u64>,
    vision: bool,
) -> String {
    // A model positively known to lack `thinking` gets an empty level list, so
    // Codex has the fact rather than only the `-c model_reasoning_effort` order
    // to obey. "Could not tell" leaves the standard levels, matching the rest
    // of the capability rules: absence of an answer never removes a capability.
    let levels: Vec<serde_json::Value> = if thinking == Some(false) {
        Vec::new()
    } else {
        ["low", "medium", "high"]
            .iter()
            .map(|e| serde_json::json!({ "effort": e }))
            .collect()
    };
    let mut modalities = vec!["text"];
    if vision {
        modalities.push("image");
    }

    let mut entry = serde_json::json!({
        "slug": model,
        "display_name": model,
        "base_instructions": "",
        "default_verbosity": "low",
        "support_verbosity": true,
        "experimental_supported_tools": [],
        "input_modalities": modalities,
        "priority": 0,
        "shell_type": "default",
        "supported_in_api": true,
        "supported_reasoning_levels": levels,
        "supports_parallel_tool_calls": false,
        "supports_reasoning_summaries": false,
        "truncation_policy": { "mode": "bytes", "limit": 10000 },
        "visibility": "list",
    });
    // Omitted rather than guessed when Ollama won't say: a wrong context window
    // is worse than the fallback, because it is wrong with confidence.
    if let Some(ctx) = context_window {
        entry["context_window"] = serde_json::json!(ctx);
    }
    serde_json::json!({ "models": [entry] }).to_string()
}

/// The model's trained context window, per Ollama's own `/api/show`. The key is
/// architecture-prefixed (`qwen3moe.context_length`, `llama.context_length`, …),
/// so it is found by suffix rather than by a table of architectures that would
/// need an entry per new model family.
fn model_context_length(model: &str) -> Option<u64> {
    let body = serde_json::json!({ "model": model }).to_string();
    let v: serde_json::Value =
        serde_json::from_str(&ollama_http("POST", "/api/show", Some(&body)).ok()?).ok()?;
    v["model_info"]
        .as_object()?
        .iter()
        .find(|(k, _)| k.ends_with(".context_length"))
        .and_then(|(_, v)| v.as_u64())
        .filter(|n| *n > 0)
}

fn sanitize_alias(model: &str) -> String {
    model.replace(':', "-")
}

/// Reject model names that could break out of — or inject keys into — the TOML we
/// write into vibe's `config.toml`. `model` is interpolated raw inside a basic
/// TOML string (`name = "{model}"`); a `"` would close that string and a newline
/// would let an attacker append arbitrary TOML keys/tables. Control chars are
/// also illegal in TOML basic strings. We allow only the characters that appear
/// in real Ollama model refs (`<namespace>/<name>:<tag>`): ASCII alphanumerics
/// and `. _ - : /` plus `@` (digest refs). Empty names are rejected too.
fn validate_model_name(model: &str) -> Result<(), String> {
    let model = model.trim();
    if model.is_empty() {
        return Err("model name must not be empty".to_string());
    }
    if let Some(bad) = model
        .chars()
        .find(|c| !(c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ':' | '/' | '@')))
    {
        return Err(format!("invalid character {bad:?} in model name '{model}'"));
    }
    Ok(())
}

/// Return the per-model VIBE_HOME path: `~/.local/share/tabtivity/vibe_local/{alias}/`.
/// Each Ollama tab gets its own subdirectory so the configs are independent
/// and `active_model` is always unambiguous.
fn app_vibe_local_dir_for(alias: &str) -> Result<std::path::PathBuf, String> {
    Ok(crate::storage::home_share_dir()
        .join("vibe_local")
        .join(alias))
}

fn dirs_vibe_config() -> Result<std::path::PathBuf, String> {
    let vibe_home = std::env::var_os("VIBE_HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| crate::paths::home_dir().join(".vibe"));
    Ok(vibe_home.join("config.toml"))
}

/// The `vibe` provider stanza. `api_base` follows `ollama_host`, because a
/// config file naming 11434 while Tabtivity's own reads go to 11500 is the same
/// class of bug as the setting doing nothing — it just fails one layer further
/// out, inside the agent, where the message is somebody else's.
fn ollama_provider_block() -> String {
    let base = ollama_addr().unwrap_or_else(|_| DEFAULT_OLLAMA_ADDR.to_string());
    format!(
        "\n[[providers]]\nname = \"ollama\"\napi_base = \"http://{base}/v1\"\napi_key_env_var = \"\"\napi_style = \"openai\"\nbackend = \"generic\"\nreasoning_field_name = \"reasoning_content\"\nproject_id = \"\"\nregion = \"\"\n\n[providers.extra_headers]\n"
    )
}

fn ollama_model_block(model: &str, alias: &str) -> String {
    format!(
        "\n[[models]]\nname = \"{model}\"\nprovider = \"ollama\"\nalias = \"{alias}\"\ntemperature = 0.2\ninput_price = 0.0\noutput_price = 0.0\nthinking = \"off\"\nauto_compact_threshold = 200000\n"
    )
}

#[cfg(all(test, unix))]
mod owned_server_tests {
    use super::*;

    /// The whole shutdown contract in one pass, deliberately as a single test:
    /// `OWNED_SERVER` is process-global, so two tests taking turns with it would
    /// race and each would occasionally reap the other's child.
    #[test]
    fn shutdown_reaps_only_a_server_this_run_started() {
        // The reap walks (and invalidates) the shared process-tree cache the
        // sysstat tests seed synthetic entries into — share their lock.
        let _cache_guard = crate::sysstat::lock_cache_for_test();

        // SAFETY: `kill(pid, 0)` probes existence without signalling.
        let alive = |pid: u32| unsafe { libc::kill(pid as libc::pid_t, 0) == 0 };

        // Nothing started → nothing stopped, and no panic on the empty slot.
        assert!(OWNED_SERVER.lock().unwrap().is_none());
        shutdown_owned_server();

        // Stand in for `ollama serve` + its runner child: the trailing `; true`
        // defeats the shell's exec optimization, so `sleep` is a real child of
        // the pid we recorded rather than the pid itself.
        let mut cmd = std::process::Command::new("sh");
        cmd.args(["-c", "sleep 300; true"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        let leader = crate::paths::spawn_reaped(cmd).expect("spawn stand-in server");
        record_owned_server(OwnedServer::Process(leader));

        let mut child = None;
        for _ in 0..100 {
            crate::sysstat::invalidate_descendant_cache();
            if let Some(&pid) = crate::sysstat::descendant_pids(&[leader])
                .iter()
                .find(|&&p| p != leader)
            {
                child = Some(pid);
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let child = child.expect("the stand-in server should have spawned a child");

        shutdown_owned_server();

        // The subtree is gone — the leader *and* the child holding the weights.
        for pid in [leader, child] {
            let mut gone = false;
            for _ in 0..250 {
                if !alive(pid) {
                    gone = true;
                    break;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            assert!(gone, "pid {pid} must not outlive the app");
        }

        // Ownership is consumed, so a second teardown pass cannot signal a pid
        // the OS has since handed to somebody else.
        assert!(OWNED_SERVER.lock().unwrap().is_none());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prose_sentence_stops_preserve_language_punctuation_and_decimals() {
        assert_eq!(completion_stop(" kostet 3.14 Euro. Weiter", true, false), Some(" kostet 3.14 Euro.".len()));
        assert_eq!(completion_stop(" kostet 3.", true, false), None);
        assert_eq!(completion_stop(" fertig!", true, true), Some(" fertig!".len()));
        assert_eq!(completion_stop("一文。次", true, false), Some("一文。".len()));
        assert_eq!(completion_stop("call().next()\nother()", false, false), Some("call().next()".len()));
        for language in ["markdown", "tex", "text", ""] {
            let prompt = completion_prompt("% Ein deutscher Absatz", "", language, CompletionMode::Sentence, "English reference");
            assert!(prompt.contains("Do not translate or switch to English"));
            assert!(!prompt.contains("code that implements"));
        }
    }

    #[test]
    fn completion_fim_uses_native_suffix_and_preserves_whitespace() {
        let body = completion_body(
            "fn f() {",
            "\n}",
            "coder",
            "rust",
            CompletionMode::Sentence,
            "",
            true,
        );
        assert_eq!(body["prompt"], "fn f() {");
        assert_eq!(body["suffix"], "\n}");
        assert!(body.get("messages").is_none());
        assert_eq!(body["options"]["stop"], serde_json::json!(["\n"]));
        assert_eq!(body["stream"], true);
        assert_eq!(body["think"], false);
        assert_eq!(
            completion_preview("\n    return 1;\n", true, true, "", ""),
            "\n    return 1;\n"
        );
    }

    #[test]
    fn completion_chat_keeps_reference_context_and_language_instruction() {
        let body = completion_body(
            "Ein Satz",
            ".",
            "chat",
            "markdown",
            CompletionMode::Block,
            "notes",
            false,
        );
        assert!(body.get("suffix").is_none());
        assert!(body["messages"][1]["content"]
            .as_str()
            .unwrap()
            .contains("notes"));
        assert!(body["messages"][0]["content"]
            .as_str()
            .unwrap()
            .contains("never translate"));
        assert_eq!(
            body["options"]["num_predict"],
            CompletionMode::Block.num_predict()
        );
    }

    #[test]
    fn completion_stream_withholds_partial_wrappers() {
        assert_eq!(completion_preview("```py", false, false, "", ""), "");
        assert_eq!(completion_preview("Here is the", false, false, "", ""), "");
        assert_eq!(
            completion_preview(
                "Here is the continuation:\n```py\nreturn",
                false,
                false,
                "",
                ""
            ),
            "return"
        );
        assert_eq!(
            completion_preview("return a + b", false, true, "return ", ""),
            "a + b"
        );
        assert_eq!(completion_preview("x\nnext", false, true, "", "next"), "x");
    }

    #[test]
    fn completion_backend_window_is_utf8_safe() {
        let text = "界".repeat(10_000);
        let tail = bounded_completion_prefix(&text);
        assert!(tail.len() <= 16_384);
        assert!(text.ends_with(&tail));
    }

    #[test]
    fn partial_file_match_takes_the_layer_and_its_chunks_only() {
        let main = "sha256-ab12-partial";
        assert!(is_partial_file_of("sha256-ab12-partial", main));
        assert!(is_partial_file_of("sha256-ab12-partial-0", main));
        assert!(is_partial_file_of("sha256-ab12-partial-15", main));
        assert!(!is_partial_file_of("sha256-ab12-partial-", main));
        assert!(!is_partial_file_of("sha256-ab12-partial-x", main));
        assert!(!is_partial_file_of("sha256-ab12", main));
        assert!(!is_partial_file_of("sha256-ab123-partial", main));
    }

    #[test]
    fn remove_blob_files_ignores_already_gone_files() {
        let dir = tempfile::tempdir().unwrap();
        let kept = dir.path().join("sha256-ab12-partial");
        std::fs::write(&kept, b"x").unwrap();
        let gone = dir.path().join("sha256-ab12-partial-0");
        assert!(remove_blob_files(&[kept.clone(), gone]).is_ok());
        assert!(!kept.exists());
    }
    use std::io::Write;

    // ── Helper: simulate prepare_local_agent using a tmp base dir ─────────────

    fn write_agent_config(base: &std::path::Path, model: &str) -> (std::path::PathBuf, String) {
        let alias = sanitize_alias(model);
        let vibe_home = base.join(&alias);
        std::fs::create_dir_all(&vibe_home).unwrap();
        let config_path = vibe_home.join("config.toml");
        let mut cfg = format!("active_model = \"{alias}\"\nenabled_tools = [\"__no_tools__\"]\n");
        cfg.push_str(&ollama_provider_block());
        cfg.push_str(&ollama_model_block(model, &alias));
        std::fs::write(&config_path, &cfg).unwrap();
        (vibe_home, alias)
    }

    // ── model-name validation (TOML injection defense) ───────────────────────

    #[test]
    fn validate_model_name_accepts_real_refs() {
        for ok in [
            "llama3.2:1b",
            "qwen2.5-coder:7b",
            "library/llama3:latest",
            "registry.example.com/ns/model:tag",
            "model@sha256",
            "phi-4",
        ] {
            assert!(validate_model_name(ok).is_ok(), "{ok} should be accepted");
        }
    }

    #[test]
    fn validate_model_name_rejects_toml_injection() {
        // A `"` closes the TOML basic string; a newline lets the attacker append
        // arbitrary keys/tables. Both — and other shell/TOML metacharacters and
        // control chars — must be rejected.
        for bad in [
            "model\"\nmalicious_key = \"x",
            "model\nenabled_tools = []",
            "a\"b",
            "back`tick",
            "with space",
            "tab\tinside",
            "",
            "   ",
        ] {
            assert!(
                validate_model_name(bad).is_err(),
                "{bad:?} should be rejected"
            );
        }
    }

    // ── local-driver registry (ollama launch + fallbacks) ────────────────────

    // ── the tool-capability gate ─────────────────────────────────────────────

    #[test]
    fn a_completion_only_model_withholds_every_tool_calling_agent() {
        // The bug this exists for: picking a completion-only model (`llama3`) in
        // the 🧠 menu left Codex in the + menu, and the tab it opened died on its
        // first request with `does not support tools`.
        for d in LOCAL_DRIVERS {
            let (available, blocked) = driver_verdict(d.needs_tools, true, true);
            assert!(!available, "{} should be withheld", d.id);
            assert!(blocked, "{} should say the model is why", d.id);
        }
    }

    #[test]
    fn an_unreadable_capability_list_never_hides_an_agent() {
        // `model_supports_tools` answers `None` when Ollama is down or too old
        // to report capabilities, which reaches the verdict as `false`. A probe
        // failure must not empty the menu — an agent that errors is recoverable,
        // an agent that silently vanished is not diagnosable.
        for d in LOCAL_DRIVERS {
            let (available, blocked) = driver_verdict(d.needs_tools, true, false);
            assert!(available, "{} should still be offered", d.id);
            assert!(!blocked);
        }
    }

    #[test]
    fn a_missing_binary_is_not_reported_as_a_model_problem() {
        // Two different failures with two different fixes: the menu says
        // "install the agent" for one and "pick another model" for the other,
        // and an uninstalled agent must never claim the latter.
        let (available, blocked) = driver_verdict(true, false, true);
        assert!(!available);
        assert!(!blocked);
    }

    #[test]
    fn every_local_driver_needs_tools() {
        // vibe is the deliberate exception and is deliberately not in this
        // list — it turns tools off (`enabled_tools = ["__no_tools__"]`), which
        // is exactly why it still runs on a completion-only model. If an entry
        // here ever stops needing tools, this assertion is where to say so.
        assert!(LOCAL_DRIVERS.iter().all(|d| d.needs_tools));
    }

    // ── update checks ────────────────────────────────────────────────────────

    #[test]
    fn the_manifest_url_defaults_the_namespace_and_the_tag() {
        assert_eq!(
            registry_manifest_url("deepcoder").unwrap(),
            "https://registry.ollama.ai/v2/library/deepcoder/manifests/latest"
        );
        assert_eq!(
            registry_manifest_url("qwen3-coder:30b").unwrap(),
            "https://registry.ollama.ai/v2/library/qwen3-coder/manifests/30b"
        );
        // An explicit namespace is kept rather than nested under `library/`.
        assert_eq!(
            registry_manifest_url("hf.co/someone/model:q4").unwrap(),
            "https://registry.ollama.ai/v2/hf.co/someone/model/manifests/q4"
        );
    }

    #[test]
    fn the_digest_header_is_read_case_insensitively_and_last_wins() {
        // HTTP/2 lowercases header names and HTTP/1.1 does not, and a redirect
        // leaves several head blocks in curl's output — the manifest came with
        // the last one.
        let head = "HTTP/1.1 301 Moved\r\n\
                    Ollama-Content-Digest: sha256:old\r\n\
                    \r\n\
                    HTTP/2 200\r\n\
                    ollama-content-digest: sha256:new\r\n\
                    ollama-push-time: 1744152652\r\n\r\n";
        assert_eq!(
            header_value(head, "ollama-content-digest").as_deref(),
            Some("sha256:new")
        );
        assert_eq!(
            header_value(head, "OLLAMA-PUSH-TIME").as_deref(),
            Some("1744152652")
        );
        assert_eq!(header_value(head, "etag"), None);
    }

    // ── the Ollama server's own version ──────────────────────────────────────

    #[test]
    fn the_installed_version_is_found_whatever_else_the_command_printed() {
        assert_eq!(
            parse_version("ollama version is 0.14.3\n").as_deref(),
            Some("0.14.3")
        );
        // The real output when the server isn't running: a warning line first,
        // which is why this scans rather than taking a fixed field.
        assert_eq!(
            parse_version(
                "Warning: could not connect to a running Ollama instance\n\
                 ollama version is 0.32.5\n"
            )
            .as_deref(),
            Some("0.32.5")
        );
        // A release tag, straight out of the API's JSON.
        assert_eq!(
            parse_version("\"tag_name\": \"v0.32.5\",").as_deref(),
            Some("0.32.5")
        );
        assert_eq!(parse_version("no version here").as_deref(), None);
    }

    #[test]
    fn versions_compare_numerically_not_lexically() {
        // The bug a string compare would have: "0.9.0" > "0.14.3" as text, so
        // most of Ollama's history would have reported a downgrade as an update.
        assert_eq!(version_is_newer("0.14.3", "0.9.0"), Some(true));
        assert_eq!(version_is_newer("0.9.0", "0.14.3"), Some(false));
        assert_eq!(version_is_newer("0.32.5", "0.14.3"), Some(true));
        assert_eq!(version_is_newer("0.14.3", "0.14.3"), Some(false));
        // A missing component is zero — 0.15 and 0.15.0 are one version.
        assert_eq!(version_is_newer("0.15", "0.15.0"), Some(false));
        assert_eq!(version_is_newer("0.15.1", "0.15"), Some(true));
        // The leading `v` of a tag, and a pre-release suffix, are both handled.
        assert_eq!(version_is_newer("v0.16.0", "0.15.9"), Some(true));
        assert_eq!(version_is_newer("0.16.0-rc1", "0.15.9"), Some(true));
        // Unparseable on either side is "couldn't tell", never an update.
        assert_eq!(version_is_newer("dev", "0.14.3"), None);
        assert_eq!(version_is_newer("0.14.3", ""), None);
    }

    #[test]
    fn an_unreachable_registry_is_not_an_up_to_date_verdict() {
        // The whole point of carrying `error` per model: "couldn't check" and
        // "current" must never render the same, and neither may raise a badge.
        let out = wanted_updates(vec![("no-such-model-xyz".into(), "sha256:local".into())]);
        assert_eq!(out.len(), 1);
        assert!(!out[0].update_available);
        assert!(out[0].error.is_some(), "a failure must say so");
    }

    #[test]
    fn codex_fallback_substitutes_model_for_oss_mode() {
        let d = LOCAL_DRIVERS.iter().find(|d| d.id == "codex").unwrap();
        let spec = fallback_spec(d, "qwen2.5-coder:7b", &[]).expect("codex has a fallback");
        assert_eq!(spec.cmd, "codex");
        // `oss_provider` rides every codex fallback, not just the non-thinking
        // one: codex ≥0.146 refuses a bare `--oss` with "No default OSS
        // provider configured", i.e. the tab dies before it reaches Ollama.
        assert_eq!(
            spec.args,
            vec![
                "--oss",
                "-c",
                "oss_provider=\"ollama\"",
                "-m",
                "qwen2.5-coder:7b"
            ]
        );
    }

    #[test]
    fn opencode_fallback_prefixes_the_ollama_provider() {
        let d = LOCAL_DRIVERS.iter().find(|d| d.id == "opencode").unwrap();
        let spec = fallback_spec(d, "llama3.2", &[]).expect("opencode has a fallback");
        assert_eq!(spec.cmd, "opencode");
        assert_eq!(spec.args, vec!["--model", "ollama/llama3.2"]);
        // Direct only: `ollama launch` would override the injected model list.
        assert!(d.launch_sub.is_none());
    }

    fn argv(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn opencode_spawn_model_recognises_every_opencode_launch_shape() {
        assert_eq!(opencode_spawn_model("opencode", &[]), Some(None));
        assert_eq!(
            opencode_spawn_model("/home/u/.opencode/bin/opencode", &argv(&["--model", "ollama/qwen3:8b"])),
            Some(Some("qwen3:8b".into()))
        );
        assert_eq!(
            opencode_spawn_model("opencode", &argv(&["--model=ollama/qwen3:8b"])),
            Some(Some("qwen3:8b".into()))
        );
        // Another provider's model is not an Ollama request.
        assert_eq!(
            opencode_spawn_model("opencode", &argv(&["-m", "anthropic/claude"])),
            Some(None)
        );
        assert_eq!(
            opencode_spawn_model("ollama", &argv(&["launch", "opencode", "--model", "qwen3:8b"])),
            Some(Some("qwen3:8b".into()))
        );
        assert_eq!(opencode_spawn_model("ollama", &argv(&["launch", "codex"])), None);
        assert_eq!(opencode_spawn_model("codex", &[]), None);
    }

    #[test]
    fn loaded_model_names_reads_api_ps() {
        let body = r#"{"models":[{"name":"nemotron:30b","model":"nemotron:30b"},{"model":"qwen3:8b"}]}"#;
        assert_eq!(
            loaded_model_names(body),
            Some(vec!["nemotron:30b".to_string(), "qwen3:8b".to_string()])
        );
        assert_eq!(loaded_model_names(r#"{"models":[]}"#), Some(vec![]));
        assert_eq!(loaded_model_names("garbage"), None);
    }

    #[test]
    fn opencode_config_whitelists_the_loaded_models_plus_the_requested_one() {
        let cfg: serde_json::Value = serde_json::from_str(&opencode_ollama_config(
            "127.0.0.1:11434",
            &["nemotron:30b".to_string()],
            Some("qwen3:8b"),
        ))
        .unwrap();
        let p = &cfg["provider"]["ollama"];
        assert_eq!(p["options"]["baseURL"], "http://127.0.0.1:11434/v1");
        assert_eq!(p["whitelist"], serde_json::json!(["nemotron:30b", "qwen3:8b"]));
        assert_eq!(p["models"]["nemotron:30b"]["name"], "nemotron:30b");
        assert!(p["models"]["qwen3:8b"].is_object());

        // Nothing loaded: an empty whitelist, so stale config models drop out.
        let cfg: serde_json::Value =
            serde_json::from_str(&opencode_ollama_config("h:1", &[], None)).unwrap();
        assert_eq!(cfg["provider"]["ollama"]["whitelist"], serde_json::json!([]));
    }

    #[test]
    fn launch_only_drivers_have_no_fallback() {
        // Claude Code / Droid need `ollama launch`; there is no hand-rolled spec.
        for id in ["claude", "droid"] {
            let d = LOCAL_DRIVERS.iter().find(|d| d.id == id).unwrap();
            assert!(
                fallback_spec(d, "any:model", &[]).is_none(),
                "{id} must be launch-only"
            );
            assert!(d.launch_sub.is_some(), "{id} must support ollama launch");
        }
    }

    // ── the thinking gate ────────────────────────────────────────────────────

    #[test]
    fn codex_turns_reasoning_off_only_for_a_non_thinking_model() {
        // The bug this exists for: `qwen3-coder` reports `tools` but not
        // `thinking`, so it passed the tool gate and then died on its first
        // turn with `"qwen3-coder:latest" does not support thinking` — Codex
        // sends `model_reasoning_effort` (default `medium`, and usually set
        // outright in the user's ~/.codex/config.toml) and Ollama rejects the
        // whole request rather than ignoring the field.
        let d = LOCAL_DRIVERS.iter().find(|d| d.id == "codex").unwrap();

        let off = non_thinking_override(d, Some(false));
        assert_eq!(off, ["-c", "model_reasoning_effort=\"none\""]);
        let spec = fallback_spec(d, "qwen3-coder:latest", off).expect("codex has a fallback");
        assert_eq!(
            spec.args.last().map(String::as_str),
            Some("model_reasoning_effort=\"none\"")
        );

        // A thinking model keeps its reasoning: forcing it off would silently
        // downgrade every reasoning-capable local model to a worse agent.
        assert!(non_thinking_override(d, Some(true)).is_empty());
        // And "could not tell" changes nothing — same rule as the tool gate.
        assert!(non_thinking_override(d, None).is_empty());
    }

    #[test]
    fn an_agent_that_sends_no_reasoning_is_left_alone() {
        for id in ["claude", "opencode", "droid", "openclaw"] {
            let d = LOCAL_DRIVERS.iter().find(|d| d.id == id).unwrap();
            assert!(
                non_thinking_override(d, Some(false)).is_empty(),
                "{id} must not be rewritten for a non-thinking model"
            );
        }
    }

    #[test]
    fn the_local_catalog_carries_the_two_facts_only_ollama_knows() {
        let doc: serde_json::Value = serde_json::from_str(&local_catalog_json(
            "qwen3-coder:latest",
            Some(false),
            Some(262_144),
            false,
        ))
        .expect("catalog is valid JSON");
        let m = &doc["models"][0];
        assert_eq!(m["slug"], "qwen3-coder:latest");
        // The whole point of writing one: Codex's fallback metadata does not
        // know this number, so it compacts against a guess.
        assert_eq!(m["context_window"], 262_144);
        assert_eq!(m["supported_reasoning_levels"].as_array().unwrap().len(), 0);
        assert_eq!(m["input_modalities"].as_array().unwrap().len(), 1);

        // A thinking model keeps its levels, and a vision model its modality.
        let doc: serde_json::Value =
            serde_json::from_str(&local_catalog_json("m:latest", Some(true), None, true)).unwrap();
        let m = &doc["models"][0];
        assert!(!m["supported_reasoning_levels"]
            .as_array()
            .unwrap()
            .is_empty());
        assert!(m["input_modalities"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v == "image"));
        // An unknown window is absent, never a plausible-looking default.
        assert!(m.get("context_window").is_none());

        // "Could not tell" must not strip a capability, same as the tool gate.
        let doc: serde_json::Value =
            serde_json::from_str(&local_catalog_json("m:latest", None, None, false)).unwrap();
        assert!(!doc["models"][0]["supported_reasoning_levels"]
            .as_array()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn a_persisted_local_launch_line_must_be_one_app_builds() {
        let v = |args: &[&str]| args.iter().map(|a| a.to_string()).collect::<Vec<_>>();
        let m = "qwen3-coder:30b";
        // `ollama launch`, for a driver that has it.
        assert!(local_launch_line_ok("claude", m, "ollama", &v(&["launch", "claude", "--model", m])));
        assert!(local_launch_line_ok("droid", m, "ollama", &v(&["launch", "droid", "--model", m])));
        // Direct fallbacks, with and without the reasoning-off override.
        assert!(local_launch_line_ok("opencode", m, "opencode", &v(&["--model", &format!("ollama/{m}")])));
        let codex = fallback_spec(
            LOCAL_DRIVERS.iter().find(|d| d.id == "codex").unwrap(),
            m,
            &["-c", "model_reasoning_effort=\"none\""],
        )
        .unwrap();
        assert!(local_launch_line_ok("codex", m, "codex", &codex.args));
        // Codex's catalog pair rides after either form, and only the path
        // Tabtivity writes it to.
        let mut with_catalog = codex.args.clone();
        with_catalog.extend(catalog_arg_pair(&local_catalog_path(m)));
        assert!(local_launch_line_ok("codex", m, "codex", &with_catalog));
        let mut elsewhere = codex.args.clone();
        elsewhere.extend(catalog_arg_pair(std::path::Path::new("/tmp/x.json")));
        assert!(!local_launch_line_ok("codex", m, "codex", &elsewhere));

        // Anything else is refused: another sub, another model, an extra
        // flag, a driver without a fallback run directly, an unknown driver,
        // a model that reads as a flag, and a line of another driver.
        assert!(!local_launch_line_ok("claude", m, "ollama", &v(&["launch", "codex", "--model", m])));
        assert!(!local_launch_line_ok("claude", m, "ollama", &v(&["launch", "claude", "--model", "other"])));
        assert!(!local_launch_line_ok("claude", m, "ollama", &v(&["launch", "claude", "--model", m, "--yes"])));
        assert!(!local_launch_line_ok("claude", m, "claude", &v(&["--model", m])));
        assert!(!local_launch_line_ok("vibe", m, "vibe", &[]));
        let flag = "--dangerously-skip-permissions";
        assert!(!local_launch_line_ok("claude", flag, "ollama", &v(&["launch", "claude", "--model", flag])));
        assert!(!local_launch_line_ok("opencode", m, "ollama", &v(&["launch", "claude", "--model", m])));
        assert_eq!(local_driver_bin("opencode"), Some("opencode"));
        assert_eq!(local_driver_bin("nope"), None);
    }

    #[test]
    fn only_a_driver_with_a_fallback_asks_for_a_catalog() {
        // The catalog rides the direct invocation's argv; `ollama launch`
        // generates its own and forwards nothing, so a launch-only driver
        // asking for one would silently get nothing.
        for d in LOCAL_DRIVERS {
            if d.wants_local_catalog {
                assert!(d.fallback.is_some(), "{} needs a fallback", d.id);
            }
        }
    }

    #[test]
    fn a_reasoning_override_requires_a_fallback_to_ride() {
        // `ollama launch` forwards nothing — it rejects an extra flag with
        // `unknown shorthand flag` — so a driver that needs the override and
        // has no direct invocation would report the launch-only error message,
        // which names the wrong problem and an update that wouldn't fix it.
        for d in LOCAL_DRIVERS {
            if d.non_thinking_args.is_some() {
                assert!(
                    d.fallback.is_some(),
                    "{} needs a fallback to carry its reasoning override",
                    d.id
                );
            }
        }
    }

    #[test]
    fn model_block_with_validated_name_has_no_stray_quotes_or_newlines_in_value() {
        // Defense in depth: once validated, the interpolated name can never break
        // out of its `name = "<...>"` TOML string.
        let model = "qwen2.5-coder:7b";
        assert!(validate_model_name(model).is_ok());
        let block = ollama_model_block(model, &sanitize_alias(model));
        let name_line = block
            .lines()
            .find(|l| l.starts_with("name = "))
            .expect("name line");
        assert_eq!(name_line, "name = \"qwen2.5-coder:7b\"");
    }

    // ── active_model is always the first line of the per-model config ─────────

    #[test]
    fn prepare_local_agent_config_has_active_model_first() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let (vibe_home, alias) = write_agent_config(tmp.path(), "llama3:latest");

        let written = std::fs::read_to_string(vibe_home.join("config.toml")).unwrap();
        let first_line = written.lines().next().unwrap_or("");
        assert_eq!(first_line, format!("active_model = \"{alias}\""),
            "active_model must be the first config line so it is not shadowed by the global ~/.vibe/config.toml");
    }

    // ── each model gets its own directory so configs never collide ────────────

    #[test]
    fn prepare_local_agent_uses_per_alias_directory() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let (home_a, alias_a) = write_agent_config(tmp.path(), "llama3:latest");
        let (home_b, alias_b) = write_agent_config(tmp.path(), "qwen2:7b");

        // Directories are distinct.
        assert_ne!(home_a, home_b);
        assert!(home_a.ends_with(&alias_a));
        assert!(home_b.ends_with(&alias_b));

        // Each config's active_model matches its own alias — not the other's.
        let cfg_a = std::fs::read_to_string(home_a.join("config.toml")).unwrap();
        let cfg_b = std::fs::read_to_string(home_b.join("config.toml")).unwrap();
        assert!(cfg_a.contains(&format!("active_model = \"{alias_a}\"")));
        assert!(!cfg_a.contains(&format!("active_model = \"{alias_b}\"")));
        assert!(cfg_b.contains(&format!("active_model = \"{alias_b}\"")));
        assert!(!cfg_b.contains(&format!("active_model = \"{alias_a}\"")));
    }

    // ── config contains exactly the requested model, provider, and no-tools ──

    #[test]
    fn prepare_local_agent_config_structure() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let model = "mistral:latest";
        let (vibe_home, alias) = write_agent_config(tmp.path(), model);

        let cfg = std::fs::read_to_string(vibe_home.join("config.toml")).unwrap();
        assert!(
            cfg.contains("enabled_tools = [\"__no_tools__\"]"),
            "tool calls must be disabled for local models"
        );
        assert!(
            cfg.contains("name = \"ollama\""),
            "ollama provider block required"
        );
        assert!(
            cfg.contains(&format!("name = \"{model}\"")),
            "model name must appear"
        );
        assert!(
            cfg.contains(&format!("alias = \"{alias}\"")),
            "model alias must appear"
        );
    }

    // ── friendly error mapping: broken Ollama runner (#vibe 500) ─────────────

    #[test]
    fn friendly_ollama_error_detects_missing_runner() {
        // The exact shape Ollama returns when its llama-server binary is absent —
        // this is what surfaces through vibe as an "internal server error".
        let raw = "error starting llama-server: llama-server binary not found \
            (checked: /usr/local/lib/ollama/llama-server, ...). Run 'cmake -S \
            llama/server --preset cpu && cmake --build --preset cpu' first";
        let msg = friendly_ollama_error(raw);
        assert!(
            msg.contains("inference runner") && msg.contains("incomplete"),
            "missing-runner error should be rewritten to an actionable message, got: {msg}"
        );
        // It points the user at the reinstall command.
        assert!(msg.contains(ollama_install_cmd()));
        // And it no longer leaks the raw cmake/build hint.
        assert!(!msg.contains("cmake"));
    }

    #[test]
    fn friendly_ollama_error_is_case_insensitive() {
        let msg = friendly_ollama_error("LLAMA-SERVER binary NOT FOUND");
        assert!(msg.contains("inference runner"));
    }

    #[test]
    fn friendly_ollama_error_passes_through_unrelated() {
        // Errors we don't special-case must be returned verbatim, not swallowed.
        for raw in [
            "model 'foo' not found, try pulling it first",
            "out of memory",
            "HTTP 500",
        ] {
            assert_eq!(friendly_ollama_error(raw), raw);
        }
    }

    // ── registry search HTML parsing ─────────────────────────────────────────

    // Trimmed-down but structurally faithful fixture of two ollama.com/search
    // result cards, matching the post-2026-redesign markup (no `x-test-*`
    // hooks): the title links to `/library/<name>`, badges are colour-coded
    // `rounded-md bg-…` spans, and the pull count / updated label sit in the
    // meta row. nomic deliberately carries no size badge (embedding models omit
    // one on the live page), exercising the empty-sizes path.
    const SEARCH_FIXTURE: &str = r#"
      <ul role="list">
      <li  class="flex items-baseline border-b border-neutral-200 py-6">
        <a href="/library/glm-5.2" class="group w-full">
          <div class="flex flex-col mb-1" title="glm-5.2">
            <h2 class="truncate text-xl"><span >glm-5.2</span></h2>
            <p class="max-w-lg break-words text-neutral-800 text-md">GLM-5.2 is Z.ai&#39;s flagship model &amp; more.</p>
          </div>
          <div class="flex flex-col">
            <div class="flex flex-wrap space-x-2">
              <span  class="inline-flex my-1 items-center rounded-md bg-indigo-50 px-2 py-[2px] text-xs text-indigo-600">tools</span>
              <span  class="inline-flex my-1 items-center rounded-md bg-indigo-50 px-2 py-[2px] text-xs text-indigo-600">thinking</span>
              <span  class="inline-flex my-1 items-center rounded-md bg-[#ddf4ff] px-2 py-[2px] text-xs text-blue-600">8b</span>
              <span  class="inline-flex my-1 items-center rounded-md bg-[#ddf4ff] px-2 py-[2px] text-xs text-blue-600">355b</span>
            </div>
            <p class="my-1 flex space-x-5 text-[13px] text-neutral-500">
              <span class="flex items-center"><svg></svg><span >65.8K</span><span class="hidden sm:flex">&nbsp;Pulls</span></span>
              <span class="flex items-center"><svg></svg><span >93</span><span class="hidden sm:flex">&nbsp;Tags</span></span>
              <span class="flex items-center" title="Sep 30, 2026 10:34 PM UTC"><svg></svg><span class="hidden sm:flex">Updated&nbsp;</span><span >1 week ago</span></span>
            </p>
          </div>
        </a>
      </li>
      <li  class="flex items-baseline border-b border-neutral-200 py-6">
        <a href="/library/nomic-embed-text" class="group w-full">
          <div class="flex flex-col mb-1" title="nomic-embed-text">
            <h2 class="truncate text-xl"><span >nomic-embed-text</span></h2>
            <p class="max-w-lg break-words text-neutral-800 text-md">High-quality text embeddings.</p>
          </div>
          <div class="flex flex-col">
            <div class="flex flex-wrap space-x-2">
              <span  class="inline-flex my-1 items-center rounded-md bg-indigo-50 px-2 py-[2px] text-xs text-indigo-600">embedding</span>
            </div>
            <p class="my-1 flex space-x-5 text-[13px] text-neutral-500">
              <span class="flex items-center"><svg></svg><span >30M</span><span class="hidden sm:flex">&nbsp;Pulls</span></span>
              <span class="flex items-center" title="Feb 21, 2024 5:26 PM UTC"><svg></svg><span class="hidden sm:flex">Updated&nbsp;</span><span >1 year ago</span></span>
            </p>
          </div>
        </a>
      </li>
      </ul>"#;

    #[test]
    fn parse_search_html_extracts_all_fields() {
        let models = parse_search_html(SEARCH_FIXTURE);
        assert_eq!(models.len(), 2);

        let glm = &models[0];
        assert_eq!(glm.name, "glm-5.2");
        // HTML entities are unescaped.
        assert_eq!(glm.description, "GLM-5.2 is Z.ai's flagship model & more.");
        assert_eq!(glm.capabilities, vec!["tools", "thinking"]);
        assert_eq!(glm.sizes, vec!["8b", "355b"]);
        assert_eq!(glm.pulls, "65.8K");
        assert_eq!(glm.updated, "1 week ago");

        let nomic = &models[1];
        assert_eq!(nomic.name, "nomic-embed-text");
        assert_eq!(nomic.capabilities, vec!["embedding"]);
        assert!(nomic.sizes.is_empty());
        assert_eq!(nomic.pulls, "30M");
        assert_eq!(nomic.updated, "1 year ago");
    }

    #[test]
    fn parse_search_html_empty_when_no_cards() {
        assert!(parse_search_html("<html><body>no results</body></html>").is_empty());
    }

    #[test]
    fn percent_encode_query_escapes_unsafe_chars() {
        assert_eq!(percent_encode_query("llama 3.2"), "llama%203.2");
        assert_eq!(percent_encode_query("a&b=c"), "a%26b%3Dc");
        assert_eq!(percent_encode_query("qwen2.5-coder"), "qwen2.5-coder");
    }

    // ── completion prompt construction (#45) ──────────────────────────────────

    #[test]
    fn completion_prompt_includes_prefix_suffix_and_language() {
        let p = completion_prompt("let x =", " + 1;", "rust", CompletionMode::Sentence, "");
        assert!(p.contains("let x ="), "prefix must be embedded");
        assert!(p.contains(" + 1;"), "suffix must be embedded");
        assert!(p.contains("rust"), "language must be named");
        // Prefix appears before suffix so the model fills in the middle.
        assert!(p.find("let x =").unwrap() < p.find(" + 1;").unwrap());
    }

    #[test]
    fn completion_prompt_defaults_empty_language_to_text() {
        let p = completion_prompt("a", "b", "", CompletionMode::Sentence, "");
        assert!(
            p.contains("Language: text"),
            "empty language defaults to text"
        );
    }

    #[test]
    fn completion_prompt_labels_before_and_after_sections() {
        // The BEFORE/AFTER framing is what stops a chat model rewriting the doc.
        let p = completion_prompt("pre", "post", "rust", CompletionMode::Sentence, "");
        assert!(p.contains("BEFORE:\npre"));
        assert!(p.contains("AFTER:\npost"));
        assert!(p.find("BEFORE:").unwrap() < p.find("AFTER:").unwrap());
    }

    #[test]
    fn build_context_block_labels_files_and_skips_empty() {
        let files = vec![
            ContextFile {
                name: "util.rs".into(),
                content: "fn helper() {}".into(),
            },
            ContextFile {
                name: "blank.rs".into(),
                content: "   \n  ".into(),
            },
            ContextFile {
                name: "types.rs".into(),
                content: "struct Foo;".into(),
            },
        ];
        let block = build_context_block(&files);
        assert!(block.contains("--- util.rs ---\nfn helper() {}"));
        assert!(block.contains("--- types.rs ---\nstruct Foo;"));
        // Whitespace-only files contribute nothing.
        assert!(!block.contains("blank.rs"));
        // No files → empty string, so the prompt omits the section.
        assert_eq!(build_context_block(&[]), "");
    }

    #[test]
    fn build_context_block_caps_total_size() {
        let big = "x".repeat(20_000);
        let files = vec![
            ContextFile {
                name: "a".into(),
                content: big.clone(),
            },
            ContextFile {
                name: "b".into(),
                content: big.clone(),
            },
            ContextFile {
                name: "c".into(),
                content: big,
            },
        ];
        let block = build_context_block(&files);
        // Each file is per-file capped and the total is bounded; allow for the
        // labels/separators on top of the included bytes.
        assert!(
            block.len() <= MAX_CONTEXT_TOTAL + 256,
            "total context stays bounded"
        );
        // The first file always makes it in.
        assert!(block.contains("--- a ---"));
    }

    #[test]
    fn truncate_chars_respects_utf8_boundaries() {
        // Cutting mid-multibyte must back off to a valid boundary, never panic.
        let s = "a\u{00e9}b"; // 'é' is 2 bytes → byte index 2 splits it
        assert_eq!(truncate_chars(s, 2), "a");
        assert_eq!(truncate_chars(s, 100), s);
    }

    #[test]
    fn completion_prompt_embeds_reference_files_before_the_cursor_sections() {
        let ctx = build_context_block(&[ContextFile {
            name: "lib.rs".into(),
            content: "pub fn answer() -> i32 { 42 }".into(),
        }]);
        let p = completion_prompt("let x = ", "", "rust", CompletionMode::Sentence, &ctx);
        assert!(p.contains("REFERENCE FILES"));
        assert!(p.contains("pub fn answer"));
        // Reference context precedes the BEFORE/AFTER framing.
        assert!(p.find("REFERENCE FILES").unwrap() < p.find("BEFORE:").unwrap());
        // With no context the section is omitted entirely.
        let plain = completion_prompt("let x = ", "", "rust", CompletionMode::Sentence, "");
        assert!(!plain.contains("REFERENCE FILES"));
    }

    #[test]
    fn completion_mode_parse_and_caps_scale_by_mode() {
        assert_eq!(CompletionMode::parse("block"), CompletionMode::Block);
        assert_eq!(CompletionMode::parse("scope"), CompletionMode::Scope);
        // Unknown / absent → the conservative default.
        assert_eq!(CompletionMode::parse("sentence"), CompletionMode::Sentence);
        assert_eq!(CompletionMode::parse("bogus"), CompletionMode::Sentence);
        // Caps grow with scope so bigger modes have room to finish.
        assert!(
            CompletionMode::Sentence.num_predict() < CompletionMode::Block.num_predict()
                && CompletionMode::Block.num_predict() < CompletionMode::Scope.num_predict()
        );
    }

    #[test]
    fn completion_prompt_block_and_scope_drop_the_single_sentence_bias() {
        // Block/scope allow multi-line output; they must NOT carry the sentence
        // mode's "do not begin a new paragraph" restriction.
        let mid = "fn add(a: i32, b: i32) {\n    ";
        let block = completion_prompt(mid, "\n}", "rust", CompletionMode::Block, "");
        assert!(block.contains("block"));
        assert!(!block.contains("middle of a sentence"));

        let scope = completion_prompt(mid, "\n}", "rust", CompletionMode::Scope, "");
        assert!(scope.contains("function") && scope.contains("scope"));
        assert!(!scope.contains("middle of a sentence"));
    }

    #[test]
    fn trailing_comment_intent_detects_comment_above_a_fresh_line() {
        // Caret on a fresh indented line directly below a `//` comment.
        let p = "fn main() {\n    // new for loop to compute the sum\n    ";
        assert_eq!(
            trailing_comment_intent(p, "rust").as_deref(),
            Some("new for loop to compute the sum")
        );
        // Caret at the end of the comment line itself (no newline yet).
        let p2 = "# compute the average of the list";
        assert_eq!(
            trailing_comment_intent(p2, "python").as_deref(),
            Some("compute the average of the list")
        );
    }

    #[test]
    fn trailing_comment_intent_merges_consecutive_comment_lines() {
        let p = "    // compute the sum of all even numbers\n    /// and return the result\n    ";
        assert_eq!(
            trailing_comment_intent(p, "rust").as_deref(),
            Some("compute the sum of all even numbers and return the result")
        );
        // Single-line block comment is recognised in C-family languages.
        let blk = "/* build the lookup table */\n";
        assert_eq!(
            trailing_comment_intent(blk, "typescript").as_deref(),
            Some("build the lookup table")
        );
    }

    #[test]
    fn trailing_comment_intent_ignores_non_instructions_and_prose() {
        // Real code on the caret line → not an intent comment.
        assert_eq!(trailing_comment_intent("let x = 1;\n", "rust"), None);
        // Dividers / lone tokens don't read as instructions.
        assert_eq!(trailing_comment_intent("// ----\n", "rust"), None);
        assert_eq!(trailing_comment_intent("//\n", "rust"), None);
        // Comment is no longer adjacent to the caret (intervening code line).
        let gap = "// describe the loop\nlet y = 2;\n";
        assert_eq!(trailing_comment_intent(gap, "rust"), None);
        // Markdown headings must never be treated as code-intent comments.
        assert_eq!(trailing_comment_intent("# My Heading\n", "markdown"), None);
        // Shebang line is not a natural-language instruction.
        assert_eq!(trailing_comment_intent("#!/bin/bash\n", "bash"), None);
    }

    #[test]
    fn completion_prompt_switches_to_implement_mode_for_intent_comments() {
        let p = "fn main() {\n    // new for loop to compute the sum\n    ";
        let prompt = completion_prompt(p, "\n}", "rust", CompletionMode::Sentence, "");
        // Implements the comment as code rather than continuing prose.
        assert!(prompt.contains("implements that description"));
        assert!(prompt.contains("new for loop to compute the sum"));
        assert!(!prompt.contains("middle of a sentence"));
        // Without a trailing comment it keeps the ordinary sentence behaviour.
        let plain = completion_prompt("let x = ", "", "rust", CompletionMode::Sentence, "");
        assert!(!plain.contains("implements that description"));
    }

    #[test]
    fn is_mid_sentence_detects_unfinished_sentences() {
        // Mid-sentence: ends on a word, comma, or trailing space after a word.
        assert!(is_mid_sentence("The main advantages are"));
        assert!(is_mid_sentence("I am writing to "));
        assert!(is_mid_sentence("a, b,"));
        // Not mid-sentence: terminator, newline, or empty (start of document).
        assert!(!is_mid_sentence("Done."));
        assert!(!is_mid_sentence("Why?"));
        assert!(!is_mid_sentence("Header:"));
        assert!(!is_mid_sentence("paragraph end.\n"));
        assert!(!is_mid_sentence(""));
    }

    #[test]
    fn completion_prompt_biases_to_finishing_the_sentence_when_mid_sentence() {
        let mid = completion_prompt(
            "I am writing to ",
            " Best regards",
            "text",
            CompletionMode::Sentence,
            "",
        );
        assert!(mid.contains("middle of a sentence"));
        assert!(mid.contains("complete") || mid.contains("completes"));
        // At a sentence boundary it switches to the plain-continuation hint.
        let cont = completion_prompt("First line.\n", "", "text", CompletionMode::Sentence, "");
        assert!(!cont.contains("middle of a sentence"));
        assert!(cont.contains("Continue"));
    }

    #[test]
    fn clean_completion_strips_code_fences() {
        assert_eq!(clean_completion("foo()\n"), "foo()");
        assert_eq!(clean_completion("```rust\nfoo()\n```"), "foo()\n");
        // No fence → unchanged (bar a trailing newline trim).
        assert_eq!(clean_completion("plain"), "plain");
    }

    #[test]
    fn clean_completion_strips_conversational_preamble() {
        // The exact failure the user hit: a chat model prefacing the answer.
        assert_eq!(
            clean_completion("Here is the reformatted version of the text:\nreturn a + b"),
            "return a + b",
        );
        assert_eq!(clean_completion("Sure, here you go:\nx = 1"), "x = 1");
        // A real first line that merely ends in ':' is NOT a preamble — keep it.
        assert_eq!(
            clean_completion("def foo():\n    return 1"),
            "def foo():\n    return 1",
        );
        // A normal multi-line completion is untouched.
        assert_eq!(clean_completion("a + b\nc + d"), "a + b\nc + d");
    }

    #[test]
    fn trim_context_overlap_drops_echoed_prefix_tail() {
        // The exact case from llama3.2:3b: BEFORE ends with "return ", model echoes it.
        assert_eq!(
            trim_context_overlap("    return ", "\n\nprint(x)", "return a + b"),
            "a + b",
        );
        // Repeated trailing word.
        assert_eq!(
            trim_context_overlap("The quick brown fox", " over the dog", "fox jumps"),
            "jumps",
        );
    }

    #[test]
    fn trim_context_overlap_drops_echoed_suffix_head() {
        // Model pre-echoes the start of AFTER at the end of its insertion.
        assert_eq!(
            trim_context_overlap("a = ", " + 1", "compute() + 1"),
            "compute()",
        );
    }

    #[test]
    fn trim_context_overlap_keeps_unrelated_completion() {
        // No overlap → returned unchanged.
        assert_eq!(
            trim_context_overlap("I am writing to ", " Best regards", "express my thanks"),
            "express my thanks",
        );
        // A 1–2 char incidental match is below the threshold, so it is NOT trimmed.
        assert_eq!(
            trim_context_overlap("foo a", "", "a list of items"),
            "a list of items"
        );
    }

    #[test]
    fn overlap_len_finds_seam() {
        assert_eq!(overlap_len("    return", "return a"), 6);
        assert_eq!(overlap_len("brown fox", "fox jumps"), 3);
        assert_eq!(overlap_len("hello", "world"), 0);
    }

    // ── sanitize_alias turns ':' into '-' ─────────────────────────────────────

    #[test]
    fn sanitize_alias_replaces_colon() {
        assert_eq!(sanitize_alias("llama3:latest"), "llama3-latest");
        assert_eq!(sanitize_alias("qwen2:7b"), "qwen2-7b");
        assert_eq!(sanitize_alias("noname"), "noname");
    }

    // ── reload regression: writing the same model twice is idempotent ─────────

    #[test]
    fn prepare_local_agent_idempotent_on_same_model() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let model = "llama3:latest";
        let (vibe_home, alias) = write_agent_config(tmp.path(), model);
        // Write again — should produce identical content (no duplicated blocks).
        write_agent_config(tmp.path(), model);

        let cfg = std::fs::read_to_string(vibe_home.join("config.toml")).unwrap();
        let model_block_count = cfg.matches("[[models]]").count();
        assert_eq!(
            model_block_count, 1,
            "calling prepare_local_agent twice must not duplicate the model block"
        );
        // active_model appears exactly once.
        let active_model_count = cfg.matches(&format!("active_model = \"{alias}\"")).count();
        assert_eq!(active_model_count, 1);
    }

    #[test]
    fn model_directory_candidates_are_os_specific() {
        let home = std::path::Path::new("/home/alice");
        for os in [crate::paths::OsKind::Windows, crate::paths::OsKind::Macos] {
            let dirs = ollama_model_dir_candidates(os, home, None);
            assert_eq!(dirs, vec![home.join(".ollama/models")]);
        }
        let linux = ollama_model_dir_candidates(crate::paths::OsKind::Unix, home, None);
        assert!(linux.contains(&home.join(".ollama/models")));
        assert!(linux.contains(&std::path::PathBuf::from(
            "/usr/share/ollama/.ollama/models"
        )));
    }

    // ── models-download-location (Settings::ollama_models_path) ──────────────

    #[test]
    fn models_path_safety_gates_the_service_command_only() {
        assert!(models_path_is_safe("/data/ollama/models"));
        assert!(models_path_is_safe("/mnt/big disk/models")); // a space is fine
        assert!(!models_path_is_safe("")); // nothing to point at
        assert!(!models_path_is_safe("/data/\"quoted\"")); // breaks Environment="…"
        assert!(!models_path_is_safe("/data/50%")); // a systemd specifier
        assert!(!models_path_is_safe("/data/back\\slash"));
        assert!(!models_path_is_safe("/data/\nnewline"));
    }

    #[test]
    fn sh_single_quote_wraps_and_escapes() {
        assert_eq!(sh_single_quote("/plain/path"), "'/plain/path'");
        assert_eq!(sh_single_quote("/with space"), "'/with space'");
        // A lone apostrophe closes, escapes, reopens.
        assert_eq!(sh_single_quote("a'b"), "'a'\\''b'");
    }

    #[test]
    fn service_command_is_a_drop_in_only_under_systemd() {
        let path = "/data/ollama/models";
        // No service to reconfigure → nothing to run (a Tabtivity-spawned server
        // already honours the setting).
        assert_eq!(
            models_dir_service_command(path, false),
            (String::new(), String::new())
        );

        let (cmd, shell) = models_dir_service_command(path, true);
        assert_eq!(shell, "bash");
        assert!(cmd.contains(concat!("ollama.service.d/", crate::app_slug!(), "-models.conf")));
        assert!(cmd.contains("OLLAMA_MODELS=%s")); // path arrives as a printf arg
        assert!(cmd.contains(&sh_single_quote(path)));
        assert!(cmd.contains("systemctl restart ollama"));
        // The dir is created and handed to whoever the unit runs as.
        assert!(cmd.contains("systemctl show -p User"));
        assert!(cmd.contains("chown"));
    }

    #[test]
    fn service_command_withheld_for_an_unsafe_path_even_under_systemd() {
        assert_eq!(
            models_dir_service_command("/data/\"x\"", true),
            (String::new(), String::new())
        );
    }

    // ── #201a: `ollama_host` actually reaches the transport ──────────────────

    fn addr(raw: &str) -> Result<String, String> {
        resolve_ollama_addr(Some(raw), false)
    }

    #[test]
    fn unset_ollama_host_is_the_address_it_always_was() {
        // The whole compatibility promise: every install that predates this
        // change keeps dialling exactly what it dialled before.
        assert_eq!(
            resolve_ollama_addr(None, false).unwrap(),
            DEFAULT_OLLAMA_ADDR
        );
        assert_eq!(addr("").unwrap(), DEFAULT_OLLAMA_ADDR);
        assert_eq!(addr("   ").unwrap(), DEFAULT_OLLAMA_ADDR);
    }

    #[test]
    fn a_port_is_the_case_this_exists_for() {
        assert_eq!(addr("127.0.0.1:11500").unwrap(), "127.0.0.1:11500");
        assert_eq!(addr(":11500").unwrap(), "127.0.0.1:11500");
        // Ollama's own documented bare-port spelling.
        assert_eq!(addr("11500").unwrap(), "127.0.0.1:11500");
        assert_eq!(addr("localhost").unwrap(), "localhost:11434");
    }

    #[test]
    fn spellings_that_get_copied_in_are_understood() {
        assert_eq!(addr("http://127.0.0.1:11434").unwrap(), "127.0.0.1:11434");
        assert_eq!(addr("http://localhost:11500/").unwrap(), "localhost:11500");
        assert_eq!(
            addr("http://localhost:11500/v1").unwrap(),
            "localhost:11500"
        );
        // `0.0.0.0` is what you write to make the *server* listen everywhere; as
        // a connect address it means this machine.
        assert_eq!(addr("0.0.0.0:11500").unwrap(), "127.0.0.1:11500");
        assert_eq!(addr("::").unwrap(), "[::1]:11434");
        assert_eq!(addr("::1").unwrap(), "[::1]:11434");
        assert_eq!(addr("[::1]:11500").unwrap(), "[::1]:11500");
    }

    #[test]
    fn https_is_refused_rather_than_downgraded() {
        // The transport is plaintext HTTP/1.0 over a raw TcpStream. Connecting
        // in the clear to an address written as TLS is the one outcome that must
        // not be silent.
        let err = addr("https://127.0.0.1:11434").unwrap_err();
        assert!(err.contains("HTTPS"), "{err}");
        assert!(addr("ftp://127.0.0.1").is_err());
    }

    #[test]
    fn another_machine_needs_saying_so() {
        // RFC 5737 documentation addresses, not RFC 1918 ones: these are
        // guaranteed unroutable and reserved for exactly this, and the privacy
        // scan still flags a real `10.x`/`192.168.x` so a leaked internal
        // address cannot hide among test fixtures.
        for host in ["192.0.2.9:11434", "nas.example:11434", "203.0.113.5"] {
            assert!(
                resolve_ollama_addr(Some(host), false).is_err(),
                "{host} must not be reachable without the opt-in"
            );
            assert!(
                resolve_ollama_addr(Some(host), true).is_ok(),
                "{host} must be reachable with it"
            );
        }
        // Loopback never needs the opt-in, whatever it is spelled as.
        for host in [
            "127.0.0.1",
            "127.1.2.3",
            "localhost",
            "dev.localhost",
            "::1",
        ] {
            assert!(resolve_ollama_addr(Some(host), false).is_ok(), "{host}");
        }
    }

    #[test]
    fn a_host_that_could_inject_a_header_is_refused() {
        // The result is interpolated into a request line and a `Host:` header.
        assert!(addr("local\r\nX-Evil: 1").is_err());
        assert!(addr("local host").is_err());
        assert!(addr("127.0.0.1:not-a-port").is_err());
        assert!(addr("127.0.0.1:99999").is_err());
    }

    #[test]
    fn ensure_running_only_starts_a_server_it_could_own() {
        assert!(addr_is_loopback("127.0.0.1:11434"));
        assert!(addr_is_loopback("localhost:11500"));
        assert!(addr_is_loopback("[::1]:11434"));
        assert!(!addr_is_loopback("192.0.2.9:11434"));
    }

    #[test]
    fn the_vibe_provider_points_at_the_same_server() {
        // Not a strong assertion about the address (that depends on this
        // machine's settings.json) — only that the stanza is still well-formed
        // and names an `http://` base, which is what the agent parses.
        let block = ollama_provider_block();
        assert!(block.contains("api_base = \"http://"), "{block}");
        assert!(block.ends_with("/v1\"\napi_key_env_var = \"\"\napi_style = \"openai\"\nbackend = \"generic\"\nreasoning_field_name = \"reasoning_content\"\nproject_id = \"\"\nregion = \"\"\n\n[providers.extra_headers]\n"), "{block}");
    }

    /// Integration test: only runs when Ollama is reachable and has models.
    #[test]
    fn prepare_local_agent_integration_if_ollama_running() {
        if TcpStream::connect_timeout(
            &"127.0.0.1:11434".parse().unwrap(),
            Duration::from_millis(300),
        )
        .is_err()
        {
            eprintln!("Ollama not running — skipping integration test");
            return;
        }

        let model = match first_available_model() {
            Some(m) => m,
            None => {
                eprintln!("No Ollama models found — skipping integration test");
                return;
            }
        };

        let tmp = tempfile::tempdir().expect("tempdir");
        let (vibe_home, alias) = write_agent_config(tmp.path(), &model);

        let cfg = std::fs::read_to_string(vibe_home.join("config.toml")).unwrap();
        assert_eq!(
            cfg.lines().next().unwrap_or(""),
            format!("active_model = \"{alias}\""),
            "active_model must be first so global config cannot shadow it"
        );
        assert!(cfg.contains(&format!("alias = \"{alias}\"")));
    }

    fn first_available_model() -> Option<String> {
        let mut stream = TcpStream::connect("127.0.0.1:11434").ok()?;
        stream
            .write_all(b"GET /api/tags HTTP/1.0\r\nHost: localhost\r\n\r\n")
            .ok()?;
        let mut response = String::new();
        std::io::Read::read_to_string(&mut stream, &mut response).ok()?;
        let body = response.split("\r\n\r\n").nth(1)?;
        let v: serde_json::Value = serde_json::from_str(body).ok()?;
        v["models"]
            .as_array()?
            .iter()
            .find_map(|m| Some(m["name"].as_str()?.to_owned()))
    }
}

#[cfg(test)]
mod phone_control_tests {
    use super::*;

    /// The body shape the live server (0.34.4) answers, trimmed.
    const PS_BODY: &str = r#"{"models":[{"name":"nemotron-3.5-lightning:30b","model":"nemotron-3.5-lightning:30b","size":26783818710,"digest":"e7a6","details":{"parameter_size":"32.9B","quantization_level":"Q4_K_M"},"expires_at":"2319-01-14T10:20:46.070730299+01:00","size_vram":26783818710,"context_length":262144},{"name":"qwen3:8b","size":7100000000,"size_vram":0}]}"#;

    fn at(s: &str) -> chrono::DateTime<chrono::Utc> {
        chrono::DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&chrono::Utc)
    }

    #[test]
    fn ps_entries_reads_name_size_vram_and_expiry() {
        let ps = ps_entries(PS_BODY);
        assert_eq!(ps.len(), 2);
        assert_eq!(
            ps["nemotron-3.5-lightning:30b"],
            PsEntry {
                vram: 26_783_818_710,
                size: 26_783_818_710,
                expires_at: Some("2319-01-14T10:20:46.070730299+01:00".into()),
            }
        );
        assert_eq!(
            ps["qwen3:8b"],
            PsEntry { vram: 0, size: 7_100_000_000, expires_at: None }
        );
        assert!(ps_entries("garbage").is_empty());
        assert!(ps_entries(r#"{"models":[]}"#).is_empty());
    }

    #[test]
    fn keep_alive_tells_pinned_from_a_countdown() {
        let now = at("2026-10-04T12:00:00Z");
        // `keep_alive: -1`, as the live server reports it.
        assert_eq!(
            keep_alive_of(Some("2319-01-14T10:20:46.070730299+01:00"), now),
            (true, None)
        );
        assert_eq!(keep_alive_of(Some("2026-10-04T12:04:00Z"), now), (false, Some(240)));
        assert_eq!(
            keep_alive_of(Some("2026-10-04T14:04:00+02:00"), now),
            (false, Some(240)),
            "the offset is honoured"
        );
        assert_eq!(keep_alive_of(Some("2026-10-04T11:59:00Z"), now), (false, None));
        assert_eq!(keep_alive_of(None, now), (false, None));
        assert_eq!(keep_alive_of(Some("soon"), now), (false, None));
    }

    const TAGS_BODY: &str = r#"{"models":[
        {"name":"llama3:latest","model":"llama3:latest","size":1},
        {"name":"qwen3.5:9b","model":"qwen3.5:9b","size":2},
        {"name":"hf.co/u/m:q4","size":3},
        {"name":"gpt-oss:120b-cloud","remote_model":"gpt-oss:120b","remote_host":"https://ollama.com:443","size":4}
    ]}"#;

    #[test]
    fn installed_match_is_exact_or_latest_never_a_prefix() {
        assert_eq!(installed_match(TAGS_BODY, "qwen3.5:9b"), Ok("qwen3.5:9b".into()));
        assert_eq!(installed_match(TAGS_BODY, "hf.co/u/m:q4"), Ok("hf.co/u/m:q4".into()));
        // An untagged name means `:latest`, and the listed spelling comes back.
        assert_eq!(installed_match(TAGS_BODY, "llama3"), Ok("llama3:latest".into()));
        assert_eq!(installed_match(TAGS_BODY, "llama3:latest"), Ok("llama3:latest".into()));
        // No prefix match, in either direction.
        assert_eq!(installed_match(TAGS_BODY, "qwen3"), Err("model_not_installed"));
        assert_eq!(installed_match(TAGS_BODY, "qwen3.5"), Err("model_not_installed"));
        assert_eq!(installed_match(TAGS_BODY, "llama3:8b"), Err("model_not_installed"));
        assert_eq!(installed_match(TAGS_BODY, "mistral"), Err("model_not_installed"));
        // A cloud model is listed but has nothing here to load.
        assert_eq!(installed_match(TAGS_BODY, "gpt-oss:120b-cloud"), Err("model_not_local"));
        // An unreadable list fails closed.
        assert_eq!(installed_match("garbage", "llama3"), Err("model_not_installed"));
        assert_eq!(installed_match("{}", "llama3"), Err("model_not_installed"));
    }

    #[test]
    fn remote_entries_name_a_remote() {
        assert!(is_remote_entry(&serde_json::json!({"name":"a","remote_host":"https://x"})));
        assert!(is_remote_entry(&serde_json::json!({"name":"a","remote_model":"b"})));
        assert!(!is_remote_entry(&serde_json::json!({"name":"a"})));
        assert!(!is_remote_entry(&serde_json::json!({"name":"a","remote_host":""})));
        assert!(!is_remote_entry(&serde_json::json!({"name":"a","remote_host":null})));
    }

    #[test]
    fn server_kind_judges_the_resolved_literal() {
        for local in ["127.0.0.1:11434", "localhost:11434", "[::1]:11434", "127.0.0.1:11500"] {
            assert_eq!(server_kind(local), "local", "{local}");
        }
        for remote in ["192.0.2.7:11434", "gpu-box:11434", "[2001:db8::1]:11434"] {
            assert_eq!(server_kind(remote), "remote", "{remote}");
        }
        // What the resolver hands over for the default and for bind-all.
        assert_eq!(server_kind(&resolve_ollama_addr(None, false).unwrap()), "local");
        assert_eq!(server_kind(&resolve_ollama_addr(Some("0.0.0.0:11434"), false).unwrap()), "local");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn an_unattended_start_never_asks_for_a_password() {
        assert!(systemctl_start_args(false).contains(&"--no-ask-password"));
        assert!(!systemctl_start_args(true).contains(&"--no-ask-password"));
        for ask in [false, true] {
            assert!(systemctl_start_args(ask).ends_with(&["start", "ollama"]));
        }
    }

    #[test]
    fn a_phone_load_claim_dedupes_and_releases_on_drop() {
        let model = "phone-claim-test:1b";
        let first = PhoneLoadClaim::claim(model).expect("a free model can be claimed");
        assert!(PhoneLoadClaim::claim(model).is_none(), "a running load is not started twice");
        let other = PhoneLoadClaim::claim("phone-claim-test:2b");
        assert!(other.is_some(), "claims are per model");
        drop(first);
        assert!(
            PhoneLoadClaim::claim(model).is_some(),
            "the entry goes with the claim, whatever ended the load"
        );

        // A panicking load thread releases it too.
        let claim = PhoneLoadClaim::claim(model).unwrap();
        let _ = std::thread::spawn(move || {
            let _claim = claim;
            panic!("load blew up");
        })
        .join();
        assert!(PhoneLoadClaim::claim(model).is_some());
    }
}
