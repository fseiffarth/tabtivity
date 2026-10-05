//! The native print manager: which printers this machine can reach, what is
//! queued on them, and the few actions a queue is worth opening for.
//!
//! It replaces the `print_manager` *global app* slot — the button that launched
//! whatever external printer GUI the user had configured — for the reason the
//! mail/calendar/file-manager roles were retired before it: the thing behind the
//! button is a list and a handful of verbs, and Tabtivity can render a list.
//!
//! Two backends, picked by target OS, both **read-only by default**:
//!
//!  - **CUPS** (Linux, macOS): `lpstat`/`lpq` to read, `cancel`/`lpoptions`/
//!    `cupsenable`/`cupsdisable`/`lp` to act. Every read runs with `LC_ALL=C`,
//!    because these tools translate their output — "is idle" becomes "ist im
//!    Leerlauf" under a German locale and every parser here would go blind.
//!  - **Windows**: one PowerShell script per read, returning JSON.
//!
//! Three rules the whole module keeps:
//!
//!  1. **Nothing is spawned through a shell.** Names reach `Command` as argv
//!     entries, so a printer called `; rm -rf ~` is a printer with a silly name
//!     and not a command. The Windows path is the exception that proves it — a
//!     PowerShell script *is* a string — so every name interpolated there goes
//!     through [`ps_quote`] after [`check_printer_name`] has already refused the
//!     characters that make quoting interesting.
//!  2. **Every read is capped in time** ([`run_capped`]). `lpstat` talks to a
//!     CUPS server that may be a machine on the other end of a dead VPN, and it
//!     waits; a Tauri command that waits with it takes the window down with it.
//!     Hence the cap *and* `spawn_blocking`.
//!  3. **A missing print system is a state, not an error.** No `lpstat` on PATH
//!     (a container, a minimal install) resolves to `supported: false` plus a
//!     sentence, so the pane says what is wrong instead of rendering an empty
//!     table that reads as "no printers".

use std::collections::HashMap;
use std::process::Stdio;
use std::time::{Duration, Instant};

use serde::Serialize;

/// How long any single probe/action may take before it is killed. Generous
/// enough for a cold CUPS daemon, short enough that a wedged one is a message
/// on screen rather than a pane that never resolves.
const RUN_TIMEOUT: Duration = Duration::from_secs(8);

/// One printer as the pane renders it. Every string is best-effort: a field the
/// print system did not report stays empty and the row simply omits it, rather
/// than showing a placeholder that looks like a reading.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct PrinterInfo {
    pub name: String,
    pub description: String,
    pub location: String,
    /// `idle` | `printing` | `stopped` | `unknown` — a small closed set the
    /// frontend tones by; anything unrecognized degrades to `unknown`, never to
    /// a healthy-looking value.
    pub state: String,
    /// The reason line a stopped printer carries ("(paused)", "Out of paper").
    pub state_message: String,
    /// Whether the queue accepts new jobs. A printer can be *stopped* but still
    /// accepting (jobs pile up), which is exactly the state a user opens a print
    /// manager to discover, so the two are separate fields rather than one.
    pub accepting: bool,
    pub is_default: bool,
}

/// One queued job.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct PrintJob {
    /// The id the print system cancels by: `Printer-42` on CUPS, the plain
    /// number on Windows. Passed back verbatim to [`print_job_cancel`].
    pub id: String,
    /// The numeric part, used to join a CUPS job to its `lpq` title.
    pub number: u32,
    pub printer: String,
    pub user: String,
    /// The document name. CUPS does not report it in `lpstat -o` at all, so it
    /// is joined in from `lpq -a`; a job whose title could not be recovered
    /// shows its id instead of a blank row.
    pub title: String,
    pub size_bytes: u64,
    /// As reported, unparsed: CUPS prints a locale-formatted timestamp and
    /// re-deriving an epoch from it would be a second parser to get wrong.
    pub submitted: String,
    /// `printing` | `pending` | `held` | `unknown`.
    pub state: String,
    /// Pages the print system has passed on to the printer so far — not sheets
    /// out of it: once a page is sent the paper can lag behind. `None` when the
    /// print system does not say (see [`ipp_job_progress`]).
    pub pages_done: Option<u32>,
    /// The job's page count, when the print system knows it.
    pub pages_total: Option<u32>,
    /// Seconds since the job started printing, measured on the print server's
    /// own clock at both ends, so a skewed remote clock cannot bend it.
    pub printing_secs: Option<u64>,
}

/// One whole reading of the machine's print system — printers *and* jobs in a
/// single command, because they are polled together and two commands would make
/// the pane show a job on a printer it has not listed yet.
#[derive(Debug, Clone, Default, Serialize)]
pub struct PrintSnapshot {
    /// False when there is no usable print system here. The pane renders `note`
    /// instead of an empty table.
    pub supported: bool,
    /// `cups` | `windows` | `none`.
    pub backend: String,
    pub default_printer: Option<String>,
    pub printers: Vec<PrinterInfo>,
    pub jobs: Vec<PrintJob>,
    /// A sentence for the user when something is off (no tooling, a probe that
    /// timed out). Empty on a clean read.
    pub note: String,
}

// ── Process plumbing ─────────────────────────────────────────────────────────

/// Run `bin args…` with a hard time cap, returning `(ok, stdout, stderr)`.
///
/// Reads both pipes on their own threads for `tex.rs`'s reason: a child that
/// fills a pipe buffer while nobody reads deadlocks, which would make the cap
/// fire on a perfectly healthy machine with many printers. `LC_ALL=C`/`LANG=C`
/// are set on every call because the parsers below read English CUPS output.
fn run_capped(bin: &str, args: &[&str]) -> Result<(bool, String, String), String> {
    let mut child = crate::paths::command_no_window(bin)
        .args(args)
        .env("LC_ALL", "C")
        .env("LANG", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("{bin}: {e}"))?;

    let mut out_pipe = child.stdout.take();
    let mut err_pipe = child.stderr.take();
    let out_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(p) = out_pipe.as_mut() {
            let _ = std::io::Read::read_to_end(p, &mut buf);
        }
        buf
    });
    let err_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(p) = err_pipe.as_mut() {
            let _ = std::io::Read::read_to_end(p, &mut buf);
        }
        buf
    });

    let deadline = Instant::now() + RUN_TIMEOUT;
    let status = loop {
        match child.try_wait().map_err(|e| format!("{bin}: {e}"))? {
            Some(s) => break Some(s),
            None if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            None => std::thread::sleep(Duration::from_millis(40)),
        }
    };

    let stdout = String::from_utf8_lossy(&out_reader.join().unwrap_or_default()).into_owned();
    let stderr = String::from_utf8_lossy(&err_reader.join().unwrap_or_default()).into_owned();
    match status {
        Some(s) => Ok((s.success(), stdout, stderr)),
        None => Err(format!(
            "{bin} did not answer within {}s — the print server may be unreachable",
            RUN_TIMEOUT.as_secs()
        )),
    }
}

/// The message an action reports when the tool ran but refused. CUPS says what
/// it means on stderr ("Forbidden", "Operation was not allowed") and that text
/// is the one thing the user can act on, so it is passed through rather than
/// replaced with a generic failure.
fn action_error(bin: &str, ok: bool, out: String, err: String) -> Result<(), String> {
    if ok {
        return Ok(());
    }
    let msg = err.trim();
    let msg = if msg.is_empty() { out.trim() } else { msg };
    Err(if msg.is_empty() {
        format!("{bin} failed")
    } else {
        msg.to_string()
    })
}

