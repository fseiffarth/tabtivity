//! Small pieces of old-name tolerance that code outside the migrator needs:
//! the script preambles that read an old environment variable, and the
//! mapping of an old tool or command name to the current one. Each is empty
//! or the identity while the name is unchanged.

use crate::brand::{Name, Pair};

/// `sh` lines that give each of the app's variables in `names` the value of
/// its old-named twin when it is unset or empty. A process an older build
/// started (an agent in a tmux session that outlived the update) has only
/// the old names in its environment, and it runs the scripts this build
/// writes. Empty while the prefix is unchanged, so the scripts are then
/// byte-for-byte what they were.
pub fn legacy_env_preamble_sh(pair: &Pair, names: &[&str]) -> String {
    let mut out = String::new();
    for name in names {
        if let Some(old) = pair.legacy_env_name(name) {
            let new = pair.cur.env_name(name);
            out.push_str(&format!(": \"${{{new}:=${{{old}:-}}}}\"\n"));
        }
    }
    out
}

/// [`legacy_env_preamble_sh`] for the running app's scripts: only on an
/// install that was upgraded across the rename. One created after it never
/// ran a session under the old names, and gets no script that spells them.
pub fn script_preamble_sh(names: &[&str]) -> String {
    let pair = crate::brand::PAIR;
    if !super::upgraded_install(&pair, &crate::storage::state_dir()) {
        return String::new();
    }
    legacy_env_preamble_sh(&pair, names)
}

/// The PowerShell twin of [`script_preamble_sh`].
pub fn script_preamble_ps1(names: &[&str]) -> String {
    let pair = crate::brand::PAIR;
    if !super::upgraded_install(&pair, &crate::storage::state_dir()) {
        return String::new();
    }
    legacy_env_preamble_ps1(&pair, names)
}

/// The PowerShell twin of [`legacy_env_preamble_sh`], `\r\n`-terminated.
pub fn legacy_env_preamble_ps1(pair: &Pair, names: &[&str]) -> String {
    let mut out = String::new();
    for name in names {
        if let Some(old) = pair.legacy_env_name(name) {
            let new = pair.cur.env_name(name);
            out.push_str(&format!("if (-not $env:{new}) {{ $env:{new} = $env:{old} }}\r\n"));
        }
    }
    out
}

/// What follows the app's prefix in a tmux session name (`<slug>-<rest>`),
/// when `session` is one of the app's: under the current prefix, or under
/// the one an older build minted (counted as a legacy hit). Sessions on a
/// remote host outlive an update by weeks and end under their old names; new
/// ones are only ever minted under the current prefix.
pub fn tmux_session_rest<'a>(pair: &Pair, session: &'a str) -> Option<&'a str> {
    if let Some(rest) = session.strip_prefix(pair.cur(Name::TMUX_PREFIX).as_str()) {
        return Some(rest);
    }
    let rest = session.strip_prefix(pair.legacy(Name::TMUX_PREFIX)?.as_str())?;
    crate::brand::legacy_hit("tmux-prefix");
    Some(rest)
}

/// A shell fragment that removes the Ollama systemd drop-in an older build
/// wrote under the app's old name, to splice in before the `daemon-reload`
/// of the command that writes the current one: `sudo rm -f <old file> && `.
/// The drop-ins need root, so the old file can only go when the user next
/// runs that command — and it has to go then, or two drop-ins would set the
/// same variable. Empty while the name is unchanged.
pub fn ollama_dropin_cleanup(pair: &Pair, dropin: Name) -> String {
    match pair.legacy(dropin) {
        Some(old) => format!("sudo rm -f /etc/systemd/system/ollama.service.d/{old} && "),
        None => String::new(),
    }
}

