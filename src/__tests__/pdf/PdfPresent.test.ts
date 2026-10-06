/**
 * Tests for the fullscreen PDF present window's link
 * (`components/embed/pdf/present`).
 *
 * The cases worth reading are the ones that encode a decision. That the window
 * label is derived from the PDF's *path*, so pressing Present twice for one file
 * targets the window already up rather than stacking a second one on the
 * projector. That a PDF label is told apart from a deck audience label — they
 * share the `present-` prefix deliberately, because that prefix is what the
 * window capabilities are granted by, so `App` routes on the rest of it. And
 * that a page request is clamped against the document rather than at the key
 * handler, because the seed arrives before the file is open.
 */

import { describe, it, expect } from "vitest";
import {
  PDF_PRESENT_READY,
  TALK_TARGETS,
  clampPage,
  clockElapsed,
  clockTone,
  formatClock,
  isPdfPresentLabel,
  nextTarget,
  pdfPresentLabel,
  pdfPresentSeedEvent,
  resetClock,
  startClock,
  toggleClock,
} from "../../components/embed/pdf/present";
import { parsePresentParam, presenterLabel } from "../../lib/viewers/deck/present";

describe("pdf present labels", () => {
  it("derives one label per path, so a second Present re-uses the window", () => {
    const a = pdfPresentLabel("/home/x/talk.pdf");
    expect(a).toBe(pdfPresentLabel("/home/x/talk.pdf"));
    expect(a).not.toBe(pdfPresentLabel("/home/x/other.pdf"));
  });

  it("is a valid present-window label, which is what the capabilities grant", () => {
    const label = pdfPresentLabel("/home/x/talk.pdf");
    expect(label.startsWith("present-pdf-")).toBe(true);
    expect(/^present-[A-Za-z0-9_-]+$/.test(label)).toBe(true);
    expect(label.length).toBeLessThanOrEqual(64);
    // And survives the round trip through the window's own query.
    expect(parsePresentParam(`?present=${label}`)).toBe(label);
  });

  it("is never confused with a deck audience label", () => {
    expect(isPdfPresentLabel(pdfPresentLabel("/home/x/talk.pdf"))).toBe(true);
    // A deck label carries exactly one hyphen, so it can never grow a `pdf-`
    // segment however its hash comes out.
    expect(isPdfPresentLabel(presenterLabel("/home/x/talk.eldeck.json"))).toBe(false);
    expect(isPdfPresentLabel("present-pdf")).toBe(false);
    expect(isPdfPresentLabel("present-pdf-")).toBe(false);
    expect(isPdfPresentLabel("main")).toBe(false);
  });

  it("namespaces the seed channel per window", () => {
    expect(pdfPresentSeedEvent("present-pdf-a")).not.toBe(pdfPresentSeedEvent("present-pdf-b"));
    // The readiness channel is shared — it carries its own label.
    expect(PDF_PRESENT_READY).toBe("pdf-present-ready");
  });
});

describe("clampPage", () => {
  it("keeps a request inside the document", () => {
    expect(clampPage(1, 10)).toBe(1);
    expect(clampPage(10, 10)).toBe(10);
    expect(clampPage(11, 10)).toBe(10);
    expect(clampPage(0, 10)).toBe(1);
    expect(clampPage(-3, 10)).toBe(1);
  });

  it("answers 1 while the page count is still unknown", () => {
    // The seed lands before the document is open; asking pdf.js for page 0 of a
    // document with no pages is the failure this avoids.
    expect(clampPage(7, 0)).toBe(1);
    expect(clampPage(Number.NaN, 5)).toBe(1);
  });
});

describe("talk clock", () => {
  it("runs from its start and banks across a pause", () => {
    let c = startClock(1_000);
    expect(clockElapsed(c, 61_000)).toBe(60_000);
    c = toggleClock(c, 61_000); // pause at 1:00
    expect(c.since).toBeNull();
    // A paused clock does not move, however long the pause.
    expect(clockElapsed(c, 500_000)).toBe(60_000);
    c = toggleClock(c, 500_000); // resume
    expect(clockElapsed(c, 530_000)).toBe(90_000);
  });

  it("resets to zero and keeps whether it runs", () => {
    const running = resetClock(startClock(0), 50_000);
    expect(clockElapsed(running, 55_000)).toBe(5_000);
    // A paused reset arms the clock for a talk that has not started yet.
    const paused = resetClock(toggleClock(startClock(0), 50_000), 60_000);
    expect(paused.since).toBeNull();
    expect(clockElapsed(paused, 999_000)).toBe(0);
  });

  it("formats minutes under an hour and hours past it", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(59_999)).toBe("0:59");
    expect(formatClock(605_000)).toBe("10:05");
    expect(formatClock(3_725_000)).toBe("1:02:05");
    expect(formatClock(-5_000)).toBe("0:00");
  });

  it("cycles targets back to none", () => {
    let t = 0;
    const seen = new Set<number>();
    for (let i = 0; i < TALK_TARGETS.length; i++) {
      t = nextTarget(t);
      seen.add(t);
    }
    expect(t).toBe(0);
    expect(seen.size).toBe(TALK_TARGETS.length);
    // An unknown value (none of the steps) starts over at the first target.
    expect(nextTarget(7)).toBe(0);
  });

  it("warns in the last tenth of the target and past it", () => {
    expect(clockTone(9 * 60_000, 0, false)).toBe("ok");
    expect(clockTone(8 * 60_000, 10, false)).toBe("ok");
    expect(clockTone(9 * 60_000, 10, false)).toBe("near");
    expect(clockTone(10 * 60_000, 10, false)).toBe("over");
    expect(clockTone(10 * 60_000, 10, true)).toBe("paused");
  });
});
