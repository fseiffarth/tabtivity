//! Directory links on Windows that need no privilege: junctions.
//!
//! A Windows symlink needs `SeCreateSymbolicLinkPrivilege` (or Developer
//! Mode), which an ordinary account does not hold; a directory junction is a
//! reparse point any user may create, and std treats it as a symlink for
//! `is_symlink`, `read_link` and `remove_dir`. Box member links
//! (`commands::boxes`), the state-dir move of the brand migration and a
//! project import's directory links (`commands::project_transfer`) all make
//! theirs here. The command line is built by the pure [`mklink_junction_line`].

use std::path::Path;

/// The `cmd` line that makes a junction at `at` leading to `target`: both
/// paths quoted verbatim (`mklink` is a `cmd` builtin and takes no argv) with
/// a `\\?\` prefix dropped, which `mklink` would store as part of the
/// target. The verbatim UNC form `\\?\UNC\srv\share` (what `canonicalize`
/// returns on a mapped network drive) becomes `\\srv\share` — dropping only
/// `\\?\` would leave the relative `UNC\srv\share`, which `mklink` resolves
/// against its working directory. A path holding a `"` is refused — Windows
/// never allows one in a name, so it can only be a malformed or hostile
/// string.
pub fn mklink_junction_line(target: &Path, at: &Path) -> Result<String, String> {
    let plain = |p: &Path| {
        let s = p.to_string_lossy();
        if let Some(unc) = s.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{unc}");
        }
        s.strip_prefix(r"\\?\").unwrap_or(&s).to_string()
    };
    let (target, at) = (plain(target), plain(at));
    if target.contains('"') || at.contains('"') {
        return Err("the path holds a quote".into());
    }
    Ok(format!("/D /C mklink /J \"{at}\" \"{target}\""))
}

/// Make a directory junction at `at` leading to `target` (absolute; a
/// missing one is accepted and leaves a dangling junction, like a Unix
/// symlink). `cmd` comes through the trusted-helper lookup of
/// `paths::command_no_window`.
#[cfg(windows)]
pub fn make_junction(target: &Path, at: &Path) -> std::io::Result<()> {
    use std::os::windows::process::CommandExt;
    let line = mklink_junction_line(target, at).map_err(std::io::Error::other)?;
    let out = crate::paths::command_no_window("cmd")
        .raw_arg(line)
        .output()?;
    if out.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let message = if stderr.trim().is_empty() {
            "mklink /J failed".to_string()
        } else {
            stderr.trim().to_string()
        };
        Err(std::io::Error::other(message))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_junction_line_quotes_both_paths_link_first() {
        let line = mklink_junction_line(
            Path::new(r"C:\work\member one"),
            Path::new(r"C:\boxes\b\member one"),
        )
        .unwrap();
        assert_eq!(
            line,
            r#"/D /C mklink /J "C:\boxes\b\member one" "C:\work\member one""#
        );
    }

    #[test]
    fn a_verbatim_prefix_is_dropped_and_a_quote_refused() {
        let line = mklink_junction_line(Path::new(r"\\?\C:\work\m"), Path::new(r"C:\b\m")).unwrap();
        assert_eq!(line, r#"/D /C mklink /J "C:\b\m" "C:\work\m""#);
        assert!(mklink_junction_line(Path::new("C:\\a\" & calc \""), Path::new(r"C:\b")).is_err());
        assert!(mklink_junction_line(Path::new(r"C:\a"), Path::new("C:\\b\"")).is_err());
    }

    #[test]
    fn a_verbatim_unc_path_keeps_its_leading_backslashes() {
        let line = mklink_junction_line(
            Path::new(r"\\?\UNC\srv\share\proj\data"),
            Path::new(r"\\?\UNC\srv\share\proj\link"),
        )
        .unwrap();
        assert_eq!(
            line,
            r#"/D /C mklink /J "\\srv\share\proj\link" "\\srv\share\proj\data""#
        );
    }
}
