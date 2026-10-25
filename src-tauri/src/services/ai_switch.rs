//! The AI switch (`docs/ai_switch_plan.md`): one machine-wide flag,
//! `Settings.ai_off`, set by the side panel's power button. While AI is off,
//! nothing starts new AI work — no agent spawn, no input typed into an agent,
//! no scheduled prompt, completion or mail AI call. Agents already running
//! keep running; only what would reach them is refused.
//!
//! The window and the Mobile sidecar both read `settings.json`, so both obey
//! the one file. A read is a `stat` while the file is unchanged: `pty_write`
//! asks on every keystroke to an agent.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

/// The refusal every gate returns, for the frontend to recognise.
pub const AI_OFF: &str = "ai_off";

/// Whether the user switched AI off.
pub fn is_off() -> bool {
    is_off_at(&crate::storage::settings_path())
}

/// `Err(AI_OFF)` while AI is off.
pub fn check() -> Result<(), String> {
    if is_off() {
        Err(AI_OFF.to_string())
    } else {
        Ok(())
    }
}

/// The last reading, keyed by the file's identity on disk. The inode is the
/// sharpest part: `settings.json` is replaced by rename at every write
/// (`storage`), so a toggle within one mtime tick still changes it.
struct Reading {
    path: PathBuf,
    identity: (Option<SystemTime>, u64, u64),
    off: bool,
}

#[cfg(unix)]
fn inode(meta: &std::fs::Metadata) -> u64 {
    std::os::unix::fs::MetadataExt::ino(meta)
}

#[cfg(not(unix))]
fn inode(_meta: &std::fs::Metadata) -> u64 {
    0
}

static LAST: Mutex<Option<Reading>> = Mutex::new(None);

/// [`is_off`] for the settings file at `path`. A missing or unreadable file
/// reads as on, the default every other setting falls back to.
pub fn is_off_at(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    let identity = (meta.modified().ok(), meta.len(), inode(&meta));
    let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(r) = last.as_ref() {
        if r.path == path && r.identity == identity && identity.0.is_some() {
            return r.off;
        }
    }
    let off = std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|v| v.get("ai_off").and_then(serde_json::Value::as_bool))
        .unwrap_or(false);
    *last = Some(Reading { path: path.to_path_buf(), identity, off });
    off
}

/// What of `data` still reaches an agent while AI is off: `None` when all of
/// it may — only Ctrl+C and terminal control sequences (Esc, arrows, focus
/// and mouse reports, the terminal's answers to the program's queries), so a
/// running agent can always be stopped or steered. Otherwise `Some` of what
/// is kept: a lone Ctrl+C when the input held one (the renderer batches
/// keystrokes, and an interrupt must not drown in typed text), else nothing.
/// Typed text, Enter, Alt+key and a bracketed paste never pass.
pub fn filter_while_off(data: &[u8]) -> Option<Vec<u8>> {
    if only_controls(data) {
        None
    } else if data.contains(&0x03) {
        Some(vec![0x03])
    } else {
        Some(Vec::new())
    }
}

/// A CSI sequence that only moves, scrolls or answers — an allowlist, so no
/// encoding of Enter (kitty `u`, modifyOtherKeys `27;…~`), Shift+Tab (`Z`,
/// which cycles a CLI's permission mode) or bracketed paste gets through.
/// `params` are the parameter bytes, `last` the final byte.
fn steering_csi(params: &[u8], last: u8) -> bool {
    match last {
        // Arrows, Home, End; focus in/out.
        b'A' | b'B' | b'C' | b'D' | b'H' | b'F' | b'I' | b'O' => params.iter().all(|b| b.is_ascii_digit() || *b == b';'),
        // SGR mouse reports (`<b;x;y` M/m).
        b'M' | b'm' => params.first() == Some(&b'<'),
        // The terminal's answers: device attributes, cursor position.
        b'c' | b'R' => true,
        // Insert/Delete/PgUp/PgDn/Home/End keys (`1`…`6`, with modifiers).
        b'~' => params.split(|b| *b == b';').next().is_some_and(|key| matches!(key, b"1" | b"2" | b"3" | b"4" | b"5" | b"6")),
        _ => false,
    }
}

