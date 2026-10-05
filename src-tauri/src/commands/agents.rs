//! Agent-CLI management: detect and install the AI coding-agent command-line
//! tools Tabtivity can launch as agent tabs. The registry covers the major hosted,
//! open-source, and provider-agnostic terminal agents (Claude, Codex, Gemini,
//! Kiro, Cline, Goose, Pi, and more).
//!
//! This mirrors the local-model install flow in `commands::ollama` (see
//! `install_vibe`), but is registry-driven so the set of agents lives in one
//! table (`AGENTS`). Each spec carries the binary name, the official one-line
//! install command, and any well-known user install locations to also check,
//! since Tabtivity's inherited `PATH` may omit `~/.local/bin` / npm's global bin
//! even when a login shell would include them.

/// A single installable agent CLI.
#[derive(Clone, Copy)]
struct AgentSpec {
    /// Stable id used by the frontend and `install-progress` events.
    id: &'static str,
    /// Human-readable label.
    label: &'static str,
    /// Binary name to probe on `PATH` (`where` on Windows, `which` elsewhere).
    bin: &'static str,
    /// Official non-interactive install command (Linux/macOS, run in `sh`).
    install_cmd: &'static str,
    /// Official non-interactive install command on Windows, when one exists.
    /// `None` means there is no one-line Windows installer — the UI then points
    /// at `docs` instead. Commands using `irm`/`iex` are PowerShell-only; plain
    /// `npm`/`python` commands run in either PowerShell or Command Prompt (see
    /// `windows_shell`).
    install_cmd_windows: Option<&'static str>,
    /// Extra home-relative paths to check when the PATH lookup misses (PATH gaps).
    extra_paths: &'static [&'static str],
    /// Docs URL shown when automatic install isn't possible.
    docs: &'static str,
    /// Where this CLI keeps its sign-in under `$HOME` (Linux survey
    /// 2026-09-25): shared across every Tabtivity agent home by
    /// `services::agent_auth`. Only files that hold a credential and can
    /// never name a command — a config that mixes both (Continue's
    /// `config.yaml`, Crush's `crush.json`, Aider's `.env`) stays per scope,
    /// as does a login kept in a database beside other state (Kiro, Kilo,
    /// OpenClaw) or in the keyring (Copilot: `services::copilot_auth`).
    auth_paths: &'static [AuthPath],
}

use crate::services::agent_auth::{dir as auth_dir, file as auth_file, AuthPath};

/// The registry's login paths, for `services::agent_auth`.
pub fn auth_registry() -> Vec<(&'static str, &'static [AuthPath])> {
    AGENTS.iter().map(|a| (a.id, a.auth_paths)).collect()
}

/// The shell a Windows install command must be run in, derived from the command
/// itself: `irm … | iex` is PowerShell-only; `npm`/`python` installs work in
/// either PowerShell or the classic Command Prompt.
fn windows_shell(cmd: &str) -> &'static str {
    if cmd.contains("iex")
        || cmd.trim_start().starts_with("irm")
        || cmd.contains("Invoke-RestMethod")
        || cmd.contains("Invoke-Expression")
    {
        "PowerShell"
    } else {
        "PowerShell or Command Prompt"
    }
}

fn windows_shell_kind(cmd: &str) -> &'static str {
    if cmd.contains("iex")
        || cmd.trim_start().starts_with("irm")
        || cmd.contains("Invoke-RestMethod")
        || cmd.contains("Invoke-Expression")
    {
        "powershell"
    } else {
        "default"
    }
}

/// The install command + the shell it runs in, for the host OS. On Windows the
/// command is `None` when no one-line installer exists.
fn platform_install(spec: &AgentSpec) -> (Option<&'static str>, String, &'static str) {
    if cfg!(target_os = "windows") {
        let shell = spec
            .install_cmd_windows
            .map(windows_shell)
            .unwrap_or("PowerShell")
            .to_string();
        let kind = spec
            .install_cmd_windows
            .map(windows_shell_kind)
            .unwrap_or("powershell");
        (spec.install_cmd_windows, shell, kind)
    } else {
        (Some(spec.install_cmd), "bash".to_string(), "bash")
    }
}

/// The built-in agent registry. The order here is the order the UI lists them.
const AGENTS: &[AgentSpec] = &[
    AgentSpec {
        id: "claude",
        label: "Claude",
        bin: "claude",
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
        install_cmd: "npm install -g @google/gemini-cli",
        install_cmd_windows: Some("npm install -g @google/gemini-cli"),
        extra_paths: &[".local/bin/gemini"],
        docs: "https://github.com/google-gemini/gemini-cli",
        auth_paths: &[auth_file(".gemini/oauth_creds.json")],
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
        install_cmd: "npm install -g cline",
        install_cmd_windows: Some("npm install -g cline"),
        extra_paths: &[],
        docs: "https://docs.cline.bot/getting-started/installing-cline",
        auth_paths: &[auth_file(".cline/data/settings/providers.json")],
    },
    AgentSpec {
        id: "vibe",
        label: "Mistral",
        bin: "vibe",
        install_cmd: "curl -LsSf https://mistral.ai/vibe/install.sh | bash",
        // No one-line Windows installer; the UI points at `docs`.
        install_cmd_windows: None,
        extra_paths: &[".local/bin/vibe", ".cargo/bin/vibe"],
        docs: "https://docs.mistral.ai/getting-started/quickstarts/vibe-code/install-cli",
        auth_paths: &[auth_file(".vibe/.env")],
    },
    AgentSpec {
        id: "aider",
        label: "Aider",
        bin: "aider",
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
        auth_paths: &[auth_file(".aider/oauth-keys.env")],
    },
    AgentSpec {
        id: "opencode",
        label: "OpenCode",
        bin: "opencode",
        install_cmd: "curl -fsSL https://opencode.ai/install | bash",
        install_cmd_windows: Some("npm install -g opencode-ai"),
        extra_paths: &[".opencode/bin/opencode", ".local/bin/opencode"],
        docs: "https://opencode.ai/docs/",
        auth_paths: &[auth_file(".local/share/opencode/auth.json")],
    },
    AgentSpec {
        id: "cursor-agent",
        label: "Cursor",
        bin: "cursor-agent",
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
        install_cmd: "npm install -g @tencent-ai/codebuddy-code",
        install_cmd_windows: Some("npm install -g @tencent-ai/codebuddy-code"),
        extra_paths: &[],
        docs: "https://www.codebuddy.ai/docs/cli/README",
        auth_paths: &[auth_dir(".local/share/CodeBuddyExtension/Data/Public/auth")],
    },
    AgentSpec {
        id: "goose",
        label: "Goose",
        bin: "goose",
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
        install_cmd: "npm install -g @mariozechner/pi-coding-agent",
        install_cmd_windows: Some("npm install -g @mariozechner/pi-coding-agent"),
        extra_paths: &[],
        docs: "https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent",
        auth_paths: &[auth_file(".pi/agent/auth.json")],
    },
    AgentSpec {
        id: "plandex",
        label: "Plandex",
        bin: "plandex",
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
        install_cmd: "pip install mini-swe-agent",
        install_cmd_windows: Some("pip install mini-swe-agent"),
        extra_paths: &[".local/bin/mini"],
        docs: "https://mini-swe-agent.com/latest/quickstart/",
        auth_paths: &[auth_file(".config/mini-swe-agent/.env")],
    },
    AgentSpec {
        id: "crush",
        label: "Crush",
        bin: "crush",
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
        // `/kimi-code/`, not the bare host path: that one serves the
        // deprecated Python `kimi-cli` (whose own installer renames it to
        // `kimi-legacy` when Kimi Code lands beside it). Both put `kimi` in
        // `~/.kimi-code/bin`.
        install_cmd: "curl -LsSf https://code.kimi.com/kimi-code/install.sh | bash",
        install_cmd_windows: Some("Invoke-RestMethod https://code.kimi.com/kimi-code/install.ps1 | Invoke-Expression"),
        extra_paths: &[".kimi-code/bin/kimi", ".local/bin/kimi"],
        docs: "https://code.kimi.com/kimi-code",
        auth_paths: &[auth_dir(".kimi-code/credentials")],
    },
    AgentSpec {
        id: "qoder",
        label: "Qoder",
        bin: "qoder",
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
        install_cmd: "curl -fsSL https://dev.meta.ai/install.sh | bash",
        install_cmd_windows: None,
        extra_paths: &[".local/bin/muse"],
        docs: "https://dev.meta.ai",
        auth_paths: &[auth_file(".config/muse/auth.json")],
    },
];

/// Public view of one agent + whether it is currently installed.
#[derive(serde::Serialize)]
pub struct AgentInfo {
    pub id: String,
    pub label: String,
    pub bin: String,
    /// The install command for the host OS, or empty when there is no one-line
    /// installer on this platform (Windows-only case — fall back to `docs`).
    pub install_cmd: String,
    /// The shell `install_cmd` is meant to run in: `bash` on Linux/macOS,
    /// `PowerShell` or `PowerShell or Command Prompt` on Windows.
    pub shell: String,
    /// Machine-readable terminal shell policy for the frontend.
    pub shell_kind: String,
    /// `npm uninstall -g <pkg>` for an npm-installed agent, empty otherwise —
    /// the terminal fallback the frontend offers next to "Remove" when the
    /// one-click uninstall hits a permission error (a system-wide npm global
    /// directory owned by root, common on non-nvm Linux Node installs, needs a
    /// sudo prompt Tabtivity cannot answer itself).
    pub uninstall_cmd: String,
    /// `install_cmd` prefixed with `sudo`, or empty when that wouldn't make
    /// sense (Windows, or a non-npm installer — see `sudo_variant`). Offered as
    /// a second one-click "run with elevated rights" terminal button beside the
    /// plain command, since the plain one is what most installs actually need
    /// (nvm and other per-user Node installs) and forcing `sudo` into the
    /// default one-click install would root-own files for that majority.
    pub install_cmd_sudo: String,
    /// `uninstall_cmd` prefixed with `sudo`, same rule as `install_cmd_sudo`.
    pub uninstall_cmd_sudo: String,
    pub docs: String,
    pub installed: bool,
    /// Whether the scheduled warm-up can drive this CLI: it has a known
    /// one-shot print/exec mode (`WARMUPS`). False greys the schedule toggle
    /// on the agent's card.
    pub warmup: bool,
}

