/**
 * The tab hover card's memory row (`lib/tabCost`, `docs/done/tab_cost_plan.md`
 * step 1): a terminal's estimate with its scrollback rows, a sleeping
 * terminal's "keeps running", a PDF's pages and file size, a released PDF's
 * "Unloaded" — and no row at all for a kind with nothing to estimate.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(() => Promise.resolve()),
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

import type { Terminal } from "@xterm/xterm";
import { TabHoverCard } from "../../components/tabs/TabHoverCard";
import { _clearTabCostForTest, registerPdfDoc, updatePdfDoc } from "../../lib/tabCost";
import { registerTerminal, unregisterTerminal } from "../../lib/terminal/terminalRegistry";
import { _clearAsleepPtysForTest, markPtyAsleep } from "../../lib/terminal/sleepingPtys";
import { useTabsStore, type TabEntry } from "../../stores/tabs";

const tab = (key: string, kind: TabEntry["kind"], viewer?: TabEntry["viewer"]): TabEntry =>
  ({ key, label: key, cmd: "", cwd: "/p", kind, viewer }) as TabEntry;

function card(entry: TabEntry) {
  render(<TabHoverCard tab={entry} scope="p1" anchorX={100} anchorY={20} />);
}

/** The memory row's value, or null when the card has none. */
function memoryRow(): string | null {
  const rows = [...document.querySelectorAll(".tab-popup .pill-popup-path-row")];
  const row = rows.find((r) => r.querySelector(".pill-popup-path-label")?.textContent?.startsWith("memory"));
  return row?.querySelector(".tab-popup-meta")?.textContent ?? null;
}

beforeEach(() => {
  _clearTabCostForTest();
  _clearAsleepPtysForTest();
  useTabsStore.setState({ detachedGroupsByScope: {} });
});
afterEach(() => {
  cleanup();
});

describe("tab hover card memory row", () => {
  it("shows a live terminal's estimate and its rows of the cap", () => {
    const term = {
      buffer: { normal: { length: 1024 } },
      cols: 80,
      rows: 24,
      options: { scrollback: 2000 },
    } as unknown as Terminal;
    registerTerminal("p1:shell-1", term);
    try {
      card(tab("shell-1", "shell"));
      // 1024 × (80 × 12 + 64) B = 1 MiB.
      expect(memoryRow()).toBe(`≈ 1.0 MB · ${(1000).toLocaleString()} of ${(2000).toLocaleString()} lines`);
    } finally {
      unregisterTerminal("p1:shell-1", term);
    }
  });

  it("says a sleeping terminal keeps running, with no size", () => {
    markPtyAsleep("p1:agent-1");
    card(tab("agent-1", "agent"));
    expect(memoryRow()).toBe("Unloaded — the program keeps running");
  });

  it("shows a PDF's pages and file size", () => {
    const token = {};
    registerPdfDoc(token, { tabKey: "embed-1", path: "/p/a.pdf" });
    updatePdfDoc(token, { pages: 12, bytes: 2048 });
    card(tab("embed-1", "embed", "pdf"));
    expect(memoryRow()).toBe("≈ 4.0 KB · 12 pages, 2.0 KB file");
  });

  it("says a PDF with no viewer mounted is unloaded", () => {
    card(tab("embed-2", "embed", "pdf"));
    expect(memoryRow()).toBe("Unloaded — reloads when shown");
  });

  it("has no row for a calendar tab", () => {
    card(tab("cal-1", "calendar"));
    expect(document.querySelector(".tab-popup")).not.toBeNull();
    expect(memoryRow()).toBeNull();
  });
});
