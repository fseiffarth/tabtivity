//! Spreadsheet parsing in a child process of the main binary.
//!
//! calamine can abort the whole process on a crafted workbook: an `.xls`
//! DIMENSIONS record drives `cells.reserve(rows * cols)` while the workbook is
//! merely being *opened* (every sheet is parsed then), and `Range::from_sparse`
//! allocates the bounding box of an `.xlsx` sheet's cells — A1 plus XFD1048576
//! asks for ~1.7·10¹⁰ cells. A failed allocation aborts; it cannot be caught.
//! Run in the app, that took down every window and every non-tmux terminal.
//!
//! So the read runs in `<binary> --sheet-read <path> [sheet]` ([`MODE_FLAG`],
//! handled in `main.rs` before Tauri starts). The child limits itself (Linux:
//! address space and CPU time; macOS: CPU time; never a core dump) and writes
//! one JSON [`Reply`] as the last line on stdout. The parent allows it
//! [`WALL_TIME`], caps what it reads, kills it on timeout and on a clean quit
//! ([`kill_all_for_exit`], called from `RunEvent::Exit`), and maps a crash, a
//! timeout or an oversized answer to a `viewer-limit:` code the viewer shows
//! as a translated message. Windows has no rlimits here; the process boundary
//! alone keeps an abort contained.
//!
//! Inside the child an `.xlsx`/`.xlsm` sheet is read cell by cell through
//! `worksheet_cells_reader`, never through a `Range`, under the row, cell and
//! text caps below. An `.xls` is parsed by calamine whole (it has no streaming
//! reader); the child's limits are what bound it. Only the three extensions the
//! viewer routes here are accepted (`TableView`'s `SHEET_RE`).
//!
//! AppHandle-free: the command (`commands::sheets`) confines the path first.

use std::ffi::OsString;
use std::io::{BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use calamine::{open_workbook, Data, DataRef, Reader, Xls, Xlsx, XlsxError};
use serde::{Deserialize, Serialize};

/// The hidden mode of the main binary that does the read.
pub const MODE_FLAG: &str = "--sheet-read";

/// The sheet is past the viewer's row/cell/text caps.
pub const ERR_TOO_LARGE: &str = "viewer-limit:sheet-too-large";
/// The read took longer than [`WALL_TIME`].
pub const ERR_TIMEOUT: &str = "viewer-limit:sheet-timeout";
/// The reader died (an abort, a signal, a limit) or answered nothing usable.
pub const ERR_CRASHED: &str = "viewer-limit:sheet-crashed";
/// Not one of `.xlsx`, `.xlsm`, `.xls`.
pub const ERR_UNSUPPORTED: &str = "viewer-limit:sheet-unsupported";

/// Rows returned, counted from the sheet's first used row. Rows past it are
/// dropped (the viewer has its own render window on top of this).
pub const MAX_ROWS: usize = 20_000;
/// Cells in the returned grid (kept rows × used width). A sheet past it is
/// refused, not cut: no answer is better than a silently partial one.
pub const MAX_CELLS: u64 = 2_000_000;
/// One cell's text, in bytes (Excel's own limit is 32 767 characters).
const MAX_CELL_BYTES: usize = 32 * 1024;
/// All cell text of one answer, in bytes.
const MAX_TEXT_BYTES: usize = 32 * 1024 * 1024;
/// What the parent reads off the child's stdout: the text budget plus JSON's
/// worst-case escaping.
const STDOUT_CAP: usize = 224 * 1024 * 1024;
/// How long the parent waits for an answer before it kills the child.
pub const WALL_TIME: Duration = Duration::from_secs(30);
/// The child's own CPU-time limit (soft; SIGXCPU).
#[cfg(unix)]
const CPU_SECONDS: u64 = 30;
/// Address space the child may add to what it holds at start (Linux).
#[cfg(target_os = "linux")]
const ADDRESS_SPACE_HEADROOM: u64 = 2 << 30;

/// A workbook read result: the names of all sheets (so the UI can offer a sheet
/// picker) plus the rows of the selected (or first) sheet.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SheetData {
    pub sheet_names: Vec<String>,
    /// The sheet actually returned in `rows`.
    pub active_sheet: String,
    /// Row-major grid of stringified cells (header row included, if any).
    pub rows: Vec<Vec<String>>,
}

/// The child's one line of output.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Reply {
    Ok(SheetData),
    Err(String),
}

/// The formats the reader accepts, by extension.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Xlsx,
    Xls,
}

