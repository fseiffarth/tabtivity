/**
 * `lib/tabCost` (`docs/done/tab_cost_plan.md` step 1): the per-window PDF document
 * registry and its loaded count, the terminal estimate read off the live
 * xterm, the per-tab reader, the ranking, and the loaded-PDF notice's
 * hysteresis.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));

import type { Terminal } from "@xterm/xterm";
import {
  PDF_LOADED_REARM_AT,
  PDF_LOADED_WARN_AT,
  PDF_WARN_GRACE_MS,
  PDF_WARN_INITIAL,
  _clearTabCostForTest,
  costBytes,
  describeTabCost,
  loadedPdfCount,
  pdfCostFor,
  pdfWarnGraceLeft,
  pdfWarnStep,
  rankTabCosts,
  registerPdfDoc,
  subscribeLoadedPdfCount,
  tabCost,
  terminalCost,
  unregisterPdfDoc,
  untabbedPdfCost,
  updatePdfDoc,
  type PdfWarnState,
} from "../../lib/tabCost";
import { registerTerminal, unregisterTerminal } from "../../lib/terminal/terminalRegistry";
import { _clearAsleepPtysForTest, markPtyAsleep } from "../../lib/terminal/sleepingPtys";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { en, translate, type Dict, type TranslationKey } from "../../lib/i18n";
import { dict as de } from "../../lib/i18n/de";
import { dict as es } from "../../lib/i18n/es";
import { dict as fr } from "../../lib/i18n/fr";
import { dict as it_ } from "../../lib/i18n/it";

function fakeTerm(length: number, cols: number, rows: number, scrollback: number): Terminal {
  return {
    buffer: { normal: { length } },
    cols,
    rows,
    options: { scrollback },
  } as unknown as Terminal;
}

const tab = (key: string, kind: TabEntry["kind"], viewer?: TabEntry["viewer"]): TabEntry =>
  ({ key, label: key, cmd: "", cwd: "/p", kind, viewer }) as TabEntry;

const registered: { id: string; term: Terminal }[] = [];
function addTerm(id: string, term: Terminal) {
  registerTerminal(id, term);
  registered.push({ id, term });
}

beforeEach(() => {
  _clearTabCostForTest();
  _clearAsleepPtysForTest();
  useTabsStore.setState({ detachedGroupsByScope: {} });
});
afterEach(() => {
  for (const { id, term } of registered.splice(0)) unregisterTerminal(id, term);
});

describe("PDF registry", () => {
  it("counts only entries holding a document, and notifies only when the count moves", () => {
    const seen: number[] = [];
    const off = subscribeLoadedPdfCount((n) => seen.push(n));
    const a = {};
    const b = {};
    registerPdfDoc(a, { tabKey: "embed-1", path: "/p/a.pdf" });
    registerPdfDoc(b, { tabKey: "embed-2", path: "/p/b.pdf" });
    expect(loadedPdfCount()).toBe(0);
    updatePdfDoc(a, { pages: 3, bytes: 1000 });
    // A reload of the same viewer moves nothing.
    updatePdfDoc(a, { pages: 4, bytes: 1200 });
    updatePdfDoc(b, { pages: 1, bytes: 10 });
    expect(loadedPdfCount()).toBe(2);
    // A file switch in flight: no document, no count.
    updatePdfDoc(b, { pages: 0, bytes: 0 });
    unregisterPdfDoc(a);
    unregisterPdfDoc(a);
    expect(seen).toEqual([1, 2, 1, 0]);
    off();
    registerPdfDoc(a, { path: "/x.pdf" });
    updatePdfDoc(a, { pages: 1, bytes: 1 });
    expect(seen).toEqual([1, 2, 1, 0]);
  });

  it("sums a tab with its TeX sub-panes and keeps the rest outside a tab", () => {
    const own = {};
    const sub = {};
    const side = {};
    const otherScope = {};
    registerPdfDoc(own, { tabKey: "embed-ws", path: "/p/a.pdf" });
    registerPdfDoc(sub, { tabKey: "embed-ws#/p/b.pdf", path: "/p/b.pdf" });
    registerPdfDoc(side, { path: "/p/c.pdf" });
    registerPdfDoc(otherScope, { tabKey: "embed-gone", path: "/p/d.pdf" });
    updatePdfDoc(own, { pages: 2, bytes: 100 });
    updatePdfDoc(sub, { pages: 5, bytes: 300 });
    updatePdfDoc(side, { pages: 1, bytes: 50 });
    updatePdfDoc(otherScope, { pages: 1, bytes: 25 });
    expect(pdfCostFor("embed-ws")).toEqual({ entries: 2, docs: 2, pages: 7, bytes: 400, estBytes: 800 });
    // A key that merely shares a prefix is not a sub-pane.
    expect(pdfCostFor("embed-w")).toBeNull();
    expect(untabbedPdfCost(new Set(["embed-ws"]))).toMatchObject({ docs: 2, bytes: 75 });
    expect(untabbedPdfCost(new Set(["embed-ws", "embed-gone"]))).toMatchObject({ docs: 1, bytes: 50 });
    unregisterPdfDoc(side);
    unregisterPdfDoc(otherScope);
    expect(untabbedPdfCost(new Set(["embed-ws"]))).toBeNull();
  });
});

describe("terminalCost", () => {
  it("estimates a live xterm from its buffer", () => {
    addTerm("p1:shell-1", fakeTerm(124, 80, 24, 2000));
    const cost = terminalCost("p1:shell-1");
    expect(cost).toEqual({ state: "live", rows: 100, cols: 80, cap: 2000, estBytes: 124 * (80 * 12 + 64) });
  });

  it("says asleep, elsewhere or unbuilt — never a size", () => {
    markPtyAsleep("p1:agent-1");
    expect(terminalCost("p1:agent-1")).toEqual({ state: "asleep" });
    useTabsStore.setState({
      detachedGroupsByScope: {
        p1: [{ id: "g9", label: "popout-g9", subtree: { type: "group", id: "g9", tabKeys: ["shell-2"], activeKey: "shell-2" } }],
      },
    });
    expect(terminalCost("p1:shell-2")).toEqual({ state: "elsewhere" });
    expect(terminalCost("p1:shell-3")).toEqual({ state: "unbuilt" });
    expect(costBytes({ kind: "terminal", state: "unbuilt" })).toBeUndefined();
  });
});

describe("tabCost", () => {
  it("reads terminals, PDFs, released PDFs and nothing for other kinds", () => {
    addTerm("p1:shell-1", fakeTerm(30, 100, 30, 5000));
    expect(tabCost("p1", tab("shell-1", "shell"))).toMatchObject({ kind: "terminal", state: "live" });
    const t = {};
    registerPdfDoc(t, { tabKey: "embed-1", path: "/p/a.pdf" });
    // Loading: an entry with no document says nothing.
    expect(tabCost("p1", tab("embed-1", "embed", "pdf"))).toBeNull();
    updatePdfDoc(t, { pages: 3, bytes: 500 });
    expect(tabCost("p1", tab("embed-1", "embed", "pdf"))).toMatchObject({ kind: "pdf", pages: 3, estBytes: 1000 });
    expect(tabCost("p1", tab("embed-2", "embed", "pdf"))).toEqual({ kind: "unloaded" });
    expect(tabCost("p1", tab("embed-3", "embed", "texworkspace"))).toEqual({ kind: "unloaded" });
    expect(tabCost("p1", tab("cal-1", "calendar"))).toBeNull();
    expect(tabCost("p1", tab("embed-4", "embed", "markdown"))).toBeNull();
    useTabsStore.setState({
      detachedGroupsByScope: {
        p1: [{ id: "g9", label: "popout-g9", subtree: { type: "group", id: "g9", tabKeys: ["embed-2"], activeKey: "embed-2" } }],
      },
    });
    expect(tabCost("p1", tab("embed-2", "embed", "pdf"))).toEqual({ kind: "elsewhere" });
  });

  it("a Files tab previewing a PDF gets a line from its registry entry", () => {
    const t = {};
    registerPdfDoc(t, { tabKey: "files-1", path: "/p/a.pdf" });
    updatePdfDoc(t, { pages: 1, bytes: 10 });
    expect(tabCost("p1", tab("files-1", "files"))).toMatchObject({ kind: "pdf", pages: 1 });
  });
});

describe("rankTabCosts", () => {
  it("orders by estimate and counts the rest", () => {
    const { ranked, others } = rankTabCosts([
      { key: "a", cost: { kind: "pdf", entries: 1, docs: 1, pages: 1, bytes: 10, estBytes: 20 } },
      { key: "b", cost: { kind: "terminal", state: "live", rows: 1, cols: 1, cap: 1, estBytes: 500 } },
      { key: "c", cost: { kind: "unloaded" } },
      { key: "d", cost: { kind: "terminal", state: "asleep" } },
      { key: "e", cost: null },
    ]);
    expect(ranked.map((r) => r.key)).toEqual(["b", "a"]);
    expect(others).toBe(2);
  });
});

describe("pdfWarnStep", () => {
  const AFTER = PDF_WARN_GRACE_MS + 1;
  function run(counts: number[], now = AFTER, start: PdfWarnState = PDF_WARN_INITIAL) {
    let state = start;
    const fired: number[] = [];
    for (const n of counts) {
      const step = pdfWarnStep(state, n, now);
      state = step.state;
      if (step.fire) fired.push(n);
    }
    return { fired, state };
  }

  it("fires once at 8, not at 9, and re-arms at 5", () => {
    expect(PDF_LOADED_WARN_AT).toBe(8);
    expect(PDF_LOADED_REARM_AT).toBe(5);
    expect(run([6, 7, 8, 9, 8, 7, 6]).fired).toEqual([8]);
    expect(run([6, 7, 8, 9, 8, 7, 6, 5, 6, 7, 8]).fired).toEqual([8, 8]);
  });

  it("stays quiet in the grace period but armed, and fires on the next change after it", () => {
    const early = run([7, 8, 9], PDF_WARN_GRACE_MS - 1);
    expect(early.fired).toEqual([]);
    expect(early.state.armed).toBe(true);
    expect(run([10], AFTER, early.state).fired).toEqual([10]);
  });
});

describe("pdfWarnGraceLeft", () => {
  it("counts down to the end of the grace, then is null", () => {
    expect(pdfWarnGraceLeft(0)).toBe(PDF_WARN_GRACE_MS);
    expect(pdfWarnGraceLeft(PDF_WARN_GRACE_MS - 250)).toBe(250);
    expect(pdfWarnGraceLeft(PDF_WARN_GRACE_MS)).toBeNull();
    expect(pdfWarnGraceLeft(PDF_WARN_GRACE_MS + 1)).toBeNull();
  });
});

describe("describeTabCost plurals", () => {
  const t = (key: TranslationKey, params?: Record<string, string | number>) => translate("en", key, params);
  const pdf = (pages: number) =>
    describeTabCost({ kind: "pdf", entries: 1, docs: 1, pages, bytes: 1024, estBytes: 2048 }, t);

  it("says 1 page, not 1 pages", () => {
    expect(pdf(1)).toContain("1 page,");
    expect(pdf(1)).not.toContain("pages");
    expect(pdf(2)).toContain("2 pages,");
  });

  it("has a singular form in every language for each counted line", () => {
    const dicts: Dict[] = [en, de, es, fr, it_];
    for (const d of dicts) {
      for (const [one, many] of [
        ["settings.tabCostsOthersOne", "settings.tabCostsOthers"],
        ["settings.tabCostsUntabbedOne", "settings.tabCostsUntabbed"],
        ["tabCost.pdfOne", "tabCost.pdf"],
      ] as const) {
        expect(d[one]).toBeTruthy();
        expect(d[one]).not.toBe(d[many]);
        expect(d[one]).not.toContain("{n}");
      }
    }
  });
});
