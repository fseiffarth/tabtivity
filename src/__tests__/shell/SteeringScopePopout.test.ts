/**
 * A popout is a third source of "the tabs steering walks" (`steeringScope`):
 * its tabs store is empty on purpose, so the tab levels, the new-tab chords and
 * the status jumps read the popout's own view (`stores/popoutView`).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setDetachedWindowContext } from "../../stores/detachedContext";
import { usePopoutViewStore } from "../../stores/popoutView";
import { useTabsStore, type LayoutNode, type TabEntry } from "../../stores/tabs";
import { steeringInRoot, steeringTabs, steeringTabsActive } from "../../lib/shortcuts/steeringScope";
import { shownStatusTab } from "../../lib/shortcuts/statusJump";
import { NEW_TAB_SLOTS_EVENT, newTabSlotLabels, type NewTabSlotsDetail } from "../../lib/shortcuts/newTabChord";

const tab = (key: string): TabEntry => ({ key, label: key, cmd: "bash", cwd: "/p", kind: "shell", scope: "p" });

const split: LayoutNode = {
  type: "split",
  id: "s1",
  dir: "row",
  sizes: [0.5, 0.5],
  children: [
    { type: "group", id: "g1", tabKeys: ["a", "b"], activeKey: "b" },
    { type: "group", id: "g2", tabKeys: ["c"], activeKey: "c" },
  ],
} as LayoutNode;

function installPopout() {
  setDetachedWindowContext({
    scope: "p",
    groupId: "pop",
    label: "detached-p-pop",
    targetGroupId: () => "g1",
    pushEdit: () => {},
    closeTab: () => {},
  });
  usePopoutViewStore.getState().setView({
    scope: "p",
    popoutId: "pop",
    label: "detached-p-pop",
    tree: split,
    tabs: [tab("a"), tab("b"), tab("c")],
  });
}

beforeEach(() => {
  usePopoutViewStore.getState().reset();
  useTabsStore.setState({ scope: "root", tabs: [], layout: null, focusedGroupId: null, activeKey: null });
});
afterEach(() => {
  setDetachedWindowContext(null);
  usePopoutViewStore.getState().reset();
});

describe("steering's tabs in a popout", () => {
  it("walks the popout view, never the empty tabs store", () => {
    installPopout();
    const walked = steeringTabs();
    expect(walked).toMatchObject({ scope: "p", focusedGroupId: "g1", inRoot: false, popout: true });
    expect(walked.layout).toBe(split);
    expect(steeringTabsActive()).toEqual({ scope: "p", tab: tab("b") });
    expect(steeringInRoot()).toBe(false);
  });

  it("follows the popout view's focus", () => {
    installPopout();
    usePopoutViewStore.getState().focusGroup("g2");
    expect(steeringTabs().focusedGroupId).toBe("g2");
    expect(steeringTabsActive()?.tab.key).toBe("c");
    expect(shownStatusTab()).toEqual({ scope: "p", key: "c" });
  });

  it("is the main window's workspace when no popout context is installed", () => {
    usePopoutViewStore.getState().setView({ scope: "p", tree: split, tabs: [tab("a")] });
    expect(steeringTabs().popout).toBe(false);
    expect(steeringTabs().scope).toBe("root");
  });

  it("asks the popout's focused subwindow for the new-tab slots", () => {
    installPopout();
    usePopoutViewStore.getState().focusGroup("g2");
    let asked: string | null = null;
    const answer = (e: Event) => {
      const detail = (e as CustomEvent<NewTabSlotsDetail>).detail;
      asked = detail.groupId;
      detail.labels = ["Claude"];
    };
    window.addEventListener(NEW_TAB_SLOTS_EVENT, answer);
    try {
      expect(newTabSlotLabels()).toEqual(["Claude"]);
      expect(asked).toBe("g2");
    } finally {
      window.removeEventListener(NEW_TAB_SLOTS_EVENT, answer);
    }
  });
});

describe("the popout view", () => {
  it("keeps the focused subwindow across a reseed, else lands on the first", () => {
    installPopout();
    usePopoutViewStore.getState().focusGroup("g2");
    // A reseed with the same panes (an edit) keeps it.
    usePopoutViewStore.getState().setView({ tree: { ...split } as LayoutNode });
    expect(usePopoutViewStore.getState().focusedGroupId).toBe("g2");
    // g2 docked back: focus falls to the first pane.
    usePopoutViewStore.getState().setView({
      tree: { type: "group", id: "g1", tabKeys: ["a", "b"], activeKey: "a" } as LayoutNode,
    });
    expect(usePopoutViewStore.getState().focusedGroupId).toBe("g1");
  });

  it("ignores a focus on a subwindow it does not hold", () => {
    installPopout();
    usePopoutViewStore.getState().focusGroup("elsewhere");
    expect(usePopoutViewStore.getState().focusedGroupId).toBe("g1");
  });
});