/// The format `path` names by its extension (case-insensitive), or
/// [`ERR_UNSUPPORTED`]. `.ods`/`.xlsb` stay out: the viewer never routes them
/// here, and every format calamine parses is more of its code a file reaches.
pub fn format_of(path: &Path) -> Result<Format, String> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());
    match ext.as_deref() {
        Some("xlsx" | "xlsm") => Ok(Format::Xlsx),
        Some("xls") => Ok(Format::Xls),
        _ => Err(ERR_UNSUPPORTED.to_string()),
    }
}

// ── Parent side ──────────────────────────────────────────────────────────────

/// Children still running, so a clean quit can end them.
static LIVE: Mutex<Vec<(u64, Arc<Mutex<Child>>)>> = Mutex::new(Vec::new());
static NEXT_ID: AtomicU64 = AtomicU64::new(0);
/// Set by [`kill_all_for_exit`]; no child starts after it.
static CLOSING: AtomicBool = AtomicBool::new(false);

/// Read one sheet of the workbook at `path` in a child process. Blocking: call
/// it off the main thread. The path must already be confined.
pub fn read_in_child(path: &Path, sheet: Option<&str>) -> Result<SheetData, String> {
    format_of(path)?;
    let mut cmd = Command::new(running_binary()?);
    cmd.arg(MODE_FLAG).arg(path);
    if let Some(sheet) = sheet {
        cmd.arg(sheet);
    }
    run_reader(cmd, WALL_TIME)
}

/// The running binary, as a path a child can exec now. On Linux the magic link,
/// which still names the running image after a rebuild or an update replaced
/// the file (`current_exe` then ends in ` (deleted)`).
fn running_binary() -> Result<PathBuf, String> {
    #[cfg(target_os = "linux")]
    {
        Ok(PathBuf::from("/proc/self/exe"))
    }
    #[cfg(not(target_os = "linux"))]
    {
        std::env::current_exe().map_err(|e| format!("spreadsheet reader: cannot find the binary: {e}"))
    }
}

enum Waited {
    Exited(ExitStatus),
    TimedOut,
}

/// Run a prepared reader command: `cmd` must print a [`Reply`] as its last
/// stdout line. Split from [`read_in_child`] so a test can hand in a stand-in.
fn run_reader(mut cmd: Command, wall: Duration) -> Result<SheetData, String> {
    if CLOSING.load(Ordering::SeqCst) {
        return Err(ERR_CRASHED.to_string());
    }
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    crate::paths::hide_command_window(&mut cmd);
    #[cfg(target_os = "linux")]
    die_with_parent(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("spreadsheet reader: cannot start: {e}"))?;
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(ERR_CRASHED.to_string());
    };
    // Drained on its own thread so a big answer can't fill the pipe and stall
    // the child; past the cap the pipe is dropped and the child's write fails.
    let (drained_tx, drained) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = drained_tx.send(read_capped(stdout, STDOUT_CAP));
    });
    let child = Arc::new(Mutex::new(child));
    let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
    lock(&LIVE).push((id, child.clone()));
    // A quit that ran between the spawn and the registration missed this one.
    if CLOSING.load(Ordering::SeqCst) {
        kill_and_reap(&child);
    }
    let waited = wait_until(&child, Instant::now() + wall);
    lock(&LIVE).retain(|(other, _)| *other != id);
    let status = match waited {
        // Not waited for: whatever still holds the pipe keeps the drain
        // thread, not this one.
        Waited::TimedOut => return Err(ERR_TIMEOUT.to_string()),
        Waited::Exited(status) => status,
    };
    // The child is gone, so its end of the pipe is closed and the drain ends at
    // once — unless something it left behind still holds the pipe.
    match drained.recv_timeout(Duration::from_secs(5)) {
        Ok(Drained::Overflow) => Err(ERR_TOO_LARGE.to_string()),
        Ok(Drained::Bytes(bytes)) if status.success() => parse_reply(&bytes),
        _ => Err(ERR_CRASHED.to_string()),
    }
}

/// Linux: the reader gets `SIGKILL` when the app dies. A clean quit already
/// kills it ([`kill_all_for_exit`]); an app that is killed instead would leave
/// it running to its CPU limit. The death signal is armed in the child between
/// fork and exec, and the parent is checked right after, so an app that died
/// in between is caught too (the child was reparented by then).
///
/// The kernel sends the signal when the *thread* that spawned the child ends,
/// not the process: [`run_reader`] waits for the child on the spawning thread,
/// so that thread outlives it.
#[cfg(target_os = "linux")]
fn die_with_parent(cmd: &mut Command) {
    use std::os::unix::process::CommandExt;
    let parent = std::process::id() as libc::pid_t;
    // SAFETY: the closure runs between fork and exec and makes only
    // async-signal-safe syscalls; it allocates nothing.
    unsafe {
        cmd.pre_exec(move || {
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL as libc::c_ulong, 0, 0, 0) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            if libc::getppid() != parent {
                return Err(std::io::Error::from_raw_os_error(libc::ESRCH));
            }
            Ok(())
        });
    }
}

