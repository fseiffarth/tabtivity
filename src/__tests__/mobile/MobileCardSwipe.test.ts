/**
 * The project screen's swipe-to-close drag (`terminal/cardSwipe.ts`): a card
 * leaves when it is pulled far enough left, or flicked; letting go early
 * springs it back, and a rightward pull never closes it.
 */
import { describe, expect, it } from "vitest";
import { cardDragOpacity, cardSwipeCloses } from "../../../mobile-web/src/terminal/cardSwipe";

describe("cardSwipeCloses", () => {
  it("closes past two fifths of the width, however slowly", () => {
    expect(cardSwipeCloses(-160, 400, 2000)).toBe(true);
    expect(cardSwipeCloses(-150, 400, 2000)).toBe(false);
  });
  it("closes on a quick flick from a short pull", () => {
    expect(cardSwipeCloses(-70, 400, 200)).toBe(true);
    expect(cardSwipeCloses(-70, 400, 600)).toBe(false);
    expect(cardSwipeCloses(-30, 400, 100)).toBe(false);
  });
  it("never closes on a rightward pull", () => {
    expect(cardSwipeCloses(200, 400, 100)).toBe(false);
    expect(cardSwipeCloses(0, 400, 100)).toBe(false);
  });
});

describe("cardDragOpacity", () => {
  it("thins out with the pull and keeps a floor", () => {
    expect(cardDragOpacity(0, 400)).toBe(1);
    expect(cardDragOpacity(-200, 400)).toBeCloseTo(0.625);
    expect(cardDragOpacity(-900, 400)).toBe(0.25);
  });
});
