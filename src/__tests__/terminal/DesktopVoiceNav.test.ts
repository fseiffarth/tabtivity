import { beforeEach, describe, expect, it } from "vitest";
import {
  agentTabChoice, clearDesktopLanding, leaveDesktopLanding, navLists, navQueue, scopeAgentTab, tabAtNumber, takeDesktopLanding,
} from "../../lib/voice/desktopNav";
import { nextStatusTab } from "../../lib/shortcuts/statusJump";
import type { TabEntry } from "../../stores/tabs";

const agent = (key: string, label = "Claude", cmd = "claude"): TabEntry => ({ key, label, cmd, cwd: "/p", kind: "agent" });
const shell = (key: string): TabEntry => ({ key, label: "Shell", cmd: "bash", cwd: "/p", kind: "shell" });
const label = (tab: { label: string }) => tab.label;

describe("desktop spoken navigation's targets", () => {
  beforeEach(() => clearDesktopLanding());

  it("lists projects and boxes by name, never a reserved scope's tabs", () => {
    const lists = navLists(
      [{ id: "p1", name: "Alpha" }, { id: "root", name: "Root" }, { id: "assistant", name: "Tabby" }],
      [{ id: "b1", name: "Papers" }],
      "p1",
      [agent("a"), agent("b", "Codex", "codex"), shell("s")],
      (tab) => (tab.label === "Claude" ? "Claude Code" : tab.label),
    );
    expect(lists.projects).toEqual([{ id: "p1", name: "Alpha" }]);
    expect(lists.boxes).toEqual([{ id: "box:b1", name: "Papers" }]);
    expect(lists.tabs?.map((tab) => tab.id)).toEqual(["a", "b", "s"]);
    expect(lists.agents?.map((item) => item.name)).toEqual(["Claude Code", "Codex"]);
    expect(lists.agents?.[0].aliases).toContain("cloud");
    expect(navLists([], [], "root", [agent("r")], label).tabs).toEqual([]);
    expect(navLists([], [], "assistant", [agent("t")], label).tabs).toEqual([]);
  });

  it("walks steering's order without root, Tabby, busy shells or tabs with no Chat", () => {
    const tabsByScope = { p1: [agent("a"), shell("s"), agent("b")], root: [agent("r")], assistant: [agent("t")] };
    const busy = { "p1:a": true, "p1:s": true, "root:r": true, "assistant:t": true, "p1:b": true };
    const noChatB = (_scope: string, tab: TabEntry) => tab.key !== "b";
    expect(navQueue("working", busy, {}, tabsByScope, noChatB)).toEqual([{ scope: "p1", key: "a" }]);
    const attention = { "p1:a": "done", "p1:b": "done", "root:r": "done" } as const;
    const done = navQueue("done", {}, attention, tabsByScope, () => true);
    expect(done).toEqual([{ scope: "p1", key: "a" }, { scope: "p1", key: "b" }]);
    // "Again" goes on from the tab shown, as the next-done key does.
    expect(nextStatusTab(done, { scope: "p1", key: "a" }, 1)).toEqual({ scope: "p1", key: "b" });
    expect(navQueue("waiting", {}, { "root:r": "decision" }, tabsByScope, () => true)).toEqual([]);
  });

  it("lands a scope on its agent tab with the latest activity, else the first", () => {
    const tabs = [shell("s"), agent("a"), agent("b")];
    expect(scopeAgentTab("p1", tabs, {}, {})?.key).toBe("a");
    expect(scopeAgentTab("p1", tabs, { "p1:a": 5 }, { "p1:b": 9 })?.key).toBe("b");
    expect(scopeAgentTab("p1", [shell("s")], {}, {})).toBeUndefined();
  });

  it("picks a tab by number and an agent's tab by name", () => {
    const tabs = [agent("a"), agent("x", "Codex", "codex"), agent("b")];
    expect(tabAtNumber(tabs, 2)?.key).toBe("x");
    expect(tabAtNumber(tabs, 0)).toBeUndefined();
    expect(agentTabChoice("p1", tabs, "Claude", label, {}, {}, 2)?.key).toBe("b");
    expect(agentTabChoice("p1", tabs, "Claude", label, { "p1:b": 3 }, {})?.key).toBe("b");
    expect(agentTabChoice("p1", tabs, "Gemini", label, {}, {})).toBeUndefined();
  });

  it("hands the note to its own Chat once, and drops a stale one", () => {
    leaveDesktopLanding({ ptyId: "p1:a", handsFree: true, where: "Claude in Alpha" }, 1_000);
    // Another Chat coming into view leaves it for the one it is for.
    expect(takeDesktopLanding("p1:b", 2_000)).toBeNull();
    expect(takeDesktopLanding("p1:a", 2_000)).toEqual({ ptyId: "p1:a", handsFree: true, where: "Claude in Alpha", at: 1_000 });
    expect(takeDesktopLanding("p1:a", 2_000)).toBeNull();
    leaveDesktopLanding({ ptyId: "p1:a", handsFree: false, where: "" }, 1_000);
    expect(takeDesktopLanding("p1:a", 31_001)).toBeNull();
    expect(takeDesktopLanding("p1:a", 2_000)).toBeNull();
  });
});