/// Printer names come from the frontend, which got them from us — but a
/// destination can also be typed into the CUPS default field, and the Windows
/// backend interpolates the name into a *script*. So the shape is checked once,
/// here, before any of that: printable, no quotes/backticks/`$`/`;`/newlines,
/// bounded length. CUPS itself forbids space, `/` and `#` in a queue name;
/// Windows printer names routinely contain spaces, so space is allowed and the
/// stricter CUPS rule is left to CUPS.
fn check_printer_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > 128 {
        return Err("that is not a printer name".into());
    }
    let bad = |c: char| {
        c.is_control()
            || matches!(
                c,
                '\'' | '"' | '`' | '$' | ';' | '|' | '&' | '\\' | '<' | '>'
            )
    };
    if name.chars().any(bad) {
        return Err("that is not a printer name".into());
    }
    Ok(())
}

/// A CUPS job id (`Printer-42`) or a bare number, as handed back from a
/// snapshot. Same argument as [`check_printer_name`], same closed shape.
fn check_job_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 160 {
        return Err("that is not a job id".into());
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '@'))
    {
        return Err("that is not a job id".into());
    }
    Ok(())
}

// ── CUPS parsers (pure) ──────────────────────────────────────────────────────

/// Parse `lpstat -l -p` (English). Header lines look like
/// `printer Office is idle.  enabled since …`, followed by indented detail
/// lines; a stopped printer's header ends in `-` and carries its reason on the
/// next indented line.
pub fn parse_lpstat_printers(out: &str) -> Vec<PrinterInfo> {
    let mut printers: Vec<PrinterInfo> = Vec::new();
    // Set after a `disabled since … -` header: the next unlabelled indented
    // line is that printer's reason, not scenery.
    let mut expect_reason = false;

    for line in out.lines() {
        if let Some(rest) = line.strip_prefix("printer ") {
            expect_reason = false;
            let mut it = rest.splitn(2, ' ');
            let name = it.next().unwrap_or("").trim().to_string();
            if name.is_empty() {
                continue;
            }
            let tail = it.next().unwrap_or("");
            let lower = tail.to_ascii_lowercase();
            let state = if lower.contains("disabled") {
                "stopped"
            } else if lower.contains("printing") {
                "printing"
            } else if lower.contains("is idle") {
                "idle"
            } else {
                "unknown"
            };
            // `… since <date> -` means the reason follows on its own line.
            expect_reason = tail.trim_end().ends_with('-');
            printers.push(PrinterInfo {
                name,
                state: state.to_string(),
                // Absent an `lpstat -a` reading, assume the queue accepts —
                // that is the overwhelmingly common case and the accepting
                // pass overwrites it when it succeeds.
                accepting: true,
                ..Default::default()
            });
            continue;
        }
        if !line.starts_with([' ', '\t']) {
            expect_reason = false;
            continue;
        }
        let Some(current) = printers.last_mut() else {
            continue;
        };
        let body = line.trim();
        if body.is_empty() {
            continue;
        }
        if let Some(value) = body.strip_prefix("Description:") {
            current.description = value.trim().to_string();
        } else if let Some(value) = body.strip_prefix("Location:") {
            current.location = value.trim().to_string();
        } else if expect_reason {
            current.state_message = body.to_string();
            expect_reason = false;
        }
    }
    printers
}

/// Parse `lpstat -d`: `system default destination: Office`, or a line saying
/// there is none.
pub fn parse_lpstat_default(out: &str) -> Option<String> {
    out.lines()
        .find_map(|line| line.split_once("destination:"))
        .map(|(_, name)| name.trim().to_string())
        .filter(|name| !name.is_empty())
}

/// Parse `lpstat -a`: `Office accepting requests since …` /
/// `Office not accepting requests since …`.
pub fn parse_lpstat_accepting(out: &str) -> HashMap<String, bool> {
    let mut map = HashMap::new();
    for line in out.lines() {
        let Some((name, rest)) = line.trim_end().split_once(' ') else {
            continue;
        };
        if !rest.contains("accepting requests") {
            continue;
        }
        map.insert(name.to_string(), !rest.trim_start().starts_with("not "));
    }
    map
}

/// Parse `lpstat -o`:
/// `Office-42   alice     14336   Mon 28 Jul 2026 09:12:00 AM CEST`.
///
/// Split on whitespace for the first three fields only — the timestamp contains
/// spaces and is kept whole, because re-formatting a locale-formatted date is a
/// second thing to get wrong for no gain.
pub fn parse_lpstat_jobs(out: &str) -> Vec<PrintJob> {
    let mut jobs = Vec::new();
    for line in out.lines() {
        if line.starts_with([' ', '\t']) || line.trim().is_empty() {
            continue;
        }
        let mut it = line.split_whitespace();
        let (Some(id), Some(user), Some(size)) = (it.next(), it.next(), it.next()) else {
            continue;
        };
        let Ok(size_bytes) = size.parse::<u64>() else {
            continue; // Not a job line (a heading, an error message).
        };
        let (printer, number) = split_cups_job_id(id);
        jobs.push(PrintJob {
            id: id.to_string(),
            number,
            printer,
            user: user.to_string(),
            title: String::new(),
            size_bytes,
            submitted: it.collect::<Vec<_>>().join(" "),
            state: "pending".to_string(),
            ..Default::default()
        });
    }
    jobs
}

/// `Office-42` → (`Office`, 42). A printer name may itself contain `-`, so the
/// split is on the LAST one, and only when what follows is a number.
fn split_cups_job_id(id: &str) -> (String, u32) {
    match id.rsplit_once('-') {
        Some((printer, num)) => match num.parse::<u32>() {
            Ok(n) => (printer.to_string(), n),
            Err(_) => (id.to_string(), 0),
        },
        None => (id.to_string(), 0),
    }
}

/// What `lpq -a` adds that `lpstat -o` cannot: the document name, and whether a
/// job is the active one. Returns job number → (title, state).
///
/// The file column can contain spaces, so the line is parsed from BOTH ends:
/// rank/owner/job from the left, `<n> bytes` from the right, and everything
/// between is the document name.
pub fn parse_lpq_titles(out: &str) -> HashMap<u32, (String, String)> {
    let mut map = HashMap::new();
    for line in out.lines() {
        let line = line.trim_end();
        if line.trim().is_empty() || line.starts_with("Rank") {
            continue;
        }
        let mut it = line.split_whitespace();
        let (Some(rank), Some(_owner), Some(job)) = (it.next(), it.next(), it.next()) else {
            continue;
        };
        let Ok(number) = job.parse::<u32>() else {
            continue; // A status line ("Office is ready and printing").
        };
        // Strip the trailing "<size> bytes" to leave the file column.
        let rest: Vec<&str> = it.collect();
        let title = match rest.split_last() {
            Some((last, head)) if last.eq_ignore_ascii_case("bytes") => match head.split_last() {
                Some((_size, name)) => name.join(" "),
                None => String::new(),
            },
            _ => rest.join(" "),
        };
        let state = match rank.to_ascii_lowercase().as_str() {
            "active" => "printing",
            "hold" | "held" => "held",
            _ => "pending",
        };
        map.insert(number, (title, state.to_string()));
    }
    map
}

