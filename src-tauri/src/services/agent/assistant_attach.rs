//! Whether a Tabby chat has had an `@` attachment (threat recheck 2026-11-04,
//! gap 78). Once it has, the web lane (`services::web_lane`) cuts the query
//! string and fragment off every `web_fetch` URL, caps the path and caps
//! `web_search` queries, so the contents of an attached file cannot ride out
//! in an address a hostile page asked the model to fetch.
//!
//! The backend decides, never the renderer or the phone: the flag is set
//! where the user's own input enters the chat's PTY (`pty_write` for the
//! window, the phone's terminal bridge for the phone) when it carries an `@`
//! mention, and where a file lands in the chat (`pty_drop_files`, the
//! clipboard image, the phone's upload). It is kept as a marker file
//! `<state>/assistant/attached/<uid>` — outside the chat folder, which the
//! fence mounts read-write, and so beyond any agent's reach — so a restart or
//! a resume does not forget it. A chat's flag is never cleared. The lane finds
//! a chat by its token's tab id, which [`note_chat`] ties to the chat's uid
//! at spawn. AppHandle-free.
//!
//! Residual: this limits what an address can carry (host-name labels and up to
//! [`MAX_PATH_BYTES`] of path still can); it does not close the leak.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use app_core::sync::LockExt;

/// The longest URL path a `web_fetch` of an attached chat keeps, in bytes.
pub const MAX_PATH_BYTES: usize = 64;
/// The longest `web_search` query of an attached chat, in characters.
pub const MAX_QUERY_CHARS: usize = 128;

/// More chats than this in one process and the oldest tie is forgotten (the
/// next spawn of that chat ties it again).
const MAX_CHATS: usize = 512;

#[derive(Default)]
struct State {
    /// PTY id (the web token's tab) -> chat uid, noted at spawn.
    chats: HashMap<String, String>,
    /// Chats known to be attached (cache of the marker files).
    attached: HashSet<String>,
    /// The last user byte seen per chat, so `@` typed one key at a time is
    /// judged by what came before it.
    last_byte: HashMap<String, u8>,
}

fn state() -> &'static Mutex<State> {
    static STATE: OnceLock<Mutex<State>> = OnceLock::new();
    STATE.get_or_init(Default::default)
}

/// Tie PTY `tab` to chat `uid`; called by the spawn gate, whose uid is the
/// backend's own (uuid-shaped, checked).
pub fn note_chat(tab: &str, uid: &str) {
    let mut st = state().lock_ok();
    if st.chats.len() >= MAX_CHATS && !st.chats.contains_key(tab) {
        st.chats.clear();
    }
    st.chats.insert(tab.to_string(), uid.to_string());
}

/// The chat PTY `tab` runs, if it is a Tabby chat spawned by this process.
pub fn chat_of_tab(tab: &str) -> Option<String> {
    state().lock_ok().chats.get(tab).cloned()
}

/// The chat uid in a Tabby chat's tmux session name (`assistant::tmux_session_for`),
/// for the phone's bridge, which knows the session and not the PTY.
pub fn chat_of_tmux(session: &str) -> Option<String> {
    let probe = crate::services::assistant::tmux_session_for("");
    let uid = session.strip_prefix(probe.as_str())?;
    crate::services::agent_session::is_uuid_shaped(uid).then(|| uid.to_string())
}

fn marker(state_dir: &Path, uid: &str) -> PathBuf {
    crate::services::assistant::assistant_root(state_dir).join("attached").join(uid)
}

/// Record that chat `uid` has had an attachment. Silent on failure beyond the
/// in-memory flag (the chat is restricted for this run either way).
pub fn note_attachment_in(state_dir: &Path, uid: &str) {
    if !crate::services::agent_session::is_uuid_shaped(uid) {
        return;
    }
    if !state().lock_ok().attached.insert(uid.to_string()) {
        return;
    }
    let path = marker(state_dir, uid);
    if let Some(dir) = path.parent() {
        let _ = crate::services::agent_home::create_private_dir(dir);
    }
    if let Err(e) = crate::storage::write_private_atomic(&path, b"1\n") {
        eprintln!("assistant_attach: cannot record the attachment: {e}");
    }
}

