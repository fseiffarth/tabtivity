/**
 * The restore half of stopping agent tabs (`docs/agent_tab_stop_plan.md` §6):
 * with the cap on, a layout load brings every agent tab no static guard holds
 * for back stopped — nothing spawns for it — and notes it for the restore
 * wake; root, a Host session, Gemini and an auto-continuing tab come back
 * running; with the cap off nothing comes back stopped.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

import { ROOT_SCOPE, toSavedTabEntry, useTabsStore, type SavedTabEntry } from "../../stores/tabs";
import { AGENT_ITEMS, buildStaticTabSpec, customAgentToItem } from "../../lib/tabs/newTabItems";
import { useSettingsStore } from "../../stores/settings";
import { useProjectsStore } from "../../stores/projects";
// Importing the store registers the restore's rule, as the app does.
import "../../stores/agents/agentTabStop";
import { _resetAgentTabStopMarksForTest, takeRestoredStopped } from "../../lib/agents/agentTabStopMarks";
import type { ProjectEntry, Settings } from "../../types";

const saved = (n: number, over: Partial<SavedTabEntry> = {}): SavedTabEntry => ({
  key: `agent-${n}`,
  label: "Agent",
  cmd: "claude",
  cwd: "/p",
  kind: "agent",
  sessionId: `00000000-0000-4000-8000-00000000000${n}`,
  ...over,
});

function load(scope: string, layout: SavedTabEntry[]) {
  useTabsStore.getState().loadFromLayout(layout, "/p", scope);
  return useTabsStore.getState().tabsByScope[scope] ?? [];
}

beforeEach(() => {
  _resetAgentTabStopMarksForTest();
  useTabsStore.setState({ scope: "p", tabsByScope: {}, layoutByScope: {}, focusedGroupByScope: {}, detachedGroupsByScope: {}, hiddenGroupsByScope: {} });
  useProjectsStore.setState({
    projects: [
      { id: "p", name: "P", path: "/p", status: "active" } as unknown as ProjectEntry,
      { id: "boxed", name: "C", path: "/c", status: "active", sandbox: { enabled: true } } as unknown as ProjectEntry,
    ],
  });
  useSettingsStore.setState({ settings: { stop_agent_tabs_cap: 30 } as Settings, loaded: true });
});

describe("restoring with the cap on", () => {
  it("brings the stoppable tabs back stopped and notes them for the wake", () => {
    const tabs = load("p", [
      saved(1),
      saved(2, { cmd: "codex" }),
      saved(3, { cmd: "gemini" }),
      saved(4, { autoContinue: true }),
      { key: "shell-1", label: "Shell", cmd: "bash", cwd: "/p", kind: "shell" },
    ]);
    expect(tabs.map((t) => [t.cmd, !!t.stopped])).toEqual([
      ["claude", true],
      ["codex", true],
      ["gemini", false],
      ["claude", false],
      ["bash", false],
    ]);
    const noted = takeRestoredStopped().get("p");
    expect([...(noted ?? [])].sort()).toEqual([tabs[0].key, tabs[1].key].sort());
  });

  it("never in the root scope, nor a container project's tabs", () => {
    expect(load(ROOT_SCOPE, [saved(1), saved(2, { hostSession: true })]).some((t) => t.stopped)).toBe(false);
    expect(load("boxed", [saved(1)]).some((t) => t.stopped)).toBe(false);
    expect(takeRestoredStopped().size).toBe(0);
  });
});

describe("a custom agent", () => {
  it("is marked at launch, keeps the mark through a save and comes back running", () => {
    const spec = buildStaticTabSpec(
      customAgentToItem({ id: "c1", label: "My Claude", cmd: "claude", args: ["--model", "opus"] }),
      "/p",
      "P",
      (k) => k,
    );
    expect(spec.customAgent).toBe(true);
    const savedTab = toSavedTabEntry({ ...spec, key: "agent-9" });
    expect(savedTab.customAgent).toBe(true);
    const tabs = load("p", [savedTab, saved(1)]);
    expect(tabs.map((t) => [!!t.customAgent, !!t.stopped])).toEqual([
      [true, false],
      [false, true],
    ]);
  });

  it("a built-in launch is not marked", () => {
    const spec = buildStaticTabSpec(AGENT_ITEMS.find((i) => i.cmd === "claude")!, "/p", "P", (k) => k);
    expect(spec.customAgent).toBeUndefined();
  });
});

describe("restoring with the cap off", () => {
  it("brings every tab back running", () => {
    useSettingsStore.setState({ settings: { stop_agent_tabs_cap: 0 } as Settings, loaded: true });
    expect(load("p", [saved(1), saved(2, { cmd: "codex" })]).some((t) => t.stopped)).toBe(false);
    expect(takeRestoredStopped().size).toBe(0);
  });
});

describe("restoring before the settings have loaded", () => {
  // The current scope restores on its own (CenterPanel, the runtime-switch
  // event), not behind `whenSettingsLoaded`: an unloaded store must not read
  // as the default cap, or a user who switched the cap off gets stopped tabs.
  it("brings every tab back running", () => {
    useSettingsStore.setState({ settings: null, loaded: false });
    expect(load("p", [saved(1), saved(2, { cmd: "codex" })]).some((t) => t.stopped)).toBe(false);
    expect(takeRestoredStopped().size).toBe(0);
  });
});