fn find_spec(id: &str) -> Option<&'static AgentSpec> {
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

/// The registry's display name for an agent CLI's binary ("claude" → "Claude"),
/// or `None` for a command the registry does not list. It lets a surface say
/// which agent a tab runs without publishing the command itself — the phone's
/// tab list is one (`services::mobile_control::discovery`).
pub fn agent_label_for_bin(bin: &str) -> Option<&'static str> {
    AGENTS.iter().find(|a| a.bin == bin).map(|a| a.label)
}

/// The registry id of the agent whose binary is `bin` — what the settings'
/// `disabled_agents` list names (`SettingsSubPanels`' Manage CLIs switches).
pub fn agent_id_for_bin(bin: &str) -> Option<&'static str> {
    AGENTS.iter().find(|a| a.bin == bin).map(|a| a.id)
}

/// POSIX login-shell script used by the explicit "install on remote machine"
/// action. Agent ids resolve through the same registry as local installation,
/// so the frontend never supplies executable text. Probe before and after: a
/// repeat click is harmless, and installer success without a reachable binary
/// is reported as failure rather than as a false green result.
fn remote_install_script(spec: &AgentSpec) -> String {
    format!(
        "if command -v {bin} >/dev/null 2>&1; then \
           echo '{label} is already installed on this machine.'; \
           exit 0; \
         fi; \
         echo 'Installing {label} on this machine...'; \
         {install}; \
         install_status=$?; \
         if [ \"$install_status\" -ne 0 ]; then exit \"$install_status\"; fi; \
         hash -r 2>/dev/null || true; \
         if command -v {bin} >/dev/null 2>&1; then \
           echo '{label} installed successfully.'; \
         else \
           echo '{label} installer finished, but {bin} is not on the login-shell PATH.' >&2; \
           exit 127; \
         fi",
        bin = spec.bin,
        label = spec.label,
        install = spec.install_cmd,
    )
}

/// Install a known agent CLI on one configured global remote machine.
///
/// This is an explicit user gesture, so the SSH dial is declared foreground.
/// Authentication follows the same saved-password/key/ControlMaster path as
/// the global machine monitor. The command itself is registry-owned and runs in
/// the remote account's login shell, where npm/nvm and user install paths live.
#[tauri::command]
pub async fn install_agent_remote(agent_id: String, machine_id: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let spec = find_spec(&agent_id).ok_or_else(|| format!("unknown agent: {agent_id}"))?;
        let machine = crate::commands::global_machines::find_by_id(&machine_id)
            .ok_or_else(|| "remote machine is no longer configured".to_string())?;

        use crate::services::remote_credentials as creds;
        let _dial = crate::services::ssh_common::declared_dial(
            Some(false),
            &machine.user,
            &machine.host,
            machine.port,
        );
        let account = creds::ssh_account(&machine.user, &machine.host, machine.port);
        let password = creds::get(&account);
        let script = remote_install_script(spec);
        let quoted = crate::services::ssh_exec::shell_quote(&script);
        let command = format!("exec \"${{SHELL:-/bin/sh}}\" -lc {quoted}");
        crate::commands::ssh::run_ssh_auth(
            &machine.user,
            &machine.host,
            machine.port,
            password.as_deref(),
            &[&command],
        )
    })
    .await
    .map_err(|e| format!("remote agent installer task failed: {e}"))?
}

