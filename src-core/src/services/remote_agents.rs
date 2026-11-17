//! Detect-and-bootstrap recipes for remote agent CLIs.
//!
//! A remote agent (#28b) runs *on* the remote host, so its CLI must exist there.
//! Rather than a separate install step, we fold a tiny POSIX-sh prelude into the
//! remote command (`ssh_exec::remote_command`): inside the remote login shell,
//! `command -v <bin>` is probed and, if missing, a **userspace** (no sudo)
//! installer runs before the agent is exec'd. Progress and any first-run
//! `login` happen live in the PTY; an install failure prints an actionable
//! manual hint and aborts (`exit 127`) before exec.
//!
//! Recipes are matched by the spawn's command base name. Unknown commands get no
//! prelude — we never try to install something we don't recognise.
//!
//! # Why this table exists next to `commands::agents::AGENTS`
//!
//! It is the same question asked in a place that may not reach the answer: this
//! is a `services/` module (`AppHandle`-free, no command layer beneath it), and
//! the string it needs is a *fragment of a remote shell script*, not the
//! platform-dispatched, event-emitting local installer `commands::agents` runs.
//! So the fact is restated here rather than imported upward.
//!
//! Two tables that mean the same thing drift, and this pair already had: this
//! one installed Claude with `npm install -g @anthropic-ai/claude-code` while
//! the shipped registry had moved to the official `install.sh`, so a remote
//! bootstrap and a local one put *different* binaries on two machines the user
//! thinks are running the same agent. The guard against a repeat is a tripwire
//! test in `commands::agents` that fails whenever a row here names a `bin` the
//! registry doesn't have, or an `install` its Unix row disagrees with.
//!
//! **Every recipe must be installable without `sudo`**, which is what decides
//! membership rather than "is it a known agent": a remote is typically a shared
//! login node where the user has a home directory and nothing else. An agent
//! whose only installer needs root belongs in no row at all — an unknown command
//! runs with no prelude and simply reports `command not found`, which is honest,
//! where a prelude would print a password prompt into an agent's PTY.

use crate::brand::SLUG;
/// A known agent CLI and how to detect / install it on a remote host.
pub struct AgentRecipe {
    /// Executable probed with `command -v` and finally exec'd.
    pub bin: &'static str,
    /// POSIX-sh install command, userspace (no sudo), run when `bin` is absent.
    pub install: &'static str,
    /// Hint shown if auto-install fails, so the user can fix it by hand.
    pub manual_hint: &'static str,
}

/// The recipe table. Each `bin`/`install` pair mirrors the same agent's Unix row
/// in `commands::agents::AGENTS` — see the module header for why it is restated
/// and what stops the two from drifting.
///
/// The `npm -g` rows are the ones with a real failure mode worth the hint: a
/// host whose Node came from the system package manager has a root-owned global
/// prefix, so the install fails on permissions with the user's home untouched.
/// nvm/fnm/Volta hosts (the common case on a cluster, and what the login-shell
/// wrap in `ssh_exec::remote_command` exists to pick up) install fine.
static RECIPES: &[AgentRecipe] = &[
    AgentRecipe {
        bin: "claude",
        install: "curl -fsSL https://claude.ai/install.sh | bash",
        manual_hint: "curl -fsSL https://claude.ai/install.sh | bash \
                      (see https://docs.anthropic.com/en/docs/claude-code/setup)",
    },
    AgentRecipe {
        bin: "codex",
        install: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
        manual_hint: "curl -fsSL https://chatgpt.com/codex/install.sh | sh \
                      (see https://github.com/openai/codex)",
    },
    AgentRecipe {
        bin: "agy",
        install: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
        manual_hint: "curl -fsSL https://antigravity.google/cli/install.sh | bash \
                      (see https://antigravity.google/docs/cli/install/)",
    },
    AgentRecipe {
        bin: "gemini",
        install: "npm install -g @google/gemini-cli",
        manual_hint: "npm install -g @google/gemini-cli (needs a writable npm \
                      prefix - with a system-packaged Node, install nvm first; \
                      see https://github.com/google-gemini/gemini-cli)",
    },
    AgentRecipe {
        bin: "vibe",
        install: "curl -LsSf https://mistral.ai/vibe/install.sh | bash",
        manual_hint: "curl -LsSf https://mistral.ai/vibe/install.sh | bash (see \
                      https://docs.mistral.ai/getting-started/quickstarts/vibe-code/install-cli)",
    },
    AgentRecipe {
        bin: "opencode",
        install: "curl -fsSL https://opencode.ai/v2/install | bash",
        manual_hint: "curl -fsSL https://opencode.ai/v2/install | bash \
                      (see https://opencode.ai/v2/docs/)",
    },
];

