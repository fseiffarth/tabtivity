//! `tabtivity --agent-exec <program> [args…]`: an agent's secrets under the
//! names its CLI reads, given at the last step before it runs
//! (`docs/api_chat_plan.md`, Part C, C1).
//!
//! A local agent tab with a `tmux_session` runs on the user's **default** tmux
//! server, and a secret reaches that session only through the fixed global
//! `update-environment` slots (`tmux_local::SECRET_ENV`, #864). Those slots
//! stay set on the server for its life, so every name listed there is taken
//! from the client — or dropped — for every later session the user opens on it,
//! their own terminals included. Common names (`ANTHROPIC_AUTH_TOKEN`) cannot go
//! there. So a spawn carries such a secret under an app-named *carrier*
//! (`<PREFIX><NAME>`, [`CARRIER_PREFIX`]) — the only names `SECRET_ENV`
//! gains — and this step, run by Tabtivity's own binary, sets `<NAME>` from it
//! and removes every carrier before it `exec`s the program.
//!
//! Where it runs: the fence's first step (with `--fence-scope`, which maps the
//! same way, when the kernel takes the Landlock scope), in front of bwrap or
//! `sandbox-exec`; in front of the CLI itself for an unfenced Host session.
//! Not *inside* bwrap: the binary need not be reachable there (the home is the
//! scope home, `/tmp` a tmpfs that hides an AppImage's mount, `/proc` a fresh
//! one without Tabtivity's `/proc/<pid>/exe`), and nothing is gained — bwrap and
//! sandbox-exec pass the environment through unchanged. The value is only ever
//! in an environment (0400 `/proc/<pid>/environ`), never an argv
//! (`/proc/<pid>/cmdline` is world-readable) or a file.
//!
//! Windows has no tmux and no fence: a key goes into the ConPTY child's
//! environment block under its own name, no carrier (`agent_api_keys`).

use std::collections::HashMap;
use std::ffi::{OsStr, OsString};

/// Every carrier starts with this; the rest is the variable it becomes.
pub const CARRIER_PREFIX: &str = crate::app_env!("AGENT_SECRET_");

/// The command-line flag of this mode.
pub const MODE_FLAG: &str = "--agent-exec";

/// The carrier of variable `name`.
pub fn carrier_name(name: &str) -> String {
    format!("{CARRIER_PREFIX}{name}")
}

/// Whether `env` carries anything for this step to map.
pub fn has_carriers(env: &HashMap<String, String>) -> bool {
    env.keys().any(|k| k.starts_with(CARRIER_PREFIX))
}

/// What the step does to an environment: carriers to remove, variables to set.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Mapping {
    pub remove: Vec<OsString>,
    pub set: Vec<(OsString, OsString)>,
}

/// The variables a carrier may set: the CLIs' credential variables that carry
/// an API proxy token (`agent_api_keys::ENV_VARS`), nothing else. The step runs *outside* the
/// fence, in front of bwrap or `sandbox-exec` (and of an unfenced Host
/// session's CLI), so a carrier able to name any variable would be an
/// environment-injection lever there: `LD_PRELOAD`, `PATH`, `BASH_ENV` or
/// `NODE_OPTIONS` reach the unfenced launcher itself. A fixed list costs
/// nothing: the step is always the running binary (`fence_scope::
/// running_binary`, `/proc/<pid>/exe` once replaced), the same build that
/// injected the carrier. A name a later build adds is added here with it.
pub fn targets() -> &'static [&'static str] {
    crate::services::agent_api_keys::ENV_VARS
}

/// Whether `key` is a carrier, by bytes: a name that is not UTF-8 still
/// starts with the prefix and is still removed.
fn is_carrier(key: &OsStr) -> bool {
    key.as_encoded_bytes().starts_with(CARRIER_PREFIX.as_bytes())
}

/// The mapping of an environment. Pure. Every carrier is removed; a carrier
/// of one of [`targets`] with a non-empty value sets its variable, over a
/// value already there — the spawn decided at injection that the user had
/// not set one (`agent_api_keys`), and a value here can only be the tmux
/// server's own global copy, which is not the user's choice for this tab.
pub fn mapping<'a>(vars: impl IntoIterator<Item = (&'a OsStr, &'a OsStr)>) -> Mapping {
    let mut out = Mapping::default();
    for (key, value) in vars {
        if !is_carrier(key) {
            continue;
        }
        out.remove.push(key.to_owned());
        let target = key.to_str().and_then(|k| k.strip_prefix(CARRIER_PREFIX));
        if let Some(name) = target.filter(|n| targets().contains(n)) {
            if !value.is_empty() {
                out.set.push((OsString::from(name), value.to_owned()));
            }
        }
    }
    out
}

/// Apply this process's [`mapping`] to `cmd`, which inherits the rest of the
/// environment as it is.
#[cfg(unix)]
pub fn apply(cmd: &mut std::process::Command) {
    let vars: Vec<(OsString, OsString)> = std::env::vars_os().collect();
    apply_from(cmd, &vars);
}

