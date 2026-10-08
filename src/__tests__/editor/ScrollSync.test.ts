/**
 * Proportional scroll-linking between two side-by-side viewer subwindows. The
 * store holds symmetric links keyed by group id and forwards one pane's scroll
 * ratio to its linked partner's handle, guarding against the feedback bounce the
 * induced scroll would otherwise cause. These tests lock the link matching, the
 * ratio forwarding + suppress guard, and the prune-on-stale behaviour.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";

import {
  useScrollSync,
  useScrollSyncStore,
  type ScrollHandle,
} from "../../stores/viewers/scrollSync";

function reset() {
  useScrollSyncStore.setState({ links: {}, handles: new Map() });
}

describe("scrollSync links", () => {
  beforeEach(reset);

  it("toggleLink creates a symmetric pair and toggles it off", () => {
    const s = useScrollSyncStore.getState();
    s.toggleLink("a", "b");
    expect(useScrollSyncStore.getState().isLinked("a", "b")).toBe(true);
    expect(useScrollSyncStore.getState().isLinked("b", "a")).toBe(true);

    useScrollSyncStore.getState().toggleLink("a", "b");
    expect(useScrollSyncStore.getState().isLinked("a", "b")).toBe(false);
    expect(useScrollSyncStore.getState().isLinked("b", "a")).toBe(false);
  });

  it("a new link on an already-linked group drops the prior pairing on both sides", () => {
    useScrollSyncStore.getState().toggleLink("a", "b");
    useScrollSyncStore.getState().toggleLink("a", "c");
    const { isLinked } = useScrollSyncStore.getState();
    expect(isLinked("a", "c")).toBe(true);
    expect(isLinked("a", "b")).toBe(false);
    // b is now orphaned, not silently still pointing at a.
    expect(useScrollSyncStore.getState().links["b"]).toBeUndefined();
  });

  it("prune drops any link whose endpoints are no longer both valid", () => {
    useScrollSyncStore.getState().toggleLink("a", "b");
    useScrollSyncStore.getState().prune(new Set(["a"])); // b gone
    expect(useScrollSyncStore.getState().isLinked("a", "b")).toBe(false);
    expect(useScrollSyncStore.getState().links).toEqual({});
  });
});

describe("scrollSync report", () => {
  beforeEach(reset);

  it("forwards the source ratio to the linked partner's handle", () => {
    const applyA = vi.fn();
    const applyB = vi.fn();
    const s = useScrollSyncStore.getState();
    s.register("a", { applyRatio: applyA });
    s.register("b", { applyRatio: applyB });
    s.toggleLink("a", "b");

    useScrollSyncStore.getState().report("a", 0.5);
    expect(applyB).toHaveBeenCalledWith(0.5);
    expect(applyA).not.toHaveBeenCalled();
  });

  it("does nothing for an unlinked group", () => {
    const applyB = vi.fn();
    useScrollSyncStore.getState().register("b", { applyRatio: applyB });
    useScrollSyncStore.getState().report("a", 0.5);
    expect(applyB).not.toHaveBeenCalled();
  });

  it("suppresses the partner's echoed report so the two panes don't fight", () => {
    // Simulate the induced scroll: applying a ratio to the partner fires its own
    // scroll, which reports back. That echo must be swallowed within the tick.
    const applyA = vi.fn();
    const partnerReports: number[] = [];
    const handleB: ScrollHandle = {
      applyRatio: (r) => {
        partnerReports.push(r);
        // The write to B's scrollTop fires B's scroll handler synchronously here.
        useScrollSyncStore.getState().report("b", r);
      },
    };
    const s = useScrollSyncStore.getState();
    s.register("a", { applyRatio: applyA });
    s.register("b", handleB);
    s.toggleLink("a", "b");

    useScrollSyncStore.getState().report("a", 0.5);
    expect(partnerReports).toEqual([0.5]);
    // The echo from B must NOT bounce back into A while suppressed.
    expect(applyA).not.toHaveBeenCalled();
  });
});

/** A scroll container whose scrollTop the engine snaps to whole pixels, like a
 *  real one, and whose writes are counted. */
function pane(scrollHeight: number, clientHeight: number) {
  let top = 0;
  const writes: number[] = [];
  const el = { scrollHeight, clientHeight } as unknown as HTMLElement;
  Object.defineProperty(el, "scrollTop", {
    get: () => top,
    set: (v: number) => {
      writes.push(v);
      top = Math.round(Math.min(Math.max(v, 0), scrollHeight - clientHeight));
    },
  });
  return { el, writes, scrollBy: (to: number) => (top = to) };
}

describe("useScrollSync echo", () => {
  beforeEach(reset);

  it("does not bounce the partner's own scroll event back, so linked panes never creep", () => {
    // Heights that don't divide evenly: the partner's rounded position, read back
    // as a ratio, lands a pixel off the originator's — the old creep.
    const a = pane(10_000, 700);
    const b = pane(3_337, 700);
    const ha = renderHook(() => useScrollSync("a", { current: a.el })).result.current;
    const hb = renderHook(() => useScrollSync("b", { current: b.el })).result.current;
    useScrollSyncStore.getState().toggleLink("a", "b");

    a.scrollBy(1_234);
    ha(); // the reader scrolled A
    expect(b.writes).toHaveLength(1);

    // B's scroll event for that mirrored write arrives later, on its own.
    hb();
    expect(a.writes).toHaveLength(0);
    expect(a.el.scrollTop).toBe(1_234);

    // The reader then scrolls B for real: that one does drive A.
    b.scrollBy(900);
    hb();
    expect(a.writes).toHaveLength(1);
  });
});
