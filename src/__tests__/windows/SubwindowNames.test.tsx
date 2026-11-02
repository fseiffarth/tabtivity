/**
 * Subwindows and popouts take names. A name lives on the group node, so it
 * follows the group through detach, dock and hide with nothing copied; only a
 * multi-pane popout keeps one beside its tree (`DetachedGroup.name`).
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn((..._a: unknown[]) => Promise.resolve(undefined as unknown)),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(() => Promise.resolve()),
}));
vi.mock("@tauri-apps/api/window", () => ({
  cursorPosition: vi.fn(() => Promise.resolve({ x: 0, y: 0 })),
  getCurrentWindow: () => ({
    label: "popout",
    innerPosition: () => Promise.resolve({ x: 0, y: 0 }),
    outerPosition: () => Promise.resolve({ x: 0, y: 0 }),
    outerSize: () => Promise.resolve({ width: 800, height: 600 }),
    scaleFactor: () => Promise.resolve(1),
    onMoved: () => Promise.resolve(() => {}),
  }),
}));
vi.mock("../../components/tabs/TabPane", () => ({ TabPane: () => <div /> }));
vi.mock("../../components/header/WindowControls", () => ({ WindowControls: () => null }));

import { DetachedCenterPanel } from "../../components/layout/DetachedCenterPanel";
import { TabBar } from "../../components/tabs/TabBar";
import { applyEditToSubtree, buildSeed } from "../../stores/detached";
import {
  allGroups,
  findGroup,
  useTabsStore,
  type GroupNode,
  type LayoutNode,
  type SplitNode,
  type TabEntry,
} from "../../stores/tabs";
import { MAX_SUBWINDOW_NAME, subtreeName } from "../../stores/tabs/layoutTree";
import { pruneSavedTree, serializeTree, withDetachedDocked } from "../../stores/tabs/savedLayout";
import { translate } from "../../lib/i18n";

function reset() {
  invokeMock.mockClear();
  useTabsStore.setState({
    scope: "p",
    tabsByScope: {},
    layoutByScope: {},
    focusedGroupByScope: {},
    detachedGroupsByScope: {},
    hiddenGroupsByScope: {},
    pendingRespawnByScope: {},
    tabs: [],
    layout: null,
    focusedGroupId: null,
    activeKey: null,
  });
  useTabsStore.getState().setScope("p");
}

const store = () => useTabsStore.getState();

/** Two subwindows side by side; `right` is the one the tests name. */
function twoGroups() {
  store().addTab({ label: "a", cmd: "bash", cwd: "/p", kind: "shell" });
  const b = store().addTab({ label: "b", cmd: "bash", cwd: "/p", kind: "shell" });
  store().splitWithTab(b.key, allGroups(store().layout)[0].id, "right");
  const [left, right] = allGroups(store().layout);
  return { left, right };
}

function restore(snap: ReturnType<TabsStoreSnap>, scope = "p2") {
  const saved = snap.tabs.map(({ key, label, cmd, cwd, kind }) => ({ key, label, cmd, cwd, kind }));
  reset();
  store().loadFromLayout(saved, "/p", scope, snap.tabGroups ?? undefined);
}
type TabsStoreSnap = () => ReturnType<ReturnType<typeof useTabsStore.getState>["snapshotScopeForSwitch"]>;

const splitPopout = (id = "s-pop"): SplitNode => ({
  type: "split",
  id,
  dir: "row",
  sizes: [0.5, 0.5],
  children: [
    { type: "group", id: "g-b", tabKeys: ["kb"], activeKey: "kb" },
    { type: "group", id: "g-c", tabKeys: ["kc"], activeKey: "kc" },
  ],
});

function seedSplitPopout(name?: string) {
  const b = { key: "kb", label: "b", cmd: "bash", cwd: "/p", kind: "shell" as const };
  const c = { key: "kc", label: "c", cmd: "bash", cwd: "/p", kind: "shell" as const };
  store().addTab({ label: "a", cmd: "bash", cwd: "/p", kind: "shell" });
  useTabsStore.setState((s) => ({
    tabsByScope: { ...s.tabsByScope, p: [...(s.tabsByScope.p ?? []), b, c] },
    detachedGroupsByScope: {
      p: [{ id: "s-pop", label: "detached-p-s-pop", subtree: splitPopout(), ...(name ? { name } : {}) }],
    },
  }));
}

