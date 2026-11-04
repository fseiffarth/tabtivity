import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));

import {
  AUTO_TAB_NAME_MAX,
  firstPromptTabName,
  isResumeLaunch,
  promptTabName,
  withAutoLabel,
} from "../../lib/agents/autoTabName";
import { _resetAutoTabNamesForTest, noteAutoNameRoll, startAutoTabNames } from "../../stores/agents/autoTabNames";
import { useAgentModelsStore } from "../../stores/agents/agentModels";
import { useSettingsStore } from "../../stores/settings";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { duplicateSpec, restoreSavedTab } from "../../stores/tabs/tabEntries";
import type { Settings } from "../../types";

describe("promptTabName", () => {
  it("keeps a short prompt, trimmed of trailing punctuation", () => {
    expect(promptTabName("  Fix the   settings scrollbar.  ")).toBe("Fix the settings scrollbar");
  });

  it("cuts a long prompt at a word, with an ellipsis", () => {
    const name = promptTabName("Please refactor the terminal registry so that every hidden pane stops rendering")!;
    expect(name.endsWith("…")).toBe(true);
    expect(Array.from(name).length).toBeLessThanOrEqual(AUTO_TAB_NAME_MAX + 1);
    expect(name).toBe("Please refactor the terminal registry so…");
  });

  it("skips slash commands but names a goal", () => {
    expect(promptTabName("/model")).toBeNull();
    expect(promptTabName("/init")).toBeNull();
    expect(promptTabName("/goal ship the phone files view")).toBe("ship the phone files view");
  });

  it("drops attachment placeholders and leading quote marks", () => {
    expect(promptTabName("[Image #1] why is this red?")).toBe("why is this red");
    expect(promptTabName("> \"quoted task\"")).toBe("quoted task\"");
    expect(promptTabName("[Pasted text #1 +40 lines]")).toBeNull();
  });

  it("names from the first prompt that holds a task", () => {
    expect(firstPromptTabName(["/model", "", "Add a toggle", "later"])).toBe("Add a toggle");
    expect(firstPromptTabName(["/clear"])).toBeNull();
  });
});

describe("withAutoLabel", () => {
  const spec: Omit<TabEntry, "key"> = { label: "Claude", cmd: "claude", cwd: "/p", kind: "agent", args: ["--session-id", "x"] };

  it("arms a new agent conversation with its label", () => {
    expect(withAutoLabel("p1", spec).autoLabel).toBe("Claude");
  });

  it("leaves resumed, sign-in, Tabby and non-agent tabs alone, and keeps a carried label", () => {
    expect(isResumeLaunch(["--resume", "id"])).toBe(true);
    expect(isResumeLaunch(["resume", "--last"])).toBe(true);
    expect(withAutoLabel("p1", { ...spec, args: ["--resume", "x"] }).autoLabel).toBeUndefined();
    expect(withAutoLabel("p1", { ...spec, signIn: true }).autoLabel).toBeUndefined();
    expect(withAutoLabel("assistant", spec).autoLabel).toBeUndefined();
    expect(withAutoLabel("p1", { ...spec, kind: "shell" }).autoLabel).toBeUndefined();
    // The label names the CLI of a custom command or a local-model tab.
    expect(withAutoLabel("p1", { ...spec, cmd: "my-agent" }).autoLabel).toBeUndefined();
    expect(withAutoLabel("p1", { ...spec, cmd: "ollama", kind: "local_agent" }).autoLabel).toBeUndefined();
    expect(withAutoLabel("p1", { ...spec, autoLabel: "Old task", autoNamed: true }).autoLabel).toBe("Old task");
  });

  it("is dropped by a duplicate and survives a restore, validated", () => {
    const tab = { ...spec, key: "agent-1", autoLabel: "Task", autoNamed: true } as TabEntry;
    const copy = duplicateSpec(tab);
    expect(copy.autoLabel).toBeUndefined();
    expect(copy.autoNamed).toBeUndefined();
    const ctx = { scope: "p1" } as Parameters<typeof restoreSavedTab>[1];
    const restored = restoreSavedTab({ key: "agent-1", label: "Task", cmd: "claude", cwd: "/p", kind: "agent", autoLabel: "Task", autoNamed: true }, ctx);
    expect(restored.autoLabel).toBe("Task");
    expect(restored.autoNamed).toBe(true);
    const planted = restoreSavedTab({ key: "agent-2", label: "x", cmd: "claude", cwd: "/p", kind: "agent", autoLabel: 5 as never, autoNamed: true }, ctx);
    expect(planted.autoLabel).toBeUndefined();
    expect(planted.autoNamed).toBeUndefined();
  });
});

describe("autoTabNames", () => {
  const PTY = "p1:agent-1";
  let stop: () => void = () => {};

  function seed(extra: Partial<TabEntry> = {}): void {
    const tab = { key: "agent-1", kind: "agent", cmd: "claude", label: "Claude", cwd: "/p1", autoLabel: "Claude", ...extra } as TabEntry;
    useTabsStore.setState((state) => ({ tabsByScope: { ...state.tabsByScope, p1: [tab] } }));
  }
  const tab = () => useTabsStore.getState().tabsByScope.p1[0];
  const read = (prompts: string[]) =>
    useAgentModelsStore.setState({
      recentByTab: { [PTY]: prompts.map((text, i) => ({ text, at: `2026-11-03T10:0${i}:00Z` })) },
      promptByTab: prompts.length ? { [PTY]: prompts[prompts.length - 1] } : {},
    });

  beforeEach(() => {
    invokeMock.mockReset();
    _resetAutoTabNamesForTest();
    useAgentModelsStore.setState({ recentByTab: {}, promptByTab: {} });
    useSettingsStore.setState({ settings: {} as Settings });
    stop = startAutoTabNames();
  });
  afterEach(() => stop());

  it("names the tab after its first prompt, once", () => {
    seed();
    read(["Fix the settings scrollbar"]);
    expect(tab()).toMatchObject({ label: "Fix the settings scrollbar", autoLabel: "Fix the settings scrollbar", autoNamed: true });
    read(["Fix the settings scrollbar", "now the phone too"]);
    expect(tab().label).toBe("Fix the settings scrollbar");
  });

  it("never touches a tab the user renamed", () => {
    seed({ label: "My name" });
    read(["Fix the settings scrollbar"]);
    expect(tab().label).toBe("My name");
  });

  it("does nothing for an unarmed tab or with the setting off", () => {
    seed({ autoLabel: undefined });
    read(["Fix it"]);
    expect(tab().label).toBe("Claude");
    seed();
    useSettingsStore.setState({ settings: { agent_tab_auto_name: false } as Settings });
    read(["Fix it again"]);
    expect(tab().label).toBe("Claude");
  });

  it("waits past a slash command for the task", () => {
    seed();
    read(["/model"]);
    expect(tab().label).toBe("Claude");
    read(["/model", "Write the docs"]);
    expect(tab().label).toBe("Write the docs");
  });

  it("names it again after a /clear, from the new conversation only", () => {
    seed();
    read(["First task"]);
    expect(tab().label).toBe("First task");
    noteAutoNameRoll(PTY, "clear");
    // A read still pointed at the cleared conversation brings nothing new.
    read(["First task"]);
    expect(tab().label).toBe("First task");
    read(["Second task"]);
    expect(tab().label).toBe("Second task");
  });

  it("a /clear on a renamed tab changes nothing", () => {
    seed({ label: "Mine", autoLabel: "First task", autoNamed: true });
    noteAutoNameRoll(PTY, "clear");
    read(["Second task"]);
    expect(tab().label).toBe("Mine");
  });
});