/// Join the two CUPS readings: titles and the active/held state come from
/// `lpq`, everything else from `lpstat`. A job `lpq` never mentioned keeps its
/// id as a title, so no row is blank.
#[cfg(any(not(target_os = "windows"), test))]
fn merge_cups_jobs(
    mut jobs: Vec<PrintJob>,
    titles: &HashMap<u32, (String, String)>,
) -> Vec<PrintJob> {
    for job in &mut jobs {
        if let Some((title, state)) = titles.get(&job.number) {
            if !title.is_empty() {
                job.title = title.clone();
            }
            job.state = state.clone();
        }
        if job.title.is_empty() {
            job.title = job.id.clone();
        }
    }
    jobs
}

// ── CUPS job progress over IPP ───────────────────────────────────────────────
//
// `lpstat` and `lpq` print no page counts at all. CUPS keeps them on the job —
// `job-impressions-completed` advances as the filter chain passes each page on —
// and answers for them only over IPP. So one `Get-Jobs` request goes to the same
// server `lpstat` talks to, and everything it adds is optional: a failed read (a
// remote server, encryption required, an old CUPS) leaves those fields `None`
// and the rest of the snapshot as it was.
//
// It is HTTP spoken by hand: IPP's wire format is a flat run of tag–length–value
// records, and three integers do not justify a client dependency.

/// Where the CUPS client library would connect.
#[cfg_attr(target_os = "windows", allow(dead_code))]
#[derive(Debug, Clone, PartialEq)]
pub enum CupsServer {
    Socket(std::path::PathBuf),
    /// `host:port`, plus the bare host for the `Host` header.
    Tcp { addr: String, host: String },
}

/// The page counters one IPP job record carries.
#[cfg_attr(target_os = "windows", allow(dead_code))]
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct JobProgress {
    pub pages_done: Option<u32>,
    pub pages_total: Option<u32>,
    pub printing_secs: Option<u64>,
}

/// The attributes asked for. `job-printer-up-time` is the server's "now", on the
/// same clock as `time-at-processing`.
#[cfg_attr(target_os = "windows", allow(dead_code))]
const IPP_JOB_ATTRS: [&str; 6] = [
    "job-id",
    "job-impressions",
    "job-impressions-completed",
    "job-media-sheets-completed",
    "time-at-processing",
    "job-printer-up-time",
];

/// Connect + whole exchange. Shorter than [`RUN_TIMEOUT`]: this rides on a
/// snapshot that has already spent its time on `lpstat`, and it is only extra.
#[cfg_attr(target_os = "windows", allow(dead_code))]
const IPP_TIMEOUT: Duration = Duration::from_secs(2);
#[cfg_attr(target_os = "windows", allow(dead_code))]
const IPP_MAX_RESPONSE: usize = 4 << 20;

/// The `ServerName` a `client.conf` names, if any.
#[cfg_attr(target_os = "windows", allow(dead_code))]
pub fn client_conf_server_name(text: &str) -> Option<String> {
    text.lines().find_map(|line| {
        let mut it = line.split_whitespace();
        match (it.next(), it.next()) {
            (Some(key), Some(value)) if key.eq_ignore_ascii_case("ServerName") => {
                Some(value.to_string())
            }
            _ => None,
        }
    })
}

/// A `CUPS_SERVER` / `ServerName` value: a socket path or `host[:port]`, either
/// possibly suffixed with `/version=1.1`.
#[cfg_attr(target_os = "windows", allow(dead_code))]
pub fn parse_cups_server(value: &str) -> Option<CupsServer> {
    let value = value.trim();
    let value = match value.find("/version=") {
        Some(i) if i > 0 => &value[..i],
        _ => value,
    };
    if value.is_empty() {
        return None;
    }
    if value.starts_with('/') {
        return Some(CupsServer::Socket(value.into()));
    }
    let (host, port) = if let Some(rest) = value.strip_prefix('[') {
        let (inner, tail) = rest.split_once(']')?;
        (format!("[{inner}]"), tail.strip_prefix(':').unwrap_or("631"))
    } else {
        match value.rsplit_once(':') {
            Some((h, p)) if !h.contains(':') => (h.to_string(), p),
            Some(_) => return None, // an unbracketed IPv6 address
            None => (value.to_string(), "631"),
        }
    };
    let port: u16 = port.parse().ok()?;
    Some(CupsServer::Tcp {
        addr: format!("{host}:{port}"),
        host,
    })
}

/// Whether reaching `server` costs nothing that can hang: the socket, or a
/// loopback address. A named remote host is skipped rather than resolved —
/// name resolution has no timeout to give it, and a print server behind a dead
/// VPN would stall every poll on it for the sake of a page count.
#[cfg_attr(target_os = "windows", allow(dead_code))]
pub fn cups_server_is_local(server: &CupsServer) -> bool {
    match server {
        CupsServer::Socket(_) => true,
        CupsServer::Tcp { host, .. } => {
            host.eq_ignore_ascii_case("localhost")
                || host
                    .trim_start_matches('[')
                    .trim_end_matches(']')
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|ip| ip.is_loopback())
        }
    }
}

/// An IPP/2.0 `Get-Jobs` request for the not-completed jobs of every queue.
#[cfg_attr(target_os = "windows", allow(dead_code))]
pub fn ipp_get_jobs_request(user: &str) -> Vec<u8> {
    fn attr(buf: &mut Vec<u8>, tag: u8, name: &str, value: &[u8]) {
        buf.push(tag);
        buf.extend((name.len() as u16).to_be_bytes());
        buf.extend(name.as_bytes());
        buf.extend((value.len() as u16).to_be_bytes());
        buf.extend(value);
    }
    // version 2.0, operation Get-Jobs (0x000A), request-id 1, operation group.
    let mut buf = vec![0x02, 0x00, 0x00, 0x0A, 0, 0, 0, 1, 0x01];
    attr(&mut buf, 0x47, "attributes-charset", b"utf-8");
    attr(&mut buf, 0x48, "attributes-natural-language", b"en");
    attr(&mut buf, 0x45, "printer-uri", b"ipp://localhost/");
    attr(&mut buf, 0x42, "requesting-user-name", user.as_bytes());
    for (i, name) in IPP_JOB_ATTRS.iter().enumerate() {
        // Additional values of a 1setOf carry an empty name.
        let key = if i == 0 { "requested-attributes" } else { "" };
        attr(&mut buf, 0x44, key, name.as_bytes());
    }
    buf.push(0x03);
    buf
}

/// The IPP body of a raw HTTP response: `None` unless the status is 200, with a
/// chunked body put back together.
#[cfg_attr(target_os = "windows", allow(dead_code))]
pub fn http_ipp_body(raw: &[u8]) -> Option<Vec<u8>> {
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n")?;
    let head = std::str::from_utf8(&raw[..split]).ok()?;
    let body = &raw[split + 4..];
    let mut lines = head.split("\r\n");
    if lines.next()?.split_whitespace().nth(1) != Some("200") {
        return None;
    }
    let chunked = lines.any(|line| {
        let line = line.to_ascii_lowercase();
        line.starts_with("transfer-encoding:") && line.contains("chunked")
    });
    if !chunked {
        return Some(body.to_vec());
    }
    let mut out = Vec::new();
    let mut rest = body;
    loop {
        let eol = rest.windows(2).position(|w| w == b"\r\n")?;
        let size_line = std::str::from_utf8(&rest[..eol]).ok()?;
        let size = usize::from_str_radix(size_line.split(';').next()?.trim(), 16).ok()?;
        rest = &rest[eol + 2..];
        if size == 0 {
            return Some(out);
        }
        out.extend_from_slice(rest.get(..size)?);
        rest = rest.get(size + 2..)?;
    }
}

