//! The built-in agent-CLI registry (`AGENTS`): every agent Tabtivity can launch
//! as a tab, its binary, label, resume args, install command and login paths,
//! plus the lookups over it and the "is it installed / which version" probes
//! a spawn consults. Moved down from `commands::agents` (S5), which keeps the
//! install/usage commands and re-exports these names.

use crate::services::agent_auth::{dir as auth_dir, file as auth_file, AuthPath, DirNames};

/// A single installable agent CLI.
#[derive(Clone, Copy)]
pub(crate) struct AgentSpec {
    /// Stable id used by the frontend and `install-progress` events.
    pub(crate) id: &'static str,
    /// Human-readable label.
    pub(crate) label: &'static str,
    /// Binary name to probe on `PATH` (`where` on Windows, `which` elsewhere).
    /// Also the agent tab's `cmd`, which is how a restored tab is known to be
    /// an agent (the frontend's generated `agentCliTable.ts`).
    pub(crate) bin: &'static str,
    /// How a restarted tab of this CLI gets its conversation back.
    pub(crate) resume: Resume,
    /// Official non-interactive install command (Linux/macOS, run in `sh`).
    pub(crate) install_cmd: &'static str,
    /// Official non-interactive install command on Windows, when one exists.
    /// `None` means there is no one-line Windows installer — the UI then points
    /// at `docs` instead. Commands using `irm`/`iex` are PowerShell-only; plain
    /// `npm`/`python` commands run in either PowerShell or Command Prompt (see
    /// `windows_shell`).
    pub(crate) install_cmd_windows: Option<&'static str>,
    /// Extra home-relative paths to check when the PATH lookup misses (PATH gaps).
    pub(crate) extra_paths: &'static [&'static str],
    /// Docs URL shown when automatic install isn't possible.
    pub(crate) docs: &'static str,
    /// Where this CLI keeps its sign-in under `$HOME` (Linux survey
    /// 2026-09-25): shared across every Tabtivity agent home by
    /// `services::agent_auth`. Only files that hold a credential and can
    /// never name a command. A config that mixes both (Continue's
    /// `config.yaml`, Crush's `crush.json`, Cline's `providers.json`) stays
    /// per scope, and so does a file the CLI loads as its environment —
    /// Vibe's `.vibe/.env`, Aider's `.aider/oauth-keys.env` and `.env`,
    /// mini-swe-agent's `.config/mini-swe-agent/.env` — since one
    /// `GIT_CONFIG_*` line in it runs a command (threat recheck 2026-10-08,
    /// gap 16; `agent_auth::RETIRED`). A login kept in a database beside
    /// other state (Kiro, Kilo, OpenClaw) or in the keyring (Copilot:
    /// `services::copilot_auth`) is per scope too. A login folder lists the
    /// file names it shares (`agent_auth::DirNames`).
    pub(crate) auth_paths: &'static [AuthPath],
}

/// How a restarted agent tab brings its conversation back — the frontend's
/// `RESUMABLE_AGENTS`, generated from this table (`agent_clis_ts`).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Resume {
    /// No per-session resume: the tab is not kept across a restart.
    No,
    /// Relaunch with these args, [`SESSION_ID`] replaced by the tab's session
    /// id. Two styles: an id the launch captured (Claude), or the CLI's own
    /// "continue the cwd's most recent session" flag — each agent tab starts in
    /// its project directory, so that session IS the tab's (two tabs of one
    /// agent in one project cannot be told apart on restore). Empty args: the
    /// backend injects them at spawn from a hook record (Codex).
    Args(&'static [&'static str]),
}

/// The placeholder a [`Resume::Args`] entry uses for the tab's session id.
pub(crate) const SESSION_ID: &str = "{sessionId}";

/// The registry's login paths, for `services::agent_auth`.
pub fn auth_registry() -> Vec<(&'static str, &'static [AuthPath])> {
    AGENTS.iter().map(|a| (a.id, a.auth_paths)).collect()
}