/// The name of the manifest inside a project export, given which entries
/// the bundle `has`: the current name, or — for a bundle an older build wrote
/// — the old one (counted as a legacy hit). Old bundles sit in backups for
/// years, so this lookup is meant to stay.
pub fn export_manifest_name(pair: &Pair, has: impl Fn(&str) -> bool) -> String {
    let current = pair.cur(Name::EXPORT_MANIFEST);
    match pair.legacy(Name::EXPORT_MANIFEST) {
        Some(old) if !has(&current) && has(&old) => {
            crate::brand::legacy_hit("export-manifest");
            old
        }
        _ => current,
    }
}

/// The file the old-named send command leaves in a project's outbox to say
/// it was used. An agent's fence cannot write the state dir, so the count is
/// taken by whoever next lists that outbox ([`take_send_alias_marker`]).
pub const SEND_ALIAS_MARKER: &str = ".old-name-used";

/// The old name of the send command as a POSIX script that runs the current
/// one: agents' instructions and users' habits name the old command for a
/// while after a rename. `None` while the name is unchanged — no second
/// command is installed then.
pub fn send_alias_script(pair: &Pair) -> Option<String> {
    let old = pair.legacy(Name::SEND_CLI)?;
    let new = pair.cur(Name::SEND_CLI);
    let outbox = pair.cur(Name::OUTBOX_DIR);
    let project_dir = pair.cur.env_name("PROJECT_DIR");
    let old_project_dir = pair.legacy_env_name("PROJECT_DIR").unwrap_or_else(|| project_dir.clone());
    // A session an older build started has the project and the tab under
    // the old variables only, and the current command reads the current ones.
    let preamble = legacy_env_preamble_sh(pair, &["PROJECT_DIR", "TAB_UID"]);
    let tab_uid = pair.cur.env_name("TAB_UID");
    Some(format!(
        "#!/bin/sh\n\
         # {display}: `{old}` is the old name of `{new}`, kept for one release.\n\
         # It leaves a note in the project's outbox so the use is counted, then\n\
         # runs the current command. Managed by {display}; do not edit.\n\
         {preamble}export {project_dir} {tab_uid}\n\
         root=${{{project_dir}:-${{{old_project_dir}:-}}}}\n\
         if [ -n \"$root\" ] && [ -d \"$root/{outbox}\" ] && [ ! -L \"$root/{outbox}\" ]; then\n\
         \x20 : > \"$root/{outbox}/{marker}\" 2>/dev/null || true\n\
         fi\n\
         exec \"$(dirname \"$0\")/{new}\" \"$@\"\n",
        display = pair.cur.display,
        marker = SEND_ALIAS_MARKER,
    ))
}

/// The same alias for `cmd.exe`, beside the current `.cmd` shim.
pub fn send_alias_cmd(pair: &Pair) -> Option<String> {
    pair.legacy(Name::SEND_CLI)?;
    let new = pair.cur(Name::SEND_CLI);
    Some(format!("@echo off\r\n\"%~dp0{new}.cmd\" %*\r\nexit /b %errorlevel%\r\n"))
}

/// Count and remove the note the old-named send command left in `outbox`.
/// Called where an outbox is listed; a no-op while the name is unchanged.
pub fn take_send_alias_marker(pair: &Pair, outbox: &std::path::Path) {
    take_send_alias_marker_with(pair, |name| {
        let marker = outbox.join(name);
        // A plain file only: the outbox is the agent's to fill.
        std::fs::symlink_metadata(&marker).is_ok_and(|meta| meta.is_file()) && std::fs::remove_file(&marker).is_ok()
    });
}

/// [`take_send_alias_marker`] for an outbox reached some other way:
/// `remove` deletes the leaf it is given if it is a plain file there and says
/// whether it did (the phone's outbox listing does so through its held
/// folder, `mobile_control::outbox`).
pub fn take_send_alias_marker_with(pair: &Pair, remove: impl FnOnce(&str) -> bool) {
    if pair.legacy(Name::SEND_CLI).is_some() && remove(SEND_ALIAS_MARKER) {
        crate::brand::legacy_hit("send-cli");
    }
}