/// The same install, as a command line for a **visible terminal tab** instead of
/// a headless run.
///
/// `install_agent_remote` reports one string when it is over and nothing while it
/// runs, which is the wrong shape for the thing that actually goes wrong here: an
/// npm install on someone else's machine takes minutes, prints its progress, and
/// can stop on a question (a `sudo` password, an nvm shell that has to be sourced,
/// a host key). All of that is invisible headlessly, so a slow install and a hung
/// one look identical and a prompt is simply never answered.
///
/// Same registry-owned script (`remote_install_script`) and the same machine
/// lookup — the frontend supplies an agent id and a machine id, never executable
/// text. What differs is only the transport: `ssh -t` into the login shell, typed
/// into a root-scope shell tab, where the user reads the output and answers what
/// it asks.
///
/// Deliberately **not** registered with `credentials::note_minted_login`: this
/// command line does not stop at a login prompt, it goes on to run an installer,
/// so a "type my saved password" paste aimed at it could land in whatever prompt
/// the installer happens to be showing. The interactive login is still typed by
/// hand, or ridden for free off the shared ControlMaster.
#[tauri::command]
pub fn install_agent_remote_command(
    agent_id: String,
    machine_id: String,
) -> Result<String, String> {
    let spec = find_spec(&agent_id).ok_or_else(|| format!("unknown agent: {agent_id}"))?;
    let machine = crate::commands::global_machines::find_by_id(&machine_id)
        .ok_or_else(|| "remote machine is no longer configured".to_string())?;
    let script = remote_install_script(spec);
    let quoted = crate::services::ssh_exec::shell_quote(&script);
    let remote = format!("\"${{SHELL:-/bin/sh}}\" -lc {quoted}");
    crate::services::ssh_exec::interactive_exec_command(
        &machine.user,
        &machine.host,
        machine.port,
        &remote,
    )
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
fn resolve_spec_path(spec: &AgentSpec) -> Option<std::path::PathBuf> {
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
fn spec_is_installed(spec: &AgentSpec) -> bool {
    resolve_spec_path(spec).is_some()
}

/// True when the given agent (by id) is installed. Unknown ids return false.
#[tauri::command]
pub async fn agent_is_installed(id: String) -> bool {
    find_spec(&id).map(spec_is_installed).unwrap_or(false)
}

/// The oldest Node.js major the Manage Agents panel accepts without nudging:
/// the current LTS line. Agent CLIs track it closely — OpenClaw requires
/// 24.16+, and npm dependencies they pull in already reject Node 22 point
/// releases — so an older Node installs them with `EBADENGINE` warnings and
/// then fails at runtime. Raise this when a new line becomes LTS.
const NODE_MIN_MAJOR: u32 = 24;

/// What the Manage Agents Node helper needs to know about the host's Node.js.
#[derive(serde::Serialize)]
pub struct NodeRuntimeStatus {
    /// `npm` is reachable on Tabtivity's PATH.
    npm: bool,
    /// `node --version` (e.g. `v22.22.1`), or `None` when Node is absent or
    /// didn't answer.
    version: Option<String>,
    min_major: u32,
    /// Node answered with a version below `min_major`.
    too_old: bool,
}

/// Probe the host's Node.js for the Manage Agents panel. Most agent CLIs
/// install via `npm install -g …`, so a missing npm or a Node below
/// [`NODE_MIN_MAJOR`] surfaces the "install Node first" helper.
#[tauri::command]
pub async fn node_runtime_status() -> NodeRuntimeStatus {
    tauri::async_runtime::spawn_blocking(|| {
        let version = crate::paths::command_no_window("node")
            .arg("--version")
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .filter(|v| !v.is_empty());
        node_runtime_status_from(crate::paths::binary_on_path("npm"), version)
    })
    .await
    .unwrap_or(NodeRuntimeStatus {
        npm: true,
        version: None,
        min_major: NODE_MIN_MAJOR,
        too_old: false,
    })
}

/// Pure half of [`node_runtime_status`]. An unparseable version is never
/// "too old": the helper nudges only on a reading it understood.
fn node_runtime_status_from(npm: bool, version: Option<String>) -> NodeRuntimeStatus {
    let too_old = version
        .as_deref()
        .and_then(crate::paths::parse_node_version)
        .is_some_and(|(major, _, _)| major < NODE_MIN_MAJOR);
    NodeRuntimeStatus {
        npm,
        version,
        min_major: NODE_MIN_MAJOR,
        too_old,
    }
}

/// Probe arbitrary commands (user-defined custom agents, which aren't in the
/// built-in `AGENTS` registry) for install status, returning the subset present.
/// A bare name is looked up on `PATH`; a value containing a path separator is
/// checked as a file path so a custom agent pointed at a full path resolves too.
#[tauri::command]
pub async fn probe_binaries(bins: Vec<String>) -> Vec<String> {
    bins.into_iter()
        .filter(|b| {
            if b.contains('/') || b.contains('\\') {
                std::path::Path::new(b).exists()
            } else {
                crate::paths::binary_on_path(b)
            }
        })
        .collect()
}

/// Sync install probe for callers outside the agent registry (e.g. the local-
/// model drivers in `commands::ollama`). Looks `bin` up in the registry first so
/// it reuses the known user install locations; falls back to a bare PATH lookup
/// for binaries the registry doesn't track (e.g. Droid).
pub fn binary_is_installed(bin: &str) -> bool {
    AGENTS
        .iter()
        .find(|a| a.bin == bin)
        .map(spec_is_installed)
        .unwrap_or_else(|| crate::paths::binary_on_path(bin))
}

/// Whether Codex is actually running Tabtivity's `SessionStart` hook — the precise
/// path for resuming a tab's *current* conversation. Codex gates user-level hooks
/// behind a one-time trust approval (`/hooks`), and an untrusted one never fires,
/// silently; Tabtivity then falls back to guessing the session from Codex's rollout
/// logs (`services::codex_bind`). The UI reads this to offer the one-click fix.
#[tauri::command]
pub async fn codex_hook_status() -> crate::services::agent_session::CodexHookState {
    crate::services::agent_session::codex_hook_state()
}

/// `cmd` prefixed with `sudo`, for the one-click "run with elevated rights"
/// terminal fallback beside a plain `npm install -g`/`npm uninstall -g`
/// command — the actual EACCES case (a system-wide, root-owned npm global
/// directory, the default on a non-nvm Linux/macOS Node install). Empty for
/// anything else: `sudo` doesn't exist on Windows, and a curl/irm/pip
/// installer targets the user's own home directory, where running it as root
/// would create root-owned files there instead of fixing anything.
fn sudo_variant(cmd: &str) -> String {
    if !cfg!(windows)
        && (cmd.starts_with("npm install -g ") || cmd.starts_with("npm uninstall -g "))
    {
        format!("sudo {cmd}")
    } else {
        String::new()
    }
}

/// List every known agent CLI with its current installed status.
#[tauri::command]
pub async fn list_agents() -> Vec<AgentInfo> {
    AGENTS
        .iter()
        .map(|spec| {
            let (cmd, shell, shell_kind) = platform_install(spec);
            let install_cmd = cmd.unwrap_or("").to_string();
            let uninstall_cmd = cmd
                .and_then(npm_package_from_cmd)
                .map(|pkg| format!("npm uninstall -g {pkg}"))
                .unwrap_or_default();
            AgentInfo {
                id: spec.id.to_string(),
                label: spec.label.to_string(),
                bin: spec.bin.to_string(),
                install_cmd_sudo: sudo_variant(&install_cmd),
                install_cmd,
                shell,
                shell_kind: shell_kind.to_string(),
                uninstall_cmd_sudo: sudo_variant(&uninstall_cmd),
                uninstall_cmd,
                docs: spec.docs.to_string(),
                installed: spec_is_installed(spec),
                warmup: warmup_args(spec).is_some(),
            }
        })
        .collect()
}

/// Build the process that runs `spec`'s installer for the host OS, with stdout
/// and stderr merged in-shell (the read loop only drains stdout — merging in the
/// shell keeps interleaving right and avoids a stderr-fill deadlock).
///
/// Linux/macOS run `install_cmd` via `sh`. Windows runs `install_cmd_windows`
/// via PowerShell when the command is PowerShell-only (`irm … | iex`), else via
/// `cmd /C` — plain `npm`/`python` installs may chain with `&&`, which Windows
/// PowerShell 5.1 does not parse but cmd does.
fn installer_command(spec: &AgentSpec) -> Result<std::process::Command, String> {
    #[cfg(windows)]
    {
        let cmd_str = spec.install_cmd_windows.ok_or_else(|| {
            format!(
                "{} has no one-line Windows installer. See {}.",
                spec.label, spec.docs
            )
        })?;
        let mut c;
        if windows_shell_kind(cmd_str) == "powershell" {
            c = crate::paths::command_no_window("powershell");
            c.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command"])
                // Scriptblock-wrap so `2>&1` merges the whole pipeline's error
                // stream, not just the last command's.
                .arg(format!("& {{ {cmd_str} }} 2>&1"));
        } else {
            c = crate::paths::command_no_window("cmd");
            // cmd doesn't take an argv — hand it the raw line un-requoted.
            use std::os::windows::process::CommandExt;
            c.raw_arg(format!("/C {cmd_str} 2>&1"));
        }
        Ok(c)
    }
    #[cfg(not(windows))]
    {
        if !cfg!(any(target_os = "linux", target_os = "macos")) {
            return Err(format!(
                "Automatic install is not supported on this OS. See {}.",
                spec.docs
            ));
        }
        let mut c = crate::paths::command_no_window("sh");
        c.arg("-c").arg(format!("{} 2>&1", spec.install_cmd));
        // Into Tabtivity's own install home, never the user's
        // (`services::agent_install`).
        let root = crate::services::agent_install::install_root();
        std::fs::create_dir_all(&root).map_err(|e| format!("create {}: {e}", root.display()))?;
        c.envs(crate::services::agent_install::install_env());
        c.env("PATH", agent_install_path());
        Ok(c)
    }
}

/// PATH for an installer: the install home's launcher dirs first, so a
/// second installer of the same vendor finds the first's tools there.
#[cfg(not(windows))]
fn agent_install_path() -> std::ffi::OsString {
    let mut dirs = crate::services::agent_install::bin_dirs_in(&crate::storage::state_dir());
    if let Some(path) = crate::paths::effective_path() {
        dirs.extend(std::env::split_paths(&path));
    }
    std::env::join_paths(dirs).unwrap_or_default()
}

/// The command string to suggest re-running manually when the installer fails,
/// for the host OS.
fn manual_install_cmd(spec: &AgentSpec) -> &'static str {
    if cfg!(windows) {
        spec.install_cmd_windows.unwrap_or(spec.install_cmd)
    } else {
        spec.install_cmd
    }
}

/// Install an agent CLI via its official install command.
///
/// Streams the installer's combined stdout+stderr to the frontend line-by-line
/// via `agent-install-progress` events (`{ id, line }`) so the UI can show live
/// progress. Returns the install log on success, or the tail of the output on
/// failure. The post-install probe is the real source of truth.
#[tauri::command]
pub async fn install_agent(app: tauri::AppHandle, id: String) -> Result<String, String> {
    let spec = find_spec(&id).ok_or_else(|| format!("unknown agent: {id}"))?;

    if spec_is_installed(spec) {
        return Ok(format!("{} is already installed.", spec.label));
    }
    run_installer(app, spec)
}

/// Update an installed agent CLI: its official installer run again, which
/// fetches the newest release — into Tabtivity's install home, whose launcher
/// dirs come ahead of any host copy on PATH (`services::agent_install`). Same
/// `agent-install-progress` stream as [`install_agent`].
#[tauri::command]
pub async fn update_agent(app: tauri::AppHandle, id: String) -> Result<String, String> {
    let spec = find_spec(&id).ok_or_else(|| format!("unknown agent: {id}"))?;
    if !spec_is_installed(spec) {
        return Err(format!("{} is not installed.", spec.label));
    }
    run_installer(app, spec)
}

/// Run `spec`'s installer, streaming its output; the body of [`install_agent`]
/// and [`update_agent`].
fn run_installer(app: tauri::AppHandle, spec: &'static AgentSpec) -> Result<String, String> {
    use std::io::{BufRead, BufReader};
    use tauri::Emitter;

    let id_owned = spec.id.to_string();
    let emit = move |line: &str| {
        let _ = app.emit(
            "agent-install-progress",
            serde_json::json!({ "id": id_owned, "line": line }),
        );
    };
    emit(&format!("Starting {} installer…", spec.label));

    let mut lines: Vec<String> = Vec::new();
    let mut retried_npm_reify = false;
    let status = loop {
        let mut child = installer_command(spec)?
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("failed to launch installer: {e}"))?;

        if let Some(stdout) = child.stdout.take() {
            for line in BufReader::new(stdout).lines() {
                let line = match line {
                    Ok(l) => l,
                    Err(_) => break,
                };
                emit(&line);
                lines.push(line);
            }
        }

        let status = child
            .wait()
            .map_err(|e| format!("installer did not finish: {e}"))?;
        let output = lines.join("\n");
        if !status.success() && !retried_npm_reify && should_retry_npm_install(spec, &output) {
            retried_npm_reify = true;
            emit(
                "npm hit a stale reify staging directory; retrying the install once with a fresh staging path…",
            );
            continue;
        }
        break status;
    };
    let combined = lines.join("\n").trim().to_string();

    if !status.success() {
        let tail: Vec<&str> = combined.lines().rev().take(20).collect();
        let tail = tail.into_iter().rev().collect::<Vec<_>>().join("\n");
        let mut msg = if tail.is_empty() {
            format!(
                "installer exited unsuccessfully ({status}). Run `{}` in a terminal.",
                manual_install_cmd(spec)
            )
        } else {
            tail
        };
        // EACCES on a headless install is almost always a root-owned npm global
        // directory (system-wide Node, no nvm) — this process has no TTY to run
        // `sudo` through, so point at the terminal fallback that can.
        let sudo_cmd = sudo_variant(manual_install_cmd(spec));
        if !sudo_cmd.is_empty() && is_permission_error(&msg) {
            msg.push_str(&format!(
                "\n\nThis needs elevated rights (a system-wide npm global directory owned by \
                root — common when Node was installed system-wide rather than per-user). {app} \
                never prompts for a password itself: use the \"Run with sudo\" button below, or \
                run `{sudo_cmd}` yourself in a terminal.", app = crate::brand::DISPLAY
            ));
        }
        return Err(msg);
    }

    // The post-install check is the real source of truth.
    if !spec_is_installed(spec) {
        return Err(format!(
            "installer ran but `{}` is still not detected. It may need a new shell so \
            the install dir is on PATH — run `{}` in a terminal.\n\n{combined}",
            spec.bin,
            manual_install_cmd(spec)
        ));
    }

    emit("Done.");
    Ok(if combined.is_empty() {
        format!("{} installed.", spec.label)
    } else {
        combined
    })
}

/// The npm package spec an `npm install -g <pkg>` command installs, or `None`
/// for a curl/irm script installer (which has no npm package to remove — its
/// binary is deleted directly instead). Used so uninstall targets the exact
/// package the installer added rather than guessing from the agent id.
fn npm_package_from_cmd(cmd: &str) -> Option<&str> {
    cmd.trim()
        .strip_prefix("npm install -g ")?
        .split_whitespace()
        .next()
}

/// Run `cmd` to completion and return its combined stdout+stderr, trimmed.
/// `Err` carries that same output (or a status-only message when the command
/// produced none) on a non-zero exit.
fn run_capture(mut cmd: std::process::Command) -> Result<String, String> {
    let output = cmd
        .output()
        .map_err(|e| format!("failed to run command: {e}"))?;
    let mut combined = String::from_utf8_lossy(&output.stdout).into_owned();
    combined.push_str(&String::from_utf8_lossy(&output.stderr));
    let combined = combined.trim().to_string();
    if !output.status.success() {
        return Err(if combined.is_empty() {
            format!("command exited unsuccessfully ({})", output.status)
        } else {
            combined
        });
    }
    Ok(combined)
}

/// True when an error message reads as a permission/lock failure rather than
/// a genuine "nothing to remove" — `EACCES`/"permission denied" (a system-wide
/// npm global directory owned by root, the default on a non-nvm Linux Node
/// install) and `EPERM`/`EBUSY` (a file locked by a running process, common on
/// Windows). Used to swap in guidance pointing at a terminal Tabtivity can't
/// elevate on the user's behalf, instead of a bare stack of npm's own output.
fn is_permission_error(msg: &str) -> bool {
    let lower = msg.to_lowercase();
    ["eacces", "eperm", "ebusy", "permission denied"]
        .iter()
        .any(|needle| lower.contains(needle))
}

