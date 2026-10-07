/**
 * The flat pane layer with many tabs (performance plan §5.1): the per-tab
 * derivation lives in a memoised `PaneSlot`, so a `groupRects` measure
 * re-renders the positioned boxes only (no slot), a change to one tab's entry
 * re-renders that one slot, and a redundant `setActive` on the already-active
 * tab writes nothing to the store (no layout rebuild to re-render from).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(undefined)) }));
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
    onFocusChanged: () => Promise.resolve(() => {}),
  }),
}));
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// A plain (un-memoised) stand-in: every render of a `PaneSlot` renders it once,
// so its per-key count is the slot's render count.
const renders = new Map<string, number>();
// The props of each slot's last render: what the derivation handed `TabPane`.
const lastProps = new Map<string, Record<string, unknown>>();
vi.mock("../../components/tabs/TabPane", () => ({
  TabPane: (props: { tab: { key: string }; visible: boolean }) => {
    renders.set(props.tab.key, (renders.get(props.tab.key) ?? 0) + 1);
    lastProps.set(props.tab.key, props as unknown as Record<string, unknown>);
    return <div data-testid={`pane-${props.tab.key}`} data-visible={String(props.visible)} />;
  },
}));

import { CenterPanel } from "../../components/layout/CenterPanel";
import { ROOT_SCOPE, allGroups, useTabsStore, type TabEntry } from "../../stores/tabs";
import { useProjectsStore } from "../../stores/projects";
import { useRemoteStatusStore } from "../../stores/remote/remoteStatus";
import { useRootOverlayStore } from "../../stores/rootOverlay";
import { useOverlayAgentStore } from "../../stores/overlayAgent";

const N = 60;
let keys: string[];

const total = () => [...renders.values()].reduce((a, b) => a + b, 0);

function rect(w: number, h: number): DOMRect {
  return { left: 0, top: 0, right: w, bottom: h, width: w, height: h, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
}

beforeEach(() => {
  cleanup();
  renders.clear();
  lastProps.clear();
  localStorage.clear();
  useRemoteStatusStore.setState({ byProject: {}, byHost: {} });
  useProjectsStore.setState({ projects: [], activeId: null, rootDir: "/r" });
  useTabsStore.setState({
    scope: ROOT_SCOPE,
    tabsByScope: { [ROOT_SCOPE]: [] },
    layoutByScope: { [ROOT_SCOPE]: null },
    focusedGroupByScope: { [ROOT_SCOPE]: null },
    detachedGroupsByScope: {},
    fullscreenGroupId: null,
  });
  useTabsStore.getState().setScope(ROOT_SCOPE);
  const s = useTabsStore.getState();
  keys = [];
  for (let i = 0; i < N; i++) {
    const tab: TabEntry = s.addTabToScope(ROOT_SCOPE, {
      label: `Shell ${i}`,
      cmd: "bash",
      cwd: "",
      kind: "shell",
    });
    keys.push(tab.key);
  }
  useRootOverlayStore.setState({ open: false, installTabs: {} });
  useOverlayAgentStore.setState({ shownKeys: new Set() });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pane layer memoisation (60 tabs)", () => {
  it("re-renders no PaneSlot on a groupRects change", async () => {
    render(<CenterPanel />);
    await act(async () => {});
    expect(renders.size).toBe(N);
    const before = total();

    // The layer measures group bodies off `getBoundingClientRect`; jsdom's is
    // all zeros, so a non-zero answer + the window-resize bridge is a real
    // rect change.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => rect(800, 600));
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
    });
    const shown = document.querySelector<HTMLElement>(".center-pane[style*='display: flex']");
    expect(shown?.style.width).toBe("800px");
    expect(total()).toBe(before);
  });

  it("re-renders exactly one PaneSlot when one tab's entry changes", async () => {
    render(<CenterPanel />);
    await act(async () => {});
    const before = new Map(renders);
    const target = keys[17];

    await act(async () => {
      useTabsStore.getState().renameTab(target, "Renamed");
    });
    for (const k of keys) {
      expect(renders.get(k), k).toBe((before.get(k) ?? 0) + (k === target ? 1 : 0));
    }
  });

  it("setActive on the already-active tab of the focused group writes nothing", async () => {
    render(<CenterPanel />);
    await act(async () => {});
    const st = useTabsStore.getState();
    const active = st.layout?.type === "group" ? st.layout.activeKey : null;
    expect(active).toBe(keys[N - 1]);
    const layoutBefore = st.layoutByScope;
    const tabsBefore = st.tabsByScope;
    const renderedBefore = total();

    await act(async () => {
      useTabsStore.getState().setActive(active!);
    });
    expect(useTabsStore.getState().layoutByScope).toBe(layoutBefore);
    expect(useTabsStore.getState().tabsByScope).toBe(tabsBefore);
    expect(total()).toBe(renderedBefore);

    // A real activation still goes through (and re-renders the two slots whose
    // visibility flips).
    await act(async () => {
      useTabsStore.getState().setActive(keys[0]);
    });
    expect(useTabsStore.getState().layoutByScope).not.toBe(layoutBefore);
    const after = useTabsStore.getState().layout;
    expect(after?.type === "group" ? after.activeKey : null).toBe(keys[0]);
    expect(total()).toBe(renderedBefore + 2);
  });
});

// ── The slot's memo keys: every input the derivation reads must reach it ──────
// A remote project `p` (primary host `host-a`) with ten shell tabs, beside the
// root scope's sixty: the root slots are the control group that must not
// re-render on anything that happens to `p`.
const P = "p";
const PN = 10;
let pKeys: string[];
const project = {
  id: P,
  name: "P",
  directory: "/p",
  local_file: "",
  remote: { host: "host-a", user: "u" },
  mirror: "/mirror/p",
};
const st = () => useTabsStore.getState();
const gid = (key: string) => allGroups(st().layout).find((g) => g.tabKeys.includes(key))!.id;
const visible = (key: string) =>
  document.querySelector(`[data-testid="pane-${key}"]`)?.getAttribute("data-visible");

async function mountProject() {
  useProjectsStore.setState({ projects: [project as never], activeId: P, rootDir: "/r" });
  useTabsStore.setState({
    tabsByScope: { ...st().tabsByScope, [P]: [] },
    layoutByScope: { ...st().layoutByScope, [P]: null },
  });
  st().setScope(P);
  pKeys = [];
  for (let i = 0; i < PN; i++) {
    pKeys.push(st().addTab({ label: `Remote ${i}`, cmd: "bash", cwd: "/p", kind: "shell" }).key);
  }
  useRemoteStatusStore.getState().setSsh(P, "connected");
  render(<CenterPanel />);
  await act(async () => {});
  expect(renders.size).toBe(N + PN);
  for (const k of pKeys) expect(lastProps.get(k)?.holdRemoteTerminal).toBe(false);
}

/** Render count delta per key since `before`. */
function delta(before: Map<string, number>, key: string): number {
  return (renders.get(key) ?? 0) - (before.get(key) ?? 0);
}