/// Look up the recipe for a spawn command, matching on its base name so an
/// absolute path (`/usr/bin/claude`) still resolves. `None` for unknown
/// commands.
pub fn recipe_for(cmd: &str) -> Option<&'static AgentRecipe> {
    let base = cmd.rsplit('/').next().unwrap_or(cmd);
    RECIPES.iter().find(|r| r.bin == base)
}

/// Every recipe, for the tripwire in `commands::agents` that keeps this table and
/// the install registry from disagreeing about one agent.
pub fn recipes() -> &'static [AgentRecipe] {
    RECIPES
}

/// Build the POSIX-sh prelude that guarantees `recipe.bin` is present —
/// installing it userspace if needed — before the caller exec's it, run inside
/// the remote login shell. Probes once, installs if missing, then probes again
/// and aborts with `exit 127` + a manual hint if it is still absent. Returned as
/// a single `;`-joined line so it can be embedded in `$SHELL -lc '<…>'`.
///
/// `hash -r` between the two probes is what makes the second one *mean*
/// something: an installer that drops a binary into a directory already on
/// `PATH` is invisible to a shell that cached the lookup for that name, so
/// without it a successful install could still be reported as a failure.
pub fn bootstrap_prelude(recipe: &AgentRecipe) -> String {
    let AgentRecipe {
        bin,
        install,
        manual_hint,
    } = recipe;
    format!(
        "command -v {bin} >/dev/null 2>&1 || \
         {{ echo '{SLUG}: {bin} not found on remote, installing...'; {install}; \
         hash -r 2>/dev/null || true; }}; \
         command -v {bin} >/dev/null 2>&1 || \
         {{ echo '{SLUG}: {bin} not found and auto-install failed - install it manually: \
         {manual_hint}' >&2; exit 127; }}"
    )
}

/// Launcher dirs (relative to a home) a remote recipe's installer may drop its
/// binary into, put first on `PATH` once an agent folder stands in for the home.
/// A subset of `agent_install::bin_dirs_for`'s Unix list (the rows of agents that
/// have a recipe above); a test there keeps the two from drifting.
pub const LAUNCHER_DIRS: &[&str] = &[".local/bin", "npm/bin", ".bun/bin", ".cargo/bin", ".opencode/bin"];

/// Name of the folder inside a host's agent folder that stands in for `$HOME`.
fn home_leaf() -> String {
    format!("{SLUG}-agent-home")
}

/// Check and normalise the agent folder a user typed for a host: `Ok(None)` for a
/// blank one (cleared), the trimmed absolute path otherwise. It is an absolute
/// path on the *host* (a `~` would be the very home the user is trying to avoid),
/// without control characters or `..` parts, and not the root.
pub fn clean_agent_dir(dir: &str) -> Result<Option<String>, String> {
    let t = dir.trim();
    if t.is_empty() {
        return Ok(None);
    }
    if !t.starts_with('/') {
        return Err("the agent folder must be an absolute path on the machine (starting with /)".into());
    }
    if t.chars().any(char::is_control) {
        return Err("the agent folder contains a control character".into());
    }
    if t.split('/').any(|part| part == "..") {
        return Err("the agent folder must not contain \"..\"".into());
    }
    let t = t.trim_end_matches('/');
    if t.is_empty() {
        return Err("the agent folder must not be the root".into());
    }
    Ok(Some(t.to_string()))
}

