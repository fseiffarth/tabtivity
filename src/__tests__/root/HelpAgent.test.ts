/**
 * The header's help button: which agent it opens (`pickHelpAgent` — the
 * default agent first, Mistral only when nothing else will do and no local
 * model is set), and the click itself (`openHelpAgent`): a root tab in the
 * root console, told what it is for, brought back on a second click while it
 * lives, and nothing opened when there is no agent.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

// The PTY lifecycle bus, so a test can end the help tab's program.
const bus = vi.hoisted(() => ({ exit: new Map<string, () => void>() }));
vi.mock("../../lib/terminal/terminalBus", () => ({
  onTerminalExit: (id: string, h: () => void) => {
    bus.exit.set(id, h);
    return () => bus.exit.delete(id);
  },
  onTerminalReady: () => () => {},
}));

import type { CustomAgent } from "../../types";
import { useTabsStore } from "../../stores/tabs";
import { useSettingsStore } from "../../stores/settings";
import { useRootOverlayStore } from "../../stores/rootOverlay";
import {
  __resetHelpAgentForTests,
  openHelpAgent,
  pickHelpAgent,
} from "../../components/header/helpAgent";

const base = {
  installedBuiltins: new Set<string>(),
  installedCmds: new Set<string>(),
  customAgents: [] as CustomAgent[],
  defaultAgentBin: "claude",
  wiredClis: ["claude", "codex"],
  vibeInstalled: false,
};

describe("pickHelpAgent", () => {
  it("opens the default agent when it is installed", () => {
    const pick = pickHelpAgent({ ...base, installedBuiltins: new Set(["codex", "gemini"]), defaultAgentBin: "gemini" });
    expect(pick).toMatchObject({ kind: "agent", item: { cmd: "gemini" } });
  });

  it("falls back to a CLI wired to the help server, then to any installed one", () => {
    expect(pickHelpAgent({ ...base, installedBuiltins: new Set(["gemini", "codex"]) })).toMatchObject({
      kind: "agent",
      item: { cmd: "codex" },
    });
    expect(pickHelpAgent({ ...base, installedBuiltins: new Set(["gemini"]) })).toMatchObject({
      kind: "agent",
      item: { cmd: "gemini" },
    });
  });

  it("drives the local model through Vibe rather than Mistral's cloud agent", () => {
    const vibeOnly = { ...base, installedBuiltins: new Set(["vibe"]), vibeInstalled: true };
    expect(pickHelpAgent({ ...vibeOnly, localModel: "qwen3:8b" })).toEqual({ kind: "localModel", model: "qwen3:8b" });
    expect(pickHelpAgent(vibeOnly)).toMatchObject({ kind: "agent", item: { cmd: "vibe" } });
    expect(pickHelpAgent({ ...vibeOnly, localModel: "qwen3:8b", defaultAgentBin: "vibe" })).toMatchObject({
      kind: "agent",
      item: { cmd: "vibe" },
    });
  });

  it("counts an installed custom agent and nothing that is not installed", () => {
    const custom: CustomAgent = { id: "c1", label: "Mine", cmd: "my-agent" };
    expect(pickHelpAgent({ ...base, customAgents: [custom] })).toEqual({ kind: "none" });
    expect(
      pickHelpAgent({ ...base, customAgents: [custom], installedCmds: new Set(["my-agent"]) }),
    ).toMatchObject({ kind: "agent", item: { cmd: "my-agent" } });
  });

  it("says none with neither an agent nor a local model", () => {
    expect(pickHelpAgent({ ...base, localModel: "qwen3:8b" })).toEqual({ kind: "none" });
  });
});

const t = (key: string, vars?: Record<string, string>) =>
  vars ? `${key}(${Object.values(vars).join(",")})` : key;
const rootTabs = () => useTabsStore.getState().tabsByScope.root ?? [];

function answer(agents: { id: string; bin: string; installed: boolean }[]) {
  vi.mocked(invoke).mockImplementation((cmd: string) => {
    if (cmd === "list_agents") return Promise.resolve(agents);
    if (cmd === "root_mcp_status") return Promise.resolve({ help: { enabled: true, wiredClis: ["claude", "codex"] } });
    return Promise.resolve({});
  });
}

beforeEach(() => {
  __resetHelpAgentForTests();
  vi.mocked(invoke).mockReset();
  useSettingsStore.setState({ settings: { default_agent_cmd: "claude" } as never });
  useTabsStore.setState({
    scope: "p1",
    tabsByScope: { root: [] },
    layoutByScope: { root: null },
    focusedGroupByScope: { root: null },
  });
  useRootOverlayStore.setState({ open: false, installTabs: {} });
});

describe("openHelpAgent", () => {
  it("opens the default agent as a primed root tab in the root console", async () => {
    answer([{ id: "claude", bin: "claude", installed: true }]);

    await expect(openHelpAgent(t)).resolves.toBe("opened");

    expect(rootTabs()).toHaveLength(1);
    expect(rootTabs()[0]).toMatchObject({
      cmd: "claude",
      kind: "agent",
      label: "helpAgent.tabLabel(Claude)",
      initialInput: "helpAgent.prompt",
    });
    expect(useRootOverlayStore.getState().open).toBe(true);
    expect(useTabsStore.getState().scope).toBe("p1");
  });

  it("brings the live help tab back instead of opening a second, and replaces an exited one", async () => {
    answer([{ id: "claude", bin: "claude", installed: true }]);
    await openHelpAgent(t);
    useRootOverlayStore.setState({ open: false });

    await openHelpAgent(t);
    expect(rootTabs()).toHaveLength(1);
    expect(useRootOverlayStore.getState().open).toBe(true);

    bus.exit.get(`root:${rootTabs()[0].key}`)?.();
    await openHelpAgent(t);
    expect(rootTabs()).toHaveLength(2);
  });

  it("opens nothing when no agent is installed", async () => {
    answer([{ id: "claude", bin: "claude", installed: false }]);

    await expect(openHelpAgent(t)).resolves.toBe("none");

    expect(rootTabs()).toHaveLength(0);
    expect(useRootOverlayStore.getState().open).toBe(false);
  });
});