/// [`apply`] over `vars` instead of this process's environment.
#[cfg(unix)]
fn apply_from(cmd: &mut std::process::Command, vars: &[(OsString, OsString)]) {
    let m = mapping(vars.iter().map(|(k, v)| (k.as_os_str(), v.as_os_str())));
    for key in &m.remove {
        cmd.env_remove(key);
    }
    for (key, value) in &m.set {
        cmd.env(key, value);
    }
}

/// Remove every carrier from this process's own environment. `main` calls it
/// first in every mode but the two steps that read them (`--agent-exec`,
/// `--fence-scope`): a Tabtivity (or an `--agent-shim`) started from a shell
/// that still holds one must not hand it to every child it spawns — those
/// inherit the process environment, and only a spawn whose `opts.env` holds
/// a carrier gets the step that removes it. Single-threaded at that point.
pub fn forget_inherited_carriers() {
    let carriers: Vec<OsString> = std::env::vars_os()
        .map(|(k, _)| k)
        .filter(|k| is_carrier(k))
        .collect();
    for key in carriers {
        std::env::remove_var(key);
    }
}

/// `tabtivity --agent-exec <program> [args…]`: map, then exec `program`.
/// Returns only on failure, with the exit code. Prints no value.
#[cfg(unix)]
pub fn run(args: &[OsString]) -> i32 {
    use std::os::unix::process::CommandExt;
    let Some((prog, rest)) = args.split_first() else {
        eprintln!(concat!("Agent launch: usage: ", crate::app_slug!(), " --agent-exec <program> [args…]"));
        return 2;
    };
    let mut cmd = std::process::Command::new(prog);
    cmd.args(rest);
    apply(&mut cmd);
    let e = cmd.exec();
    eprintln!("Agent launch: {}: {e}", std::path::Path::new(prog).display());
    127
}

/// The binary that runs this step: the running one (by `/proc/<pid>/exe` on
/// Linux once a rebuild has replaced it, see `fence_scope`).
#[cfg(unix)]
pub fn helper() -> Result<String, String> {
    #[cfg(target_os = "linux")]
    {
        Ok(crate::services::fence_scope::running_binary())
    }
    #[cfg(not(target_os = "linux"))]
    {
        std::env::current_exe()
            .map(|p| p.to_string_lossy().into_owned())
            .map_err(|e| format!(concat!("Agent launch: cannot find the ", crate::app_name!(), " binary: {}"), e))
    }
}

