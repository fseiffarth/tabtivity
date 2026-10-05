/**
 * The Models & agents overlay (`models/ModelsOverlay`): the room the header's
 * processor-chip button opens. Settings' panels and the skills library are
 * stubbed — what is locked in here is the overlay's own contract:
 *
 *  - closed, it renders nothing; open, it is a labelled dialog that lands on
 *    a grid of four section tiles (no tab strip), each with a live summary;
 *  - a tile opens its section, the bar's back button returns to the grid and
 *    hands focus back to the tile just left; a visited section stays mounted
 *    (install logs are component state) and is `hidden` when not shown;
 *  - arrow keys move between tiles;
 *  - Escape closes unless something inside took it, the root console is up on
 *    top of it, or the key was aimed outside its frame; only a press on the
 *    backdrop itself dismisses;
 *  - `openOverlay(section)` deep-links, and its own doors (Manage local
 *    models…, the autostart notice's "Ollama…") switch to the Ollama section —
 *    never out to Settings;
 *  - a pull started before it opened already shows in Local models (the
 *    shared `stores/agents/ollamaActivity`), which reads the models but not
 *    the agents it doesn't show, and lays out as the dropdown does: the Local
 *    Models band, then Machine;
 *  - the Agents section re-reads which CLIs the root MCP server is wired to
 *    when the agent registry changes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act, waitFor, within } from "@testing-library/react";

const h = vi.hoisted(() => ({
  skillsVisible: [] as boolean[],
  agentsPanelMounts: 0,
  machine: { supported: false } as Record<string, unknown>,
  agents: [] as unknown[],
  skills: [] as unknown[],
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../components/layout/SettingsSubPanels", async () => {
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
    OllamaPanel: () => <div data-testid="ollama-panel" />,
  };
});
vi.mock("../../components/skills/SkillsLibraryView", () => ({
  SkillsLibraryView: ({ visible }: { visible?: boolean }) => {
    h.skillsVisible.push(visible !== false);
    return <div data-testid="skills-view" />;
  },
}));

import { invoke } from "@tauri-apps/api/core";
import { ModelsOverlayHost } from "../../components/models/ModelsOverlay";
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
  useRootOverlayStore.setState({ open: false });
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
  useModelsOverlayStore.setState({ open: false, view: "home" });
  useSettingsStore.setState({ settings: { ollama_model: "qwen:7b" } } as never);
});

afterEach(() => {
  cleanup();
  resetOllamaStatusPoller();
});


const open = (section?: "agents" | "models" | "ollama" | "skills") =>
  act(() => useModelsOverlayStore.getState().openOverlay(section));

const pane = (id: string) => document.getElementById(`models-overlay-pane-${id}`);
const tile = (name: string) => screen.getByRole("button", { name });
const back = () => screen.getByRole("button", { name: "All sections" });

describe("ModelsOverlay", () => {
  it("renders nothing while closed and opens on a grid of section tiles", () => {
    const { container } = render(<ModelsOverlayHost />);
    expect(container.innerHTML).toBe("");
    open();
    expect(screen.getByRole("dialog", { name: "Models & agents" })).toBeTruthy();
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    const tiles = [...container.ownerDocument.querySelectorAll(".models-home-grid .models-tile")];
    expect(tiles.map((el) => el.getAttribute("aria-label"))).toEqual([
      "Agents & CLIs",
      "Local models",
      "Ollama",
      "Skills",
    ]);
    // The grid lands focus on its first tile; no section is mounted yet.
    expect(document.activeElement).toBe(tile("Agents & CLIs"));
    expect(pane("agents")).toBeNull();
    expect(screen.queryByRole("button", { name: "All sections" })).toBeNull();
  });

  it("shows each section's live state on its tile", async () => {
    h.agents = [
      { id: "claude", label: "Claude Code", bin: "claude", installed: true },
      { id: "codex", label: "Codex", bin: "codex", installed: true },
      { id: "gemini", label: "Gemini CLI", bin: "gemini", installed: false },
    ];
    h.skills = [{ name: "pdf-tools", description: "" }];
    useOllamaActivityStore.setState({ installed: true, downloads: { "mistral:7b": { pct: 10 } } });
    render(<ModelsOverlayHost />);
    open();
    const agents = tile("Agents & CLIs");
    expect(await within(agents).findByText("2 installed")).toBeTruthy();
    expect(within(agents).getByText("Claude Code")).toBeTruthy();
    expect(within(agents).queryByText("Gemini CLI")).toBeNull();
    const models = tile("Local models");
    expect(await within(models).findByText("1 on disk · 1 in memory")).toBeTruthy();
    expect(within(models).getByText("qwen:7b")).toBeTruthy();
    expect(within(models).getByText("1 downloading")).toBeTruthy();
    expect(within(tile("Ollama")).getByText("Running")).toBeTruthy();
    expect(await within(tile("Skills")).findByText("1 installed")).toBeTruthy();
    expect(within(tile("Skills")).getByText("pdf-tools")).toBeTruthy();
  });

  it("says what is missing when nothing is installed yet", async () => {
    render(<ModelsOverlayHost />);
    open();
    expect(await within(tile("Agents & CLIs")).findByText("No agent CLI installed yet")).toBeTruthy();
    expect(within(tile("Local models")).getByText("Install Ollama first")).toBeTruthy();
    expect(within(tile("Ollama")).getByText("Not installed")).toBeTruthy();
    expect(await within(tile("Skills")).findByText("No personal skills yet")).toBeTruthy();
  });

  it("opens a section from its tile and keeps a visited one mounted, hidden", () => {
    render(<ModelsOverlayHost />);
    open();
    fireEvent.click(tile("Agents & CLIs"));
    expect(useModelsOverlayStore.getState().view).toBe("agents");
    expect(pane("agents")?.hidden).toBe(false);
    expect(document.activeElement).toBe(back());
    // Back to the grid: the section is kept, and focus returns to its tile.
    fireEvent.click(back());
    expect(useModelsOverlayStore.getState().view).toBe("home");
    expect(pane("agents")?.hidden).toBe(true);
    expect(document.activeElement).toBe(tile("Agents & CLIs"));
    fireEvent.click(tile("Ollama"));
    expect(pane("ollama")?.hidden).toBe(false);
    expect(pane("agents")?.hidden).toBe(true);
    fireEvent.click(back());
    fireEvent.click(tile("Agents & CLIs"));
    expect(pane("agents")?.hidden).toBe(false);
    expect(h.agentsPanelMounts).toBe(1);
  });

  it("moves between tiles with the arrow keys and Home / End", () => {
    render(<ModelsOverlayHost />);
    open();
    const first = tile("Agents & CLIs");
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(document.activeElement).toBe(tile("Local models"));
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement).toBe(tile("Skills"));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(tile("Skills"));
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(document.activeElement).toBe(first);
    // Moving focus opens nothing.
    expect(useModelsOverlayStore.getState().view).toBe("home");
  });

  it("closes on Escape unless something inside already took it", () => {
    render(<ModelsOverlayHost />);
    open("agents");
    const ev = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    ev.preventDefault();
    act(() => {
      window.dispatchEvent(ev);
    });
    expect(useModelsOverlayStore.getState().open).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useModelsOverlayStore.getState().open).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("leaves an Escape aimed outside its frame, or at the root console on top, alone", () => {
    render(
      <>
        <ModelsOverlayHost />
        <button type="button">elsewhere</button>
      </>,
    );
    open();
    // Focus in something outside the frame (the root console's chrome).
    fireEvent.keyDown(screen.getByRole("button", { name: "elsewhere" }), { key: "Escape" });
    expect(useModelsOverlayStore.getState().open).toBe(true);
    // The root console open above it: its Escape, not ours — even from inside.
    act(() => useRootOverlayStore.setState({ open: true }));
    fireEvent.keyDown(tile("Agents & CLIs"), { key: "Escape" });
    expect(useModelsOverlayStore.getState().open).toBe(true);
    act(() => useRootOverlayStore.setState({ open: false }));
    // Inside the frame (or on <body>) it is ours.
    fireEvent.keyDown(tile("Agents & CLIs"), { key: "Escape" });
    expect(useModelsOverlayStore.getState().open).toBe(false);
  });

  it("closes on a backdrop press, not on one inside the window", () => {
    const { container } = render(<ModelsOverlayHost />);
    open();
    fireEvent.mouseDown(screen.getByRole("dialog"));
    expect(useModelsOverlayStore.getState().open).toBe(true);
    fireEvent.mouseDown(container.querySelector(".models-overlay-backdrop")!);
    expect(useModelsOverlayStore.getState().open).toBe(false);
  });

  it("deep-links to a section, named in the bar's trail", () => {
    const { container } = render(<ModelsOverlayHost />);
    open("ollama");
    expect(screen.getByTestId("ollama-panel")).toBeTruthy();
    expect(pane("agents")).toBeNull();
    expect(container.ownerDocument.querySelector(".models-home")).toBeNull();
    expect(container.ownerDocument.querySelector("[aria-current='page']")?.textContent).toBe("Ollama");
    expect(document.activeElement).toBe(back());
  });

  it("a plain open after a deep link lands on the grid again", () => {
    render(<ModelsOverlayHost />);
    open("skills");
    act(() => useModelsOverlayStore.getState().close());
    open();
    expect(useModelsOverlayStore.getState().view).toBe("home");
    expect(tile("Skills")).toBeTruthy();
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
      render(<ModelsOverlayHost />);
      open("models");
      fireEvent.click(await within(pane("models")!).findByText("Manage local models…"));
      expect(useModelsOverlayStore.getState().view).toBe("ollama");
      expect(pane("ollama")?.hidden).toBe(false);
      expect(screen.getByTestId("ollama-panel")).toBeTruthy();
      // Back to Local models by way of the grid: the autostart notice's chip
      // is the same door.
      fireEvent.click(back());
      fireEvent.click(tile("Local models"));
      expect(pane("models")?.hidden).toBe(false);
      fireEvent.click(await within(pane("models")!).findByText("Ollama…"));
      expect(useModelsOverlayStore.getState()).toMatchObject({ open: true, view: "ollama" });
      expect(pane("ollama")?.hidden).toBe(false);
      const settingsEvents = spy.mock.calls.filter(([e]) => (e as Event).type === "app:open-settings");
      expect(settingsEvents).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("passes the skills library its visibility", () => {
    render(<ModelsOverlayHost />);
    open("skills");
    expect(h.skillsVisible[h.skillsVisible.length - 1]).toBe(true);
    fireEvent.click(back());
    expect(h.skillsVisible[h.skillsVisible.length - 1]).toBe(false);
  });

  it("shows a pull started before it opened in Local models", async () => {
    useOllamaActivityStore.setState({ installed: true, downloads: { "mistral:7b": { pct: 40 } } });
    render(<ModelsOverlayHost />);
    open("models");
    expect(await screen.findByText("40%")).toBeTruthy();
    expect(screen.getByText("mistral:7b")).toBeTruthy();
    // Becoming visible reads the list, as a hover does.
    expect(await screen.findByText("qwen:7b")).toBeTruthy();
    expect(calls("list_ollama_models_detailed").length).toBeGreaterThan(0);
    // …but not the agents: this section doesn't show them.
    expect(calls("list_agents")).toHaveLength(0);
  });

  it("lays Local models out as the dropdown: Local Models band, then Machine", async () => {
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
    render(<ModelsOverlayHost />);
    open("models");
    await screen.findByText("qwen:7b");
    const machine = await screen.findByText("Machine");
    const bands = [...pane("models")!.querySelectorAll(".tab-new-menu-group-label")].map((el) => ({
      text: el.textContent,
      sub: el.classList.contains("is-sub"),
    }));
    expect(bands[0]).toEqual({ text: "Local Models", sub: false });
    expect(bands.find((b) => b.text === "Running models")?.sub).toBe(true);
    // Machine comes last, after the models' own sub-bands.
    expect(bands[bands.length - 1].text).toBe("Machine");
    expect(machine).toBeTruthy();
  });

  it("re-reads the wired CLIs when the agent registry changes", async () => {
    render(<ModelsOverlayHost />);
    open("agents");
    await waitFor(() => expect(calls("root_mcp_status")).toHaveLength(1));
    // The installed card carries the dropdown's chips, MCP included once wired.
    expect(await screen.findByRole("button", { name: "MCP" })).toBeTruthy();
    act(() => notifyAgentRegistryChanged());
    await waitFor(() => expect(calls("root_mcp_status")).toHaveLength(2));
  });
});
