//! What a hidden pane's show-again replay has to carry (performance plan
//! §3.2b).
//!
//! A hidden PTY's output accumulates in its route's `pending` buffer and is
//! written into xterm in one go when the pane is shown. Agent TUIs repaint
//! their whole screen frame after frame, so by the time a pane is shown
//! again most of that buffer is dead: every frame before the last full clear
//! was overwritten by the frames after it, and writing a megabyte of dead
//! frames into xterm is what froze the window on a tab switch.
//!
//! So a big replay is cut at the last *full clear* — never at a byte count,
//! which lands mid-frame or mid-sequence — and what the dropped bytes did to
//! the terminal's state is re-applied in front of the cut. A TUI switches to
//! the alternate screen, turns on mouse reporting, bracketed paste and focus
//! events and hides the cursor once, at startup, and never again; dropping
//! those sequences would leave xterm on the wrong screen typing mouse reports
//! into the program. `ScreenState` folds every such sequence (last value
//! wins) and `prefix()` writes the result back out.
//!
//! The cut rule, from what the TUIs actually emit:
//! - Ink (Claude, Gemini) clears with `ESC[2J ESC[3J ESC[H`; `clear` and
//!   curses programs with `ESC[H ESC[2J`; ratatui's `Clear(All)` is `ESC[2J`
//!   followed by absolute positioning. So: an erase-all (`2J`) whose
//!   contiguous run of sequences also positions the cursor absolutely, or a
//!   cursor-home (`H`/`f` to 1;1) whose run also erases to the end (`J`,
//!   `0J`, `2J`). Either way nothing written before it is still on screen.
//! - Entering the alternate screen with `?1049h` clears it, so that is a cut
//!   too — but the *main* screen's output before it is live again once the
//!   program leaves, so the main-screen phases before such a cut are kept.
//! - `ESC c` (full reset) is a cut after which no state needs re-applying.
//!
//! Scrollback: a cut on the main screen drops lines the hidden spell scrolled
//! off before its last full clear (an alt-screen TUI has none to lose), so
//! only a buffer past `REPLAY_TRIM_FLOOR` is cut at all — below it a whole
//! replay is milliseconds of xterm work and loses nothing.

/// Buffers shorter than this replay whole: the freeze is a megabyte of dead
/// frames, not a screenful, and a whole replay keeps every scrolled-off line.
pub(super) const REPLAY_TRIM_FLOOR: usize = 128 * 1024;

const ESC: u8 = 0x1b;
const BEL: u8 = 0x07;

/// How many sequences a clear's run is scanned for its cursor move / erase.
/// A frame's cursor move is followed by text within a couple of sequences; a
/// run longer than this is not a clear-and-home, and giving up is the safe
/// direction (no cut).
const CLEAR_RUN_LOOKAHEAD: usize = 32;

/// One lexical unit of terminal output. `end` is the byte index just past it;
/// every boundary is at an ASCII byte (ESC, a final byte, BEL), so slicing
/// the `&str` at it is always valid.
#[derive(Debug)]
enum Token<'a> {
    /// Printable bytes and C0 controls up to the next ESC.
    Text { end: usize },
    Csi {
        end: usize,
        /// `?`, `>`, `=` or `<` when the parameters open with one.
        private: Option<u8>,
        params: &'a str,
        intermediates: &'a str,
        final_byte: u8,
    },
    Osc { end: usize, body: &'a str },
    /// A two-byte escape (`ESC c`, `ESC 7`) or a charset designation
    /// (`ESC ( B`): `intermediates` is empty for the former.
    Esc {
        end: usize,
        intermediates: &'a str,
        final_byte: u8,
    },
    /// A DCS/SOS/PM/APC string, an unterminated sequence at the end of the
    /// buffer, or an ESC that opens nothing readable.
    Other { end: usize },
}

impl Token<'_> {
    fn end(&self) -> usize {
        match self {
            Token::Text { end }
            | Token::Csi { end, .. }
            | Token::Osc { end, .. }
            | Token::Esc { end, .. }
            | Token::Other { end } => *end,
        }
    }
}