describe("PaneSlot memo keys", () => {
  it("a remote status flip re-renders the project's slots with the hold, none of root's", async () => {
    await mountProject();
    const before = new Map(renders);
    await act(async () => {
      useRemoteStatusStore.getState().setSsh(P, "disconnected");
    });
    for (const k of pKeys) {
      expect(delta(before, k), k).toBe(1);
      expect(lastProps.get(k)?.holdRemoteTerminal).toBe(true);
      // A remote-located shell keeps its remote cwd (the mirror fallback is
      // for local-located tabs and the Files browse dir).
      expect(lastProps.get(k)?.terminalCwd).toBe("/p");
    }
    for (const k of keys) expect(delta(before, k), k).toBe(0);
    await act(async () => {
      useRemoteStatusStore.getState().setSsh(P, "connected");
    });
    for (const k of pKeys) expect(lastProps.get(k)?.holdRemoteTerminal).toBe(false);
  });

  it("a project record change reaches every slot of that project once", async () => {
    await mountProject();
    const before = new Map(renders);
    // The store's own write shape (`patchProject`): a fresh entry, same list slot.
    await act(async () => {
      useProjectsStore.setState({
        projects: [{ ...project, remote: { ...project.remote, host: "host-b" } } as never],
      });
    });
    for (const k of pKeys) {
      expect(delta(before, k), k).toBe(1);
      expect(lastProps.get(k)?.remoteHost).toBe("host-b");
    }
    for (const k of keys) expect(delta(before, k), k).toBe(0);
  });

  it("a tab moved to another group re-renders that slot with its new group only", async () => {
    await mountProject();
    const g1 = gid(pKeys[2]);
    const before = new Map(renders);
    await act(async () => {
      st().splitWithTab(pKeys[2], g1, "right");
    });
    const g2 = gid(pKeys[2]);
    expect(g2).not.toBe(g1);
    expect(lastProps.get(pKeys[2])?.groupId).toBe(g2);
    expect(visible(pKeys[2])).toBe("true");
    // The tabs neither moved nor active anywhere keep their props: no render.
    for (const k of pKeys) {
      if (k === pKeys[2] || k === pKeys[PN - 1]) continue;
      expect(delta(before, k), k).toBe(0);
    }
    for (const k of keys) expect(delta(before, k), k).toBe(0);
  });

  it("a scope switch hides the project's panes and shows them again on return", async () => {
    await mountProject();
    const active = pKeys[PN - 1];
    expect(visible(active)).toBe("true");
    const cwdBefore = lastProps.get(active)?.terminalCwd;
    await act(async () => {
      st().setScope(ROOT_SCOPE);
    });
    expect(visible(active)).toBe("false");
    expect(visible(keys[N - 1])).toBe("true");
    // The pane stays mounted and keeps its own project's answers.
    expect(lastProps.get(active)?.holdRemoteTerminal).toBe(false);
    await act(async () => {
      st().setScope(P);
    });
    expect(visible(active)).toBe("true");
    expect(visible(keys[N - 1])).toBe("false");
    expect(lastProps.get(active)?.terminalCwd).toBe(cwdBefore);
  });

  it("detaching a group hides its slot (still mounted) and re-attaching shows it", async () => {
    await mountProject();
    await act(async () => {
      st().splitWithTab(pKeys[2], gid(pKeys[2]), "right");
    });
    const g2 = gid(pKeys[2]);
    expect(visible(pKeys[2])).toBe("true");
    await act(async () => {
      st().detachGroup(g2, { skipBackend: true });
    });
    const detached = st().detachedGroupsByScope[P]?.[0];
    expect(detached?.id).toBe(g2);
    expect(visible(pKeys[2])).toBe("false");
    expect(lastProps.get(pKeys[2])?.groupId).toBeUndefined();
    await act(async () => {
      st().attachGroup(g2, { skipBackend: true });
    });
    expect(visible(pKeys[2])).toBe("true");
    expect(lastProps.get(pKeys[2])?.groupId).toBe(gid(pKeys[2]));
  });

  it("setActive on the active tab of an unfocused group still moves focus there", async () => {
    await mountProject();
    const g1 = gid(pKeys[PN - 1]);
    await act(async () => {
      st().splitWithTab(pKeys[2], g1, "right");
    });
    const g2 = gid(pKeys[2]);
    expect(st().focusedGroupId).toBe(g2);
    expect(lastProps.get(pKeys[PN - 1])?.focused).toBe(false);
    const layoutBefore = st().layoutByScope;
    await act(async () => {
      st().setActive(pKeys[PN - 1]);
    });
    expect(st().focusedGroupId).toBe(g1);
    expect(st().layoutByScope).not.toBe(layoutBefore);
    expect(lastProps.get(pKeys[PN - 1])?.focused).toBe(true);
    expect(lastProps.get(pKeys[2])?.focused).toBe(false);
  });
});
