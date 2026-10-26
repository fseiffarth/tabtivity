//! Frontend crash/error reporting into crash.log.
//!
//! The native crash logger in `lib.rs` only sees faults in this process;
//! JavaScript errors die silently inside the webview. The frontend forwards
//! them here so every failure mode ends up in the same crash.log.

use std::borrow::Cow;

const MAX_KIND: usize = 40;
const MAX_MESSAGE: usize = 2_000;
const MAX_STACK: usize = 8_000;

/// Append a frontend error to crash.log. Fields are clipped so a runaway
/// error source cannot bloat the log.
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn report_frontend_error(kind: String, message: String, stack: Option<String>) {
    let mut entry = format!(
        "=== FRONTEND {} {} ===\n{}",
        clip(&kind, MAX_KIND),
        crate::storage::iso_now(),
        clip(&message, MAX_MESSAGE),
    );
    if let Some(stack) = stack.as_deref().filter(|s| !s.trim().is_empty()) {
        entry.push('\n');
        entry.push_str(&clip(stack, MAX_STACK));
    }
    crate::crash_log_append(&entry);
}

fn clip(s: &str, max_chars: usize) -> Cow<'_, str> {
    if s.chars().nth(max_chars).is_none() {
        Cow::Borrowed(s)
    } else {
        let mut clipped: String = s.chars().take(max_chars).collect();
        clipped.push_str("…[clipped]");
        Cow::Owned(clipped)
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clip_keeps_short_strings_borrowed() {
        assert!(matches!(clip("short", 10), Cow::Borrowed("short")));
    }

    #[test]
    fn clip_keeps_exact_length_strings() {
        assert_eq!(clip("abcde", 5), "abcde");
    }

    #[test]
    fn clip_truncates_long_strings() {
        assert_eq!(clip("abcdef", 3), "abc…[clipped]");
    }

    #[test]
    fn clip_respects_char_boundaries() {
        // Multi-byte chars must not be split mid-codepoint.
        assert_eq!(clip("äöüß", 2), "äö…[clipped]");
    }
}
