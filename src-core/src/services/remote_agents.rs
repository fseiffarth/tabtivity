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
        install: "curl -fsSL https://opencode.ai/install | bash",
        manual_hint: "curl -fsSL https://opencode.ai/install | bash \
                      (see https://opencode.ai/docs/)",
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

#[cfg(test)]
mod tests {
    use super::*;

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
