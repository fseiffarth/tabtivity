//! The host build behind `compile_tex_host`: a remote project's `.tex` read
//! from the host (its Remote side, or any file of a host-pinned VM /
//! remote-only project) is built there by `latexmk`, over the pooled
//! ControlMaster, in the background — no build tab. The answer is the same
//! [`TexCompileResult`] a local `compile_tex` gives, so the viewer reports
//! both alike (log, errors, PDF).
//!
//! Pure: the script and the reading of its output. The command in `tex.rs`
//! runs it.

use super::{
    build_succeeded, latexmk_args, latexmk_flag, latexmk_summary, log_has_tex_error, log_shows_shell_escape, tail,
    TexCompileResult, ENGINES, OPENOUT_PARANOID, RUN_TIMEOUT,
};
use crate::services::ssh_exec::shell_quote;

/// Prefix of the lines the script writes to stderr after the build: its exit
/// status and the PDF's stamp before and after. The build's own output goes to
/// stdout, so nothing it prints can pose as one of these.
const MARK: &str = "@@tex-host:";

/// A `.tex` on the host, as the build names it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct HostTex {
    /// The file relative to the project root, `/`-separated.
    pub rel: String,
    /// The PDF latexmk writes beside it, as an absolute host path.
    pub pdf: String,
}

/// Check `path` is a `.tex` under the host project root `root` (POSIX paths,
/// whatever this machine is) and name its PDF. No `..`, `.` or empty step: the
/// build runs where the path says, inside the project.
pub(super) fn host_tex(root: &str, path: &str) -> Result<HostTex, String> {
    crate::services::ssh_common::validate_arg("TeX file", path)?;
    let root = root.trim_end_matches('/');
    let rel = path
        .strip_prefix(root)
        .and_then(|r| r.strip_prefix('/'))
        .filter(|r| !r.is_empty())
        .ok_or_else(|| format!("{path} is not inside the project on the host ({root})"))?;
    if rel.split('/').any(|step| step.is_empty() || step == "." || step == "..") {
        return Err(format!("not a plain path inside the project: {path}"));
    }
    let lower = rel.to_ascii_lowercase();
    if !lower.ends_with(".tex") || rel.len() <= 4 {
        return Err(format!("not a .tex file: {path}"));
    }
    let stem = &path[..path.len() - 4];
    Ok(HostTex { rel: rel.to_string(), pdf: format!("{stem}.pdf") })
}

/// The POSIX `sh` script `run_remote_script_within` runs in the project root.
///
/// The build runs through the user's login shell (`-lc`), as a terminal on the
/// host would, so a TeX installed under the home directory or put on `PATH` by
/// a profile is found; a shell outside the Bourne family (csh, fish) is passed
/// over for `/bin/sh -l`. Its argv is the local build's (`latexmk_args`: no
/// shell-escape, SyncTeX, `file:line:` errors) with `-cd` and `-g` in front —
/// `-cd` builds in the file's folder, `-g` builds although latexmk thinks
/// nothing changed, as a local Compile does — and the file named `./<rel>` so a
/// name starting with `-` is never a flag. Every word is single-quoted, then
/// the whole line again for `-lc`. The host's `timeout` stops a build stuck
/// past the local ceiling, where it has one.
pub(super) fn host_build_script(root: &str, tex: &HostTex, engine: Option<&str>) -> String {
    let engine = engine.filter(|e| ENGINES.contains(e));
    let file = format!("./{}", tex.rel);
    let mut args = vec!["-cd".to_string(), "-g".to_string()];
    args.extend(latexmk_args(engine, &file, None, &[], None));
    let argv: Vec<String> = std::iter::once("latexmk".to_string()).chain(args).map(|a| shell_quote(&a)).collect();
    let build = format!(
        "cd {root} && {key}={val} && export {key} && exec {argv}",
        root = shell_quote(root),
        key = OPENOUT_PARANOID.0,
        val = OPENOUT_PARANOID.1,
        argv = argv.join(" "),
    );
    let secs = RUN_TIMEOUT.as_secs();
    format!(
        "st() {{ stat -c '%y %s' \"$1\" 2>/dev/null || stat -f '%m %z' \"$1\" 2>/dev/null; }}\n\
         b=$(st {pdf})\n\
         case \"${{SHELL##*/}}\" in bash|zsh|ksh|mksh|dash|ash|sh) L=$SHELL ;; *) L=/bin/sh ;; esac\n\
         if command -v timeout >/dev/null 2>&1; then T=\"timeout -k 10 {secs}\"; else T=; fi\n\
         $T \"$L\" -lc {build} 2>&1\n\
         rc=$?\n\
         a=$(st {pdf})\n\
         printf '%s\\n' \"{MARK}rc=$rc\" \"{MARK}before=$b\" \"{MARK}after=$a\" >&2",
        pdf = shell_quote(&tex.pdf),
        build = shell_quote(&build),
    )
}

