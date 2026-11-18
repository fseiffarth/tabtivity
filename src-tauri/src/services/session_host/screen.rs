//! A session's parsed screen (plan §2, Per session): a `vt100` parser fed every
//! output byte, standing in for what tmux's pane grid gives the Unix side.
//!
//! - [`Screen::capture`]: the visible screen like `capture-pane -p [-J] [-e]`.
//! - [`Screen::history`] / [`Screen::scrollback`]: the rows that scrolled off
//!   the top, ending one row above the visible screen (`-S -N -E -1`), wrapped
//!   rows joined, SGR kept, CRLF line ends for xterm (`normalize_scrollback`'s
//!   rule, `mobile_control::pty_bridge`).
//! - [`Screen::repaint`] / [`Screen::snapshot`]: bytes that redraw the whole
//!   screen and its input modes on a fresh terminal; the snapshot puts the
//!   history in front.
//! - [`Screen::bracketed_paste`]: mode 2004, which [`paste_bytes`] honours.
//!
//! History is kept here, not in vt100's own scrollback: the parser runs with
//! scrollback 0 and every row it pushes off the main screen arrives through
//! `on_scroll` and is stored as its formatted text (bounded by row count), far
//! smaller than vt100's ~40 B per cell. Rows leaving the alternate screen are
//! not history, as in tmux. Known gap: `CSI 3 J` does not clear this history.

use std::collections::VecDeque;
use std::num::NonZeroU16;

use vt100::capture::{BasicFormattedCaptureState, RowContents};

/// The default history bound in rows, below tmux's `TMUX_HISTORY_LINES`
/// (10 000) on the Unix side. Rows are stored as formatted text, so a row costs
/// its text plus SGR, but SGR-heavy agent TUIs can make that several times the
/// width: measure real sessions before raising it (plan §2, Risks).
pub const DEFAULT_HISTORY_ROWS: usize = 2_000;

/// The most output [`complete_prefix`] holds back waiting for the rest of an
/// escape sequence; a longer unterminated sequence is passed on as it is.
pub const MAX_HELD_BACK: usize = 4 << 10;

const PASTE_START: &str = "\x1b[200~";
const PASTE_END: &str = "\x1b[201~";
const SGR_RESET: &str = "\x1b[m";

struct HistRow {
    /// The row as vt100's "basic formatted" text: SGR only, from default attrs.
    text: String,
    /// The row runs on into the next one.
    wrapped: bool,
}

struct Hooks {
    history: VecDeque<HistRow>,
    cap: usize,
    cwd: Option<String>,
}

impl vt100::Callbacks for Hooks {
    fn on_scroll(&mut self, contents: RowContents<'_>, alternate_screen: bool) {
        if alternate_screen || self.cap == 0 {
            return;
        }
        let mut state = BasicFormattedCaptureState::new();
        let mut text = String::new();
        let _ = contents.write_formatted_basic(&mut text, &mut state);
        // The state remembers whether a newline is owed after the row; a
        // second write shows it as a leading '\n' unless the row wrapped.
        let mut probe = String::new();
        let _ = contents.write_formatted_basic(&mut probe, &mut state);
        let wrapped = !probe.starts_with('\n');
        if self.history.len() == self.cap {
            self.history.pop_front();
        }
        self.history.push_back(HistRow { text, wrapped });
    }

    fn unhandled_osc(&mut self, _: &mut vt100::Screen, params: &[&[u8]]) {
        if let Some(cwd) = osc_cwd(params) {
            self.cwd = Some(cwd);
        }
    }
}

/// How a capture renders rows.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CaptureOpts {
    /// Join wrapped rows into one line (tmux `-J`).
    pub join_wrapped: bool,
    /// Keep SGR colours (tmux `-e`). Unjoined captures are always plain.
    pub escapes: bool,
}

pub struct Screen {
    parser: vt100::Parser<Hooks>,
}

