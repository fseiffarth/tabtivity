//! HPC **workspaces** — the missing first step of the SLURM pipeline
//! (`docs/quirky-knitting-umbrella` plan, Phase C).
//!
//! On a cluster, `$HOME` is a small, quota'd, backed-up filesystem for *code*;
//! the bulk data of a computation belongs on the big parallel filesystem, which
//! is handed out as a **workspace** — a directory with a *name*, a *duration* and
//! an *expiry*, created through the `hpc-workspace` tooling (`ws_allocate`,
//! `ws_list`, `ws_find`, `ws_extend`, `ws_release`). Sites differ in filesystems
//! and limits (a typical one: up to 90 days, three extensions, a general-purpose
//! default location plus a faster SSD one, data deleted some weeks after expiry),
//! so nothing here is site-specific: the host is *asked* what it offers
//! (`ws_list -l`) and the tooling's own output is parsed.
//!
//! This module is what lets Tabtivity put a remote project's tree **in a workspace
//! instead of `$HOME`** before a single byte is uploaded or synced — the wizard's
//! Workspace step simply makes the allocated path the project's remote root, so
//! every existing transport (SFTP upload, byte-sync, git lockstep) lands on the
//! parallel filesystem with no change of its own.
//!
//! Structure mirrors `commands::slurm` (whose dispatch it reuses verbatim), with
//! one addition: a workspace is usually allocated **before the project exists**,
//! so every command takes an [`HpcWsTarget`] that is *either* a project (pooled
//! ControlMaster, like SLURM) *or* a bare host (ad-hoc `run_ssh_auth`, exactly as
//! `global_machine_usage_check` does for a project-free machine).
//!
//! **Security.** The scripts are embedded verbatim in `sh`, so every interpolated
//! value is both **validated** (id/filesystem/link name charsets, day counts
//! numeric and bounded, mail free of shell metacharacters) *and* `shell_quote`d.
//! The pure parsers are unit-tested against captured tooling output.

use serde::{Deserialize, Serialize};

use crate::services::remote::{remote_target_for_dir, PRIMARY_HOST};
use crate::services::ssh_exec::shell_quote;

// ── Types ────────────────────────────────────────────────────────────────────

/// One workspace filesystem the site offers (`ws_list -l`). `default` marks the
/// one used when `ws_allocate` is given no `-F`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct HpcWsFilesystem {
    pub name: String,
    pub default: bool,
}

/// Whether the host has the workspace tooling at all, and which filesystems it
/// offers. `available: false` is the ordinary answer on a cluster without
/// `hpc-workspace` (and on a plain SSH host) — the UI hides the step, it is not
/// an error.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct HpcWsInfo {
    pub available: bool,
    pub filesystems: Vec<HpcWsFilesystem>,
}

/// One workspace, as reported by `ws_list` (and by `ws_allocate` for a fresh one).
/// Only `id` and `path` are guaranteed; every other field is whatever the site's
/// tooling printed, because the detail lines differ between versions.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct HpcWorkspace {
    pub id: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filesystem: Option<String>,
    /// The tooling's own remaining-time phrasing, e.g. `"89 days 23 hours"`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remaining: Option<String>,
    /// Whole days left, lifted out of `remaining` when it starts with a day count.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remaining_days: Option<i64>,
    /// Extensions still available (each buys another duration).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extensions: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expiration: Option<String>,
}

/// Where to run a workspace command. **Either** a project (`project_dir` +
/// optional `host_id`, riding its pooled ControlMaster exactly as SLURM does)
/// **or** a bare host (`host` + credentials, authenticated ad-hoc) — because the
/// wizard allocates a workspace *before* the project it will hold exists.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HpcWsTarget {
    pub project_dir: Option<String>,
    pub host_id: Option<String>,
    pub user: Option<String>,
    pub host: Option<String>,
    pub port: Option<u16>,
    /// Single-use, never persisted here: the credential the wizard's login just
    /// authenticated with. Omitted, a saved password (then key/agent auth) is used
    /// — the same fallback `ssh_connect` applies.
    pub password: Option<String>,
}

/// The `ws_allocate` request. `days` is mandatory on purpose: the tooling's own
/// default when it is omitted is **one day**, which is the classic way to lose a
/// workspace full of results overnight.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HpcWsAllocate {
    pub id: String,
    pub days: i64,
    /// `-F`: the workspace filesystem. Omitted ⇒ the site default.
    pub filesystem: Option<String>,
    /// `-r`: send a reminder this many days before expiry (needs `mail`).
    pub reminder_days: Option<i64>,
    /// `-m`: the reminder address. Sites commonly only deliver to their own
    /// domain, so a rejected address is the site's answer, not ours.
    pub mail: Option<String>,
    /// `-G`: make the workspace group-writable for this group.
    pub group: Option<String>,
    /// `-g`: make the workspace group-readable.
    pub group_readable: Option<bool>,
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

/// Run `script` at the target and return its stdout. A project target reuses
/// `commands::slurm`'s dispatch verbatim (pooled ControlMaster for a remote
/// project, a local shell for a login node Tabtivity runs on); a bare-host target
/// authenticates ad-hoc like `global_machine_usage_check`.
fn run_ws_script(target: &HpcWsTarget, script: &str) -> Result<String, String> {
    if let Some(dir) = target
        .project_dir
        .as_deref()
        .map(str::trim)
        .filter(|d| !d.is_empty())
    {
        let host = target.host_id.as_deref().unwrap_or(PRIMARY_HOST);
        return crate::commands::slurm::run_slurm_script(dir, host, script);
    }
    let host = target
        .host
        .as_deref()
        .map(str::trim)
        .filter(|h| !h.is_empty())
        .ok_or_else(|| "no project or host given for the workspace command".to_string())?;
    let user = target
        .user
        .clone()
        .map(|u| u.trim().to_string())
        .filter(|u| !u.is_empty());
    use crate::services::remote_credentials as creds;
    // The bare-host branch runs *before any project exists* — the Workspace step
    // of the create flow, where the user has just typed this machine's address —
    // so, like the project branch above (`run_slurm_script`), it is user-initiated
    // and clears the dial policy for the argv `run_ssh_auth` builds.
    let _dial = crate::services::ssh_common::user_dial(&user, host, target.port);
    let account = creds::ssh_account(&user, host, target.port);
    let password = target
        .password
        .clone()
        .filter(|p| !p.is_empty())
        .or_else(|| creds::get(&account));
    crate::commands::ssh::run_ssh_auth(&user, host, target.port, password.as_deref(), &[script])
}

