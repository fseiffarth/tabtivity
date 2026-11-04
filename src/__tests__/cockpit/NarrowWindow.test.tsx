/**
 * The window's width bands (`docs/cockpit_root_merge_plan.md`, decision 8):
 * 1180 px and up is the full layout, 820 to 1179 px Now's rail is the icon rail
 * (the full one in a popover) beside roster and detail, under 820 px Now is
 * master / detail with a "Needs you N" chip. The band is measured on the frame
 * and tested at its edges; the CSS that follows it needs a layout engine and is
 * not run here.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn((cmd: string, _args?: unknown) => {
  if (cmd === "root_mcp_status") return Promise.resolve({ running: true, tools: [] });
  return Promise.resolve([]);
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emit: vi.fn() }));
vi.mock("../../components/tabs/TabPane", () => ({
  TabPane: (props: { tab: { key: string } }) => <div data-testid={`attached-${props.tab.key}`} />,
}));
// The lazy view body resolves to Now, already imported below (no cold import
// inside a loaded run).
vi.mock("../../components/cockpit/CockpitViews", async () => {
  const { CockpitNow } = await import("../../components/cockpit/CockpitNow");
  return { CockpitViewBody: () => <CockpitNow /> };
});
vi.mock("../../lib/shortcuts/tabJump", () => ({ jumpToTab: vi.fn(), openPromptChartTab: vi.fn() }));

import { CockpitNow } from "../../components/cockpit/CockpitNow";
import { RootOverlayHost } from "../../components/layout/RootOverlay";
import { FrameBandContext, frameBand, type FrameBand } from "../../lib/window/frameBand";
import { useActivityStore } from "../../stores/activity";
import { useBoxesStore } from "../../stores/boxes";
import { useCockpitStore } from "../../stores/cockpit";
import { useOverlayAgentStore } from "../../stores/overlayAgent";
import { useProjectsStore } from "../../stores/projects";
import { useRootOverlayStore } from "../../stores/rootOverlay";
import { useRootReviewStore } from "../../stores/rootReview";
import { useSettingsStore } from "../../stores/settings";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { useAgentModelsStore } from "../../stores/agents/agentModels";
import type { ProjectEntry, Settings } from "../../types";

const agent = (key: string, label = key): TabEntry => ({ key, label, cmd: "claude", cwd: "/p", kind: "agent" });
const project = (id: string): ProjectEntry =>
  ({ id, name: id.toUpperCase(), status: "active", position: 1, local_file: `/${id}/project.json` }) as ProjectEntry;

function seedStores() {
  localStorage.clear();
  useProjectsStore.setState({ projects: [project("p1"), project("p2")], activeId: "p1", rootDir: "/r" });
  useBoxesStore.setState({ boxes: [] });
  useTabsStore.setState({
    scope: "p1",
    tabsByScope: { p1: [agent("a", "alpha")], p2: [agent("b", "beta"), agent("c", "gamma")], root: [agent("r", "rooty")] },
    layoutByScope: {},
    focusedGroupByScope: {},
    detachedGroupsByScope: {},
  });
  useActivityStore.setState({ busyByTab: {}, attentionByTab: { "p2:b": "decision" }, lastDoneByTab: {}, lastWorkingByTab: {} });
  useAgentModelsStore.setState({ refresh: vi.fn(() => Promise.resolve()), refreshScreen: vi.fn(() => Promise.resolve()) });
  useRootReviewStore.setState({ proposals: [], imports: [], refresh: vi.fn(() => Promise.resolve()) });
  useOverlayAgentStore.setState({ scopeShownKeys: new Set() });
  useRootOverlayStore.setState({ open: false, view: "root", installTabs: {} });
  useCockpitStore.setState({ selected: null, stateFilter: "all", query: "", rosterMode: "flat", boxFilter: null, scopeFilter: null });
}

beforeEach(() => {
  cleanup();
  seedStores();
});
afterEach(() => cleanup());

describe("frameBand", () => {
  it("cuts at 820 and 1180 px, and reads an unmeasured frame as wide", () => {
    expect([0, 819, 820, 1179, 1180, 1680].map(frameBand)).toEqual(["wide", "narrow", "mid", "mid", "wide", "wide"]);
  });
});

describe("Now by band", () => {
  const renderNow = async (band: FrameBand) => {
    render(
      <FrameBandContext.Provider value={band}>
        <CockpitNow />
      </FrameBandContext.Provider>,
    );
    await act(async () => {});
  };
  const rosterRows = () => document.querySelectorAll(".cockpit-roster-row");
  const click = (el: Element) => act(async () => void fireEvent.click(el));

  it("wide: the full rail, the roster and the detail; no icon rail, no chip", async () => {
    await renderNow("wide");
    expect(document.querySelector(".cockpit-now-rail .cockpit-rail")).toBeTruthy();
    expect(document.querySelector(".cockpit-rail-icons")).toBeNull();
    expect(document.querySelector(".cockpit-needs-chip")).toBeNull();
    expect(rosterRows()).toHaveLength(4);
    expect(document.querySelector(".cockpit-detail")).toBeTruthy();
  });

  it("mid: the rail is the icon rail, roster and detail stay side by side", async () => {
    await renderNow("mid");
    expect(document.querySelector(".cockpit-now-rail")).toBeNull();
    expect(document.querySelector(".cockpit-now-icons .cockpit-rail-icons")).toBeTruthy();
    expect(document.querySelector(".cockpit-needs-chip")).toBeNull();
    expect(rosterRows()).toHaveLength(4);
    expect(document.querySelector(".cockpit-now-detail .cockpit-detail")).toBeTruthy();
    // The detail floors at a readable width and gives way to the roster before that.
    const style = (document.querySelector(".cockpit-now-detail") as HTMLElement).style;
    expect(style.minWidth).toBe("360px");
    expect(style.maxWidth).toBe("55%");
  });

  it("mid: an icon opens the full rail in a popover, and a picked row selects and closes it", async () => {
    await renderNow("mid");
    expect(document.querySelector(".cockpit-needs-popover")).toBeNull();
    await click(document.querySelector('.cockpit-rail-icon[data-group="asking"]')!);
    const pop = document.querySelector(".cockpit-needs-popover")!;
    expect(pop.querySelector(".cockpit-rail")).toBeTruthy();
    expect(pop.querySelector('[data-group="asking"]')).toBeTruthy();
    await click(Array.from(pop.querySelectorAll(".cockpit-rail-pick")).find((el) => el.textContent?.includes("beta"))!);
    expect(useCockpitStore.getState().selected).toBe("p2:b");
    expect(document.querySelector(".cockpit-needs-popover")).toBeNull();
    // Side by side: still both columns.
    expect(rosterRows()).toHaveLength(4);
  });

  it("narrow: the roster alone, a Needs you N chip, no detail and no terminal attached", async () => {
    await renderNow("narrow");
    expect(screen.getByRole("button", { name: "Needs you 1" })).toBeTruthy();
    expect(document.querySelector(".cockpit-now-rail")).toBeNull();
    expect(document.querySelector(".cockpit-rail-icons")).toBeNull();
    expect(rosterRows()).toHaveLength(4);
    expect(document.querySelector(".cockpit-now-detail")).toBeNull();
    expect(screen.queryByTestId("attached-b")).toBeNull();
  });

  it("narrow: a row opens the detail, the back button returns to the roster", async () => {
    await renderNow("narrow");
    await click(document.querySelector('[data-pty="p2:c"]')!);
    expect(document.querySelector(".cockpit-roster")).toBeNull();
    expect(screen.getByTestId("attached-c")).toBeTruthy();
    await click(screen.getByRole("button", { name: "Agents" }));
    expect(rosterRows()).toHaveLength(4);
    expect(document.querySelector(".cockpit-now-detail")).toBeNull();
    expect(screen.queryByTestId("attached-c")).toBeNull();
  });

  it("narrow: Space on the selected row opens the detail, Escape on the back bar returns and is handled", async () => {
    await renderNow("narrow");
    useCockpitStore.getState().select("p2:c");
    fireEvent.keyDown(screen.getByRole("listbox"), { key: " " });
    await act(async () => {});
    expect(screen.getByTestId("attached-c")).toBeTruthy();
    const back = screen.getByRole("button", { name: "Agents" });
    // fireEvent returns false when the event was default-prevented (the window
    // closes on an Escape nobody handled).
    expect(await act(async () => fireEvent.keyDown(back, { key: "Escape" }))).toBe(false);
    expect(rosterRows()).toHaveLength(4);
  });

  it("narrow: the chip opens the rail as a popover; a picked row opens the detail on it", async () => {
    await renderNow("narrow");
    const chip = screen.getByRole("button", { name: "Needs you 1" });
    await click(chip);
    expect(chip.getAttribute("aria-expanded")).toBe("true");
    const pop = document.querySelector(".cockpit-needs-popover")!;
    expect(pop.querySelector(".cockpit-rail")).toBeTruthy();
    await click(Array.from(pop.querySelectorAll(".cockpit-rail-pick")).find((el) => el.textContent?.includes("beta"))!);
    expect(document.querySelector(".cockpit-needs-popover")).toBeNull();
    expect(screen.getByTestId("attached-b")).toBeTruthy();
    expect(document.querySelector(".cockpit-roster")).toBeNull();
  });

  it("a popover left open does not outlive the wide band", async () => {
    const view = (band: FrameBand) => (
      <FrameBandContext.Provider value={band}>
        <CockpitNow />
      </FrameBandContext.Provider>
    );
    const { rerender } = render(view("narrow"));
    await act(async () => {});
    await click(screen.getByRole("button", { name: "Needs you 1" }));
    expect(document.querySelector(".cockpit-needs-popover")).toBeTruthy();
    rerender(view("wide"));
    await act(async () => {});
    expect(document.querySelector(".cockpit-needs-popover")).toBeNull();
  });
});

describe("the window measures its frame", () => {
  let width = 1400;
  const observers: Array<() => void> = [];

  beforeEach(() => {
    width = 1400;
    observers.length = 0;
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => width });
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(cb: () => void) {
          observers.push(cb);
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    useSettingsStore.setState({ settings: { cockpit: true, experimental_explicit: true } as Settings });
  });
  afterEach(() => {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
    vi.unstubAllGlobals();
  });

  const frame = () => document.querySelector(".root-overlay") as HTMLElement;
  async function openAt(view: "now" | "root", w: number) {
    width = w;
    render(<RootOverlayHost />);
    await act(async () => useRootOverlayStore.getState().openView(view));
    await act(async () => {});
  }
  const resizeTo = async (w: number) => {
    width = w;
    await act(async () => observers.forEach((cb) => cb()));
  };

  it("writes the band on the frame at both edges, and follows a resize", async () => {
    await openAt("now", 1180);
    expect(frame().dataset.band).toBe("wide");
    await resizeTo(1179);
    expect(frame().dataset.band).toBe("mid");
    await resizeTo(820);
    expect(frame().dataset.band).toBe("mid");
    await resizeTo(819);
    expect(frame().dataset.band).toBe("narrow");
    await resizeTo(1180);
    expect(frame().dataset.band).toBe("wide");
  });

  it("gives Now to the view by band: icon rail at 1179, chip at 819", async () => {
    await openAt("now", 1179);
    expect(document.querySelector(".cockpit-rail-icons")).toBeTruthy();
    await resizeTo(819);
    expect(document.querySelector(".cockpit-needs-chip")).toBeTruthy();
    expect(document.querySelector(".cockpit-rail-icons")).toBeNull();
    await resizeTo(1180);
    expect(document.querySelector(".cockpit-now-rail .cockpit-rail")).toBeTruthy();
  });

  it("Root keeps its icon rail down to 820 px and has none under it", async () => {
    await openAt("root", 820);
    expect(document.querySelector(".cockpit-rail-icons")).toBeTruthy();
    await resizeTo(819);
    expect(document.querySelector(".cockpit-rail-icons")).toBeNull();
    expect(document.querySelector(".cockpit-root-rail-full")).toBeNull();
    await resizeTo(1500);
    expect(document.querySelector(".cockpit-rail-icons")).toBeTruthy();
  });

  it("without the experiment the console has no band at any width", async () => {
    useSettingsStore.setState({ settings: { cockpit: false, experimental_explicit: true } as Settings });
    await openAt("root", 700);
    expect(frame().dataset.band).toBeUndefined();
    expect(document.querySelector(".cockpit-rail-icons")).toBeNull();
  });

  it("folds the box filter into an icon wrapper in the title bar (the select stays)", async () => {
    useBoxesStore.setState({ boxes: [{ id: "bx", name: "Box", member_ids: ["p1"] } as never] });
    await openAt("now", 700);
    const wrap = document.querySelector(".cockpit-box-filter-wrap")!;
    expect(wrap.querySelector(".cockpit-box-filter-fold svg")).toBeTruthy();
    expect(wrap.querySelector("select.cockpit-box-filter")).toBeTruthy();
  });
});