/// Whether npm failed while atomically swapping a global package directory.
///
/// npm's reifier retires the old package as a hidden sibling before it moves
/// the replacement into place.  If an earlier npm process was interrupted at
/// exactly that point, a stale `.package-random` directory can make the first
/// later install fail with `ENOTEMPTY` on `rename`.  The retired-name suffix is
/// fresh on every invocation, so one retry is safe and normally completes the
/// update without Tabtivity deleting anything from the user's global npm prefix.
fn is_npm_reify_rename_collision(msg: &str) -> bool {
    let lower = msg.to_lowercase();
    lower.contains("enotempty") && lower.contains("syscall rename")
}

/// Npm packages are the only installers that use Arborist/reify.  Keep the
/// retry narrow: a failed curl, PowerShell, or pip installer must retain its
/// original failure rather than being run a second time.
fn should_retry_npm_install(spec: &AgentSpec, output: &str) -> bool {
    npm_package_from_cmd(manual_install_cmd(spec)).is_some()
        && is_npm_reify_rename_collision(output)
}

/// Build the `npm uninstall -g <pkg>` process for the host OS (same shell
/// choice as the npm branch of `installer_command`: `cmd /C` on Windows, `sh -c`
/// elsewhere).
fn npm_uninstall_command(pkg: &str) -> std::process::Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut c = crate::paths::command_no_window("cmd");
        c.raw_arg(format!("/C npm uninstall -g {pkg} 2>&1"));
        c
    }
    #[cfg(not(windows))]
    {
        let mut c = crate::paths::command_no_window("sh");
        c.arg("-c").arg(format!("npm uninstall -g {pkg} 2>&1"));
        c
    }
}

/// Remove an installed agent CLI so it can be cleanly reinstalled — the
/// "Remove" action in Manage Agents, and the first half of "Reinstall".
///
/// An agent installed via `npm install -g <pkg>` is removed with the matching
/// `npm uninstall -g` — deleting just the PATH shim would leave the package
/// registered, so a subsequent install becomes a no-op re-link instead of a
/// fresh fetch. Every other agent (curl/irm script installers) drops exactly
/// the binary/shim `resolve_spec_path` found — enough to flip
/// `spec_is_installed` back to false and let the official installer run again
/// from scratch; any support files the installer left behind (an updater, a
/// packages cache) are none of Tabtivity's business to guess at and clean up.
#[tauri::command]
pub async fn uninstall_agent(id: String) -> Result<String, String> {
    let spec = find_spec(&id).ok_or_else(|| format!("unknown agent: {id}"))?;

    let cmd_for_platform = if cfg!(windows) {
        spec.install_cmd_windows.unwrap_or(spec.install_cmd)
    } else {
        spec.install_cmd
    };

    if let Some(pkg) = npm_package_from_cmd(cmd_for_platform) {
        if !spec_is_installed(spec) {
            return Ok(format!("{} is not installed.", spec.label));
        }
        let out = run_capture(npm_uninstall_command(pkg)).map_err(|e| {
            if is_permission_error(&e) {
                format!(
                    "Permission denied — this machine's npm global directory needs \
                    elevated rights (common when Node was installed system-wide rather \
                    than per-user). {app} never prompts for a password itself: run \
                    `npm uninstall -g {pkg}` yourself in an elevated terminal (or via \
                    the terminal button below).\n\n{e}", app = crate::brand::DISPLAY
                )
            } else {
                e
            }
        })?;
        if spec_is_installed(spec) {
            return Err(format!(
                "npm uninstall ran but `{}` is still detected on PATH.\n\n{out}",
                spec.bin
            ));
        }
        return Ok(if out.is_empty() {
            format!("{} removed.", spec.label)
        } else {
            out
        });
    }

    let path =
        resolve_spec_path(spec).ok_or_else(|| format!("{} is not installed.", spec.label))?;
    std::fs::remove_file(&path).map_err(|e| {
        let shown = path.display();
        if e.kind() == std::io::ErrorKind::PermissionDenied {
            format!(
                "Permission denied removing {shown} — it's owned by another user \
                (likely installed as root/admin). Remove it yourself in an elevated \
                terminal (`rm {shown}`, or the OS equivalent)."
            )
        } else {
            format!("failed to remove {shown}: {e}")
        }
    })?;
    Ok(format!("{} removed ({}).", spec.label, path.display()))
}

// ---------------------------------------------------------------------------
// Scheduled warm-up (Manage CLIs → Scheduled warm-up)
// ---------------------------------------------------------------------------

/// Per-agent argv prefix that runs the CLI **once, non-interactively**, on a
/// message passed as the final argument — Claude's `-p`, Codex's `exec`, and so
/// on. This is what the scheduled warm-up (`agent_warmup`) runs: the point of a
/// warm-up is to open the CLI's usage window, and its print/exec mode does that
/// as surely as a keystroke in a tab would while needing no PTY, no tab, no
/// project, and no window — it starts, answers once, and exits.
///
/// Only agents whose one-shot mode is documented are listed; one that is not
/// here cannot be scheduled (`AgentInfo::warmup` says so and the panel greys
/// the toggle). Guessing a flag would either open an interactive TUI on a
/// null stdin that then sits there forever, or run nothing at all while the
/// schedule looks armed — so an unknown recipe is a refusal, never a fallback.
///
/// The message goes **last** on purpose: a prefix ending in a value flag
/// (`goose run -t`) reads it as that flag's value, and one ending in a mode
/// (`opencode run`) reads it as the positional prompt. Keyed by the registry
/// `id`, so `find_spec` is the only lookup.
const WARMUPS: &[(&str, &[&str])] = &[
    ("claude", &["-p"]),
    ("codex", &["exec", "--skip-git-repo-check"]),
    ("gemini", &["-p"]),
    ("qwen", &["-p"]),
    ("copilot", &["-p"]),
    ("cursor-agent", &["-p"]),
    ("grok", &["-p"]),
    ("kimi", &["-p"]),
    ("vibe", &["-p"]),
    ("pi", &["-p"]),
    ("amp", &["-x"]),
    ("opencode", &["run"]),
    ("droid", &["exec"]),
    ("continue", &["-p"]),
    ("codebuddy", &["--print"]),
    ("goose", &["run", "-t"]),
    ("crush", &["run"]),
];

/// How long a warm-up process may live before it is killed. A print-mode run
/// answering "Test" takes seconds; the ceiling only exists so a CLI that hangs
/// on a first-run prompt (a trust dialog, a login) does not leave a process
/// behind per scheduled slot for as long as Tabtivity runs.
const WARMUP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10 * 60);

/// Longest message a warm-up may send. The frontend sends a fixed four-letter
/// word; the bound is here so this command can never be turned into "run an
/// agent on arbitrary text" by anything holding the IPC.
const WARMUP_MESSAGE_MAX: usize = 200;

/// The one-shot argv prefix for `spec`, or `None` when its print mode is not
/// known (see `WARMUPS`).
fn warmup_args(spec: &AgentSpec) -> Option<&'static [&'static str]> {
    WARMUPS
        .iter()
        .find(|(id, _)| *id == spec.id)
        .map(|(_, args)| *args)
}

/// The full argv (without the binary) of one warm-up run: the recipe, then the
/// message as its own final argument — never interpolated into a shell line.
fn warmup_argv(spec: &AgentSpec, message: &str) -> Option<Vec<String>> {
    let mut argv: Vec<String> = warmup_args(spec)?.iter().map(|s| s.to_string()).collect();
    argv.push(message.to_string());
    Some(argv)
}

/// Resolve an agent by registry `id` *or* binary name. The schedule is keyed by
/// whatever the settings panel handed it (the id), while the + menu's tab
/// specs speak in binaries (`agy`, `gpte`); accepting both means a schedule
/// written by either surface finds its agent.
fn find_spec_by_id_or_bin(agent: &str) -> Option<&'static AgentSpec> {
    find_spec(agent).or_else(|| AGENTS.iter().find(|a| a.bin == agent))
}

/// The folder every warm-up runs in. A print-mode agent records its session
/// under its working directory (Claude keys `~/.claude/projects/` by cwd), so
/// the run gets a directory of its own under Tabtivity's state dir rather than a
/// project's: it must not show up in any project's resume list, and it must
/// not be able to read anything a project holds. Nothing else lives here.
fn warmup_dir() -> Result<std::path::PathBuf, String> {
    let dir = crate::storage::state_dir().join("agent-cron");
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    Ok(dir)
}

/// What `agent_warmup` started, for the scheduler's log line.
#[derive(serde::Serialize)]
pub struct AgentWarmupLaunch {
    pub pid: u32,
    /// The command line as run, for display only (args are passed as argv).
    pub command: String,
    pub cwd: String,
}

/// Send one warm-up message to `agent` by running its CLI's print mode as a
/// detached background process — no terminal, no tab, no window.
///
/// Refuses (rather than improvises) when the agent is unknown, has no known
/// one-shot mode, or is not installed, so the scheduler can say which. The
/// process is reaped by a thread of its own: `std::process::Child` left
/// unwaited is a zombie on Unix, and the same thread enforces
/// `WARMUP_TIMEOUT`.
#[tauri::command]
pub async fn agent_warmup(agent: String, message: String) -> Result<AgentWarmupLaunch, String> {
    let message = message.trim().to_string();
    if message.is_empty() || message.len() > WARMUP_MESSAGE_MAX || message.contains(['\n', '\r']) {
        return Err("warm-up message must be one short line".into());
    }
    let spec = find_spec_by_id_or_bin(&agent).ok_or_else(|| format!("unknown agent: {agent}"))?;
    let argv = warmup_argv(spec, &message)
        .ok_or_else(|| format!("{} has no known non-interactive mode", spec.label))?;
    let path = resolve_spec_path(spec).ok_or_else(|| format!("{} is not installed", spec.label))?;
    let cwd = warmup_dir()?;

    let mut cmd = crate::paths::command_no_window(&path);
    cmd.args(&argv)
        .current_dir(&cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(unix)]
    {
        // Its own process group: a signal aimed at Tabtivity's terminal group (a
        // Ctrl+C in the launcher shell) must not take a half-sent warm-up with
        // it, and a warm-up must never be what a Ctrl+C reaches first.
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("cannot start {}: {e}", path.display()))?;
    let pid = child.id();
    let label = spec.label;
    std::thread::spawn(move || {
        let started = std::time::Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(_)) | Err(_) => break,
                Ok(None) if started.elapsed() > WARMUP_TIMEOUT => {
                    eprintln!("agent warm-up: {label} (pid {pid}) still running after {WARMUP_TIMEOUT:?}, killing");
                    let _ = child.kill();
                    let _ = child.wait();
                    break;
                }
                Ok(None) => std::thread::sleep(std::time::Duration::from_secs(1)),
            }
        }
    });

    Ok(AgentWarmupLaunch {
        pid,
        command: std::iter::once(path.display().to_string())
            .chain(argv)
            .collect::<Vec<_>>()
            .join(" "),
        cwd: cwd.display().to_string(),
    })
}

