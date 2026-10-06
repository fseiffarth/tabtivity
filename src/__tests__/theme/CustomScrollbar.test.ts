import { describe, it, expect, vi } from "vitest";
// Read the stylesheet at test time, the way `NativeEditorMetricsCss.test.ts`
// does: a `?raw` import yields "" under the config's `css: false`, which would
// make every assertion below pass vacuously. Vitest runs from the repo root.
import { readAppStylesheet } from "../helpers/cssCorpus";
import {
  installCustomScrollbars,
  movesBox,
  thumbGeometry,
  scrollFromDrag,
  clipBox,
  openSpans,
  largestOverlap,
  type Box,
  type TrackMetrics,
} from "../../lib/theme/customScrollbar";

/**
 * The scrollbar's arithmetic, which is the whole of what can be wrong about it
 * away from a real engine: jsdom lays nothing out, so every element there
 * reports a zero box and the DOM half of the module can only be exercised
 * live. What is testable is the part a wrong pixel would show up in — how long
 * the thumb is, where it sits, and where a drag leaves the content.
 */

const track = (over: Partial<TrackMetrics> = {}): TrackMetrics => ({
  scrollSize: 1000,
  clientSize: 200,
  scrollPos: 0,
  trackLength: 200,
  ...over,
});

describe("thumbGeometry", () => {
  it("gives no thumb to an axis that cannot scroll", () => {
    expect(thumbGeometry(track({ scrollSize: 200 }))).toBeNull();
  });

  it("treats a one-pixel overflow as no overflow", () => {
    // Fractional device pixel ratios report a scrollHeight one larger than the
    // clientHeight for content that exactly fits; a thumb there would span the
    // whole track and never move.
    expect(thumbGeometry(track({ scrollSize: 201 }))).toBeNull();
  });

  it("sizes the thumb by the share of the content on screen", () => {
    // A fifth of the content is visible, so the thumb is a fifth of the track.
    expect(thumbGeometry(track())?.size).toBe(40);
  });

  it("puts the thumb at the start when the content is at the top", () => {
    expect(thumbGeometry(track())?.offset).toBe(0);
  });

  it("puts the thumb at the end of the track when the content is at the bottom", () => {
    const geom = thumbGeometry(track({ scrollPos: 800 }));
    expect(geom).not.toBeNull();
    // Bottomed out means the thumb's far edge meets the track's, whatever the
    // thumb's length — the off-by-one that leaves a gap at the bottom.
    expect((geom?.offset ?? 0) + (geom?.size ?? 0)).toBe(200);
  });

  it("keeps a very long document's thumb grabbable", () => {
    const geom = thumbGeometry(track({ scrollSize: 500_000 }));
    // The proportional size here is well under a pixel.
    expect(geom?.size).toBe(24);
    expect((geom?.offset ?? 0) + (geom?.size ?? 0)).toBeLessThanOrEqual(200);
  });

  it("never overflows a track shorter than the minimum thumb", () => {
    const geom = thumbGeometry(track({ scrollSize: 500_000, trackLength: 12 }));
    expect(geom?.size).toBe(12);
    expect(geom?.offset).toBe(0);
  });

  it("clamps a scroll position past the end", () => {
    // Momentum scrolling and rubber-banding both report positions outside the
    // real range; the thumb must stop at the track's end rather than run past.
    const geom = thumbGeometry(track({ scrollPos: 5000 }));
    expect((geom?.offset ?? 0) + (geom?.size ?? 0)).toBe(200);
  });

  it("clamps a negative scroll position", () => {
    expect(thumbGeometry(track({ scrollPos: -300 }))?.offset).toBe(0);
  });
});

