/**
 * Tests for file-link open routing (#50):
 *  - the session-only linkRouting store records/looks-up/purges per-tab routes;
 *  - openLinkedFile opens a link in the SAME subwindow as the linking tab by
 *    default, honours a recorded override group, and re-activates an existing
 *    viewer tab instead of duplicating;
 *  - closing the linking tab purges its routes (wired via removeTab).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));

import { useLinkRoutingStore } from "../../stores/linkRouting";
import {
  useTabsStore,
  findGroupOfTab,
  type GroupNode,
  type SplitNode,
} from "../../stores/tabs";
import { openLinkedFile } from "../../components/embed/fileViewer/openLinked";

beforeEach(() => {
  useLinkRoutingStore.setState({ routes: {} });
  // Reset the tabs store to a clean root scope.
  useTabsStore.setState({
    scope: "root",
    tabsByScope: {},
    layoutByScope: {},
    focusedGroupByScope: {},
    tabs: [],
    layout: null,
    focusedGroupId: null,
    activeKey: null,
  });
});

describe("linkRouting store", () => {
  it("records and looks up a route keyed by (tab, path)", () => {
    const s = useLinkRoutingStore.getState();
    s.setRoute("tab-1", "/p/a.tex", "g-9");
    expect(useLinkRoutingStore.getState().getRoute("tab-1", "/p/a.tex")).toBe("g-9");
    // Different tab or path → no route.
    expect(useLinkRoutingStore.getState().getRoute("tab-2", "/p/a.tex")).toBeNull();
    expect(useLinkRoutingStore.getState().getRoute("tab-1", "/p/b.tex")).toBeNull();
  });

  it("purges every route originating from a tab", () => {
    const s = useLinkRoutingStore.getState();
    s.setRoute("tab-1", "/p/a.tex", "g-1");
    s.setRoute("tab-1", "/p/b.tex", "g-2");
    s.setRoute("tab-2", "/p/a.tex", "g-3");
    useLinkRoutingStore.getState().purgeForTab("tab-1");
    const after = useLinkRoutingStore.getState();
    expect(after.getRoute("tab-1", "/p/a.tex")).toBeNull();
    expect(after.getRoute("tab-1", "/p/b.tex")).toBeNull();
    // The other tab's route survives.
    expect(after.getRoute("tab-2", "/p/a.tex")).toBe("g-3");
  });
});

describe("openLinkedFile", () => {
  it("opens the link in the SAME group as the linking tab by default", () => {
    const store = useTabsStore.getState();
    const linker = store.addTab({ label: "main.tex", cmd: "", cwd: "/p", kind: "embed", embedPath: "/p/main.tex", viewer: "tex" });
    const linkerGroup = findGroupOfTab(useTabsStore.getState().layout, linker.key)!.group.id;

    openLinkedFile(linker.key, "/p", { path: "/p/intro.tex", viewer: "tex", label: "intro.tex" });

    const opened = useTabsStore.getState().tabs.find((t) => t.embedPath === "/p/intro.tex");
    expect(opened).toBeTruthy();
    // It lands in the linking tab's group (center-added, no split).
    const openedGroup = findGroupOfTab(useTabsStore.getState().layout, opened!.key)!.group.id;
    expect(openedGroup).toBe(linkerGroup);
  });

  it("honours a recorded override group over the same-subwindow default", () => {
    const store = useTabsStore.getState();
    const linker = store.addTab({ label: "main.tex", cmd: "", cwd: "/p", kind: "embed", embedPath: "/p/main.tex", viewer: "tex" });
    // Split off a second subwindow holding another tab so there are two groups.
    const other = store.addTab({ label: "shell", cmd: "", cwd: "/p", kind: "shell" });
    useTabsStore.getState().splitWithTab(other.key, findGroupOfTab(useTabsStore.getState().layout, linker.key)!.group.id, "right");

    const otherGroup = findGroupOfTab(useTabsStore.getState().layout, other.key)!.group.id;
    useLinkRoutingStore.getState().setRoute(linker.key, "/p/fig.png", otherGroup);

    openLinkedFile(linker.key, "/p", { path: "/p/fig.png", viewer: "image", label: "fig.png" });

    const opened = useTabsStore.getState().tabs.find((t) => t.embedPath === "/p/fig.png")!;
    const openedGroup = findGroupOfTab(useTabsStore.getState().layout, opened.key)!.group.id;
    expect(openedGroup).toBe(otherGroup);
  });

  it("re-activates an existing viewer tab for the same file instead of duplicating", () => {
    const store = useTabsStore.getState();
    const linker = store.addTab({ label: "main.tex", cmd: "", cwd: "/p", kind: "embed", embedPath: "/p/main.tex", viewer: "tex" });
    openLinkedFile(linker.key, "/p", { path: "/p/intro.tex", viewer: "tex", label: "intro.tex" });
    const countAfterFirst = useTabsStore.getState().tabs.filter((t) => t.embedPath === "/p/intro.tex").length;
    openLinkedFile(linker.key, "/p", { path: "/p/intro.tex", viewer: "tex", label: "intro.tex" });
    const countAfterSecond = useTabsStore.getState().tabs.filter((t) => t.embedPath === "/p/intro.tex").length;
    expect(countAfterFirst).toBe(1);
    expect(countAfterSecond).toBe(1);
  });

  it("marks only a newly opened markdown tab with its graph return target", () => {
    const store = useTabsStore.getState();
    const linker = store.addTab({ label: "map.md", cmd: "", cwd: "/p", kind: "embed", embedPath: "/p/map.md", viewer: "markdown" });
    const existing = store.addTab({ label: "existing.md", cmd: "", cwd: "/p", kind: "embed", embedPath: "/p/existing.md", viewer: "markdown" });

    openLinkedFile(linker.key, "/p", { path: "/p/new.md", viewer: "markdown", label: "new.md", mdGraphOriginKey: linker.key });
    openLinkedFile(linker.key, "/p", { path: "/p/existing.md", viewer: "markdown", label: "existing.md", mdGraphOriginKey: linker.key });

    expect(useTabsStore.getState().tabs.find((t) => t.embedPath === "/p/new.md")?.mdGraphOriginKey).toBe(linker.key);
    expect(useTabsStore.getState().tabs.find((t) => t.key === existing.key)?.mdGraphOriginKey).toBeUndefined();
  });

  it("removeTab purges the closed tab's link routes", () => {
    const store = useTabsStore.getState();
    const linker = store.addTab({ label: "main.tex", cmd: "", cwd: "/p", kind: "embed", embedPath: "/p/main.tex", viewer: "tex" });
    useLinkRoutingStore.getState().setRoute(linker.key, "/p/x.tex", "g-1");
    useTabsStore.getState().removeTab(linker.key);
    expect(useLinkRoutingStore.getState().getRoute(linker.key, "/p/x.tex")).toBeNull();
  });
});

// Silence unused-type warnings for the imported node types (kept for clarity).
export type _Nodes = GroupNode | SplitNode;
