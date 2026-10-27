/**
 * A `.tex` followed from a workspace must never scatter copies into ROOT.
 *
 *  - In a popout, the heap's own tabs store never leaves its default scope
 *    `"root"`, so a plain `addTab` (the fallback `openLinkedFile` takes for a
 *    Ctrl+clicked `\input`) was shipped to the main window as add-to-root — a
 *    fresh copy per click. It must go out as the popout's own `add`.
 *  - A `.tex` editor tab that healed into a workspace still dedupes a later
 *    open of the same file.
 *  - SyncTeX reverse search finds the root console's workspace while the
 *    console floats over a project, instead of opening the source again.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string, args?: Record<string, unknown>) =>
    Promise.resolve(cmd === "resolve_tex_root" ? (args?.path as string) : null),
  ),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(() => Promise.resolve()),
}));

import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { setDetachedWindowContext } from "../../stores/detachedContext";
import { useRootOverlayStore } from "../../stores/rootOverlay";
import { openLinkedFile } from "../../components/embed/fileViewer/openLinked";
import { focusTexWorkspaceForSource } from "../../lib/viewers/tex/openTexWorkspace";

const DOC = "/p1/sgd_delta_rule.tex";
const tabsOf = (scope: string): TabEntry[] => useTabsStore.getState().tabsByScope[scope] ?? [];

beforeEach(() => {
  useTabsStore.setState({
    scope: "p1",
    tabs: [],
    layout: null,
    focusedGroupId: null,
    activeKey: null,
    tabsByScope: { p1: [], root: [] },
    layoutByScope: { p1: null, root: null },
    focusedGroupByScope: { p1: null, root: null },
  });
  useRootOverlayStore.setState({ open: false });
});

afterEach(() => {
  setDetachedWindowContext(null);
});

describe("a followed .tex stays out of root", () => {
  it("in a popout, a link open is the popout's own add, never an add-to-root", () => {
    // A popout heap: no tabs, and the store's scope still the default "root".
    useTabsStore.setState({ scope: "root", tabsByScope: {}, layoutByScope: {} });
    const edits: { kind: string }[] = [];
    setDetachedWindowContext({
      scope: "p1",
      groupId: "g-1",
      label: "detached-p1-g-1",
      targetGroupId: () => "g-1",
      pushEdit: (e) => edits.push(e as { kind: string }),
      closeTab: () => {},
    });
    // The workspace's child pane key is synthetic (`<tabKey>#<path>`).
    openLinkedFile("t1#/p1/main.tex", "/p1", { path: DOC, viewer: "tex", label: "sgd_delta_rule.tex" });
    const adds = edits.filter((e) => e.kind === "add" || e.kind === "addToScope");
    expect(adds).toHaveLength(1);
    expect(adds[0]).toMatchObject({ kind: "add", tab: { embedPath: DOC, viewer: "tex" } });
  });

  it("a .tex tab that healed into a workspace is focused, not copied", () => {
    const ws = useTabsStore.getState().addTab({
      label: "sgd_delta_rule.tex",
      cmd: "",
      cwd: "/p1",
      kind: "embed",
      embedPath: DOC,
      viewer: "texworkspace",
    });
    useTabsStore.getState().addTab({ label: "Shell", cmd: "", cwd: "/p1", kind: "shell" });
    openLinkedFile(undefined, "/p1", { path: DOC, viewer: "tex", label: "sgd_delta_rule.tex" });
    expect(tabsOf("p1").filter((t) => t.embedPath === DOC)).toHaveLength(1);
    expect(useTabsStore.getState().layout).toMatchObject({ activeKey: ws.key });
  });

  it("reverse search finds the floating console's workspace", async () => {
    const ws = useTabsStore.getState().addTabToScope("root", {
      label: "sgd_delta_rule.tex",
      cmd: "",
      cwd: "/p1",
      kind: "embed",
      embedPath: DOC,
      viewer: "texworkspace",
    });
    // Closed console: its tabs are not on screen, so nothing is claimed.
    expect(await focusTexWorkspaceForSource(DOC)).toBe(false);
    useRootOverlayStore.setState({ open: true });
    expect(await focusTexWorkspaceForSource(DOC)).toBe(true);
    expect(tabsOf("root").map((t) => t.key)).toEqual([ws.key]);
    expect(tabsOf("p1")).toHaveLength(0);
  });
});