beforeEach(reset);
afterEach(cleanup);

describe("naming a subwindow", () => {
  it("trims, caps, and takes the name off on an empty one", () => {
    const { right } = twoGroups();
    store().setGroupName(right.id, "  Build  ");
    expect(findGroup(store().layout, right.id)?.name).toBe("Build");

    store().setGroupName(right.id, "x".repeat(MAX_SUBWINDOW_NAME + 5));
    expect(findGroup(store().layout, right.id)?.name).toHaveLength(MAX_SUBWINDOW_NAME);

    store().setGroupName(right.id, "   ");
    expect(findGroup(store().layout, right.id)?.name).toBeUndefined();
  });

  it("survives a restart", () => {
    const { right } = twoGroups();
    store().setGroupName(right.id, "Build");
    const snap = store().snapshotScopeForSwitch("p");
    restore(snap);
    expect(allGroups(store().layoutByScope["p2"]).map((g) => g.name)).toEqual([undefined, "Build"]);
  });

  it("ignores a name of the wrong type read back from disk", () => {
    const snap = (() => {
      twoGroups();
      return store().snapshotScopeForSwitch("p");
    })();
    const tree = snap.tabGroups as { children: { name?: unknown }[] };
    tree.children[1].name = 7;
    restore(snap);
    expect(allGroups(store().layoutByScope["p2"]).map((g) => g.name)).toEqual([undefined, undefined]);
  });

  it("goes with the subwindow into a popout and back", () => {
    const { right } = twoGroups();
    store().setGroupName(right.id, "Build");
    store().detachGroup(right.id);
    const [popout] = store().detachedGroupsByScope["p"];
    expect(subtreeName(popout.subtree, popout.name)).toBe("Build");
    expect(invokeMock).toHaveBeenCalledWith(
      "detach_subwindow",
      expect.objectContaining({ name: "Build" }),
    );

    store().attachGroup(popout.id);
    expect(allGroups(store().layout).map((g) => g.name)).toContain("Build");
  });

  it("asks for no name when the popout has none", () => {
    const { right } = twoGroups();
    store().detachGroup(right.id);
    const call = invokeMock.mock.calls.find((c) => c[0] === "detach_subwindow");
    expect(call?.[1]).not.toHaveProperty("name");
  });

  it("stays on a hidden subwindow, also across a restart", () => {
    const { right } = twoGroups();
    store().setGroupName(right.id, "Build");
    store().setGroupFiles(right.id, true);
    store().hideGroup(right.id);
    const snap = store().snapshotScopeForSwitch("p");
    restore(snap);

    const [hidden] = store().hiddenGroupsByScope["p2"];
    expect(subtreeName(hidden.subtree, hidden.name)).toBe("Build");
    // The restore rebuilt the node by hand and used to drop everything but its tabs.
    expect((hidden.subtree as GroupNode).filesOpen).toBe(true);
  });

  it("gives a name from an older hidden entry to the group it restores to", () => {
    const { right } = twoGroups();
    store().hideGroup(right.id);
    useTabsStore.setState((s) => ({
      hiddenGroupsByScope: {
        p: s.hiddenGroupsByScope["p"].map((h) => ({ ...h, name: "Builds" })),
      },
    }));
    store().unhideGroup(right.id);
    expect(allGroups(store().layout).map((g) => g.name)).toContain("Builds");
  });
});