// ── Validation (defense in depth — every value is ALSO shell-quoted) ──────────

/// A workspace id / filesystem / link name: printable, path-free, and made only
/// of characters the tooling itself accepts. Rejecting here buys a readable error
/// instead of a remote `ws_allocate` usage dump.
fn validate_token(what: &str, value: &str) -> Result<String, String> {
    let v = value.trim();
    if v.is_empty() {
        return Err(format!("no {what} given"));
    }
    if v.len() > 64 {
        return Err(format!("{what} is too long (max 64 characters)"));
    }
    if v.starts_with('-') {
        return Err(format!("{what} may not start with '-'"));
    }
    if !v
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    {
        return Err(format!(
            "invalid {what} '{v}' — use letters, digits, '.', '_' or '-'"
        ));
    }
    Ok(v.to_string())
}

/// A day count for an allocation/extension/reminder. Bounded so a typo can't ask
/// for a decade; the site caps it further anyway.
fn validate_days(what: &str, days: i64) -> Result<i64, String> {
    if !(1..=3650).contains(&days) {
        return Err(format!("{what} must be between 1 and 3650 days"));
    }
    Ok(days)
}

/// A reminder address: one token, an `@`, no shell metacharacters. (It is quoted
/// too; this only turns a hostile-looking value into a clear error.)
fn validate_mail(mail: &str) -> Result<String, String> {
    let m = mail.trim();
    if m.is_empty() {
        return Err("no reminder address given".to_string());
    }
    if m.len() > 254
        || m.chars().any(|c| c.is_whitespace())
        || !m.contains('@')
        || m.chars()
            .any(|c| matches!(c, '\'' | '"' | '`' | '$' | ';' | '|' | '&' | '<' | '>'))
    {
        return Err(format!("invalid reminder address '{m}'"));
    }
    Ok(m.to_string())
}

/// An absolute host path (a workspace path we are about to link to). Quoted at
/// use; validated so a relative or empty value fails locally.
fn validate_abs_path(what: &str, path: &str) -> Result<String, String> {
    let p = path.trim().trim_end_matches('/');
    if p.is_empty() || !p.starts_with('/') {
        return Err(format!("{what} must be an absolute path"));
    }
    if p.contains('\n') || p.contains('\0') {
        return Err(format!("invalid {what} '{path}'"));
    }
    Ok(p.to_string())
}

// ── Scripts ──────────────────────────────────────────────────────────────────

/// Separates the `ws_list` detail blocks from the `id\tpath` map appended after
/// them, so one round trip yields both the human detail and an authoritative path
/// per workspace (`ws_find`), whatever the site's `ws_list` layout is.
const PATHS_MARKER: &str = concat!("---", crate::app_upper!(), "-WS-PATHS---");
/// Separates `ws_allocate`'s own output from the `ws_find` confirmation after it.
const PATH_MARKER: &str = concat!("---", crate::app_upper!(), "-WS-PATH---");

/// `-F <fs>` when a filesystem was chosen, else nothing. Pre-validated + quoted.
fn fs_flag(filesystem: Option<&str>) -> Result<String, String> {
    match filesystem.map(str::trim).filter(|f| !f.is_empty()) {
        None => Ok(String::new()),
        Some(f) => {
            let f = validate_token("filesystem", f)?;
            Ok(format!(" -F {}", shell_quote(&f)))
        }
    }
}

// ── Pure parsers ─────────────────────────────────────────────────────────────

/// Parse `ws_list -l` — the available workspace filesystems. Output is a header
/// line plus one location per line, one of which may carry a `(default)` marker.
/// Anything that isn't a bare location token (headers, `Info:`/`Error:` chatter)
/// is skipped, so a site whose banner differs still yields a clean list.
pub fn parse_ws_locations(stdout: &str) -> Vec<HpcWsFilesystem> {
    let mut out: Vec<HpcWsFilesystem> = Vec::new();
    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() || line.ends_with(':') || line.contains("://") {
            continue;
        }
        let lower = line.to_ascii_lowercase();
        if lower.starts_with("info")
            || lower.starts_with("error")
            || lower.starts_with("warning")
            || lower.starts_with("available")
        {
            continue;
        }
        let Some(name) = line.split_whitespace().next() else {
            continue;
        };
        if name.len() > 64
            || !name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        {
            continue;
        }
        if out.iter().any(|f| f.name == name) {
            continue;
        }
        out.push(HpcWsFilesystem {
            name: name.to_string(),
            default: lower.contains("(default)"),
        });
    }
    out
}

/// Lift the leading whole-day count out of a remaining-time phrase
/// (`"89 days 23 hours"` → 89). `None` when it doesn't start with a number.
fn leading_days(remaining: &str) -> Option<i64> {
    let first = remaining.split_whitespace().next()?;
    first.parse::<i64>().ok()
}

/// Assign one `key : value` detail line onto a workspace. Keys are matched by
/// *keyword*, not exact spelling, because they differ between tooling versions
/// (`available extensions` vs `remaining extensions`, `remaining time` vs
/// `remaining time in days`).
fn apply_detail(ws: &mut HpcWorkspace, key: &str, value: &str) {
    let k = key.trim().to_ascii_lowercase();
    let v = value.trim();
    if v.is_empty() {
        return;
    }
    if k.contains("directory") || k.contains("workspace path") {
        if ws.path.is_empty() {
            ws.path = v.to_string();
        }
    } else if k.contains("filesystem") || k.contains("location") {
        ws.filesystem = Some(v.to_string());
    } else if k.contains("extension") {
        ws.extensions = v.parse::<i64>().ok().or(ws.extensions);
    } else if k.contains("expiration") || k.contains("expires") {
        ws.expiration = Some(v.to_string());
    } else if k.contains("remaining") {
        if k.contains("in days") {
            ws.remaining_days = v.parse::<i64>().ok().or(ws.remaining_days);
            ws.remaining.get_or_insert_with(|| format!("{v} days"));
        } else {
            ws.remaining_days = leading_days(v).or(ws.remaining_days);
            ws.remaining = Some(v.to_string());
        }
    }
}

