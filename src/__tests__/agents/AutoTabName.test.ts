import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));

import {
  AUTO_TAB_NAME_MAX,
  firstPromptTabName,
  isResumeLaunch,
  promptTabName,
  tabTaskName,
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
    const tab = { ...spec, key: "agent-1", autoLabel: "Claude", autoNamed: true, taskName: "Task" } as TabEntry;
    const copy = duplicateSpec(tab);
    expect(copy.autoLabel).toBeUndefined();
    expect(copy.autoNamed).toBeUndefined();
    expect(copy.taskName).toBeUndefined();
    const ctx = { scope: "p1" } as Parameters<typeof restoreSavedTab>[1];
    const restored = restoreSavedTab({ key: "agent-1", label: "Claude", cmd: "claude", cwd: "/p", kind: "agent", autoLabel: "Claude", autoNamed: true, taskName: "Task" }, ctx);
    expect(restored).toMatchObject({ label: "Claude", autoLabel: "Claude", autoNamed: true, taskName: "Task" });
    const planted = restoreSavedTab({ key: "agent-2", label: "x", cmd: "claude", cwd: "/p", kind: "agent", autoLabel: 5 as never, autoNamed: true, taskName: "t" }, ctx);
    expect(planted.autoLabel).toBeUndefined();
    expect(planted.autoNamed).toBeUndefined();
    expect(planted.taskName).toBeUndefined();
  });

  it("moves an earlier build's task label back off the tab", () => {
    const ctx = { scope: "p1" } as Parameters<typeof restoreSavedTab>[1];
    const old = restoreSavedTab({ key: "agent-1", label: "Task", cmd: "claude", cwd: "/p", kind: "agent", autoLabel: "Task", autoNamed: true }, ctx);
    expect(old).toMatchObject({ label: "Claude", autoLabel: "Claude", autoNamed: true, taskName: "Task" });
    // Renamed by the user since: left alone.
    const mine = restoreSavedTab({ key: "agent-2", label: "Mine", cmd: "claude", cwd: "/p", kind: "agent", autoLabel: "Task", autoNamed: true }, ctx);
    expect(mine).toMatchObject({ label: "Mine", autoLabel: "Task" });
    expect(mine.taskName).toBeUndefined();
  });

  it("shows the task name only while the tab holds the label it was given", () => {
    expect(tabTaskName({ label: "Claude", autoLabel: "Claude", taskName: "Task" })).toBe("Task");
    expect(tabTaskName({ label: "Mine", autoLabel: "Claude", taskName: "Task" })).toBeUndefined();
    expect(tabTaskName({ label: "Claude", autoLabel: "Claude" })).toBeUndefined();
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
    // The tab keeps its CLI's name; the task is kept apart (phone, hover card).
    expect(tab()).toMatchObject({ label: "Claude", autoLabel: "Claude", autoNamed: true, taskName: "Fix the settings scrollbar" });
    read(["Fix the settings scrollbar", "now the phone too"]);
    expect(tab().taskName).toBe("Fix the settings scrollbar");
  });

  it("never touches a tab the user renamed", () => {
    seed({ label: "My name" });
    read(["Fix the settings scrollbar"]);
    expect(tab().label).toBe("My name");
    expect(tab().taskName).toBeUndefined();
  });

  it("does nothing for an unarmed tab or with the setting off", () => {
    seed({ autoLabel: undefined });
    read(["Fix it"]);
    expect(tab().taskName).toBeUndefined();
    seed();
    useSettingsStore.setState({ settings: { agent_tab_auto_name: false } as Settings });
    read(["Fix it again"]);
    expect(tab().taskName).toBeUndefined();
  });

  it("waits past a slash command for the task", () => {
    seed();
    read(["/model"]);
    expect(tab().taskName).toBeUndefined();
    read(["/model", "Write the docs"]);
    expect(tab().taskName).toBe("Write the docs");
  });

  it("names it again after a /clear, from the new conversation only", () => {
    seed();
    read(["First task"]);
    expect(tab().taskName).toBe("First task");
    noteAutoNameRoll(PTY, "clear");
    // A read still pointed at the cleared conversation brings nothing new.
    read(["First task"]);
    expect(tab().taskName).toBe("First task");
    read(["Second task"]);
    expect(tab().taskName).toBe("Second task");
    expect(tab().label).toBe("Claude");
  });

  it("a /clear arms a resumed tab that still carries its CLI's name", () => {
    seed({ autoLabel: undefined, args: ["--resume", "abc"] });
    read(["Old task"]);
    expect(tab().taskName).toBeUndefined();
    noteAutoNameRoll(PTY, "clear");
    expect(tab().autoLabel).toBe("Claude");
    read(["Old task"]);
    expect(tab().taskName).toBeUndefined();
    read(["New task"]);
    expect(tab()).toMatchObject({ label: "Claude", autoLabel: "Claude", autoNamed: true, taskName: "New task" });
  });

  it("a /clear leaves an unarmed tab with a name of its own, and Tabby's", () => {
    seed({ autoLabel: undefined, label: "Mine" });
    noteAutoNameRoll(PTY, "clear");
    read(["New task"]);
    expect(tab().label).toBe("Mine");
    expect(tab().autoLabel).toBeUndefined();
    expect(tab().taskName).toBeUndefined();
    seed({ autoLabel: undefined, assistant: { cli: "claude" } as TabEntry["assistant"] });
    noteAutoNameRoll(PTY, "clear");
    expect(tab().autoLabel).toBeUndefined();
  });

  it("a /clear arms nothing while names are off", () => {
    useSettingsStore.setState({ settings: { agent_tab_auto_name: false } as Settings });
    seed({ autoLabel: undefined });
    noteAutoNameRoll(PTY, "clear");
    expect(tab().autoLabel).toBeUndefined();
  });

  it("a /clear on a renamed tab changes nothing", () => {
    seed({ label: "Mine", autoLabel: "Claude", autoNamed: true, taskName: "First task" });
    noteAutoNameRoll(PTY, "clear");
    read(["Second task"]);
    expect(tab()).toMatchObject({ label: "Mine", taskName: "First task" });
  });
});
