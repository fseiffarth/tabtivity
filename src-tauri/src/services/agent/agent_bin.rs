//! Tabtivity-owned commands reachable from local, fenced and container tabs:
//! `tabtivity-send`, `tabtivity-mcp` (Tabtivity's MCP tools for a CLI that was
//! not told about them at launch), and one **agent shim** per registry CLI
//! (`agent_shim`).
//!
//! The shims sit at the front of every tab's PATH. In a shell tab (never
//! fenced) a typed `claude` reaches the shim, which asks Tabtivity's own binary
//! to build the tab's fence and execs into it — same scope home, same shared
//! logins as an agent tab. Inside a fence the shim steps aside and execs the
//! real CLI from the rest of PATH. Written at every startup, so they always
//! name the running Tabtivity.
use crate::brand::{DISPLAY, UPPER};
use std::{fs, io, path::{Path, PathBuf}};

/// A second name a vendor's installer writes beside its CLI, and the registry
/// CLI it runs. `opencode.ai/v2/install` leaves an `opencode2` that execs the
/// real `opencode` next to it, in a folder on every tab's PATH: unshadowed,
/// typing it in a shell tab skips the fence. It gets its CLI's own shim.
const VENDOR_ALIASES: &[(&str, &str)] = &[("opencode2", "opencode")];

/// The command an agent runs to call Tabtivity's MCP tools when its CLI was
/// not told about them at launch (`agent_registry::McpWiring::None`).
pub const MCP_CLI: &str = concat!(crate::app_slug!(), "-mcp");

pub fn bin_dir() -> PathBuf { crate::storage::state_dir().join("bin") }

pub fn install() -> io::Result<()> {
    let exe = std::env::current_exe().ok();
    install_in(&bin_dir(), exe.as_deref(), &crate::services::agent_registry::agent_bins())
}

fn install_in(dir: &Path, exe: Option<&Path>, clis: &[&str]) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    // The POSIX script is needed even on Windows for Docker containers.
    // brand-check: allow — an include path is a literal; the script file is renamed at the flip
    write_script(dir, crate::brand::SEND_CLI, include_bytes!("../../../../scripts/tabtivity-send.sh"))?;
    // brand-check: allow — an include path is a literal; the script file is renamed at the flip
    write_script(dir, MCP_CLI, include_bytes!("../../../../scripts/tabtivity-mcp.sh"))?;
    #[cfg(windows)]
    {
        // brand-check: allow — an include path is a literal; the script file is renamed at the flip
        write_script(dir, concat!(crate::app_slug!(), "-mcp.cmd"), include_bytes!("../../../../scripts/tabtivity-mcp.cmd"))?;
        // brand-check: allow — an include path is a literal; the script file is renamed at the flip
        write_script(dir, concat!(crate::app_slug!(), "-mcp.ps1"), include_bytes!("../../../../scripts/tabtivity-mcp.ps1"))?;
        // brand-check: allow — an include path is a literal; the script file is renamed at the flip
        write_script(dir, concat!(crate::app_slug!(), "-send.cmd"), include_bytes!("../../../../scripts/tabtivity-send.cmd"))?;
        // brand-check: allow — an include path is a literal; the script file is renamed at the flip
        write_script(dir, concat!(crate::app_slug!(), "-send.ps1"), include_bytes!("../../../../scripts/tabtivity-send.ps1"))?;
    }
    // After a rename the old name of the send command stays for one release,
    // as an alias that runs the current one and is counted — on an install
    // that was upgraded across the rename. Nothing is installed under a
    // second name while the name is unchanged, or on a fresh install.
    let pair = crate::brand::PAIR;
    let upgraded = crate::services::brand_migration::upgraded_install(&pair, &crate::storage::state_dir());
    if let (true, Some(old), Some(alias)) = (
        upgraded,
        pair.legacy(crate::brand::Name::SEND_CLI),
        crate::services::brand_migration::compat::send_alias_script(&pair),
    ) {
        write_script(dir, &old, alias.as_bytes())?;
        #[cfg(windows)]
        if let Some(alias) = crate::services::brand_migration::compat::send_alias_cmd(&pair) {
            write_script(dir, &format!("{old}.cmd"), alias.as_bytes())?;
        }
    }
    #[cfg(target_os = "macos")]
    write_script(dir, "mktemp", mktemp_shim_script().as_bytes())?;
    if let Some(exe) = exe {
        let aliases = VENDOR_ALIASES.iter().filter(|(_, cli)| clis.contains(cli)).copied();
        for (name, cli) in clis.iter().map(|cli| (*cli, *cli)).chain(aliases) {
            // An extensionless `#!/bin/sh` file first on PATH is not
            // launchable on Windows: a PTY spawn of the bare name found it
            // and died with os error 193. Drop one an earlier build wrote;
            // `cmd` and PowerShell find the `.cmd` twin by PATHEXT instead.
            if cfg!(windows) {
                let _ = fs::remove_file(dir.join(name));
                write_script(dir, &format!("{name}.cmd"), cmd_shim_script(cli, exe).as_bytes())?;
                continue;
            }
            write_script(dir, name, shim_script(cli, exe, dir).as_bytes())?;
        }
    }
    Ok(())
}