enum Drained {
    Bytes(Vec<u8>),
    Overflow,
}

fn read_capped(stdout: impl Read, cap: usize) -> Drained {
    let mut bytes = Vec::new();
    match stdout.take(cap as u64 + 1).read_to_end(&mut bytes) {
        Ok(_) if bytes.len() <= cap => Drained::Bytes(bytes),
        Ok(_) => Drained::Overflow,
        // A broken pipe after a kill: whatever arrived is judged by the status.
        Err(_) => Drained::Bytes(bytes),
    }
}

fn wait_until(child: &Mutex<Child>, deadline: Instant) -> Waited {
    let mut step = Duration::from_millis(2);
    loop {
        {
            let mut guard = lock(child);
            match guard.try_wait() {
                Ok(Some(status)) => return Waited::Exited(status),
                Ok(None) => {}
                Err(_) => {
                    drop(guard);
                    kill_and_reap(child);
                    return Waited::TimedOut;
                }
            }
            if Instant::now() >= deadline {
                let _ = guard.kill();
                let _ = guard.wait();
                return Waited::TimedOut;
            }
        }
        std::thread::sleep(step);
        step = (step * 2).min(Duration::from_millis(50));
    }
}

fn kill_and_reap(child: &Mutex<Child>) {
    let mut guard = lock(child);
    let _ = guard.kill();
    let _ = guard.wait();
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// The reply is the last non-empty stdout line; anything a linked library
/// printed before it is ignored.
fn parse_reply(out: &[u8]) -> Result<SheetData, String> {
    let text = String::from_utf8_lossy(out);
    let Some(line) = text.lines().rev().find(|l| !l.trim().is_empty()) else {
        return Err(ERR_CRASHED.to_string());
    };
    match serde_json::from_str::<Reply>(line) {
        Ok(Reply::Ok(data)) => Ok(data),
        Ok(Reply::Err(e)) => Err(e),
        Err(_) => Err(ERR_CRASHED.to_string()),
    }
}

/// End every running reader and start no more. `RunEvent::Exit` calls it.
pub fn kill_all_for_exit() {
    CLOSING.store(true, Ordering::SeqCst);
    kill_registered(|_| true);
}

/// End (and unregister) every registered reader `which` picks; whether any was.
fn kill_registered(which: impl Fn(&Child) -> bool) -> bool {
    let picked: Vec<_> = {
        let mut live = lock(&LIVE);
        let (picked, kept) = std::mem::take(&mut *live)
            .into_iter()
            .partition(|(_, child)| which(&lock(child)));
        *live = kept;
        picked
    };
    for (_, child) in &picked {
        kill_and_reap(child);
    }
    !picked.is_empty()
}

// ── Child side ───────────────────────────────────────────────────────────────

/// `<binary> --sheet-read <path> [sheet]`: limit this process, read the sheet,
/// print the [`Reply`]. Returns the exit code.
pub fn child_main(args: &[OsString]) -> i32 {
    apply_child_limits();
    let (path, sheet) = match args {
        [path] => (path, None),
        [path, sheet] => (path, Some(sheet.to_string_lossy().into_owned())),
        _ => {
            eprintln!(concat!("usage: ", crate::app_slug!(), " --sheet-read <path> [sheet]"));
            return 2;
        }
    };
    let reply = match read_workbook(Path::new(path), sheet.as_deref()) {
        Ok(data) => Reply::Ok(data),
        Err(e) => Reply::Err(e),
    };
    let stdout = std::io::stdout();
    let mut out = BufWriter::new(stdout.lock());
    // A newline first, so the reply starts a line of its own whatever was
    // printed before it.
    let written = out
        .write_all(b"\n")
        .and_then(|()| serde_json::to_writer(&mut out, &reply).map_err(std::io::Error::from))
        .and_then(|()| out.write_all(b"\n"))
        .and_then(|()| out.flush());
    if written.is_err() {
        return 3;
    }
    0
}

/// No core dump ever; CPU time (Unix) and address space (Linux) bounded.
/// macOS does not enforce `RLIMIT_AS`, so there only the wall clock and the CPU
/// limit bound a runaway read.
fn apply_child_limits() {
    #[cfg(unix)]
    {
        let set = |resource, soft: u64, hard: u64| {
            let limit = libc::rlimit {
                rlim_cur: soft as libc::rlim_t,
                rlim_max: hard as libc::rlim_t,
            };
            // SAFETY: plain syscall on this process with a valid struct.
            unsafe { libc::setrlimit(resource, &limit) };
        };
        set(libc::RLIMIT_CORE, 0, 0);
        set(libc::RLIMIT_CPU, CPU_SECONDS, CPU_SECONDS + 5);
        #[cfg(target_os = "linux")]
        {
            // SAFETY: plain prctl on this process.
            unsafe { libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0) };
            if let Some(now) = address_space_now() {
                let cap = now.saturating_add(ADDRESS_SPACE_HEADROOM);
                set(libc::RLIMIT_AS, cap, cap);
            }
        }
    }
}