describe("scrollFromDrag", () => {
  it("scales the pointer delta by the ratio the thumb is shorter than the track", () => {
    // Thumb 40px in a 200px track: 160px of thumb travel across 800px of
    // content, so one pointer pixel is five content pixels.
    expect(scrollFromDrag(0, 16, track())).toBe(80);
  });

  it("bottoms out rather than scrolling past the end", () => {
    expect(scrollFromDrag(0, 10_000, track())).toBe(800);
  });

  it("tops out rather than scrolling above the start", () => {
    expect(scrollFromDrag(400, -10_000, track())).toBe(0);
  });

  it("is a no-op on an axis that cannot scroll", () => {
    expect(scrollFromDrag(0, 50, track({ scrollSize: 200 }))).toBe(0);
  });

  it("is a no-op when the thumb fills the track and has nowhere to travel", () => {
    // A track no longer than the minimum thumb: dragging it must not teleport
    // the content, which is what dividing by a zero travel would do.
    expect(scrollFromDrag(120, 40, track({ trackLength: 12 }))).toBe(120);
  });

  it("round-trips a drag out and back to where it started", () => {
    const m = track();
    const out = scrollFromDrag(0, 16, m);
    expect(scrollFromDrag(out, -16, { ...m, scrollPos: out })).toBe(0);
  });
});

/**
 * Thumbs live in one fixed layer that nothing in the DOM clips, so a container
 * only half on screen — the bounded lists inside the Settings dialog's own
 * scroll are the case that showed it — would paint its thumb straight out of
 * the dialog and over the app behind it. Every thumb is intersected with what
 * its ancestors leave visible; this is that intersection.
 */
describe("clipBox", () => {
  // A dialog frame 400px tall at y=100, the shape the settings window has.
  const frame: Box = { top: 100, left: 0, width: 500, height: 400 };

  it("leaves a thumb wholly inside the frame untouched", () => {
    const thumb: Box = { top: 200, left: 480, width: 8, height: 40 };
    expect(clipBox(thumb, frame)).toEqual(thumb);
  });

  it("trims the part of a thumb that hangs below the frame", () => {
    const thumb: Box = { top: 480, left: 480, width: 8, height: 40 };
    expect(clipBox(thumb, frame)).toEqual({ top: 480, left: 480, width: 8, height: 20 });
  });

  it("trims the part of a thumb that starts above the frame", () => {
    const thumb: Box = { top: 80, left: 480, width: 8, height: 40 };
    expect(clipBox(thumb, frame)).toEqual({ top: 100, left: 480, width: 8, height: 20 });
  });

  it("clips a horizontal thumb on the cross axis too", () => {
    // Half the container is off the frame's right edge; so is half the thumb.
    const thumb: Box = { top: 300, left: 480, width: 60, height: 8 };
    expect(clipBox(thumb, frame)).toEqual({ top: 300, left: 480, width: 20, height: 8 });
  });

  it("gives nothing back for a thumb scrolled clear of the frame", () => {
    expect(clipBox({ top: 520, left: 480, width: 8, height: 40 }, frame)).toBeNull();
  });

  it("treats a touching edge as no overlap rather than a zero-height thumb", () => {
    expect(clipBox({ top: 500, left: 480, width: 8, height: 40 }, frame)).toBeNull();
  });

  it("gives nothing back once the frame itself has collapsed", () => {
    // What an ancestor chain resolves to when one link clips everything away.
    const collapsed: Box = { top: 0, left: 0, width: 0, height: 0 };
    expect(clipBox({ top: 0, left: 0, width: 8, height: 40 }, collapsed)).toBeNull();
  });
});

describe("openSpans", () => {
  // A 600px gutter from y=40; a header dropdown covers y < 250.
  const underMenu = (y: number) => y >= 250;

  it("returns the whole gutter when nothing covers it", () => {
    expect(openSpans(40, 640, () => true)).toEqual([[40, 640]]);
  });

  it("returns nothing when the gutter is wholly covered", () => {
    expect(openSpans(40, 640, () => false)).toEqual([]);
  });

  it("finds a menu's bottom edge to the pixel, not to the probe step", () => {
    expect(openSpans(40, 640, underMenu)).toEqual([[250, 640]]);
  });

  it("splits around a band covered in the middle", () => {
    const band = (y: number) => y < 300 || y >= 420;
    expect(openSpans(40, 640, band)).toEqual([
      [40, 300],
      [420, 640],
    ]);
  });

  it("gives nothing for a collapsed gutter", () => {
    expect(openSpans(40, 40, () => true)).toEqual([]);
  });
});