/// Whether `data` is nothing but Ctrl+C and whole escape sequences.
fn only_controls(data: &[u8]) -> bool {
    let mut i = 0;
    while i < data.len() {
        match data[i] {
            0x03 => i += 1,
            0x1b => match data.get(i + 1) {
                // A lone Esc, or Esc Esc.
                None | Some(0x1b) => i += 1,
                Some(b'[') => {
                    let mut j = i + 2;
                    while j < data.len() && (0x30..=0x3f).contains(&data[j]) {
                        j += 1;
                    }
                    let (params, Some(&last)) = (&data[i + 2..j], data.get(j)) else {
                        return false;
                    };
                    if !steering_csi(params, last) {
                        return false;
                    }
                    i = j + 1;
                }
                // SS3 arrows, Home, End (application cursor mode) — never its
                // keypad Enter (`ESC O M`).
                Some(b'O') => match data.get(i + 2) {
                    Some(b'A' | b'B' | b'C' | b'D' | b'H' | b'F') => i += 3,
                    _ => return false,
                },
                // OSC: the terminal's answer to a colour or title query.
                Some(b']') => {
                    let rest = &data[i + 2..];
                    let bel = rest.iter().position(|&b| b == 0x07).map(|p| p + 1);
                    let st = rest.windows(2).position(|w| w == b"\x1b\\").map(|p| p + 2);
                    match bel.into_iter().chain(st).min() {
                        Some(end) => i += 2 + end,
                        None => return false,
                    }
                }
                // Alt+key: a typed character.
                Some(_) => return false,
            },
            _ => return false,
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, text: &str) {
        std::fs::write(path, text).unwrap();
    }

    #[test]
    fn unset_missing_and_unreadable_read_as_on() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        assert!(!is_off_at(&path));
        write(&path, "{\"debug\":true}");
        assert!(!is_off_at(&path));
        write(&path, "{not json");
        assert!(!is_off_at(&path));
    }

    #[test]
    fn a_rewrite_is_seen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        write(&path, "{\"ai_off\":true}");
        assert!(is_off_at(&path));
        // A different length, so the change shows even within one mtime tick.
        write(&path, "{\"ai_off\":false }");
        assert!(!is_off_at(&path));
        write(&path, "{\"ai_off\": true}");
        assert!(is_off_at(&path));
    }

    #[test]
    fn only_interrupts_and_steering_pass_while_off() {
        for passes in [&b"\x03"[..], b"\x1b", b"\x1b\x1b", b"\x1b[A", b"\x1b[I", b"\x1bOA",
            b"\x1b[<0;10;5M", b"\x1b[?1;2c", b"\x1b]11;rgb:0/0/0\x07", b"\x1b]11;rgb:0/0/0\x1b\\",
            b"\x1b[A\x1b[B\x03", b"\x1b[3~", b"\x1b[5;5~", b"\x1b[1;5C", b"\x1b[O", b"\x1b[24;80R", b""] {
            assert_eq!(filter_while_off(passes), None, "{passes:?}");
        }
        for dropped in [&b"hello"[..], b"\r", b"\x1b\r", b"\x1bh", b"\x1bhello", b"\x1b[200~text\x1b[201~",
            b"\x1b[A\r", b"\x1b]11;unterminated", b"\x1bOM", b"\x1b[13u", b"\x1b[27;5;13~", b"\x1b[Z",
            b"\x1b[9;2u"] {
            assert_eq!(filter_while_off(dropped), Some(Vec::new()), "{dropped:?}");
        }
        // An interrupt batched with typed text still goes through, alone.
        assert_eq!(filter_while_off(b"abc\x03"), Some(vec![0x03]));
        assert_eq!(filter_while_off(b"\x03def\r"), Some(vec![0x03]));
    }
}