#[cfg_attr(target_os = "windows", allow(dead_code))]
#[derive(Default)]
struct RawIppJob {
    id: Option<u32>,
    total: Option<i32>,
    impressions: Option<i32>,
    sheets: Option<i32>,
    processing: Option<i32>,
    up: Option<i32>,
}

#[cfg_attr(target_os = "windows", allow(dead_code))]
fn finish_ipp_job(raw: RawIppJob, out: &mut HashMap<u32, JobProgress>) {
    let Some(id) = raw.id else { return };
    let count = |v: Option<i32>| v.and_then(|n| u32::try_from(n).ok());
    out.insert(
        id,
        JobProgress {
            pages_done: count(raw.impressions.or(raw.sheets)),
            // CUPS reports 0 for "not counted yet", which is not a page count.
            pages_total: count(raw.total).filter(|&n| n > 0),
            printing_secs: match (raw.processing, raw.up) {
                (Some(start), Some(now)) if start > 0 && now >= start => {
                    Some(u64::from((now - start).unsigned_abs()))
                }
                _ => None,
            },
        },
    );
}

/// Job id → page counters, from a `Get-Jobs` response body. An error status or
/// a damaged record yields what was read before the damage and nothing
/// invented after it; an out-of-band value (`no-value` for a job not yet
/// processing) simply leaves its field unset.
#[cfg_attr(target_os = "windows", allow(dead_code))]
pub fn parse_ipp_job_progress(body: &[u8]) -> HashMap<u32, JobProgress> {
    let mut out = HashMap::new();
    // Any status from 0x0100 up is an error (client-error-*, server-error-*).
    if body.len() < 8 || u16::from_be_bytes([body[2], body[3]]) >= 0x0100 {
        return out;
    }
    let read_len = |at: usize| {
        body.get(at..at + 2)
            .map(|b| usize::from(u16::from_be_bytes([b[0], b[1]])))
    };
    let mut job: Option<RawIppJob> = None;
    let mut pos = 8;
    while pos < body.len() {
        let tag = body[pos];
        if tag <= 0x0F {
            // A group delimiter: 0x02 opens a job, 0x03 ends the message.
            pos += 1;
            if let Some(raw) = job.take() {
                finish_ipp_job(raw, &mut out);
            }
            match tag {
                0x03 => break,
                0x02 => job = Some(RawIppJob::default()),
                _ => {}
            }
            continue;
        }
        let Some(name_len) = read_len(pos + 1) else { break };
        let name_at = pos + 3;
        let Some(name) = body.get(name_at..name_at + name_len) else { break };
        let Some(value_len) = read_len(name_at + name_len) else { break };
        let value_at = name_at + name_len + 2;
        let Some(value) = body.get(value_at..value_at + value_len) else { break };
        pos = value_at + value_len;
        // integer (0x21) and enum (0x23) are the only shapes read here.
        let (Some(raw), 0x21 | 0x23, [a, b, c, d]) = (job.as_mut(), tag, value) else {
            continue;
        };
        let n = i32::from_be_bytes([*a, *b, *c, *d]);
        match name {
            b"job-id" => raw.id = u32::try_from(n).ok(),
            b"job-impressions" => raw.total = Some(n),
            b"job-impressions-completed" => raw.impressions = Some(n),
            b"job-media-sheets-completed" => raw.sheets = Some(n),
            b"time-at-processing" => raw.processing = Some(n),
            b"job-printer-up-time" => raw.up = Some(n),
            _ => {}
        }
    }
    if let Some(raw) = job.take() {
        finish_ipp_job(raw, &mut out);
    }
    out
}

/// The server the CUPS client library would pick, in its own precedence:
/// `CUPS_SERVER`, `~/.cups/client.conf`, `/etc/cups/client.conf`, then the
/// local socket, then `localhost:631`.
#[cfg(not(target_os = "windows"))]
fn cups_server() -> Option<CupsServer> {
    if let Ok(value) = std::env::var("CUPS_SERVER") {
        if !value.trim().is_empty() {
            return parse_cups_server(&value);
        }
    }
    let user_conf = std::env::var_os("HOME")
        .map(|home| std::path::Path::new(&home).join(".cups/client.conf"));
    for conf in user_conf
        .into_iter()
        .chain([std::path::PathBuf::from("/etc/cups/client.conf")])
    {
        if let Some(name) = std::fs::read_to_string(&conf)
            .ok()
            .and_then(|text| client_conf_server_name(&text))
        {
            return parse_cups_server(&name);
        }
    }
    for sock in ["/run/cups/cups.sock", "/var/run/cups/cups.sock", "/private/var/run/cupsd"] {
        if std::path::Path::new(sock).exists() {
            return Some(CupsServer::Socket(sock.into()));
        }
    }
    Some(CupsServer::Tcp {
        addr: "localhost:631".into(),
        host: "localhost".into(),
    })
}