/// Read the script's run into the local build's answer. `None` when the marks
/// are missing: the script never ran to its end (ssh could not reach the host,
/// or was stopped), and stderr is then the reason.
pub(super) fn read_host_build(tex: &HostTex, engine: Option<&str>, stdout: &str, stderr: &str) -> Option<TexCompileResult> {
    let mark = |key: &str| {
        stderr.lines().rev().find_map(|l| l.strip_prefix(MARK)?.strip_prefix(key)?.strip_prefix('=')).map(str::trim)
    };
    let rc: i32 = mark("rc")?.parse().ok()?;
    let before = mark("before")?;
    let after = mark("after")?;
    let mut log = stdout.to_string();
    // `timeout` answers 124 for the build it stopped (137 when it had to KILL).
    if rc == 124 || rc == 137 {
        log.push_str(&format!(
            "\n! {app} stopped latexmk after {} seconds — the build appears to be stuck.\n",
            RUN_TIMEOUT.as_secs(),
            app = crate::brand::DISPLAY
        ));
    }
    let exists = !after.is_empty();
    let fresh = exists && after != before;
    let ok = rc == 0;
    let engine = engine.filter(|e| ENGINES.contains(e));
    Some(TexCompileResult {
        success: build_succeeded(ok, exists, fresh, log_has_tex_error(&log)),
        pdf_path: exists.then(|| tex.pdf.clone()),
        engine: format!("latexmk {} (host)", latexmk_flag(engine)),
        shell_escape: log_shows_shell_escape(&log),
        driver_note: if ok { None } else { latexmk_summary(&log) },
        log: tail(&log),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROOT: &str = "/srv/p";

    #[test]
    fn a_tex_under_the_root_names_its_pdf_beside_it() {
        let tex = host_tex("/srv/p/", "/srv/p/ch 1/Main.TEX").unwrap();
        assert_eq!(tex.rel, "ch 1/Main.TEX");
        assert_eq!(tex.pdf, "/srv/p/ch 1/Main.pdf");
    }

    #[test]
    fn only_a_plain_tex_inside_the_root_builds() {
        for bad in [
            "/srv/pother/a.tex",
            "/elsewhere/a.tex",
            "/srv/p",
            "/srv/p/",
            "/srv/p/a.txt",
            "/srv/p/.tex",
            "/srv/p/../etc/a.tex",
            "/srv/p/a/./b.tex",
            "/srv/p//a.tex",
            "/srv/p/a\nb.tex",
            "-x.tex",
        ] {
            assert!(host_tex(ROOT, bad).is_err(), "{bad:?} was accepted");
        }
    }

    #[test]
    fn the_script_quotes_the_file_and_never_enables_shell_escape() {
        let tex = host_tex(ROOT, "/srv/p/ch 1/-main's.tex").unwrap();
        let script = host_build_script(ROOT, &tex, Some("lualatex"));
        // The build line is quoted twice (its words, then the whole line for
        // `-lc`), so the file's own quote is escaped twice over.
        assert!(script.contains("-pdflua"), "{script}");
        assert!(script.contains("./ch 1/-main"), "{script}");
        assert!(!script.contains("'./ch 1/-main's.tex'"), "the file's quote broke out: {script}");
        assert!(script.contains("-no-shell-escape"));
        assert!(!script.replace("-no-shell-escape", "").contains("shell-escape"));
        assert!(script.contains("openout_any=p"));
        assert!(script.contains("'-cd'") && script.contains("'-g'"));
        // The PDF's stamp is taken on its own quoted path.
        assert!(script.contains("b=$(st '/srv/p/ch 1/-main'\\''s.pdf')"), "{script}");
    }

    #[test]
    fn an_unknown_engine_builds_with_pdflatex() {
        let tex = host_tex(ROOT, "/srv/p/a.tex").unwrap();
        let script = host_build_script(ROOT, &tex, Some("-pdf; rm -rf ~"));
        assert!(!script.contains("rm -rf"));
        assert!(script.contains("-pdf"));
    }

    /// The script as `run_remote_script` hands it to the host's shell, with a
    /// stand-in latexmk that writes the PDF: it parses, reaches the build
    /// through the login shell with the argv intact, and its marks read back.
    #[cfg(target_os = "linux")]
    #[test]
    fn the_script_runs_under_sh_and_reports_the_pdf_it_wrote() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("proj");
        let bin = tmp.path().join("bin");
        std::fs::create_dir_all(root.join("ch 1")).unwrap();
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(root.join("ch 1").join("it's.tex"), "x").unwrap();
        let fake = bin.join("latexmk");
        std::fs::write(
            &fake,
            "#!/bin/sh\nfor a; do printf '[%s]\\n' \"$a\"; f=$a; done\nprintf '%%PDF' > \"${f%.tex}.pdf\"\n",
        )
        .unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        let root_s = root.to_str().unwrap();
        let tex = host_tex(root_s, &format!("{root_s}/ch 1/it's.tex")).unwrap();
        let script = host_build_script(root_s, &tex, Some("xelatex"));
        let line = format!("cd {} && {{ {script}\n}}", shell_quote(root_s));
        let path = format!("{}:{}", bin.display(), std::env::var("PATH").unwrap_or_default());
        let out = std::process::Command::new("sh")
            .arg("-c")
            .arg(&line)
            .env("PATH", path)
            .env("SHELL", "/bin/sh")
            .env("HOME", tmp.path())
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&out.stdout);
        let stderr = String::from_utf8_lossy(&out.stderr);
        let res = read_host_build(&tex, Some("xelatex"), &stdout, &stderr).unwrap_or_else(|| panic!("{stderr}"));
        assert!(res.success, "{stdout}\n{stderr}");
        assert_eq!(res.pdf_path.as_deref(), Some(format!("{root_s}/ch 1/it's.pdf").as_str()));
        for arg in ["[-cd]", "[-g]", "[-pdfxe]", "[-no-shell-escape]", "[./ch 1/it's.tex]"] {
            assert!(stdout.contains(arg), "{arg} missing: {stdout}");
        }
    }

    fn marks(rc: i32, before: &str, after: &str) -> String {
        format!("ssh noise\n{MARK}rc={rc}\n{MARK}before={before}\n{MARK}after={after}\n")
    }

    #[test]
    fn a_clean_build_reports_the_host_pdf() {
        let tex = host_tex(ROOT, "/srv/p/a.tex").unwrap();
        let res = read_host_build(&tex, None, "Latexmk: All targets are up-to-date\n", &marks(0, "", "2026 100")).unwrap();
        assert!(res.success);
        assert_eq!(res.pdf_path.as_deref(), Some("/srv/p/a.pdf"));
        assert_eq!(res.driver_note, None);
    }

    #[test]
    fn a_failed_build_with_an_old_pdf_is_a_failure() {
        let tex = host_tex(ROOT, "/srv/p/a.tex").unwrap();
        let log = "./a.tex:3: Undefined control sequence.\n";
        let res = read_host_build(&tex, None, log, &marks(12, "t1 5", "t1 5")).unwrap();
        assert!(!res.success);
        assert_eq!(res.pdf_path.as_deref(), Some("/srv/p/a.pdf"));
        assert!(res.log.contains("Undefined control sequence"));
    }

    #[test]
    fn a_driver_complaint_over_a_fresh_pdf_is_forgiven() {
        let tex = host_tex(ROOT, "/srv/p/a.tex").unwrap();
        let res = read_host_build(&tex, None, "Output written on a.pdf\n", &marks(12, "t1 5", "t2 6")).unwrap();
        assert!(res.success);
    }

    #[test]
    fn a_stopped_build_says_so_and_a_run_without_marks_is_no_answer() {
        let tex = host_tex(ROOT, "/srv/p/a.tex").unwrap();
        let res = read_host_build(&tex, None, "(./a.tex\n", &marks(124, "", "")).unwrap();
        assert!(!res.success);
        assert!(res.log.contains("appears to be stuck"));
        assert!(read_host_build(&tex, None, "", "ssh: connect to host h port 22: refused\n").is_none());
    }

    #[test]
    fn a_mark_printed_by_the_build_itself_is_not_read() {
        // The build's output is stdout; only stderr carries the marks.
        let tex = host_tex(ROOT, "/srv/p/a.tex").unwrap();
        let stdout = format!("{MARK}rc=0\n{MARK}before=\n{MARK}after=x\n");
        assert!(read_host_build(&tex, None, &stdout, "").is_none());
    }
}