fn nz(v: u16) -> NonZeroU16 {
    NonZeroU16::new(v).unwrap_or(NonZeroU16::MIN)
}

impl Screen {
    /// A blank `cols`×`rows` screen keeping up to `history_rows` rows of history.
    pub fn new(cols: u16, rows: u16, history_rows: usize) -> Self {
        let hooks = Hooks { history: VecDeque::new(), cap: history_rows, cwd: None };
        Self { parser: vt100::Parser::new_with_callbacks(nz(rows), nz(cols), 0, hooks) }
    }

    pub fn process(&mut self, bytes: &[u8]) {
        self.parser.process(bytes);
    }

    /// Rows pushed off by a shorter screen become history.
    pub fn resize(&mut self, cols: u16, rows: u16) {
        self.parser.set_size(nz(rows), nz(cols));
    }

    /// `(cols, rows)`.
    pub fn size(&self) -> (u16, u16) {
        let (rows, cols) = self.parser.screen().size();
        (cols.get(), rows.get())
    }

    /// Mode 2004 is on: a paste may be bracketed.
    pub fn bracketed_paste(&self) -> bool {
        self.parser.screen().bracketed_paste()
    }

    pub fn alternate_screen(&self) -> bool {
        self.parser.screen().alternate_screen()
    }

    /// The last cwd an OSC 7 or OSC 9;9 reported.
    pub fn cwd(&self) -> Option<&str> {
        self.parser.callbacks().cwd.as_deref()
    }

    /// History rows held.
    pub fn history_len(&self) -> usize {
        self.parser.callbacks().history.len()
    }

    /// The visible screen, every line ending in `\n`.
    pub fn capture(&self, opts: CaptureOpts) -> String {
        let screen = self.parser.screen();
        let mut out = String::new();
        if opts.join_wrapped {
            let formatted = screen.contents_formatted_basic();
            if opts.escapes {
                out.push_str(&formatted);
                if formatted.contains('\x1b') {
                    out.push_str(SGR_RESET);
                }
            } else {
                out.extend(vt100::capture::basic_formatted_to_plain(&formatted));
            }
            out.push('\n');
        } else {
            let (_, cols) = screen.size();
            for row in screen.rows(0, cols.get()) {
                out.push_str(&row);
                out.push('\n');
            }
        }
        out
    }

    /// The last `lines` history rows (oldest first), ending one row above the
    /// visible screen; every line ends in `\n`. Empty without history.
    pub fn history(&self, lines: usize, opts: CaptureOpts) -> String {
        let history = &self.parser.callbacks().history;
        let start = history.len().saturating_sub(lines);
        let mut out = String::new();
        let last = history.len().saturating_sub(1);
        for (i, row) in history.iter().enumerate().skip(start) {
            if opts.escapes && opts.join_wrapped {
                out.push_str(&row.text);
                if row.text.contains('\x1b') {
                    out.push_str(SGR_RESET);
                }
            } else {
                out.extend(vt100::capture::basic_formatted_to_plain(&row.text));
            }
            if !(opts.join_wrapped && row.wrapped) || i == last {
                out.push('\n');
            }
        }
        out
    }

    /// The last `lines` history rows for a terminal: joined, SGR kept, CRLF.
    pub fn scrollback(&self, lines: usize) -> Vec<u8> {
        let text = self.history(lines, CaptureOpts { join_wrapped: true, escapes: true });
        to_crlf(text.as_bytes())
    }

    /// Bytes that redraw the screen, its cursor and input modes (bracketed
    /// paste, application keys, mouse) on any terminal of the same size.
    ///
    /// Not restored (vt100 does not expose it): the scroll region (DECSTBM),
    /// character sets (G0/G1, line drawing), origin mode, tab stops, the
    /// saved cursor and the title. A program relying on one of them looks
    /// wrong after a repaint until it redraws (most TUIs do on the resize an
    /// attach brings).
    pub fn repaint(&self) -> Vec<u8> {
        let screen = self.parser.screen();
        let mut out = String::from(if screen.alternate_screen() { "\x1b[?1049h" } else { "\x1b[?1049l" });
        out.push_str(&screen.state_formatted());
        out.into_bytes()
    }