/// [`note_attachment_in`] under the live state dir.
pub fn note_attachment(uid: &str) {
    note_attachment_in(&crate::storage::state_dir(), uid);
}

/// Whether chat `uid` has had an attachment: remembered in memory, else the
/// marker file.
pub fn attached_in(state_dir: &Path, uid: &str) -> bool {
    if state().lock_ok().attached.contains(uid) {
        return true;
    }
    let found = crate::services::agent_session::is_uuid_shaped(uid) && std::fs::symlink_metadata(marker(state_dir, uid)).is_ok();
    if found {
        state().lock_ok().attached.insert(uid.to_string());
    }
    found
}

/// Whether the chat behind web-lane tab `tab` has had an attachment. A tab
/// this process never tied to a chat has none to find: false.
pub fn tab_attached(tab: &str) -> bool {
    chat_of_tab(tab).is_some_and(|uid| attached_in(&crate::storage::state_dir(), &uid))
}

/// Whether `bytes`, typed or pasted by the user into chat `uid`, carry an `@`
/// mention: an `@` not directly after a word character (so `me@example.org`
/// is not one). Remembers the last byte between calls. Records the
/// attachment when it finds one.
pub fn note_input_in(state_dir: &Path, uid: &str, bytes: &[u8]) -> bool {
    let hit = {
        let mut st = state().lock_ok();
        let mut prev = st.last_byte.get(uid).copied().unwrap_or(b' ');
        let mut hit = false;
        for &b in bytes {
            if b == b'@' && !(prev.is_ascii_alphanumeric() || matches!(prev, b'.' | b'_' | b'-' | b'+')) {
                hit = true;
            }
            prev = b;
        }
        if st.last_byte.len() >= MAX_CHATS && !st.last_byte.contains_key(uid) {
            st.last_byte.clear();
        }
        if let Some(last) = bytes.last() {
            st.last_byte.insert(uid.to_string(), *last);
        }
        hit
    };
    if hit {
        note_attachment_in(state_dir, uid);
    }
    hit
}

/// [`note_input_in`] for the PTY `tab`, under the live state dir; nothing for a
/// PTY that is not a Tabby chat.
pub fn note_tab_input(tab: &str, bytes: &[u8]) {
    if !bytes.contains(&b'@') {
        // Still moves the last byte along for the next call.
        if let Some(uid) = chat_of_tab(tab) {
            if let Some(last) = bytes.last() {
                state().lock_ok().last_byte.insert(uid, *last);
            }
        }
        return;
    }
    if let Some(uid) = chat_of_tab(tab) {
        note_input_in(&crate::storage::state_dir(), &uid, bytes);
    }
}