/// Put this step in front of `opts`' command when its environment carries
/// something: `cmd args…` becomes `<binary> --agent-exec cmd args…`. A bare
/// command the spawn would have found off `PATH` is resolved first, as
/// `terminal::build_command` would have; on `PATH` it stays bare, so the
/// step's `exec` finds it through the same `PATH`.
#[cfg(unix)]
pub fn wrap(opts: &mut crate::terminal::PtyOptions) -> Result<(), String> {
    if !has_carriers(&opts.env) {
        return Ok(());
    }
    let helper = helper()?;
    let prog = crate::paths::resolve_offpath_binary(&opts.cmd)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| opts.cmd.clone());
    let mut args = vec![MODE_FLAG.to_string(), prog];
    args.append(&mut opts.args);
    opts.cmd = helper;
    opts.args = args;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(pairs: &[(&str, &str)]) -> Mapping {
        let owned: Vec<(OsString, OsString)> =
            pairs.iter().map(|(k, v)| (OsString::from(k), OsString::from(v))).collect();
        mapping(owned.iter().map(|(k, v)| (k.as_os_str(), v.as_os_str())))
    }

    #[test]
    fn a_carrier_becomes_its_variable_and_is_removed() {
        let carrier = carrier_name("ANTHROPIC_AUTH_TOKEN");
        let m = map(&[(&carrier, "sk-test-fake"), ("PATH", "/bin"), ("ANTHROPIC_MODEL", "opus")]);
        assert_eq!(m.remove, vec![OsString::from(&carrier)]);
        assert_eq!(m.set, vec![(OsString::from("ANTHROPIC_AUTH_TOKEN"), OsString::from("sk-test-fake"))]);
    }

    #[test]
    fn empty_odd_or_unlisted_carriers_are_removed_and_set_nothing() {
        let empty = carrier_name("GEMINI_API_KEY");
        let bad = [
            carrier_name(""),
            carrier_name("1ABC"),
            carrier_name("A B"),
            carrier_name("A=B"),
            carrier_name(&format!("{}AGENT_FENCE", crate::brand::ENV_PREFIX)),
            carrier_name(&carrier_name("X")),
            // The step runs outside the fence: a carrier must not be able to
            // name a variable that steers the launcher, the loader or a shell.
            carrier_name("LD_PRELOAD"),
            carrier_name("LD_LIBRARY_PATH"),
            carrier_name("PATH"),
            carrier_name("BASH_ENV"),
            carrier_name("ENV"),
            carrier_name("NODE_OPTIONS"),
            carrier_name("HOME"),
            carrier_name("ANTHROPIC_BASE_URL"),
            // The raw key's name: since the proxy (C2) no carrier sets it.
            carrier_name("ANTHROPIC_API_KEY"),
            carrier_name("anthropic_api_key"),
        ];
        let mut pairs: Vec<(&str, &str)> = vec![(empty.as_str(), "")];
        pairs.extend(bad.iter().map(|k| (k.as_str(), "fake")));
        let m = map(&pairs);
        assert_eq!(m.remove.len(), pairs.len());
        assert!(m.set.is_empty(), "{:?}", m.set);
        // Every key variable a spawn can carry is a target.
        for var in crate::services::agent_api_keys::ENV_VARS {
            let carrier = carrier_name(var);
            assert_eq!(map(&[(&carrier, "fake")]).set, vec![(OsString::from(*var), OsString::from("fake"))]);
        }
    }

    /// A carrier name that is not UTF-8 is still a carrier, and still removed.
    #[cfg(unix)]
    #[test]
    fn a_non_utf8_carrier_is_removed_too() {
        use std::os::unix::ffi::OsStringExt;
        let mut name = CARRIER_PREFIX.as_bytes().to_vec();
        name.extend_from_slice(b"ANTHROPIC_AUTH_TOKEN\xff");
        let key = OsString::from_vec(name);
        let value = OsString::from("fake");
        let m = mapping([(key.as_os_str(), value.as_os_str())]);
        assert_eq!(m.remove, vec![key]);
        assert!(m.set.is_empty());
    }

    #[test]
    fn nothing_to_map_maps_nothing() {
        assert_eq!(map(&[("PATH", "/bin"), (crate::app_env!("TAB_UID"), "u")]), Mapping::default());
        let env = HashMap::from([("PATH".to_string(), "/bin".to_string())]);
        assert!(!has_carriers(&env));
        let env = HashMap::from([(carrier_name("GEMINI_API_KEY"), "fake".to_string())]);
        assert!(has_carriers(&env));
    }

    /// The legacy-name twins (`brand::Pair::export_both`) skip any name with
    /// `SECRET` in it; a carrier twinned under the old prefix would not be in
    /// `SECRET_ENV` and would ride the tmux argv.
    #[test]
    fn carriers_get_no_legacy_twin() {
        let mut env = HashMap::from([(carrier_name("ANTHROPIC_AUTH_TOKEN"), "sk-test-fake".to_string())]);
        crate::brand::PAIR.export_both(&mut env);
        assert_eq!(env.len(), 1, "{:?}", env.keys());
    }

    /// The step's own code path (`apply`, over a given environment) really
    /// reaches an exec'd program: the variable is set, no carrier is left, an
    /// unlisted carrier sets nothing, and the rest is inherited untouched.
    #[cfg(unix)]
    #[test]
    fn an_execd_program_sees_the_variable_and_no_carrier() {
        let carrier = carrier_name("ANTHROPIC_AUTH_TOKEN");
        let evil = carrier_name("BASH_ENV");
        let vars: Vec<(OsString, OsString)> = [
            (carrier.as_str(), "sk-test-fake"),
            (evil.as_str(), "/tmp/not-a-real-file"),
            ("KEEP", "kept"),
        ]
        .iter()
        .map(|(k, v)| (OsString::from(k), OsString::from(v)))
        .collect();
        let mut cmd = std::process::Command::new("sh");
        cmd.args([
            "-c",
            &format!(
                "printf '%s|%s|%s|%s|%s' \"${{ANTHROPIC_AUTH_TOKEN-unset}}\" \"${{{carrier}-gone}}\" \
                 \"${{{evil}-gone}}\" \"${{BASH_ENV-unset}}\" \"$KEEP\""
            ),
        ]);
        cmd.env_remove("ANTHROPIC_AUTH_TOKEN").env_remove("BASH_ENV");
        for (k, v) in &vars {
            cmd.env(k, v);
        }
        apply_from(&mut cmd, &vars);
        let out = cmd.output().unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout), "sk-test-fake|gone|gone|unset|kept");
    }

    #[cfg(unix)]
    #[test]
    fn wrap_puts_the_step_in_front_only_when_something_is_carried() {
        let mut opts: crate::terminal::PtyOptions = serde_json::from_value(serde_json::json!({
            "id": "t", "cmd": "/usr/bin/sandbox-exec", "args": ["-f", "/p.sb", "/bin/claude"],
            "cwd": "/", "cols": 80, "rows": 24
        }))
        .unwrap();
        wrap(&mut opts).unwrap();
        assert_eq!(opts.cmd, "/usr/bin/sandbox-exec");
        opts.env.insert(carrier_name("ANTHROPIC_AUTH_TOKEN"), "sk-test-fake".into());
        wrap(&mut opts).unwrap();
        assert_eq!(opts.cmd, helper().unwrap());
        assert_eq!(opts.args, vec![MODE_FLAG, "/usr/bin/sandbox-exec", "-f", "/p.sb", "/bin/claude"]);
        assert!(!opts.args.iter().any(|a| a.contains("sk-test")));
    }
}
