//! Quoting one value as one shell word — the one copy of each rule.
//!
//! Both wrap the value in `'…'`, which both shells take literally; they differ
//! only in how an apostrophe inside is written. cmd.exe has no such quote and
//! is never a target here.

/// Single-quote `s` for a POSIX shell: an embedded `'` becomes `'\''` (close,
/// escaped quote, reopen). The result parses back to exactly `s` whatever it
/// holds — spaces, `$`, backticks, newlines, other quotes.
pub fn posix(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Single-quote `s` as a PowerShell literal string: an embedded `'` is doubled.
/// Nothing else is special inside `'…'`, backslashes included.
pub fn powershell(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn posix_wraps_and_escapes() {
        assert_eq!(posix(""), "''");
        assert_eq!(posix("abc"), "'abc'");
        assert_eq!(posix("a b"), "'a b'");
        assert_eq!(posix("$HOME `id` \"x\" \\n"), "'$HOME `id` \"x\" \\n'");
        assert_eq!(posix("a'b"), "'a'\\''b'");
        assert_eq!(posix("''"), "''\\'''\\'''");
        assert_eq!(posix("line\nbreak"), "'line\nbreak'");
    }

    #[test]
    fn powershell_doubles_apostrophes_only() {
        assert_eq!(powershell(""), "''");
        assert_eq!(powershell("plain"), "'plain'");
        assert_eq!(powershell("it's"), "'it''s'");
        assert_eq!(powershell(r"C:\Users\o'brien\$x"), r"'C:\Users\o''brien\$x'");
    }

    /// The POSIX form survives a real `sh` round trip.
    #[cfg(unix)]
    #[test]
    fn posix_round_trips_through_sh() {
        for value in ["plain", "a'b", "it's $HOME", "''", "back\\slash", "new\nline", "*?[]"] {
            let out = std::process::Command::new("sh")
                .arg("-c")
                .arg(format!("printf %s {}", posix(value)))
                .output()
                .expect("run sh");
            assert_eq!(String::from_utf8_lossy(&out.stdout), value);
        }
    }
}