// ---------------------------------------------------------------------------
// Usage panel (the phone's agent status sheet)
// ---------------------------------------------------------------------------

/// What one agent CLI says about its own usage, plus enough identity for a
/// caller to render the answer *and* the refusals.
///
/// Not a `Result`: every branch here — unknown agent, no usage recipe, not
/// installed, CLI complained — is a thing the reader should see named, next to
/// the label of the agent it is about. Collapsing them into an error string
/// would leave the sheet with nothing to title itself with.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsageReport {
    /// Registry id the report is about (`claude`), as resolved from whatever
    /// the caller named the agent.
    pub agent: String,
    /// Display label (`Claude Code`), or the caller's own string for an agent
    /// the registry does not know.
    pub label: String,
    /// False when this CLI has no readable usage panel at all — the sheet says
    /// so rather than showing an empty one.
    pub supported: bool,
    /// The panel exactly as the CLI printed it. Parsed by the reader.
    pub raw: Option<String>,
    /// Why there is no panel, in the CLI's own words where it had any. For the
    /// desktop's own sheet; the phone is given `code` instead, because a CLI's
    /// stderr routinely names paths on this machine.
    pub error: Option<String>,
    /// The same reason as one fixed code: `unknown_agent`, `no_usage_readout`,
    /// `cli_not_installed`, `cli_failed`, `cli_timeout`, `cli_error`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    /// True when this answer came from the short-lived cache rather than from a
    /// fresh run, so a reader can tell a stale figure from a live one.
    pub cached: bool,
}

impl AgentUsageReport {
    fn refused(agent: &str, label: &str, supported: bool, code: &str, error: String) -> Self {
        Self {
            agent: agent.to_string(),
            label: label.to_string(),
            supported,
            raw: None,
            error: Some(error),
            code: Some(code.to_string()),
            cached: false,
        }
    }
}

/// Which model the tab launched as `agent` with launch id `session_id` last
/// answered with, read from the CLI's own transcript
/// (`services::agent_session::agent_session_model`). `None` when the agent
/// keeps no transcript Tabtivity reads, or it holds no answer yet — the Agents
/// view then shows no tag rather than a guessed one.
#[tauri::command]
pub async fn agent_tab_model(
    agent: String,
    project_id: Option<String>,
    session_id: String,
) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::services::agent_session::agent_session_model(
            &agent,
            project_id.as_deref(),
            &session_id,
        )
    })
    .await
    .ok()
    .flatten()
}

/// Whether the tab launched as `agent` with launch id `session_id` is
/// pursuing a `/goal`, read from the session's own record
/// (`services::agent_session::agent_session_goal`). `None` when the agent
/// keeps none Tabtivity reads; the GOAL mark then goes by the tab's footer.
#[tauri::command]
pub async fn agent_tab_goal(
    agent: String,
    project_id: Option<String>,
    session_id: String,
) -> Option<bool> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::services::agent_session::agent_session_goal(&agent, project_id.as_deref(), &session_id)
    })
    .await
    .ok()
    .flatten()
}

/// The last prompt the tab launched as `agent` with launch id `session_id`
/// was given, however it was submitted — typed in the terminal included —
/// read from the CLI's own transcript
/// (`services::agent_session::agent_session_last_prompt`). `None` when the
/// agent keeps no transcript Tabtivity reads, or it holds no prompt yet.
#[tauri::command]
pub async fn agent_tab_last_prompt(
    agent: String,
    project_id: Option<String>,
    session_id: String,
) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::services::agent_session::agent_session_last_prompt(
            &agent,
            project_id.as_deref(),
            &session_id,
        )
    })
    .await
    .ok()
    .flatten()
}

/// The newest prompts the tab launched as `agent` with launch id `session_id`
/// was given, each with the moment its transcript says it went — messages
/// sent while the agent was working included
/// (`services::agent_session::agent_session_recent_prompts`). What the prompt
/// chart adopts typed prompts from; empty when there is no transcript to read.
#[tauri::command]
pub async fn agent_tab_recent_prompts(
    agent: String,
    project_id: Option<String>,
    session_id: String,
) -> Vec<crate::services::agent_session::TranscriptPrompt> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::services::agent_session::agent_session_recent_prompts(
            &agent,
            project_id.as_deref(),
            &session_id,
        )
    })
    .await
    .unwrap_or_default()
}

/// The stored conversation of the tab launched as `agent` with launch id
/// `session_id` in `tab_dir` — its prompts and answers, read from the CLI's
/// own transcript or session store (`services::agent_transcript`) for the
/// phone's Focus view — or, with `subagent` (the handle on one of its `agent`
/// entries), the conversation of a subagent it spawned. `since` is the launch
/// moment (epoch ms) of a tab opened fresh rather than restored. `version` is
/// the fingerprint the caller last saw; a matching one is answered
/// `unchanged` without a parse. `local_model` marks a local-model tab, whose
/// OpenCode keeps its sessions in the scope's local-model home. Always
/// answers: an agent with no readable transcript comes back
/// `available: false` with the reason, never an error.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn agent_tab_transcript(
    agent: String,
    project_id: Option<String>,
    tab_dir: Option<String>,
    since: Option<i64>,
    session_id: String,
    subagent: Option<String>,
    version: Option<String>,
    limit: Option<usize>,
    local_model: Option<bool>,
) -> crate::services::agent_transcript::AgentTranscript {
    use crate::services::agent_transcript::{self, AgentTranscript, DEFAULT_LIMIT};
    tauri::async_runtime::spawn_blocking(move || {
        if local_model == Some(true) && agent == "opencode" {
            return agent_transcript::local_opencode_transcript(
                project_id.as_deref(),
                tab_dir.as_deref(),
                since,
                subagent.as_deref(),
                version.as_deref(),
                limit.unwrap_or(DEFAULT_LIMIT),
            );
        }
        agent_transcript::agent_session_transcript(
            &agent,
            project_id.as_deref(),
            tab_dir.as_deref(),
            since,
            &session_id,
            subagent.as_deref(),
            version.as_deref(),
            limit.unwrap_or(DEFAULT_LIMIT),
        )
    })
    .await
    .unwrap_or_else(|_| AgentTranscript::unavailable("read_failed"))
}

/// The files the tab's conversation — or `subagent`'s — changed, as the
/// diffs its CLI recorded (`services::agent_changes`): the desktop Reader's
/// Changes panel. Takes `agent_tab_transcript`'s arguments; never reaches
/// the phone.
#[tauri::command]
pub async fn agent_tab_changes(
    agent: String,
    project_id: Option<String>,
    tab_dir: Option<String>,
    since: Option<i64>,
    session_id: String,
    subagent: Option<String>,
    version: Option<String>,
    limit: Option<usize>,
) -> crate::services::agent_changes::AgentChanges {
    use crate::services::agent_changes::{self, AgentChanges, DEFAULT_LIMIT};
    tauri::async_runtime::spawn_blocking(move || {
        agent_changes::agent_session_changes(
            &agent,
            project_id.as_deref(),
            tab_dir.as_deref(),
            since,
            &session_id,
            subagent.as_deref(),
            version.as_deref(),
            limit.unwrap_or(DEFAULT_LIMIT),
        )
    })
    .await
    .unwrap_or_else(|_| AgentChanges::unavailable("read_failed"))
}

/// How to take back the tab's last `/clear` (`services::agent_session::undo_clear_plan`):
/// Claude types `/resume <id>` of the conversation it ended; Codex has its
/// record pointed back at that conversation and is relaunched onto it. `None`
/// once there is nothing to undo, or for an agent this does not know — the
/// window relaunches the other resumable agents on their own resume flag.
#[tauri::command]
pub async fn agent_tab_undo_clear(
    agent: String,
    project_id: Option<String>,
    session_id: String,
) -> Option<crate::services::agent_session::UndoClearPlan> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::services::agent_session::undo_clear_plan(&agent, project_id.as_deref(), &session_id)
    })
    .await
    .ok()
    .flatten()
}

