/**
 * Cloud sessions from the "+" menu (`lib/agents/cloudSessions`): which CLIs
 * offer one, what they launch with, and that a cloud tab is never one restore
 * could relaunch into a second cloud session.
 */
import { describe, expect, it, vi } from "vitest";
import { cleanCloudTask, cloudLaunch, cloudLaunchesFor, MAX_CLOUD_TASK } from "../../lib/agents/cloudSessions";
import {
  AGENT_ITEMS,
  CLOUD_SESSION_KEY,
  agentMenuEntries,
  buildCloudTabSpec,
  compactAgentMenuEntries,
} from "../../components/tabs/newTabItems";
import { isRestorableTab } from "../../stores/tabs";
import { envName } from "../../lib/brand";

const t = (key: string, vars?: Record<string, string>) =>
  vars ? `${key}(${Object.values(vars).join(",")})` : key;
const item = (cmd: string) => AGENT_ITEMS.find((entry) => entry.cmd === cmd)!;

describe("cloud launches", () => {
  it("are the launch-time entry points each CLI has", () => {
    expect(cloudLaunch("claude", "new")!.args("fix it")).toEqual(["--cloud", "fix it"]);
    expect(cloudLaunch("claude", "open")!.args("")).toEqual(["--teleport"]);
    expect(cloudLaunch("codex", "open")!.args("")).toEqual(["cloud"]);
    expect(cloudLaunch("kiro-cli", "new")!.args("")).toEqual(["--cloud"]);
    expect(cloudLaunch("vibe", "new")!.args("x")).toEqual(["--remote", "x"]);
    expect(cloudLaunch("copilot", "open")!.args("")).toEqual(["--connect"]);
    expect(cloudLaunchesFor("gemini")).toEqual([]);
    expect(cloudLaunchesFor("toString")).toEqual([]);
    expect(cloudLaunch("codex", "new")).toBeUndefined();
  });

  it("clean the task to plain, bounded text", () => {
    expect(cleanCloudTask("  fix\nthe build\t ")).toBe("fix\nthe build");
    expect(cleanCloudTask("   ")).toBeNull();
    expect(cleanCloudTask(undefined)).toBeNull();
    expect(cleanCloudTask("a\u001b[2Jb")).toBeNull();
    expect(cleanCloudTask("x".repeat(MAX_CLOUD_TASK + 1))).toBeNull();
  });

  it("build a tab with no session id, so restore drops it instead of relaunching", () => {
    const spec = buildCloudTabSpec(item("claude"), cloudLaunch("claude", "new")!, "fix it", "/p", t);
    expect(spec).toMatchObject({ cmd: "claude", args: ["--cloud", "fix it"], cwd: "/p", kind: "agent" });
    expect(spec.sessionId).toBeUndefined();
    expect(spec.initialInput).toBeUndefined();
    expect(spec.env).not.toHaveProperty(envName("TAB_UID"));
    expect(isRestorableTab(spec)).toBe(false);
    // …yet it is saved while it runs, so a phone that started it can attach.
    expect(spec.cloud).toBe(true);
  });
});

describe("the Agents group's Cloud session row", () => {
  const entries = (installed: string[], pickCloud?: () => void) =>
    agentMenuEntries({
      installedBuiltins: new Set(installed),
      installedCmds: new Set(),
      customAgents: [],
      pick: vi.fn(),
      pickCloud,
      onAddCustom: vi.fn(),
      t,
    });

  it("gathers the installed CLIs' launches into one fly-out, kept in the compact menu", () => {
    const pickCloud = vi.fn();
    const list = entries(["claude", "codex", "gemini"], pickCloud);
    const row = list.find((entry) => entry.key === CLOUD_SESSION_KEY)!;
    expect(row.moreEntries!.map((entry) => entry.key)).toEqual([
      "cloud:claude:new",
      "cloud:claude:open",
      "cloud:codex:open",
    ]);
    row.moreEntries![2].onPick();
    expect(pickCloud).toHaveBeenCalledWith(item("codex"), cloudLaunch("codex", "open"));
    expect(compactAgentMenuEntries(list, new Set(["claude"])).map((entry) => entry.key)).toContain(CLOUD_SESSION_KEY);
  });

  it("is absent where no cloud session is offered or none is installed", () => {
    expect(entries(["claude"]).some((entry) => entry.key === CLOUD_SESSION_KEY)).toBe(false);
    expect(entries(["gemini"], vi.fn()).some((entry) => entry.key === CLOUD_SESSION_KEY)).toBe(false);
  });
});