    /// What a newly attached client is sent: the last `history_lines` history
    /// rows pushed into its scrollback, then [`Self::repaint`].
    pub fn snapshot(&self, history_lines: usize) -> Vec<u8> {
        let mut out = Vec::new();
        let history = if history_lines == 0 { Vec::new() } else { self.scrollback(history_lines) };
        if !history.is_empty() {
            out.extend_from_slice(b"\x1b[?1049l");
            out.extend_from_slice(&history);
            out.extend_from_slice(SGR_RESET.as_bytes());
            // Scroll the history above the screen so the repaint's clear
            // does not erase its last rows.
            let (_, rows) = self.size();
            for _ in 0..rows {
                out.extend_from_slice(b"\r\n");
            }
        }
        out.extend_from_slice(&self.repaint());
        out
    }
}

/// `text` as typed into a session: wrapped in bracketed-paste markers only
/// when the caller asked (`paste-buffer -p`) **and** the program enabled mode
/// 2004; newlines pass through unchanged (`-r`). A bracketed paste cannot end
/// itself early: an end marker inside `text` is dropped.
pub fn paste_bytes(text: &str, bracketed: bool, mode_2004: bool) -> Vec<u8> {
    let mut open = false;
    paste_chunk(text, bracketed, mode_2004, false, false, &mut open)
}

/// One piece of a paste sent in several requests. The first piece (`!cont`)
/// decides whether the paste is bracketed and opens it; the last (`!more`)
/// closes it; `open` carries the decision between pieces, so a mode change
/// mid-paste cannot leave a start marker unclosed.
pub fn paste_chunk(text: &str, bracketed: bool, mode_2004: bool, cont: bool, more: bool, open: &mut bool) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() + 12);
    if !cont {
        *open = bracketed && mode_2004;
        if *open {
            out.extend_from_slice(PASTE_START.as_bytes());
        }
    }
    if *open {
        out.extend_from_slice(text.replace(PASTE_END, "").as_bytes());
        if !more {
            out.extend_from_slice(PASTE_END.as_bytes());
            *open = false;
        }
    } else {
        out.extend_from_slice(text.as_bytes());
    }
    out
}

/// The end-of-paste marker a bracketed paste must not contain.
pub const PASTE_END_MARKER: &str = PASTE_END;

/// How much of `bytes` can be passed on now: everything but a trailing
/// escape sequence or UTF-8 code point the read cut in half, so a client
/// that starts at a snapshot or repaint never begins mid-sequence. A held
/// tail longer than [`MAX_HELD_BACK`] is passed on anyway.
pub fn complete_prefix(bytes: &[u8]) -> usize {
    let cut = escape_cut(bytes).min(utf8_cut(bytes));
    if bytes.len() - cut > MAX_HELD_BACK {
        bytes.len()
    } else {
        cut
    }
}

/// Where an unfinished trailing escape sequence starts (or `len`). Only the
/// last ESC matters: no sequence can contain one unfinished before it.
fn escape_cut(bytes: &[u8]) -> usize {
    let Some(esc) = bytes.iter().rposition(|&b| b == 0x1b) else { return bytes.len() };
    let rest = &bytes[esc + 1..];
    let complete = match rest.first() {
        None => false,
        // CSI: parameter and intermediate bytes, then a final byte.
        Some(b'[') => rest[1..].iter().any(|b| (0x40..=0x7e).contains(b)),
        // OSC, DCS, SOS, PM, APC: ended by BEL (or ST, whose ESC would be
        // the last one and is handled as a two-byte sequence).
        Some(b']' | b'P' | b'X' | b'^' | b'_') => rest[1..].contains(&0x07),
        // nF: intermediates, then a final byte (`ESC ( B`).
        Some(&b) if (0x20..=0x2f).contains(&b) => rest.iter().any(|b| (0x30..=0x7e).contains(b)),
        Some(_) => true,
    };
    if complete {
        bytes.len()
    } else {
        esc
    }
}