/// The built-in agent registry. The order here is the order the UI lists them.
pub(crate) const AGENTS: &[AgentSpec] = &[
    AgentSpec {
        id: "claude",
        label: "Claude",
        bin: "claude",
        // `--resume <launch id>`; the backend upgrades the id to the live one
        // after `/clear` (`launch_prep`).
        resume: Resume::Args(&["--resume", SESSION_ID]),
        install_cmd: "curl -fsSL https://claude.ai/install.sh | bash",
        install_cmd_windows: Some("irm https://claude.ai/install.ps1 | iex"),
        extra_paths: &[".local/bin/claude"],
        docs: "https://docs.anthropic.com/en/docs/claude-code/setup",
        auth_paths: &[auth_file(".claude/.credentials.json")],
    },
    AgentSpec {
        id: "codex",
        label: "Codex",
        bin: "codex",
        // Codex mints its own session id: the tab's id is only the
        // `<APP>_TAB_UID` key, and `terminal::resolve_codex_session` injects
        // `codex resume <live id>` at spawn — no args from here.
        resume: Resume::Args(&[]),
        install_cmd: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
        install_cmd_windows: Some("irm https://chatgpt.com/codex/install.ps1 | iex"),
        extra_paths: &[".local/bin/codex"],
        docs: "https://github.com/openai/codex",
        auth_paths: &[auth_file(".codex/auth.json")],
    },
    AgentSpec {
        id: "antigravity",
        label: "Google Antigravity",
        bin: "agy",
        // `-c`/`--continue` resumes the most recent conversation.
        resume: Resume::Args(&["--continue"]),
        install_cmd: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
        install_cmd_windows: Some("irm https://antigravity.google/cli/install.ps1 | iex"),
        extra_paths: &[".local/bin/agy", "AppData/Local/agy/bin/agy"],
        docs: "https://antigravity.google/docs/cli/install/",
        auth_paths: &[auth_file(".gemini/antigravity-cli/antigravity-oauth-token")],
    },
    AgentSpec {
        id: "gemini",
        label: "Google Gemini",
        bin: "gemini",
        // `--resume` takes "latest" (or an index), not the uuid its launch
        // `--session-id` minted: continue-last like the others.
        resume: Resume::Args(&["--resume", "latest"]),
        install_cmd: "npm install -g @google/gemini-cli",
        install_cmd_windows: Some("npm install -g @google/gemini-cli"),
        extra_paths: &[".local/bin/gemini"],
        docs: "https://github.com/google-gemini/gemini-cli",
        auth_paths: &[auth_file(".gemini/oauth_creds.json")],
    },
    AgentSpec {
        id: "vibe",
        label: "Mistral",
        bin: "vibe",
        // Vibe mints its own id; the backend replaces this fallback with
        // `--resume <live id>` once its post-agent hook has recorded a turn.
        resume: Resume::Args(&["--continue"]),
        install_cmd: "curl -LsSf https://mistral.ai/vibe/install.sh | bash",
        // No one-line Windows installer; the UI points at `docs`.
        install_cmd_windows: None,
        extra_paths: &[".local/bin/vibe", ".cargo/bin/vibe"],
        docs: "https://docs.mistral.ai/getting-started/quickstarts/vibe-code/install-cli",
        // `~/.vibe/.env` is loaded as environment: per scope.
        auth_paths: &[],
    },
    AgentSpec {
        id: "kiro",
        label: "Kiro",
        // `kiro-cli`, not `kiro`: this installer is the renamed Amazon Q
        // Developer CLI and it keeps that executable name (the `q`/`q chat`
        // entry points still work too). Probing `kiro` reported every
        // installed Kiro as missing, and launched a tab on a command that is
        // not there.
        bin: "kiro-cli",
        resume: Resume::No,
        install_cmd: "curl -fsSL https://cli.kiro.dev/install | bash",
        install_cmd_windows: None,
        extra_paths: &[".local/bin/kiro-cli"],
        docs: "https://kiro.dev/docs/cli/installation/",
        auth_paths: &[],
    },
    AgentSpec {
        id: "cline",
        label: "Cline",
        bin: "cline",
        resume: Resume::No,
        install_cmd: "npm install -g cline",
        install_cmd_windows: Some("npm install -g cline"),
        extra_paths: &[],
        docs: "https://docs.cline.bot/getting-started/installing-cline",
        // `~/.cline/data/settings/providers.json` holds the login but also
        // the provider config: per scope.
        auth_paths: &[],
    },
    AgentSpec {
        id: "aider",
        label: "Aider",
        bin: "aider",
        // No per-session resume (only `--restore-chat-history`).
        resume: Resume::No,
        // Use Aider's official uv-based one-liners. Unlike the pip bootstrap,
        // these do not assume the host provides a `python` alias (many Linux
        // distributions only ship `python3`) or permits writes to its
        // distro-managed Python environment.
        install_cmd: "curl -LsSf https://aider.chat/install.sh | sh",
        // `installer_command` already supplies the PowerShell process and
        // execution-policy override, so this is the body of Aider's documented
        // `powershell ... -c "..."` command.
        install_cmd_windows: Some("irm https://aider.chat/install.ps1 | iex"),
        extra_paths: &[".local/bin/aider"],
        docs: "https://aider.chat/docs/install.html",
        // `~/.aider/oauth-keys.env` is loaded as environment: per scope.
        auth_paths: &[],
    },
    AgentSpec {
        id: "opencode",
        label: "OpenCode",
        bin: "opencode",
        resume: Resume::Args(&["--continue"]),
        // OpenCode 2: `opencode.ai/install` and npm `opencode-ai` only ever
        // serve OpenCode 1. The V2 script replaces a V1 binary in place
        // (same `~/.opencode/bin`); on Windows the V1 package goes first, as
        // both packages link an `opencode` launcher.
        install_cmd: "curl -fsSL https://opencode.ai/v2/install | bash",
        install_cmd_windows: Some("npm uninstall -g opencode-ai && npm install -g @opencode/cli"),
        extra_paths: &[".opencode/bin/opencode", ".local/bin/opencode"],
        docs: "https://opencode.ai/docs/",
        auth_paths: &[auth_file(".local/share/opencode/auth.json")],
    },
    AgentSpec {
        id: "cursor-agent",
        label: "Cursor",
        bin: "cursor-agent",
        resume: Resume::Args(&["--continue"]),
        install_cmd: "curl https://cursor.com/install -fsS | bash",
        // No one-line Windows installer; the UI points at `docs`.
        install_cmd_windows: None,
        extra_paths: &[".local/bin/cursor-agent"],
        docs: "https://cursor.com/docs/cli/installation",
        auth_paths: &[auth_file(".config/cursor/auth.json")],
    },
    AgentSpec {
        id: "copilot",
        label: "Copilot",
        bin: "copilot",
        resume: Resume::Args(&["--continue"]),
        install_cmd: "npm install -g @github/copilot",
        install_cmd_windows: Some("npm install -g @github/copilot"),
        extra_paths: &[".local/bin/copilot"],
        docs: "https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli",
        auth_paths: &[],
    },
    AgentSpec {
        id: "droid",
        label: "Droid",
        bin: "droid",
        // `--resume` with no id loads the cwd's most recent session.
        resume: Resume::Args(&["--resume"]),
        install_cmd: "curl -fsSL https://app.factory.ai/cli | sh",
        install_cmd_windows: Some("irm https://app.factory.ai/cli/windows | iex"),
        extra_paths: &[".local/bin/droid"],
        docs: "https://docs.factory.ai/cli/getting-started/overview",
        auth_paths: &[auth_file(".factory/auth.v2.json")],
    },
    AgentSpec {
        id: "grok",
        label: "Grok",
        bin: "grok",
        // Grok Build: `-c/--continue` takes the cwd's most recent session;
        // its `--resume <id>` wants Grok's own id, which a launch cannot supply.
        resume: Resume::Args(&["--continue"]),
        // xAI's own Grok Build, not `@xai-official/grok` — the third-party
        // client this row used to install. Both install as `grok`, which is
        // what made the wrong one invisible: a stale 0.0.34 that keeps no
        // conversation, where the vendor CLI has shipped 1.0.x since Aug 2026.
        install_cmd: "curl -fsSL https://x.ai/cli/install.sh | bash",
        install_cmd_windows: Some("npm install -g @xai-official/grok"),
        extra_paths: &[".grok/bin/grok"],
        docs: "https://docs.x.ai/build/overview",
        auth_paths: &[auth_file(".grok/auth.json")],
    },
    AgentSpec {
        id: "qwen",
        label: "Qwen",
        bin: "qwen",
        resume: Resume::Args(&["--continue"]),
        install_cmd: "npm install -g @qwen-code/qwen-code",
        install_cmd_windows: Some("npm install -g @qwen-code/qwen-code"),
        extra_paths: &[".local/bin/qwen"],
        docs: "https://github.com/QwenLM/qwen-code",
        auth_paths: &[auth_file(".qwen/oauth_creds.json")],
    },
    AgentSpec {
        id: "openclaw",
        label: "OpenClaw",
        bin: "openclaw",
        resume: Resume::No,
        // OpenClaw's own local-prefix installer, not `npm install -g openclaw`:
        // the package demands Node >=24.16, newer than most distro Node, and a
        // system-wide npm prefix is root-owned (EACCES). This one fetches a
        // private Node 24 and installs both under `~/.openclaw` — no root, no
        // onboarding prompt, nothing added to shell rc files.
        install_cmd: "curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash",
        // The Windows installer onboards interactively unless told not to.
        install_cmd_windows: Some(
            "$env:OPENCLAW_NO_ONBOARD='1'; irm https://openclaw.ai/install.ps1 | iex",
        ),
        extra_paths: &[".openclaw/bin/openclaw", ".local/bin/openclaw"],
        docs: "https://docs.openclaw.ai",
        auth_paths: &[],
    },
    AgentSpec {
        id: "auggie",
        label: "Auggie",
        bin: "auggie",
        resume: Resume::No,
        install_cmd: "npm install -g @augmentcode/auggie",
        install_cmd_windows: Some("npm install -g @augmentcode/auggie"),
        extra_paths: &[],
        docs: "https://docs.augmentcode.com/cli/overview",
        auth_paths: &[auth_file(".augment/session.json")],
    },
    AgentSpec {
        id: "kilo",
        label: "Kilo Code",
        bin: "kilo",
        resume: Resume::No,
        install_cmd: "curl -fsSL https://kilo.ai/cli/install | bash",
        install_cmd_windows: Some("npm install -g @kilocode/cli"),
        extra_paths: &[".kilo/bin/kilo"],
        docs: "https://kilo.ai/docs/code-with-ai/platforms/cli",
        auth_paths: &[],
    },
    AgentSpec {
        id: "continue",
        label: "Continue.dev",
        // `cn`, not `continue`: the package is @continuedev/cli and the
        // executable it installs is the two-letter one.
        bin: "cn",
        resume: Resume::No,
        install_cmd: "npm install -g @continuedev/cli",
        install_cmd_windows: Some("npm install -g @continuedev/cli"),
        extra_paths: &[],
        docs: "https://docs.continue.dev/cli/quickstart",
        auth_paths: &[],
    },
    AgentSpec {
        id: "junie",
        label: "JetBrains Junie",
        bin: "junie",
        resume: Resume::No,
        install_cmd: "curl -fsSL https://junie.jetbrains.com/install.sh | bash",
        install_cmd_windows: Some("npm install -g @jetbrains/junie-cli"),
        extra_paths: &[".local/bin/junie"],
        docs: "https://junie.jetbrains.com/docs/junie-cli.html",
        auth_paths: &[auth_file(".junie/secure_credentials.json")],
    },
    AgentSpec {
        id: "codebuddy",
        label: "CodeBuddy",
        bin: "codebuddy",
        resume: Resume::No,
        install_cmd: "npm install -g @tencent-ai/codebuddy-code",
        install_cmd_windows: Some("npm install -g @tencent-ai/codebuddy-code"),
        extra_paths: &[],
        docs: "https://www.codebuddy.ai/docs/cli/README",
        auth_paths: &[auth_dir(".local/share/CodeBuddyExtension/Data/Public/auth", DirNames::CodeBuddyInfo)],
    },
    AgentSpec {
        id: "goose",
        label: "Goose",
        bin: "goose",
        resume: Resume::No,
        install_cmd: "curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh | bash",
        install_cmd_windows: None,
        extra_paths: &[".local/bin/goose"],
        docs: "https://github.com/aaif-goose/goose",
        auth_paths: &[auth_file(".config/goose/secrets.yaml")],
    },
    AgentSpec {
        id: "pi",
        label: "Pi",
        bin: "pi",
        resume: Resume::No,
        install_cmd: "npm install -g @earendil-works/pi-coding-agent",
        install_cmd_windows: Some("npm install -g @earendil-works/pi-coding-agent"),
        extra_paths: &[],
        docs: "https://github.com/earendil-works/pi/tree/main/packages/coding-agent",
        auth_paths: &[auth_file(".pi/agent/auth.json")],
    },
    AgentSpec {
        id: "plandex",
        label: "Plandex",
        bin: "plandex",
        resume: Resume::No,
        install_cmd: "curl -sL https://plandex.ai/install.sh | bash",
        install_cmd_windows: None,
        extra_paths: &[],
        docs: "https://docs.plandex.ai/docs/cli-reference/",
        auth_paths: &[auth_file(".plandex-home-v2/auth.json")],
    },
    AgentSpec {
        id: "swe-agent",
        label: "SWE-agent",
        bin: "sweagent",
        resume: Resume::No,
        install_cmd: "pip install swe-agent",
        install_cmd_windows: Some("pip install swe-agent"),
        extra_paths: &[".local/bin/sweagent"],
        docs: "https://swe-agent.com/latest/installation/source/",
        auth_paths: &[],
    },
    AgentSpec {
        id: "mini-swe-agent",
        label: "mini-SWE-agent",
        bin: "mini",
        resume: Resume::No,
        install_cmd: "pip install mini-swe-agent",
        install_cmd_windows: Some("pip install mini-swe-agent"),
        extra_paths: &[".local/bin/mini"],
        docs: "https://mini-swe-agent.com/latest/quickstart/",
        // `~/.config/mini-swe-agent/.env` is loaded as environment: per scope.
        auth_paths: &[],
    },
    AgentSpec {
        id: "crush",
        label: "Crush",
        bin: "crush",
        resume: Resume::No,
        install_cmd: "npm install -g @charmland/crush",
        install_cmd_windows: Some("npm install -g @charmland/crush"),
        extra_paths: &[],
        docs: "https://github.com/charmbracelet/crush",
        auth_paths: &[],
    },
    AgentSpec {
        id: "amp",
        label: "Amp",
        bin: "amp",
        resume: Resume::No,
        install_cmd: "npm install -g @ampcode/cli",
        install_cmd_windows: Some("npm install -g @ampcode/cli"),
        extra_paths: &[],
        docs: "https://ampcode.com/",
        auth_paths: &[auth_file(".local/share/amp/secrets.json")],
    },
    AgentSpec {
        id: "kimi",
        label: "Kimi Code",
        bin: "kimi",
        resume: Resume::No,
        // `/kimi-code/`, not the bare host path: that one serves the
        // deprecated Python `kimi-cli` (whose own installer renames it to
        // `kimi-legacy` when Kimi Code lands beside it). Both put `kimi` in
        // `~/.kimi-code/bin`.
        install_cmd: "curl -LsSf https://code.kimi.com/kimi-code/install.sh | bash",
        install_cmd_windows: Some("Invoke-RestMethod https://code.kimi.com/kimi-code/install.ps1 | Invoke-Expression"),
        extra_paths: &[".kimi-code/bin/kimi", ".local/bin/kimi"],
        docs: "https://code.kimi.com/kimi-code",
        auth_paths: &[auth_dir(".kimi-code/credentials", DirNames::Json)],
    },
    AgentSpec {
        id: "qoder",
        label: "Qoder",
        bin: "qoder",
        resume: Resume::No,
        install_cmd: "curl -fsSL https://qoder.com/install | bash",
        install_cmd_windows: Some("irm https://qoder.com/install.ps1 | iex"),
        extra_paths: &[".local/bin/qoder"],
        docs: "https://docs.qoder.com/cli/installation",
        auth_paths: &[auth_file(".qoder/.auth")],
    },
    AgentSpec {
        id: "muse",
        label: "Meta Muse Code",
        bin: "muse",
        resume: Resume::No,
        install_cmd: "curl -fsSL https://dev.meta.ai/install.sh | bash",
        install_cmd_windows: None,
        extra_paths: &[".local/bin/muse"],
        docs: "https://dev.meta.ai",
        auth_paths: &[auth_file(".config/muse/auth.json")],
    },
];

