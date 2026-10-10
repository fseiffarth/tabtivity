/**
 * The loaded-PDF notice (`PdfLoadWarningHost`, `docs/tab_cost_plan.md` step
 * 1): after the start-up grace, the 8th loaded PDF shows one self-dismissing
 * toast and the 9th none; inside the grace there is none.
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));

import { PdfLoadWarningHost } from "../../components/layout/PdfLoadWarningHost";
import { PDF_WARN_GRACE_MS, _clearTabCostForTest, registerPdfDoc, updatePdfDoc } from "../../lib/tabCost";

function loadPdf(i: number) {
  const token = {};
  act(() => {
    registerPdfDoc(token, { tabKey: `embed-${i}`, path: `/p/${i}.pdf` });
    updatePdfDoc(token, { pages: 1, bytes: 10 });
  });
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
    expect(toasts()[0].className).toBe("project-switch-toast conn-toast multiline");
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
});
