/**
 * The cockpit's detail-pane plumbing (`docs/desktop_cockpit_plan.md` C2): a
 * project's tab drawn attach-only in the cockpit stands its owning pane in
 * `CenterPanel` down — one visible view per PTY — and its slot says where the
 * tab went instead of going blank. Root and Tabby keep their own shown sets,
 * unchanged. A sleeping owner is woken (drawn elsewhere), a popout-owned tab
 * and one whose remote host is down are never attached.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useEffect } from "react";

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

const mounts = new Map<string, number>();
vi.mock("../../components/tabs/TabPane", () => {
  function TabPane(props: { tab: { key: string }; scope: string; visible: boolean; focused: boolean; attachOnly?: boolean }) {
    const id = `${props.attachOnly ? "attached" : "pane"}-${props.tab.key}`;
    useEffect(() => {
      mounts.set(id, (mounts.get(id) ?? 0) + 1);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return <div data-testid={id} data-visible={String(props.visible)} data-focused={String(props.focused)} />;
  }
  return { TabPane };
});

import { CenterPanel } from "../../components/layout/CenterPanel";
import { CockpitDetailPane, cockpitDetailMode, popoutLabelOf } from "../../components/cockpit/CockpitDetailPane";
import { ROOT_SCOPE, useTabsStore, type TabEntry } from "../../stores/tabs";
import { useProjectsStore } from "../../stores/projects";
import { useRootOverlayStore } from "../../stores/rootOverlay";
import { isShownElsewhere, useOverlayAgentStore } from "../../stores/overlayAgent";
import { useRemoteStatusStore } from "../../stores/remote/remoteStatus";
import { useSettingsStore } from "../../stores/settings";
import { ASSISTANT_SCOPE } from "../../lib/assistant";
import { SLEEP_TABS_DEFAULT_MIN } from "../../lib/sleepWhenHidden";
import { _clearAsleepPtysForTest } from "../../lib/terminal/sleepingPtys";
import type { ProjectEntry } from "../../types";

const P = "p-cockpit";
const project: ProjectEntry = { id: P, name: "Paper", status: "active", position: 1, local_file: "/p/project.json", path: "/p" } as ProjectEntry;

let drawn: TabEntry;
let other: TabEntry;
const st = () => useTabsStore.getState();
const visible = (key: string) => document.querySelector(`[data-testid="pane-${key}"]`)?.getAttribute("data-visible");
const mounted = (key: string) => document.querySelector(`[data-testid="pane-${key}"]`) != null;
const standDowns = () => document.querySelectorAll(".center-pane-standdown").length;

function resetStores() {
  useProjectsStore.setState({ projects: [project], activeId: P, rootDir: "/r" });
  useTabsStore.setState({
    scope: P,
    tabsByScope: { [P]: [], [ROOT_SCOPE]: [] },
    layoutByScope: { [P]: null, [ROOT_SCOPE]: null },
    focusedGroupByScope: { [P]: null, [ROOT_SCOPE]: null },
    detachedGroupsByScope: {},
    fullscreenGroupId: null,
  });
  st().setScope(P);
  other = st().addTabToScope(P, { label: "Shell", cmd: "bash", cwd: "/p", kind: "shell" });
  drawn = st().addTabToScope(P, { label: "Claude", cmd: "claude", cwd: "/p", kind: "agent" });
  useRootOverlayStore.setState({ open: false, installTabs: {} });
  useOverlayAgentStore.setState({ shownKeys: new Set(), assistantShownKeys: new Set(), scopeShownKeys: new Set() });
  useRemoteStatusStore.setState({ byProject: {}, byHost: {} });
  useSettingsStore.setState({ settings: null });
}

beforeEach(() => {
  cleanup();
  mounts.clear();
  _clearAsleepPtysForTest();
  localStorage.clear();
  resetStores();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the shown sets", () => {
  it("records a project's tab by PTY id, and root and Tabby keys as before", () => {
    const store = useOverlayAgentStore.getState();
    store.markShown("k1");
    store.markShown("k2", ASSISTANT_SCOPE);
    store.markShown("k3", P);
    const s = useOverlayAgentStore.getState();
    expect([...s.shownKeys]).toEqual(["k1"]);
    expect([...s.assistantShownKeys]).toEqual(["k2"]);
    expect([...s.scopeShownKeys]).toEqual([`${P}:k3`]);
    expect(isShownElsewhere(s, ROOT_SCOPE, "k1")).toBe(true);
    expect(isShownElsewhere(s, P, "k1")).toBe(false);
    expect(isShownElsewhere(s, P, "k3")).toBe(true);
    s.unmarkShown("k3", P);
    expect(useOverlayAgentStore.getState().scopeShownKeys.size).toBe(0);
    expect(useOverlayAgentStore.getState().shownKeys.size).toBe(1);
  });

  it("keeps the set's identity while nothing changes", () => {
    useOverlayAgentStore.getState().markShown("k", P);
    const before = useOverlayAgentStore.getState().scopeShownKeys;
    useOverlayAgentStore.getState().markShown("k", P);
    expect(useOverlayAgentStore.getState().scopeShownKeys).toBe(before);
  });
});

describe("CenterPanel stands a project's pane down for the cockpit", () => {
  beforeEach(() => {
    const group = st().layoutByScope[P];
    if (group?.type !== "group") throw new Error("expected one group");
    st().splitWithTabInScope(P, drawn.key, group.id, "right");
  });

  it("shows both panes while nothing else draws them", async () => {
    render(<CenterPanel />);
    await act(async () => {});
    expect(visible(other.key)).toBe("true");
    expect(visible(drawn.key)).toBe("true");
    expect(standDowns()).toBe(0);
  });

  it("hides only the drawn tab, with a placeholder in its slot, and gives it back on unmark", async () => {
    render(<CenterPanel />);
    await act(async () => {
      useOverlayAgentStore.getState().markShown(drawn.key, P);
    });
    expect(visible(drawn.key)).toBe("false");
    expect(document.querySelector(`[data-testid="pane-${drawn.key}"]`)?.getAttribute("data-focused")).toBe("false");
    expect(visible(other.key)).toBe("true");
    // The pane stays mounted (it owns the PTY): hidden, never unmounted.
    expect(mounts.get(`pane-${drawn.key}`)).toBe(1);
    expect(standDowns()).toBe(1);

    await act(async () => {
      useOverlayAgentStore.getState().unmarkShown(drawn.key, P);
    });
    expect(visible(drawn.key)).toBe("true");
    expect(standDowns()).toBe(0);
    expect(mounts.get(`pane-${drawn.key}`)).toBe(1);
  });

  it("Show here closes the cockpit", async () => {
    useRootOverlayStore.setState({ open: true, view: "now" });
    render(<CenterPanel />);
    await act(async () => {
      useOverlayAgentStore.getState().markShown(drawn.key, P);
    });
    await act(async () => {
      (document.querySelector(".center-pane-standdown button") as HTMLButtonElement).click();
    });
    expect(useRootOverlayStore.getState().open).toBe(false);
  });

  it("draws no placeholder for a tab of a scope not on screen", async () => {
    render(<CenterPanel />);
    await act(async () => {
      useOverlayAgentStore.getState().markShown(drawn.key, "elsewhere");
    });
    expect(visible(drawn.key)).toBe("true");
    expect(standDowns()).toBe(0);
  });

  it("leaves root's stand-down to root's own set", async () => {
    render(<CenterPanel />);
    await act(async () => {
      useOverlayAgentStore.getState().markShown(drawn.key);
    });
    // A root key never hides a project's tab, whatever its key.
    expect(visible(drawn.key)).toBe("true");
  });
});

describe("the detail pane", () => {
  it("attaches to the tab and marks it shown while mounted, then unmarks", async () => {
    const { unmount } = render(<CockpitDetailPane ptyId={`${P}:${drawn.key}`} focused={false} />);
    await act(async () => {});
    expect(screen.getByTestId(`attached-${drawn.key}`)).toBeTruthy();
    expect(useOverlayAgentStore.getState().scopeShownKeys.has(`${P}:${drawn.key}`)).toBe(true);
    unmount();
    expect(useOverlayAgentStore.getState().scopeShownKeys.size).toBe(0);
  });

  it("switching the selection hands the key over, never holding two", async () => {
    const { rerender } = render(<CockpitDetailPane ptyId={`${P}:${drawn.key}`} focused={false} />);
    await act(async () => {});
    rerender(<CockpitDetailPane ptyId={`${P}:${other.key}`} focused={false} />);
    await act(async () => {});
    expect([...useOverlayAgentStore.getState().scopeShownKeys]).toEqual([`${P}:${other.key}`]);
  });

  it("never attaches to a popout-owned tab", async () => {
    useTabsStore.setState({
      detachedGroupsByScope: {
        [P]: [{ id: "g9", label: "popout-g9", subtree: { type: "group", id: "g9", tabKeys: [drawn.key], activeKey: drawn.key } }],
      },
    });
    expect(popoutLabelOf(st().detachedGroupsByScope, P, drawn.key)).toBe("popout-g9");
    render(<CockpitDetailPane ptyId={`${P}:${drawn.key}`} focused={false} />);
    await act(async () => {});
    expect(screen.queryByTestId(`attached-${drawn.key}`)).toBeNull();
    expect(useOverlayAgentStore.getState().scopeShownKeys.size).toBe(0);
    expect(document.querySelector(".cockpit-detail-note button")).toBeTruthy();
  });

  it("never attaches to a remote tab whose host is down", async () => {
    const remote = { ...project, remote: { host: "gpu" } } as unknown as ProjectEntry;
    useProjectsStore.setState({ projects: [remote] });
    const sshTab = st().addTabToScope(P, { label: "ssh", cmd: "bash", cwd: "/p", kind: "shell", location: "remote" });
    expect(cockpitDetailMode(sshTab, { popout: null, held: true })).toBe("held");
    render(<CockpitDetailPane ptyId={`${P}:${sshTab.key}`} focused={false} />);
    await act(async () => {});
    expect(useOverlayAgentStore.getState().scopeShownKeys.size).toBe(0);
  });

  it("says so for a tab that closed", async () => {
    render(<CockpitDetailPane ptyId={`${P}:gone`} focused={false} />);
    await act(async () => {});
    expect(useOverlayAgentStore.getState().scopeShownKeys.size).toBe(0);
    expect(document.querySelector(".cockpit-detail-note")).toBeTruthy();
  });
});

describe("a root tab in the detail pane", () => {
  const shownRoot = () => [...useOverlayAgentStore.getState().shownKeys];
  const attachedViews = (key: string) => document.querySelectorAll(`[data-testid="attached-${key}"]`).length;
  let rootTab: TabEntry;
  beforeEach(() => {
    rootTab = st().addTabToScope(ROOT_SCOPE, { label: "Rooty", cmd: "claude", cwd: "", kind: "agent" });
    useRootOverlayStore.setState({ open: true, view: "now", installTabs: {} });
    useOverlayAgentStore.setState({
      docks: { mail: { key: null, open: false }, calendar: { key: null, open: false }, todo: { key: null, open: false } },
    });
  });

  it("is attached like any tab, through root's own shown set, and unmarked on unmount", async () => {
    const { unmount } = render(<CockpitDetailPane ptyId={`${ROOT_SCOPE}:${rootTab.key}`} focused={false} />);
    await act(async () => {});
    expect(attachedViews(rootTab.key)).toBe(1);
    expect(shownRoot()).toEqual([rootTab.key]);
    expect(useOverlayAgentStore.getState().scopeShownKeys.size).toBe(0);
    unmount();
    expect(shownRoot()).toEqual([]);
  });
});

describe("a sleeping owner", () => {
  it("is woken and kept awake while the cockpit draws it", async () => {
    vi.useFakeTimers();
    // The drawn tab hidden behind the other one in the same subwindow.
    st().setActive(other.key);
    render(<CenterPanel />);
    await act(async () => {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SLEEP_TABS_DEFAULT_MIN * 60_000 * 2);
    });
    expect(mounted(drawn.key)).toBe(false);
    await act(async () => {
      useOverlayAgentStore.getState().markShown(drawn.key, P);
    });
    expect(mounted(drawn.key)).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SLEEP_TABS_DEFAULT_MIN * 60_000 * 2);
    });
    expect(mounted(drawn.key)).toBe(true);
  });
});