describe("naming a popout", () => {
  it("names a one-pane window through its group, so docking needs no hand-off", () => {
    const { right } = twoGroups();
    store().detachGroup(right.id);
    store().applyDetachedEdit("p", right.id, { kind: "name", name: "Notes" });
    const [popout] = store().detachedGroupsByScope["p"];
    expect((popout.subtree as GroupNode).name).toBe("Notes");
    expect(popout.name).toBeUndefined();

    store().attachGroup(popout.id);
    expect(allGroups(store().layout).map((g) => g.name)).toContain("Notes");
  });

  it("can take the name off a one-pane window again", () => {
    const { right } = twoGroups();
    store().setGroupName(right.id, "Build");
    store().detachGroup(right.id);
    store().applyDetachedEdit("p", right.id, { kind: "name", name: "" });
    const [popout] = store().detachedGroupsByScope["p"];
    expect(subtreeName(popout.subtree, popout.name)).toBeUndefined();
  });

  it("keeps a split window's name beside its tree and a pane's on the pane", () => {
    seedSplitPopout();
    store().applyDetachedEdit("p", "s-pop", { kind: "name", name: "Review" });
    store().applyDetachedEdit("p", "s-pop", { kind: "name", groupId: "g-c", name: "Diff" });
    const [popout] = store().detachedGroupsByScope["p"];
    expect(popout.name).toBe("Review");
    expect(allGroups(popout.subtree).map((g) => g.name)).toEqual([undefined, "Diff"]);

    // The popout's own optimistic copy lands on the same tree.
    let local: LayoutNode | null = splitPopout();
    local = applyEditToSubtree(local, { kind: "name", groupId: "g-c", name: "Diff" });
    expect(allGroups(local).map((g) => g.name)).toEqual([undefined, "Diff"]);
    local = applyEditToSubtree(local!, { kind: "name", name: "Review" });
    expect(allGroups(local).map((g) => g.name)).toEqual([undefined, "Diff"]);
  });

  it("falls back to its first named pane, so splitting keeps the window's name", () => {
    const tree = splitPopout();
    expect(subtreeName(tree)).toBeUndefined();
    (tree.children[1] as GroupNode).name = "Diff";
    expect(subtreeName(tree)).toBe("Diff");
    expect(subtreeName(tree, "Review")).toBe("Review");
  });

  it("reaches the popout in its seed", () => {
    const seed = buildSeed("p", "s-pop", [], splitPopout(), undefined, undefined, "Review");
    expect(seed.name).toBe("Review");
    expect(buildSeed("p", "s-pop", [], splitPopout())).not.toHaveProperty("name");
  });

  it("carries a split window's name and zoom through a prune and a respawn", () => {
    seedSplitPopout("Review");
    useTabsStore.setState((s) => ({
      detachedGroupsByScope: { p: [{ ...s.detachedGroupsByScope["p"][0], zoom: 1.25 }] },
    }));
    const merged = withDetachedDocked(
      serializeTree(store().layout),
      store().detachedGroupsByScope["p"],
    );
    const keep = new Set(store().tabsByScope["p"].map((t) => t.key));
    const pruned = pruneSavedTree(merged, keep) as { children: Record<string, unknown>[] };
    const tagged = pruned.children.find((c) => c.detached);
    expect(tagged).toMatchObject({ detachedName: "Review", zoom: 1.25 });

    const snap = store().snapshotScopeForSwitch("p");
    restore(snap);
    expect(store().pendingRespawnByScope["p2"]).toEqual([
      expect.objectContaining({ name: "Review", zoom: 1.25 }),
    ]);
  });

  it("lands a respawned split window with its name", () => {
    const { right } = twoGroups();
    store().detachGroup(right.id, { name: "Review", allowLastGroup: true });
    expect(store().detachedGroupsByScope["p"][0].name).toBe("Review");
  });

  it("gives its name to the hidden list when it is hidden", () => {
    seedSplitPopout("Review");
    store().hideDetachedGroup("p", "s-pop");
    expect(store().hiddenGroupsByScope["p"][0].name).toBe("Review");
  });
});