/// The `mktemp` in front of macOS's (installed on macOS only). Its `mktemp`
/// never reads `$TMPDIR`: without a template it asks the system
/// (`confstr(_CS_DARWIN_USER_TEMP_DIR)`) and lands in the user's own
/// `/var/folders/…/T`, which the Seatbelt fence hides (2442n), so every bare
/// `mktemp` in a fenced tab failed. Inside a fence a call without a template
/// (`mktemp`, `-d`, `-q`, `-u`, `-t prefix`) gets one in `$TMPDIR`, the scope's
/// private temp dir; anything else — a template, `-p`, an option this does not
/// know, or no fence — runs the real one untouched. Programs that ask the
/// system themselves (Foundation's `NSTemporaryDirectory`) are not covered.
#[cfg(any(target_os = "macos", all(test, unix)))]
pub(crate) fn mktemp_shim_script() -> String {
    mktemp_shim_script_for("/usr/bin/mktemp")
}

#[cfg(any(target_os = "macos", all(test, unix)))]
fn mktemp_shim_script_for(real: &str) -> String {
    format!(
        "#!/bin/sh\n\
         # {DISPLAY} fence mktemp: a call without a template gets one in $TMPDIR (services::agent_bin).\n\
         real={real}\n\
         if [ -z \"${{{UPPER}_AGENT_FENCE:-}}\" ] || [ -z \"${{TMPDIR:-}}\" ]; then\n\
         \x20   exec \"$real\" \"$@\"\n\
         fi\n\
         prefix=tmp\n\
         flags=\n\
         want_prefix=\n\
         for a in \"$@\"; do\n\
         \x20   if [ -n \"$want_prefix\" ]; then prefix=$a; want_prefix=; continue; fi\n\
         \x20   case $a in\n\
         \x20       -t) want_prefix=1 ;;\n\
         \x20       -t?*) prefix=${{a#-t}} ;;\n\
         \x20       -[dqu]|-[dqu][dqu]|-[dqu][dqu][dqu]) flags=\"$flags $a\" ;;\n\
         \x20       *) exec \"$real\" \"$@\" ;;\n\
         \x20   esac\n\
         done\n\
         [ -z \"$want_prefix\" ] || exec \"$real\" \"$@\"\n\
         # $flags holds only -d/-q/-u letters: split on purpose.\n\
         exec \"$real\" $flags \"${{TMPDIR%/}}/$prefix.XXXXXXXXXX\"\n",
        real = crate::quote::posix(real),
    )
}

