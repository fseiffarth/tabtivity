/**
 * The Agents and Models views of the console window (`models/AgentsView`,
 * `models/ModelsView`): what the Models & agents overlay was, split in two and
 * moved into the one window. Settings' panels and the skills library are
 * stubbed — what is locked in here is the views' own contract:
 *
 *  - each view opens straight on its content (no overview grid), its sections
 *    are tabs in the window's sub-bar, and a visited section stays mounted
 *    (install logs are component state) and is `hidden` when not shown;
 *  - `openOverlay(section)` deep-links to the view that holds the section, a
 *    plain open lands on Models, and the views' own doors (Manage models, the
 *    autostart notice's "Ollama…") switch to the Ollama section — never out to
 *    Settings;
 *  - a pull started before the view opened already shows in Local models (the
 *    shared `stores/agents/ollamaActivity`), which reads the models but not the
 *    agents it doesn't show, and lays out as the dropdown does: the Machine
 *    band, then the Running models;
 *  - the Agents section re-reads which CLIs the root MCP server is wired to
 *    when the agent registry changes, and Usage mounts the CLIs overview.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act, waitFor, within } from "@testing-library/react";

const h = vi.hoisted(() => ({
  skillsVisible: [] as boolean[],
  agentsPanelMounts: 0,
  machine: { supported: false } as Record<string, unknown>,
  agents: [] as unknown[],
  skills: [] as unknown[],
  extraModels: [] as unknown[],
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../components/settings/AgentsPanel", async () => {
  const { useEffect } = await import("react");
  return {
    AgentsPanel: ({ installedExtras }: { installedExtras?: (a: unknown) => unknown }) => {
      useEffect(() => {
        h.agentsPanelMounts += 1;
      }, []);
      return (
        <div data-testid="agents-panel">
          {installedExtras?.({ id: "claude", label: "Claude Code", bin: "claude", installed: true }) as never}
        </div>
      );
    },
  };
});
vi.mock("../../components/settings/OllamaPanel", () => ({
  OllamaPanel: () => <div data-testid="ollama-panel" />,
}));
vi.mock("../../components/skills/SkillsLibraryView", () => ({
  SkillsLibraryView: ({ visible }: { visible?: boolean }) => {
    h.skillsVisible.push(visible !== false);
    return <div data-testid="skills-view" />;
  },
}));

vi.mock("../../components/agents/CliOverviewView", () => ({
  CliOverviewBody: ({ active }: { active: boolean }) => <div data-testid="cli-overview" data-active={String(active)} />,
}));
vi.mock("../../components/tabs/TabPane", () => ({ TabPane: () => null }));

import { invoke } from "@tauri-apps/api/core";
import { RootOverlayHost } from "../../components/layout/RootOverlay";
import { useModelsOverlayStore } from "../../stores/modelsOverlay";
import {
  __resetOllamaActivityForTests,
  useOllamaActivityStore,
} from "../../stores/agents/ollamaActivity";
import { notifyAgentRegistryChanged } from "../../lib/agents/agentRegistry";
import { resetOllamaStatusPoller } from "../../lib/ollamaStatus";
import { useSettingsStore } from "../../stores/settings";
import { useRootOverlayStore } from "../../stores/rootOverlay";
import { resetOllamaAutoload, useOllamaAutoloadStore } from "../../stores/agents/ollamaAutoload";

const invokeMock = vi.mocked(invoke);
const calls = (cmd: string) => invokeMock.mock.calls.filter(([c]) => c === cmd);

beforeEach(() => {
  // The frame persists; keep each test from reading the last one's.
  localStorage.clear();
  h.skillsVisible.length = 0;
  h.agentsPanelMounts = 0;
  h.machine = { supported: false };
  h.agents = [];
  h.skills = [];
  h.extraModels = [];
  useRootOverlayStore.setState({ open: false, view: "root" });
  invokeMock.mockReset();
  invokeMock.mockImplementation(((cmd: string) => {
    if (cmd === "root_mcp_status") return Promise.resolve({ wired_clis: ["claude"] });
    if (cmd === "list_ollama_models_detailed")
      return Promise.resolve([
        {
          name: "qwen:7b",
          parameter_size: "7B",
          quantization: "Q4",
          running: true,
          size_vram: 0,
          size: 1,
          capabilities: ["completion", "tools"],
        },
        ...h.extraModels,
      ]);
    if (cmd === "list_agents") return Promise.resolve(h.agents);
    if (cmd === "skills_list_installed") return Promise.resolve(h.skills);
    if (cmd === "ollama_status") return Promise.resolve("loaded");
    if (cmd === "machine_load_snapshot") return Promise.resolve(h.machine);
    if (cmd === "gpu_memory_snapshot") return Promise.resolve([]);
    return Promise.resolve(null);
  }) as never);
  __resetOllamaActivityForTests();
  resetOllamaStatusPoller();
  resetOllamaAutoload();
  useModelsOverlayStore.setState({ agentsSection: "agents", modelsSection: "models" });
  useSettingsStore.setState({ settings: { ollama_model: "qwen:7b" } } as never);
});

afterEach(() => {
  cleanup();
  resetOllamaStatusPoller();
});


const open = (section?: "agents" | "usage" | "skills" | "models" | "ollama") =>
  act(() => useModelsOverlayStore.getState().openOverlay(section));

const pane = (id: string) => document.querySelector<HTMLElement>(`.models-overlay-pane-${id}`);
const sectionTab = (name: string) => screen.getByRole("tab", { name });
const view = () => useRootOverlayStore.getState();

describe("the Agents and Models views", () => {
  it("a plain open lands on Models, straight on Local models with no overview grid", async () => {
    render(<RootOverlayHost />);
    open();
    expect(view()).toMatchObject({ open: true, view: "models" });
    expect(await screen.findByRole("tab", { name: "Local models" })).toBeTruthy();
    expect(sectionTab("Local models").getAttribute("aria-selected")).toBe("true");
    expect(sectionTab("Ollama").getAttribute("aria-selected")).toBe("false");
    expect(document.querySelector(".models-home-grid")).toBeNull();
    expect(pane("models")?.hidden).toBe(false);
    expect(pane("ollama")).toBeNull();
  });

  it("deep-links to the view that holds the section", async () => {
    render(<RootOverlayHost />);
    open("ollama");
    expect(view()).toMatchObject({ open: true, view: "models" });
    expect(await screen.findByTestId("ollama-panel")).toBeTruthy();
    expect(pane("models")).toBeNull();
    act(() => useRootOverlayStore.getState().close());
    open("skills");
    expect(view()).toMatchObject({ open: true, view: "agents" });
    expect(await screen.findByTestId("skills-view")).toBeTruthy();
    expect(sectionTab("Skills").getAttribute("aria-selected")).toBe("true");
    // The Models view remembers its section for the next plain open.
    act(() => useRootOverlayStore.getState().close());
    open();
    expect(await screen.findByTestId("ollama-panel")).toBeTruthy();
  });

  it("keeps a visited section mounted, hidden, and mounts one only when first shown", async () => {
    render(<RootOverlayHost />);
    open("agents");
    expect(await screen.findByTestId("agents-panel")).toBeTruthy();
    expect(pane("skills")).toBeNull();
    expect(pane("usage")).toBeNull();
    fireEvent.mouseDown(sectionTab("Usage"), { button: 0 });
    expect(await screen.findByTestId("cli-overview")).toBeTruthy();
    expect(screen.getByTestId("cli-overview").getAttribute("data-active")).toBe("true");
    expect(pane("agents")?.hidden).toBe(true);
    fireEvent.mouseDown(sectionTab("Skills"), { button: 0 });
    expect(pane("usage")?.hidden).toBe(true);
    expect(screen.getByTestId("cli-overview").getAttribute("data-active")).toBe("false");
    fireEvent.mouseDown(sectionTab("Agents & CLIs"), { button: 0 });
    expect(pane("agents")?.hidden).toBe(false);
    expect(h.agentsPanelMounts).toBe(1);
  });

  it("walks the sections with the arrow keys", async () => {
    render(<RootOverlayHost />);
    open("agents");
    await screen.findByTestId("agents-panel");
    const first = sectionTab("Agents & CLIs");
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(document.activeElement).toBe(sectionTab("Usage"));
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    expect(useModelsOverlayStore.getState().agentsSection).toBe("usage");
  });

  it("switches to the Ollama section from its own doors, never out to Settings", async () => {
    useOllamaActivityStore.setState({ installed: true });
    useOllamaAutoloadStore.setState({
      phase: "skipped",
      pending: ["llama:8b"],
      models: ["llama:8b"],
      dismissed: false,
    });
    const spy = vi.spyOn(window, "dispatchEvent");
    try {
      render(<RootOverlayHost />);
      open("models");
      fireEvent.click(await within(pane("models")!).findByText("Manage models"));
      expect(useModelsOverlayStore.getState().modelsSection).toBe("ollama");
      expect(pane("ollama")?.hidden).toBe(false);
      expect(screen.getByTestId("ollama-panel")).toBeTruthy();
      // Back to Local models by its tab: the autostart notice's chip is the same door.
      fireEvent.mouseDown(sectionTab("Local models"), { button: 0 });
      expect(pane("models")?.hidden).toBe(false);
      fireEvent.click(await within(pane("models")!).findByText("Ollama…"));
      expect(useModelsOverlayStore.getState().modelsSection).toBe("ollama");
      expect(pane("ollama")?.hidden).toBe(false);
      const settingsEvents = spy.mock.calls.filter(([e]) => (e as Event).type === "app:open-settings");
      expect(settingsEvents).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("passes the skills library its visibility", async () => {
    render(<RootOverlayHost />);
    open("skills");
    await screen.findByTestId("skills-view");
    expect(h.skillsVisible[h.skillsVisible.length - 1]).toBe(true);
    fireEvent.mouseDown(sectionTab("Agents & CLIs"), { button: 0 });
    expect(h.skillsVisible[h.skillsVisible.length - 1]).toBe(false);
  });

  it("closes the window on Escape unless something inside already took it", async () => {
    render(<RootOverlayHost />);
    open("agents");
    await screen.findByTestId("agents-panel");
    const ev = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    ev.preventDefault();
    act(() => {
      window.dispatchEvent(ev);
    });
    expect(view().open).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(view().open).toBe(false);
  });

  it("shows a pull started before it opened in Local models", async () => {
    useOllamaActivityStore.setState({ installed: true, downloads: { "mistral:7b": { pct: 40 } } });
    render(<RootOverlayHost />);
    open("models");
    expect(await screen.findByText("40%")).toBeTruthy();
    expect(screen.getByText("mistral:7b")).toBeTruthy();
    // Becoming visible reads the list, as a hover does.
    expect(await screen.findByText("qwen:7b")).toBeTruthy();
    expect(calls("list_ollama_models_detailed").length).toBeGreaterThan(0);
    // …but not the agents: this section doesn't show them.
    expect(calls("list_agents")).toHaveLength(0);
  });

  it("lays Local models out as a status bar, the Machine meters, then a card per model", async () => {
    h.machine = {
      supported: true,
      cpu_percent: 10,
      num_cores: 8,
      load_avg: [0.5, 0.5, 0.5],
      mem_total_bytes: 16e9,
      mem_used_bytes: 4e9,
      swap_total_bytes: 0,
      swap_used_bytes: 0,
      cpu_temp_c: null,
    };
    useOllamaActivityStore.setState({ installed: true });
    render(<RootOverlayHost />);
    open("models");
    await screen.findByText("qwen:7b");
    const page = pane("models")!.querySelector(".lm-page")!;
    expect(within(page as HTMLElement).getByText("Ollama running")).toBeTruthy();
    const headings = [...page.querySelectorAll(".lm-heading-title")].map((el) => el.textContent);
    // Machine first (will it fit?), then what is in memory ("on disk" only
    // appears once a model is not resident).
    expect(headings).toEqual(["Machine", "Running models"]);
    // One card per model; a resident one carries its tasks and an Unload verb.
    const running = page.querySelector(".lm-card.is-running")!;
    expect(within(running as HTMLElement).getByRole("button", { name: "Tabs" })).toBeTruthy();
    expect(within(running as HTMLElement).getByRole("button", { name: "Unload" })).toBeTruthy();
    // Machine readings are meters, and none is drawn for a missing sensor.
    expect(page.querySelectorAll("[role='meter']").length).toBeGreaterThan(0);
    expect(page.querySelector(".local-model-stat-note")).toBeNull();
  });

  it("offers a model on disk one primary Load button and an immediate load-on-start switch", async () => {
    h.extraModels = [
      { name: "llama:8b", parameter_size: "8B", quantization: "Q4", running: false, size_vram: 0, size: 4e9 },
    ];
    useOllamaActivityStore.setState({ installed: true });
    render(<RootOverlayHost />);
    open("models");
    const name = await screen.findByText("llama:8b");
    const card = name.closest(".lm-card") as HTMLElement;
    expect(card.classList.contains("is-running")).toBe(false);
    expect(within(card).getByRole("button", { name: "Load" }).className).toContain("btn-primary");
    expect(within(card).getByRole("checkbox")).toBeTruthy();
    expect(within(card).getByText("Load on start")).toBeTruthy();
  });

  it("re-reads the wired CLIs when the agent registry changes", async () => {
    render(<RootOverlayHost />);
    open("agents");
    // The installed card carries the dropdown's chips, MCP included once wired.
    expect(await screen.findByRole("button", { name: "MCP" })).toBeTruthy();
    // (The window's own ⚿ badge reads the same status once per mount.)
    const before = calls("root_mcp_status").length;
    act(() => notifyAgentRegistryChanged());
    await waitFor(() => expect(calls("root_mcp_status")).toHaveLength(before + 1));
  });
});