/// Parse the two-part `ws_list` script output: the tooling's detail blocks
/// (`Id: <name>` followed by indented `key : value` lines), then a
/// [`PATHS_MARKER`]-separated `id\tpath` map from `ws_find`.
///
/// The map is what makes this robust: the *path* is the one field everything
/// downstream depends on, and `ws_find` states it unambiguously whatever the
/// listing looks like. A workspace present only in the map still appears (with no
/// detail); a block whose path the map confirms is corrected.
pub fn parse_ws_list(stdout: &str) -> Vec<HpcWorkspace> {
    let (blocks, paths) = match stdout.split_once(PATHS_MARKER) {
        Some((a, b)) => (a, b),
        None => (stdout, ""),
    };

    let mut out: Vec<HpcWorkspace> = Vec::new();
    for line in blocks.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        // `Id: name` starts a new workspace block.
        if let Some(rest) = trimmed
            .strip_prefix("Id:")
            .or_else(|| trimmed.strip_prefix("id:"))
            .or_else(|| trimmed.strip_prefix("ID:"))
        {
            let id = rest.trim();
            if !id.is_empty() {
                out.push(HpcWorkspace {
                    id: id.to_string(),
                    ..Default::default()
                });
            }
            continue;
        }
        // An indented `key : value` detail line belongs to the open block.
        if line.starts_with(char::is_whitespace) {
            if let Some((k, v)) = trimmed.split_once(':') {
                if let Some(ws) = out.last_mut() {
                    apply_detail(ws, k, v);
                }
            }
        }
    }

    // `id<TAB>path` from `ws_find` — authoritative for the path, and the source
    // of any workspace the block parse missed entirely.
    for line in paths.lines() {
        let Some((id, path)) = line.trim_end().split_once('\t') else {
            continue;
        };
        let (id, path) = (id.trim(), path.trim());
        if id.is_empty() || !path.starts_with('/') {
            continue;
        }
        match out.iter_mut().find(|w| w.id == id) {
            Some(ws) => ws.path = path.to_string(),
            None => out.push(HpcWorkspace {
                id: id.to_string(),
                path: path.to_string(),
                ..Default::default()
            }),
        }
    }
    out.retain(|w| !w.path.is_empty());
    out
}

/// Parse the allocate script's output into the fresh workspace. The path is taken
/// from the `ws_find` confirmation after [`PATH_MARKER`] when present (the
/// tooling prints its path to stdout but its chatter to stderr, and a site could
/// mix them), else from the first absolute-looking line of `ws_allocate`'s own
/// output. `None` means no path was stated — the caller reports the raw output,
/// which is where the site's refusal will be.
pub fn parse_ws_allocate(id: &str, stdout: &str) -> Option<HpcWorkspace> {
    let (head, tail) = match stdout.split_once(PATH_MARKER) {
        Some((a, b)) => (a, b),
        None => (stdout, ""),
    };
    let path = tail
        .lines()
        .map(str::trim)
        .find(|l| l.starts_with('/'))
        .or_else(|| {
            head.lines()
                .map(str::trim)
                .find(|l| l.starts_with('/') && !l.contains(char::is_whitespace))
        })?;
    let mut ws = HpcWorkspace {
        id: id.to_string(),
        path: path.to_string(),
        ..Default::default()
    };
    // `ws_allocate` prints its own `remaining …` lines; reuse the list parser's
    // keyword matching so both surfaces read the same fields.
    for line in head.lines() {
        if let Some((k, v)) = line.split_once(':') {
            if k.trim().to_ascii_lowercase().contains("remaining") {
                apply_detail(&mut ws, k, v);
            }
        }
    }
    Some(ws)
}

// ── Commands ─────────────────────────────────────────────────────────────────
//
// Every command shells out (locally, over the pooled ControlMaster, or through an
// ad-hoc ssh), which can block for as long as the host takes to answer. A
// synchronous Tauri command runs on the MAIN thread and would freeze the window
// (the bug `commands::git`/`commands::slurm` already fixed), so each is an async
// wrapper around a blocking body.

async fn run_off_thread<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| format!("workspace task failed: {e}"))?
}

/// Does this host hand out workspaces, and on which filesystems? Constant script.
/// A host without the tooling answers `available: false` — never an error, since
/// most hosts are not clusters.
#[tauri::command]
pub async fn hpc_ws_available(target: HpcWsTarget) -> Result<HpcWsInfo, String> {
    run_off_thread(move || {
        let script = concat!("command -v ws_allocate >/dev/null 2>&1 || exit 0\n\
                      printf '", crate::app_upper!(), "-WS-OK\\n'\n\
                      ws_list -l 2>/dev/null || true");
        let stdout = run_ws_script(&target, script).unwrap_or_default();
        if !stdout.contains(concat!(crate::app_upper!(), "-WS-OK")) {
            return Ok(HpcWsInfo::default());
        }
        let rest = stdout
            .split_once(concat!(crate::app_upper!(), "-WS-OK"))
            .map(|(_, b)| b)
            .unwrap_or("");
        Ok(HpcWsInfo {
            available: true,
            filesystems: parse_ws_locations(rest),
        })
    })
    .await
}

/// The caller's existing workspaces. Constant script: `ws_list` for the detail,
/// then `ws_find` per id for an authoritative path — one round trip.
#[tauri::command]
pub async fn hpc_ws_list(target: HpcWsTarget) -> Result<Vec<HpcWorkspace>, String> {
    run_off_thread(move || {
        let script = format!(
            "command -v ws_list >/dev/null 2>&1 || exit 0\n\
             ws_list 2>/dev/null || true\n\
             printf '%s\\n' '{PATHS_MARKER}'\n\
             ws_list -s 2>/dev/null | while IFS= read -r wsid; do\n\
             \x20 [ -n \"$wsid\" ] || continue\n\
             \x20 case \"$wsid\" in *:*|*' '*) continue;; esac\n\
             \x20 wspath=$(ws_find \"$wsid\" 2>/dev/null | tail -n 1)\n\
             \x20 case \"$wspath\" in /*) printf '%s\\t%s\\n' \"$wsid\" \"$wspath\";; esac\n\
             done"
        );
        let stdout = run_ws_script(&target, &script)?;
        Ok(parse_ws_list(&stdout))
    })
    .await
}