/// This process's mapped address space in bytes (`/proc/self/statm`). The
/// limit is set on top of it: the binary and its libraries are already mapped
/// and differ between a debug and a release build.
#[cfg(target_os = "linux")]
fn address_space_now() -> Option<u64> {
    let statm = std::fs::read_to_string("/proc/self/statm").ok()?;
    let pages: u64 = statm.split_whitespace().next()?.parse().ok()?;
    // SAFETY: sysconf has no preconditions.
    let page = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
    u64::try_from(page).ok().map(|page| pages.saturating_mul(page))
}

/// Read one sheet (the first when `sheet` is `None` or unknown). Runs in the
/// child; safe in-process for `.xlsx`, whose path never builds a `Range`.
pub fn read_workbook(path: &Path, sheet: Option<&str>) -> Result<SheetData, String> {
    match format_of(path)? {
        Format::Xlsx => read_xlsx(path, sheet),
        Format::Xls => read_xls(path, sheet),
    }
}

fn open_err(e: impl std::fmt::Display) -> String {
    format!("Failed to open workbook: {e}")
}

fn sheet_err(sheet: &str, e: impl std::fmt::Display) -> String {
    format!("Failed to read sheet '{sheet}': {e}")
}

/// The sheet names and the one to read: the requested one when present,
/// otherwise the first.
fn pick_sheet(names: Vec<String>, sheet: Option<&str>) -> Result<(Vec<String>, String), String> {
    if names.is_empty() {
        return Err("Workbook has no sheets".to_string());
    }
    let active = match sheet {
        Some(name) if names.iter().any(|n| n == name) => name.to_string(),
        _ => names[0].clone(),
    };
    Ok((names, active))
}

fn read_xlsx(path: &Path, sheet: Option<&str>) -> Result<SheetData, String> {
    let mut workbook: Xlsx<_> = open_workbook(path).map_err(open_err)?;
    let (sheet_names, active_sheet) = pick_sheet(workbook.sheet_names().to_vec(), sheet)?;
    let mut grid = Grid::default();
    match workbook.worksheet_cells_reader(&active_sheet) {
        Ok(mut reader) => {
            // The sheet's declared `<dimension>` is not checked: Excel counts
            // formatted blank cells in it, so a lightly filled sheet with wide
            // formatting would be refused. The caps in `Grid` bound what is
            // actually read, and `Grid::finish` checks the real cells' area
            // before laying anything out.
            while let Some(cell) = reader
                .next_cell()
                .map_err(|e| sheet_err(&active_sheet, e))?
            {
                if matches!(cell.get_value(), DataRef::Empty) {
                    continue;
                }
                let (row, col) = cell.get_position();
                grid.push(row, col, || cell_to_string(Data::from(cell.get_value().clone())))?;
            }
        }
        // A chart sheet: nothing to show, as calamine's own range reader does.
        Err(XlsxError::NotAWorksheet(_)) => {}
        Err(e) => return Err(sheet_err(&active_sheet, e)),
    }
    Ok(SheetData {
        sheet_names,
        active_sheet,
        rows: grid.finish()?,
    })
}

fn read_xls(path: &Path, sheet: Option<&str>) -> Result<SheetData, String> {
    // Opening parses every sheet; a hostile file can abort here. That is why
    // this runs in the child.
    let mut workbook: Xls<_> = open_workbook(path).map_err(open_err)?;
    let (sheet_names, active_sheet) = pick_sheet(workbook.sheet_names().to_vec(), sheet)?;
    let range = workbook
        .worksheet_range(&active_sheet)
        .map_err(|e| sheet_err(&active_sheet, e))?;
    let (height, width) = range.get_size();
    check_area(height as u64, width as u64)?;
    let mut grid = Grid::default();
    for (row, col, value) in range.used_cells() {
        grid.push(row as u32, col as u32, || cell_to_string(value.clone()))?;
    }
    Ok(SheetData {
        sheet_names,
        active_sheet,
        rows: grid.finish()?,
    })
}

