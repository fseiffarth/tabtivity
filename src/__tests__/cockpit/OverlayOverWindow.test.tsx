/**
 * F9 (`docs/cockpit_followup_handoff.md`): the Machines and Models overlays
 * opened FROM the console window (the Usage view's "Open Machines", the Root
 * view's "Add agent...") are the front layer, and one Escape closes only the
 * front one. Opened first and the window raised over them (a terminal sign-in
 * or install), the window stays in front as it always was. The z-order is a
 * class (`under-overlay`) the CSS lowers one layer; jsdom has no layout, so the
 * class and the Escape routing are what is asserted.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string) => {
    if (cmd === "root_mcp_status") return Promise.resolve({ running: true, tools: [], wired_clis: [] });
    if (cmd === "list_agents" || cmd === "skills_list_installed") return Promise.resolve([]);
    return Promise.resolve(null);
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emit: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("../../components/tabs/TabPane", () => ({ TabPane: () => null }));
vi.mock("../../components/settings/AgentsPanel", () => ({ AgentsPanel: () => <div /> }));
vi.mock("../../components/settings/OllamaPanel", () => ({ OllamaPanel: () => <div /> }));
vi.mock("../../components/skills/SkillsLibraryView", () => ({ SkillsLibraryView: () => <div /> }));
// The Usage view stands in as a door to the Machines overlay.
vi.mock("../../components/cockpit/CockpitViews", () => ({
  CockpitViewBody: () => (
    <button type="button" onClick={() => useMachinesOverlayStore.getState().openOverlay()}>
      door
    </button>
  ),
}));

import { MachinesOverlayHost } from "../../components/header/MachinesIndicator";
import { RootOverlayHost } from "../../components/layout/RootOverlay";
import { ModelsOverlayHost } from "../../components/models/ModelsOverlay";
import { useConsoleCover } from "../../stores/consoleCover";
import { useMachinesOverlayStore } from "../../stores/machinesOverlay";
import { useModelsOverlayStore } from "../../stores/modelsOverlay";
import { useProjectsStore } from "../../stores/projects";
import { useRootOverlayStore } from "../../stores/rootOverlay";
import { useGlobalMachinesStore } from "../../stores/remote/globalMachines";
import { useSettingsStore } from "../../stores/settings";
import { useTabsStore } from "../../stores/tabs";

const consoleBackdrop = () => document.querySelector(".root-console-backdrop");
const machines = () => useMachinesOverlayStore.getState().open;
const models = () => useModelsOverlayStore.getState().open;
const windowUp = () => useRootOverlayStore.getState().open;
/** An Escape from where the focus is; both overlays focus a control of their own. */
const escape = () => act(() => void fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }));

beforeEach(() => {
  cleanup();
  localStorage.clear();
  useSettingsStore.setState({ settings: { machines_enabled: true } as never, loaded: true });
  useGlobalMachinesStore.setState({
    machines: [{ id: "m1", host: "gpu1.example.org", label: "GPU box" }],
    status: {},
    reachable: {},
    errors: {},
    loaded: true,
    load: vi.fn(async () => {}),
    probeAll: vi.fn(async () => {}),
  });
  useProjectsStore.setState({ projects: [], activeId: null, rootDir: "/r" });
  useTabsStore.setState({ scope: "p1", tabsByScope: { root: [] }, layoutByScope: {}, focusedGroupByScope: {}, detachedGroupsByScope: {} });
  useMachinesOverlayStore.setState({ open: false });
  useModelsOverlayStore.setState({ open: false, view: "home" });
  useRootOverlayStore.setState({ open: false, view: "root", installTabs: {} });
  useConsoleCover.setState({ covered: false });
});
afterEach(() => cleanup());

const mountAll = () =>
  render(
    <>
      <MachinesOverlayHost />
      <ModelsOverlayHost />
      <RootOverlayHost />
    </>,
  );

describe("the Machines overlay opened from the window", () => {
  it("is in front of it: the window steps below, and Escape closes the overlay, then the window", async () => {
    mountAll();
    await act(async () => useRootOverlayStore.getState().openView("usage"));
    expect(consoleBackdrop()?.classList.contains("under-overlay")).toBe(false);
    await act(async () => void fireEvent.click(await screen.findByRole("button", { name: "door" })));
    expect(machines()).toBe(true);
    expect(consoleBackdrop()?.classList.contains("under-overlay")).toBe(true);
    expect(document.querySelector(".machines-overlay-backdrop")?.classList.contains("under-overlay")).toBe(false);

    escape();
    expect(machines()).toBe(false);
    expect(windowUp()).toBe(true);
    expect(consoleBackdrop()?.classList.contains("under-overlay")).toBe(false);
    escape();
    expect(windowUp()).toBe(false);
  });

  it("an Escape aimed at <body> (focus dropped by a click on the bar) still closes only the overlay", async () => {
    mountAll();
    await act(async () => useRootOverlayStore.getState().openView("usage"));
    await act(async () => void fireEvent.click(await screen.findByRole("button", { name: "door" })));
    act(() => void fireEvent.keyDown(document.body, { key: "Escape" }));
    expect(machines()).toBe(false);
    expect(windowUp()).toBe(true);
  });

  it("opened with no window up, the window raised over it later stays in front, and Escape closes the window first", async () => {
    mountAll();
    await act(async () => useMachinesOverlayStore.getState().openOverlay());
    await act(async () => useRootOverlayStore.getState().openView("usage"));
    expect(consoleBackdrop()?.classList.contains("under-overlay")).toBe(false);
    act(() => void fireEvent.keyDown(document.body, { key: "Escape" }));
    expect(windowUp()).toBe(false);
    expect(machines()).toBe(true);
    escape();
    expect(machines()).toBe(false);
  });

  it("the window opened afresh over an overlay that covered it comes back in front", async () => {
    mountAll();
    await act(async () => useRootOverlayStore.getState().openView("usage"));
    await act(async () => void fireEvent.click(await screen.findByRole("button", { name: "door" })));
    expect(consoleBackdrop()?.classList.contains("under-overlay")).toBe(true);
    await act(async () => useRootOverlayStore.getState().close());
    await act(async () => useRootOverlayStore.getState().show());
    expect(consoleBackdrop()?.classList.contains("under-overlay")).toBe(false);
  });
});

describe("the Models overlay opened from the window", () => {
  it("is in front of it (the Root view's Add agent door), and Escape closes only it", async () => {
    mountAll();
    await act(async () => useRootOverlayStore.getState().show());
    await act(async () => useModelsOverlayStore.getState().openOverlay("agents"));
    expect(consoleBackdrop()?.classList.contains("under-overlay")).toBe(true);
    escape();
    expect(models()).toBe(false);
    expect(windowUp()).toBe(true);
    expect(consoleBackdrop()?.classList.contains("under-overlay")).toBe(false);
  });

  it("opened from the header (no window), it is just the front overlay as before", async () => {
    mountAll();
    await act(async () => useModelsOverlayStore.getState().openOverlay("agents"));
    expect(useConsoleCover.getState().covered).toBe(false);
    escape();
    expect(models()).toBe(false);
  });
});