/// Allocate a workspace (`ws_allocate <id> <days>`), then confirm its path with
/// `ws_find` in the same round trip. Every interpolated value is validated above
/// and `shell_quote`d here.
#[tauri::command]
pub async fn hpc_ws_allocate(
    target: HpcWsTarget,
    req: HpcWsAllocate,
) -> Result<HpcWorkspace, String> {
    run_off_thread(move || {
        let id = validate_token("workspace name", &req.id)?;
        let days = validate_days("duration", req.days)?;
        let fs = fs_flag(req.filesystem.as_deref())?;

        let mut opts = String::new();
        if let Some(mail) = req.mail.as_deref().map(str::trim).filter(|m| !m.is_empty()) {
            let mail = validate_mail(mail)?;
            opts.push_str(&format!(" -m {}", shell_quote(&mail)));
            let reminder = validate_days("reminder", req.reminder_days.unwrap_or(7))?;
            opts.push_str(&format!(" -r {reminder}"));
        } else if let Some(r) = req.reminder_days {
            // A reminder with no address still works when the site's
            // `~/.ws_user.conf` carries one.
            opts.push_str(&format!(" -r {}", validate_days("reminder", r)?));
        }
        if let Some(group) = req.group.as_deref().map(str::trim).filter(|g| !g.is_empty()) {
            let group = validate_token("group", group)?;
            opts.push_str(&format!(" -G {}", shell_quote(&group)));
        } else if req.group_readable.unwrap_or(false) {
            opts.push_str(" -g");
        }

        let q_id = shell_quote(&id);
        let script = format!(
            "command -v ws_allocate >/dev/null 2>&1 || {{ printf '%s\\n' \
             'this host has no ws_allocate (no workspace tooling)' >&2; exit 1; }}\n\
             out=$(ws_allocate{fs}{opts} {q_id} {days} 2>&1) || {{ printf '%s\\n' \"$out\" >&2; exit 1; }}\n\
             printf '%s\\n' \"$out\"\n\
             printf '%s\\n' '{PATH_MARKER}'\n\
             ws_find{fs} {q_id} 2>/dev/null | tail -n 1"
        );
        let stdout = run_ws_script(&target, &script)?;
        parse_ws_allocate(&id, &stdout).ok_or_else(|| {
            format!(
                "ws_allocate did not report a workspace path:\n{}",
                stdout.trim()
            )
        })
    })
    .await
}

/// Extend a workspace by `days`, spending one of its extensions. Prefers
/// `ws_extend`, falling back to `ws_allocate -x` (older tooling has only the
/// latter). The same `-F` used at allocation must be repeated, so the caller
/// passes the workspace's own filesystem.
#[tauri::command]
pub async fn hpc_ws_extend(
    target: HpcWsTarget,
    id: String,
    days: i64,
    filesystem: Option<String>,
) -> Result<HpcWorkspace, String> {
    run_off_thread(move || {
        let id = validate_token("workspace name", &id)?;
        let days = validate_days("duration", days)?;
        let fs = fs_flag(filesystem.as_deref())?;
        let q_id = shell_quote(&id);
        let script = format!(
            "if command -v ws_extend >/dev/null 2>&1; then\n\
             \x20 out=$(ws_extend{fs} {q_id} {days} 2>&1) || {{ printf '%s\\n' \"$out\" >&2; exit 1; }}\n\
             elif command -v ws_allocate >/dev/null 2>&1; then\n\
             \x20 out=$(ws_allocate -x{fs} {q_id} {days} 2>&1) || {{ printf '%s\\n' \"$out\" >&2; exit 1; }}\n\
             else\n\
             \x20 printf '%s\\n' 'this host has no workspace tooling' >&2; exit 1\n\
             fi\n\
             printf '%s\\n' \"$out\"\n\
             printf '%s\\n' '{PATH_MARKER}'\n\
             ws_find{fs} {q_id} 2>/dev/null | tail -n 1"
        );
        let stdout = run_ws_script(&target, &script)?;
        parse_ws_allocate(&id, &stdout)
            .ok_or_else(|| format!("could not extend '{id}':\n{}", stdout.trim()))
    })
    .await
}

/// Release a workspace. The data is not deleted immediately (sites keep it for a
/// grace period and `ws_restore` can recover it), but the directory goes away —
/// so the UI must confirm before calling this.
#[tauri::command]
pub async fn hpc_ws_release(
    target: HpcWsTarget,
    id: String,
    filesystem: Option<String>,
) -> Result<(), String> {
    run_off_thread(move || {
        let id = validate_token("workspace name", &id)?;
        let fs = fs_flag(filesystem.as_deref())?;
        let script = format!(
            "command -v ws_release >/dev/null 2>&1 || {{ printf '%s\\n' \
             'this host has no ws_release' >&2; exit 1; }}\n\
             out=$(ws_release{fs} {} 2>&1) || {{ printf '%s\\n' \"$out\" >&2; exit 1; }}\n\
             printf '%s\\n' \"$out\"",
            shell_quote(&id)
        );
        run_ws_script(&target, &script)?;
        Ok(())
    })
    .await
}

/// Symlink a workspace into a project's remote root (`<remote_path>/<link_name>
/// -> <workspace_path>`) — for the layout where the project itself stays in
/// `$HOME` (code, git) and only the bulk data lives in the workspace, so a job
/// script can write to `./<link_name>` without knowing the site's path.
///
/// **The link is for the host's own tools, not for Tabtivity's byte-sync**, which
/// never follows a symlink (`remote_sync::walk_host_files`, guard G3): files the
/// job writes under it are not mirrored. That is exactly why the wizard's default
/// is instead to put the project *in* the workspace, where every transport
/// already works unchanged.
#[tauri::command]
pub async fn hpc_ws_link(
    project_dir: String,
    workspace_path: String,
    link_name: String,
) -> Result<String, String> {
    run_off_thread(move || {
        let ws = validate_abs_path("workspace path", &workspace_path)?;
        let name = validate_token("link name", &link_name)?;
        let root = remote_target_for_dir(&project_dir)
            .map(|t| t.spec.remote_path.trim_end_matches('/').to_string())
            .ok_or_else(|| "not a remote project".to_string())?;
        let dest = format!("{root}/{name}");
        let script = format!(
            "[ -d {ws} ] || {{ printf '%s\\n' 'workspace path does not exist' >&2; exit 1; }}\n\
             if [ -e {dest} ] && [ ! -L {dest} ]; then\n\
             \x20 printf '%s\\n' 'a real file or folder of that name already exists' >&2; exit 1\n\
             fi\n\
             ln -sfn {ws} {dest}",
            ws = shell_quote(&ws),
            dest = shell_quote(&dest),
        );
        run_ws_script(
            &HpcWsTarget {
                project_dir: Some(project_dir.clone()),
                ..Default::default()
            },
            &script,
        )?;
        Ok(dest)
    })
    .await
}

