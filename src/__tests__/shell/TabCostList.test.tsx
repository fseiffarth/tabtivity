/**
 * Settings → Power & performance → "What open tabs hold" (`TabCostList`,
 * `docs/done/tab_cost_plan.md` step 1): rows largest first across every loaded
 * scope, Close through `closeTabInScope`, Show only for the current scope's
 * tabs (activates and closes Settings), Refresh re-reads, and the collapsed
 * lines for tabs with nothing loaded and PDFs outside a tab.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const closeTabInScope = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(() => Promise.resolve()),
  listen: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("../../lib/remote/closeRemoteTab", () => ({ closeTabInScope }));

import { TabCostList } from "../../components/layout/TabCostList";
import { _clearTabCostForTest, registerPdfDoc, unregisterPdfDoc, updatePdfDoc } from "../../lib/tabCost";
import { _clearAsleepPtysForTest, markPtyAsleep } from "../../lib/terminal/sleepingPtys";
import { useTabsStore, type TabEntry } from "../../stores/tabs";

const tab = (key: string, kind: TabEntry["kind"], viewer?: TabEntry["viewer"]): TabEntry =>
  ({ key, label: `label-${key}`, cmd: "", cwd: "/p", kind, viewer }) as TabEntry;

function pdf(tabKey: string | undefined, bytes: number) {
  const token = {};
  registerPdfDoc(token, { tabKey, path: `/p/${tabKey ?? "side"}.pdf` });
  updatePdfDoc(token, { pages: 1, bytes });
  return token;
}

const rowKeys = () => [...document.querySelectorAll("[data-tab-cost]")].map((r) => r.getAttribute("data-tab-cost"));
const rowOf = (key: string) => document.querySelector(`[data-tab-cost="${key}"]`)!;

let setActive: ReturnType<typeof vi.fn>;

beforeEach(() => {
  _clearTabCostForTest();
  _clearAsleepPtysForTest();
  closeTabInScope.mockReset();
  setActive = vi.fn();
  const current = [tab("embed-small", "embed", "pdf"), tab("embed-big", "embed", "pdf"), tab("agent-1", "agent"), tab("cal-1", "calendar")];
  useTabsStore.setState({
    scope: "p1",
    tabs: current,
    // The current scope's entry here is stale on purpose: `tabs` wins.
    tabsByScope: { p1: [], p2: [tab("embed-other", "embed", "pdf"), tab("embed-unloaded", "embed", "pdf")] },
    detachedGroupsByScope: {},
    setActive: setActive as unknown as (key: string) => void,
  });
  pdf("embed-small", 100);
  pdf("embed-big", 10_000);
  pdf("embed-other", 1_000);
  pdf(undefined, 50);
  markPtyAsleep("p1:agent-1");
});
afterEach(() => {
  cleanup();
});

describe("TabCostList", () => {
  it("lists tabs with an estimate largest first and collapses the rest", () => {
    render(<TabCostList onClose={() => {}} />);
    expect(rowKeys()).toEqual(["embed-big", "embed-other", "embed-small"]);
    // agent-1 (asleep) and embed-unloaded have a line but no estimate; the
    // calendar has none at all.
    expect(screen.getByText("2 more tabs hold nothing loaded")).toBeTruthy();
    expect(screen.getByText(/1 PDF open outside a tab/)).toBeTruthy();
    expect(screen.getByText(/PDFs loaded now: 4\./)).toBeTruthy();
  });

  it("offers Show only for the current scope's tabs: it activates and closes Settings", () => {
    const onClose = vi.fn();
    render(<TabCostList onClose={onClose} />);
    expect(rowOf("embed-other").textContent).not.toContain("Show");
    fireEvent.click(screen.getAllByText("Show")[0]);
    expect(setActive).toHaveBeenCalledWith("embed-big");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes a tab of any scope through closeTabInScope", () => {
    render(<TabCostList onClose={() => {}} />);
    const close = rowOf("embed-other").querySelectorAll("button");
    fireEvent.click(close[close.length - 1]);
    expect(closeTabInScope).toHaveBeenCalledWith("p2", "embed-other");
  });

  it("re-reads on Refresh, not on its own", () => {
    render(<TabCostList onClose={() => {}} />);
    pdf("embed-unloaded", 99_000);
    expect(rowKeys()).toEqual(["embed-big", "embed-other", "embed-small"]);
    fireEvent.click(screen.getByText("Refresh"));
    expect(rowKeys()).toEqual(["embed-unloaded", "embed-big", "embed-other", "embed-small"]);
    expect(screen.getByText("1 more tab holds nothing loaded")).toBeTruthy();
  });
});

/** Stands in for a mounted `PdfCanvas`: registered while its tab is open,
 *  unregistered in its unmount effect, as the real one is. */
function FakeCanvas({ tabKey, bytes }: { tabKey: string; bytes: number }) {
  useEffect(() => {
    const token = {};
    registerPdfDoc(token, { tabKey, path: `/p/${tabKey}.pdf` });
    updatePdfDoc(token, { pages: 1, bytes });
    return () => unregisterPdfDoc(token);
  }, [tabKey, bytes]);
  return null;
}

function OpenPdfTabs() {
  const tabs = useTabsStore((s) => s.tabs);
  return (
    <>
      {tabs
        .filter((t) => t.viewer === "pdf")
        .map((t) => (
          <FakeCanvas key={t.key} tabKey={t.key} bytes={t.key === "embed-big" ? 10_000 : 100} />
        ))}
    </>
  );
}

describe("TabCostList after Close", () => {
  it("re-reads once the closed tab's viewer has unmounted, not before", () => {
    _clearTabCostForTest();
    pdf(undefined, 50); // a side-panel preview: the one PDF outside a tab
    closeTabInScope.mockImplementation((_scope: string, key: string) => {
      useTabsStore.setState((s) => ({ tabs: s.tabs.filter((t) => t.key !== key) }));
    });
    render(
      <>
        <OpenPdfTabs />
        <TabCostList onClose={() => {}} />
      </>,
    );
    fireEvent.click(screen.getByText("Refresh"));
    expect(rowKeys()).toEqual(["embed-big", "embed-small"]);
    expect(screen.getByText(/PDFs loaded now: 3\./)).toBeTruthy();

    const close = rowOf("embed-big").querySelectorAll("button");
    fireEvent.click(close[close.length - 1]);

    expect(rowKeys()).toEqual(["embed-small"]);
    // The closed tab's document is gone, not re-listed "outside a tab".
    expect(screen.getByText(/1 PDF open outside a tab/)).toBeTruthy();
    expect(screen.getByText(/PDFs loaded now: 2\./)).toBeTruthy();
  });
});
