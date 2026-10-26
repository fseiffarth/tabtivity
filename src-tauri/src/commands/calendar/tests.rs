use super::*;
use std::path::PathBuf;

fn tmp_path() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("calendar.json");
    (dir, path)
}

#[test]
fn ics_path_guard_accepts_calendar_extensions() {
    for ok in ["a.ics", "a.ical", "a.ifb", "A.ICS"] {
        assert!(
            check_ics_path(Path::new(ok)).is_ok(),
            "{ok} should be accepted"
        );
    }
}

#[test]
fn ics_path_guard_refuses_anything_else() {
    // The whole point of the guard: an ICS command must not become a
    // read-any-file primitive.
    for bad in [
        "id_rsa",
        "/home/u/.ssh/id_rsa",
        "notes.txt",
        "a.ics.txt",
        "config.toml",
    ] {
        assert!(
            check_ics_path(Path::new(bad)).is_err(),
            "{bad} should be refused"
        );
    }
}

#[test]
fn read_ics_refuses_a_non_ics_path() {
    let (dir, _) = tmp_path();
    let secret = dir.path().join("id_rsa");
    std::fs::write(&secret, "PRIVATE KEY").unwrap();
    let err = calendar_read_ics_blocking(secret.to_string_lossy().into_owned());
    assert!(err.is_err(), "a non-.ics path must be refused");
}

#[test]
fn read_ics_roundtrips_a_calendar_file() {
    let (dir, _) = tmp_path();
    let ics = dir.path().join("cal.ics");
    std::fs::write(&ics, "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n").unwrap();
    let text = calendar_read_ics_blocking(ics.to_string_lossy().into_owned()).unwrap();
    assert!(text.contains("VCALENDAR"));
}

#[test]
fn write_ics_refuses_a_non_ics_path() {
    let (dir, _) = tmp_path();
    let target = dir.path().join("important.conf");
    assert!(calendar_write_ics_blocking(target.to_string_lossy().into_owned(), "x".into()).is_err());
    assert!(!target.exists(), "the refused write must not have happened");
}

/// The mail tripwire, mirrored: no board command may take a filesystem path.
/// The two ICS commands are the documented exception — they exist precisely
/// to open a narrow, extension-checked door to a user-picked file.
#[test]
fn no_todo_command_takes_a_path() {
    let src = include_str!("../calendar.rs");
    let lines: Vec<&str> = src.lines().map(str::trim).collect();
    let mut seen = 0;
    for (i, line) in lines.iter().enumerate() {
        if !line.starts_with("pub fn todo_") && !line.starts_with("pub async fn todo_") {
            continue;
        }
        seen += 1;
        // The whole signature: a command's parameters may wrap onto later lines.
        let end = (i..lines.len()).find(|&j| lines[j].contains('{')).unwrap_or(i);
        let sig = lines[i..=end].join(" ");
        assert!(!sig.contains("path"), "a todo command must not take a path: {sig}");
    }
    // The commands are `async`: a scan that matched only `pub fn` saw none.
    assert!(seen >= 2, "the scan found {seen} todo commands in calendar.rs");
}