// ── Big-filesystem candidates for a cluster WITHOUT workspace tooling ────────

/// A directory the site itself nominates as the place for bulk data — the
/// `hpc-workspace`-less cluster's answer to "where does this project go".
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ScratchCandidate {
    /// `env` (an environment variable the site's profile exports) or `path` (a
    /// conventional location that turned out to exist).
    pub source: String,
    /// `$SCRATCH`, `$WORK`, … or the convention's own name.
    pub label: String,
    pub path: String,
    pub writable: bool,
    /// Free space in KiB from `df -Pk`, when it answered.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub free_kb: Option<u64>,
}

/// The environment variables clusters use to point at their big filesystem. This
/// list is the ONE site-shaped thing in this module, and it is deliberately just
/// a list of *names to ask about* — the site's own profile decides which exist
/// and what they mean, exactly as `ws_list -l` does at a workspace site. Ordered
/// by how specifically each usually means "bulk working data".
const SCRATCH_VARS: &[&str] = &[
    "SCRATCH", "WORK", "WORKDIR", "WRKDIR", "BIGWORK", "PROJECT", "FASTDATA", "DATA",
];

/// Parse the candidate probe's `source\tlabel\tpath\twritable\tfree` lines,
/// dropping duplicates by path (a site commonly points two variables at one
/// directory) and anything malformed.
pub fn parse_scratch_candidates(stdout: &str) -> Vec<ScratchCandidate> {
    let mut out: Vec<ScratchCandidate> = Vec::new();
    for line in stdout.lines() {
        let f: Vec<&str> = line.trim_end().split('\t').collect();
        if f.len() < 4 {
            continue;
        }
        let path = f[2].trim().trim_end_matches('/');
        if !path.starts_with('/') || f[1].trim().is_empty() {
            continue;
        }
        if out.iter().any(|c| c.path == path) {
            continue;
        }
        out.push(ScratchCandidate {
            source: f[0].trim().to_string(),
            label: f[1].trim().to_string(),
            path: path.to_string(),
            writable: f[3].trim() == "yes",
            free_kb: f.get(4).and_then(|v| v.trim().parse::<u64>().ok()),
        });
    }
    out
}

/// Ask a cluster **without** workspace tooling where its bulk data belongs.
///
/// This is what keeps the pipeline honest at a site that has SLURM but no
/// `ws_allocate`: without it the project would land in the browsed folder — i.e.
/// `$HOME` — which is the exact failure the whole workspace step exists to
/// prevent. Nothing about a site is assumed: the probe asks whether the *site's
/// own profile* exports one of the usual variables, then falls back to the two
/// conventional locations, and reports only directories that actually exist.
/// Writability is stated rather than filtered on, because a read-only hit is
/// still information (it is usually the group's shared tree, not yours).
#[tauri::command]
pub async fn hpc_scratch_candidates(target: HpcWsTarget) -> Result<Vec<ScratchCandidate>, String> {
    run_off_thread(move || {
        // `eval` only ever expands a name from SCRATCH_VARS, and every value is
        // handled as data (quoted `"$p"`), never re-evaluated.
        let vars = SCRATCH_VARS.join(" ");
        let script = format!(
            "probe() {{\n\
             \x20 [ -d \"$3\" ] || return 0\n\
             \x20 w=no; [ -w \"$3\" ] && w=yes\n\
             \x20 free=$(df -Pk \"$3\" 2>/dev/null | awk 'NR==2 {{print $4}}')\n\
             \x20 printf '%s\\t%s\\t%s\\t%s\\t%s\\n' \"$1\" \"$2\" \"$3\" \"$w\" \"${{free:-}}\"\n\
             }}\n\
             for v in {vars}; do\n\
             \x20 eval p=\\$$v\n\
             \x20 case \"$p\" in /*) probe env \"\\$$v\" \"$p\";; esac\n\
             done\n\
             for p in \"/scratch/$USER\" \"/work/$USER\" \"/lustre/$USER\"; do\n\
             \x20 probe path \"$p\" \"$p\"\n\
             done"
        );
        let stdout = run_ws_script(&target, &script).unwrap_or_default();
        Ok(parse_scratch_candidates(&stdout))
    })
    .await
}

// ── The home anchor (Phase 1) ────────────────────────────────────────────────

/// The small per-project folder kept in the user's cluster **home**, holding what
/// must outlive the workspace: the job logs, a `cd`-able link to the workspace,
/// and an append-only record naming it. Returned with every path resolved
/// absolutely, because `$HOME` is only known on the host.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct HpcAnchor {
    pub dir: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub logs_dir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub link: Option<String>,
}

/// A `$HOME`-relative anchor location (`tabtivity/my-project`): plain path segments,
/// no absolute path, no `..`, no metacharacters. Validated rather than merely
/// quoted so a slip can't write outside the user's home.
fn validate_anchor_rel(rel: &str) -> Result<String, String> {
    let r = rel.trim().trim_matches('/');
    if r.is_empty() {
        return Err("no anchor folder given".to_string());
    }
    if r.len() > 128 {
        return Err("anchor folder path is too long".to_string());
    }
    for seg in r.split('/') {
        // `validate_token` permits '.' inside a name (`my.project`), so the
        // traversal segments have to be rejected on their own.
        if seg == "." || seg == ".." {
            return Err("anchor folder path may not contain '.' or '..'".to_string());
        }
        validate_token("anchor folder", seg)?;
    }
    Ok(r.to_string())
}

