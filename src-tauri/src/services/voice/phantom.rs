//! Whisper's phantom text: on noise, breath or a silent stretch it writes what
//! its training subtitles said ("Thank you for watching.", "Untertitel von
//! …"). A segment reaches here only when the voice detector heard speech, so
//! this is the second line: whisper's own no-speech probability, bracketed
//! non-speech tags, an echo of the initial prompt, and a short table of known
//! lines. Pure, so CI tests the table.

/// Whisper's no-speech probability above which the segment is dropped.
/// whisper.cpp already drops a window when this is high *and* the average
/// log-probability is low; this catches a confident phantom too.
const NO_SPEECH_MAX: f32 = 0.6;

/// Lines whisper produces on silence, compared without case or punctuation.
/// Whole-text matches only: a real sentence that merely contains them stays.
/// Checked whatever the speech language: a German speaker's silence gets
/// English credits too.
const PHANTOM_LINES: &[&str] = &[
    "thank you for watching",
    "thanks for watching",
    "thank you for watching and see you next time",
    "please subscribe",
    "like and subscribe",
    "subtitles by the amara org community",
    "vielen dank fürs zuschauen",
    "danke fürs zuschauen",
    "bis zum nächsten mal",
    "untertitel der amara org community",
    "copyright wdr 2021",
    "swr 2021",
];

/// Starts of lines whisper writes as a subtitle credit ("Untertitel im
/// Auftrag des ZDF für funk, 2017").
const PHANTOM_PREFIXES: &[&str] = &[
    "untertitel im auftrag",
    "untertitel von",
    "untertitelung",
    "subtitles by",
    "transcribed by",
];

/// Lowercase words without punctuation, single spaces.
fn normalize(text: &str) -> String {
    text.chars()
        .map(|c| if c.is_alphanumeric() { c.to_lowercase().next().unwrap_or(c) } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Only tags like `[BLANK_AUDIO]`, `(Musik)`, `*Applaus*` or music notes.
fn only_tags(text: &str) -> bool {
    let mut rest = text.trim();
    while !rest.is_empty() {
        let close = match rest.chars().next() {
            Some('[') => ']',
            Some('(') => ')',
            Some('*') => '*',
            Some('♪' | '♫' | '-' | '.' | ',' | '…') => {
                rest = rest[rest.chars().next().map_or(1, char::len_utf8)..].trim_start();
                continue;
            }
            _ => return false,
        };
        let Some(end) = rest[1..].find(close) else { return false };
        rest = rest[end + 2..].trim_start();
    }
    true
}

/// The text to put in the draft, or `None` when the segment is a phantom.
/// Control characters are folded to spaces (it becomes terminal input).
pub fn keep(text: &str, no_speech: f32, prompt: Option<&str>) -> Option<String> {
    let text: String = text
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if text.is_empty() || no_speech > NO_SPEECH_MAX || only_tags(&text) {
        return None;
    }
    let norm = normalize(&text);
    if norm.is_empty() {
        return None;
    }
    if PHANTOM_LINES.contains(&norm.as_str()) || PHANTOM_PREFIXES.iter().any(|start| norm.starts_with(start))
    {
        return None;
    }
    if prompt.map(normalize).is_some_and(|p| !p.is_empty() && p == norm) {
        return None;
    }
    Some(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_real_speech() {
        assert_eq!(keep(" Fix the login, please. ", 0.01, None).as_deref(), Some("Fix the login, please."));
        assert_eq!(keep("Thank you.", 0.05, None).as_deref(), Some("Thank you."));
        assert_eq!(
            keep("Thank you for watching the logs, now fix it", 0.05, None).as_deref(),
            Some("Thank you for watching the logs, now fix it")
        );
    }

    #[test]
    fn drops_known_phantom_lines() {
        for line in [
            "Thank you for watching!",
            "Thanks for watching.",
            "Vielen Dank fürs Zuschauen!",
            "Untertitel im Auftrag des ZDF für funk, 2017",
            "Untertitel von Stephanie Geiges",
            "Subtitles by the Amara.org community",
        ] {
            assert_eq!(keep(line, 0.1, None), None, "{line}");
        }
    }

    #[test]
    fn drops_bracketed_tags() {
        for line in ["[BLANK_AUDIO]", "(Musik)", "[Music] ♪", "*Applaus*", " (upbeat music) [silence] "] {
            assert_eq!(keep(line, 0.0, None), None, "{line}");
        }
        assert_eq!(keep("(quietly) fix it", 0.0, None).as_deref(), Some("(quietly) fix it"));
    }

    #[test]
    fn drops_confident_silence_and_empty_text() {
        assert_eq!(keep("Okay.", 0.9, None), None);
        assert_eq!(keep("   ", 0.0, None), None);
        assert_eq!(keep("...", 0.0, None), None);
    }

    #[test]
    fn drops_an_echo_of_the_initial_prompt() {
        assert_eq!(keep("Tabs: Mail, Calendar.", 0.1, Some("Tabs: mail, calendar")), None);
        assert!(keep("Open mail", 0.1, Some("Tabs: mail, calendar")).is_some());
    }

    #[test]
    fn folds_control_characters() {
        assert_eq!(keep("go\u{1b}[2J on\nnow", 0.0, None).as_deref(), Some("go [2J on now"));
    }
}
