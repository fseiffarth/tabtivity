/**
 * The tab strip with many tabs (performance plan §5.1): each plain tab is a
 * memoised `TabItem` that subscribes to its own activity entries, so one tab's
 * busy flip re-renders that one item, and bar-level churn (a hover card
 * opening) re-renders no item at all.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve([])) }));

// Rendered once per `TabItem` render and nowhere else in the bar: its per-key
// count is the item's render count.
const renders = new Map<string, number>();
vi.mock("../../components/tabs/TabMarkBadge", () => ({
  TabMarkBadge: ({ tab }: { tab: { key: string } }) => {
    renders.set(tab.key, (renders.get(tab.key) ?? 0) + 1);
    return null;
  },
}));

import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { useActivityStore } from "../../stores/activity";
import { useDragStore } from "../../stores/drag/drag";
import { TabBar } from "../../components/tabs/TabBar";

const N = 60;
const keys = Array.from({ length: N }, (_, i) => `tab-${i}`);

function seed() {
  const tabs: TabEntry[] = keys.map((key) => ({
    key,
    label: key,
    cmd: "claude",
    cwd: "/p",
    kind: "agent",
    scope: "p1",
  }));
  const layout = { type: "group" as const, id: "g1", tabKeys: keys, activeKey: keys[0] };
  useTabsStore.setState({
    scope: "p1",
    tabsByScope: { p1: tabs },
    tabs,
    layoutByScope: { p1: layout },
    layout,
    focusedGroupByScope: { p1: "g1" },
    focusedGroupId: "g1",
    activeKey: keys[0],
  });
}

const total = () => [...renders.values()].reduce((a, b) => a + b, 0);

beforeEach(() => {
  cleanup();
  renders.clear();
  useDragStore.setState({ drag: null });
  useActivityStore.setState({ busyByTab: {}, busyKindByTab: {}, attentionByTab: {} });
  seed();
});

describe("tab strip memoisation (60 tabs)", () => {
  it("re-renders one TabItem when one tab's busy state flips", async () => {
    render(<TabBar groupId="g1" projectCwd="/p" showGroupClose={false} />);
    await act(async () => {});
    expect(renders.size).toBe(N);
    const before = new Map(renders);
    const target = keys[23];

    await act(async () => {
      useActivityStore.setState({
        busyByTab: { [`p1:${target}`]: true },
        busyKindByTab: { [`p1:${target}`]: "agent" },
      });
    });
    for (const k of keys) {
      expect(renders.get(k), k).toBe((before.get(k) ?? 0) + (k === target ? 1 : 0));
    }
    const el = document.querySelector(`.tab[data-tab-index="23"]`);
    expect(el?.className).toContain("working");

    // Attention on another tab: again exactly that one item.
    await act(async () => {
      useActivityStore.setState({ attentionByTab: { [`p1:${keys[40]}`]: "done" } });
    });
    expect(renders.get(keys[40])).toBe((before.get(keys[40]) ?? 0) + 1);
    expect(renders.get(keys[23])).toBe((before.get(keys[23]) ?? 0) + 1);
    expect(total()).toBe([...before.values()].reduce((a, b) => a + b, 0) + 2);
  });

  it("re-renders no TabItem when the hover card opens", async () => {
    render(<TabBar groupId="g1" projectCwd="/p" showGroupClose={false} />);
    await act(async () => {});
    const before = total();
    const el = document.querySelector(`.tab[data-tab-index="5"]`)!;
    await act(async () => {
      fireEvent.mouseEnter(el);
    });
    expect(total()).toBe(before);
    await act(async () => {
      fireEvent.mouseLeave(el);
    });
    expect(total()).toBe(before);
  });

  it("re-renders only the two items whose active state changes on activation", async () => {
    render(<TabBar groupId="g1" projectCwd="/p" showGroupClose={false} />);
    await act(async () => {});
    const before = total();
    await act(async () => {
      useTabsStore.getState().setGroupActive("g1", keys[7]);
    });
    expect(total()).toBe(before + 2);
    expect(document.querySelector(`.tab[data-tab-index="7"]`)?.className).toContain("active");
  });
});