describe("largestOverlap", () => {
  it("trims a thumb to the part below a dropdown", () => {
    expect(largestOverlap([[250, 640]], 40, 400)).toEqual([250, 400]);
  });

  it("hides a thumb lying wholly under the dropdown", () => {
    expect(largestOverlap([[250, 640]], 40, 200)).toBeNull();
  });

  it("keeps the larger side of a thumb crossing a covered band", () => {
    expect(
      largestOverlap(
        [
          [40, 300],
          [420, 640],
        ],
        280,
        500,
      ),
    ).toEqual([420, 500]);
  });
});

/**
 * The stylesheet half of the mechanism, guarded here because it is the half
 * that silently broke.
 *
 * WebKitGTK builds a scroll container's native bar once and ignores every later
 * change to `scrollbar-width`, so the bar can only be prevented — never removed
 * — and `themes.css` has to hide every one of them statically, up front. A
 * single per-surface rule naming a native bar anywhere in that file undoes it
 * for that surface, and the failure is invisible in every automated gate: the
 * app just paints its own thumb next to a native bar that never left. That is
 * exactly how the two-scrollbars bug survived a round of fixing, so the rule is
 * asserted rather than left to memory.
 */
describe("installCustomScrollbars", () => {
  it("re-measures when a transition or animation ends, and stops on uninstall", () => {
    // A container can move with no DOM mutation, no resize and no scroll: the
    // side panel slides in on a transform transition, and a thumb measured
    // mid-slide stood in the middle of the panel with nothing to re-measure it.
    // jsdom lays nothing out, so what is checkable is that the pass is wired.
    const listened = new Set<string>();
    const added = vi.spyOn(document, "addEventListener");
    const removed = vi.spyOn(document, "removeEventListener");
    const uninstall = installCustomScrollbars();
    for (const call of added.mock.calls) if (call[2] === true) listened.add(call[0]);
    expect([...listened]).toEqual(
      expect.arrayContaining(["transitionend", "transitioncancel", "animationend"]),
    );
    uninstall();
    const dropped = removed.mock.calls.filter((c) => c[2] === true).map((c) => c[0]);
    expect(dropped).toEqual(
      expect.arrayContaining(["transitionend", "transitioncancel", "animationend"]),
    );
    added.mockRestore();
    removed.mockRestore();
  });
});

describe("movesBox", () => {
  it("names the properties whose transition moves the boxes inside", () => {
    // The side panel's slide, the pinned body's padding, a resize drag's width.
    for (const prop of ["transform", "translate", "padding-right", "width", "left", "all"]) {
      expect(movesBox(prop)).toBe(true);
    }
  });

  it("leaves the hover-and-focus transitions alone", () => {
    // These run all day on every button and row; following them would be
    // per-frame measuring for a box that never moved.
    for (const prop of ["color", "background-color", "opacity", "border-color", "box-shadow"]) {
      expect(movesBox(prop)).toBe(false);
    }
  });
});

/**
 * The live half, as far as jsdom can carry it: it lays nothing out, so the
 * container below is given a scrollable box by hand and its rect is whatever
 * the test says. What is checked is the mechanism — that a box-moving
 * transition on an ancestor makes the layer re-measure the container every
 * frame until the transition ends, and that nothing else does.
 */