pub(crate) fn find_spec(id: &str) -> Option<&'static AgentSpec> {
    AGENTS.iter().find(|a| a.id == id)
}

/// Every agent CLI's binary name — the registry as a plain set, for callers that
/// only need "is this command an agent?".
///
/// It exists so `services::sandbox::is_agent_cmd` (which decides whether a spawn
/// is containerized under `SandboxScope::Agents`) reads the *same* table the +
/// menu lists from. A hand-copied second list is how an agent added here would
/// silently start running outside the container.
pub fn agent_bins() -> Vec<&'static str> {
    AGENTS.iter().map(|a| a.bin).collect()
}

/// The launch args that bring a resumable built-in agent tab's conversation
/// back (`Resume`), or `None` for a CLI with no per-session resume or a
/// command the registry does not list.
pub fn resume_args_for_bin(bin: &str, session_id: &str) -> Option<Vec<String>> {
    match AGENTS.iter().find(|a| a.bin == bin)?.resume {
        Resume::No => None,
        Resume::Args(args) => Some(
            args.iter()
                .map(|a| if *a == SESSION_ID { session_id.to_string() } else { (*a).to_string() })
                .collect(),
        ),
    }
}

/// Whether a built-in agent tab running `bin` resumes across a restart.
pub fn is_resumable_bin(bin: &str) -> bool {
    AGENTS.iter().any(|a| a.bin == bin && a.resume != Resume::No)
}