/// Rows or columns covered from `start` to `end` inclusive (1 for a bogus
/// reversed pair).
fn span(start: u32, end: u32) -> u64 {
    u64::from(end.saturating_sub(start)) + 1
}

/// Refuse an area whose kept rows times its width pass [`MAX_CELLS`].
fn check_area(rows: u64, cols: u64) -> Result<(), String> {
    if rows.min(MAX_ROWS as u64).saturating_mul(cols) > MAX_CELLS {
        Err(ERR_TOO_LARGE.to_string())
    } else {
        Ok(())
    }
}

/// The used cells of one sheet, gathered sparse and laid out only once their
/// bounds are known to fit.
#[derive(Default)]
struct Grid {
    cells: Vec<(u32, u32, String)>,
    text: usize,
    min_row: Option<u32>,
    min_col: u32,
}

impl Grid {
    /// Keep one non-empty cell. Rows [`MAX_ROWS`] or more past the first used
    /// row are dropped; past the cell or text budget the sheet is refused.
    fn push(&mut self, row: u32, col: u32, text: impl FnOnce() -> String) -> Result<(), String> {
        if let Some(min_row) = self.min_row {
            if u64::from(row) >= u64::from(min_row) + MAX_ROWS as u64 {
                return Ok(());
            }
        }
        if self.cells.len() as u64 >= MAX_CELLS {
            return Err(ERR_TOO_LARGE.to_string());
        }
        let text = truncate_cell(text());
        self.text += text.len();
        if self.text > MAX_TEXT_BYTES {
            return Err(ERR_TOO_LARGE.to_string());
        }
        match self.min_row {
            Some(min_row) if min_row <= row => self.min_col = self.min_col.min(col),
            Some(_) => {
                self.min_row = Some(row);
                self.min_col = self.min_col.min(col);
            }
            None => {
                self.min_row = Some(row);
                self.min_col = col;
            }
        }
        self.cells.push((row, col, text));
        Ok(())
    }

    /// The rectangular grid from the first used row and column, or
    /// [`ERR_TOO_LARGE`] when its area passes [`MAX_CELLS`].
    fn finish(self) -> Result<Vec<Vec<String>>, String> {
        let Some(min_row) = self.min_row else {
            return Ok(Vec::new());
        };
        let min_col = self.min_col;
        let row_end = u64::from(min_row) + MAX_ROWS as u64;
        let kept: Vec<_> = self
            .cells
            .into_iter()
            .filter(|(row, _, _)| u64::from(*row) < row_end)
            .collect();
        let max_row = kept.iter().map(|c| c.0).max().unwrap_or(min_row);
        let max_col = kept.iter().map(|c| c.1).max().unwrap_or(min_col);
        let height = span(min_row, max_row);
        let width = span(min_col, max_col);
        if height.saturating_mul(width) > MAX_CELLS {
            return Err(ERR_TOO_LARGE.to_string());
        }
        let mut rows = vec![vec![String::new(); width as usize]; height as usize];
        for (row, col, text) in kept {
            rows[(row - min_row) as usize][(col - min_col) as usize] = text;
        }
        Ok(rows)
    }
}

/// Cut a cell's text to [`MAX_CELL_BYTES`] on a character boundary.
fn truncate_cell(mut text: String) -> String {
    if text.len() > MAX_CELL_BYTES {
        let mut end = MAX_CELL_BYTES;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
        text.push('…');
    }
    text
}

