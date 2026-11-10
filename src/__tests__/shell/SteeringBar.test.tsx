/**
 * The steering bar's model (`lib/shortcuts/steeringBar`: which keys sit in the
 * bar and which are caps on the control they fire, the ladder) and the caps
 * drawn on a window that has those controls (`SteeringLegend` +
 * `lib/shortcuts/steeringCaps`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isFullscreen: vi.fn().mockResolvedValue(false),
    setFullscreen: vi.fn(),
  }),
}));

import { SteeringLegend } from "../../components/layout/SteeringLegend";
import { useKeyboardSteeringStore } from "../../stores/keyboardSteering";
import { useTabsStore } from "../../stores/tabs";
import { useSettingsStore } from "../../stores/settings";
import { STEERING_GROUPS, steeringKeysFor, type SteeringKeyDef, type SteeringLegendState } from "../../lib/shortcuts/shortcuts";
import { NEW_TAB_SLOTS_EVENT, type NewTabSlotsDetail } from "../../lib/shortcuts/newTabChord";
import { anchorOf, barModel, ladder, rowCaps, type CapAnchor } from "../../lib/shortcuts/steeringBar";
import { spreadRows } from "../../lib/shortcuts/steeringCaps";

const tokFor = (g: string) => STEERING_GROUPS.find((x) => x.id === g)!.tok;

const state: SteeringLegendState = {
  level: "tabs",
  sideRegion: false,
  multiPane: false,
  apps: { mail: true, calendar: true, todo: true },
  agent: { clear: true, plan: true, goal: true, prompt: true },
  terminal: true,
  statusCounts: { decision: 2, working: 0, done: 1 },
};
const rowsFor = (s: Partial<SteeringLegendState>) => steeringKeysFor({ ...state, ...s });
const model = (rows: SteeringKeyDef[], level: SteeringLegendState["level"], placed: CapAnchor[], agents: { key: string; label: string }[] = []) =>
  barModel(rows, level, new Set(placed), null, agents, tokFor);
const labels = (m: ReturnType<typeof model>) => m.items.map((i) => i.labelKey);

describe("steering bar model", () => {
  it("pins each key to the control it fires, and only keys of the level", () => {
    const act = (a: string) => rowsFor({}).find((r) => r.actions.includes(a as never))!;
    expect(anchorOf(act("newShell"))).toBe("add");
    expect(anchorOf(act("newTabMenu"))).toBe("add");
    expect(anchorOf(act("closeTab"))).toBe("tab");
    expect(anchorOf(act("files"))).toBe("files");
    expect(anchorOf(act("agentPrompt"))).toBe("prompt");
    expect(anchorOf(act("mail"))).toBe("mail");
    expect(anchorOf(act("sidePanel"))).toBe("sidePanel");
    expect(anchorOf(act("panels"))).toBe("panels");
    // Moving, jumping and leaving are the bar's own.
    expect(anchorOf(act("left"))).toBeNull();
    expect(anchorOf(act("nextDecision"))).toBeNull();
    expect(anchorOf(act("legend"))).toBeNull();
    expect(anchorOf(act("jumpProject"))).toBeNull();
    // The side panel's own key inside it is a mode row, not the rail's cap.
    const back = steeringKeysFor({ ...state, level: "region", sideRegion: true }).find((r) => r.labelKey === "steering.sidePanelBack.label")!;
    expect(anchorOf(back)).toBeNull();
  });

  it("lists the side panel's row and view-switch keys in the bar; the tabs wear their own caps", () => {
    const side = steeringKeysFor({ ...state, level: "region", sideRegion: true });
    const row = side.find((r) => r.labelKey === "steering.sideRow.label")!;
    const jump = side.find((r) => r.labelKey === "steering.sideViewJump.label")!;
    // Neither is pinned to a floating cap any more (there is no `sideViews` anchor).
    expect(anchorOf(row)).toBeNull();
    expect(anchorOf(jump)).toBeNull();
    const m = barModel(side, "region", new Set<CapAnchor>(["cursor"]), null, [], tokFor);
    const jumpItem = m.items.find((i) => i.labelKey === "steering.sideViewJump.label")!;
    expect(jumpItem.caps).toEqual(["1–9"]);
    expect(m.items.find((i) => i.labelKey === "steering.sideRow.label")!.caps).toEqual(["S", "F"]);
    // The number keys follow the user's slot bindings.
    const rebound = barModel(side, "region", new Set<CapAnchor>(), { slot1: ["a"], slot2: ["b"] }, [], tokFor);
    expect(rebound.items.find((i) => i.labelKey === "steering.sideViewJump.label")!.caps[0]).toMatch(/^A B/);
    // And the old steps are not offered outside the side panel.
    expect(rowsFor({ level: "region" }).some((r) => r.labelKey === "steering.sideViewJump.label")).toBe(false);
  });

  it("keeps every key in the bar until its control is on screen", () => {
    const none = model(rowsFor({}), "tabs", []);
    expect(labels(none)).toEqual(expect.arrayContaining(["steering.newShell.label", "steering.closeTab.label", "steering.agentPrompt.label"]));
    expect(none.caps.size).toBe(0);

    const placed = model(rowsFor({}), "tabs", ["add", "tab", "prompt", "files", "mail"]);
    const bar = labels(placed);
    for (const gone of [
      "steering.newShell.label",
      "steering.newMonitor.label",
      "steering.newTabMenu.label",
      "steering.closeTab.label",
      "steering.files.label",
      "steering.agentPrompt.label",
      "steering.agentClear.label",
      "steering.mail.label",
    ]) {
      expect(bar).not.toContain(gone);
    }
    // Not placed: the settings gear's key stays in the bar.
    expect(bar).toContain("steering.settings.label");
    expect([...placed.caps.keys()].sort()).toEqual(["add", "files", "mail", "prompt", "tab"]);
  });

  it("orders a control's caps by press order: N O 1–3 + above the +, Space L G K on the prompt strip", () => {
    const m = model(rowsFor({}), "tabs", ["add", "prompt"], [
      { key: "1", label: "Claude" },
      { key: "2", label: "Codex" },
      { key: "3", label: "Gemini" },
    ]);
    const text = (a: CapAnchor) => m.caps.get(a)!.flatMap((r) => r.caps.map((c) => c.key));
    expect(text("add")).toEqual(["N", "O", "1–3", "+"]);
    expect(text("prompt")).toEqual(["Space"]);
    // Each cap wears its group's token colour.
    expect(m.caps.get("add")![0].caps[0].tok).toBe("tok-string");
    expect(m.caps.get("prompt")![0].caps[0].tok).toBe("tok-keyword");
  });

  it("shows the user's keys on caps and in the bar", () => {
    const overrides = { newShell: ["l"], left: ["a"], right: ["z"] };
    const rows = rowsFor({});
    const m = barModel(rows, "tabs", new Set<CapAnchor>(["add"]), overrides, [], tokFor);
    expect(m.caps.get("add")![0].caps[0].key).toBe("L");
    const tabs = m.items.find((i) => i.labelKey === "steering.tabs.label")!;
    expect(tabs.caps).toEqual(["A", "Z"]);
    // A key bound to nothing has no cap at all.
    const none = barModel(rows, "tabs", new Set<CapAnchor>(["add"]), { newMonitor: [] }, [], tokFor);
    expect(none.caps.get("add")![0].caps.map((c) => c.key)).not.toContain("O");
    expect(rowCaps(rows.find((r) => r.actions.includes("newMonitor"))!, { newMonitor: [] })).toEqual([]);
  });

  it("collapses up and down into the ladder's one entry on the subwindow and tab levels only", () => {
    const tabs = model(rowsFor({}), "tabs", []);
    expect(tabs.items[0]).toMatchObject({ id: "upDown", caps: ["E", "D"], labelKey: "steering.bar.upDown" });
    expect(labels(tabs)).not.toContain("steering.up.label");
    expect(labels(tabs)).not.toContain("steering.intoTerminal.label");

    const projects = model(rowsFor({ level: "projects" }), "projects", []);
    expect(projects.items.some((i) => i.id === "upDown")).toBe(false);
    expect(labels(projects)).toEqual(expect.arrayContaining(["steering.into.label", "steering.header.label"]));
  });

  it("reads move keys first, status jumps with their counts next, the leave keys last", () => {
    const m = model(rowsFor({}), "tabs", ["add", "tab"]);
    const order = m.items.map((i) => i.group);
    expect(order.indexOf("move")).toBeLessThan(order.indexOf("status"));
    expect(order.indexOf("status")).toBeLessThan(order.indexOf("act"));
    const status = m.items.filter((i) => i.status);
    expect(status.map((i) => i.status)).toEqual(["decision", "done"]);
    const tail = m.items.slice(-4);
    expect(tail.map((i) => i.labelKey)).toEqual([
      "steering.help.label",
      "steering.legend.label",
      "steering.work.label",
      "steering.exit.label",
    ]);
    expect(tail.map((i) => !!i.leave)).toEqual([false, false, true, true]);
    expect(tail.map((i) => i.caps[0])).toEqual(["?", "H", "Enter", "Esc"]);
  });

  it("names the surface on the ladder inside a region, and the box when the keyboard is lent", () => {
    const lit = (l: ReturnType<typeof ladder>) => l.filter((r) => r.lit).map((r) => r.labelKey);
    expect(ladder({ level: "tabs", region: null, regionReturn: "tabs" }).map((r) => r.id)).toEqual(["projects", "panes", "tabs", "scroll"]);
    expect(lit(ladder({ level: "projects", region: null, regionReturn: "tabs" }))).toEqual(["steering.level.projects"]);
    expect(lit(ladder({ level: "scroll", region: null, regionReturn: "tabs" }))).toEqual(["steering.level.scroll"]);
    expect(lit(ladder({ level: "scroll", region: null, regionReturn: "tabs", document: true }))).toEqual(["steering.level.scrollDocument"]);

    const region = ladder({ level: "region", region: "side", regionReturn: "tabs" });
    expect(region.map((r) => r.labelKey)).toEqual(["steering.level.tabs", "steering.region.side"]);
    expect(lit(region)).toEqual(["steering.region.side"]);

    const lent = ladder({ level: "tabs", region: null, regionReturn: "tabs", lent: "steering.agentPrompt.label" });
    expect(lent.map((r) => r.labelKey)).toEqual(["steering.level.tabs", "steering.agentPrompt.label"]);
    expect(lent[1]).toMatchObject({ lit: true, lent: true });
  });
});

describe("steering key caps on a window", () => {
  const rect = (left: number, top: number, width: number, height: number) =>
    ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
  const place = (el: Element, r: DOMRect) => {
    (el as HTMLElement).getBoundingClientRect = () => r;
    return el as HTMLElement;
  };
  const answer = (e: Event) => {
    (e as CustomEvent<NewTabSlotsDetail>).detail.labels = ["Claude", "Codex", "Gemini"];
  };

  /** A focused subwindow with its tab bar's active tab and + button. */
  function subwindow() {
    document.body.insertAdjacentHTML(
      "beforeend",
      `<div class="subwindow focused"><div class="tab active"></div><button class="tab-new-btn">+</button></div>`,
    );
    place(document.querySelector(".tab.active")!, rect(100, 60, 120, 30));
    place(document.querySelector(".tab-new-btn")!, rect(300, 60, 30, 30));
  }

  beforeEach(() => {
    localStorage.clear();
    useTabsStore.setState({
      scope: "p",
      tabsByScope: {},
      layoutByScope: {},
      focusedGroupByScope: {},
      tabs: [],
      layout: null,
      focusedGroupId: null,
      activeKey: null,
      fullscreenGroupId: null,
    });
    useSettingsStore.setState({ settings: null });
    useKeyboardSteeringStore.setState({ legendHidden: false });
    useKeyboardSteeringStore.getState().exit();
    useTabsStore.getState().addTab({ label: "a", cmd: "bash", cwd: "/p", kind: "shell" });
    window.addEventListener(NEW_TAB_SLOTS_EVENT, answer);
  });

  afterEach(() => {
    window.removeEventListener(NEW_TAB_SLOTS_EVENT, answer);
    cleanup();
    document.body.innerHTML = "";
  });

  const caps = (anchor: string) =>
    [...document.querySelectorAll(`.steering-cap-row[data-anchor="${anchor}"] .steering-cap`)].map((c) => c.textContent);
  const barLabels = () => [...document.querySelectorAll(".steering-bar-label")].map((l) => l.textContent);

  it("hangs the new-tab keys above the + and the close key on the steered tab", () => {
    subwindow();
    render(<SteeringLegend />);
    act(() => useKeyboardSteeringStore.getState().enter());
    expect(caps("add")).toEqual(["N", "O", "1–3", "+"]);
    expect(caps("tab")).toEqual(["W"]);
    const add = document.querySelector('.steering-cap-row[data-anchor="add"]') as HTMLElement;
    // Hung 4 px into the control's top edge, from its left edge less 2 px.
    expect(add.style.left).toBe("298px");
    expect(add.style.top).toBe("49px");
    expect(add.classList.contains("start")).toBe(true);
    const tab = document.querySelector('.steering-cap-row[data-anchor="tab"]') as HTMLElement;
    expect(tab.classList.contains("end")).toBe(true);
    expect(tab.style.left).toBe("222px");
    // Pinned keys leave the bar; the rest stay.
    expect(barLabels()).not.toContain("New shell");
    expect(barLabels()).not.toContain("Close tab");
    expect(barLabels()).toContain("Switch tab");
  });

  it("gives the keys back to the bar when their control is not on screen", () => {
    subwindow();
    render(<SteeringLegend />);
    act(() => useKeyboardSteeringStore.getState().enter());
    expect(barLabels()).not.toContain("New shell");
    act(() => {
      document.querySelector(".tab-new-btn")!.remove();
      // The next steering key redraws the bar, which measures again.
      useKeyboardSteeringStore.getState().setLevel("panes");
    });
    expect(caps("add")).toEqual([]);
    expect(barLabels()).toContain("New shell");
    expect(barLabels()).toContain("All tab types");
  });

  it("follows a rebound key onto its cap", () => {
    subwindow();
    useSettingsStore.setState({ settings: { steering_keys: { newShell: ["l"] } } as never });
    render(<SteeringLegend />);
    act(() => useKeyboardSteeringStore.getState().enter());
    expect(caps("add")).toEqual(["L", "O", "1–3", "+"]);
  });

  it("draws no caps when folded, and the bar alone says where steering is", () => {
    subwindow();
    render(<SteeringLegend />);
    act(() => useKeyboardSteeringStore.getState().enter());
    act(() => useKeyboardSteeringStore.getState().toggleLegend());
    expect(document.querySelector(".steering-caps")).toBeNull();
    expect(document.querySelector(".steering-bar.folded")).not.toBeNull();
  });

  it("hangs the caps under a control at the window's top edge instead of over its text", () => {
    document.body.insertAdjacentHTML(
      "beforeend",
      `<div class="subwindow focused"><div class="tab active"></div><button class="tab-new-btn">+</button></div>`,
    );
    place(document.querySelector(".tab.active")!, rect(100, 0, 120, 30));
    place(document.querySelector(".tab-new-btn")!, rect(300, 0, 30, 30));
    render(<SteeringLegend />);
    act(() => useKeyboardSteeringStore.getState().enter());
    const add = document.querySelector('.steering-cap-row[data-anchor="add"]') as HTMLElement;
    // 4 px up into the control's bottom edge.
    expect(add.style.top).toBe("26px");
    expect((document.querySelector('.steering-cap-row[data-anchor="tab"]') as HTMLElement).style.top).toBe("26px");
  });

  it("pins nothing to a hidden control (the fullscreen header parked above the window)", () => {
    subwindow();
    document.body.insertAdjacentHTML(
      "beforeend",
      `<header class="app-header" style="visibility: hidden"><button data-hint-anchor="settings">s</button></header>`,
    );
    place(document.querySelector('[data-hint-anchor="settings"]')!, rect(500, 4, 32, 32));
    render(<SteeringLegend />);
    act(() => useKeyboardSteeringStore.getState().enter());
    expect(caps("settings")).toEqual([]);
    expect(barLabels()).toContain("Settings");
    act(() => {
      (document.querySelector(".app-header") as HTMLElement).style.visibility = "";
      useKeyboardSteeringStore.getState().setLevel("panes");
    });
    expect(caps("settings")).toEqual([","]);
  });

  it("measures the region cursor for Enter", () => {
    document.body.insertAdjacentHTML("beforeend", `<div class="side-panel open"><button class="steer-cursor">x</button></div>`);
    place(document.querySelector(".steer-cursor")!, rect(10, 200, 200, 24));
    render(<SteeringLegend />);
    act(() => {
      useKeyboardSteeringStore.getState().enter();
      useKeyboardSteeringStore.getState().enterRegion("side");
    });
    expect(caps("cursor")).toEqual(["Enter"]);
    // Enter is also the bar's own "Press".
    expect(barLabels()).toContain("Press");
    expect([...document.querySelectorAll(".steering-rung")].map((r) => r.textContent)).toEqual(["Tabs", "Side panel"]);
  });
});

describe("steering cap rows kept apart", () => {
  const box = (left: number, width: number, top = 0) => ({ left, right: left + width, top, bottom: top + 15 });

  it("moves a row after the one it would cover on the same line", () => {
    // W on the tab's end, N O + from the + button, V on the files toggle.
    expect(spreadRows([box(200, 20), box(210, 60), box(250, 20)], 1000)).toEqual([0, 12, 34]);
  });

  it("leaves rows on other lines and rows with room alone", () => {
    expect(spreadRows([box(0, 50), box(20, 50, 40), box(60, 20)], 1000)).toEqual([0, 0, 0]);
  });

  it("brings a row pushed past the right edge back in, with the rows before it", () => {
    expect(spreadRows([box(940, 40), box(950, 40)], 1000)).toEqual([-24, 8]);
  });
});
