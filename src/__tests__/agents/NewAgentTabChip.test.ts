/**
 * A CLI installed while the app runs gets its "+ tab" chip by itself, whichever
 * way it arrived; a CLI that was already there keeps the chip the user left it
 * with. Everything the app learns comes through `list_agents`, so that is the
 * only input here.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "../../types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(() => Promise.resolve()),
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

const row = (id: string, installed: boolean, bin = id) => ({ id, bin, installed });

/** A fresh module per test: the baseline is per window, for a window's life. */
async function load(settings: Partial<Settings>) {
  vi.resetModules();
  const { useSettingsStore } = await import("../../stores/settings");
  const { noteInstalledAgents, AGENT_REGISTRY_CHANGED_EVENT } = await import(
    "../../lib/agents/agentRegistry"
  );
  useSettingsStore.setState({ settings: settings as Settings });
  const compact = () => useSettingsStore.getState().settings?.compact_tab_agents;
  return { noteInstalledAgents, AGENT_REGISTRY_CHANGED_EVENT, compact };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("noteInstalledAgents", () => {
  it("leaves the first answer alone: what was installed at launch is no install", async () => {
    const { noteInstalledAgents, compact } = await load({ compact_tab_agents: ["claude"] });
    noteInstalledAgents([row("claude", true), row("opencode", true)]);
    expect(compact()).toEqual(["claude"]);
  });

  it("adds a CLI that turns up installed", async () => {
    const { noteInstalledAgents, compact } = await load({ compact_tab_agents: ["claude"] });
    noteInstalledAgents([row("claude", true), row("opencode", false)]);
    noteInstalledAgents([row("claude", true), row("opencode", true)]);
    expect(compact()).toEqual(["claude", "opencode"]);
  });

  it("starts from the shortlist when no list was saved, so the three stay", async () => {
    const { noteInstalledAgents, compact } = await load({});
    noteInstalledAgents([row("opencode", false)]);
    noteInstalledAgents([row("opencode", true)]);
    expect(compact()).toEqual(["claude", "codex", "gemini", "opencode"]);
  });

  it("saves nothing for a CLI the unset shortlist already shows", async () => {
    const { noteInstalledAgents, compact } = await load({});
    noteInstalledAgents([row("codex", false)]);
    noteInstalledAgents([row("codex", true)]);
    expect(compact()).toBeUndefined();
  });

  it("knows a CLI listed under its binary, as the chip does", async () => {
    const { noteInstalledAgents, compact } = await load({ compact_tab_agents: ["agy"] });
    noteInstalledAgents([row("antigravity", false, "agy")]);
    noteInstalledAgents([row("antigravity", true, "agy")]);
    expect(compact()).toEqual(["agy"]);
  });

  it("keeps a chip switched off through a Reinstall", async () => {
    const { noteInstalledAgents, compact } = await load({ compact_tab_agents: ["claude"] });
    noteInstalledAgents([row("opencode", true)]);
    noteInstalledAgents([row("opencode", false)]);
    noteInstalledAgents([row("opencode", true)]);
    expect(compact()).toEqual(["claude"]);
  });

  it("adds a CLI once, so switching the new chip off sticks", async () => {
    const { noteInstalledAgents, compact } = await load({ compact_tab_agents: [] });
    noteInstalledAgents([row("opencode", false)]);
    noteInstalledAgents([row("opencode", true)]);
    expect(compact()).toEqual(["opencode"]);
    const { useSettingsStore } = await import("../../stores/settings");
    useSettingsStore.setState({ settings: { compact_tab_agents: [] } as unknown as Settings });
    noteInstalledAgents([row("opencode", true)]);
    expect(compact()).toEqual([]);
  });

  it("takes no baseline from a failed read", async () => {
    const { noteInstalledAgents, compact } = await load({ compact_tab_agents: ["claude"] });
    noteInstalledAgents([]);
    noteInstalledAgents([row("opencode", true)]);
    expect(compact()).toEqual(["claude"]);
  });

  it("tells the menus only when a new CLI turned up", async () => {
    const { noteInstalledAgents, AGENT_REGISTRY_CHANGED_EVENT } = await load({ compact_tab_agents: [] });
    const changed = vi.fn();
    window.addEventListener(AGENT_REGISTRY_CHANGED_EVENT, changed);
    noteInstalledAgents([row("opencode", false)]);
    noteInstalledAgents([row("opencode", false)]);
    expect(changed).not.toHaveBeenCalled();
    noteInstalledAgents([row("opencode", true)]);
    noteInstalledAgents([row("opencode", true)]);
    expect(changed).toHaveBeenCalledTimes(1);
    window.removeEventListener(AGENT_REGISTRY_CHANGED_EVENT, changed);
  });
});
