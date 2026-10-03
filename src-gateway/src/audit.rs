//! The audit log (hosted plan §8): `(time, user, device, verb, resource,
//! result)` for logins, pairings, revocations and admin actions. Not per
//! command, no terminal content, no IP addresses, no free text; retention is
//! bounded by row count. Each user reads their own rows.
//!
//! JSON lines in the gateway's state dir. The gateway and the helper both
//! append; a line is one `write` of under `PIPE_BUF`, so appends from the two
//! do not interleave.

use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const AUDIT_FILE: &str = "audit.jsonl";
/// Rows kept after a trim.
pub const KEEP_ROWS: usize = 20_000;
/// The file is trimmed once it passes this size.
const TRIM_AT_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Row {
    pub time: u64,
    pub user: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device: Option<String>,
    pub verb: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource: Option<String>,
    pub result: String,
}

impl Row {
    pub fn new(user: &str, device: Option<&str>, verb: &str, result: &str) -> Self {
        Row { time: crate::now(), user: user.into(), device: device.map(Into::into), verb: verb.into(), resource: None, result: result.into() }
    }

    pub fn resource(mut self, resource: &str) -> Self {
        self.resource = Some(resource.into());
        self
    }
}

#[derive(Debug, Clone)]
pub struct AuditLog {
    path: PathBuf,
}

impl AuditLog {
    pub fn in_dir(dir: &Path) -> Self {
        Self { path: dir.join(AUDIT_FILE) }
    }

    /// Append one row; best effort (an audit failure is reported on stderr,
    /// never turns a request into an error).
    pub fn record(&self, row: Row) {
        if let Err(error) = self.append(&row) {
            eprintln!("audit: {}: {error}", self.path.display());
        }
    }

    fn append(&self, row: &Row) -> std::io::Result<()> {
        let mut line = serde_json::to_vec(row).map_err(std::io::Error::other)?;
        line.push(b'\n');
        let mut options = std::fs::OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            // The helper appends as root in the gateway's own directory:
            // no planted symlink or FIFO is followed or waited on.
            options.mode(0o640).custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
        }
        let mut file = options.open(&self.path)?;
        if !file.metadata()?.is_file() {
            return Err(std::io::Error::other("not a regular file"));
        }
        file.write_all(&line)?;
        if file.metadata().map(|m| m.len()).unwrap_or(0) > TRIM_AT_BYTES {
            drop(file);
            self.trim(KEEP_ROWS)?;
        }
        Ok(())
    }

    /// Keep the newest `keep` rows.
    pub fn trim(&self, keep: usize) -> std::io::Result<()> {
        let text = String::from_utf8_lossy(&crate::read_regular(&self.path)?).into_owned();
        let lines: Vec<&str> = text.lines().collect();
        let start = lines.len().saturating_sub(keep);
        let mut out = lines[start..].join("\n");
        out.push('\n');
        crate::write_atomic(&self.path, out.as_bytes(), 0o640)
    }

    /// Every row, oldest first (unparseable lines skipped).
    pub fn rows(&self) -> Vec<Row> {
        String::from_utf8_lossy(&crate::read_regular(&self.path).unwrap_or_default())
            .lines()
            .filter_map(|l| serde_json::from_str(l).ok())
            .collect()
    }

    /// A user's own rows, newest first, at most `limit`.
    pub fn rows_for(&self, user: &str, limit: usize) -> Vec<Row> {
        let mut rows: Vec<Row> = self.rows().into_iter().filter(|r| r.user == user).collect();
        rows.reverse();
        rows.truncate(limit);
        rows
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rows_append_trim_and_are_read_per_user() {
        let dir = tempfile::tempdir().unwrap();
        let log = AuditLog::in_dir(dir.path());
        for i in 0..5 {
            log.record(Row::new(if i % 2 == 0 { "alice" } else { "bob" }, Some("dev_0000000"), "login", "ok").resource(&format!("r{i}")));
        }
        assert_eq!(log.rows().len(), 5);
        let alice = log.rows_for("alice", 10);
        assert_eq!(alice.len(), 3);
        assert_eq!(alice[0].resource.as_deref(), Some("r4"), "newest first");
        log.trim(2).unwrap();
        assert_eq!(log.rows().len(), 2);
        assert_eq!(log.rows()[0].resource.as_deref(), Some("r3"));
    }
}
