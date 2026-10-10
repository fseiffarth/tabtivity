/**
 * The loaded-PDF notice (`PdfLoadWarningHost`, `docs/tab_cost_plan.md` step
 * 1): after the start-up grace, the 8th loaded PDF shows one self-dismissing
 * toast and the 9th none; inside the grace there is none.
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));

import { PdfLoadWarningHost } from "../../components/layout/PdfLoadWarningHost";
import {
  PDF_WARN_GRACE_MS,
  _clearTabCostForTest,
  registerPdfDoc,
  unregisterPdfDoc,
  updatePdfDoc,
} from "../../lib/tabCost";
import { readAppStylesheet } from "../helpers/cssCorpus";

function loadPdf(i: number): object {
  const token = {};
  act(() => {
    registerPdfDoc(token, { tabKey: `embed-${i}`, path: `/p/${i}.pdf` });
    updatePdfDoc(token, { pages: 1, bytes: 10 });
  });
  return token;
}

const toasts = () => document.querySelectorAll("[data-pdf-warn]");

beforeEach(() => {
  _clearTabCostForTest();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("PdfLoadWarningHost", () => {
  it("shows one toast at the 8th loaded PDF after the grace period, none at the 9th", () => {
    // Fake timers first: they install a fake `performance` the spy then targets.
    vi.useFakeTimers();
    vi.spyOn(performance, "now").mockReturnValue(PDF_WARN_GRACE_MS + 1);
    render(<PdfLoadWarningHost />);
    for (let i = 1; i <= 7; i++) loadPdf(i);
    expect(toasts()).toHaveLength(0);
    loadPdf(8);
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0].textContent).toContain("8 PDFs are loaded at once.");
    expect(toasts()[0].className).toBe("project-switch-toast conn-toast multiline pdf-warn-toast");
    act(() => {
      vi.advanceTimersByTime(3200);
    });
    expect(toasts()).toHaveLength(0);
    loadPdf(9);
    expect(toasts()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stays quiet inside the start-up grace", () => {
    vi.spyOn(performance, "now").mockReturnValue(PDF_WARN_GRACE_MS - 1);
    render(<PdfLoadWarningHost />);
    for (let i = 1; i <= 9; i++) loadPdf(i);
    expect(toasts()).toHaveLength(0);
  });

  it("shows once when the grace ends on a crossing made inside it that never moved again", () => {
    vi.useFakeTimers();
    const now = vi.spyOn(performance, "now").mockReturnValue(PDF_WARN_GRACE_MS - 1000);
    render(<PdfLoadWarningHost />);
    for (let i = 1; i <= 9; i++) loadPdf(i);
    expect(toasts()).toHaveLength(0);
    // The one-shot grace-end check is the only timer.
    expect(vi.getTimerCount()).toBe(1);
    now.mockReturnValue(PDF_WARN_GRACE_MS);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0].textContent).toContain("9 PDFs are loaded at once.");
    act(() => {
      vi.advanceTimersByTime(3200);
    });
    expect(toasts()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    // Same crossing: no second notice on the next change.
    loadPdf(10);
    expect(toasts()).toHaveLength(0);
  });

  it("still looks when the grace-end timer fires on a clock reading just short of the grace", () => {
    // A browser truncates setTimeout's delay to whole ms, and performance.now()
    // is coarsened: mounted at G − 1000.5, the timer may fire on G − 0.5.
    vi.useFakeTimers();
    const now = vi.spyOn(performance, "now").mockReturnValue(PDF_WARN_GRACE_MS - 1000.5);
    render(<PdfLoadWarningHost />);
    for (let i = 1; i <= 9; i++) loadPdf(i);
    now.mockReturnValue(PDF_WARN_GRACE_MS - 0.5);
    act(() => {
      vi.advanceTimersByTime(1001);
    });
    expect(toasts()).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1); // only the toast's own dismissal
  });

  it("stays quiet when the grace ends below the threshold", () => {
    vi.useFakeTimers();
    const now = vi.spyOn(performance, "now").mockReturnValue(PDF_WARN_GRACE_MS - 1000);
    render(<PdfLoadWarningHost />);
    const tokens = Array.from({ length: 9 }, (_, i) => loadPdf(i + 1));
    act(() => {
      for (const tok of tokens.slice(0, 3)) unregisterPdfDoc(tok);
    });
    now.mockReturnValue(PDF_WARN_GRACE_MS);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(toasts()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sets no grace timer in a window older than the grace", () => {
    vi.useFakeTimers();
    vi.spyOn(performance, "now").mockReturnValue(PDF_WARN_GRACE_MS + 1);
    render(<PdfLoadWarningHost />);
    expect(vi.getTimerCount()).toBe(0);
  });
});

/** Every `top:` declared for `selector`, in stylesheet order. */
function topsOf(css: string, selector: string): string[] {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...css.matchAll(new RegExp(`(?:^|[}/])\\s*${esc}\\s*\\{([^}]*)\\}`, "g"))]
    .map((m) => /(?:^|;|\s)top:\s*([^;]+);/.exec(m[1])?.[1].trim())
    .filter((v): v is string => v !== undefined);
}

describe("PdfLoadWarningHost placement", () => {
  it("sits in its own slot below the connection toast, never on top of it", () => {
    vi.useFakeTimers();
    vi.spyOn(performance, "now").mockReturnValue(PDF_WARN_GRACE_MS + 1);
    render(<PdfLoadWarningHost />);
    for (let i = 1; i <= 8; i++) loadPdf(i);
    expect(toasts()[0].classList.contains("pdf-warn-toast")).toBe(true);

    const css = readAppStylesheet();
    const conn = topsOf(css, ".conn-toast");
    const pdf = topsOf(css, ".conn-toast.pdf-warn-toast");
    expect(conn).toHaveLength(1);
    expect(pdf).toHaveLength(1);
    expect(pdf[0]).not.toBe(conn[0]);
    // Both carry `.conn-toast`; the more specific rule must win, below it.
    const px = (v: string) => Number(/50% \+ (\d+)px/.exec(v)?.[1]);
    expect(px(pdf[0])).toBeGreaterThan(px(conn[0]) + 46);
  });

  it("wraps its long second line instead of cutting it off in a narrow window", () => {
    const css = readAppStylesheet();
    const rule = [...css.matchAll(/(?:^|[}/])\s*\.conn-toast\.pdf-warn-toast\s*\{([^}]*)\}/g)].map((m) => m[1]);
    expect(rule).toHaveLength(1);
    // `.multiline` sets `pre` (no wrap) and the base toast ellipsizes; the
    // notice keeps its newline but wraps.
    expect(/white-space:\s*pre-line;/.test(rule[0])).toBe(true);
  });
});