/// Page counters for every not-completed job, keyed by CUPS job number. Empty
/// whenever they cannot be had cheaply — see [`cups_server_is_local`].
#[cfg(not(target_os = "windows"))]
fn ipp_job_progress() -> HashMap<u32, JobProgress> {
    use std::io::{Read, Write};

    fn exchange<S: Read + Write>(mut stream: S, request: &[u8]) -> Option<Vec<u8>> {
        stream.write_all(request).ok()?;
        let deadline = Instant::now() + IPP_TIMEOUT;
        let mut raw = Vec::new();
        let mut chunk = [0u8; 8192];
        loop {
            if Instant::now() >= deadline || raw.len() > IPP_MAX_RESPONSE {
                return None;
            }
            match stream.read(&mut chunk) {
                Ok(0) => return Some(raw),
                Ok(n) => raw.extend_from_slice(&chunk[..n]),
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                Err(_) => return None,
            }
        }
    }

    let Some(server) = cups_server().filter(cups_server_is_local) else {
        return HashMap::new();
    };
    let user = std::env::var("USER")
        .or_else(|_| std::env::var("LOGNAME"))
        .ok()
        .filter(|u| !u.is_empty() && u.len() <= 255 && !u.contains(['\r', '\n']))
        .unwrap_or_else(|| crate::app_slug!().into());
    let body = ipp_get_jobs_request(&user);
    let host = match &server {
        CupsServer::Socket(_) => "localhost",
        CupsServer::Tcp { host, .. } => host.as_str(),
    };
    let mut request = format!(
        "POST / HTTP/1.1\r\nHost: {host}\r\nContent-Type: application/ipp\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )
    .into_bytes();
    request.extend_from_slice(&body);

    let raw = match &server {
        CupsServer::Socket(path) => std::os::unix::net::UnixStream::connect(path)
            .ok()
            .and_then(|stream| {
                stream.set_read_timeout(Some(IPP_TIMEOUT)).ok()?;
                stream.set_write_timeout(Some(IPP_TIMEOUT)).ok()?;
                exchange(stream, &request)
            }),
        CupsServer::Tcp { addr, .. } => {
            use std::net::ToSocketAddrs;
            addr.to_socket_addrs()
                .ok()
                .and_then(|mut addrs| addrs.next())
                .and_then(|sa| std::net::TcpStream::connect_timeout(&sa, IPP_TIMEOUT).ok())
                .and_then(|stream| {
                    stream.set_read_timeout(Some(IPP_TIMEOUT)).ok()?;
                    stream.set_write_timeout(Some(IPP_TIMEOUT)).ok()?;
                    exchange(stream, &request)
                })
        }
    };
    raw.and_then(|raw| http_ipp_body(&raw))
        .map(|body| parse_ipp_job_progress(&body))
        .unwrap_or_default()
}

// ── CUPS backend ─────────────────────────────────────────────────────────────

#[cfg(not(target_os = "windows"))]
fn snapshot_impl() -> PrintSnapshot {
    if !crate::paths::binary_on_path("lpstat") {
        return PrintSnapshot {
            supported: false,
            backend: "none".into(),
            note: "no CUPS tooling found on this machine (lpstat is not on PATH)".into(),
            ..Default::default()
        };
    }

    let mut note = String::new();
    let mut printers = match run_capped("lpstat", &["-l", "-p"]) {
        // `lpstat -p` exits non-zero when there are simply no printers, so the
        // exit status is deliberately not consulted — the output is.
        Ok((_, out, err)) => {
            if out.trim().is_empty() && !err.trim().is_empty() {
                note = err.trim().to_string();
            }
            parse_lpstat_printers(&out)
        }
        Err(e) => {
            return PrintSnapshot {
                supported: true,
                backend: "cups".into(),
                note: e,
                ..Default::default()
            }
        }
    };

    let default_printer = run_capped("lpstat", &["-d"])
        .ok()
        .and_then(|(_, out, _)| parse_lpstat_default(&out));
    if let Some(name) = default_printer.as_deref() {
        for p in &mut printers {
            p.is_default = p.name == name;
        }
    }

    if let Ok((_, out, _)) = run_capped("lpstat", &["-a"]) {
        let accepting = parse_lpstat_accepting(&out);
        for p in &mut printers {
            if let Some(&ok) = accepting.get(&p.name) {
                p.accepting = ok;
            }
        }
    }

    let mut jobs = match run_capped("lpstat", &["-o"]) {
        Ok((_, out, _)) => {
            let titles = run_capped("lpq", &["-a"])
                .map(|(_, lpq, _)| parse_lpq_titles(&lpq))
                .unwrap_or_default();
            merge_cups_jobs(parse_lpstat_jobs(&out), &titles)
        }
        Err(e) => {
            note = e;
            Vec::new()
        }
    };

    // Page counts are one extra read, only worth making with something queued.
    if !jobs.is_empty() {
        let progress = ipp_job_progress();
        for job in &mut jobs {
            if let Some(p) = progress.get(&job.number) {
                job.pages_done = p.pages_done;
                job.pages_total = p.pages_total;
                job.printing_secs = p.printing_secs;
            }
        }
    }

    PrintSnapshot {
        supported: true,
        backend: "cups".into(),
        default_printer,
        printers,
        jobs,
        note,
    }
}

#[cfg(not(target_os = "windows"))]
fn cancel_job_impl(_printer: &str, job_id: &str) -> Result<(), String> {
    check_job_id(job_id)?;
    let (ok, out, err) = run_capped("cancel", &[job_id])?;
    action_error("cancel", ok, out, err)
}

#[cfg(not(target_os = "windows"))]
fn cancel_all_impl(printer: &str) -> Result<(), String> {
    check_printer_name(printer)?;
    let (ok, out, err) = run_capped("cancel", &["-a", printer])?;
    action_error("cancel", ok, out, err)
}

#[cfg(not(target_os = "windows"))]
fn set_default_impl(printer: &str) -> Result<(), String> {
    check_printer_name(printer)?;
    // `lpoptions -d` sets the *user's* default (~/.cups/lpoptions), which needs
    // no admin rights — deliberately not `lpadmin -d`, which sets it for the
    // whole machine and would ask for a password Tabtivity has no business asking.
    let (ok, out, err) = run_capped("lpoptions", &["-d", printer])?;
    action_error("lpoptions", ok, out, err)
}

#[cfg(not(target_os = "windows"))]
fn set_enabled_impl(printer: &str, enabled: bool) -> Result<(), String> {
    check_printer_name(printer)?;
    let bin = if enabled { "cupsenable" } else { "cupsdisable" };
    let (ok, out, err) = run_capped(bin, &[printer])?;
    action_error(bin, ok, out, err)
}

#[cfg(not(target_os = "windows"))]
fn print_file_impl(printer: &str, path: &str, title: &str) -> Result<(), String> {
    check_printer_name(printer)?;
    let (ok, out, err) = run_capped("lp", &["-d", printer, "-t", title, path])?;
    action_error("lp", ok, out, err)
}

// ── Windows backend ──────────────────────────────────────────────────────────

/// Single-quote a value for a PowerShell literal string. [`check_printer_name`]
/// has already refused `'` (and everything else that makes quoting delicate), so
/// this is the second of two gates, not the only one.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn ps_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// Run a PowerShell script and hand back stdout. `-NoProfile` so a user profile
/// can neither slow the probe down nor print into the JSON we are about to
/// parse.
#[cfg(target_os = "windows")]
fn run_powershell(script: &str) -> Result<(bool, String, String), String> {
    run_capped(
        "powershell",
        &[
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ],
    )
}

/// `Get-Printer`'s `PrinterStatus` / `Get-PrintJob`'s `JobStatus` are flag
/// enums serialized as text; map the ones that mean something to the same closed
/// set the CUPS side produces, and let everything else be `unknown`.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn windows_printer_state(status: &str) -> &'static str {
    let s = status.to_ascii_lowercase();
    if s.contains("error") || s.contains("offline") || s.contains("paused") {
        "stopped"
    } else if s.contains("printing") || s.contains("processing") {
        "printing"
    } else if s.contains("normal") || s.contains("idle") {
        "idle"
    } else {
        "unknown"
    }
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn windows_job_state(status: &str) -> &'static str {
    let s = status.to_ascii_lowercase();
    if s.contains("paused") {
        "held"
    } else if s.contains("printing") || s.contains("spooling") {
        "printing"
    } else if s.is_empty() {
        "unknown"
    } else {
        "pending"
    }
}

