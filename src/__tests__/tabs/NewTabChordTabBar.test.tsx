/**
 * The new-tab chords land through the focused pane's `TabBar`: a shell, the
 * System Monitor and the numbered agents open there as the active tab (which
 * is what hands a terminal the keyboard), an unused number is left alone, and
 * the + menu shows each chord beside its row. Steering's requests
 * (`besideActive`) land right of the active tab, chords at the pane's end.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, cleanup, fireEvent } from "@testing-library/react";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(() => Promise.resolve()),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    scaleFactor: () => Promise.resolve(1),
    innerPosition: () => Promise.resolve({ toLogical: () => ({ x: 0, y: 0 }) }),
    onMoved: () => Promise.resolve(() => {}),
    onResized: () => Promise.resolve(() => {}),
  }),
  cursorPosition: () => Promise.resolve({ x: 0, y: 0 }),
}));

import { TabBar } from "../../components/tabs/TabBar";
import { findGroup, useTabsStore } from "../../stores/tabs";
import { useProjectsStore } from "../../stores/projects";
import { useSettingsStore } from "../../stores/settings";
import { requestNewTab } from "../../lib/shortcuts/newTabChord";
import type { ProjectEntry, Settings } from "../../types";

const proj: ProjectEntry = {
  id: "p1",
  name: "p1",
  status: "active",
  position: 10,
  local_file: "/p/p1/project.json",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockInvoke.mockImplementation((cmd: string) => {
    if (cmd === "list_agents") {
      return Promise.resolve([
        { id: "claude", bin: "claude", installed: true },
        { id: "codex", bin: "codex", installed: true },
      ]);
    }
    // No linked worktrees, so an agent opens without the worktree question.
    if (cmd === "git_worktree_list") return Promise.resolve([]);
    return Promise.resolve(null);
  });
  useProjectsStore.setState({ projects: [proj], activeId: "p1", loaded: true });
  useSettingsStore.setState({ settings: { default_agent_cmd: "codex" } as Settings });
  useTabsStore.setState({
    scope: "p1",
    tabsByScope: {},
    layoutByScope: {},
    focusedGroupByScope: {},
    tabs: [],
    layout: null,
    focusedGroupId: null,
    activeKey: null,
  });
});
afterEach(() => cleanup());

async function renderBar() {
  useTabsStore.getState().setScope("p1");
  useTabsStore
    .getState()
    .addTab({ label: "Files", cmd: "", args: [], env: {}, cwd: "/p/p1", kind: "shell" });
  const groupId = useTabsStore.getState().focusedGroupId!;
  let container!: HTMLElement;
  await act(async () => {
    ({ container } = render(<TabBar groupId={groupId} projectCwd="/p/p1" showGroupClose={false} />));
  });
  return { groupId, container };
}

function activeTab(groupId: string) {
  const s = useTabsStore.getState();
  const key = findGroup(s.layout, groupId)?.activeKey;
  return s.tabs.find((t) => t.key === key);
}

describe("new-tab chords", () => {
  it("opens a shell and the monitor as the focused pane's active tab", async () => {
    const { groupId } = await renderBar();
    let took = false;
    await act(async () => {
      took = requestNewTab({ kind: "shell" });
    });
    expect(took).toBe(true);
    expect(useTabsStore.getState().tabs).toHaveLength(2);
    expect(activeTab(groupId)?.kind).toBe("shell");
    await act(async () => {
      requestNewTab({ kind: "monitor" });
    });
    expect(activeTab(groupId)?.kind).toBe("monitor");
  });

  it("opens the default agent on Ctrl+1 and the next one on Ctrl+2", async () => {
    const { groupId } = await renderBar();
    await act(async () => {
      requestNewTab({ kind: "agent", slot: 0 });
    });
    expect(activeTab(groupId)?.cmd).toBe("codex");
    await act(async () => {
      requestNewTab({ kind: "agent", slot: 1 });
    });
    expect(activeTab(groupId)?.cmd).toBe("claude");
  });

  it("passes an agent number with nothing behind it", async () => {
    await renderBar();
    let took = true;
    await act(async () => {
      took = requestNewTab({ kind: "agent", slot: 5 });
    });
    expect(took).toBe(false);
    expect(useTabsStore.getState().tabs).toHaveLength(1);
  });

  it("shows the chords in the + menu", async () => {
    const { container } = await renderBar();
    await act(async () => {
      fireEvent.click(container.querySelector(".tab-new-btn")!);
    });
    const hint = (label: string) =>
      [...document.querySelectorAll(".tab-new-menu button")]
        .find((el) => el.querySelector(".tab-new-menu-dot")?.nextSibling?.textContent === label)
        ?.querySelector(".menu-shortcut")?.textContent;
    expect(hint("Codex")).toBe("Ctrl+1");
    expect(hint("Claude")).toBe("Ctrl+2");
    expect(hint("Shell")).toBe("Ctrl+Shift+N");
    expect(hint("System Monitor")).toBe("Ctrl+Shift+M");
  });
});

describe("steering's new tabs land beside the active one", () => {
  // Files | a | b, with Files active.
  async function renderThree() {
    const bar = await renderBar();
    const add = (label: string) =>
      useTabsStore
        .getState()
        .addTab({ label, cmd: "", args: [], env: {}, cwd: "/p/p1", kind: "shell" });
    add("a");
    add("b");
    const first = findGroup(useTabsStore.getState().layout, bar.groupId)!.tabKeys[0];
    act(() => useTabsStore.getState().setGroupActive(bar.groupId, first));
    return bar;
  }
  const order = (groupId: string) => {
    const s = useTabsStore.getState();
    return findGroup(s.layout, groupId)!.tabKeys.map(
      (k) => s.tabs.find((t) => t.key === k)!,
    );
  };

  it("puts a steering shell, monitor and agent right of the active tab", async () => {
    const { groupId } = await renderThree();
    await act(async () => {
      requestNewTab({ kind: "shell" }, { besideActive: true });
    });
    expect(order(groupId).map((t) => t.label)).toEqual(["Files", "Shell", "a", "b"]);
    await act(async () => {
      requestNewTab({ kind: "monitor" }, { besideActive: true });
    });
    expect(order(groupId)[2].kind).toBe("monitor");
    await act(async () => {
      requestNewTab({ kind: "agent", slot: 0 }, { besideActive: true });
    });
    expect(order(groupId)[3].cmd).toBe("codex");
    expect(order(groupId)).toHaveLength(6);
  });

  it("keeps a chord's tab at the end", async () => {
    const { groupId } = await renderThree();
    await act(async () => {
      requestNewTab({ kind: "shell" });
    });
    expect(order(groupId).map((t) => t.label)).toEqual(["Files", "a", "b", "Shell"]);
  });

  it("places a pick from a menu steering opened, and only that one", async () => {
    const { groupId, container } = await renderThree();
    await act(async () => {
      requestNewTab({ kind: "menu" }, { besideActive: true });
    });
    const shellRow = () =>
      [...document.querySelectorAll<HTMLButtonElement>(".tab-new-menu button")].find(
        (el) => el.querySelector(".tab-new-menu-dot")?.nextSibling?.textContent === "Shell",
      )!;
    await act(async () => {
      fireEvent.click(shellRow());
    });
    expect(order(groupId)[1].label).toBe("Shell");
    // The menu closed; a mouse-opened one appends again.
    await act(async () => {
      fireEvent.click(container.querySelector(".tab-new-btn")!);
    });
    await act(async () => {
      fireEvent.click(shellRow());
    });
    expect(order(groupId)).toHaveLength(5);
    expect(order(groupId)[4].key).toBe(activeTab(groupId)?.key);
  });
});