describe("the main tab bar", () => {
  const seedBar = () => {
    store().addTab({ label: "shell", cmd: "bash", cwd: "/p", kind: "shell" });
    const groupId = allGroups(store().layout)[0].id;
    const { container } = render(<TabBar groupId={groupId} projectCwd="/p" showGroupClose={false} />);
    return { groupId, bar: container.querySelector(".tab-bar") as HTMLElement };
  };
  const menuItem = (key: "tabBar.nameSubwindow" | "tabBar.renameSubwindow") =>
    screen.getByRole("button", { name: new RegExp(translate("en", key)) });

  it("names the subwindow from a right-click on the bar and shows the name", async () => {
    const user = userEvent.setup();
    const { groupId, bar } = seedBar();
    fireEvent.contextMenu(bar, { clientX: 5, clientY: 5 });
    await user.click(menuItem("tabBar.nameSubwindow"));
    const asked = await screen.findByRole("dialog");
    await user.type(within(asked).getByRole("textbox"), "Build{Enter}");
    await waitFor(() => expect(findGroup(store().layout, groupId)?.name).toBe("Build"));
    expect(bar.querySelector(".subwindow-name")?.textContent).toBe("Build");
  });

  it("removes the name when the field is emptied", async () => {
    const user = userEvent.setup();
    const { groupId, bar } = seedBar();
    store().setGroupName(groupId, "Build");
    fireEvent.contextMenu(bar, { clientX: 5, clientY: 5 });
    await user.click(await waitFor(() => menuItem("tabBar.renameSubwindow")));
    const field = within(await screen.findByRole("dialog")).getByRole("textbox");
    await user.clear(field);
    await user.type(field, "{Enter}");
    await waitFor(() => expect(findGroup(store().layout, groupId)?.name).toBeUndefined());
  });

  it("leaves a right-click on a tab to the tab's own menu", () => {
    const { bar } = seedBar();
    fireEvent.contextMenu(bar.querySelector(".tab") as HTMLElement);
    expect(screen.queryByRole("button", { name: new RegExp(translate("en", "tabBar.nameSubwindow")) })).toBeNull();
  });
});

describe("the popout's title bar", () => {
  const tabs: TabEntry[] = [
    { key: "kb", label: "b", kind: "shell", cmd: "bash", cwd: "/p" },
    { key: "kc", label: "c", kind: "shell", cmd: "bash", cwd: "/p" },
  ];
  const mount = (tree: LayoutNode, windowName?: string) => {
    const onName = vi.fn();
    const { container } = render(
      <DetachedCenterPanel
        scope="p" popoutId="popout" tree={tree} tabs={tabs}
        onSplit={vi.fn()} onMove={vi.fn()} onReorder={vi.fn()}
        onActivate={vi.fn()} onClose={vi.fn()} onSetLocation={vi.fn()}
        onResize={vi.fn()} onAddTab={vi.fn()} onFiles={vi.fn()}
        windowName={windowName} onName={onName}
      />,
    );
    return { container, onName };
  };
  const one: GroupNode = { type: "group", id: "g", tabKeys: ["kb"], activeKey: "kb", name: "Build" };

  it("shows the window's name once, not again on a lone pane's bar", () => {
    const { container } = mount(one, "Build");
    expect(container.querySelector(".detached-titlebar-name")?.textContent).toBe("Build");
    expect(container.querySelector(".subwindow-name")).toBeNull();
  });

  it("names the window from a right-click on the title bar", async () => {
    const user = userEvent.setup();
    const { container, onName } = mount({ ...one, name: undefined });
    fireEvent.contextMenu(container.querySelector(".detached-titlebar") as HTMLElement);
    await user.click(screen.getByRole("button", { name: new RegExp(translate("en", "detachedTabs.nameWindow")) }));
    await user.type(within(await screen.findByRole("dialog")).getByRole("textbox"), "Notes{Enter}");
    await waitFor(() => expect(onName).toHaveBeenCalledWith(undefined, "Notes"));
  });

  it("names the pane from its own bar once the window is split", async () => {
    const user = userEvent.setup();
    const { container, onName } = mount(splitPopout());
    const bar = container.querySelector('.tab-bar[data-group-id="g-c"]') as HTMLElement;
    fireEvent.contextMenu(bar);
    await user.click(screen.getByRole("button", { name: new RegExp(translate("en", "tabBar.nameSubwindow")) }));
    await user.type(within(await screen.findByRole("dialog")).getByRole("textbox"), "Diff{Enter}");
    await waitFor(() => expect(onName).toHaveBeenCalledWith("g-c", "Diff"));
  });

  it("treats a lone pane's bar as the window", () => {
    const { container } = mount({ ...one, name: undefined });
    fireEvent.contextMenu(container.querySelector(".tab-bar") as HTMLElement);
    expect(screen.getByRole("button", { name: new RegExp(translate("en", "detachedTabs.nameWindow")) })).toBeTruthy();
  });
});
