//! The `tfevents_*` commands: the native TensorBoard viewer's reads
//! (`docs/tensorboard_viewer_plan.md`).
//!
//! `tfevents_read` follows one event file: it stats it, reads the window after
//! the caller's cursor, and answers the scalars found there plus the new
//! cursor. The viewer merges what comes back; nothing here keeps state, so a
//! second tab on the same file, a popout and a browser client all just work.
//!
//! Both commands go through the viewers' one byte route (`fs::byte_route`,
//! `fs::read_range_routed`): the same remote-vs-local decision and the same
//! confinement as `read_file_bytes`. They only read.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::commands::fs::{self, ByteRoute};
use crate::services::tfevents::{self, Point, Skipped};
use crate::tauri_host::Ctx;

/// The most bytes one `tfevents_read` takes. Above `tfevents::MAX_RECORD` so a
/// record that big always fits whole; a bigger file is read in several calls
/// (`truncated`), so a 300 MB file never lands in memory at once.
const CHUNK: u64 = 24 * 1024 * 1024;

/// Folders descended below the one opened, files listed and folders visited.
const DISCOVER_DEPTH: usize = 3;
const DISCOVER_FILES: usize = 64;
const DISCOVER_DIRS: usize = 512;

/// Whether `name` is a TensorBoard event file (`events.out.tfevents.<time>.<host>…`).
pub fn is_event_file(name: &str) -> bool {
    name.starts_with("events.out.tfevents.")
}

/// Where the previous call stopped, handed back verbatim by the caller.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TfCursor {
    /// Byte offset of the next record to read.
    pub offset: u64,
    /// The file's size at that call: a smaller one now means it was replaced.
    pub size: u64,
    /// Its modification time (seconds), carried for the caller's own use.
    pub mtime: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TfRead {
    pub cursor: TfCursor,
    /// The file shrank (or was replaced by a smaller one): the caller drops
    /// what it kept for it; this answer starts again from byte 0.
    pub reset: bool,
    /// New points only, per tag, each tag cut to the downsampling bound.
    pub scalars: BTreeMap<String, Vec<Point>>,
    /// What this read met and did not draw (see [`Skipped`]).
    pub skipped: Skipped,
    /// More of the file remains: call again at once with the returned cursor.
    pub truncated: bool,
    pub file_version: Option<String>,
}

/// Where to read next: `(reset, offset, max bytes)`. Pure.
///
/// A file that is now smaller than at the last call started over. A cursor
/// beyond the end (a skipped oversized record the writer is still filling)
/// waits: nothing is read until the file reaches it.
pub fn plan_window(cursor: Option<&TfCursor>, size: u64) -> (bool, u64, usize) {
    let (reset, offset) = match cursor {
        Some(c) if size < c.size => (true, 0),
        Some(c) => (false, c.offset),
        None => (false, 0),
    };
    let max = if offset >= size { 0 } else { (size - offset).min(CHUNK) as usize };
    (reset, offset, max)
}

/// Turn the window read into the answer. Pure, so it is tested without a disk.
pub fn finish(size: u64, mtime: u64, reset: bool, offset: u64, bytes: &[u8]) -> TfRead {
    let scan = tfevents::scan(bytes, offset);
    let truncated = scan.next_offset > offset && scan.next_offset < size;
    let scalars = scan
        .scalars
        .into_iter()
        .map(|(tag, points)| (tag, tfevents::downsample(points, tfevents::DEFAULT_DOWNSAMPLE)))
        .collect();
    TfRead {
        cursor: TfCursor { offset: scan.next_offset, size, mtime },
        reset,
        scalars,
        skipped: scan.skipped,
        truncated,
        file_version: scan.file_version,
    }
}

/// Read the part of an event file after `cursor` (the whole file when absent).
///
/// `path` is absolute, `project_id` is the viewer's scope; remote projects read
/// the host over SFTP, ranged, so a refresh moves the new bytes only.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn tfevents_read(
    path: String,
    project_id: Option<String>,
    cursor: Option<TfCursor>,
    ctx: Ctx,
) -> Result<TfRead, String> {
    let pool = ctx.get::<crate::services::remote::RemotePoolState>();
    // The window is a pure function of the cursor and the size the stat saw, so
    // the answer re-derives it from that size instead of carrying it out.
    let read = fs::read_range_routed(path, project_id, pool, move |size, _mtime| {
        let (_, offset, max) = plan_window(cursor.as_ref(), size);
        (offset, max)
    })
    .await?;
    let (reset, offset, _) = plan_window(cursor.as_ref(), read.size);
    app_core::rt::try_blocking("tfevents", move || {
        Ok(finish(read.size, read.mtime, reset, offset, &read.bytes))
    })
    .await
}

