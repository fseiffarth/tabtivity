//! What the Windows ConPTY spawn (`win/conpty.rs`) hands `CreateProcessW`,
//! built purely so it is tested on every OS: the command line, quoted so the
//! child's `CommandLineToArgvW` / MSVC runtime reads back exactly `argv`, and
//! the Unicode environment block (exactly the client's env, nothing added).

/// `argv` as one Windows command line. `argv[0]` is the program, which
/// `CreateProcessW` takes from `lpApplicationName`, so here it only sets the
/// child's own `argv[0]`: quoted whole, since the program-name rule knows no
/// escapes (a `"` in it is refused). Every other argument follows the MSVC
/// rules: backslashes double only before a quote or the closing quote.
pub fn command_line(argv: &[String]) -> Result<String, &'static str> {
    let Some((program, args)) = argv.split_first() else { return Err("argv is empty") };
    if program.contains('"') {
        return Err("a quote in argv[0]");
    }
    let mut out = String::new();
    out.push('"');
    out.push_str(program);
    out.push('"');
    for arg in args {
        out.push(' ');
        quote_arg(arg, &mut out);
    }
    Ok(out)
}

fn quote_arg(arg: &str, out: &mut String) {
    if !arg.is_empty() && !arg.contains([' ', '\t', '\n', '\x0b', '"']) {
        out.push_str(arg);
        return;
    }
    out.push('"');
    let mut backslashes = 0usize;
    for c in arg.chars() {
        match c {
            '\\' => backslashes += 1,
            '"' => {
                out.extend(std::iter::repeat_n('\\', backslashes * 2 + 1));
                out.push('"');
                backslashes = 0;
            }
            _ => {
                out.extend(std::iter::repeat_n('\\', backslashes));
                out.push(c);
                backslashes = 0;
            }
        }
    }
    out.extend(std::iter::repeat_n('\\', backslashes * 2));
    out.push('"');
}

/// The `CREATE_UNICODE_ENVIRONMENT` block for exactly `env`: `KEY=VALUE\0`
/// entries sorted by key without regard to case (as Windows keeps them), a
/// later duplicate of a key (any case) replacing an earlier one, then a final
/// `\0`. An empty env is the two-NUL empty block.
pub fn env_block(env: &[(String, String)]) -> Vec<u16> {
    let mut entries: Vec<(&str, &str)> = Vec::new();
    for (key, value) in env {
        match entries.iter_mut().find(|(k, _)| k.eq_ignore_ascii_case(key)) {
            Some(slot) => *slot = (key, value),
            None => entries.push((key, value)),
        }
    }
    entries.sort_by_key(|(k, _)| k.to_uppercase());
    let mut block = Vec::new();
    for (key, value) in entries {
        block.extend(key.encode_utf16());
        block.push(u16::from(b'='));
        block.extend(value.encode_utf16());
        block.push(0);
    }
    if block.is_empty() {
        block.push(0);
    }
    block.push(0);
    block
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(argv: &[&str]) -> String {
        command_line(&argv.iter().map(|s| s.to_string()).collect::<Vec<_>>()).unwrap()
    }

    /// The MSVC reading of an argument string (`CommandLineToArgvW`'s rules
    /// past the program name), to check the quoting round-trips.
    fn parse_args(s: &str) -> Vec<String> {
        let mut out = Vec::new();
        let chars: Vec<char> = s.chars().collect();
        let mut i = 0;
        while i < chars.len() {
            while i < chars.len() && (chars[i] == ' ' || chars[i] == '\t') {
                i += 1;
            }
            if i >= chars.len() {
                break;
            }
            let mut arg = String::new();
            let mut quoted = false;
            while i < chars.len() && (quoted || (chars[i] != ' ' && chars[i] != '\t')) {
                if chars[i] == '\\' {
                    let start = i;
                    while i < chars.len() && chars[i] == '\\' {
                        i += 1;
                    }
                    let n = i - start;
                    if i < chars.len() && chars[i] == '"' {
                        arg.extend(std::iter::repeat_n('\\', n / 2));
                        if n % 2 == 1 {
                            arg.push('"');
                            i += 1;
                        }
                    } else {
                        arg.extend(std::iter::repeat_n('\\', n));
                    }
                } else if chars[i] == '"' {
                    quoted = !quoted;
                    i += 1;
                } else {
                    arg.push(chars[i]);
                    i += 1;
                }
            }
            out.push(arg);
        }
        out
    }

    #[test]
    fn the_program_is_quoted_whole_and_plain_args_stay_bare() {
        assert_eq!(line(&[r"C:\Program Files\x.exe", "/c", "echo"]), r#""C:\Program Files\x.exe" /c echo"#);
        assert_eq!(line(&[r"C:\a.exe"]), r#""C:\a.exe""#);
        assert!(command_line(&[r#"C:\a"b.exe"#.to_string()]).is_err());
        assert!(command_line(&[]).is_err());
    }

    #[test]
    fn every_argument_reads_back_exactly() {
        let args = [
            "",
            "plain",
            "two words",
            r#"say "hi""#,
            r"C:\dir\",
            r"C:\dir with space\",
            r#"back\\"quote"#,
            r"\\server\share",
            "tab\there",
            "é ünïcode",
            r#"""#,
        ];
        let mut argv = vec![r"C:\p.exe".to_string()];
        argv.extend(args.iter().map(|s| s.to_string()));
        let text = command_line(&argv).unwrap();
        let rest = text.strip_prefix(r#""C:\p.exe""#).unwrap();
        assert_eq!(parse_args(rest), args.iter().map(|s| s.to_string()).collect::<Vec<_>>(), "{text}");
    }

    fn decode(block: &[u16]) -> String {
        String::from_utf16(block).unwrap()
    }

    #[test]
    fn the_env_block_is_exactly_the_env_sorted_and_double_terminated() {
        let env = vec![
            ("Path".to_string(), r"C:\bin".to_string()),
            ("A".to_string(), "1".to_string()),
            ("b".to_string(), "x=y".to_string()),
        ];
        assert_eq!(decode(&env_block(&env)), "A=1\0b=x=y\0Path=C:\\bin\0\0");
        assert_eq!(env_block(&[]), vec![0, 0]);
    }

    #[test]
    fn a_later_duplicate_key_wins_whatever_its_case() {
        let env = vec![("PATH".to_string(), "old".to_string()), ("Path".to_string(), "new".to_string())];
        assert_eq!(decode(&env_block(&env)), "Path=new\0\0");
    }
}