/// Stringify a single spreadsheet cell. Empty cells become `""`; everything
/// else renders to a plain, CSV-like string the table viewer can display.
pub fn cell_to_string(cell: Data) -> String {
    match cell {
        Data::Empty => String::new(),
        Data::String(s) => s,
        Data::Int(i) => i.to_string(),
        Data::Float(f) => {
            // Render whole floats without a trailing `.0` so a column of integers
            // stored as floats (the common xlsx case) reads cleanly.
            if f.fract() == 0.0 && f.is_finite() {
                (f as i64).to_string()
            } else {
                f.to_string()
            }
        }
        Data::Bool(b) => if b { "TRUE" } else { "FALSE" }.to_string(),
        // DateTime / DateTimeIso / DurationIso / Error all have a sensible Display.
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Set when the test binary is re-run as the reader child (see
    /// [`child_entry`]): the workbook path, then optionally `\u{1f}` and a sheet.
    const TEST_CHILD_ENV: &str = "SHEET_READER_TEST_CHILD";

    /// The child half of the in-process tests: a no-op in a normal run; when
    /// [`TEST_CHILD_ENV`] is set it is the reader child and exits.
    #[test]
    fn child_entry() {
        let Some(spec) = std::env::var_os(TEST_CHILD_ENV) else {
            return;
        };
        let spec = spec.to_string_lossy().into_owned();
        let args: Vec<OsString> = spec.split('\u{1f}').map(OsString::from).collect();
        std::process::exit(child_main(&args));
    }

    /// The death signal is armed: the child is killed once the thread that
    /// started it is gone (the kernel's notion of the parent), here a thread
    /// that ends right after the spawn.
    #[cfg(target_os = "linux")]
    #[test]
    fn the_reader_child_dies_with_its_parent() {
        use std::os::unix::process::ExitStatusExt;
        let mut child = std::thread::spawn(|| {
            let mut cmd = Command::new("sleep");
            cmd.arg("30");
            die_with_parent(&mut cmd);
            cmd.spawn().unwrap()
        })
        .join()
        .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break Some(status);
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        assert_eq!(status.and_then(|s| s.signal()), Some(libc::SIGKILL));
    }

    /// The test binary itself, run as the reader child on `path`.
    fn test_child(path: &Path) -> Command {
        let mut cmd = Command::new(std::env::current_exe().unwrap());
        cmd.args([
            "--exact",
            "services::sheet_reader::tests::child_entry",
            "--test-threads=1",
            "--nocapture",
        ]);
        cmd.env(TEST_CHILD_ENV, path);
        cmd
    }

    /// A minimal `.xlsx`: one sheet "S" whose `sheetData` is `rows_xml`,
    /// with an optional `<dimension ref=…>`.
    fn write_xlsx(path: &Path, dimension: Option<&str>, rows_xml: &str) {
        let file = std::fs::File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default();
        let parts: [(&str, String); 4] = [
            (
                "[Content_Types].xml",
                r#"<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>"#.to_string(),
            ),
            (
                "_rels/.rels",
                r#"<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#.to_string(),
            ),
            (
                "xl/workbook.xml",
                r#"<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>"#.to_string(),
            ),
            (
                "xl/_rels/workbook.xml.rels",
                r#"<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>"#.to_string(),
            ),
        ];
        for (name, body) in parts {
            zip.start_file(name, opts).unwrap();
            zip.write_all(body.as_bytes()).unwrap();
        }
        let dim = dimension
            .map(|d| format!(r#"<dimension ref="{d}"/>"#))
            .unwrap_or_default();
        zip.start_file("xl/worksheets/sheet1.xml", opts).unwrap();
        write!(
            zip,
            r#"<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">{dim}<sheetData>{rows_xml}</sheetData></worksheet>"#
        )
        .unwrap();
        zip.finish().unwrap();
    }

    fn num(cell: &str, v: i64) -> String {
        format!(r#"<c r="{cell}"><v>{v}</v></c>"#)
    }

    fn row(r: u32, cells: &[String]) -> String {
        format!(r#"<row r="{r}">{}</row>"#, cells.concat())
    }

    #[test]
    fn reads_a_small_sheet_from_its_first_used_cell() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("book.xlsx");
        let rows = [
            row(2, &[num("B2", 1), r#"<c r="C2" t="inlineStr"><is><t>hi</t></is></c>"#.to_string()]),
            row(3, &[num("C3", 7)]),
        ]
        .concat();
        write_xlsx(&path, Some("B2:C3"), &rows);
        let data = read_workbook(&path, None).unwrap();
        assert_eq!(data.sheet_names, vec!["S"]);
        assert_eq!(data.active_sheet, "S");
        assert_eq!(data.rows, vec![vec!["1", "hi"], vec!["", "7"]]);
        // An unknown sheet falls back to the first.
        assert_eq!(read_workbook(&path, Some("nope")).unwrap().active_sheet, "S");
    }

    #[test]
    fn a_sparse_a1_xfd1048576_sheet_never_allocates_its_box() {
        // The 2026-10-08 bomb: two cells whose bounding box is ~1.7·10¹⁰ cells.
        // Read in-process on purpose — if anything built that box, this test
        // process would abort. The far cell is past the row cap and dropped;
        // what is left is one cell, not a box, whatever the sheet declares.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bomb.xlsx");
        let rows = [row(1, &[num("A1", 1)]), row(1_048_576, &[num("XFD1048576", 2)])].concat();
        write_xlsx(&path, Some("A1:XFD1048576"), &rows);
        assert_eq!(read_workbook(&path, None).unwrap().rows, vec![vec!["1"]]);
        write_xlsx(&path, None, &rows);
        assert_eq!(read_workbook(&path, None).unwrap().rows, vec![vec!["1"]]);

        // A box inside the row cap but past the cell cap is refused on the
        // cells themselves, whatever the sheet declares.
        let wide = [row(1, &[num("A1", 1)]), row(20_000, &[num("XFD20000", 2)])].concat();
        write_xlsx(&path, Some("A1"), &wide);
        assert_eq!(read_workbook(&path, None).unwrap_err(), ERR_TOO_LARGE);
    }

    /// Excel's declared range counts formatted blank cells: a sheet declaring
    /// far more than the cell cap but holding a few cells opens.
    #[test]
    fn a_huge_declared_dimension_with_few_cells_opens() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("formatted.xlsx");
        let rows = [row(1, &[num("A1", 1)]), row(2, &[num("B2", 2)])].concat();
        write_xlsx(&path, Some("A1:ZZ50000"), &rows);
        assert_eq!(read_workbook(&path, None).unwrap().rows, vec![vec!["1", ""], vec!["", "2"]]);
    }

    #[test]
    fn rows_past_the_cap_are_dropped_and_long_text_is_cut() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("long.xlsx");
        let long = "x".repeat(MAX_CELL_BYTES + 100);
        let rows = [
            row(1, &[format!(r#"<c r="A1" t="inlineStr"><is><t>{long}</t></is></c>"#)]),
            row(MAX_ROWS as u32, &[num("A20000", 2)]),
            row(MAX_ROWS as u32 + 1, &[num("A20001", 3)]),
        ]
        .concat();
        write_xlsx(&path, None, &rows);
        let data = read_workbook(&path, None).unwrap();
        assert_eq!(data.rows.len(), MAX_ROWS);
        assert_eq!(data.rows[MAX_ROWS - 1], vec!["2"]);
        assert!(data.rows[0][0].ends_with('…'));
        assert!(data.rows[0][0].len() <= MAX_CELL_BYTES + '…'.len_utf8());
    }

    #[test]
    fn only_the_three_viewer_extensions_are_read() {
        for ok in ["a.xlsx", "a.XLSM", "a.xls"] {
            assert!(format_of(Path::new(ok)).is_ok(), "{ok}");
        }
        for refused in ["a.ods", "a.xlsb", "a.csv", "a", "a.xlsx.txt"] {
            assert_eq!(format_of(Path::new(refused)).unwrap_err(), ERR_UNSUPPORTED, "{refused}");
            assert_eq!(read_in_child(Path::new(refused), None).unwrap_err(), ERR_UNSUPPORTED);
        }
    }

    #[test]
    fn cell_to_string_maps_variants() {
        assert_eq!(cell_to_string(Data::Empty), "");
        assert_eq!(cell_to_string(Data::String("hi".into())), "hi");
        assert_eq!(cell_to_string(Data::Int(42)), "42");
        // Whole floats lose the trailing `.0`.
        assert_eq!(cell_to_string(Data::Float(7.0)), "7");
        // Fractional floats keep their decimals.
        assert_eq!(cell_to_string(Data::Float(3.5)), "3.5");
        assert_eq!(cell_to_string(Data::Bool(true)), "TRUE");
        assert_eq!(cell_to_string(Data::Bool(false)), "FALSE");
    }

    #[test]
    fn the_child_answers_a_good_workbook() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("book.xlsx");
        write_xlsx(&path, None, &row(1, &[num("A1", 5)]));
        let data = run_reader(test_child(&path), Duration::from_secs(60)).unwrap();
        assert_eq!(data.rows, vec![vec!["5"]]);
    }

    /// A BIFF8 record: type, length, body.
    #[cfg(unix)]
    fn record(typ: u16, body: &[u8]) -> Vec<u8> {
        let mut out = typ.to_le_bytes().to_vec();
        out.extend((body.len() as u16).to_le_bytes());
        out.extend(body);
        out
    }

    /// An `.xls` whose one sheet declares 1 048 576 × 16 384 cells in its
    /// DIMENSIONS record: calamine reserves that many cells while *opening*
    /// the workbook, and the failed allocation aborts.
    #[cfg(unix)]
    fn write_dimensions_bomb(path: &Path) {
        let bof = |dt: u16| {
            let mut body = 0x0600u16.to_le_bytes().to_vec();
            body.extend(dt.to_le_bytes());
            body.resize(16, 0);
            record(0x0809, &body)
        };
        let eof = record(0x000A, &[]);
        let boundsheet_len = 4 + 9; // header + pos, state, type, cch, flags, "S"
        let globals_len = bof(0x0005).len() + boundsheet_len + eof.len();
        let mut boundsheet = (globals_len as u32).to_le_bytes().to_vec();
        boundsheet.extend([0, 0, 1, 0, b'S']);
        let mut dimensions = 0u32.to_le_bytes().to_vec();
        dimensions.extend(1_048_576u32.to_le_bytes());
        dimensions.extend(0u16.to_le_bytes());
        dimensions.extend(16_384u16.to_le_bytes());
        dimensions.extend(0u16.to_le_bytes());

        let mut stream = bof(0x0005);
        stream.extend(record(0x0085, &boundsheet));
        stream.extend(&eof);
        assert_eq!(stream.len(), globals_len);
        stream.extend(bof(0x0010));
        stream.extend(record(0x0200, &dimensions));
        stream.extend(&eof);
        // Past the mini-stream cutoff, so the stream lives in regular sectors.
        stream.resize(8192, 0);

        // Version 3 (512-byte sectors), what Excel writes; calamine refuses a
        // version 4 file with no mini stream.
        let file = std::fs::File::create(path).unwrap();
        let mut cfb = cfb::CompoundFile::create_with_version(cfb::Version::V3, file).unwrap();
        cfb.create_stream("/Workbook").unwrap().write_all(&stream).unwrap();
        cfb.flush().unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn a_crafted_xls_dimensions_record_ends_the_child_not_the_app() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bomb.xls");
        write_dimensions_bomb(&path);
        // This test process is still here to compare the result.
        assert_eq!(
            run_reader(test_child(&path), Duration::from_secs(60)).unwrap_err(),
            ERR_CRASHED
        );
    }

    #[test]
    #[cfg(unix)]
    fn a_crash_a_hang_garbage_and_a_flood_map_to_viewer_errors() {
        let sh = |script: &str| {
            let mut cmd = Command::new("sh");
            cmd.args(["-c", script]);
            cmd
        };
        let long = Duration::from_secs(30);
        assert_eq!(run_reader(sh("kill -ABRT $$"), long).unwrap_err(), ERR_CRASHED);
        assert_eq!(run_reader(sh("exit 101"), long).unwrap_err(), ERR_CRASHED);
        assert_eq!(run_reader(sh("echo not json"), long).unwrap_err(), ERR_CRASHED);
        assert_eq!(run_reader(sh("true"), long).unwrap_err(), ERR_CRASHED);
        // A reply that is a refusal comes through as that refusal.
        let refusal = format!(r#"echo; echo '{{"err":"{ERR_TOO_LARGE}"}}'"#);
        assert_eq!(run_reader(sh(&refusal), long).unwrap_err(), ERR_TOO_LARGE);

        let started = Instant::now();
        assert_eq!(
            run_reader(sh("exec sleep 30"), Duration::from_millis(300)).unwrap_err(),
            ERR_TIMEOUT
        );
        assert!(started.elapsed() < Duration::from_secs(10), "the hung child was killed");

        // More output than the cap reads as too large (and the child, its pipe
        // gone, stops).
        assert_eq!(
            run_reader(sh("head -c 300000000 /dev/zero"), long).unwrap_err(),
            ERR_TOO_LARGE
        );
    }

    #[test]
    #[cfg(unix)]
    fn the_quit_teardown_kills_a_running_reader() {
        let dir = tempfile::tempdir().unwrap();
        let pid_file = dir.path().join("pid");
        let mut cmd = Command::new("sh");
        cmd.arg("-c")
            .arg(format!("echo $$ > '{}'; exec sleep 60", pid_file.display()));
        let reader = std::thread::spawn(move || run_reader(cmd, Duration::from_secs(120)));
        let started = Instant::now();
        let pid: u32 = loop {
            if let Some(pid) = std::fs::read_to_string(&pid_file)
                .ok()
                .and_then(|s| s.trim().parse().ok())
            {
                break pid;
            }
            assert!(started.elapsed() < Duration::from_secs(10), "the reader never started");
            std::thread::sleep(Duration::from_millis(10));
        };
        // Registered before it is waited on; only this test's child is ended,
        // so readers other tests run at the same time are left alone.
        while !kill_registered(|child| child.id() == pid) {
            assert!(started.elapsed() < Duration::from_secs(10), "the reader was never registered");
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(reader.join().unwrap().unwrap_err(), ERR_CRASHED);
        assert!(started.elapsed() < Duration::from_secs(30));
    }
}