/// Where a control string opened at `start` ends: `(end, body_end)` — past
/// the BEL / ST terminator, or at an ESC that opens something else (xterm
/// ends the string there too), or at the end of the buffer.
fn string_end(b: &[u8], start: usize) -> (usize, usize) {
    let n = b.len();
    let mut k = start;
    while k < n {
        match b[k] {
            BEL => return (k + 1, k),
            ESC if b.get(k + 1) == Some(&b'\\') => return (k + 2, k),
            ESC => return (k, k),
            _ => k += 1,
        }
    }
    (n, n)
}

fn token_at(text: &str, i: usize) -> Token<'_> {
    let b = text.as_bytes();
    let n = b.len();
    if b[i] != ESC {
        let end = b[i..].iter().position(|&c| c == ESC).map_or(n, |p| i + p);
        return Token::Text { end };
    }
    let Some(&kind) = b.get(i + 1) else {
        return Token::Other { end: n };
    };
    match kind {
        b'[' => {
            let p0 = i + 2;
            let mut j = p0;
            while j < n && (0x30..=0x3f).contains(&b[j]) {
                j += 1;
            }
            let p1 = j;
            while j < n && (0x20..=0x2f).contains(&b[j]) {
                j += 1;
            }
            if j < n && (0x40..=0x7e).contains(&b[j]) {
                let all = &text[p0..p1];
                let (private, params) = match all.as_bytes().first() {
                    Some(&c) if (0x3c..=0x3f).contains(&c) => (Some(c), &all[1..]),
                    _ => (None, all),
                };
                Token::Csi {
                    end: j + 1,
                    private,
                    params,
                    intermediates: &text[p1..j],
                    final_byte: b[j],
                }
            } else {
                // Unterminated, or a control byte inside the sequence: nothing
                // to read from it, and no cut ever lands inside it.
                Token::Other { end: j }
            }
        }
        b']' => {
            let (end, body_end) = string_end(b, i + 2);
            Token::Osc {
                end,
                body: &text[i + 2..body_end],
            }
        }
        b'P' | b'X' | b'^' | b'_' => Token::Other {
            end: string_end(b, i + 2).0,
        },
        0x20..=0x2f => {
            let mut j = i + 1;
            while j < n && (0x20..=0x2f).contains(&b[j]) {
                j += 1;
            }
            if j < n && (0x30..=0x7e).contains(&b[j]) {
                Token::Esc {
                    end: j + 1,
                    intermediates: &text[i + 1..j],
                    final_byte: b[j],
                }
            } else {
                Token::Other { end: j }
            }
        }
        0x30..=0x7e => Token::Esc {
            end: i + 2,
            intermediates: "",
            final_byte: kind,
        },
        _ => Token::Other { end: i + 1 },
    }
}

/// The numeric parameters of a mode sequence (`?1000;1006h` → 1000, 1006).
fn mode_params(params: &str) -> impl Iterator<Item = u16> + '_ {
    params.split(';').filter_map(|p| p.parse().ok())
}

/// Whether the parameters of a `H`/`f` say "home" (`""`, `1;1`, `;`, `1`).
fn is_home(params: &str) -> bool {
    params
        .split(';')
        .all(|p| p.is_empty() || p.parse::<u32>().is_ok_and(|v| v <= 1))
}

/// Whether `?47`, `?1047` or `?1049` is among the modes of a DECSET/DECRST.
fn switches_screen(params: &str) -> bool {
    mode_params(params).any(|m| matches!(m, 47 | 1047 | 1049))
}

/// What the run of sequences starting at `start` (a `2J` or a home) contains
/// before its first text byte.
#[derive(Default)]
struct ClearRun {
    erase_all: bool,
    erase_below: bool,
    cursor_abs: bool,
}

fn clear_run(text: &str, start: usize) -> ClearRun {
    let mut run = ClearRun::default();
    let mut i = start;
    for _ in 0..CLEAR_RUN_LOOKAHEAD {
        if i >= text.len() {
            break;
        }
        let tok = token_at(text, i);
        match &tok {
            Token::Text { .. } => break,
            Token::Csi {
                private: None,
                params,
                intermediates: "",
                final_byte,
                ..
            } => match final_byte {
                b'J' if *params == "2" => run.erase_all = true,
                b'J' if params.is_empty() || *params == "0" => run.erase_below = true,
                b'H' | b'f' => run.cursor_abs = true,
                _ => {}
            },
            _ => {}
        }
        i = tok.end();
    }
    run
}