describe("installCustomScrollbars following motion", () => {
  function motionEvent(type: string, init: Record<string, unknown>): Event {
    // jsdom has neither TransitionEvent nor AnimationEvent; the module reads the
    // fields duck-typed, so a plain Event carrying them is the same thing.
    return Object.assign(new Event(type, { bubbles: true }), init);
  }

  function mountPanelWithList() {
    // jsdom has no hit testing; the container is the topmost thing at its own
    // point, which is what a reachable, uncovered panel reports.
    const panel = document.createElement("div");
    const list = document.createElement("div");
    list.style.overflowY = "auto";
    Object.defineProperty(list, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(list, "clientHeight", { value: 200, configurable: true });
    Object.defineProperty(list, "offsetWidth", { value: 100, configurable: true });
    Object.defineProperty(list, "clientWidth", { value: 100, configurable: true });
    Object.defineProperty(list, "scrollWidth", { value: 100, configurable: true });
    const rect = vi.fn(() => ({ top: 0, left: 0, width: 100, height: 200 }) as DOMRect);
    list.getBoundingClientRect = rect;
    panel.appendChild(list);
    document.body.appendChild(panel);
    (document as unknown as { elementFromPoint: (x: number, y: number) => Element | null })
      .elementFromPoint = () => list;
    return { panel, list, rect };
  }

  // A hand-cranked frame clock: the layer coalesces everything into rAF, and
  // jsdom's own never fires unless asked.
  function frameClock() {
    let queue: FrameRequestCallback[] = [];
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      queue.push(cb);
      return queue.length;
    });
    const caf = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    return {
      tick() {
        const due = queue;
        queue = [];
        for (const cb of due) cb(performance.now());
      },
      pending: () => queue.length,
      restore() {
        raf.mockRestore();
        caf.mockRestore();
      },
    };
  }

  it("re-measures a container every frame while its ancestor's slide runs, then stops", () => {
    const clock = frameClock();
    const { panel, list, rect } = mountPanelWithList();
    const uninstall = installCustomScrollbars();
    clock.tick(); // the install's own geometry pass
    const measuredBefore = rect.mock.calls.length;
    expect(measuredBefore).toBeGreaterThan(0);

    panel.dispatchEvent(motionEvent("transitionrun", { propertyName: "transform" }));
    for (let i = 0; i < 3; i++) clock.tick();
    // One measurement per frame: the thumb rides the panel instead of standing
    // where a single mid-slide measurement left it.
    expect(rect.mock.calls.length).toBe(measuredBefore + 3);

    panel.dispatchEvent(motionEvent("transitionend", { propertyName: "transform" }));
    clock.tick(); // the end's own full pass (queued by the end event)
    const measuredAtEnd = rect.mock.calls.length;
    clock.tick();
    clock.tick();
    // Nothing left in flight: no further frames are requested.
    expect(rect.mock.calls.length).toBe(measuredAtEnd);
    expect(clock.pending()).toBe(0);

    uninstall();
    list.remove();
    panel.remove();
    clock.restore();
  });

  it("ignores transitions that do not move a box, and a pseudo-element's motion", () => {
    const clock = frameClock();
    const { panel, list, rect } = mountPanelWithList();
    const uninstall = installCustomScrollbars();
    clock.tick();
    const measured = rect.mock.calls.length;

    panel.dispatchEvent(motionEvent("transitionrun", { propertyName: "background-color" }));
    panel.dispatchEvent(
      motionEvent("animationstart", { animationName: "side-panel-drop-pulse", pseudoElement: "::before" }),
    );
    clock.tick();
    clock.tick();
    expect(rect.mock.calls.length).toBe(measured);
    expect(clock.pending()).toBe(0);

    uninstall();
    list.remove();
    panel.remove();
    clock.restore();
  });

  it("keeps following the slide when a colour transition on the same element ends first", () => {
    const clock = frameClock();
    const { panel, list, rect } = mountPanelWithList();
    const uninstall = installCustomScrollbars();
    clock.tick();

    panel.dispatchEvent(motionEvent("transitionrun", { propertyName: "transform" }));
    panel.dispatchEvent(motionEvent("transitionrun", { propertyName: "border-left-color" }));
    panel.dispatchEvent(motionEvent("transitionend", { propertyName: "border-left-color" }));
    clock.tick(); // the end's full pass
    const measured = rect.mock.calls.length;
    clock.tick();
    clock.tick();
    expect(rect.mock.calls.length).toBe(measured + 2);

    uninstall();
    list.remove();
    panel.remove();
    clock.restore();
  });

  it("stops following an element that was unmounted mid-motion", () => {
    const clock = frameClock();
    const { panel, list, rect } = mountPanelWithList();
    const uninstall = installCustomScrollbars();
    clock.tick();

    panel.dispatchEvent(motionEvent("transitionrun", { propertyName: "transform" }));
    clock.tick();
    panel.remove(); // no transitionend will ever come from it
    const measured = rect.mock.calls.length;
    clock.tick();
    clock.tick();
    expect(rect.mock.calls.length).toBe(measured);
    expect(clock.pending()).toBe(0);

    uninstall();
    list.remove();
    clock.restore();
  });
});