/// The shim for `cli`: exec the fence through `exe`, or — already inside a
/// fence, or in the root console's Host session, which is unfenced by the
/// user's explicit choice — the real CLI found on PATH minus this directory.
/// POSIX `sh`; no bypass flag.
///
/// Only the *lookup* skips this directory; the CLI runs with PATH as it came,
/// so `tabtivity-send` (which lives here too) stays reachable from the agent and
/// every shell it opens. Trimming the exported PATH lost it in every fenced
/// tab (2026-09-29).
pub(crate) fn shim_script(cli: &str, exe: &Path, dir: &Path) -> String {
    let quote = crate::quote::posix;
    format!(
        "#!/bin/sh\n\
         # {DISPLAY} agent shim: runs {cli} fenced in this tab's scope (services::agent_shim).\n\
         {legacy_env}if [ -n \"${{{UPPER}_AGENT_FENCE:-}}\" ] || [ -n \"${{{UPPER}_HOST_SESSION:-}}\" ]; then\n\
         \x20   real=$(PATH=$(printf '%s' \"$PATH\" | tr ':' '\\n' | grep -vx -- {dir} | paste -sd: -); command -v {cli_q}) || {{\n\
         \x20       echo {not_found} >&2\n\
         \x20       exit 127\n\
         \x20   }}\n\
         \x20   exec \"$real\" \"$@\"\n\
         fi\n\
         exec {exe} --agent-shim {cli_q} \"$@\"\n",
        cli = cli,
        legacy_env = crate::services::brand_migration::compat::script_preamble_sh(&["AGENT_FENCE", "HOST_SESSION"]),
        cli_q = quote(cli),
        not_found = quote(&format!("{cli}: command not found")),
        dir = quote(&dir.to_string_lossy()),
        exe = quote(&exe.to_string_lossy()),
    )
}

/// The Windows shim for `cli`, a batch file: ask `exe --agent-shim-env` for
/// the real CLI and the scope's environment (`agent_shim::run_env`), set it
/// for this one run (`setlocal`), and start the CLI on the same console.
/// Windows has no fence, so this is what an agent tab of the scope gets
/// there: its home, the Windows profile set and the shared logins. A refusal
/// is printed and the shim stops. Delayed expansion stays off while values
/// and arguments pass through, so a `!` in either survives.
pub(crate) fn cmd_shim_script(cli: &str, exe: &Path) -> String {
    let (real, call, err) = crate::services::agent_shim::windows_answer_vars();
    let exe = exe.to_string_lossy();
    // A CLI name is a registry id (`[a-z0-9-]`); nothing in it needs quoting.
    format!(
        "@echo off\r\n\
         rem {DISPLAY} agent shim: runs {cli} in this tab's scope home (services::agent_shim).\r\n\
         setlocal DisableDelayedExpansion\r\n\
         set \"{real}=\"\r\n\
         set \"{call}=\"\r\n\
         set \"{err}=\"\r\n\
         for /f \"usebackq delims=\" %%L in (`\"\"{exe}\" --agent-shim-env {cli}\"`) do set \"%%L\"\r\n\
         if defined {real} goto run\r\n\
         if not defined {err} set \"{err}={cli}: the agent shim gave no answer\"\r\n\
         setlocal EnableDelayedExpansion\r\n\
         echo(!{err}! 1>&2\r\n\
         exit /b 1\r\n\
         :run\r\n\
         %{call}% \"%{real}%\" %*\r\n\
         exit /b %errorlevel%\r\n"
    )
}