/// One event file found under a folder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TfFile {
    pub path: String,
    pub size: u64,
    pub mtime: u64,
}

/// The event files under a folder, at most [`DISCOVER_DEPTH`] levels down and
/// [`DISCOVER_FILES`] of them, for "Open as training runs". Links are not
/// followed. A remote folder is listed over the connected session and is
/// refused while the host is not connected (it never dials).
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn tfevents_discover(
    path: String,
    project_id: Option<String>,
    ctx: Ctx,
) -> Result<Vec<TfFile>, String> {
    match fs::byte_route(&path, project_id.as_deref())? {
        ByteRoute::Remote(target) => {
            let pool = ctx.get::<crate::services::remote::RemotePoolState>();
            let Some(sftp) = fs::pooled(pool, &target).await else {
                return Err("not connected to the host".to_string());
            };
            discover_remote(&sftp, &path).await
        }
        ByteRoute::Local => {
            app_core::rt::try_blocking("tfevents", move || {
                discover_local(&path, project_id.as_deref())
            })
            .await
        }
    }
}

async fn discover_remote(
    sftp: &openssh_sftp_client::Sftp,
    root: &str,
) -> Result<Vec<TfFile>, String> {
    use crate::services::sftp::{list_dir_raw_on, SyncKind};
    let mut out = Vec::new();
    let mut queue = std::collections::VecDeque::from([(root.to_string(), 0usize)]);
    let mut visited = 0;
    while let Some((dir, depth)) = queue.pop_front() {
        visited += 1;
        if visited > DISCOVER_DIRS || out.len() >= DISCOVER_FILES {
            break;
        }
        // The top folder's failure is the caller's answer; a deeper one is
        // just a folder we may not read.
        let entries = match list_dir_raw_on(sftp, &dir).await {
            Ok(e) => e,
            Err(e) if depth == 0 => return Err(e),
            Err(_) => continue,
        };
        for e in entries {
            let child = fs::join_remote_dir(&dir, &e.name);
            match e.kind {
                SyncKind::File if is_event_file(&e.name) && out.len() < DISCOVER_FILES => {
                    out.push(TfFile { path: child, size: e.size, mtime: e.modified_secs.unwrap_or(0) });
                }
                SyncKind::Dir if depth < DISCOVER_DEPTH => queue.push_back((child, depth + 1)),
                _ => {}
            }
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

/// Local walk. The start must lie inside the scope's roots; below it only real
/// folders are entered (a link is never followed), and every file found is
/// read later through `open_confined` like any other.
pub fn discover_local(path: &str, scope_id: Option<&str>) -> Result<Vec<TfFile>, String> {
    let root = PathBuf::from(path);
    fs::confine_abs(&root, scope_id)?;
    discover_walk(root)
}

/// [`discover_local`] without the confinement check (the walk itself).
pub fn discover_walk(root: PathBuf) -> Result<Vec<TfFile>, String> {
    let mut out = Vec::new();
    let mut queue = std::collections::VecDeque::from([(root, 0usize)]);
    let mut visited = 0;
    while let Some((dir, depth)) = queue.pop_front() {
        visited += 1;
        if visited > DISCOVER_DIRS || out.len() >= DISCOVER_FILES {
            break;
        }
        let rd = match std::fs::read_dir(&dir) {
            Ok(r) => r,
            Err(e) if depth == 0 => return Err(e.to_string()),
            Err(_) => continue,
        };
        for entry in rd.flatten() {
            let Ok(kind) = entry.file_type() else { continue };
            let name = entry.file_name().to_string_lossy().into_owned();
            if kind.is_dir() && depth < DISCOVER_DEPTH {
                queue.push_back((entry.path(), depth + 1));
            } else if kind.is_file() && is_event_file(&name) && out.len() < DISCOVER_FILES {
                let Ok(meta) = entry.metadata() else { continue };
                out.push(TfFile {
                    path: fs::display_path(&entry.path()),
                    size: meta.len(),
                    mtime: meta.modified().map(crate::clock::unix_secs).unwrap_or(0),
                });
            }
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

#[cfg(test)]
mod tests;