/// Where the replay starts and what of the dropped prefix still matters.
struct Cut {
    at: usize,
    /// Main-screen phases of the dropped prefix, kept in front: the cut is on
    /// the alternate screen, and these come back when the program leaves it.
    keep_before: Vec<(usize, usize)>,
    /// `ESC c`: no state from before it survives, so none is re-applied.
    reset: bool,
}

/// The last full clear in `text`, with the alternate-screen bookkeeping that
/// says which earlier bytes are still live.
fn find_cut(text: &str) -> Option<Cut> {
    let n = text.len();
    let mut i = 0;
    // Which screen the buffer is on: unknown until its first switch (xterm's
    // state before the hidden spell is not tracked), then followed.
    let mut on_alt: Option<bool> = None;
    let mut phase_start = 0usize;
    let mut main_phases: Vec<(usize, usize)> = Vec::new();
    let mut cut: Option<Cut> = None;
    while i < n {
        let tok = token_at(text, i);
        let end = tok.end();
        match &tok {
            Token::Csi {
                private: Some(b'?'),
                params,
                final_byte: final_byte @ (b'h' | b'l'),
                ..
            } if switches_screen(params) => {
                if *final_byte == b'h' {
                    // xterm ignores a redundant enter, so only a real one cuts.
                    if on_alt != Some(true) {
                        if mode_params(params).any(|m| m == 1049) {
                            let mut keep_before = main_phases.clone();
                            if i > phase_start {
                                keep_before.push((phase_start, i));
                            }
                            cut = Some(Cut {
                                at: i,
                                keep_before,
                                reset: false,
                            });
                        }
                        if i > phase_start {
                            main_phases.push((phase_start, i));
                        }
                        on_alt = Some(true);
                        phase_start = end;
                    }
                } else if on_alt != Some(false) {
                    // Leaving: the alternate screen's content is dead.
                    on_alt = Some(false);
                    phase_start = end;
                }
            }
            Token::Csi {
                private: None,
                params,
                intermediates: "",
                final_byte,
                ..
            } => {
                let clears = match final_byte {
                    b'J' if *params == "2" => clear_run(text, i).cursor_abs,
                    b'H' | b'f' if is_home(params) => {
                        let run = clear_run(text, i);
                        run.erase_all || run.erase_below
                    }
                    _ => false,
                };
                if clears {
                    cut = Some(Cut {
                        at: i,
                        keep_before: if on_alt == Some(true) {
                            main_phases.clone()
                        } else {
                            Vec::new()
                        },
                        reset: false,
                    });
                }
            }
            Token::Esc {
                intermediates: "",
                final_byte: b'c',
                ..
            } => {
                cut = Some(Cut {
                    at: i,
                    keep_before: Vec::new(),
                    reset: true,
                });
                // A full reset wipes both screens and lands on the main one:
                // nothing printed before it is live, whichever screen it was on.
                main_phases.clear();
                on_alt = Some(false);
                phase_start = end;
            }
            _ => {}
        }
        i = end;
    }
    cut
}

/// The DEC private modes xterm's DECSTR (`ESC[!p`) puts back to their
/// defaults (xterm.js `softReset` → `CoreService.reset`): cursor keys, origin,
/// wraparound, cursor visibility, reverse wraparound, keypad, focus events,
/// bracketed paste. The screen switch (`?47`/`?1047`/`?1049`) and mouse
/// reporting are NOT among them — a TUI that soft-resets after entering the
/// alternate screen is still on it, with the mouse still reporting.
const SOFT_RESET_DEC_MODES: [u16; 8] = [1, 6, 7, 25, 45, 66, 1004, 2004];