/// A file landed in PTY `tab`'s chat (a drop, a pasted image): an attachment,
/// whether or not an `@` ever follows. Nothing for a PTY that is not a chat.
pub fn note_tab_file(tab: &str) {
    if let Some(uid) = chat_of_tab(tab) {
        note_attachment(&uid);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const UID: &str = "11111111-2222-4333-8444-555555555555";

    fn fresh_uid(n: u8) -> String {
        format!("aaaaaaaa-bbbb-4ccc-8ddd-{n:012}")
    }

    #[test]
    fn an_at_mention_marks_the_chat_and_an_email_does_not() {
        let tmp = tempfile::tempdir().unwrap();
        let uid = fresh_uid(1);
        assert!(!attached_in(tmp.path(), &uid));
        assert!(!note_input_in(tmp.path(), &uid, b"write to me@example.org please"));
        assert!(!attached_in(tmp.path(), &uid));
        assert!(note_input_in(tmp.path(), &uid, b"what is in @notes.txt"));
        assert!(attached_in(tmp.path(), &uid));
        assert!(marker(tmp.path(), &uid).is_file());
    }

    #[test]
    fn an_at_typed_one_key_at_a_time_counts_after_a_space_not_after_a_word() {
        let tmp = tempfile::tempdir().unwrap();
        let (mail, mention) = (fresh_uid(2), fresh_uid(3));
        for chunk in [&b"me"[..], b"@", b"x"] {
            note_input_in(tmp.path(), &mail, chunk);
        }
        assert!(!attached_in(tmp.path(), &mail));
        for chunk in [&b"see"[..], b" ", b"@", b"x"] {
            note_input_in(tmp.path(), &mention, chunk);
        }
        assert!(attached_in(tmp.path(), &mention));
    }

    #[test]
    fn the_marker_outlives_the_process_and_lives_outside_the_chat_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let uid = fresh_uid(4);
        note_attachment_in(tmp.path(), &uid);
        let chat = crate::services::assistant::chat_dir(tmp.path(), &uid).unwrap();
        assert!(!marker(tmp.path(), &uid).starts_with(&chat));
        assert!(!marker(tmp.path(), &uid).starts_with(crate::services::assistant::work_root(tmp.path())));
        // A restart forgets the memory, not the file.
        state().lock_ok().attached.remove(&uid);
        assert!(attached_in(tmp.path(), &uid));
        // A name that is no uuid never becomes a path.
        note_attachment_in(tmp.path(), "../escape");
        assert!(!attached_in(tmp.path(), "../escape"));
    }

    /// The recorder is only worth what calls it: every way an attachment
    /// enters a chat (the window's keystrokes, a drop, a pasted picture, the
    /// phone's bytes, its upload and desktop-picture routes) must name it. A
    /// source scan, as `nav_gate` does; a removed call fails here.
    #[test]
    fn every_way_an_attachment_enters_a_chat_names_the_recorder() {
        fn body<'a>(src: &'a str, start: &str) -> &'a str {
            let at = src.find(start).unwrap_or_else(|| panic!("`{start}` moved: update this scan"));
            let rest = &src[at..];
            &rest[..rest.find("\n}\n").unwrap_or(rest.len())]
        }
        let terminal = include_str!("../../commands/terminal.rs");
        let host = include_str!("../mobile_control/host.rs");
        let bridge = include_str!("../mobile_control/pty_bridge.rs");
        let launch = include_str!("../launch_prep.rs");
        for (what, text, needle) in [
            ("the window's keystrokes", body(terminal, "pub async fn pty_write("), "assistant_attach::note_tab_input"),
            ("a drop on the tab", body(terminal, "pub async fn pty_drop_files("), "assistant_attach::note_tab_file"),
            ("a pasted picture", body(terminal, "pub async fn pty_paste_clipboard_image("), "assistant_attach::note_tab_file"),
            ("the phone's bytes", body(bridge, "pub async fn attach("), "assistant_attach::note_input_in"),
            ("the phone's upload", body(host, "async fn inbox_upload("), "note_chat_file("),
            ("the phone's desktop picture", body(host, "async fn attach_desktop_image("), "assistant_attach::note_attachment_in"),
            ("the spawn that ties a tab to its chat", body(launch, "fn assistant_gate("), "assistant_attach::note_chat"),
        ] {
            assert!(text.contains(needle), "{what} no longer calls {needle}");
        }
    }

    #[test]
    fn a_chat_is_found_by_its_tab_and_by_its_tmux_session() {
        note_chat("assistant:t-attach", UID);
        assert_eq!(chat_of_tab("assistant:t-attach").as_deref(), Some(UID));
        assert_eq!(chat_of_tab("assistant:other"), None);
        assert!(!tab_attached("assistant:other"));
        let session = crate::services::assistant::tmux_session_for(UID);
        assert_eq!(chat_of_tmux(&session).as_deref(), Some(UID));
        assert_eq!(chat_of_tmux("not-a-chat"), None);
        assert_eq!(chat_of_tmux(&format!("{}x", crate::services::assistant::tmux_session_for(""))), None);
    }
}