describe("stylesheet scrollbar invariants", () => {
  // Comments are prose about scrollbars, including the values banned below.
  // The whole split corpus, in import order — one offender anywhere counts.
  const css: string = readAppStylesheet().replace(/\/\*[\s\S]*?\*\//g, "");

  it("hides every native bar from the baseline, where it still counts", () => {
    // Also the guard against these assertions passing vacuously: an empty or
    // unread stylesheet has no offenders either, which is how a `?raw` import
    // (stubbed to "" by the config's `css: false`) quietly made the whole
    // block meaningless once already.
    expect(css).toMatch(/(^|\n)\*\s*\{[^}]*scrollbar-width\s*:\s*none/);
  });

  it("never asks for a native scrollbar of any width", () => {
    const offenders = [...css.matchAll(/scrollbar-width\s*:\s*([^;}]+)/g)]
      .map((m) => m[1].replace(/!important/, "").trim())
      .filter((value) => value !== "none");
    expect(offenders).toEqual([]);
  });

  it("never sizes a ::-webkit-scrollbar above zero", () => {
    const offenders: string[] = [];
    for (const rule of css.split("}")) {
      const [selector, body] = rule.split("{");
      if (!body || !selector.includes("::-webkit-scrollbar")) continue;
      // The parts of a bar (-thumb, -track, -corner) may carry any size; it is
      // the bar itself whose width/height reserves a gutter.
      if (/::-webkit-scrollbar-/.test(selector)) continue;
      for (const [, prop, value] of body.matchAll(/\b(width|height)\s*:\s*([^;}]+)/g)) {
        if (parseFloat(value) !== 0) offenders.push(`${selector.trim()} { ${prop}: ${value.trim()} }`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("registers the opt-out property so it cannot inherit", () => {
    // An opted-out strip must not mute the thumbs of scroll containers inside
    // it, which only a registered `inherits: false` property guarantees.
    const at = css.match(/@property\s+--app-scrollbar\s*\{[^}]*\}/);
    expect(at?.[0]).toMatch(/inherits\s*:\s*false/);
  });
});

/**
 * Discovery after the fact. A container earns its thumbs by what overflowed
 * when it was found, and is found only when nodes are added under it or when
 * it is first scrolled. Both left the side panel's list bar-less on some opens
 * and not others, depending on what its first paint happened to hold.
 */
describe("installCustomScrollbars discovering late overflow", () => {
  function frameClock() {
    let queue: FrameRequestCallback[] = [];
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      queue.push(cb);
      return queue.length;
    });
    const caf = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    return {
      tick() {
        const due = queue;
        queue = [];
        for (const cb of due) cb(performance.now());
      },
      restore() {
        raf.mockRestore();
        caf.mockRestore();
      },
    };
  }

  function mountList(over: { scrollHeight: number; scrollWidth: number }) {
    const panel = document.createElement("div");
    const list = document.createElement("div");
    list.style.overflowY = "auto";
    list.style.overflowX = "auto";
    const metrics: Record<string, number> = {
      clientHeight: 200,
      clientWidth: 100,
      offsetWidth: 100,
      ...over,
    };
    for (const [key, value] of Object.entries(metrics)) {
      Object.defineProperty(list, key, { value, configurable: true });
    }
    list.getBoundingClientRect = () => ({ top: 0, left: 0, width: 100, height: 200 }) as DOMRect;
    panel.appendChild(list);
    document.body.appendChild(panel);
    (document as unknown as { elementFromPoint: (x: number, y: number) => Element | null })
      .elementFromPoint = () => list;
    return { panel, list };
  }

  const thumbs = (axis: "vertical" | "horizontal") =>
    document.querySelectorAll(`.app-scrollbar-layer .app-scrollbar-${axis}`).length;

  it("grows a vertical thumb for a list that overflowed sideways only when it was found", () => {
    const clock = frameClock();
    // Long names, few rows: the first paint of a file tree.
    const { panel, list } = mountList({ scrollHeight: 200, scrollWidth: 400 });
    const uninstall = installCustomScrollbars();
    clock.tick();
    expect(thumbs("horizontal")).toBe(1);
    expect(thumbs("vertical")).toBe(0);

    // Folders expand: the same element now overflows downward as well. No node
    // was added under it here, and every scan skips it as already registered.
    Object.defineProperty(list, "scrollHeight", { value: 1000, configurable: true });
    window.dispatchEvent(new Event("resize"));
    clock.tick();
    expect(thumbs("vertical")).toBe(1);

    uninstall();
    panel.remove();
    clock.restore();
  });

  it("finds a container that became scrollable by the time the slide it rode in on ended", () => {
    const clock = frameClock();
    // Fits when found: nothing to take over, so it is not registered at all.
    const { panel, list } = mountList({ scrollHeight: 200, scrollWidth: 100 });
    const uninstall = installCustomScrollbars();
    clock.tick();
    expect(list.hasAttribute("data-app-scrollbar")).toBe(false);

    // The panel slides open and, with no DOM change, the list now overflows
    // (a class flip, a width change). The slide's end looks under the panel.
    Object.defineProperty(list, "scrollHeight", { value: 1000, configurable: true });
    panel.dispatchEvent(
      Object.assign(new Event("transitionend", { bubbles: true }), { propertyName: "transform" }),
    );
    clock.tick();
    expect(list.hasAttribute("data-app-scrollbar")).toBe(true);
    expect(thumbs("vertical")).toBe(1);

    uninstall();
    panel.remove();
    clock.restore();
  });

  it("finds a container that overflows once rows arrive inside it", async () => {
    const clock = frameClock();
    // The Git view: its scroll mounts short while the history loads.
    const { panel, list } = mountList({ scrollHeight: 200, scrollWidth: 100 });
    const holder = document.createElement("div");
    list.appendChild(holder);
    const uninstall = installCustomScrollbars();
    clock.tick();
    expect(list.hasAttribute("data-app-scrollbar")).toBe(false);

    // The rows land under a child of the list, not as the list or above it.
    Object.defineProperty(list, "scrollHeight", { value: 1000, configurable: true });
    holder.appendChild(document.createElement("div"));
    await Promise.resolve(); // MutationObserver delivers on a microtask.
    clock.tick();
    expect(list.hasAttribute("data-app-scrollbar")).toBe(true);
    expect(thumbs("vertical")).toBe(1);

    uninstall();
    panel.remove();
    clock.restore();
  });

  it("does not look again on a motion that moves nothing", () => {
    const clock = frameClock();
    const { panel, list } = mountList({ scrollHeight: 200, scrollWidth: 100 });
    const uninstall = installCustomScrollbars();
    clock.tick();
    Object.defineProperty(list, "scrollHeight", { value: 1000, configurable: true });
    panel.dispatchEvent(
      Object.assign(new Event("transitionend", { bubbles: true }), { propertyName: "opacity" }),
    );
    clock.tick();
    expect(list.hasAttribute("data-app-scrollbar")).toBe(false);

    uninstall();
    panel.remove();
    clock.restore();
  });
});