/// Create (idempotently) the project's home anchor: `$HOME/<anchor_rel>` with a
/// `logs/` subfolder, a `workspace` symlink to the workspace path, and a line
/// appended to `workspaces.txt`.
///
/// The record is **append-only and deliberately plain text**: a project moves
/// through several workspaces over a year, and the previous names are what
/// `ws_restore` needs after an expiry — a file that got overwritten each time
/// would answer "which workspace held the runs from March?" with the wrong one.
/// It notes the local mirror path too, so the cluster side says which machine
/// holds the durable copy.
///
/// Refuses to replace a real file/directory named `workspace` (only its own
/// symlink is re-pointed), so an anchor folder someone put real data in is never
/// clobbered.
#[tauri::command]
pub async fn hpc_ws_anchor(
    target: HpcWsTarget,
    anchor_rel: String,
    workspace_path: Option<String>,
    workspace_id: Option<String>,
    project_name: String,
    mirror_path: Option<String>,
    make_logs: Option<bool>,
) -> Result<HpcAnchor, String> {
    run_off_thread(move || {
        let rel = validate_anchor_rel(&anchor_rel)?;
        let logs = make_logs.unwrap_or(true);
        let ws_path = match workspace_path
            .as_deref()
            .map(str::trim)
            .filter(|p| !p.is_empty())
        {
            Some(p) => Some(validate_abs_path("workspace path", p)?),
            None => None,
        };
        // Free text only ever reaches the host inside single quotes; newlines are
        // stripped so a name cannot forge a second record line.
        let clean = |s: &str| s.replace(['\n', '\r'], " ").trim().to_string();
        let name = clean(&project_name);
        let ws_id = workspace_id.as_deref().map(clean).unwrap_or_default();
        let mirror = mirror_path.as_deref().map(clean).unwrap_or_default();

        let mut script = format!(
            "dir=\"$HOME\"/{rel}\n\
             mkdir -p \"$dir\" || exit 1\n",
            rel = shell_quote(&rel),
        );
        if logs {
            script.push_str("mkdir -p \"$dir/logs\" || exit 1\n");
        }
        if let Some(p) = &ws_path {
            script.push_str(&format!(
                "if [ -e \"$dir/workspace\" ] && [ ! -L \"$dir/workspace\" ]; then\n\
                 \x20 printf '%s\\n' 'a real file named workspace is already there' >&2; exit 1\n\
                 fi\n\
                 ln -sfn {ws} \"$dir/workspace\" || exit 1\n",
                ws = shell_quote(p),
            ));
        }
        script.push_str(&format!(
            "{{ printf '%s  project=%s  workspace=%s  path=%s  mirror=%s\\n' \
             \"$(date -u '+%Y-%m-%dT%H:%M:%SZ')\" {name} {id} {path} {mirror}; }} \
             >> \"$dir/workspaces.txt\" || exit 1\n\
             printf '%s\\n' \"$dir\"",
            name = shell_quote(&name),
            id = shell_quote(&ws_id),
            path = shell_quote(ws_path.as_deref().unwrap_or("")),
            mirror = shell_quote(&mirror),
        ));

        let stdout = run_ws_script(&target, &script)?;
        let dir = stdout
            .lines()
            .map(str::trim)
            .rev()
            .find(|l| l.starts_with('/'))
            .ok_or_else(|| format!("could not create the home folder:\n{}", stdout.trim()))?
            .to_string();
        Ok(HpcAnchor {
            logs_dir: logs.then(|| format!("{dir}/logs")),
            link: ws_path.map(|_| format!("{dir}/workspace")),
            dir,
        })
    })
    .await
}

/// Persist a project's workspace/anchor record. Writes BOTH the `projects.json`
/// entry's `extra["hpc"]` (what the frontend reads on load) and the `project.json`
/// `hpc` field, exactly as `set_project_run_host` does for its own value.
#[tauri::command]
pub fn set_project_hpc(
    project_id: String,
    hpc: Option<crate::schema::project::HpcInfo>,
) -> Result<(), String> {
    crate::commands::projects::patch_project_entry_mirrored(
        &project_id,
        |entry| {
            match &hpc {
                Some(info) => {
                    let value = serde_json::to_value(info).map_err(|e| e.to_string())?;
                    entry.extra.insert("hpc".into(), value);
                }
                None => {
                    entry.extra.remove("hpc");
                }
            }
            Ok(())
        },
        |project, ()| project.hpc = hpc.clone(),
    )
}

/// Copy the anchor's `logs/` into the local mirror's `logs/` — the provenance
/// record on the machine the user actually reads logs on. Small by construction
/// (SLURM out/err only), so it is a plain per-file SFTP read, not a sync pass;
/// nothing is deleted locally and an unreadable file is skipped rather than
/// failing the batch. Returns how many files were copied.
#[tauri::command]
pub async fn hpc_ws_pull_logs(
    pool: tauri::State<'_, crate::services::remote::RemotePoolState>,
    project_id: String,
    logs_dir: String,
) -> Result<u32, String> {
    let dir = validate_abs_path("logs folder", &logs_dir)?;
    let sftp = crate::services::remote::pooled_sftp(pool.inner(), &project_id)
        .await
        .ok_or_else(|| "remote project is not connected".to_string())?;
    let entries = crate::services::sftp::list_dir_on(&sftp, &dir).await?;
    let mirror = crate::services::remote_sync::mirror_dir(&project_id);
    let mut copied = 0u32;
    for entry in entries {
        // #863: the name is joined onto the mirror — one component only, and the
        // write is confined (no `..`, no symlinked `logs/`, a planted file link is
        // replaced rather than written through).
        if entry.is_dir || !crate::services::sftp::is_single_component_name(&entry.name) {
            continue;
        }
        let remote = format!("{dir}/{}", entry.name);
        let Ok(bytes) = crate::services::sftp::read_file_on(&sftp, &remote).await else {
            continue;
        };
        let rel = format!("logs/{}", entry.name);
        if crate::services::remote_sync::write_mirror_file(&mirror, &rel, &bytes).is_ok() {
            copied += 1;
        }
    }
    Ok(copied)
}