/// Read `agent`'s own usage panel by running its CLI's print mode once.
///
/// Free in every sense that matters: the run is client-side (Claude's envelope
/// comes back with `num_turns: 0` and zero tokens), it needs no tab, no PTY and
/// no project, and a successful read is cached for `CACHE_TTL` so reopening the
/// sheet does not spawn anything. `refresh` skips the cache — that is what the
/// sheet's own refresh means.
#[tauri::command]
pub async fn agent_usage(agent: String, refresh: Option<bool>) -> AgentUsageReport {
    use crate::services::agent_usage as usage;

    let Some(spec) = find_spec_by_id_or_bin(&agent) else {
        return AgentUsageReport::refused(&agent, &agent, false, "unknown_agent", format!("unknown agent: {agent}"));
    };
    let Some(argv) = usage::usage_argv(spec.id) else {
        return AgentUsageReport::refused(
            spec.id,
            spec.label,
            false,
            "no_usage_readout",
            format!("{} has no usage readout that can be read without a tab", spec.label),
        );
    };
    // A refresh still consults the cache, at a much shorter window: it means
    // "ask the CLI again", not "spawn one process per tap".
    let window = if refresh.unwrap_or(false) {
        usage::REFRESH_FLOOR
    } else {
        usage::CACHE_TTL
    };
    if let Some(raw) = usage::cached_within(spec.id, window) {
        return AgentUsageReport {
            agent: spec.id.to_string(),
            label: spec.label.to_string(),
            supported: true,
            raw: Some(raw),
            error: None,
            code: None,
            cached: true,
        };
    }
    usage::forget(spec.id);
    let Some(path) = resolve_spec_path(spec) else {
        return AgentUsageReport::refused(
            spec.id,
            spec.label,
            true,
            "cli_not_installed",
            format!("{} is not installed", spec.label),
        );
    };
    // The state dir, not a project: a usage window is per account, and running
    // in a project folder would put a CLI's first-run trust prompt in the way of
    // a question that has nothing to do with that folder.
    let cwd = match warmup_dir() {
        Ok(dir) => dir,
        Err(error) => return AgentUsageReport::refused(spec.id, spec.label, true, "cli_failed", error),
    };

    let mut cmd = tokio::process::Command::from(crate::paths::command_no_window(&path));
    cmd.args(&argv)
        .current_dir(&cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    {
        // Its own process group, for the reason the warm-up spawn gives: a
        // Ctrl+C in Tabtivity's launcher shell must not be what reaches this first.
        cmd.process_group(0);
    }
    let output = match tokio::time::timeout(usage::USAGE_TIMEOUT, async {
        cmd.spawn()
            .map_err(|e| format!("cannot start {}: {e}", path.display()))?
            .wait_with_output()
            .await
            .map_err(|e| format!("{} did not run: {e}", spec.label))
    })
    .await
    {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => return AgentUsageReport::refused(spec.id, spec.label, true, "cli_failed", error),
        // `kill_on_drop` reaps the child as the future is dropped here.
        Err(_) => {
            return AgentUsageReport::refused(
                spec.id,
                spec.label,
                true,
                "cli_timeout",
                format!(
                    "{} did not answer within {}s",
                    spec.label,
                    usage::USAGE_TIMEOUT.as_secs()
                ),
            )
        }
    };
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    match usage::report_text(&stdout, &stderr, output.status.code()) {
        Ok(raw) => {
            usage::remember(spec.id, &raw);
            AgentUsageReport {
                agent: spec.id.to_string(),
                label: spec.label.to_string(),
                supported: true,
                raw: Some(raw),
                error: None,
                code: None,
                cached: false,
            }
        }
        Err(error) => AgentUsageReport::refused(spec.id, spec.label, true, "cli_error", error),
    }
}

/// Ask one agent CLI what version it is, once.
///
/// Same spawn shape as the usage read above and for the same reasons: argv
/// (never a shell line), stdin closed so a CLI that ignores `--version` and
/// opens its TUI has nothing to read, its own process group, `kill_on_drop` so
/// the timeout actually reaps, and the state dir as cwd so no project folder's
/// first-run trust prompt gets in the way of a question that has nothing to do
/// with that folder.
async fn probe_agent_version(
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

/// What version of each *installed* agent CLI is on this machine, against the
/// releases Tabtivity's flags and parsers were verified with.
///
/// Reported, never enforced: nothing here updates a CLI or refuses to launch
/// one. It exists so "somebody else's CLI moved under us" is a line in Manage
/// Agents (and in `cargo run --example agent_versions`) instead of a mystery
/// the next time a TUI parses wrong.
///
/// Only installed agents are probed, at most once a day per unchanged
/// executable (`PROBE_TTL`), all of them concurrently. `refresh` skips the
/// cache; that is what the panel's own re-check means.
#[tauri::command]
pub async fn agent_versions(
    refresh: Option<bool>,
) -> Vec<crate::services::agent_versions::VersionReport> {
    use crate::services::agent_versions as versions;

    let refresh = refresh.unwrap_or(false);
    let store = versions::load();
    let mut ready: std::collections::HashMap<&str, versions::VersionReport> =
        std::collections::HashMap::new();
    let mut probes = Vec::new();

    for spec in AGENTS {
        let Some(path) = resolve_spec_path(spec) else {
            continue;
        };
        // Installed, but nobody has checked what it answers: say so rather than
        // guessing a flag at a binary that may open a TUI instead.
        if !versions::is_supported(spec.id) {
            ready.insert(
                spec.id,
                versions::VersionReport::unread(spec.id, spec.label, true, None),
            );
            continue;
        }
        if !refresh {
            if let Some(seen) = store
                .get(spec.id)
                .filter(|seen| versions::fresh_for_path(seen, versions::PROBE_TTL, &path))
            {
                ready.insert(
                    spec.id,
                    versions::VersionReport::from_seen(spec.id, spec.label, seen, true),
                );
                continue;
            }
        }
        // `AGENTS` is a const slice in static memory, so the borrow outlives
        // the spawned task — spelled out because that is what makes it
        // spawnable rather than a lifetime that happens to work.
        let spec: &'static AgentSpec = spec;
        probes.push(tokio::spawn(async move {
            let result = probe_agent_version(spec, &path).await;
            (spec, path, result)
        }));
    }

    for probe in probes {
        let Ok((spec, path, result)) = probe.await else {
            continue;
        };
        let seen = versions::remember(spec.id, result, &path);
        ready.insert(
            spec.id,
            versions::VersionReport::from_seen(spec.id, spec.label, &seen, false),
        );
    }

    // Registry order, so the rows line up with the Manage Agents list.
    AGENTS
        .iter()
        .filter_map(|spec| ready.remove(spec.id))
        .collect()
}

/// One installed CLI against its newest published release
/// (`services::agent_latest`).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUpdateReport {
    agent: String,
    /// The installed version, when it could be read: the CLI's `--version`
    /// recipe, else the package metadata beside its executable.
    current: Option<String>,
    /// The newest published version.
    latest: Option<String>,
    /// Both versions read and `latest` genuinely newer — never `latest` alone.
    update_available: bool,
    /// Whether a registry is known for this CLI at all.
    checkable: bool,
    error: Option<String>,
}

/// Ask installed CLIs' registries for their newest release — each Manage CLIs
/// card's "Check for update" (`id`), or every installed CLI when `id` is
/// `None`; the agent twin of `check_ollama_updates`. Only on a click: one
/// request per CLI that has a known registry, all at once, each settled on its
/// own so one registry being down costs only its row. The installed versions
/// are re-read first, so a CLI that updated itself since the last probe is not
/// offered the update it already has.
#[tauri::command]
pub async fn check_agent_updates(id: Option<String>) -> Vec<AgentUpdateReport> {
    use crate::services::{agent_latest, agent_versions};

    let mut probed: std::collections::HashMap<String, Option<String>> = agent_versions(Some(true))
        .await
        .into_iter()
        .map(|report| (report.agent, report.version))
        .collect();
    let mut checks = Vec::new();
    for spec in AGENTS.iter().filter(|spec| id.as_deref().is_none_or(|id| id == spec.id)) {
        let Some(path) = resolve_spec_path(spec) else {
            continue;
        };
        let source = agent_latest::source_for(spec.id);
        let current = probed
            .remove(spec.id)
            .flatten()
            .or_else(|| source.and_then(|source| agent_latest::installed_version_near(&path, source)));
        checks.push(tokio::spawn(async move {
            let latest = match source {
                Some(source) => Some(agent_latest::fetch_latest(source).await),
                None => None,
            };
            (spec.id, current, latest)
        }));
    }

    let mut reports = Vec::new();
    for check in checks {
        let Ok((agent, current, latest)) = check.await else {
            continue;
        };
        let (latest, error) = match latest {
            Some(Ok(version)) => (Some(version), None),
            Some(Err(error)) => (None, Some(error)),
            None => (None, None),
        };
        let update_available = matches!(
            (&current, &latest),
            (Some(current), Some(latest))
                if agent_versions::version_cmp(latest, current) == std::cmp::Ordering::Greater
        );
        reports.push(AgentUpdateReport {
            agent: agent.to_string(),
            checkable: agent_latest::source_for(agent).is_some(),
            current,
            latest,
            update_available,
            error,
        });
    }
    reports
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

/// Answer `check` from the version store's entry for `agent`, refreshing a
/// missing or day-old entry in the background (one probe per agent at a time).
fn host_agent_version_says(
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
            tauri::async_runtime::spawn(async move {
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

/// Stop reminding the user that `agent`'s installed version has moved past what
/// Tabtivity was verified against.
///
/// Keyed by the version, not by a flag: the notice comes back on the *next*
/// release, which is the only time it has something new to say.
#[tauri::command]
pub async fn dismiss_agent_version(agent: String, version: String) -> Result<(), String> {
    let spec = find_spec_by_id_or_bin(&agent).ok_or_else(|| format!("unknown agent: {agent}"))?;
    if version.trim().is_empty() {
        return Err("no version to dismiss".into());
    }
    crate::services::agent_versions::dismiss(spec.id, version.trim());
    Ok(())
}

/// Whether Claude already trusts `cwd`, i.e. it will NOT open its "Is this a
/// project you created or one you trust?" dialog there.
///
/// The caller is the tab's auto-typed `/rename <project>` line, which is
/// submitted with a bare Enter. On that dialog, Enter confirms the highlighted
/// default — `No, exit` — so an agent tab opened in an untrusted folder killed
/// itself on launch. Answering the question is the user's alone; Tabtivity only
/// asks whether the question is coming, and stays quiet when it is.
/// Off the main thread: a `.claude.json` carries a scope's prompt history
/// and grows into the megabytes, and this is asked once per new Claude tab —
/// parsing it inline would jank the window at launch. `sandbox` and
/// `local_only` are accepted for older callers; the answer is the scope
/// home's either way (`services::agent_home`).
#[tauri::command]
pub async fn claude_folder_trusted(
    cwd: String,
    project_id: Option<String>,
    sandbox: Option<bool>,
    local_only: Option<bool>,
) -> bool {
    let _ = (sandbox, local_only);
    tauri::async_runtime::spawn_blocking(move || {
        crate::services::sandbox::claude_folder_trusted(&cwd, project_id.as_deref())
    })
    .await
    .unwrap_or(false)
}

/// Every CLI's shared login as the Manage CLIs panel shows it
/// (`services::agent_auth`). Never a token.
#[tauri::command]
pub async fn agent_logins() -> Vec<crate::services::agent_auth::LoginStatus> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut logins = crate::services::agent_auth::status();
        // Which CLIs start on a stored API key: read here, not in
        // `agent_auth::status_in`, whose tests stay keyring-free. With no CLI
        // switched on this reads no keychain entry at all.
        let ready = crate::services::agent_api_keys::ready_clis();
        // Of those, the ones whose provider is out of budget this month (or
        // has no limit): their keyed tabs are refused.
        let blocked = crate::services::agent_api_keys::budget_blocked_clis(&ready);
        for login in &mut logins {
            login.api_key = ready.contains(&login.id.as_str());
            login.api_budget_reached = blocked.contains(&login.id.as_str());
        }
        logins
    })
    .await
    .unwrap_or_default()
}

/// The provider API keys and the CLIs switched on for them
/// (`services::agent_api_keys`), for Manage CLIs. Never a key.
#[tauri::command]
pub async fn agent_api_keys_status() -> Result<crate::services::agent_api_keys::ApiKeyStatus, String> {
    tauri::async_runtime::spawn_blocking(crate::services::agent_api_keys::status)
        .await
        .map_err(|e| e.to_string())
}

fn api_key_provider(provider: &str) -> Result<crate::services::agent_api_keys::Provider, String> {
    crate::services::agent_api_keys::Provider::from_id(provider)
        .ok_or_else(|| format!("unknown API key provider: {provider}"))
}

/// Save `provider`'s API key in the OS keychain. A locked or missing keyring
/// refuses (its own message); there is no other place a key is kept. A key is
/// only saved beside a monthly spending limit (`Settings::agent_api_limits`,
/// written first by Manage CLIs): refused without one.
#[tauri::command]
pub async fn agent_api_key_set(provider: String, key: String) -> Result<(), String> {
    let provider = api_key_provider(&provider)?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::services::agent_api_keys::require_limit(provider)?;
        crate::services::agent_api_keys::set_key(provider, Some(key.trim()))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Remove `provider`'s API key from the OS keychain.
#[tauri::command]
pub async fn agent_api_key_clear(provider: String) -> Result<(), String> {
    let provider = api_key_provider(&provider)?;
    tauri::async_runtime::spawn_blocking(move || crate::services::agent_api_keys::set_key(provider, None))
        .await
        .map_err(|e| e.to_string())?
}

/// Copy this computer's login files for `id` into Tabtivity's store — the one
/// safe direction — and link them into every agent home. Returns how many
/// files were taken.
#[tauri::command]
pub async fn agent_login_import(id: String) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || crate::services::agent_auth::import_from_user_home(&id))
        .await
        .map_err(|e| e.to_string())?
}

/// Forget the shared login of `id` everywhere.
#[tauri::command]
pub async fn agent_login_sign_out(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || crate::services::agent_auth::sign_out(&id))
        .await
        .map_err(|e| e.to_string())?
}