/// The terminal state a stretch of output leaves behind, as the sequences
/// that re-create it. Everything is last-value-wins; what the stretch never
/// touched is not mentioned, so xterm keeps whatever it had.
#[derive(Clone, Debug, Default, PartialEq)]
pub(super) struct ScreenState {
    /// The stretch held a full reset (`ESC c`): the terminal must be reset
    /// before anything kept from after it is written (`reset_prefix`).
    hard_reset: bool,
    /// The stretch held a soft reset (`ESC[!p`) after its last full one: what
    /// DECSTR resets and this state does not track (the saved cursor, origin
    /// mode, …) is reset by replaying it, ahead of the state set after it.
    soft_reset: bool,
    /// Charset designations (`ESC ( 0` line drawing, `ESC ( B`), by designator.
    charsets: Vec<(String, String)>,
    /// SGR sequences since the last full SGR reset, in order. Non-empty means
    /// the stretch touched the attributes: a reset is written first.
    sgr: Vec<String>,
    /// DECSCUSR cursor shape.
    cursor_style: Option<String>,
    /// DEC private (`?`) and ANSI modes with their last value, first-seen order.
    modes: Vec<(Option<u8>, u16, bool)>,
    /// DECSTBM scroll region.
    scroll_region: Option<String>,
    /// Title, icon, colours, palette entries, by kind.
    osc: Vec<(String, String)>,
}

fn upsert(list: &mut Vec<(String, String)>, key: &str, raw: &str) {
    match list.iter_mut().find(|(k, _)| k == key) {
        Some(entry) => entry.1 = raw.to_string(),
        None => list.push((key.to_string(), raw.to_string())),
    }
}

impl ScreenState {
    pub(super) fn is_empty(&self) -> bool {
        *self == Self::default()
    }

    /// Fold every state-bearing sequence of `text` in.
    pub(super) fn observe(&mut self, text: &str) {
        let mut i = 0;
        while i < text.len() {
            let tok = token_at(text, i);
            let end = tok.end();
            self.observe_token(&text[i..end], &tok);
            i = end;
        }
    }

    fn observe_token(&mut self, raw: &str, tok: &Token<'_>) {
        match tok {
            Token::Csi {
                private: private @ (None | Some(b'?')),
                params,
                intermediates: "",
                final_byte: final_byte @ (b'h' | b'l'),
                ..
            } => {
                let set = *final_byte == b'h';
                for m in mode_params(params) {
                    match self
                        .modes
                        .iter_mut()
                        .find(|(p, mode, _)| *p == *private && *mode == m)
                    {
                        Some(entry) => entry.2 = set,
                        None => self.modes.push((*private, m, set)),
                    }
                }
            }
            Token::Csi {
                private: None,
                params,
                intermediates: "",
                final_byte: b'm',
                ..
            } => {
                let first = params.split(';').next().unwrap_or("");
                if first.is_empty() || first.parse::<u32>() == Ok(0) {
                    self.sgr.clear();
                }
                self.sgr.push(raw.to_string());
            }
            Token::Csi {
                private: None,
                intermediates: " ",
                final_byte: b'q',
                ..
            } => self.cursor_style = Some(raw.to_string()),
            Token::Csi {
                private: None,
                intermediates: "",
                final_byte: b'r',
                ..
            } => self.scroll_region = Some(raw.to_string()),
            // DECSTR soft reset: attributes, charsets, margins and the modes in
            // `SOFT_RESET_DEC_MODES` go back to defaults; the screen switch,
            // mouse reporting, cursor shape, title and colours stay (xterm.js
            // `softReset`). Replayed itself, for what it resets beyond these.
            Token::Csi {
                private: None,
                intermediates: "!",
                final_byte: b'p',
                ..
            } => {
                self.soft_reset = true;
                self.charsets.clear();
                self.sgr.clear();
                self.modes.retain(|(private, mode, _)| match private {
                    Some(b'?') => !SOFT_RESET_DEC_MODES.contains(mode),
                    _ => false,
                });
                self.scroll_region = None;
            }
            Token::Esc {
                intermediates: "",
                final_byte: b'c',
                ..
            } => {
                *self = Self {
                    hard_reset: true,
                    ..Self::default()
                }
            }
            Token::Esc {
                intermediates: designator @ ("(" | ")" | "*" | "+"),
                ..
            } => upsert(&mut self.charsets, designator, raw),
            Token::Osc { body, .. } => {
                let (code, rest) = body.split_once(';').unwrap_or((*body, ""));
                // A query (`10;?`) is answered on parse: never re-played.
                if rest == "?" {
                    return;
                }
                let key = match code {
                    "0" | "2" => "title".to_string(),
                    "1" => "icon".to_string(),
                    "10" | "110" => "fg".to_string(),
                    "11" | "111" => "bg".to_string(),
                    "12" | "112" => "cursor".to_string(),
                    "4" | "104" => {
                        let index = rest.split(';').next().unwrap_or("");
                        if index.is_empty() {
                            // `104` alone resets the whole palette.
                            self.osc.retain(|(k, _)| !k.starts_with("palette"));
                            "palette".to_string()
                        } else {
                            format!("palette;{index}")
                        }
                    }
                    _ => return,
                };
                upsert(&mut self.osc, &key, raw);
            }
            _ => {}
        }
    }