/// Where an unfinished trailing UTF-8 code point starts (or `len`).
fn utf8_cut(bytes: &[u8]) -> usize {
    for back in 1..=bytes.len().min(3) {
        let i = bytes.len() - back;
        let b = bytes[i];
        if b & 0xc0 == 0x80 {
            continue; // a continuation byte: keep looking for the lead
        }
        let need = match b {
            0xc0..=0xdf => 2,
            0xe0..=0xef => 3,
            0xf0..=0xf7 => 4,
            _ => 1,
        };
        return if back < need { i } else { bytes.len() };
    }
    bytes.len()
}

/// LF → CRLF, an existing CR kept; a non-empty result ends in CRLF.
fn to_crlf(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len() + bytes.len() / 32 + 2);
    let mut prev_cr = false;
    for &b in bytes {
        if b == b'\n' && !prev_cr {
            out.push(b'\r');
        }
        out.push(b);
        prev_cr = b == b'\r';
    }
    if !out.is_empty() && !out.ends_with(b"\r\n") {
        out.extend_from_slice(b"\r\n");
    }
    out
}

/// The cwd an OSC sequence reports: OSC 7 (`file://host/path`, percent-encoded)
/// or ConEmu/Windows Terminal OSC 9;9 (`"C:\path"`). A Windows drive path in
/// OSC 7 (`/C:/x`) loses its leading slash.
fn osc_cwd(params: &[&[u8]]) -> Option<String> {
    let text = |p: &[&[u8]]| p.iter().map(|s| String::from_utf8_lossy(s)).collect::<Vec<_>>().join(";");
    match params {
        [b"7", rest @ ..] if !rest.is_empty() => {
            let url = text(rest);
            let after = url.strip_prefix("file://")?;
            let path = &after[after.find('/')?..];
            let path = percent_decode(path)?;
            let bytes = path.as_bytes();
            let drive = bytes.len() >= 3 && bytes[0] == b'/' && bytes[1].is_ascii_alphabetic() && bytes[2] == b':';
            Some(if drive { path[1..].to_string() } else { path })
        }
        [b"9", b"9", rest @ ..] if !rest.is_empty() => {
            let path = text(rest);
            let path = path.trim_matches('"');
            (!path.is_empty()).then(|| path.to_string())
        }
        _ => None,
    }
}

fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    const JOINED: CaptureOpts = CaptureOpts { join_wrapped: true, escapes: false };

    #[test]
    fn capture_joins_wrapped_rows_only_when_asked() {
        let mut s = Screen::new(5, 3, 100);
        s.process(b"abcdefgh\r\nxy");
        assert_eq!(s.capture(JOINED), "abcdefgh\nxy\n");
        assert_eq!(s.capture(CaptureOpts::default()), "abcde\nfgh\nxy\n");
    }

    #[test]
    fn capture_keeps_sgr_when_asked() {
        let mut s = Screen::new(10, 2, 100);
        s.process(b"\x1b[31mred\x1b[m ok");
        let plain = s.capture(JOINED);
        assert_eq!(plain, "red ok\n\n");
        let coloured = s.capture(CaptureOpts { join_wrapped: true, escapes: true });
        assert!(coloured.contains("\x1b[31m"), "{coloured:?}");
        assert!(coloured.contains("red"), "{coloured:?}");
        assert!(coloured.trim_end().ends_with(SGR_RESET), "{coloured:?}");
    }

    #[test]
    fn history_stops_one_row_above_the_visible_screen() {
        let mut s = Screen::new(20, 3, 100);
        for i in 0..8 {
            s.process(format!("line{i}\r\n").as_bytes());
        }
        // Rows 0..=5 scrolled off; the screen shows line6, line7 and a blank row.
        assert_eq!(s.capture(JOINED), "line6\nline7\n\n");
        assert_eq!(s.history(100, JOINED), "line0\nline1\nline2\nline3\nline4\nline5\n");
        assert_eq!(s.history(2, JOINED), "line4\nline5\n");
        assert_eq!(s.scrollback(2), b"line4\r\nline5\r\n");
    }

    #[test]
    fn history_joins_wrapped_rows_and_keeps_sgr() {
        let mut s = Screen::new(4, 2, 100);
        s.process(b"\x1b[32mabcdefg\x1b[m\r\nz\r\n\r\n");
        let joined = s.history(10, CaptureOpts { join_wrapped: true, escapes: true });
        let plain: String = vt100::capture::basic_formatted_to_plain(&joined).collect();
        assert_eq!(plain, "abcdefg\nz\n");
        assert!(joined.contains("\x1b[32m"), "{joined:?}");
        assert_eq!(s.history(10, CaptureOpts::default()), "abcd\nefg\nz\n");
        let crlf = s.scrollback(10);
        assert!(crlf.ends_with(b"z\r\n"), "{:?}", String::from_utf8_lossy(&crlf));
        assert!(!crlf.windows(2).any(|w| w[1] == b'\n' && w[0] != b'\r'), "a bare LF");
    }

    #[test]
    fn history_is_bounded_and_skips_the_alternate_screen() {
        let mut s = Screen::new(10, 2, 3);
        for i in 0..10 {
            s.process(format!("r{i}\r\n").as_bytes());
        }
        assert_eq!(s.history_len(), 3);
        assert_eq!(s.history(10, JOINED), "r6\nr7\nr8\n");
        s.process(b"\x1b[?1049h");
        for i in 0..10 {
            s.process(format!("alt{i}\r\n").as_bytes());
        }
        assert!(s.alternate_screen());
        assert_eq!(s.history(10, JOINED), "r6\nr7\nr8\n");
    }

    #[test]
    fn bracketed_paste_follows_mode_2004() {
        let mut s = Screen::new(10, 2, 0);
        assert!(!s.bracketed_paste());
        assert_eq!(paste_bytes("a\nb", true, s.bracketed_paste()), b"a\nb");
        s.process(b"\x1b[?2004h");
        assert!(s.bracketed_paste());
        assert_eq!(paste_bytes("a\nb", true, s.bracketed_paste()), b"\x1b[200~a\nb\x1b[201~");
        assert_eq!(paste_bytes("a\nb", false, s.bracketed_paste()), b"a\nb");
        assert_eq!(paste_bytes("x\x1b[201~y", true, true), b"\x1b[200~xy\x1b[201~");
        s.process(b"\x1b[?2004l");
        assert!(!s.bracketed_paste());
    }

    #[test]
    fn a_paste_in_pieces_is_bracketed_once() {
        let mut open = false;
        let mut out = paste_chunk("ab", true, true, false, true, &mut open);
        assert!(open);
        // The mode turning off mid-paste does not leave it unclosed.
        out.extend(paste_chunk("cd", true, false, true, true, &mut open));
        out.extend(paste_chunk("ef", true, false, true, false, &mut open));
        assert_eq!(out, b"\x1b[200~abcdef\x1b[201~");
        assert!(!open);
        let mut plain = paste_chunk("ab", true, false, false, true, &mut open);
        plain.extend(paste_chunk("cd", true, true, true, false, &mut open));
        assert_eq!(plain, b"abcd");
    }

    #[test]
    fn repaint_reproduces_the_screen_and_modes() {
        let mut s = Screen::new(12, 3, 100);
        s.process(b"\x1b[?2004h\x1b[1mbold\x1b[m\r\nplain");
        let mut copy = Screen::new(12, 3, 0);
        copy.process(b"garbage everywhere\r\nmore");
        copy.process(&s.repaint());
        assert_eq!(copy.capture(JOINED), s.capture(JOINED));
        assert!(copy.bracketed_paste());
        assert_eq!(copy.parser.screen().cursor_position(), s.parser.screen().cursor_position());

        s.process(b"\x1b[?1049hALT");
        let mut alt = Screen::new(12, 3, 0);
        alt.process(&s.repaint());
        assert!(alt.alternate_screen());
        assert_eq!(alt.capture(JOINED), s.capture(JOINED));
    }

    #[test]
    fn snapshot_puts_history_before_the_repaint() {
        let mut s = Screen::new(10, 2, 100);
        s.process(b"old0\r\nold1\r\nold2\r\nnow");
        assert_eq!(s.history(10, JOINED), "old0\nold1\n");
        let mut client = Screen::new(10, 2, 100);
        client.process(&s.snapshot(10));
        assert_eq!(client.capture(JOINED), s.capture(JOINED));
        assert!(client.history(100, JOINED).starts_with("old0\nold1\n"));
        assert_eq!(s.snapshot(0), s.repaint());
    }

    #[test]
    fn resize_keeps_rows_pushed_off_as_history() {
        let mut s = Screen::new(10, 4, 100);
        s.process(b"a\r\nb\r\nc\r\nd");
        s.resize(8, 2);
        assert_eq!(s.size(), (8, 2));
        assert!(s.history(10, JOINED).contains('a'));
    }

    #[test]
    fn osc_reports_set_the_cwd() {
        let mut s = Screen::new(10, 2, 0);
        assert_eq!(s.cwd(), None);
        s.process(b"\x1b]7;file://box/home/u/my%20dir\x07");
        assert_eq!(s.cwd(), Some("/home/u/my dir"));
        s.process(b"\x1b]7;file://box/C:/Users/u\x1b\\");
        assert_eq!(s.cwd(), Some("C:/Users/u"));
        s.process(b"\x1b]9;9;\"C:\\work;tree\"\x07");
        assert_eq!(s.cwd(), Some("C:\\work;tree"));
        s.process(b"\x1b]0;a title\x07");
        assert_eq!(s.cwd(), Some("C:\\work;tree"));
    }

    #[test]
    fn a_cut_escape_sequence_or_code_point_is_held_back() {
        let whole: &[&[u8]] = &[
            b"plain",
            b"a\x1b[31mb",
            b"\x1b[?2004h",
            b"\x1b]0;title\x07",
            b"\x1b]7;file://h/x\x1b\\",
            b"\x1b(B",
            b"\x1b7",
            "é".as_bytes(),
            "a€".as_bytes(),
            "🙂".as_bytes(),
        ];
        for w in whole {
            assert_eq!(complete_prefix(w), w.len(), "{w:?}");
        }
        let cut: &[(&[u8], usize)] = &[
            (b"ab\x1b", 2),
            (b"ab\x1b[3", 2),
            (b"ab\x1b[?20", 2),
            (b"x\x1b]0;tit", 1),
            (b"x\x1b(", 1),
            (b"x\xc3", 1),
            (b"x\xe2\x82", 1),
            (b"x\xf0\x9f\x99", 1),
            (b"\x1b[31mok\xe2", 7),
        ];
        for (bytes, at) in cut {
            assert_eq!(complete_prefix(bytes), *at, "{bytes:?}");
        }
        // An unterminated sequence past the bound is passed on.
        let mut long = b"\x1b]0;".to_vec();
        long.extend(std::iter::repeat_n(b'x', MAX_HELD_BACK + 1));
        assert_eq!(complete_prefix(&long), long.len());
    }

    #[test]
    fn crlf_keeps_existing_cr() {
        assert_eq!(to_crlf(b"a\nb\r\nc"), b"a\r\nb\r\nc\r\n");
        assert_eq!(to_crlf(b""), b"");
    }
}