/// The help MCP tools, whose names carry the app's name.
const HELP_TOOLS: [Name; 4] = [
    Name::HELP_TOOL_SEARCH,
    Name::HELP_TOOL_READ,
    Name::HELP_TOOL_TOPICS,
    Name::HELP_TOOL_STATUS,
];

/// The current name of an MCP tool a client called by the name an older
/// build listed (counted as a legacy hit), or `tool` itself. An agent
/// session that outlived the update still holds the old tool list.
pub fn current_tool_name<'a>(pair: &Pair, tool: &'a str) -> std::borrow::Cow<'a, str> {
    for name in HELP_TOOLS {
        if pair.legacy(name).as_deref() == Some(tool) {
            crate::brand::legacy_hit("mcp-tool");
            return pair.cur(name).into();
        }
    }
    tool.into()
}

/// The current command of a saved built-in tab (`__<slug>_mail__`) or the
/// app's time-log id, when `command` is the one an older build saved (counted
/// as a legacy hit); otherwise `command` itself.
pub fn current_tab_command<'a>(pair: &Pair, command: &'a str) -> std::borrow::Cow<'a, str> {
    if let Some(old_id) = pair.legacy(Name::APP_TIMER_ID) {
        if command == old_id {
            crate::brand::legacy_hit("timer-id");
            return pair.cur(Name::APP_TIMER_ID).into();
        }
    }
    let Some(old_prefix) = pair.legacy(Name::TAB_COMMAND_PREFIX) else {
        return command.into();
    };
    match command.strip_prefix(&old_prefix) {
        Some(view) if view.ends_with("__") => {
            crate::brand::legacy_hit("tab-command");
            format!("{}{view}", pair.cur(Name::TAB_COMMAND_PREFIX)).into()
        }
        _ => command.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::super::hits;
    use super::super::testing::{RENAMED, UNCHANGED};
    use super::*;
    use crate::brand::LEGACY;

    #[test]
    fn the_preambles_are_empty_while_the_name_is_unchanged() {
        assert_eq!(legacy_env_preamble_sh(&UNCHANGED, &["TAB_UID", "PROJECT_DIR"]), "");
        assert_eq!(legacy_env_preamble_ps1(&UNCHANGED, &["TAB_UID"]), "");
    }

    #[test]
    fn the_powershell_preamble_reads_the_old_name() {
        assert_eq!(
            legacy_env_preamble_ps1(&RENAMED, &["TAB_UID"]),
            format!(
                "if (-not $env:NEWNAME_TAB_UID) {{ $env:NEWNAME_TAB_UID = $env:{} }}\r\n",
                LEGACY.env_name("TAB_UID")
            )
        );
    }

    /// Run the preamble in a real shell: the old value is taken when the
    /// current name is unset, and a current value wins.
    #[cfg(unix)]
    #[test]
    fn the_sh_preamble_gives_a_script_the_old_value() {
        let script = format!(
            "{}printf '%s|%s' \"$NEWNAME_TAB_UID\" \"$NEWNAME_PROJECT_DIR\"",
            legacy_env_preamble_sh(&RENAMED, &["TAB_UID", "PROJECT_DIR"])
        );
        let run = |env: &[(&str, &str)]| {
            let out = std::process::Command::new("sh")
                .args(["-c", &script])
                .env_clear()
                .envs(env.iter().copied())
                .output()
                .expect("sh runs");
            String::from_utf8_lossy(&out.stdout).into_owned()
        };
        let old_uid = LEGACY.env_name("TAB_UID");
        let old_dir = LEGACY.env_name("PROJECT_DIR");
        assert_eq!(run(&[(&old_uid, "u-old"), (&old_dir, "/p")]), "u-old|/p");
        assert_eq!(run(&[(&old_uid, "u-old"), ("NEWNAME_TAB_UID", "u-new")]), "u-new|");
        assert_eq!(run(&[]), "|");
    }

    #[test]
    fn the_old_ollama_dropin_is_removed_by_the_command_that_writes_the_new_one() {
        assert_eq!(
            ollama_dropin_cleanup(&RENAMED, Name::OLLAMA_MODELS_DROPIN),
            format!(
                "sudo rm -f /etc/systemd/system/ollama.service.d/{} && ",
                LEGACY.name(Name::OLLAMA_MODELS_DROPIN)
            )
        );
        assert_eq!(ollama_dropin_cleanup(&UNCHANGED, Name::OLLAMA_IGPU_DROPIN), "");
    }

    #[test]
    fn an_export_written_by_an_older_build_is_still_recognised() {
        let _ = hits::taken();
        let old = LEGACY.name(Name::EXPORT_MANIFEST);
        assert_eq!(export_manifest_name(&RENAMED, |name| name == old), old);
        assert_eq!(hits::taken(), ["export-manifest"]);
        assert_eq!(export_manifest_name(&RENAMED, |name| name == "newname-export.json"), "newname-export.json");
        assert_eq!(export_manifest_name(&RENAMED, |_| true), "newname-export.json");
        // Neither inside: the current name, so the error names what is expected.
        assert_eq!(export_manifest_name(&RENAMED, |_| false), "newname-export.json");
        assert_eq!(export_manifest_name(&UNCHANGED, |_| false), crate::brand::EXPORT_MANIFEST);
        assert!(hits::taken().is_empty());
    }

    /// The alias in a real shell: the current command gets the arguments, and
    /// the outbox gets the note that the next listing counts and removes.
    #[cfg(unix)]
    #[test]
    fn the_old_send_command_runs_the_current_one_and_is_counted() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().expect("tempdir");
        let bin = dir.path().join("bin");
        let project = dir.path().join("project");
        let outbox = project.join(RENAMED.cur(Name::OUTBOX_DIR));
        std::fs::create_dir_all(&bin).expect("mkdir");
        std::fs::create_dir_all(&outbox).expect("mkdir");
        let install = |name: &str, body: &str| {
            let path = bin.join(name);
            std::fs::write(&path, body).expect("write");
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
            path
        };
        install("newname-send", "#!/bin/sh\nprintf 'sent:%s' \"$*\"\n");
        let alias = install(
            &LEGACY.name(Name::SEND_CLI),
            &send_alias_script(&RENAMED).expect("an alias once renamed"),
        );
        let out = std::process::Command::new(&alias)
            .args(["a.pdf", "b c.png"])
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("NEWNAME_PROJECT_DIR", &project)
            .output()
            .expect("the alias runs");
        assert_eq!(String::from_utf8_lossy(&out.stdout), "sent:a.pdf b c.png");
        assert!(outbox.join(SEND_ALIAS_MARKER).is_file());

        let _ = hits::taken();
        take_send_alias_marker(&RENAMED, &outbox);
        assert_eq!(hits::taken(), ["send-cli"]);
        assert!(!outbox.join(SEND_ALIAS_MARKER).exists());
        take_send_alias_marker(&RENAMED, &outbox);
        assert!(hits::taken().is_empty());

        // A session an older build started has the project dir under the old
        // variable only; outside a project nothing is noted and it still runs.
        let run = |env: &[(&str, &std::path::Path)]| {
            let out = std::process::Command::new(&alias)
                .arg("x")
                .env_clear()
                .env("PATH", "/usr/bin:/bin")
                .envs(env.iter().map(|(k, v)| (k.to_string(), v.to_path_buf())))
                .output()
                .expect("the alias runs");
            String::from_utf8_lossy(&out.stdout).into_owned()
        };
        assert_eq!(run(&[(&LEGACY.env_name("PROJECT_DIR"), &project)]), "sent:x");
        // …and the current command is handed both under their current names.
        install("newname-send", "#!/bin/sh\nprintf '%s|%s' \"$NEWNAME_PROJECT_DIR\" \"$NEWNAME_TAB_UID\"\n");
        assert_eq!(
            run(&[(&LEGACY.env_name("PROJECT_DIR"), &project), (&LEGACY.env_name("TAB_UID"), std::path::Path::new("tab-1"))]),
            format!("{}|tab-1", project.display())
        );
        install("newname-send", "#!/bin/sh\nprintf 'sent:%s' \"$*\"\n");
        assert!(outbox.join(SEND_ALIAS_MARKER).is_file());
        std::fs::remove_file(outbox.join(SEND_ALIAS_MARKER)).expect("remove");
        assert_eq!(run(&[]), "sent:x");
        assert!(!outbox.join(SEND_ALIAS_MARKER).exists());
    }

    #[test]
    fn no_send_alias_while_the_name_is_unchanged() {
        assert_eq!(send_alias_script(&UNCHANGED), None);
        assert_eq!(send_alias_cmd(&UNCHANGED), None);
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join(SEND_ALIAS_MARKER), "").expect("write");
        let _ = hits::taken();
        take_send_alias_marker(&UNCHANGED, dir.path());
        assert!(dir.path().join(SEND_ALIAS_MARKER).is_file());
        assert!(hits::taken().is_empty());
    }

    #[test]
    fn a_tmux_session_is_the_apps_under_either_prefix() {
        let _ = hits::taken();
        let old = format!("{}p1--agent-0123456789", LEGACY.name(Name::TMUX_PREFIX));
        assert_eq!(tmux_session_rest(&RENAMED, &old), Some("p1--agent-0123456789"));
        assert_eq!(hits::taken(), ["tmux-prefix"]);
        assert_eq!(tmux_session_rest(&RENAMED, "newname-p1--shell-1"), Some("p1--shell-1"));
        assert_eq!(tmux_session_rest(&RENAMED, "train"), None);
        assert_eq!(
            tmux_session_rest(&UNCHANGED, &format!("{}p1--x", crate::brand::TMUX_PREFIX)),
            Some("p1--x")
        );
        assert!(hits::taken().is_empty());
    }

    #[test]
    fn an_old_help_tool_name_maps_to_the_current_one_and_is_counted() {
        let _ = hits::taken();
        let old = LEGACY.name(Name::HELP_TOOL_SEARCH);
        assert_eq!(current_tool_name(&RENAMED, &old), "newname_help_search");
        assert_eq!(hits::taken(), ["mcp-tool"]);
        assert_eq!(current_tool_name(&RENAMED, "newname_help_read"), "newname_help_read");
        assert_eq!(current_tool_name(&RENAMED, "mail_search"), "mail_search");
        assert_eq!(current_tool_name(&UNCHANGED, crate::brand::HELP_TOOL_READ), crate::brand::HELP_TOOL_READ);
        assert!(hits::taken().is_empty());
    }

    #[test]
    fn an_old_tab_command_maps_to_the_current_one_and_is_counted() {
        let _ = hits::taken();
        let old_mail = format!("{}mail__", LEGACY.name(Name::TAB_COMMAND_PREFIX));
        assert_eq!(current_tab_command(&RENAMED, &old_mail), "__newname_mail__");
        assert_eq!(current_tab_command(&RENAMED, &LEGACY.name(Name::APP_TIMER_ID)), "__newname__");
        assert_eq!(hits::taken(), ["tab-command", "timer-id"]);
        // A user's own command that merely starts alike, and current ones.
        let lookalike = format!("{}tool --flag", LEGACY.name(Name::TAB_COMMAND_PREFIX));
        assert_eq!(current_tab_command(&RENAMED, &lookalike), lookalike);
        assert_eq!(current_tab_command(&RENAMED, "bash"), "bash");
        assert_eq!(current_tab_command(&RENAMED, "__newname_mail__"), "__newname_mail__");
        assert_eq!(current_tab_command(&UNCHANGED, crate::app_tab_command!("mail")), crate::app_tab_command!("mail"));
        assert!(hits::taken().is_empty());
    }
}
