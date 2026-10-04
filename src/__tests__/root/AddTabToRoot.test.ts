/**
 * `addTabToRoot` — the root-tab door without the console, for a view that
 * shows the tab somewhere else (an app overlay's docked agent column). It
 * keeps the console door's hydrate-first rule: a root never restored this
 * session is restored BEFORE the tab is added, or the add would mark the scope
 * hydrated and the host's persist would write the lone new tab over the saved
 * layout. Unlike `openTabInRootConsole`, it never opens the console.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import { allGroups, useTabsStore, type TabEntry } from "../../stores/tabs";
import { setDetachedWindowContext, type ForwardedEdit } from "../../stores/detachedContext";
import { addTabToRoot, openTabInRootConsole, useRootOverlayStore } from "../../stores/rootOverlay";

const rootTabs = () => useTabsStore.getState().tabsByScope.root ?? [];
const spec = { label: "Agent", cmd: "claude", args: [], env: {}, cwd: "/r", kind: "agent" as const };

function unhydratedRootWithSavedShell() {
  useTabsStore.setState({ tabsByScope: {}, layoutByScope: {}, focusedGroupByScope: {} });
  vi.mocked(invoke).mockImplementation((cmd: string) =>
    Promise.resolve(
      cmd === "workspace_snapshot"
        ? { tabLayout: [{ label: "Saved shell", cmd: "", cwd: "/r", kind: "shell" }] }
        : "/r",
    ),
  );
}

beforeEach(() => {
  setDetachedWindowContext(null);
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValue({});
  useTabsStore.setState({
    scope: "p1",
    tabsByScope: { root: [] },
    layoutByScope: { root: null },
    focusedGroupByScope: { root: null },
  });
  useRootOverlayStore.setState({ open: false, installTabs: {} });
});

describe("addTabToRoot", () => {
  it("adds a root tab and hands it to onOpened synchronously when root is hydrated", () => {
    const opened = vi.fn<(tab: TabEntry) => void>();

    addTabToRoot(spec, opened);

    expect(rootTabs()).toHaveLength(1);
    expect(rootTabs()[0]).toMatchObject({ label: "Agent", cmd: "claude", kind: "agent" });
    expect(opened).toHaveBeenCalledTimes(1);
    expect(opened.mock.calls[0][0].key).toBe(rootTabs()[0].key);
    expect(useTabsStore.getState().scope).toBe("p1");
  });

  it("does not open the root console", () => {
    addTabToRoot(spec);

    expect(rootTabs()).toHaveLength(1);
    expect(useRootOverlayStore.getState().open).toBe(false);
  });

  it("restores a root never opened this session before adding the tab", async () => {
    unhydratedRootWithSavedShell();
    const opened = vi.fn<(tab: TabEntry) => void>();

    addTabToRoot(spec, opened);
    // Nothing is added, and onOpened has not run, until the saved layout is in.
    expect(rootTabs()).toHaveLength(0);
    expect(opened).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(opened).toHaveBeenCalledTimes(1));
    expect(rootTabs().map((tab) => tab.label)).toEqual(["Saved shell", "Agent"]);
    expect(opened.mock.calls[0][0].key).toBe(rootTabs()[1].key);
    expect(useRootOverlayStore.getState().open).toBe(false);
  });

  it("in a popout, forwards the add at once without restoring root itself", () => {
    useTabsStore.setState({ tabsByScope: {}, layoutByScope: {}, focusedGroupByScope: {} });
    const edits: ForwardedEdit[] = [];
    setDetachedWindowContext({
      scope: "p1",
      groupId: "g-1",
      label: "detached-p1-g-1",
      targetGroupId: () => "g-1",
      pushEdit: (edit) => edits.push(edit),
      closeTab: () => {},
    });
    const opened = vi.fn<(tab: TabEntry) => void>();

    addTabToRoot(spec, opened);

    // The main window owns root's tabs and its hydration: nothing is read here.
    expect(invoke).not.toHaveBeenCalled();
    expect(edits).toEqual([{ kind: "addToScope", scope: "root", tab: spec }]);
    expect(opened).toHaveBeenCalledTimes(1);
    expect(rootTabs()).toHaveLength(0);
  });
});

describe("openTabInRootConsole", () => {
  it("is addTabToRoot plus the console in front on the new tab", () => {
    const opened = vi.fn<(tab: TabEntry) => void>(() => {
      // onOpened runs before the console opens, as it always has.
      expect(useRootOverlayStore.getState().open).toBe(false);
    });

    openTabInRootConsole(spec, opened);

    expect(opened).toHaveBeenCalledTimes(1);
    const tab = rootTabs()[0];
    expect(opened.mock.calls[0][0].key).toBe(tab.key);
    expect(useRootOverlayStore.getState().open).toBe(true);
    const groups = allGroups(useTabsStore.getState().layoutByScope.root ?? null);
    expect(groups.some((g) => g.activeKey === tab.key)).toBe(true);
  });

  it("restores an unhydrated root before adding, then opens the console", async () => {
    unhydratedRootWithSavedShell();

    openTabInRootConsole(spec);
    expect(rootTabs()).toHaveLength(0);
    expect(useRootOverlayStore.getState().open).toBe(false);

    await vi.waitFor(() => expect(useRootOverlayStore.getState().open).toBe(true));
    expect(rootTabs().map((tab) => tab.label)).toEqual(["Saved shell", "Agent"]);
  });
});