/// PowerShell's `ConvertTo-Json` collapses a one-element array into a bare
/// object, so every list is read through this rather than as an array.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn json_rows(value: Option<&serde_json::Value>) -> Vec<serde_json::Value> {
    match value {
        Some(serde_json::Value::Array(items)) => items.clone(),
        Some(serde_json::Value::Object(_)) => vec![value.cloned().unwrap_or_default()],
        _ => Vec::new(),
    }
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn json_str(row: &serde_json::Value, key: &str) -> String {
    row.get(key)
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .trim()
        .to_string()
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn json_u32(row: &serde_json::Value, key: &str) -> Option<u32> {
    row.get(key)
        .and_then(|v| v.as_u64())
        .and_then(|n| u32::try_from(n).ok())
}

/// Parse the one JSON document the Windows probe returns. Kept separate from
/// the spawn so it is testable on any OS — Windows is CI-verified only here, so
/// the shape must at least be pinned by a test that runs everywhere.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn parse_windows_snapshot(json: &str) -> Result<PrintSnapshot, String> {
    let root: serde_json::Value =
        serde_json::from_str(json.trim()).map_err(|e| format!("print system: {e}"))?;
    let default_printer = root
        .get("default")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let printers = json_rows(root.get("printers"))
        .iter()
        .map(|row| {
            let name = json_str(row, "Name");
            PrinterInfo {
                is_default: default_printer.as_deref() == Some(name.as_str()),
                state: windows_printer_state(&json_str(row, "PrinterStatus")).to_string(),
                description: json_str(row, "Comment"),
                location: json_str(row, "Location"),
                state_message: String::new(),
                // Windows has no "not accepting" queue state of its own; a
                // paused printer is reported through PrinterStatus above.
                accepting: true,
                name,
            }
        })
        .filter(|p| !p.name.is_empty())
        .collect();

    let jobs = json_rows(root.get("jobs"))
        .iter()
        .map(|row| {
            let number = row.get("Id").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            let title = json_str(row, "DocumentName");
            PrintJob {
                id: number.to_string(),
                number,
                printer: json_str(row, "PrinterName"),
                user: json_str(row, "UserName"),
                size_bytes: row.get("Size").and_then(|v| v.as_u64()).unwrap_or(0),
                submitted: json_str(row, "SubmittedTime"),
                state: windows_job_state(&json_str(row, "JobStatus")).to_string(),
                pages_done: json_u32(row, "PagesPrinted"),
                // The spooler reports 0 for a page count it does not know yet.
                pages_total: json_u32(row, "TotalPages").filter(|&n| n > 0),
                printing_secs: None,
                title: if title.is_empty() {
                    number.to_string()
                } else {
                    title
                },
            }
        })
        .collect();

    Ok(PrintSnapshot {
        supported: true,
        backend: "windows".into(),
        default_printer,
        printers,
        jobs,
        note: String::new(),
    })
}

#[cfg(target_os = "windows")]
const WINDOWS_SNAPSHOT_SCRIPT: &str = "\
$ErrorActionPreference='SilentlyContinue';\
$p=@(Get-Printer | Select-Object Name,Comment,Location,PrinterStatus);\
$j=@(Get-Printer | Get-PrintJob | Select-Object Id,PrinterName,UserName,DocumentName,JobStatus,Size,SubmittedTime,PagesPrinted,TotalPages);\
$d=(Get-CimInstance Win32_Printer -Filter 'Default=True' | Select-Object -First 1).Name;\
[pscustomobject]@{printers=$p;jobs=$j;default=$d} | ConvertTo-Json -Depth 4 -Compress";

#[cfg(target_os = "windows")]
fn snapshot_impl() -> PrintSnapshot {
    match run_powershell(WINDOWS_SNAPSHOT_SCRIPT) {
        Ok((_, out, err)) if !out.trim().is_empty() => match parse_windows_snapshot(&out) {
            Ok(snap) => snap,
            Err(e) => PrintSnapshot {
                supported: true,
                backend: "windows".into(),
                note: if err.trim().is_empty() {
                    e
                } else {
                    err.trim().into()
                },
                ..Default::default()
            },
        },
        Ok((_, _, err)) => PrintSnapshot {
            supported: false,
            backend: "none".into(),
            note: if err.trim().is_empty() {
                "the Windows print spooler reported nothing".into()
            } else {
                err.trim().to_string()
            },
            ..Default::default()
        },
        Err(e) => PrintSnapshot {
            supported: false,
            backend: "none".into(),
            note: e,
            ..Default::default()
        },
    }
}

#[cfg(target_os = "windows")]
fn cancel_job_impl(printer: &str, job_id: &str) -> Result<(), String> {
    check_printer_name(printer)?;
    check_job_id(job_id)?;
    let script = format!(
        "Remove-PrintJob -PrinterName {} -ID {}",
        ps_quote(printer),
        ps_quote(job_id)
    );
    let (ok, out, err) = run_powershell(&script)?;
    action_error("Remove-PrintJob", ok, out, err)
}

#[cfg(target_os = "windows")]
fn cancel_all_impl(printer: &str) -> Result<(), String> {
    check_printer_name(printer)?;
    let script = format!(
        "Get-PrintJob -PrinterName {0} | Remove-PrintJob",
        ps_quote(printer)
    );
    let (ok, out, err) = run_powershell(&script)?;
    action_error("Remove-PrintJob", ok, out, err)
}

#[cfg(target_os = "windows")]
fn set_default_impl(printer: &str) -> Result<(), String> {
    check_printer_name(printer)?;
    let script = format!(
        "$p=Get-CimInstance Win32_Printer -Filter (\"Name='\" + {0}.Replace(\"'\",\"''\") + \"'\"); \
         Invoke-CimMethod -InputObject $p -MethodName SetDefaultPrinter",
        ps_quote(printer)
    );
    let (ok, out, err) = run_powershell(&script)?;
    action_error("SetDefaultPrinter", ok, out, err)
}

#[cfg(target_os = "windows")]
fn set_enabled_impl(printer: &str, enabled: bool) -> Result<(), String> {
    check_printer_name(printer)?;
    let method = if enabled { "Resume" } else { "Pause" };
    let script = format!(
        "$p=Get-CimInstance Win32_Printer -Filter (\"Name='\" + {0}.Replace(\"'\",\"''\") + \"'\"); \
         Invoke-CimMethod -InputObject $p -MethodName {1}",
        ps_quote(printer),
        method
    );
    let (ok, out, err) = run_powershell(&script)?;
    action_error(method, ok, out, err)
}

#[cfg(target_os = "windows")]
fn print_file_impl(printer: &str, path: &str, _title: &str) -> Result<(), String> {
    check_printer_name(printer)?;
    let script = format!(
        "Get-Content -LiteralPath {0} | Out-Printer -Name {1}",
        ps_quote(path),
        ps_quote(printer)
    );
    let (ok, out, err) = run_powershell(&script)?;
    action_error("Out-Printer", ok, out, err)
}

// ── Tauri surface ────────────────────────────────────────────────────────────

/// One reading of the machine's print system. Async + `spawn_blocking`: every
/// probe below shells out, and a synchronous command would run the whole thing
/// on the main thread — which is how a printer behind a dead VPN freezes the
/// window rather than showing a message in a pane.
#[tauri::command]
pub async fn print_system_snapshot() -> PrintSnapshot {
    tauri::async_runtime::spawn_blocking(snapshot_impl)
        .await
        .unwrap_or_else(|e| PrintSnapshot {
            supported: false,
            backend: "none".into(),
            note: format!("the print system probe did not finish: {e}"),
            ..Default::default()
        })
}

/// Cancel one job. `printer` is only read by the Windows backend (its API needs
/// the queue as well as the id); CUPS cancels by id alone.
#[tauri::command]
pub async fn print_job_cancel(printer: String, job_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || cancel_job_impl(&printer, &job_id))
        .await
        .map_err(|e| e.to_string())?
}