/// `src/lib/agents/agentCliTable.ts`: the registry as the frontend's static
/// table, for the synchronous paths that cannot await `list_agents` (a
/// restored tab's kind, its resume args, the + menu's rows). One source, so a
/// CLI added here restores as an agent rather than a shell.
/// `the_generated_agent_cli_table_ts_is_current` holds the file to this.
pub fn agent_cli_table_ts() -> String {
    fn quoted(s: &str) -> String {
        serde_json::to_string(s).expect("a string serializes")
    }
    let mut out = String::from(
        "// Generated from src-tauri/src/services/agent/agent_registry.rs (`AGENTS`) — do not edit.\n\
         // Regenerate: UPDATE_AGENT_CLI_TABLE=1 cargo test --manifest-path src-tauri/Cargo.toml -q --lib -- the_generated_agent_cli_table_ts_is_current\n\
         //\n\
         // The built-in agent CLIs in menu order: registry id, the binary a tab\n\
         // runs (its `cmd`), display name, and the args that resume a restarted\n\
         // tab (`null`: not resumable; `SESSION_ID_ARG` stands for the tab's\n\
         // session id). Read through `lib/agents/agentClis.ts`.\n\n\
         export const SESSION_ID_ARG = ",
    );
    out.push_str(&quoted(SESSION_ID));
    out.push_str(
        ";\n\n\
         export interface AgentCliRow {\n\
         \x20 readonly id: string;\n\
         \x20 readonly bin: string;\n\
         \x20 readonly label: string;\n\
         \x20 readonly resume: readonly string[] | null;\n\
         }\n\n\
         export const AGENT_CLI_ROWS: readonly AgentCliRow[] = [\n",
    );
    for a in AGENTS {
        let resume = match a.resume {
            Resume::No => "null".to_string(),
            Resume::Args(args) => {
                format!("[{}]", args.iter().map(|x| quoted(x)).collect::<Vec<_>>().join(", "))
            }
        };
        out.push_str(&format!(
            "  {{ id: {}, bin: {}, label: {}, resume: {resume} }},\n",
            quoted(a.id),
            quoted(a.bin),
            quoted(a.label)
        ));
    }
    out.push_str("];\n");
    out
}

