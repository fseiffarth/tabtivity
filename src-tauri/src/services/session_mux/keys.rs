//! [`Key`]s as the bytes a terminal sends for them: what a backend that
//! types into a session's input directly (the Windows session host) sends
//! where tmux takes `send-keys` names. Pure, tested on every OS.

use super::Key;

/// The bytes for `keys`, in order; `Err` names a key this table lacks.
pub fn key_bytes(keys: &[Key]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    for key in keys {
        match key {
            Key::Literal(text) => out.extend_from_slice(text.as_bytes()),
            Key::Ctrl(c) => out.push(ctrl_byte(*c).ok_or_else(|| format!("no control byte for C-{c}"))?),
            Key::Named(name) => out.extend_from_slice(named(name).ok_or_else(|| format!("unknown key '{name}'"))?),
        }
    }
    Ok(out)
}

fn ctrl_byte(c: char) -> Option<u8> {
    match c {
        'a'..='z' | 'A'..='Z' => Some(c.to_ascii_lowercase() as u8 & 0x1f),
        '@' | ' ' | '2' => Some(0),
        '[' => Some(0x1b),
        '\\' => Some(0x1c),
        ']' => Some(0x1d),
        '^' => Some(0x1e),
        '_' => Some(0x1f),
        '?' => Some(0x7f),
        _ => None,
    }
}

/// tmux's key names (`key-string.c`), as xterm sends them in normal cursor mode.
fn named(name: &str) -> Option<&'static [u8]> {
    Some(match name {
        "Enter" => b"\r",
        "Escape" => b"\x1b",
        "Tab" => b"\t",
        "BTab" => b"\x1b[Z",
        "BSpace" => b"\x7f",
        "Space" => b" ",
        "Up" => b"\x1b[A",
        "Down" => b"\x1b[B",
        "Right" => b"\x1b[C",
        "Left" => b"\x1b[D",
        "Home" => b"\x1b[H",
        "End" => b"\x1b[F",
        "IC" | "Insert" => b"\x1b[2~",
        "DC" | "Delete" => b"\x1b[3~",
        "PPage" | "PageUp" | "PgUp" => b"\x1b[5~",
        "NPage" | "PageDown" | "PgDn" => b"\x1b[6~",
        "F1" => b"\x1bOP",
        "F2" => b"\x1bOQ",
        "F3" => b"\x1bOR",
        "F4" => b"\x1bOS",
        "F5" => b"\x1b[15~",
        "F6" => b"\x1b[17~",
        "F7" => b"\x1b[18~",
        "F8" => b"\x1b[19~",
        "F9" => b"\x1b[20~",
        "F10" => b"\x1b[21~",
        "F11" => b"\x1b[23~",
        "F12" => b"\x1b[24~",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_schedulers_and_send_nows_keys_map_to_bytes() {
        let keys = [Key::Ctrl('a'), Key::Ctrl('k'), Key::Literal("hi\n".into()), Key::from_name("Enter")];
        assert_eq!(key_bytes(&keys).unwrap(), b"\x01\x0bhi\n\r");
        assert_eq!(key_bytes(&[Key::from_name("C-x"), Key::from_name("C-s")]).unwrap(), b"\x18\x13");
        assert_eq!(key_bytes(&[Key::from_name("Escape"), Key::from_name("C-c")]).unwrap(), b"\x1b\x03");
        assert_eq!(key_bytes(&[Key::Ctrl('C')]).unwrap(), b"\x03");
        assert_eq!(key_bytes(&[Key::from_name("Up"), Key::from_name("BSpace")]).unwrap(), b"\x1b[A\x7f");
    }

    #[test]
    fn an_unknown_key_is_an_error_not_silence() {
        assert!(key_bytes(&[Key::from_name("Hyper")]).is_err());
        assert!(key_bytes(&[Key::Ctrl('1')]).is_err());
    }
}