fn write_script(dir: &Path, name: &str, bytes: &[u8]) -> io::Result<()> {
    let path = dir.join(name);
    if fs::read(&path).ok().as_deref() != Some(bytes) { fs::write(&path, bytes)?; }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o755))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    use crate::brand::SLUG;
    use super::*;
    #[test]
    fn install_preserves_matching_bytes_and_repairs_drift() {
        let dir = tempfile::tempdir().unwrap();
        install_in(dir.path(), None, &[]).unwrap();
        let script = dir.path().join(concat!(crate::app_slug!(), "-send"));
        let modified = fs::metadata(&script).unwrap().modified().unwrap();
        install_in(dir.path(), None, &[]).unwrap();
        assert_eq!(fs::metadata(&script).unwrap().modified().unwrap(), modified);
        fs::write(&script, "drift").unwrap();
        install_in(dir.path(), None, &[]).unwrap();
        // brand-check: allow — an include path is a literal; the script file is renamed at the flip
        assert_eq!(fs::read(&script).unwrap(), include_bytes!("../../../../scripts/tabtivity-send.sh"));
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(script).unwrap().permissions().mode() & 0o777, 0o755);
        }
    }

    #[test]
    fn install_writes_the_mcp_command_beside_send() {
        let dir = tempfile::tempdir().unwrap();
        install_in(dir.path(), None, &[]).unwrap();
        // brand-check: allow — an include path is a literal; the script file is renamed at the flip
        assert_eq!(fs::read(dir.path().join(MCP_CLI)).unwrap(), include_bytes!("../../../../scripts/tabtivity-mcp.sh"));
    }

    /// The MCP command's PowerShell twin, held to the sh script as the send
    /// twin is: every literal `fail CODE '…'` line and the lane list, spelled
    /// the same with the same exit code.
    #[test]
    fn powershell_mcp_twin_matches_the_sh_messages() {
        // brand-check: allow — include paths are literals; the script files are renamed at the flip
        let sh = include_str!("../../../../scripts/tabtivity-mcp.sh");
        // brand-check: allow — include paths are literals; the script files are renamed at the flip
        let ps1 = include_str!("../../../../scripts/tabtivity-mcp.ps1");
        let mut checked = 0;
        for line in sh.lines() {
            let Some(at) = line.find("fail ") else { continue };
            let rest = &line[at + 5..];
            let Some((code, quoted)) = rest.split_once(' ') else { continue };
            let Some(message) = quoted.strip_prefix('\'').and_then(|m| m.split('\'').next()) else { continue };
            // PowerShell needs no curl.
            if message.contains("curl") { continue; }
            assert!(ps1.contains(&format!("Fail {code} '{message}'")), "ps1 lacks Fail {code} '{message}'");
            checked += 1;
        }
        assert!(checked >= 5, "only {checked} messages checked");
        for lane in ["print", "git", "markup", "help", "cockpit", "tabs", "schedule", "root"] {
            assert!(sh.contains(lane) && ps1.contains(&format!("'{lane}'")), "{lane}");
        }
        assert!(sh.contains("http://127.0.0.1:") && ps1.contains("http://127\\.0\\.0\\.1:"));
    }

    /// The PowerShell twin cannot run here, so it is held to the sh script at
    /// string level: the same marker leaves, byte caps and origin exclusion,
    /// and every `fail CODE 'message'`, `report='…'` and `app-send: …` line
    /// of the sh twin spelled the same (with the same exit code) in the PS1.
    #[test]
    fn powershell_send_twin_matches_the_sh_leaves_caps_and_messages() {
        // brand-check: allow — include paths are literals; the script files are renamed at the flip
        let sh = include_str!("../../../../scripts/tabtivity-send.sh");
        // brand-check: allow — include paths are literals; the script files are renamed at the flip
        let ps1 = include_str!("../../../../scripts/tabtivity-send.ps1");
        let outbox_exclusion = concat!(".", crate::app_slug!(), "/");
        for needle in [".$leaf.tab", ".$leaf.src", ".send-lock", ".send-", "25165824", "25165825", "1073741824", outbox_exclusion] {
            assert!(sh.contains(needle), "sh lacks {needle:?}");
            assert!(ps1.contains(needle), "ps1 lacks {needle:?}");
        }
        // The leaf loop counts a dangling link as taken (`-e || -L`); the
        // PS1's `Present`, never `Test-Path`, which follows links.
        for leaf in ["$leaf", ".$leaf.tab", ".$leaf.src"] {
            assert!(sh.contains(&format!("[ -L \"$outbox/{leaf}\" ]")), "sh lacks the -L check of {leaf}");
        }
        for var in ["$dest", "$marker", "$origin"] {
            assert!(ps1.contains(&format!("(Present {var})")), "ps1 lacks `(Present {var})`");
            assert!(!ps1.contains(&format!("Test-Path -LiteralPath {var}")), "ps1 follows links at {var}");
        }
        // `fail CODE 'message'` → `Fail CODE 'message'`.
        let quoted = |rest: &str| rest.strip_prefix('\'').and_then(|r| r.split_once('\'')).map(|(msg, _)| msg.to_string());
        let mut fails = Vec::new();
        for (i, _) in sh.match_indices("fail ") {
            let rest = &sh[i + 5..];
            let (code, rest) = rest.split_once(' ').unwrap();
            if let (Ok(code), Some(msg)) = (code.parse::<u8>(), quoted(rest)) {
                fails.push((code, msg));
            }
        }
        assert!(fails.len() >= 14, "the sh twin's fail table was not read: {fails:?}");
        for (code, msg) in &fails {
            assert!(ps1.contains(&format!("Fail {code} '{msg}'")), "ps1 lacks `Fail {code} '{msg}'`");
        }
        assert!(fails.iter().all(|(code, _)| (2..=5).contains(code)));
        // `report='kind'` → `return 'kind'`.
        let reports: Vec<_> = sh.match_indices("report='").filter_map(|(i, _)| quoted(&sh[i + 7..])).collect();
        assert_eq!(reports.len(), 4, "{reports:?}");
        for kind in &reports {
            assert!(ps1.contains(&format!("return '{kind}'")), "ps1 lacks `return '{kind}'`");
        }
        // Every single-quoted literal naming the command (the four usage
        // lines, `outbox cleared.`, the warning), quoted the same; the
        // `fail` helper's `printf` format is not a message.
        let lines: Vec<_> = sh
            .lines()
            .flat_map(|line| line.split('\'').skip(1).step_by(2))
            .filter(|l| l.contains(crate::brand::SEND_CLI) && !l.contains('%'))
            .collect();
        assert_eq!(lines.len(), 6, "{lines:?}");
        for line in &lines {
            assert!(ps1.contains(&format!("'{line}'")), "ps1 lacks '{line}'");
        }
        assert!(lines.iter().any(|l| l.ends_with("outbox cleared.")));
        assert!(lines.iter().any(|l| l.contains("warning: ")));
        assert!(lines.iter().any(|l| l.ends_with(" --help")));
        assert!(lines.iter().any(|l| l.ends_with(" -n NAME")));
    }

    /// Windows runs no `sh` shim, a vendor alias's included: none is written,
    /// and one an earlier build left is removed, so a bare `claude` in a PTY
    /// cannot resolve to it. The `.cmd` twin is written instead (2442d).
    #[cfg(windows)]
    #[test]
    fn windows_gets_cmd_shims_and_a_stale_sh_one_is_removed() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("claude"), "#!/bin/sh\n").unwrap();
        fs::write(dir.path().join("opencode2"), "#!/bin/sh\n").unwrap();
        install_in(dir.path(), Some(Path::new(concat!(crate::app_slug!(), ".exe"))), &["claude", "agy", "opencode"]).unwrap();
        assert!(!dir.path().join("claude").exists());
        assert!(!dir.path().join("agy").exists());
        assert!(!dir.path().join("opencode2").exists(), "nor a vendor alias's");
        for name in ["claude.cmd", "agy.cmd", "opencode.cmd", "opencode2.cmd"] {
            assert!(dir.path().join(name).is_file(), "{name}");
        }
        let alias = fs::read_to_string(dir.path().join("opencode2.cmd")).unwrap();
        assert!(alias.contains("--agent-shim-env opencode\""), "the alias runs its CLI's shim");
    }

    /// 2442d: the `.cmd` shim asks the app for the scope's environment, sets
    /// it for one run only and starts the real CLI with the arguments as typed.
    #[test]
    fn the_cmd_shim_sets_the_scope_env_for_one_run_and_passes_the_arguments() {
        let exe = Path::new(r"C:\Program Files\App\app.exe");
        let script = cmd_shim_script("claude", exe);
        let (real, call, err) = crate::services::agent_shim::windows_answer_vars();
        assert!(script.starts_with("@echo off\r\n"));
        assert!(script.lines().all(|l| !l.is_empty()), "CRLF lines");
        assert!(script.contains(r#"(`""C:\Program Files\App\app.exe" --agent-shim-env claude"`)"#));
        assert!(script.contains(r#"do set "%%L""#));
        // Set for this run only, with `!` in values and arguments intact.
        let setlocal = script.find("setlocal DisableDelayedExpansion").unwrap();
        assert!(setlocal < script.find("for /f").unwrap());
        assert!(script.contains(&format!("%{call}% \"%{real}%\" %*\r\n")));
        assert!(script.find(":run").unwrap() > script.find("EnableDelayedExpansion").unwrap(), "the run line has delayed expansion off");
        assert!(script.contains(&format!("echo(!{err}! 1>&2")));
        assert!(script.contains("exit /b %errorlevel%"));
    }

    #[cfg(unix)]
    #[test]
    fn a_shim_execs_app_outside_a_fence_and_the_real_cli_inside_one() {
        let dir = tempfile::tempdir().unwrap();
        install_in(dir.path(), Some(Path::new(concat!("/opt/", crate::app_slug!(), "'s bin/", crate::app_slug!()))), &["claude", "cursor-agent"]).unwrap();
        let shim = fs::read_to_string(dir.path().join("cursor-agent")).unwrap();
        assert!(shim.starts_with("#!/bin/sh\n"));
        assert!(shim.contains(concat!("exec '/opt/", crate::app_slug!(), "'\\''s bin/", crate::app_slug!(), "' --agent-shim 'cursor-agent' \"$@\"")));
        assert!(shim.contains(crate::app_env!("AGENT_FENCE")));
        assert!(shim.contains(crate::app_env!("HOST_SESSION")));
        assert!(shim.contains(&format!("grep -vx -- '{}'", dir.path().to_string_lossy())));
        assert!(!shim.contains("--unfenced"));
        assert!(dir.path().join("claude").is_file());
    }

    /// `opencode2` is the same shim as `opencode`, so typing it reaches the
    /// same fence; it is the registry CLI that is fenced, never the alias.
    #[cfg(unix)]
    #[test]
    fn a_vendor_alias_gets_its_clis_shim() {
        let exe = Path::new("/opt/app/bin");
        let dir = tempfile::tempdir().unwrap();
        install_in(dir.path(), Some(exe), &["opencode"]).unwrap();
        let alias = fs::read_to_string(dir.path().join("opencode2")).unwrap();
        assert_eq!(alias, fs::read_to_string(dir.path().join("opencode")).unwrap());
        assert!(alias.contains("--agent-shim 'opencode' \"$@\""));
        let other = tempfile::tempdir().unwrap();
        install_in(other.path(), Some(exe), &["claude"]).unwrap();
        assert!(!other.path().join("opencode2").exists());
    }

    /// Inside a fence the shim runs the real CLI, which still sees this
    /// directory on PATH — `tabtivity-send` must stay reachable from the agent.
    #[cfg(unix)]
    #[test]
    fn a_fenced_shim_runs_the_real_cli_with_app_send_still_on_path() {
        use std::os::unix::fs::PermissionsExt;
        let shims = tempfile::tempdir().unwrap();
        let real = tempfile::tempdir().unwrap();
        install_in(shims.path(), Some(Path::new(concat!("/nonexistent/", crate::app_slug!()))), &["fakecli"]).unwrap();
        let cli = real.path().join("fakecli");
        fs::write(&cli, concat!("#!/bin/sh\necho \"args=$*\"\ncommand -v ", crate::app_slug!(), "-send\n")).unwrap();
        fs::set_permissions(&cli, fs::Permissions::from_mode(0o755)).unwrap();
        let path = std::env::join_paths([shims.path(), real.path(), Path::new("/usr/bin"), Path::new("/bin")]).unwrap();
        let out = std::process::Command::new(shims.path().join("fakecli"))
            .arg("hi")
            .env("PATH", &path)
            .env(crate::app_env!("AGENT_FENCE"), "1")
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(out.status.success(), "{stdout} {}", String::from_utf8_lossy(&out.stderr));
        assert!(stdout.contains("args=hi"), "the real CLI ran, not the shim again: {stdout}");
        assert!(
            stdout.contains(&shims.path().join(concat!(crate::app_slug!(), "-send")).to_string_lossy().into_owned()),
            "{SLUG}-send is on the CLI's PATH: {stdout}"
        );

        // No real CLI anywhere but the shim: a clear error, never a loop.
        let path = std::env::join_paths([shims.path(), Path::new("/usr/bin"), Path::new("/bin")]).unwrap();
        let out = std::process::Command::new(shims.path().join("fakecli"))
            .env("PATH", &path)
            .env(crate::app_env!("AGENT_FENCE"), "1")
            .output()
            .unwrap();
        assert_eq!(out.status.code(), Some(127));
        assert!(String::from_utf8_lossy(&out.stderr).contains("fakecli: command not found"));
    }

    /// Runs the mktemp shim with `args`, fenced or not, in front of `real`.
    #[cfg(unix)]
    fn run_mktemp_shim(real: &str, dir: &Path, fenced: bool, args: &[&str]) -> std::process::Output {
        let shim = dir.join("mktemp");
        write_script(dir, "mktemp", mktemp_shim_script_for(real).as_bytes()).unwrap();
        let mut cmd = std::process::Command::new(&shim);
        cmd.args(args).env("TMPDIR", dir.join("private")).env_remove(crate::app_env!("AGENT_FENCE"));
        if fenced {
            cmd.env(crate::app_env!("AGENT_FENCE"), "1");
        }
        cmd.output().unwrap()
    }

    /// macOS's mktemp ignores `$TMPDIR` without a template, so inside the
    /// fence the shim names one there; everything else reaches it untouched.
    #[cfg(unix)]
    #[test]
    fn the_fenced_mktemp_gets_a_template_in_tmpdir_and_passes_anything_else_through() {
        let dir = tempfile::tempdir().unwrap();
        let echo = dir.path().join("echo-args");
        write_script(dir.path(), "echo-args", b"#!/bin/sh\nfor a in \"$@\"; do printf '%s\\n' \"$a\"; done\n").unwrap();
        let echo = echo.to_string_lossy().into_owned();
        let private = dir.path().join("private").to_string_lossy().into_owned();
        let args_of = |fenced: bool, args: &[&str]| {
            let out = run_mktemp_shim(&echo, dir.path(), fenced, args);
            assert!(out.status.success(), "{out:?}");
            String::from_utf8(out.stdout).unwrap().lines().map(str::to_string).collect::<Vec<_>>()
        };
        let tmpl = |prefix: &str| format!("{private}/{prefix}.XXXXXXXXXX");
        assert_eq!(args_of(true, &[]), [tmpl("tmp")]);
        assert_eq!(args_of(true, &["-d"]), ["-d".to_string(), tmpl("tmp")]);
        assert_eq!(args_of(true, &["-dq"]), ["-dq".to_string(), tmpl("tmp")]);
        assert_eq!(args_of(true, &["-q", "-t", "build"]), ["-q".to_string(), tmpl("build")]);
        assert_eq!(args_of(true, &["-tcache"]), [tmpl("cache")]);
        // A template, -p, an unknown option, a dangling -t: untouched.
        for args in [&["x.XXXXXX"][..], &["-p", "/elsewhere"], &["--tmpdir"], &["-t"], &["-d", "a b.XXXXXX"]] {
            assert_eq!(args_of(true, args), args.iter().map(|a| a.to_string()).collect::<Vec<_>>(), "{args:?}");
        }
        // Not fenced: untouched.
        assert_eq!(args_of(false, &[]), Vec::<String>::new());
        assert_eq!(args_of(false, &["-d"]), ["-d"]);

        // And the template it names is one the real mktemp takes.
        assert_eq!(mktemp_shim_script(), mktemp_shim_script_for("/usr/bin/mktemp"));
        std::fs::create_dir_all(&private).unwrap();
        for args in [&[][..], &["-d"], &["-t", "probe"]] {
            let out = run_mktemp_shim("/usr/bin/mktemp", dir.path(), true, args);
            assert!(out.status.success(), "{args:?}: {out:?}");
            let made = String::from_utf8(out.stdout).unwrap();
            let made = Path::new(made.trim());
            assert_eq!(made.parent(), Some(Path::new(&private)), "{args:?}");
            assert!(made.exists());
        }
    }
}
