import { describe, expect, it } from "vitest";
import {
  AGENT_FENCE_DEFAULT_PATHS,
  AGENT_FENCE_MACOS_PATHS,
  agentFenceDefaultPaths,
  agentFenceInstallCommand,
  agentFenceMarkLevel,
  agentFenceReasonKey,
  parseAgentFencePaths,
} from "../../lib/agents/agentFence";

describe("agent fence project-pill states", () => {
  it("marks only tabs that run unfenced right now — there is no policy off", () => {
    expect(agentFenceMarkLevel(undefined)).toBeNull();
    expect(agentFenceMarkLevel({ live_unfenced: 0 })).toBeNull();
    expect(agentFenceMarkLevel({ live_unfenced: 2 })).toBe("live");
  });

  it("maps backend status reasons to localized UI keys", () => {
    expect(agentFenceReasonKey("remote host")).toBe("pill.agentFenceReasonRemote");
    expect(agentFenceReasonKey("macOS")).toBe("pill.agentFenceReasonMacos");
    expect(agentFenceReasonKey("bubblewrap unavailable")).toBe(
      "pill.agentFenceReasonBwrap",
    );
    expect(agentFenceReasonKey("enforced")).toBeNull();
    expect(agentFenceReasonKey("host session")).toBe("pill.agentFenceReasonHostSession");
    expect(agentFenceReasonKey("off")).toBeNull();
    expect(agentFenceReasonKey("sandbox-exec unavailable")).toBe("pill.agentFenceReasonSeatbelt");
  });
});

describe("agent fence install button", () => {
  const base = { enforced: false, reason: "bubblewrap unavailable", roots: [] };

  it("uses the backend's distro command when the tool is missing", () => {
    expect(
      agentFenceInstallCommand({
        ...base,
        bwrap_available: false,
        install_cmd: "sudo dnf install -y bubblewrap",
      }),
    ).toBe("sudo dnf install -y bubblewrap");
  });

  it("offers nothing for an unknown distribution or an older backend", () => {
    expect(agentFenceInstallCommand({ ...base, bwrap_available: false, install_cmd: null })).toBeNull();
    expect(agentFenceInstallCommand({ ...base, bwrap_available: false })).toBeNull();
  });

  it("offers nothing while the tool works", () => {
    expect(
      agentFenceInstallCommand({ ...base, bwrap_available: true, install_cmd: "sudo apt install -y bubblewrap" }),
    ).toBeNull();
    expect(agentFenceInstallCommand(null)).toBeNull();
  });
});

describe("agent fence settings paths", () => {
  it("round-trips one-path-per-line input and removes blanks/duplicates", () => {
    const saved = parseAgentFencePaths(
      " ~/.cargo\r\n\n~/.local/bin\n~/.cargo\n /opt/team-tools ",
    );
    expect(saved).toEqual(["~/.cargo", "~/.local/bin", "/opt/team-tools"]);
    expect(parseAgentFencePaths(saved.join("\n"))).toEqual(saved);
  });

  it("exposes the documented default read-only tool paths", () => {
    expect(AGENT_FENCE_DEFAULT_PATHS).toEqual([
      "~/.local/bin",
      "~/.local/share/claude",
      "~/.local/share/pnpm",
      "~/.nvm",
      "~/.cargo",
      "~/.rustup",
      "~/anaconda3",
      "~/miniconda3",
      "~/.pyenv",
      "~/.bun",
      "~/go",
      "~/.gitconfig",
      "~/.config/git",
    ]);
  });

  // 2442z: a Mac host adds its toolchain homes, in the backend's order.
  it("adds the Mac toolchain homes on a Mac host only", () => {
    expect(agentFenceDefaultPaths("linux")).toEqual([...AGENT_FENCE_DEFAULT_PATHS]);
    expect(agentFenceDefaultPaths("windows")).toEqual([...AGENT_FENCE_DEFAULT_PATHS]);
    const mac = agentFenceDefaultPaths("macos");
    expect(mac.slice(0, AGENT_FENCE_DEFAULT_PATHS.length)).toEqual([...AGENT_FENCE_DEFAULT_PATHS]);
    expect(mac.slice(AGENT_FENCE_DEFAULT_PATHS.length)).toEqual([...AGENT_FENCE_MACOS_PATHS]);
    expect(mac).toContain("~/Library/pnpm");
  });
});