    /// The sequences that re-create this state in a terminal.
    pub(super) fn prefix(&self) -> String {
        let mut out = self.reset_prefix().to_string();
        out.push_str(&self.state_prefix());
        out
    }

    /// The full reset the stretch held, if any. Written before anything kept
    /// from the stretch: a reset wipes the screen, so what the program printed
    /// after it must come after it in the replay too.
    fn reset_prefix(&self) -> &'static str {
        if self.hard_reset {
            "\x1bc"
        } else {
            ""
        }
    }

    /// Everything but the full reset: the soft reset, then what was set.
    fn state_prefix(&self) -> String {
        let mut out = String::new();
        if self.soft_reset {
            out.push_str("\x1b[!p");
        }
        for (_, raw) in &self.charsets {
            out.push_str(raw);
        }
        if !self.sgr.is_empty() {
            out.push_str("\x1b[0m");
            for raw in &self.sgr {
                out.push_str(raw);
            }
        }
        if let Some(raw) = &self.cursor_style {
            out.push_str(raw);
        }
        for (private, mode, set) in &self.modes {
            out.push_str("\x1b[");
            if let Some(p) = private {
                out.push(*p as char);
            }
            out.push_str(&mode.to_string());
            out.push(if *set { 'h' } else { 'l' });
        }
        if let Some(raw) = &self.scroll_region {
            out.push_str(raw);
        }
        for (_, raw) in &self.osc {
            out.push_str(raw);
        }
        out
    }
}

