import type { InstallShellKind } from "../../lib/installCommand";

/** Official, distro-agnostic install command — kept in sync with the backend. */
/** One agent CLI + its install status (mirrors backend `AgentInfo`). */
/** One recorded "verified against" check the installed release has moved away
 *  from (backend `services::agent_versions::StaleNote`). */
export interface AgentVersionStale {
  version: string;
  surface: string;
  direction: "newer" | "older" | "different";
}

/** What one installed CLI answers `--version`, against the releases Tabtivity's
 *  flags and parsers were checked with. Reported, never enforced — see
 *  `services::agent_versions`. */
export interface AgentVersionReport {
  agent: string;
  label: string;
  installed: boolean;
  /** Whether anyone has checked what this CLI answers to a version flag. */
  supported: boolean;
  version: string | null;
  /** The version line as the CLI printed it. */
  raw: string | null;
  state: "match" | "moved" | "unverified" | "unknown";
  /** Stale checks, weakest (oldest verified release) first. */
  stale: AgentVersionStale[];
  error: string | null;
  checkedAt: number;
  cached: boolean;
  dismissed: boolean;
  /** The last stored update check; absent while running an older backend. */
  update?: AgentUpdateReport | null;
}

/** One installed CLI against its newest published release (backend
 *  `check_agent_updates`, `services::agent_latest`). */
export interface AgentUpdateReport {
  agent: string;
  /** The installed version, when it could be read. */
  current: string | null;
  latest: string | null;
  /** Both versions read and `latest` genuinely newer. */
  updateAvailable: boolean;
  /** Whether a registry is known for this CLI at all. */
  checkable: boolean;
  error: string | null;
  /** Unix seconds of the check; absent on an answer that was never stored. */
  checkedAt?: number;
}

export interface AgentInfo {
  /** Native startup choices; absent while running an older backend. */
  launch_defaults?: { model: boolean; efforts: string[]; effort_requires_model?: boolean };
  id: string;
  label: string;
  bin: string;
  /** Install command for the host OS; empty when no one-line installer exists. */
  install_cmd: string;
  /** Shell the command runs in: "bash", "PowerShell", or "PowerShell or Command Prompt". */
  shell: string;
  /** Machine-readable shell selection; display labels are not executable policy. */
  shell_kind: InstallShellKind;
  /** `npm uninstall -g <pkg>` for an npm-installed agent; empty otherwise. */
  uninstall_cmd: string;
  /** `install_cmd` prefixed with `sudo`; empty when that wouldn't apply
   *  (Windows, or a non-npm installer). See backend `sudo_variant`. */
  install_cmd_sudo: string;
  /** `uninstall_cmd` prefixed with `sudo`; same emptiness rule. */
  uninstall_cmd_sudo: string;
  docs: string;
  installed: boolean;
  /** Whether the scheduled warm-up can drive this CLI (it has a known one-shot
   *  print mode — backend `WARMUPS`). False greys the schedule toggle. */
  warmup: boolean;
}