// ── Moving the project to another workspace (Phase 2) ────────────────────────

/// Re-point a remote project's **primary** root at `new_root` — the action a
/// workspace expiry makes inevitable, and which nothing else in Tabtivity could do
/// (a primary's `remote_path` is fixed at creation; the remote-machines hub's
/// path field only adds worker hosts).
///
/// It rewrites the pointers and **resets the pairing bases**, nothing more:
///  - `project.json`'s `remote.remote_path` and the `projects.json` entry's
///    mirrored `extra["remote"]`, which is the source of truth every caller reads;
///  - git lockstep's state back to a fresh `enabled` (the next pass re-seeds the
///    new, empty host repo from the mirror — the same one-directional seed
///    `extend_project_to_remote` relies on, and safe for the same reason);
///  - the byte-sync manifest's per-file **bases** (host size/mtime + transfer
///    timestamps), keeping every marker (`selected`/`auto`/`excluded`). Left in
///    place they would claim the new root already holds files it does not, and
///    the safe-direction policy would read that as "host deleted them".
///
/// The local mirror — the durable copy — is never touched, which is exactly why
/// losing a workspace costs a re-pair rather than the work. The caller must
/// disconnect and reconnect the project around this: the pool caches the spec.
#[tauri::command]
pub async fn hpc_ws_move_root(
    project_id: String,
    new_root: String,
) -> Result<crate::schema::projects::ProjectEntry, String> {
    run_off_thread(move || {
        let root = validate_abs_path("project root", &new_root)?;
        let target = crate::services::remote::remote_target_for(&project_id)
            .ok_or_else(|| "not a remote project".to_string())?;
        if target.spec.remote_path.trim_end_matches('/') == root {
            return Err("the project is already there".to_string());
        }

        // Create the destination before anything is rewritten: a failure here must
        // leave the project pointing at a root that still exists.
        crate::services::ssh_exec::run_remote_shell(
            &target.spec,
            &format!("mkdir -p {}", shell_quote(&root)),
        )
        .and_then(|out| {
            if out.status.success() {
                Ok(())
            } else {
                Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
            }
        })
        .map_err(|e| format!("could not create '{root}' on the host: {e}"))?;

        let (_spec, updated) = crate::commands::projects::patch_project_entry_mirrored(
            &project_id,
            |entry| {
                // Re-read the current spec under the registry transaction so a
                // simultaneous key-auth/endpoint update is preserved while we
                // change only the workspace root.
                let mut spec: crate::schema::project::RemoteSpec = entry
                    .extra
                    .get("remote")
                    .cloned()
                    .map(serde_json::from_value)
                    .transpose()
                    .map_err(|e| e.to_string())?
                    .ok_or_else(|| "not a remote project".to_string())?;
                spec.remote_path = root.clone();
                let value = serde_json::to_value(&spec).map_err(|e| e.to_string())?;
                entry.extra.insert("remote".to_string(), value);
                Ok((spec, entry.clone()))
            },
            |project, (spec, _)| project.remote = Some(spec.clone()),
        )?;

        // Lockstep: keep the opt-in, drop every cached head/signature so the next
        // pass pairs the empty new root instead of trusting the old one's refs.
        let prev = crate::services::git_peer::load_state(&project_id);
        let reset = crate::services::git_peer::GitPeerState {
            enabled: prev.enabled,
            ..Default::default()
        };
        if let Err(e) = crate::services::git_peer::save_state(&project_id, &reset) {
            eprintln!("hpc_ws_move_root: could not reset lockstep state: {e}");
        }

        // Byte-sync: markers stay (they are the user's consent), bases clear.
        let mut manifest = crate::services::remote_sync::load_manifest(&project_id);
        for entry in manifest.values_mut() {
            entry.host_size = 0;
            entry.host_mtime = None;
            entry.local_size = 0;
            entry.local_mtime = None;
            entry.last_pull_ts = None;
            entry.last_push_ts = None;
        }
        if let Err(e) = crate::services::remote_sync::save_manifest(&project_id, &manifest) {
            eprintln!("hpc_ws_move_root: could not reset sync bases: {e}");
        }

        Ok(updated)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scratch_candidates_are_parsed_and_deduped_by_path() {
        // Two variables pointing at one directory is normal at a site that keeps
        // an alias; the picker must not offer the same place twice.
        let out = "env\t$SCRATCH\t/scratch/alice\tyes\t123456\n\
                   env\t$WORK\t/scratch/alice/\tyes\t123456\n\
                   env\t$PROJECT\t/project/grp\tno\t\n\
                   path\t/work/alice\t/work/alice\tyes\t9\n\
                   garbage\n\
                   env\t$X\trelative/path\tyes\t1\n";
        let c = parse_scratch_candidates(out);
        assert_eq!(c.len(), 3);
        assert_eq!(c[0].label, "$SCRATCH");
        assert_eq!(c[0].path, "/scratch/alice");
        assert_eq!(c[0].free_kb, Some(123456));
        assert!(c[0].writable);
        // Reported, not filtered: a read-only hit is still information.
        assert_eq!(c[1].path, "/project/grp");
        assert!(!c[1].writable);
        assert_eq!(c[1].free_kb, None);
        assert_eq!(c[2].source, "path");
    }

    #[test]
    fn anchor_rel_is_home_relative_and_path_safe() {
        assert_eq!(
            validate_anchor_rel(concat!(crate::app_slug!(), "/my-project")).unwrap(),
            concat!(crate::app_slug!(), "/my-project")
        );
        assert_eq!(validate_anchor_rel(concat!("/", crate::app_slug!(), "/p/")).unwrap(), concat!(crate::app_slug!(), "/p"));
        assert!(validate_anchor_rel("../../etc").is_err());
        assert!(validate_anchor_rel("a/../b").is_err());
        assert!(validate_anchor_rel("a b").is_err());
        assert!(validate_anchor_rel("").is_err());
    }

    #[test]
    fn locations_are_lifted_and_default_marked() {
        let out = "available filesystems:\nscratch (default)\nmlnvme\nproject\n";
        let fs = parse_ws_locations(out);
        assert_eq!(fs.len(), 3);
        assert_eq!(fs[0].name, "scratch");
        assert!(fs[0].default);
        assert_eq!(fs[1].name, "mlnvme");
        assert!(!fs[1].default);
    }

    #[test]
    fn locations_skip_chatter_and_duplicates() {
        let out = "Info: something\nError: nope\nscratch\nscratch\n\n";
        let fs = parse_ws_locations(out);
        assert_eq!(fs.len(), 1);
        assert_eq!(fs[0].name, "scratch");
    }

    #[test]
    fn ws_list_blocks_and_path_map_merge() {
        let out = concat!("Id: demo\n    \
                   workspace directory  : /lustre/scratch/data/alice-demo\n    \
                   remaining time       : 89 days 23 hours\n    \
                   creation time        : Mon Jul 21 10:00:00 2026\n    \
                   expiration date      : Sun Oct 19 10:00:00 2026\n    \
                   filesystem name      : scratch\n    \
                   available extensions : 3\n\
                   Id: fast\n    \
                   workspace directory  : /lustre/mlnvme/data/alice-fast\n    \
                   remaining time       : 5 days 1 hours\n    \
                   filesystem name      : mlnvme\n\
                   ---", crate::app_upper!(), "-WS-PATHS---\n\
                   demo\t/lustre/scratch/data/alice-demo\n\
                   fast\t/lustre/mlnvme/data/alice-fast\n");
        let ws = parse_ws_list(out);
        assert_eq!(ws.len(), 2);
        assert_eq!(ws[0].id, "demo");
        assert_eq!(ws[0].path, "/lustre/scratch/data/alice-demo");
        assert_eq!(ws[0].filesystem.as_deref(), Some("scratch"));
        assert_eq!(ws[0].remaining_days, Some(89));
        assert_eq!(ws[0].extensions, Some(3));
        assert_eq!(
            ws[0].expiration.as_deref(),
            Some("Sun Oct 19 10:00:00 2026")
        );
        assert_eq!(ws[1].id, "fast");
        assert_eq!(ws[1].remaining_days, Some(5));
    }

    #[test]
    fn ws_find_map_is_authoritative_and_adds_missed_workspaces() {
        // The listing's own path is stale/absent; the map states the truth, and a
        // workspace only in the map still shows up.
        let out = concat!("Id: demo\n    remaining time : 3 days\n\
                   ---", crate::app_upper!(), "-WS-PATHS---\n\
                   demo\t/lustre/scratch/data/alice-demo\n\
                   extra\t/lustre/scratch/data/alice-extra\n");
        let ws = parse_ws_list(out);
        assert_eq!(ws.len(), 2);
        assert_eq!(ws[0].path, "/lustre/scratch/data/alice-demo");
        assert_eq!(ws[0].remaining_days, Some(3));
        assert_eq!(ws[1].id, "extra");
        assert_eq!(ws[1].path, "/lustre/scratch/data/alice-extra");
    }

    #[test]
    fn ws_list_drops_pathless_entries() {
        // Without a path there is nothing the UI could do with the row.
        assert!(parse_ws_list("Id: demo\n    remaining time : 3 days\n").is_empty());
        assert!(parse_ws_list("").is_empty());
    }

    #[test]
    fn allocate_takes_the_ws_find_path_and_details() {
        let out = concat!("Info: creating workspace.\n\
                   /lustre/scratch/data/alice-demo\n\
                   remaining extensions  : 3\n\
                   remaining time in days: 90\n\
                   ---", crate::app_upper!(), "-WS-PATH---\n\
                   /lustre/scratch/data/alice-demo\n");
        let ws = parse_ws_allocate("demo", out).expect("path");
        assert_eq!(ws.id, "demo");
        assert_eq!(ws.path, "/lustre/scratch/data/alice-demo");
        assert_eq!(ws.extensions, Some(3));
        assert_eq!(ws.remaining_days, Some(90));
    }

    #[test]
    fn allocate_falls_back_to_the_tools_own_path_line() {
        let out = "Info: creating workspace.\n/lustre/scratch/data/alice-demo\n";
        let ws = parse_ws_allocate("demo", out).expect("path");
        assert_eq!(ws.path, "/lustre/scratch/data/alice-demo");
    }

    #[test]
    fn allocate_without_a_path_is_none() {
        assert!(parse_ws_allocate("demo", "Error: quota exceeded\n").is_none());
        assert!(parse_ws_allocate("demo", "").is_none());
    }

    #[test]
    fn tokens_reject_injection_and_flags() {
        assert!(validate_token("workspace name", "my-ws_1.2").is_ok());
        assert!(validate_token("workspace name", "a b").is_err());
        assert!(validate_token("workspace name", "x;rm -rf /").is_err());
        assert!(validate_token("workspace name", "../escape").is_err());
        assert!(validate_token("workspace name", "-F").is_err());
        assert!(validate_token("workspace name", "  ").is_err());
    }

    #[test]
    fn days_are_bounded() {
        assert!(validate_days("duration", 1).is_ok());
        assert!(validate_days("duration", 0).is_err());
        assert!(validate_days("duration", 4000).is_err());
    }

    #[test]
    fn mail_rejects_metacharacters() {
        assert!(validate_mail("a.user@example.org").is_ok());
        assert!(validate_mail("a user@example.org").is_err());
        assert!(validate_mail("a@b$(id)").is_err());
        assert!(validate_mail("nodomain").is_err());
    }

    #[test]
    fn abs_paths_only() {
        assert_eq!(
            validate_abs_path("workspace path", "/lustre/x/").unwrap(),
            "/lustre/x"
        );
        assert!(validate_abs_path("workspace path", "relative/x").is_err());
        assert!(validate_abs_path("workspace path", "").is_err());
    }

    #[test]
    fn fs_flag_is_quoted_or_empty() {
        assert_eq!(fs_flag(None).unwrap(), "");
        assert_eq!(fs_flag(Some("  ")).unwrap(), "");
        assert_eq!(fs_flag(Some("mlnvme")).unwrap(), " -F 'mlnvme'");
        assert!(fs_flag(Some("a;b")).is_err());
    }

    #[test]
    fn leading_days_parsing() {
        assert_eq!(leading_days("89 days 23 hours"), Some(89));
        assert_eq!(leading_days("0 days"), Some(0));
        assert_eq!(leading_days("expired"), None);
    }
}