/// The registry's display name for an agent CLI's binary ("claude" → "Claude"),
/// or `None` for a command the registry does not list. It lets a surface say
/// which agent a tab runs without publishing the command itself — the phone's
/// tab list is one (`services::mobile_control::discovery`).
pub fn agent_label_for_bin(bin: &str) -> Option<&'static str> {
    AGENTS.iter().find(|a| a.bin == bin).map(|a| a.label)
}

/// The registry's display name for an agent id ("claude" → "Claude").
pub fn agent_label_for_id(id: &str) -> Option<&'static str> {
    AGENTS.iter().find(|a| a.id == id).map(|a| a.label)
}

/// The registry id of the agent whose binary is `bin` — what the settings'
/// `disabled_agents` list names (`SettingsSubPanels`' Manage CLIs switches).
pub fn agent_id_for_bin(bin: &str) -> Option<&'static str> {
    AGENTS.iter().find(|a| a.bin == bin).map(|a| a.id)
}

/// Where `spec`'s binary actually lives — on `PATH` (including Tabtivity's
/// supplemental Windows/macOS fallback dirs) or in one of its well-known
/// per-user install locations — or `None` when it isn't installed. The single
/// resolver behind both `spec_is_installed` and `uninstall_agent` (removal
/// deletes exactly the file detection found, never a guess).
///
/// PATH lookup goes through the shared cross-platform helper (`where` on Windows,
/// `which` elsewhere): `which` does not exist on Windows, so probing it directly
/// reported every Windows install — Claude included — as missing.
pub(crate) fn resolve_spec_path(spec: &AgentSpec) -> Option<std::path::PathBuf> {
    if let Some(path) = crate::paths::resolve_executable(spec.bin) {
        return Some(path);
    }
    // Tabtivity's own install home first, then the user's.
    let homes = [crate::services::agent_install::install_root(), crate::paths::home_dir()];
    homes.iter().find_map(|home| spec.extra_paths.iter().find_map(|rel| {
        let base = home.join(rel);
        if base.exists() {
            return Some(base);
        }
        // On Windows the extra paths omit the executable extension that the
        // installer actually writes (e.g. `.local/bin/claude` → `claude.exe`).
        if cfg!(target_os = "windows") {
            for ext in ["exe", "cmd", "bat", "ps1"] {
                let cand = base.with_extension(ext);
                if cand.exists() {
                    return Some(cand);
                }
            }
        }
        None
    }))
}