/// The Tabtivity-wide agent config layer (`services::agent_global`): where it is
/// and how many files it holds.
#[tauri::command]
pub async fn agent_global_status() -> Result<crate::services::agent_global::LayerStatus, String> {
    tauri::async_runtime::spawn_blocking(crate::services::agent_global::status)
        .await
        .map_err(|e| e.to_string())
}

/// Fill the Tabtivity-wide layer from the user's own `~/.claude`, `~/.codex` and
/// `~/.gemini`; every agent home picks it up at its next tab start.
#[tauri::command]
pub async fn agent_global_import() -> Result<crate::services::agent_global::ImportReport, String> {
    tauri::async_runtime::spawn_blocking(crate::services::agent_global::import_from_user_home)
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// The Manage CLIs switch for Codex auto-review in the Tabtivity-wide layer;
/// every Codex tab picks it up at its next start.
#[tauri::command]
pub async fn agent_global_set_codex_auto_review(enabled: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || crate::services::agent_global::set_codex_auto_review(enabled))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// Open the Tabtivity-wide layer's folder in the file manager, creating it first.
#[tauri::command]
pub async fn agent_global_open() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| {
        let dir = crate::services::agent_global::ensure_dir().map_err(|e| e.to_string())?;
        opener::open(&dir).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_warmup_recipe_names_a_registry_agent_and_puts_the_message_last() {
        for (id, args) in WARMUPS {
            let spec = find_spec(id).unwrap_or_else(|| panic!("warm-up recipe for unknown agent {id}"));
            let argv = warmup_argv(spec, "Test").expect("recipe resolves");
            assert_eq!(argv.len(), args.len() + 1, "{id}");
            assert_eq!(argv.last().map(String::as_str), Some("Test"), "{id}");
            assert_eq!(&argv[..args.len()], *args, "{id}");
            assert!(args.iter().all(|a| !a.is_empty()), "{id}: empty arg");
        }
    }

    #[test]
    fn warmup_is_refused_for_agents_without_a_known_print_mode() {
        let aider = find_spec("aider").expect("aider in registry");
        assert!(warmup_args(aider).is_none());
        assert!(warmup_argv(aider, "Test").is_none());
        let claude = find_spec("claude").expect("claude in registry");
        assert_eq!(
            warmup_argv(claude, "Test").unwrap(),
            vec!["-p".to_string(), "Test".to_string()]
        );
        assert_eq!(
            warmup_argv(find_spec("codex").unwrap(), "Test").unwrap(),
            vec!["exec", "--skip-git-repo-check", "Test"]
        );
    }

    #[test]
    fn warmup_resolves_an_agent_by_id_or_by_binary() {
        assert_eq!(find_spec_by_id_or_bin("antigravity").map(|s| s.id), Some("antigravity"));
        assert_eq!(find_spec_by_id_or_bin("agy").map(|s| s.id), Some("antigravity"));
        assert_eq!(find_spec_by_id_or_bin("claude").map(|s| s.id), Some("claude"));
        assert!(find_spec_by_id_or_bin("not-an-agent").is_none());
    }

    #[test]
    fn windows_shell_flags_powershell_only_commands() {
        // `irm … | iex` is PowerShell syntax.
        assert_eq!(
            windows_shell("irm https://claude.ai/install.ps1 | iex"),
            "PowerShell"
        );
        // npm/python installs run in either shell.
        assert_eq!(
            windows_shell("npm install -g @google/gemini-cli"),
            "PowerShell or Command Prompt"
        );
    }

    #[test]
    fn claude_has_a_powershell_windows_installer() {
        let claude = find_spec("claude").expect("claude in registry");
        let win = claude
            .install_cmd_windows
            .expect("claude has a Windows installer");
        assert!(
            win.contains("irm"),
            "expected the PowerShell `irm` installer"
        );
        assert!(
            !win.contains("curl"),
            "Windows installer must not use curl/bash"
        );
    }

    #[test]
    fn antigravity_uses_the_official_native_installers() {
        let antigravity = find_spec("antigravity").expect("antigravity in registry");
        assert_eq!(antigravity.bin, "agy");
        assert_eq!(
            antigravity.install_cmd,
            "curl -fsSL https://antigravity.google/cli/install.sh | bash"
        );
        assert_eq!(
            antigravity.install_cmd_windows,
            Some("irm https://antigravity.google/cli/install.ps1 | iex")
        );
        assert!(antigravity.extra_paths.contains(&".local/bin/agy"));
        assert!(antigravity
            .extra_paths
            .contains(&"AppData/Local/agy/bin/agy"));
    }

    #[test]
    fn expanded_agent_registry_keeps_official_commands_and_binaries() {
        let expected = [
            (
                "kiro",
                "kiro-cli",
                "curl -fsSL https://cli.kiro.dev/install | bash",
            ),
            ("cline", "cline", "npm install -g cline"),
            ("goose", "goose", "https://github.com/aaif-goose/goose/"),
            ("pi", "pi", "npm install -g @mariozechner/pi-coding-agent"),
            ("plandex", "plandex", "https://plandex.ai/install.sh"),
            ("swe-agent", "sweagent", "pip install swe-agent"),
            ("mini-swe-agent", "mini", "pip install mini-swe-agent"),
            ("droid", "droid", "https://app.factory.ai/cli"),
            ("auggie", "auggie", "npm install -g @augmentcode/auggie"),
            ("kilo", "kilo", "https://kilo.ai/cli/install"),
            ("continue", "cn", "npm install -g @continuedev/cli"),
            ("junie", "junie", "https://junie.jetbrains.com/install.sh"),
            (
                "codebuddy",
                "codebuddy",
                "npm install -g @tencent-ai/codebuddy-code",
            ),
            ("crush", "crush", "npm install -g @charmland/crush"),
            ("amp", "amp", "npm install -g @ampcode/cli"),
            ("grok", "grok", "https://x.ai/cli/install.sh"),
            ("kimi", "kimi", "https://code.kimi.com/kimi-code/install.sh"),
            ("qoder", "qoder", "https://qoder.com/install"),
            ("muse", "muse", "https://dev.meta.ai/install.sh"),
        ];
        for (id, bin, install_fragment) in expected {
            let spec = find_spec(id).unwrap_or_else(|| panic!("{id} missing from registry"));
            assert_eq!(spec.bin, bin, "{id} has the wrong executable");
            assert!(
                spec.install_cmd.contains(install_fragment),
                "{id} no longer uses its official installer"
            );
        }
    }

    #[test]
    fn aider_uses_the_official_uv_installers_without_requiring_python() {
        let aider = find_spec("aider").expect("aider in registry");
        assert_eq!(
            aider.install_cmd,
            "curl -LsSf https://aider.chat/install.sh | sh"
        );
        assert_eq!(
            aider.install_cmd_windows,
            Some("irm https://aider.chat/install.ps1 | iex")
        );
        assert!(!aider.install_cmd.contains("python"));
        assert!(aider.extra_paths.contains(&".local/bin/aider"));
    }

    #[test]
    fn npm_package_from_cmd_extracts_the_package_spec() {
        assert_eq!(
            npm_package_from_cmd("npm install -g @google/gemini-cli"),
            Some("@google/gemini-cli")
        );
        assert_eq!(
            npm_package_from_cmd("npm install -g opencode-ai"),
            Some("opencode-ai")
        );
        // curl/irm script installers have no npm package to uninstall.
        assert_eq!(
            npm_package_from_cmd("curl -fsSL https://claude.ai/install.sh | bash"),
            None
        );
        assert_eq!(
            npm_package_from_cmd("irm https://chatgpt.com/codex/install.ps1 | iex"),
            None
        );
    }

    #[test]
    fn is_permission_error_matches_npm_and_windows_lock_failures() {
        // Real npm output, old and new formats, both cases.
        assert!(is_permission_error(
            "npm ERR! code EACCES\nnpm ERR! syscall rename"
        ));
        assert!(is_permission_error("npm error code EACCES"));
        assert!(is_permission_error("Access is denied. (os error 5) EPERM"));
        assert!(is_permission_error(
            "resource busy or locked, rename 'x' EBUSY"
        ));
        assert!(is_permission_error("Permission denied (os error 13)"));
        assert!(!is_permission_error("npm ERR! 404 Not Found"));
        assert!(!is_permission_error(
            "command exited unsuccessfully (exit status: 1)"
        ));
    }

    #[test]
    fn npm_reify_rename_collision_retries_npm_installers_only() {
        let collision = "npm ERR! code ENOTEMPTY\n\
            npm ERR! syscall rename\n\
            npm ERR! path /usr/local/lib/node_modules/@google/gemini-cli\n\
            npm ERR! dest /usr/local/lib/node_modules/@google/.gemini-cli-0qPrCG8o";
        assert!(is_npm_reify_rename_collision(collision));
        assert!(!is_npm_reify_rename_collision("npm ERR! code ENOTEMPTY"));

        let gemini = find_spec("gemini").expect("gemini in registry");
        let claude = find_spec("claude").expect("claude in registry");
        assert!(should_retry_npm_install(gemini, collision));
        assert!(!should_retry_npm_install(claude, collision));
    }

    #[test]
    fn node_below_the_lts_floor_is_too_old() {
        let status = |v: Option<&str>| node_runtime_status_from(true, v.map(str::to_string));
        assert!(status(Some("v22.22.1")).too_old);
        assert!(!status(Some(&format!("v{NODE_MIN_MAJOR}.0.0"))).too_old);
        assert!(!status(Some("v26.1.0")).too_old);
        // Absent or unreadable: nothing to say about the version.
        assert!(!status(None).too_old);
        assert!(!status(Some("garbage")).too_old);
        assert_eq!(status(None).min_major, NODE_MIN_MAJOR);
    }

    #[test]
    fn sudo_variant_only_covers_plain_npm_commands() {
        assert_eq!(
            sudo_variant("npm install -g @xai-official/grok"),
            if cfg!(windows) {
                String::new()
            } else {
                "sudo npm install -g @xai-official/grok".to_string()
            }
        );
        assert_eq!(
            sudo_variant("npm uninstall -g @xai-official/grok"),
            if cfg!(windows) {
                String::new()
            } else {
                "sudo npm uninstall -g @xai-official/grok".to_string()
            }
        );
        // A curl/irm/pip installer targets the user's own home directory —
        // running it as root would create root-owned files there instead of
        // fixing anything, so it must never get a sudo variant.
        assert_eq!(
            sudo_variant("curl -fsSL https://claude.ai/install.sh | bash"),
            ""
        );
        assert_eq!(
            sudo_variant("curl -LsSf https://aider.chat/install.sh | sh"),
            ""
        );
        assert_eq!(sudo_variant(""), "");
    }

    #[test]
    fn uninstall_cmd_is_populated_only_for_npm_installed_agents() {
        // Gemini installs via npm on every platform, so its uninstall command
        // must be derivable regardless of host OS this test runs on.
        let gemini = find_spec("gemini").expect("gemini in registry");
        let (cmd, _, _) = platform_install(gemini);
        let uninstall = cmd
            .and_then(npm_package_from_cmd)
            .map(|pkg| format!("npm uninstall -g {pkg}"));
        assert_eq!(
            uninstall.as_deref(),
            Some("npm uninstall -g @google/gemini-cli")
        );

        // Claude's curl/irm script installer has no npm package, so no
        // uninstall command should be synthesized for it.
        let claude = find_spec("claude").expect("claude in registry");
        let (cmd, _, _) = platform_install(claude);
        assert!(cmd.and_then(npm_package_from_cmd).is_none());
    }

    #[test]
    fn every_npm_installed_agent_resolves_to_its_package() {
        // Every agent whose install command is npm-based must round-trip
        // through `npm_package_from_cmd`, since `uninstall_agent` relies on it
        // to target `npm uninstall -g` rather than deleting a shim.
        for spec in AGENTS {
            for cmd in [Some(spec.install_cmd), spec.install_cmd_windows]
                .into_iter()
                .flatten()
            {
                if cmd.trim_start().starts_with("npm install -g") {
                    assert!(
                        npm_package_from_cmd(cmd).is_some(),
                        "{}'s npm install command did not parse: {cmd}",
                        spec.id
                    );
                }
            }
        }
    }

    #[test]
    fn every_agent_serves_a_shell_label() {
        for spec in AGENTS {
            let (_cmd, shell, shell_kind) = platform_install(spec);
            assert!(!shell.is_empty(), "{} has no shell label", spec.id);
            assert!(
                matches!(shell_kind, "bash" | "powershell" | "default"),
                "{} has an invalid shell kind",
                spec.id
            );
        }
    }

    #[test]
    fn remote_install_uses_the_registry_command_and_probes_both_sides() {
        let gemini = find_spec("gemini").expect("gemini in registry");
        let script = remote_install_script(gemini);
        assert!(script.contains("npm install -g @google/gemini-cli"));
        assert_eq!(script.matches("command -v gemini").count(), 2);
        assert!(script.contains("hash -r"));
        assert!(script.contains("exit 127"));
    }

    /// The terminal variant runs the SAME script over an interactive ssh: same
    /// probe-install-probe text, a remote PTY (`-t`) so the installer's prompts
    /// are answerable, and the script carried as one shell-quoted argument.
    #[test]
    fn remote_install_terminal_command_runs_the_same_script_on_a_pty() {
        let gemini = find_spec("gemini").expect("gemini in registry");
        let script = remote_install_script(gemini);
        let quoted = crate::services::ssh_exec::shell_quote(&script);
        let remote = format!("\"${{SHELL:-/bin/sh}}\" -lc {quoted}");
        let cmd = crate::services::ssh_exec::interactive_exec_command(
            &Some("alice".to_string()),
            "host.example",
            Some(2222),
            &remote,
        )
        .expect("command builds");
        assert!(cmd.starts_with("'ssh' "));
        assert!(cmd.contains("'alice@host.example'"));
        assert!(cmd.contains("'-p' '2222'"));
        assert!(cmd.contains("'-t'"));
        // The whole remote command is one argv item, so the local shell can't
        // re-split the installer script on its spaces.
        assert!(cmd.contains("npm install -g @google/gemini-cli"));
        assert!(cmd.trim_end().ends_with('\''));
    }

    /// **Tripwire: the two install tables must not drift** (#28b).
    ///
    /// `services::remote_agents::RECIPES` restates a few of these rows as
    /// fragments of a remote shell script — it is a `services/` module and cannot
    /// reach this one — and the pair had already drifted once: this registry moved
    /// Claude to the official `install.sh` while the remote bootstrap went on
    /// running `npm install -g @anthropic-ai/claude-code`, so the same agent name
    /// installed two different binaries depending on which machine it landed on.
    ///
    /// Nothing forces the tables to agree at compile time, so it is asserted here:
    /// every remote recipe must name an agent this registry knows, with the same
    /// Unix install command. Adding an agent stays a one-row edit; adding it in
    /// only one of the two places is what fails.
    #[test]
    fn every_remote_recipe_matches_its_registry_row() {
        for recipe in crate::services::remote_agents::recipes() {
            let spec = AGENTS
                .iter()
                .find(|a| a.bin == recipe.bin)
                .unwrap_or_else(|| panic!("remote recipe '{}' names no known agent", recipe.bin));
            assert_eq!(
                spec.install_cmd, recipe.install,
                "'{}' installs differently locally and remotely",
                recipe.bin
            );
        }
    }

    /// Windows one-click install picks its interpreter per command: PowerShell
    /// for `irm … | iex`, `cmd /C` for plain npm/python lines (which may chain
    /// with `&&` — cmd parses that, Windows PowerShell 5.1 does not), and a
    /// clear error when there is no one-line Windows installer at all.
    #[test]
    fn every_update_source_names_a_registry_agent() {
        for (id, _) in crate::services::agent_latest::SOURCES {
            assert!(find_spec(id).is_some(), "agent_latest::SOURCES names unknown agent {id}");
        }
    }

    #[test]
    fn an_npm_installed_agent_checks_the_package_it_installs() {
        use crate::services::agent_latest::{source_for, Source};
        for spec in AGENTS {
            if let Some(pkg) = npm_package_from_cmd(spec.install_cmd) {
                if let Some(source) = source_for(spec.id) {
                    assert_eq!(source, Source::Npm(pkg), "{}", spec.id);
                }
            }
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_installer_command_picks_interpreter_per_command() {
        use std::ffi::OsStr;
        let claude = find_spec("claude").unwrap(); // irm | iex
        assert_eq!(
            installer_command(claude).unwrap().get_program(),
            OsStr::new("powershell")
        );
        let gemini = find_spec("gemini").unwrap(); // npm install -g …
        assert_eq!(
            installer_command(gemini).unwrap().get_program(),
            OsStr::new("cmd")
        );
        let vibe = find_spec("vibe").unwrap(); // no Windows installer
        assert!(installer_command(vibe).is_err());
    }

    #[test]
    fn windows_shell_kind_is_not_derived_from_display_text() {
        assert_eq!(
            windows_shell_kind("irm https://claude.ai/install.ps1 | iex"),
            "powershell"
        );
        assert_eq!(
            windows_shell_kind("npm install -g @google/gemini-cli"),
            "default"
        );
    }
}