/// The replay for a hidden spell's `pending` buffer: `carried` is the state
/// left by bytes the buffer's cap already trimmed off its front. A buffer
/// under `floor` replays whole (behind the carried state, if any); a longer
/// one is cut at its last full clear with the state before the cut in front.
pub(super) fn trim_replay(pending: String, carried: &ScreenState, floor: usize) -> String {
    let cut = if pending.len() >= floor {
        find_cut(&pending)
    } else {
        None
    };
    let Some(cut) = cut else {
        if carried.is_empty() {
            return pending;
        }
        let mut out = carried.prefix();
        out.push_str(&pending);
        return out;
    };
    let mut out = String::with_capacity(pending.len() - cut.at + 256);
    let state = (!cut.reset).then(|| {
        let mut state = carried.clone();
        state.observe(&pending[..cut.at]);
        state
    });
    // A full reset before the kept phases (they were printed after it); the
    // rest of the state after them (it is the last value over all of them).
    if let Some(state) = &state {
        out.push_str(state.reset_prefix());
    }
    for (a, b) in &cut.keep_before {
        out.push_str(&pending[*a..*b]);
    }
    if let Some(state) = &state {
        out.push_str(&state.state_prefix());
    }
    out.push_str(&pending[cut.at..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn trim(pending: &str) -> String {
        trim_replay(pending.to_string(), &ScreenState::default(), 0)
    }

    #[test]
    fn a_buffer_without_a_clear_is_unchanged() {
        let s = "\x1b[?1049h\x1b[Hframe one\x1b[2Kframe two\x1b[31mred\x1b[0m";
        assert_eq!(trim(s), s);
        assert_eq!(trim("plain text\r\nmore"), "plain text\r\nmore");
    }

    #[test]
    fn a_buffer_under_the_floor_replays_whole() {
        let s = "old\x1b[2J\x1b[Hnew";
        assert_eq!(trim_replay(s.to_string(), &ScreenState::default(), s.len() + 1), s);
        assert_eq!(trim_replay(s.to_string(), &ScreenState::default(), s.len()), "\x1b[2J\x1b[Hnew");
    }

    #[test]
    fn cuts_at_the_last_full_clear_of_each_shape() {
        // Ink: 2J 3J H.
        assert_eq!(trim("a\x1b[2J\x1b[3J\x1b[Hb\x1b[2J\x1b[3J\x1b[Hc"), "\x1b[2J\x1b[3J\x1b[Hc");
        // clear(1): H 2J.
        assert_eq!(trim("a\x1b[H\x1b[2Jb"), "\x1b[H\x1b[2Jb");
        // Home then erase below, with an SGR in the run.
        assert_eq!(trim("a\x1b[1;1H\x1b[0m\x1b[Jb"), "\x1b[1;1H\x1b[0m\x1b[Jb");
        // ratatui: 2J then absolute positioning.
        assert_eq!(trim("a\x1b[2J\x1b[3;7Hb"), "\x1b[2J\x1b[3;7Hb");
        // Full reset.
        assert_eq!(trim("\x1b[?1000ha\x1bcb"), "\x1bcb");
    }

    #[test]
    fn a_bare_erase_or_a_mere_home_is_not_a_clear() {
        // 2J followed by text at the old cursor: not a repaint from the top.
        assert_eq!(trim("a\x1b[2Jb"), "a\x1b[2Jb");
        // Home with no erase: the old frame is still there.
        assert_eq!(trim("a\x1b[Hb"), "a\x1b[Hb");
        // Erase above / scrollback only.
        assert_eq!(trim("a\x1b[H\x1b[1Jb\x1b[3Jc"), "a\x1b[H\x1b[1Jb\x1b[3Jc");
    }

    #[test]
    fn modes_before_the_cut_are_re_applied_last_value_wins() {
        let s = "\x1b[?1049h\x1b[?1000;1006h\x1b[?2004h\x1b[?25l\x1b[?1000l\
                 old frame\x1b[2J\x1b[Hnew frame";
        assert_eq!(
            trim(s),
            "\x1b[?1049h\x1b[?1000l\x1b[?1006h\x1b[?2004h\x1b[?25l\x1b[2J\x1b[Hnew frame"
        );
    }

    #[test]
    fn attributes_title_charset_cursor_and_region_survive_the_cut() {
        let s = "\x1b(0\x1b[1m\x1b[0m\x1b[31m\x1b[44m\x1b[2 q\x1b[4h\x1b[3;20r\
                 \x1b]0;old\x07\x1b]2;claude\x07\x1b]11;#000000\x1b\\\x1b]10;?\x07\
                 old\x1b[2J\x1b[Hnew";
        assert_eq!(
            trim(s),
            "\x1b(0\x1b[0m\x1b[0m\x1b[31m\x1b[44m\x1b[2 q\x1b[4h\x1b[3;20r\
             \x1b]2;claude\x07\x1b]11;#000000\x1b\\\x1b[2J\x1b[Hnew"
        );
    }

    /// DECSTR is replayed and drops what it resets (bracketed paste, cursor
    /// visibility, attributes, charsets, the region); the alternate screen,
    /// mouse reporting and the title are not reset by it, so they stay — a
    /// TUI that soft-resets after entering the alternate screen is still on
    /// it, and dropping its `?1049h` put xterm on the wrong screen.
    #[test]
    fn a_soft_reset_before_the_cut_keeps_the_screen_mouse_and_title() {
        let s = "\x1b[?1049h\x1b[?1000h\x1b[?2004h\x1b[?25l\x1b[31m\x1b(0\x1b[3;20r\
                 \x1b]0;t\x07\x1b[!pold\x1b[2J\x1b[Hnew";
        assert_eq!(
            trim(s),
            "\x1b[!p\x1b[?1049h\x1b[?1000h\x1b]0;t\x07\x1b[2J\x1b[Hnew"
        );
        // Modes set after it are re-applied after it.
        let s = "\x1b[?2004h\x1b[!p\x1b[?2004h\x1b[?25lold\x1b[2J\x1b[Hnew";
        assert_eq!(trim(s), "\x1b[!p\x1b[?2004h\x1b[?25l\x1b[2J\x1b[Hnew");
    }

    /// A full reset inside the kept prefix is replayed, in front of what the
    /// program printed after it: a `reset` then an alt-screen TUI must leave
    /// xterm reset (mouse off, main screen wiped), not with the pre-reset
    /// modes and main-screen text still there.
    #[test]
    fn a_reset_inside_the_prefix_is_replayed_before_what_follows_it() {
        let s = "\x1b[?1000hold main\x1bcbanner\r\n\x1b[?1049hframe";
        assert_eq!(trim(s), "\x1bcbanner\r\n\x1b[?1049hframe");
        // The same through a main-screen phase kept across an alt-screen cut.
        let s = "old\x1bcbanner\x1b[?1049halt\x1b[2J\x1b[Hframe";
        assert_eq!(trim(s), "\x1bcbanner\x1b[?1049h\x1b[2J\x1b[Hframe");
        // From the capped-off front: the reset still comes first.
        let mut carried = ScreenState::default();
        carried.observe("\x1b[?1000h\x1bc\x1b[?2004h");
        assert_eq!(
            trim_replay("banner\x1b[?1049hframe".to_string(), &carried, 0),
            "\x1bcbanner\x1b[?2004h\x1b[?1049hframe"
        );
    }

    /// The trimmed replay leaves a terminal in the state the whole buffer
    /// would have: over random streams built from what the TUIs emit, the cut
    /// is at a sequence boundary, the tail is kept verbatim, and folding the
    /// replay into a fresh `ScreenState` gives the whole buffer's.
    #[test]
    fn a_trimmed_replay_leaves_the_state_the_whole_buffer_would() {
        const POOL: &[&str] = &[
            "text", "é\u{1F600}", "\r\n", " \x1b[2K\x1b[1A", "\x1b[G",
            "\x1b[?1049h", "\x1b[?1049l", "\x1b[?47h", "\x1b[?1047l",
            "\x1b[?1000h", "\x1b[?1000l", "\x1b[?1002;1006h", "\x1b[?1003l",
            "\x1b[?2004h", "\x1b[?2004l", "\x1b[?25l", "\x1b[?25h", "\x1b[?7l",
            "\x1b[?1004h", "\x1b[?1h", "\x1b[?2026h", "\x1b[?2026l", "\x1b[4h", "\x1b[4l",
            "\x1b[31m", "\x1b[1;44m", "\x1b[0m", "\x1b[m", "\x1b[0;32m",
            "\x1b[2 q", "\x1b[0 q", "\x1b[3;20r", "\x1b[r", "\x1b(0", "\x1b(B", "\x1b)0",
            "\x1b]0;one\x07", "\x1b]2;two\x1b\\", "\x1b]11;#000000\x07", "\x1b]10;?\x07",
            "\x1b]4;1;rgb:ff/00/00\x07", "\x1b]104\x07", "\x1b7", "\x1b8",
            "\x1b[2J\x1b[3J\x1b[H", "\x1b[H\x1b[2J", "\x1b[2J", "\x1b[H", "\x1b[1;1H\x1b[J",
            "\x1b[3;7H", "\x1b[1J", "\x1bc", "\x1b[!p", "\x1b[6n",
        ];
        let mut seed: u64 = 0x9e37_79b9_7f4a_7c15;
        let mut next = || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        let normalized = |s: &ScreenState| {
            let mut charsets = s.charsets.clone();
            charsets.sort();
            let mut modes = s.modes.clone();
            modes.sort();
            let mut osc = s.osc.clone();
            osc.sort();
            // The prefix opens its attributes with a reset the buffer may not
            // have had: equal up to leading resets.
            let is_reset = |raw: &String| raw == "\x1b[0m" || raw == "\x1b[m";
            let sgr: Vec<String> = s.sgr.iter().skip_while(|r| is_reset(r)).cloned().collect();
            (
                s.hard_reset,
                s.soft_reset,
                charsets,
                sgr,
                s.cursor_style.clone(),
                modes,
                s.scroll_region.clone(),
                osc,
            )
        };
        let mut cuts = 0;
        for _ in 0..3000 {
            let len = 3 + (next() % 60) as usize;
            let s: String = (0..len).map(|_| POOL[(next() % POOL.len() as u64) as usize]).collect();
            let out = trim(&s);
            let mut whole = ScreenState::default();
            whole.observe(&s);
            let mut replayed = ScreenState::default();
            replayed.observe(&out);
            assert_eq!(normalized(&replayed), normalized(&whole), "stream {s:?} → {out:?}");
            let Some(cut) = find_cut(&s) else {
                assert_eq!(out, s);
                continue;
            };
            cuts += 1;
            assert!(out.ends_with(&s[cut.at..]), "the tail is verbatim: {s:?}");
            assert_eq!(s.as_bytes()[cut.at], ESC, "a cut starts a sequence: {s:?}");
            // Every sequence of the replay is whole (the pool has none that
            // is not), so nothing was cut or spliced inside one.
            let mut i = 0;
            while i < out.len() {
                let tok = token_at(&out, i);
                assert!(!matches!(tok, Token::Other { .. }), "spliced sequence in {out:?}");
                i = tok.end();
            }
        }
        assert!(cuts > 1000, "the pool must exercise the cuts ({cuts})");
    }

    #[test]
    fn entering_the_alternate_screen_cuts_and_keeps_the_main_screen() {
        // Hidden spawn: a banner on the main screen, then an alt-screen TUI.
        let s = "banner\r\n\x1b[?2004h\x1b[?1049h\x1b[?1000hframe";
        // (The kept phase's own mode is re-applied after it: harmless.)
        assert_eq!(
            trim(s),
            "banner\r\n\x1b[?2004h\x1b[?2004h\x1b[?1049h\x1b[?1000hframe"
        );
        // Its later clears keep the main screen too, and only the main screen.
        let s = "main0\x1b[?1049halt0\x1b[?1049lmain1\x1b[?1049halt1\x1b[2J\x1b[Halt2";
        assert_eq!(
            trim(s),
            "main0main1\x1b[?1049h\x1b[2J\x1b[Halt2"
        );
    }

    #[test]
    fn a_clear_on_the_main_screen_after_the_program_left_drops_everything() {
        let s = "\x1b[?1049h\x1b[?1000halt\x1b[?1000l\x1b[?1049lshell\x1b[H\x1b[2Jprompt";
        assert_eq!(trim(s), "\x1b[?1049l\x1b[?1000l\x1b[H\x1b[2Jprompt");
    }

    #[test]
    fn a_redundant_alt_enter_is_no_cut() {
        let s = "\x1b[?1049ha\x1b[?1049hb";
        assert_eq!(trim(s), "\x1b[?1049ha\x1b[?1049hb");
    }

    #[test]
    fn never_cuts_inside_a_sequence() {
        // A DCS string ends at the ESC of a `2J` (as in xterm's parser), and
        // that `2J` is followed by ST, not a cursor move: no clear there.
        let s = "x\x1bPq\x1b[2J\x1b\\y\x1b[2J\x1b[Hz";
        assert_eq!(trim(s), "\x1b[2J\x1b[Hz");
        let s = "x\x1bPq\x1b[2J\x1b\\y";
        assert_eq!(trim(s), s);
        // An unterminated sequence at the end is left as it is.
        let s = "a\x1b[2J\x1b[Hb\x1b[2";
        assert_eq!(trim(s), "\x1b[2J\x1b[Hb\x1b[2");
        // A multi-byte character right before the cut.
        let s = "é\u{1F600}\x1b[2J\x1b[Hé";
        assert_eq!(trim(s), "\x1b[2J\x1b[Hé");
    }

    #[test]
    fn carried_state_from_the_capped_front_rides_in_front() {
        let mut carried = ScreenState::default();
        carried.observe("\x1b[?1049h\x1b[?2004h");
        // With a cut: folded with the prefix's own changes.
        assert_eq!(
            trim_replay("\x1b[?2004lold\x1b[2J\x1b[Hnew".to_string(), &carried, 0),
            "\x1b[?1049h\x1b[?2004l\x1b[2J\x1b[Hnew"
        );
        // Without one: in front of the whole buffer.
        assert_eq!(
            trim_replay("plain".to_string(), &carried, 0),
            "\x1b[?1049h\x1b[?2004hplain"
        );
    }

    #[test]
    fn unterminated_osc_does_not_swallow_a_later_clear() {
        // xterm ends the string at the ESC; the (unterminated) title is state
        // and rides in front, as the program wrote it.
        let s = "\x1b]0;title\x1b[2J\x1b[Hframe";
        assert_eq!(trim(s), "\x1b]0;title\x1b[2J\x1b[Hframe");
    }
}
