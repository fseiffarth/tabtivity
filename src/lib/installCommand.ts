import { useProjectsStore } from "../stores/projects";
import { openTabInRootConsole, useRootOverlayStore } from "../stores/rootOverlay";
import { IS_WINDOWS, IS_MAC } from "./platform";
import type { TranslationKey } from "./i18n";

/** A supported git-hosting provider, as chosen in the fork-import dropdown and
 *  the publish-to-GitHub/GitLab dialog. */
export type GitHostProvider = "github" | "gitlab";

/** OS-appropriate install command for a hosting provider's own CLI — the tool
 *  that actually talks to the host's API (`gh repo`/`glab repo`, forking,
 *  publishing), which plain `git` cannot do. Shared by the fork-import banner
 *  (`ProjectDialog`) and the publish banner (`ProjectPill`'s `PublishWindow`)
 *  so the two don't carry separate copies that can drift. */
export const PROVIDER_CLI_INSTALL: Record<GitHostProvider, { bin: string; cmd: string }> = {
  github: {
    bin: "gh",
    cmd: IS_WINDOWS
      ? "winget install --id GitHub.cli -e --source winget"
      : IS_MAC
        ? "brew install gh"
        : "sudo apt-get install -y gh",
  },
  gitlab: {
    bin: "glab",
    cmd: IS_WINDOWS
      ? "winget install --id GitLab.GLab -e --source winget"
      : IS_MAC
        ? "brew install glab"
        : "sudo apt-get install -y glab",
  },
};

/** The CLI's own sign-in command. Run in a visible terminal (via
 *  `runInstallInTab`) rather than headlessly — both `gh auth login` and `glab
 *  auth login` are interactive (a browser handoff, or a pasted one-time code). */
export function providerAuthLoginCmd(provider: GitHostProvider): string {
  return provider === "gitlab" ? "glab auth login" : "gh auth login";
}

/**
 * One-click "install in a terminal tab" helper.
 *
 * Tabtivity's policy is that any install-via-command flow (Ollama models, agent
 * CLIs, and external tools like a LaTeX/TeX distribution or sshfs) must be a
 * single click that opens a fresh terminal tab and *runs* the command — never a
 * "copy this command and run it yourself" manual step.
 *
 * The command is typed into the freshly-spawned shell via the tab's
 * `initialInput`; `TerminalView` submits it with a trailing CR once the shell is
 * ready, so the install actually executes. Interactive prompts (a `sudo`
 * password, MiKTeX's installer, etc.) are answered directly in that visible
 * terminal — Tabtivity never has to handle them.
 *
 * The tab opens in the **root** scope (installs are machine-global, not project
 * scoped). The active project is deliberately left unchanged — switching scope
 * from a settings click would be jarring. Instead the install is surfaced in the
 * **root console** (`layout/RootOverlay`), which floats over whatever is open
 * with the install's tab in front, so the user watches the install — and answers
 * its prompts — right where they clicked. The console's panes are attach-only
 * views, so closing it leaves the install running in its root tab. That tab
 * pulses in the console's strip until the user clicks it, so it stands out
 * among the console's other tabs.
 */
export type InstallShellKind = "bash" | "powershell" | "default";

/** Explicit terminal program for an installer shell. Shell-specific syntax must
 * never be submitted to the host's unrelated default shell. */
export function installShellCommand(shellKind: InstallShellKind): string {
  if (shellKind === "bash") return "/bin/bash";
  if (shellKind === "powershell") return "powershell.exe";
  return "";
}

/** The shell a container image build (`sandbox_preflight`'s `build_command`)
 *  runs in. The backend quotes the Dockerfile directory as `'…'` for exactly
 *  these two shells; the Windows default shell is cmd.exe, which does not treat
 *  `'` as a quote, so it must never be `"default"`. */
export function containerBuildShell(windows: boolean = IS_WINDOWS): InstallShellKind {
  return windows ? "powershell" : "bash";
}

export function runInstallInTab(
  label: string,
  command: string,
  shellKind: InstallShellKind,
): void {
  const rootDir = useProjectsStore.getState().rootDir ?? "";
  openTabInRootConsole({
    label,
    cmd: installShellCommand(shellKind),
    cwd: rootDir, // empty resolves to ~/tabtivity/root on the backend
    kind: "shell",
    initialInput: command,
  }, (tab) => useRootOverlayStore.getState().markInstallTab(tab.key));
}

/**
 * Per-OS command that installs Node.js (and with it `npm`). Most agent CLIs
 * install via `npm install -g …`, so when `npm` is missing the Manage Agents
 * panel (and the intro wizard) offers this first. nvm installs Node without administrator rights and
 * works identically on Linux and macOS; Windows uses winget (present on Windows
 * 10/11) and runs in either PowerShell or Command Prompt.
 */
export const NODE_INSTALL: Record<
  "windows" | "macos" | "linux",
  { command: string; shellKey: TranslationKey; shellKind: InstallShellKind }
> = {
  linux: {
    command:
      'curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash && export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm install --lts',
    shellKey: "install.shellBash",
    shellKind: "bash",
  },
  macos: {
    command:
      'curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash && export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm install --lts',
    shellKey: "install.shellBash",
    shellKind: "bash",
  },
  windows: {
    command: "winget install OpenJS.NodeJS.LTS",
    shellKey: "install.shellPowerShellOrCmd",
    shellKind: "default",
  },
};
export const NODE_DOWNLOAD_URL = "https://nodejs.org/en/download";

/** Backend `NodeRuntimeStatus` (`node_runtime_status`). */
export interface NodeRuntimeStatus {
  npm: boolean;
  /** `node --version`, e.g. `v22.22.1`; null when Node is absent. */
  version: string | null;
  min_major: number;
  too_old: boolean;
}
