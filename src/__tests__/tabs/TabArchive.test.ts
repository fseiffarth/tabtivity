/**
 * The per-scope tab archive (`stores/tabArchive`): Archive writes the tab's
 * persisted shape to the backend before it ends the tab, and a restore builds
 * it back the way a restart does — an agent on its resume args, never the
 * tmux name or shared id of the run that was archived.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const archive: { id: string; archivedAt: number; tab: Record<string, unknown> }[] = [];
const invoke = vi.fn((cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
  if (cmd === "tab_archive_add") {
    const tabs = (args?.tabs ?? []) as Record<string, unknown>[];
    const added = tabs.map((tab, i) => ({ id: `a${archive.length + i}`, archivedAt: 1, tab }));
    archive.unshift(...added);
    return Promise.resolve(added);
  }
  if (cmd === "tab_archive_take") {
    const at = archive.findIndex((e) => e.id === args?.id);
    return Promise.resolve(at < 0 ? null : archive.splice(at, 1)[0]);
  }
  if (cmd === "tab_archive_list") return Promise.resolve([...archive]);
  return Promise.resolve();
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: Record<string, unknown>) => invoke(cmd, args) }));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(() => Promise.resolve()), listen: vi.fn(() => Promise.resolve(() => {})) }));

import { useTabsStore, type GroupNode, type TabEntry } from "../../stores/tabs";
import { archiveSnapshot, archiveTabs, canArchiveTab, restoreArchivedTab } from "../../stores/tabArchive";
import { useClosedAgentTabsStore } from "../../stores/agents/closedAgentTabs";

function seed() {
  useTabsStore.setState({
    scope: "p",
    tabsByScope: {},
    layoutByScope: {},
    detachedGroupsByScope: {},
    focusedGroupByScope: {},
    tabs: [],
    layout: null,
    focusedGroupId: null,
    activeKey: null,
  });
  useClosedAgentTabsStore.setState({ byScope: {} });
  archive.length = 0;
  invoke.mockClear();
}

function add(tab: Partial<TabEntry> & { label: string }): TabEntry {
  return useTabsStore.getState().addTab({ cmd: "bash", cwd: "/p", kind: "shell", ...tab });
}

function labels(): string[] {
  const group = useTabsStore.getState().layout as GroupNode;
  return group.tabKeys.map((k) => useTabsStore.getState().tabs.find((t) => t.key === k)!.label);
}

describe("tab archive", () => {
  beforeEach(seed);

  it("archives a Claude tab and restores it on its conversation", async () => {
    add({ label: "a" });
    const claude = add({
      label: "claude",
      cmd: "claude",
      kind: "agent",
      args: ["--session-id", "s-1"],
      sessionId: "s-1",
      color: "blue",
      tmuxSession: "app-p-agent-1",
    });
    expect(await archiveTabs("p", [claude.key])).toBe(1);
    expect(labels()).toEqual(["a"]);
    // Kept for the archive, not for Recently closed.
    expect(useClosedAgentTabsStore.getState().byScope.p ?? []).toEqual([]);
    const sent = invoke.mock.calls.find(([cmd]) => cmd === "tab_archive_add")![1]!.tabs as Record<string, unknown>[];
    expect(sent[0].label).toBe("claude");
    expect(sent[0].sessionId).toBe("s-1");
    expect(sent[0].tmuxSession).toBeUndefined();

    const back = (await restoreArchivedTab("p", archive[0].id))!;
    expect(labels()).toEqual(["a", "claude"]);
    expect(back.key).not.toBe(claude.key);
    expect(back.args).toEqual(["--resume", "s-1"]);
    expect(back.color).toBe("blue");
    expect(back.tmuxSession).not.toBe("app-p-agent-1");
    expect(archive).toEqual([]);
    // Gone: a second restore of the same id finds nothing.
    expect(await restoreArchivedTab("p", "a0")).toBeNull();
  });

  it("does not open a conversation twice: the open tab is activated", async () => {
    const claude = add({ label: "claude", cmd: "claude", kind: "agent", sessionId: "s-2" });
    archive.push({ id: "x", archivedAt: 1, tab: archiveSnapshot(claude) as unknown as Record<string, unknown> });
    add({ label: "b" });
    const back = await restoreArchivedTab("p", "x");
    expect(back?.key).toBe(claude.key);
    expect(labels()).toEqual(["claude", "b"]);
    expect(archive).toEqual([]);
  });

  it("offers Archive only for tabs a restart would bring back", () => {
    const shell = add({ label: "sh" });
    const fresh = add({ label: "aider", cmd: "aider", kind: "agent" });
    const host = add({ label: "host", cmd: "claude", kind: "agent", sessionId: "h", hostSession: true });
    expect(canArchiveTab("p", shell)).toBe(true);
    expect(canArchiveTab("p", fresh)).toBe(false);
    expect(canArchiveTab("p", host)).toBe(false);
    expect(canArchiveTab("assistant", shell)).toBe(false);
  });

  it("leaves the tab open when the archive write fails", async () => {
    const shell = add({ label: "sh" });
    invoke.mockImplementationOnce(() => Promise.reject(new Error("disk full")));
    expect(await archiveTabs("p", [shell.key])).toBe(0);
    expect(labels()).toEqual(["sh"]);
  });

  it("skips tabs that cannot be archived in a batch", async () => {
    const a = add({ label: "a" });
    const fresh = add({ label: "aider", cmd: "aider", kind: "agent" });
    const b = add({ label: "b" });
    expect(await archiveTabs("p", [a.key, fresh.key, b.key])).toBe(2);
    expect(labels()).toEqual(["aider"]);
    expect(archive.map((e) => e.tab.label)).toEqual(["b", "a"]);
  });
});
