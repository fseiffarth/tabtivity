/**
 * Tests for the small pure pieces exported from `components/embed/deck/DeckView`
 * — the slide-overview rail's resize clamp (mirroring the same bounds-check
 * `SubwindowFilesSidebar.test.ts` runs for its own resizable column), and the
 * asset-path pair that decides whether a placed image survives the deck being
 * moved, synced to a host, or opened on another machine.
 */

import { describe, it, expect } from "vitest";
import {
  DECK_RAIL_MAX_WIDTH,
  DECK_RAIL_MIN_WIDTH,
  clampRailWidth,
  deckRelative,
  withinProject,
} from "../../components/embed/deck/DeckView";
import { resolveRel } from "../../components/embed/deck/deckAssets";

describe("clampRailWidth", () => {
  it("clamps to the documented bounds", () => {
    expect(clampRailWidth(1)).toBe(DECK_RAIL_MIN_WIDTH);
    expect(clampRailWidth(10_000)).toBe(DECK_RAIL_MAX_WIDTH);
  });

  it("rounds to a whole pixel", () => {
    expect(clampRailWidth(150.6)).toBe(151);
  });

  it("leaves an in-range width alone", () => {
    expect(clampRailWidth(150)).toBe(150);
  });
});

describe("deckRelative (V #108)", () => {
  it("relativizes a file UNDER the deck's own folder", () => {
    expect(deckRelative("/p/talks", "/p/talks/fig.png")).toBe("fig.png");
    expect(deckRelative("/p/talks", "/p/talks/img/fig.png")).toBe("img/fig.png");
  });

  it("walks up for a file beside or above it — the case that was stored ABSOLUTE", () => {
    // The old spelling relativized only files under the deck's folder, so a
    // figure in `<project>/figures/` picked into a deck in `<project>/talks/`
    // was stored absolute — and broke the moment the project was synced or moved.
    expect(deckRelative("/p/talks", "/p/figures/fig.png")).toBe("../figures/fig.png");
    expect(deckRelative("/p/talks/2026", "/p/fig.png")).toBe("../../fig.png");
    expect(deckRelative("/p/talks", "/p")).toBe("..");
  });

  it("keeps an absolute path when there is genuinely no relative form", () => {
    // Different roots (another Windows drive). A `..` chain across roots would be
    // a path that resolves to nothing.
    expect(deckRelative("C:/p/talks", "D:/other/fig.png")).toBe("D:/other/fig.png");
    expect(deckRelative("", "/p/fig.png")).toBe("/p/fig.png");
  });

  it("normalizes backslashes and trailing separators", () => {
    expect(deckRelative("/p/talks/", "/p/talks/fig.png")).toBe("fig.png");
    expect(deckRelative("C:\\p\\talks", "C:\\p\\talks\\fig.png")).toBe("fig.png");
  });
});

describe("resolveRel", () => {
  it("folds the `..` a deckRelative path climbs with, which the backend refuses", () => {
    // The round trip of V #108: a figure above the deck is stored `../…`, and
    // `read_file_bytes` refuses any path still holding a `..` (gap 22).
    const src = deckRelative("/p/talks", "/p/figures/fig.png");
    expect(resolveRel("/p/talks", src)).toBe("/p/figures/fig.png");
    expect(resolveRel("/p/talks/2026", "../../fig.png")).toBe("/p/fig.png");
    expect(resolveRel("C:\\p\\talks", "../figures/fig.png")).toBe("C:\\p\\figures\\fig.png");
    expect(resolveRel("/p/talks", "/p/x/../fig.png")).toBe("/p/fig.png");
  });

  it("leaves a plain path exactly as joined", () => {
    expect(resolveRel("/p/talks", "img/fig.png")).toBe("/p/talks/img/fig.png");
    expect(resolveRel("/p/talks", "/abs/fig.png")).toBe("/abs/fig.png");
    expect(resolveRel("", "fig.png")).toBe("fig.png");
    expect(resolveRel("/p/talks", "fig..png")).toBe("/p/talks/fig..png");
  });
});

describe("withinProject (V #108)", () => {
  it("accepts the project root and anything under it", () => {
    expect(withinProject("/p", "/p")).toBe(true);
    expect(withinProject("/p", "/p/figures/fig.png")).toBe(true);
  });

  it("refuses a file outside — which would be permanently unreadable", () => {
    // `read_file_bytes` confines to the scope project's roots, so an outside
    // file is stored, shown once from the picker, and then never loadable again:
    // a placeholder on the slide and a "not available" warning in every export.
    expect(withinProject("/p", "/elsewhere/fig.png")).toBe(false);
    // A sibling whose name merely starts the same is NOT inside it.
    expect(withinProject("/p", "/p-other/fig.png")).toBe(false);
  });

  it("defers to the backend in the root scope", () => {
    expect(withinProject(null, "/anywhere/fig.png")).toBe(true);
  });
});