/// True when an agent's binary is reachable on `PATH` or in one of its
/// well-known user install locations.
pub(crate) fn spec_is_installed(spec: &AgentSpec) -> bool {
    resolve_spec_path(spec).is_some()
}

/// Sync install probe for callers outside the agent registry (e.g. the local-
/// model drivers in `services::local_drivers`). Looks `bin` up in the registry first so
/// it reuses the known user install locations; falls back to a bare PATH lookup
/// for binaries the registry doesn't track (e.g. Droid).
pub fn binary_is_installed(bin: &str) -> bool {
    AGENTS
        .iter()
        .find(|a| a.bin == bin)
        .map(spec_is_installed)
        .unwrap_or_else(|| crate::paths::binary_on_path(bin))
}

/// Resolve an agent by registry `id` *or* binary name. The schedule is keyed by
/// whatever the settings panel handed it (the id), while the + menu's tab
/// specs speak in binaries (`agy`, `gpte`); accepting both means a schedule
/// written by either surface finds its agent.
pub(crate) fn find_spec_by_id_or_bin(agent: &str) -> Option<&'static AgentSpec> {
    find_spec(agent).or_else(|| AGENTS.iter().find(|a| a.bin == agent))
}

/// The folder every warm-up runs in. A print-mode agent records its session
/// under its working directory (Claude keys `~/.claude/projects/` by cwd), so
/// the run gets a directory of its own under Tabtivity's state dir rather than a
/// project's: it must not show up in any project's resume list, and it must
/// not be able to read anything a project holds. Nothing else lives here.
pub(crate) fn warmup_dir() -> Result<std::path::PathBuf, String> {
    let dir = crate::storage::state_dir().join("agent-cron");
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    Ok(dir)
}

