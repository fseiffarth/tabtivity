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
    /// Chats whose CLI takes a pasted picture path as a picture (Claude),
    /// noted at spawn: their inbox picture references get a paste
    /// ([`picture_pastes_in`]).
    picture_chats: HashSet<String>,
    /// Per chat: the word being typed, for [`picture_pastes_in`].
    words: HashMap<String, PictureRefs>,
}

fn state() -> &'static Mutex<State> {
    static STATE: OnceLock<Mutex<State>> = OnceLock::new();
    STATE.get_or_init(Default::default)
}

/// Tie PTY `tab` to chat `uid`; called by the spawn gate, whose uid is the
/// backend's own (uuid-shaped, checked). `pictures`: the chat's CLI takes a
/// pasted picture path as a picture (`AssistantCli::takes_pasted_pictures`).
pub fn note_chat(tab: &str, uid: &str, pictures: bool) {
    let mut st = state().lock_ok();
    if st.chats.len() >= MAX_CHATS && !st.chats.contains_key(tab) {
        st.chats.clear();
    }
    st.chats.insert(tab.to_string(), uid.to_string());
    if st.picture_chats.len() >= MAX_CHATS && !st.picture_chats.contains(uid) {
        st.picture_chats.clear();
    }
    if pictures {
        st.picture_chats.insert(uid.to_string());
    } else {
        st.picture_chats.remove(uid);
    }
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

// ---------------------------------------------------------------------------
// Pictures for a chat whose CLI has no file tool.
//
// A picture reaches a chat as `@<inbox>/<leaf>` (the phone's upload, a drop, a
// pasted image), and Claude Code 2.1.322 no longer reads an `@` picture
// itself: it leaves the reference for the model's `Read` tool, which a Tabby
// chat does not have (`--tools WebSearch`), so the model saw only the path
// (2026-11-10; text files still arrive). What Claude does take as a picture
// is a bracketed paste of the file's absolute path, alone: it reads the file
// itself and shows `[Image #N]`. So the user's own bytes into such a chat
// get that paste after each inbox picture reference, here in the backend,
// which alone knows the chat's folder (no path crosses to the phone or the
// renderer). The reference stays, so the chat still draws the picture and
// the transcript reader drops the `[Image #N]` again
// (`agent_session::claude_prompt_text`).
// ---------------------------------------------------------------------------

/// How long an Enter waits after a picture paste it would otherwise follow
/// at once. Claude reads and scales the picture before it takes the paste,
/// and an Enter in the same write as the paste is lost (the prompt is left
/// unsent); an 11.5 MB photo took about 200 ms on 2.1.322.
pub const PICTURE_SUBMIT_HOLD: std::time::Duration = std::time::Duration::from_millis(1000);

/// The longest word followed; a longer one is no reference.
const MAX_WORD: usize = 512;

/// The picture types Claude Code takes as an image.
const PICTURE_EXTENSIONS: [&str; 5] = ["png", "jpg", "jpeg", "gif", "webp"];

const PASTE_START: &[u8] = b"\x1b[200~";
const PASTE_END: &[u8] = b"\x1b[201~";

/// One chat's input, followed far enough to see an inbox reference end.
#[derive(Default)]
struct PictureRefs {
    /// The bytes typed since the last blank or key.
    word: Vec<u8>,
    /// The word outgrew [`MAX_WORD`]: no reference.
    overflow: bool,
    /// Inside a bracketed paste of the user's own: nothing is added there.
    pasting: bool,
}

impl PictureRefs {
    fn reset(&mut self) {
        self.word.clear();
        self.overflow = false;
    }

    /// The word just ended: the leaf it names in the inbox, if it is a
    /// picture reference.
    fn take_reference(&mut self) -> Option<String> {
        let leaf = (!self.overflow).then(|| picture_leaf(&self.word)).flatten();
        self.reset();
        leaf
    }

    /// `bytes` with a paste of each picture reference's file put in after the
    /// blank that ends it, split where an Enter must wait
    /// ([`PICTURE_SUBMIT_HOLD`]). `None` when nothing was added.
    fn feed(&mut self, bytes: &[u8], resolve: impl Fn(&str) -> Option<String>) -> Option<Vec<Vec<u8>>> {
        let mut pieces = Vec::new();
        let mut out = Vec::with_capacity(bytes.len());
        let mut added = false;
        let mut i = 0;
        while i < bytes.len() {
            let b = bytes[i];
            if b == 0x1b {
                let rest = &bytes[i..];
                for (marker, pasting) in [(PASTE_START, true), (PASTE_END, false)] {
                    if rest.starts_with(marker) {
                        self.pasting = pasting;
                    }
                }
                self.reset();
                out.push(b);
                i += 1;
                continue;
            }
            if self.pasting {
                out.push(b);
                i += 1;
                continue;
            }
            match b {
                b' ' | b'\t' | b'\n' | b'\r' => match self.take_reference().and_then(|leaf| resolve(&leaf)) {
                    Some(path) => {
                        added = true;
                        let paste = [PASTE_START, path.as_bytes(), PASTE_END].concat();
                        if b == b'\r' {
                            out.push(b' ');
                            out.extend_from_slice(&paste);
                            pieces.push(std::mem::take(&mut out));
                            out.push(b);
                        } else {
                            out.push(b);
                            out.extend_from_slice(&paste);
                        }
                    }
                    None => out.push(b),
                },
                0x7f | 0x08 => {
                    if !self.overflow {
                        self.word.pop();
                    }
                    out.push(b);
                }
                c if c < 0x20 => {
                    self.reset();
                    out.push(b);
                }
                _ => {
                    if self.word.len() < MAX_WORD {
                        self.word.push(b);
                    } else {
                        self.overflow = true;
                    }
                    out.push(b);
                }
            }
            i += 1;
        }
        if !added {
            return None;
        }
        pieces.push(out);
        Some(pieces)
    }
}

/// The inbox leaf `word` refers to when it is a picture reference
/// `@<inbox>/<leaf>` (the current folder name or the former one), read as the
/// chat reads one (`mobile-web/src/terminal/inboxRefs.ts`): the leaf is a run
/// of letters, digits, `.`, `_`, `-`, without a sentence's closing dots.
fn picture_leaf(word: &[u8]) -> Option<String> {
    let word = std::str::from_utf8(word).ok()?.strip_prefix('@')?;
    let rest = [crate::brand::INBOX_DIR, crate::brand::LEGACY_INBOX_DIR]
        .into_iter()
        .find_map(|dir| word.strip_prefix(dir)?.strip_prefix('/'))?;
    let end = rest.find(|c: char| !(c.is_alphanumeric() || matches!(c, '.' | '_' | '-'))).unwrap_or(rest.len());
    let leaf = rest[..end].trim_end_matches('.');
    let (_, ext) = leaf.rsplit_once('.')?;
    let ext = ext.to_ascii_lowercase();
    (!leaf.starts_with('.') && PICTURE_EXTENSIONS.contains(&ext.as_str())).then(|| leaf.to_string())
}

/// The absolute path of picture `leaf` in chat `uid`'s inbox, as the chat's
/// CLI sees it (the fence binds the chat folder at its own path): a plain
/// file in a real folder of the chat, no link on the way down from the chat
/// folder (the agent can write there), and no blank in the path (a paste is
/// split at one). The current inbox folder first, then the former one.
fn chat_picture(state_dir: &Path, uid: &str, leaf: &str) -> Option<String> {
    let chat = crate::services::assistant::chat_dir(state_dir, uid).ok()?;
    if !std::fs::symlink_metadata(&chat).is_ok_and(|meta| meta.is_dir()) {
        return None;
    }
    let found = [crate::brand::INBOX_DIR, crate::brand::LEGACY_INBOX_DIR].into_iter().find_map(|dir| {
        let mut path = chat.clone();
        for part in dir.split('/') {
            path.push(part);
            if !std::fs::symlink_metadata(&path).is_ok_and(|meta| meta.is_dir()) {
                return None;
            }
        }
        path.push(leaf);
        std::fs::symlink_metadata(&path).is_ok_and(|meta| meta.is_file()).then_some(path)
    })?;
    let path = found.to_str()?;
    (!path.chars().any(char::is_whitespace)).then(|| path.to_string())
}

/// The writes that deliver `bytes`, typed into chat `uid`, to its PTY: the
/// bytes with a paste of each inbox picture they reference, in pieces to be
/// written [`PICTURE_SUBMIT_HOLD`] apart. `None` for a chat whose CLI was not
/// noted as taking pasted pictures, or when nothing was added: write `bytes`.
pub fn picture_pastes_in(state_dir: &Path, uid: &str, bytes: &[u8]) -> Option<Vec<Vec<u8>>> {
    let mut st = state().lock_ok();
    if !st.picture_chats.contains(uid) {
        return None;
    }
    if st.words.len() >= MAX_CHATS && !st.words.contains_key(uid) {
        st.words.clear();
    }
    st.words.entry(uid.to_string()).or_default().feed(bytes, |leaf| chat_picture(state_dir, uid, leaf))
}

/// [`picture_pastes_in`] for the PTY `tab`, under the live state dir.
pub fn tab_picture_pastes(tab: &str, bytes: &[u8]) -> Option<Vec<Vec<u8>>> {
    let uid = chat_of_tab(tab)?;
    picture_pastes_in(&crate::storage::state_dir(), &uid, bytes)
}

/// Mark chat `uid` as one whose CLI takes pasted pictures (the phone's
/// bridge, which may run where the spawn did not and reads it off the tab).
pub fn note_picture_chat(uid: &str) {
    let mut st = state().lock_ok();
    if st.picture_chats.len() >= MAX_CHATS && !st.picture_chats.contains(uid) {
        st.picture_chats.clear();
    }
    st.picture_chats.insert(uid.to_string());
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
            ("the window's keystrokes, for pictures", body(terminal, "pub async fn pty_write("), "assistant_attach::tab_picture_pastes"),
            ("the phone's bytes, for pictures", body(bridge, "pub async fn attach("), "assistant_attach::picture_pastes_in"),
        ] {
            assert!(text.contains(needle), "{what} no longer calls {needle}");
        }
    }

    fn inbox_ref(leaf: &str) -> String {
        format!("@{}/{leaf}", crate::brand::INBOX_DIR)
    }

    fn paste(path: &str) -> Vec<u8> {
        [PASTE_START, path.as_bytes(), PASTE_END].concat()
    }

    #[test]
    fn a_picture_reference_is_read_as_the_chat_reads_one() {
        assert_eq!(picture_leaf(inbox_ref("a-1_b.JPG").as_bytes()).as_deref(), Some("a-1_b.JPG"));
        assert_eq!(picture_leaf(format!("{}.", inbox_ref("p.png")).as_bytes()).as_deref(), Some("p.png"));
        assert_eq!(picture_leaf(format!("{},", inbox_ref("p.webp")).as_bytes()).as_deref(), Some("p.webp"));
        assert_eq!(picture_leaf(format!("@{}/old.gif", crate::brand::LEGACY_INBOX_DIR).as_bytes()).as_deref(), Some("old.gif"));
        for word in [inbox_ref("notes.txt"), inbox_ref("noext"), inbox_ref(".jpg"), inbox_ref(""), "@pic.jpg".into(), inbox_ref("p.jpg")[1..].to_string()] {
            assert_eq!(picture_leaf(word.as_bytes()), None, "{word}");
        }
    }

    #[test]
    fn a_paste_follows_the_blank_after_a_picture_reference() {
        let mut refs = PictureRefs::default();
        let resolve = |leaf: &str| Some(format!("/chat/inbox/{leaf}"));
        let typed = format!("{} where is this?", inbox_ref("p.jpg"));
        let pieces = refs.feed(typed.as_bytes(), resolve).unwrap();
        let want = [inbox_ref("p.jpg").as_bytes(), b" ", &paste("/chat/inbox/p.jpg"), b"where is this?"].concat();
        assert_eq!(pieces, vec![want]);
        // Typed in pieces, the reference is still seen whole.
        let mut refs = PictureRefs::default();
        let typed = inbox_ref("p.jpg");
        let (head, tail) = typed.split_at(9);
        assert_eq!(refs.feed(head.as_bytes(), resolve), None);
        assert_eq!(refs.feed(tail.as_bytes(), resolve), None);
        assert_eq!(refs.feed(b"\n", resolve), Some(vec![[b"\n".as_slice(), &paste("/chat/inbox/p.jpg")].concat()]));
    }

    #[test]
    fn an_enter_right_after_a_picture_reference_waits_for_the_paste() {
        let mut refs = PictureRefs::default();
        let resolve = |leaf: &str| Some(format!("/chat/inbox/{leaf}"));
        assert_eq!(refs.feed(inbox_ref("p.png").as_bytes(), resolve), None);
        let pieces = refs.feed(b"\r", resolve).unwrap();
        assert_eq!(pieces, vec![[b" ".as_slice(), &paste("/chat/inbox/p.png")].concat(), b"\r".to_vec()]);
    }

    #[test]
    fn nothing_is_added_for_other_words_keys_or_the_users_own_paste() {
        let resolve = |leaf: &str| Some(format!("/chat/inbox/{leaf}"));
        let mut refs = PictureRefs::default();
        assert_eq!(refs.feed(format!("{} more", inbox_ref("notes.txt")).as_bytes(), resolve), None);
        assert_eq!(refs.feed(b"mail me@example.org ", resolve), None);
        // A reference the user pasted themselves stays as pasted.
        let pasted = [PASTE_START, inbox_ref("p.jpg").as_bytes(), b" hi", PASTE_END].concat();
        assert_eq!(refs.feed(&pasted, resolve), None);
        // A key in the middle (Ctrl+A Ctrl+K resets the line) breaks the word.
        let broken = format!("{}\u{1}\u{b}x ", &inbox_ref("p.jpg")[..5]);
        assert_eq!(refs.feed(broken.as_bytes(), resolve), None);
        // Backspace edits the word being typed.
        let mut refs = PictureRefs::default();
        let typed = format!("{}x\u{7f} ", inbox_ref("p.jpg"));
        assert!(refs.feed(typed.as_bytes(), resolve).is_some());
        // A file that is not there is left as typed.
        assert_eq!(PictureRefs::default().feed(format!("{} ", inbox_ref("p.jpg")).as_bytes(), |_| None), None);
    }

    #[test]
    fn only_a_noted_chats_own_inbox_picture_is_pasted() {
        let tmp = tempfile::tempdir().unwrap();
        let uid = fresh_uid(5);
        let chat = crate::services::assistant::chat_dir(tmp.path(), &uid).unwrap();
        let inbox = crate::brand::INBOX_DIR.split('/').fold(chat.clone(), |path, part| path.join(part));
        std::fs::create_dir_all(&inbox).unwrap();
        std::fs::write(inbox.join("p.jpg"), b"jpeg").unwrap();
        let typed = format!("{} hi", inbox_ref("p.jpg"));
        // Not noted (Codex, OpenCode): nothing.
        assert_eq!(picture_pastes_in(tmp.path(), &uid, typed.as_bytes()), None);
        note_picture_chat(&uid);
        let pieces = picture_pastes_in(tmp.path(), &uid, typed.as_bytes()).unwrap();
        let path = inbox.join("p.jpg").to_string_lossy().into_owned();
        assert!(pieces[0].windows(path.len()).any(|w| w == path.as_bytes()), "{pieces:?}");
        // A missing file, or a folder that is not a real one, gets nothing.
        assert_eq!(picture_pastes_in(tmp.path(), &uid, format!("{} hi", inbox_ref("q.jpg")).as_bytes()), None);
        assert_eq!(chat_picture(tmp.path(), &uid, "q.jpg"), None);
        #[cfg(unix)]
        {
            let outside = tmp.path().join("outside");
            std::fs::create_dir_all(&outside).unwrap();
            std::fs::write(outside.join("s.jpg"), b"secret").unwrap();
            std::os::unix::fs::symlink(outside.join("s.jpg"), inbox.join("link.jpg")).unwrap();
            assert_eq!(chat_picture(tmp.path(), &uid, "link.jpg"), None);
            let top = chat.join(crate::brand::INBOX_DIR.split('/').next().unwrap());
            std::fs::rename(&top, chat.join("moved")).unwrap();
            std::os::unix::fs::symlink(chat.join("moved"), &top).unwrap();
            assert_eq!(chat_picture(tmp.path(), &uid, "p.jpg"), None);
        }
    }

    #[test]
    fn a_chat_is_found_by_its_tab_and_by_its_tmux_session() {
        note_chat("assistant:t-attach", UID, false);
        assert_eq!(chat_of_tab("assistant:t-attach").as_deref(), Some(UID));
        assert_eq!(chat_of_tab("assistant:other"), None);
        assert!(!tab_attached("assistant:other"));
        let session = crate::services::assistant::tmux_session_for(UID);
        assert_eq!(chat_of_tmux(&session).as_deref(), Some(UID));
        assert_eq!(chat_of_tmux("not-a-chat"), None);
        assert_eq!(chat_of_tmux(&format!("{}x", crate::services::assistant::tmux_session_for(""))), None);
    }
}