/// The folder that stands in for `$HOME` for agents on a host whose agent folder
/// is `dir` (already [`clean_agent_dir`]ed). Everything an agent CLI keeps in its
/// home - the binary an installer drops under `~/.local`, `~/.claude`, `~/.codex`,
/// its login - lands below it.
pub fn agent_home_in(dir: &str) -> String {
    format!("{dir}/{}", home_leaf())
}

/// `s` as one single-quoted POSIX-sh word.
fn sh_word(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// The POSIX-sh prelude that points an agent (and the installer in front of it) at
/// `home` instead of the login's home, for a host whose quota the real home
/// cannot take. Run inside the remote login shell, *after* it has set up `PATH`
/// from the real home's profile (so nvm/pyenv still resolve), and before the
/// install probe:
///
/// - `HOME` becomes `home` (created if missing; a failure aborts the tab);
/// - the `XDG_*` bases an environment may pin to the real home are dropped, so
///   they cannot pull a CLI back there;
/// - `.ssh`, `.gitconfig` and `.config/git` of the real home are *linked* in
///   (never copied, never replaced), so `git` and `ssh` inside the agent still
///   find the user's keys and identity;
/// - `npm -g` gets a prefix under `home`, and the launcher dirs
///   ([`LAUNCHER_DIRS`]) come first on `PATH`, so a CLI installed there wins over
///   none and is found on every later launch.
///
/// A CLI already installed in the real home is still found (it stays on `PATH`
/// behind these); it just runs with its login and sessions in `home`.
pub fn home_prelude(home: &str) -> String {
    let path: String = LAUNCHER_DIRS.iter().map(|d| format!("\"$HOME/{d}\":")).collect();
    format!(
        "__real_home=\"$HOME\"; export HOME={home}; \
         mkdir -p \"$HOME\" 2>/dev/null || {{ echo '{SLUG}: cannot create the agent folder' \"$HOME\" >&2; exit 1; }}; \
         unset XDG_CONFIG_HOME XDG_DATA_HOME XDG_CACHE_HOME XDG_STATE_HOME; \
         for __l in .ssh .gitconfig .config/git; do \
         if [ -e \"$__real_home/$__l\" ] && [ ! -e \"$HOME/$__l\" ] && [ ! -L \"$HOME/$__l\" ]; then \
         mkdir -p \"$HOME/$(dirname \"$__l\")\" 2>/dev/null && ln -s \"$__real_home/$__l\" \"$HOME/$__l\" 2>/dev/null; fi; done; \
         export NPM_CONFIG_PREFIX=\"$HOME/npm\"; export PATH={path}\"$PATH\"",
        home = sh_word(home),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_blank_agent_folder_clears_and_a_good_one_is_trimmed() {
        assert_eq!(clean_agent_dir("  ").unwrap(), None);
        assert_eq!(clean_agent_dir(" /scratch/me/ ").unwrap().as_deref(), Some("/scratch/me"));
    }

    #[test]
    fn a_bad_agent_folder_is_refused() {
        for bad in ["~/agents", "agents", "/", "///", "/a/../b", "/a\nb", "/a\0b"] {
            assert!(clean_agent_dir(bad).is_err(), "{bad:?} was accepted");
        }
    }

    #[test]
    fn the_agent_home_sits_inside_the_folder() {
        assert_eq!(agent_home_in("/scratch/me"), format!("/scratch/me/{SLUG}-agent-home"));
    }

    #[test]
    fn the_home_prelude_swaps_home_and_keeps_the_real_one_reachable() {
        let p = home_prelude("/scratch/it's/h");
        assert!(p.starts_with("__real_home=\"$HOME\"; export HOME='/scratch/it'\\''s/h';"));
        assert!(p.contains("unset XDG_CONFIG_HOME XDG_DATA_HOME XDG_CACHE_HOME XDG_STATE_HOME"));
        // git and ssh still see the user's identity, by link and never by copy.
        for linked in [".ssh", ".gitconfig", ".config/git"] {
            assert!(p.contains(linked), "{linked} is not linked in");
        }
        assert!(p.contains("ln -s") && !p.contains("cp "));
        assert!(p.contains("NPM_CONFIG_PREFIX=\"$HOME/npm\""));
        // Launcher dirs lead the PATH; the old PATH stays behind them.
        assert!(p.ends_with("\"$PATH\""));
        assert!(p.contains("export PATH=\"$HOME/.local/bin\":"));
        assert!(!p.contains('\n'));
    }

    #[test]
    fn recipe_for_matches_base_name() {
        assert!(recipe_for("claude").is_some());
        assert!(recipe_for("/usr/local/bin/claude").is_some());
        assert!(recipe_for("definitely-not-an-agent").is_none());
    }

    /// #28b's open item: the table used to hold `claude` alone, so a Codex or
    /// Gemini tab on a host without the CLI died with a bare "command not found".
    #[test]
    fn the_generalized_agents_all_have_recipes() {
        for bin in ["claude", "codex", "gemini", "agy", "vibe", "opencode"] {
            assert!(recipe_for(bin).is_some(), "{bin} has no remote recipe");
        }
    }

    #[test]
    fn bootstrap_prelude_probes_installs_and_aborts() {
        let r = recipe_for("claude").unwrap();
        let p = bootstrap_prelude(r);
        assert!(p.contains("command -v claude >/dev/null 2>&1"));
        assert!(p.contains("curl -fsSL https://claude.ai/install.sh | bash"));
        assert!(p.contains("exit 127"));
        // Probed twice: once before install, once after to confirm it worked.
        assert_eq!(p.matches("command -v claude").count(), 2);
        // …with the shell's command cache dropped in between, or an install into
        // an already-PATH'd directory would still probe as missing.
        assert!(p.contains("hash -r"));
    }

    /// Every recipe builds a prelude that names its own binary and aborts, so a
    /// row added later cannot quietly ship a prelude that exec's regardless.
    #[test]
    fn every_recipe_builds_an_aborting_prelude() {
        for r in recipes() {
            let p = bootstrap_prelude(r);
            assert_eq!(
                p.matches(&format!("command -v {}", r.bin)).count(),
                2,
                "{} does not probe twice",
                r.bin
            );
            assert!(p.contains("exit 127"), "{} does not abort", r.bin);
            assert!(
                p.contains(r.install),
                "{} does not run its installer",
                r.bin
            );
        }
    }

    /// The prelude is embedded in a remote script, so a recipe carrying a NUL or
    /// a newline would split the line it is spliced into. (Single quotes are
    /// safe: the whole inner string goes through `ssh_exec::shell_quote`.)
    #[test]
    fn recipes_carry_no_line_breaking_characters() {
        for r in recipes() {
            for (what, s) in [
                ("bin", r.bin),
                ("install", r.install),
                ("manual_hint", r.manual_hint),
            ] {
                assert!(
                    !s.contains('\n') && !s.contains('\r') && !s.contains('\0'),
                    "{}'s {what} contains a line break or NUL",
                    r.bin
                );
            }
        }
    }

    /// Every installer must be runnable by an unprivileged user: a remote is
    /// typically a shared login node, and a `sudo` in a prelude would put a
    /// password prompt inside an agent's PTY.
    #[test]
    fn no_recipe_needs_root() {
        for r in recipes() {
            assert!(
                !r.install.contains("sudo") && !r.install.contains("doas"),
                "{} escalates in its installer",
                r.bin
            );
        }
    }
}
