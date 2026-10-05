/**
 * A PTY id is `<scope>:<tabKey>` — and a scope is NOT colon-free.
 *
 * `"root"` and a project id are, but a box scope is `box:<id>`, so
 * `box:abc:agent-3` carries two colons. Every consumer used to cut at the first
 * one and read the scope as `"box"`, which meant:
 *
 * - `isDetachedPtyId` looked up `detachedGroupsByScope["box"]`, found nothing,
 *   and let the main window's unmount kill a PTY it had just handed to a popout
 *   — detaching a box tab produced a dead black pane;
 * - the activity store filed a box tab's usage under a scope literally called
 *   `"box"`, and could not tell whether such a tab was being looked at;
 * - `TerminalView`'s unmount cleared an agent-task title under the key
 *   `<boxId>:<tabKey>`, which matched nothing, so the title lingered.
 *
 * Same defect the Rust side already fixed in `commands::subwindow`
 * (`detached_query`), where it made box-scope detach impossible outright.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn((..._a: unknown[]) => Promise.resolve(undefined)),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

import { BOX_SCOPE_PREFIX, splitPtyId } from "../../lib/terminal/ptyId";
import { useTabsStore, isDetachedPtyId, type GroupNode, type SplitNode } from "../../stores/tabs";
import { splitPtyId as splitPtyIdFromActivity } from "../../stores/activity";
import { BRAND } from "../../lib/brand";

describe("splitPtyId", () => {
  it("keeps a box scope whole", () => {
    expect(splitPtyId("box:abc:agent-3")).toEqual({ scope: "box:abc", key: "agent-3" });
    // A box id that itself looks segmented is still one scope.
    expect(splitPtyId("box:9f2-1:shell-12")).toEqual({
      scope: "box:9f2-1",
      key: "shell-12",
    });
  });

  it("splits the ordinary scopes exactly as before", () => {
    expect(splitPtyId("root:shell-1")).toEqual({ scope: "root", key: "shell-1" });
    expect(splitPtyId("2f8a-4c11:agent-7")).toEqual({
      scope: "2f8a-4c11",
      key: "agent-7",
    });
  });

  it("returns null when there is no tab key to find", () => {
    expect(splitPtyId("nocolon")).toBeNull();
    // A bare box SCOPE is not a PTY id: cutting inside the prefix would have
    // yielded the scope "box" and the key "abc".
    expect(splitPtyId("box:abc")).toBeNull();
    expect(splitPtyId("")).toBeNull();
  });

  it("is one parser, not two", () => {
    // `stores/activity` re-exports it; the copy that used to live there cut at
    // the first colon and drifted from `stores/tabs`' copy.
    expect(splitPtyIdFromActivity).toBe(splitPtyId);
    expect(BOX_SCOPE_PREFIX).toBe("box:");
  });
});

describe("isDetachedPtyId in a box scope", () => {
  const scope = `${BOX_SCOPE_PREFIX}abc`;

  beforeEach(() => {
    invokeMock.mockClear();
    useTabsStore.setState({
      scope,
      tabsByScope: {},
      layoutByScope: {},
      focusedGroupByScope: {},
      detachedGroupsByScope: {},
      pendingRespawnByScope: {},
      tabs: [],
      layout: null,
      focusedGroupId: null,
      activeKey: null,
    });
  });

  it("recognises a detached box tab, so its popped-out PTY is not killed", () => {
    const t = (label: string) =>
      ({ label, cmd: "bash", cwd: `/home/u/${BRAND.slug}/boxes/b`, kind: "shell" as const });
    const a = useTabsStore.getState().addTab(t("a"));
    const b = useTabsStore.getState().addTab(t("b"));
    const rootGid = (useTabsStore.getState().layout as GroupNode).id;
    useTabsStore.getState().splitWithTab(b.key, rootGid, "right");
    const right = (useTabsStore.getState().layout as SplitNode).children[1] as GroupNode;

    const ptyId = `${scope}:${b.key}`;
    expect(isDetachedPtyId(ptyId)).toBe(false);

    useTabsStore.getState().detachGroup(right.id);
    // The regression: this said false for every box scope, and the main pane's
    // unmount killed the PTY the popout had just attached to.
    expect(isDetachedPtyId(ptyId)).toBe(true);
    // The tab that stayed behind is still the main window's to kill.
    expect(isDetachedPtyId(`${scope}:${a.key}`)).toBe(false);
    // And nothing is claimed for the mis-parsed scope the old cut produced.
    expect(isDetachedPtyId(`box:${b.key}`)).toBe(false);
  });
});