/// Ask one agent CLI what version it is, once.
///
/// Same spawn shape as the usage read above and for the same reasons: argv
/// (never a shell line), stdin closed so a CLI that ignores `--version` and
/// opens its TUI has nothing to read, its own process group, `kill_on_drop` so
/// the timeout actually reaps, and the state dir as cwd so no project folder's
/// first-run trust prompt gets in the way of a question that has nothing to do
/// with that folder.
pub(crate) async fn probe_agent_version(
    spec: &'static AgentSpec,
    path: &std::path::Path,
) -> Result<String, String> {
    use crate::services::agent_versions as versions;

    let argv = versions::version_argv(spec.id)
        .ok_or_else(|| format!("{} has no known version flag", spec.label))?;
    let cwd = warmup_dir()?;

    let mut cmd = tokio::process::Command::from(crate::paths::command_no_window(path));
    cmd.args(&argv)
        .envs(versions::version_env(spec.id).iter().copied())
        .current_dir(&cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    {
        cmd.process_group(0);
    }
    let output = match tokio::time::timeout(versions::VERSION_TIMEOUT, async {
        cmd.spawn()
            .map_err(|e| format!("cannot start {}: {e}", path.display()))?
            .wait_with_output()
            .await
            .map_err(|e| format!("{} did not run: {e}", spec.label))
    })
    .await
    {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => return Err(error),
        Err(_) => {
            return Err(format!(
                "{} did not answer within {}s",
                spec.label,
                versions::VERSION_TIMEOUT.as_secs()
            ))
        }
    };
    versions::version_text(
        &String::from_utf8_lossy(&output.stdout),
        &String::from_utf8_lossy(&output.stderr),
        output.status.code(),
    )
}

/// Whether the host's `claude` takes `--name` at launch, from the version store
/// alone — a tab spawn never waits on a probe. A missing or day-old entry is
/// refreshed in the background (one probe at a time, however many tabs a
/// relaunch restores at once), so it is the *next* Claude tab that benefits;
/// until then this answers from what the store holds, or no.
pub(crate) fn claude_takes_name_flag() -> bool {
    use std::sync::atomic::AtomicBool;
    static PROBING: AtomicBool = AtomicBool::new(false);
    host_agent_version_says("claude", &PROBING, crate::services::agent_versions::claude_takes_name_flag)
}

/// Whether the host's `codex` takes `--no-daemon` at launch — read the same
/// way as [`claude_takes_name_flag`], never waiting on a probe.
pub(crate) fn codex_takes_no_daemon() -> bool {
    use std::sync::atomic::AtomicBool;
    static PROBING: AtomicBool = AtomicBool::new(false);
    host_agent_version_says("codex", &PROBING, crate::services::agent_versions::codex_takes_no_daemon)
}

/// V2 changes startup flags, so the first launch must wait for the bounded
/// version probe rather than letting an unknown release join a shared server.
pub(crate) async fn opencode_is_v2() -> bool {
    use crate::services::agent_versions as versions;
    let Some(spec) = find_spec("opencode") else { return false };
    let Some(path) = resolve_spec_path(spec) else { return false };
    let store = versions::load();
    let seen = store.get(spec.id);
    if seen.is_some_and(|s| versions::fresh_for_path(s, versions::PROBE_TTL, &path)) {
        return versions::opencode_is_v2(seen);
    }
    let result = probe_agent_version(spec, &path).await;
    versions::opencode_is_v2(Some(&versions::remember(spec.id, result, &path)))
}

/// Answer `check` from the version store's entry for `agent`, refreshing a
/// missing or day-old entry in the background (one probe per agent at a time).
pub(crate) fn host_agent_version_says(
    agent: &'static str,
    probing: &'static std::sync::atomic::AtomicBool,
    check: fn(Option<&crate::services::agent_versions::Seen>) -> bool,
) -> bool {
    use crate::services::agent_versions as versions;
    use std::sync::atomic::Ordering;

    let store = versions::load();
    let seen = store.get(agent);
    let path = find_spec(agent).and_then(resolve_spec_path);
    let stale = !seen.is_some_and(|seen| {
        path.as_deref()
            .is_some_and(|path| versions::fresh_for_path(seen, versions::PROBE_TTL, path))
    });
    if stale && !probing.swap(true, Ordering::SeqCst) {
        if let Some(spec) = find_spec(agent).filter(|_| path.is_some()) {
            let path = path.expect("checked above");
            app_core::rt::spawn(async move {
                let result = probe_agent_version(spec, &path).await;
                versions::remember(spec.id, result, &path);
                probing.store(false, Ordering::SeqCst);
            });
        } else {
            probing.store(false, Ordering::SeqCst);
        }
    }
    check(seen)
}

/// The identity of the executable `agent` (registry id or binary name) runs as
/// on this host — what `services::model_rows` keys a CLI build by. `None` for
/// an unknown or missing CLI.
pub fn installed_source(agent: &str) -> Option<(&'static str, crate::services::agent_versions::VersionSource)> {
    let spec = find_spec_by_id_or_bin(agent)?;
    let path = resolve_spec_path(spec)?;
    Some((spec.id, crate::services::agent_versions::version_source(&path)?))
}