/// Cancel everything queued on one printer.
#[tauri::command]
pub async fn print_jobs_cancel_all(printer: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || cancel_all_impl(&printer))
        .await
        .map_err(|e| e.to_string())?
}

/// Make `printer` the default. On CUPS this is the *user's* default and needs no
/// elevation; on Windows it is the per-user default too.
#[tauri::command]
pub async fn print_set_default(printer: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || set_default_impl(&printer))
        .await
        .map_err(|e| e.to_string())?
}

/// Resume (`true`) or pause (`false`) a printer's queue. This is the one action
/// here that commonly needs rights the user may not have — CUPS answers
/// "Forbidden" for a user outside `lpadmin` — so the error text is passed
/// through verbatim for the pane to show.
#[tauri::command]
pub async fn print_set_enabled(printer: String, enabled: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || set_enabled_impl(&printer, enabled))
        .await
        .map_err(|e| e.to_string())?
}

/// Send a small text page to `printer`, so "is this thing actually connected?"
/// has an answer that does not involve finding a document first.
///
/// The page is written by Tabtivity into the OS temp dir rather than taken from a
/// path the frontend supplies: the print manager deliberately has no
/// print-this-file command at all, so no caller can turn it into one.
#[tauri::command]
pub async fn print_test_page(printer: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        check_printer_name(&printer)?;
        let body = format!(
            "{app} print test\n\n\
             Printer: {printer}\n\
             If you are reading this on paper, the queue works.\n", app = crate::brand::DISPLAY
        );
        let path = std::env::temp_dir().join(concat!(crate::app_slug!(), "-print-test.txt"));
        std::fs::write(&path, body).map_err(|e| format!("test page: {e}"))?;
        let path_str = path.to_string_lossy().into_owned();
        print_file_impl(&printer, &path_str, concat!(crate::app_name!(), " print test"))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    const LPSTAT_P: &str = "\
printer Office_Laser is idle.  enabled since Mon 28 Jul 2026 09:12:00 AM CEST
\tDescription: Office laser, 2nd floor
\tLocation: Room 2.14
\tConnection: direct
printer Old_Inkjet disabled since Mon 28 Jul 2026 08:00:00 AM CEST -
\t(paused by the administrator)
\tDescription: Ancient inkjet
printer Lab-Plotter now printing Lab-Plotter-7.  enabled since Mon 28 Jul 2026 09:30:00 AM CEST
";

    #[test]
    fn lpstat_printers_reads_state_description_and_reason() {
        let printers = parse_lpstat_printers(LPSTAT_P);
        assert_eq!(printers.len(), 3);

        assert_eq!(printers[0].name, "Office_Laser");
        assert_eq!(printers[0].state, "idle");
        assert_eq!(printers[0].description, "Office laser, 2nd floor");
        assert_eq!(printers[0].location, "Room 2.14");
        assert_eq!(printers[0].state_message, "");

        assert_eq!(printers[1].name, "Old_Inkjet");
        assert_eq!(printers[1].state, "stopped");
        // The reason line belongs to the printer whose header ended in `-` …
        assert_eq!(printers[1].state_message, "(paused by the administrator)");
        // … and a labelled line after it is still read as a field.
        assert_eq!(printers[1].description, "Ancient inkjet");

        assert_eq!(printers[2].name, "Lab-Plotter");
        assert_eq!(printers[2].state, "printing");
    }

    #[test]
    fn lpstat_default_is_optional() {
        assert_eq!(
            parse_lpstat_default("system default destination: Office_Laser\n").as_deref(),
            Some("Office_Laser")
        );
        assert_eq!(
            parse_lpstat_default("no system default destination\n"),
            None
        );
        assert_eq!(parse_lpstat_default(""), None);
    }

    #[test]
    fn lpstat_accepting_distinguishes_not_accepting() {
        let map = parse_lpstat_accepting(
            "Office_Laser accepting requests since Mon 28 Jul 2026 09:12:00 AM CEST\n\
             Old_Inkjet not accepting requests since Mon 28 Jul 2026 08:00:00 AM CEST\n",
        );
        assert_eq!(map.get("Office_Laser"), Some(&true));
        assert_eq!(map.get("Old_Inkjet"), Some(&false));
    }

    #[test]
    fn lpstat_jobs_keeps_the_timestamp_whole() {
        let jobs = parse_lpstat_jobs(
            "Office_Laser-42       alice        14336   Mon 28 Jul 2026 09:12:00 AM CEST\n\
             Lab-Plotter-7         ada           4096   Mon 28 Jul 2026 09:30:00 AM CEST\n",
        );
        assert_eq!(jobs.len(), 2);
        assert_eq!(jobs[0].id, "Office_Laser-42");
        assert_eq!(jobs[0].number, 42);
        assert_eq!(jobs[0].printer, "Office_Laser");
        assert_eq!(jobs[0].user, "alice");
        assert_eq!(jobs[0].size_bytes, 14336);
        assert_eq!(jobs[0].submitted, "Mon 28 Jul 2026 09:12:00 AM CEST");
        // A printer name containing '-' still splits on the LAST one.
        assert_eq!(jobs[1].printer, "Lab-Plotter");
        assert_eq!(jobs[1].number, 7);
    }

    #[test]
    fn lpstat_jobs_ignores_non_job_lines() {
        assert!(parse_lpstat_jobs("lpstat: Error - no default destination\n").is_empty());
        assert!(parse_lpstat_jobs("").is_empty());
    }

    #[test]
    fn lpq_titles_survive_spaces_in_the_file_name() {
        let map = parse_lpq_titles(
            "Office_Laser is ready and printing\n\
             Rank    Owner   Job     File(s)                         Total Size\n\
             active  alice   42      quarterly report final.pdf      14336 bytes\n\
             1st     ada     7       notes.txt                       4096 bytes\n",
        );
        assert_eq!(
            map.get(&42),
            Some(&(
                "quarterly report final.pdf".to_string(),
                "printing".to_string()
            ))
        );
        assert_eq!(
            map.get(&7),
            Some(&("notes.txt".to_string(), "pending".to_string()))
        );
    }

    #[test]
    fn merge_falls_back_to_the_id_rather_than_a_blank_title() {
        let jobs = parse_lpstat_jobs(
            "Office_Laser-42   alice     14336   Mon 28 Jul 2026 09:12:00 AM CEST\n",
        );
        let merged = merge_cups_jobs(jobs, &HashMap::new());
        assert_eq!(merged[0].title, "Office_Laser-42");
        assert_eq!(merged[0].state, "pending");
    }

    #[test]
    fn names_and_ids_that_could_reach_a_shell_are_refused() {
        assert!(check_printer_name("Office_Laser").is_ok());
        assert!(check_printer_name("HP LaserJet 400").is_ok()); // Windows names have spaces
        assert!(check_printer_name("").is_err());
        assert!(check_printer_name("a'; rm -rf ~; '").is_err());
        assert!(check_printer_name("back`tick`").is_err());
        assert!(check_printer_name(&"x".repeat(200)).is_err());

        assert!(check_job_id("Office_Laser-42").is_ok());
        assert!(check_job_id("42").is_ok());
        assert!(check_job_id("42; reboot").is_err());
    }

    #[test]
    fn ps_quote_doubles_single_quotes() {
        assert_eq!(ps_quote("plain"), "'plain'");
        assert_eq!(ps_quote("it's"), "'it''s'");
    }

    #[test]
    fn windows_snapshot_reads_a_one_element_list_as_a_list() {
        // ConvertTo-Json collapses a single-element array into a bare object;
        // both shapes must read as one printer and one job.
        let snap = parse_windows_snapshot(
            r#"{"printers":{"Name":"HP LaserJet","Comment":"Front desk","Location":"Hall","PrinterStatus":"Normal"},
                "jobs":{"Id":3,"PrinterName":"HP LaserJet","UserName":"ada","DocumentName":"report.pdf","JobStatus":"Printing","Size":2048,"SubmittedTime":"2026-07-28T09:12:00","PagesPrinted":1,"TotalPages":4},
                "default":"HP LaserJet"}"#,
        )
        .expect("parses");
        assert_eq!(snap.printers.len(), 1);
        assert_eq!(snap.printers[0].name, "HP LaserJet");
        assert_eq!(snap.printers[0].state, "idle");
        assert!(snap.printers[0].is_default);
        assert_eq!(snap.jobs.len(), 1);
        assert_eq!(snap.jobs[0].id, "3");
        assert_eq!(snap.jobs[0].title, "report.pdf");
        assert_eq!(snap.jobs[0].state, "printing");
        assert_eq!(snap.jobs[0].pages_done, Some(1));
        assert_eq!(snap.jobs[0].pages_total, Some(4));
        assert_eq!(snap.default_printer.as_deref(), Some("HP LaserJet"));
    }

    /// One IPP attribute, as a server writes it.
    fn ipp_attr(buf: &mut Vec<u8>, tag: u8, name: &str, value: &[u8]) {
        buf.push(tag);
        buf.extend((name.len() as u16).to_be_bytes());
        buf.extend(name.as_bytes());
        buf.extend((value.len() as u16).to_be_bytes());
        buf.extend(value);
    }

    fn ipp_int(buf: &mut Vec<u8>, name: &str, n: i32) {
        ipp_attr(buf, 0x21, name, &n.to_be_bytes());
    }

    #[test]
    fn ipp_response_yields_each_jobs_page_counters() {
        let mut body = vec![0x02, 0x00, 0x00, 0x00, 0, 0, 0, 1, 0x01];
        ipp_attr(&mut body, 0x47, "attributes-charset", b"utf-8");
        body.push(0x02);
        ipp_int(&mut body, "job-printer-up-time", 1_789_424_700);
        ipp_int(&mut body, "time-at-processing", 1_789_424_640);
        ipp_int(&mut body, "job-id", 42);
        ipp_attr(&mut body, 0x23, "job-state", &5i32.to_be_bytes());
        ipp_int(&mut body, "job-impressions-completed", 3);
        ipp_int(&mut body, "job-impressions", 12);
        body.push(0x02);
        ipp_int(&mut body, "job-id", 43);
        // `no-value`: a job not yet processing has no start time.
        ipp_attr(&mut body, 0x13, "time-at-processing", b"");
        ipp_int(&mut body, "job-impressions", 0);
        ipp_int(&mut body, "job-media-sheets-completed", 0);
        body.push(0x03);

        let jobs = parse_ipp_job_progress(&body);
        assert_eq!(
            jobs[&42],
            JobProgress {
                pages_done: Some(3),
                pages_total: Some(12),
                printing_secs: Some(60),
            }
        );
        assert_eq!(
            jobs[&43],
            JobProgress {
                pages_done: Some(0),
                pages_total: None,
                printing_secs: None,
            }
        );
    }

    #[test]
    fn ipp_error_or_damage_yields_nothing_invented() {
        // client-error-not-found
        assert!(parse_ipp_job_progress(&[0x02, 0x00, 0x04, 0x06, 0, 0, 0, 1, 0x03]).is_empty());

        let mut cut = vec![0x02, 0x00, 0x00, 0x00, 0, 0, 0, 1, 0x02];
        ipp_int(&mut cut, "job-id", 7);
        cut.extend([0x21, 0x00, 0x20]); // a name running past the end
        let jobs = parse_ipp_job_progress(&cut);
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[&7], JobProgress::default());
    }

    #[test]
    fn get_jobs_request_asks_for_every_counter() {
        let req = ipp_get_jobs_request("ada");
        assert_eq!(&req[..4], &[0x02, 0x00, 0x00, 0x0A]);
        assert_eq!(req.last(), Some(&0x03));
        let text = String::from_utf8_lossy(&req);
        for name in IPP_JOB_ATTRS {
            assert!(text.contains(name), "{name}");
        }
        assert!(text.contains("ada"));
    }

    #[test]
    fn http_body_is_unchunked_and_refused_on_an_error_status() {
        let plain = b"HTTP/1.1 200 OK\r\nContent-Type: application/ipp\r\n\r\nABC";
        assert_eq!(http_ipp_body(plain).as_deref(), Some(&b"ABC"[..]));
        let chunked =
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nABC\r\n2;x=y\r\nDE\r\n0\r\n\r\n";
        assert_eq!(http_ipp_body(chunked).as_deref(), Some(&b"ABCDE"[..]));
        assert_eq!(http_ipp_body(b"HTTP/1.1 426 Upgrade Required\r\n\r\n"), None);
        let truncated = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nAB";
        assert_eq!(http_ipp_body(truncated), None);
    }

    #[test]
    fn cups_server_values_parse_and_only_local_ones_are_asked() {
        assert_eq!(
            parse_cups_server("/run/cups/cups.sock"),
            Some(CupsServer::Socket("/run/cups/cups.sock".into()))
        );
        assert_eq!(
            parse_cups_server("localhost"),
            Some(CupsServer::Tcp {
                addr: "localhost:631".into(),
                host: "localhost".into()
            })
        );
        assert_eq!(
            parse_cups_server("127.0.0.1:8631/version=1.1"),
            Some(CupsServer::Tcp {
                addr: "127.0.0.1:8631".into(),
                host: "127.0.0.1".into()
            })
        );
        assert_eq!(
            parse_cups_server("[::1]:631"),
            Some(CupsServer::Tcp {
                addr: "[::1]:631".into(),
                host: "[::1]".into()
            })
        );
        assert_eq!(parse_cups_server("host:notaport"), None);
        assert_eq!(
            client_conf_server_name("# comment\nservername print.example:631\n"),
            Some("print.example:631".into())
        );
        assert_eq!(client_conf_server_name("Encryption Required\n"), None);

        let local = |v: &str| cups_server_is_local(&parse_cups_server(v).expect("parses"));
        assert!(local("/run/cups/cups.sock"));
        assert!(local("[::1]"));
        assert!(local("127.0.0.1:631"));
        assert!(!local("print.example"));
        assert!(!local("192.0.2.7"));
    }

    #[test]
    fn windows_states_degrade_to_unknown_never_to_healthy() {
        assert_eq!(windows_printer_state("Normal"), "idle");
        assert_eq!(windows_printer_state("Printing"), "printing");
        assert_eq!(windows_printer_state("Offline"), "stopped");
        assert_eq!(windows_printer_state("Paused, Error"), "stopped");
        assert_eq!(windows_printer_state("Whatever-Is-New"), "unknown");
        assert_eq!(windows_job_state("Paused"), "held");
        assert_eq!(windows_job_state(""), "unknown");
    }
}
