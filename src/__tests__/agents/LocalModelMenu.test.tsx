/**
 * The header's Models & agents button (`layout/LocalModelMenu`): the hover
 * dropdown and what it shares with the Models & agents overlay.
 *
 * Written as a characterization suite before the menu's body moved out into
 * `models/useModelsHub` + `stores/agents/ollamaActivity`, so the move had to
 * keep every one of these green. What they lock in:
 *
 *  1. Hover opens the dropdown with the installed agents and the models.
 *  2. Pull progress started anywhere shows a download row; a pause flips it
 *     to Resume / Delete.
 *  3. A model finishing its load re-reads the model list.
 *  4. One resident model left → it takes the default and every task role,
 *     written once — including when the unload that left it was done in the
 *     overlay (the model list is shared, `stores/agents/ollamaActivity`).
 *
 * And the click that opens the Models & agents overlay: every door in the
 * dropdown lands on its tab and none goes out to Settings, the dropdown stays
 * shut while the overlay is up, and Escape hands focus back to the button
 * without popping the dropdown open. A dropdown opened by keyboard focus
 * closes on Escape or when focus leaves it (it has no mouse-leave coming).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act, waitFor, within } from "@testing-library/react";

const h = vi.hoisted(() => ({
  listeners: new Map<string, Set<(e: { payload: unknown }) => void>>(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, cb: (e: { payload: unknown }) => void) => {
    let set = h.listeners.get(name);
    if (!set) {
      set = new Set();
      h.listeners.set(name, set);
    }
    set.add(cb);
    return Promise.resolve(() => {
      set.delete(cb);
    });
  }),
  emit: vi.fn(() => Promise.resolve()),
}));
// The overlay's Settings-hosted panes are not what this suite is about.
vi.mock("../../components/layout/SettingsSubPanels", () => ({
  AgentsPanel: () => <div data-testid="agents-panel" />,
  OllamaPanel: () => <div data-testid="ollama-panel" />,
}));
vi.mock("../../components/skills/SkillsLibraryView", () => ({
  SkillsLibraryView: () => <div data-testid="skills-view" />,
}));

import { invoke } from "@tauri-apps/api/core";
import { LocalModelMenu } from "../../components/layout/LocalModelMenu";
import { useSettingsStore } from "../../stores/settings";
import { useHeaderHoverMenuStore } from "../../stores/headerHoverMenu";
import { resetOllamaStatusPoller } from "../../lib/ollamaStatus";
import { resetOllamaAutoload, useOllamaAutoloadStore } from "../../stores/agents/ollamaAutoload";
import { __resetOllamaActivityForTests } from "../../stores/agents/ollamaActivity";
import { useModelsOverlayStore } from "../../stores/modelsOverlay";
import { ModelsOverlayHost } from "../../components/models/ModelsOverlay";

const invokeMock = vi.mocked(invoke);

type Model = { name: string; running: boolean };
let models: Model[] = [];
let patches: Array<Record<string, unknown>> = [];
let ollamaInstalled = true;

const modelInfo = (m: Model) => ({
  name: m.name,
  parameter_size: "7B",
  quantization: "Q4_K_M",
  running: m.running,
  size_vram: 0,
  size: 4_000_000_000,
  capabilities: ["completion", "tools"],
});

function backend() {
  invokeMock.mockImplementation(((cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      case "ollama_is_installed":
        return Promise.resolve(ollamaInstalled);
      case "ollama_status":
        return Promise.resolve(models.some((m) => m.running) ? "loaded" : "idle");
      case "list_agents":
        return Promise.resolve([
          { id: "claude", label: "Claude Code", bin: "claude", installed: true },
          { id: "codex", label: "Codex", bin: "codex", installed: false },
        ]);
      case "root_mcp_status":
        return Promise.resolve({ wired_clis: ["claude"] });
      case "list_ollama_models_detailed":
        return Promise.resolve(models.map(modelInfo));
      case "ollama_version_status":
        return Promise.resolve({
          current: "0.15.0",
          latest: "",
          update_available: false,
          install_cmd: "",
          shell_kind: "",
          error: null,
        });
      case "ollama_gpu_status":
        return Promise.resolve({
          gpu_present: false,
          integrated_only: false,
          model_on_cpu: false,
          igpu_flag_supported: false,
          igpu_dropped: false,
        });
      case "gpu_memory_snapshot":
        return Promise.resolve([]);
      case "machine_load_snapshot":
        return Promise.resolve({ supported: false });
      case "stop_ollama_model":
        models = models.map((m) => (m.name === args?.model ? { ...m, running: false } : m));
        return Promise.resolve(null);
      case "patch_settings": {
        const patch = args?.patch as Record<string, unknown>;
        patches.push(patch);
        return Promise.resolve({ ...useSettingsStore.getState().settings, ...patch });
      }
      default:
        return Promise.resolve(null);
    }
  }) as never);
}

const fire = (name: string, payload: unknown) =>
  act(() => {
    for (const cb of h.listeners.get(name) ?? []) cb({ payload });
  });

const calls = (cmd: string) => invokeMock.mock.calls.filter(([c]) => c === cmd);

async function renderInstalled() {
  const view = render(
    <>
      <LocalModelMenu />
      <ModelsOverlayHost />
    </>,
  );
  // The installed poll flips the button's tooltip from "install" to a status.
  // Named for what its click opens.
  const btn = screen.getByRole("button", { name: "Models & agents" });
  await waitFor(() => expect(btn.getAttribute("title")).not.toMatch(/install/i));
  return { ...view, btn, wrap: view.container.querySelector(".global-apps-menu") as HTMLElement };
}

async function hover(wrap: HTMLElement) {
  fireEvent.mouseEnter(wrap);
  await screen.findByText("Claude Code");
}

beforeEach(() => {
  // The overlay's tab and frame persist; keep each test from reading the last one's.
  localStorage.clear();
  models = [
    { name: "qwen:7b", running: true },
    { name: "llama:8b", running: false },
  ];
  patches = [];
  ollamaInstalled = true;
  h.listeners.clear();
  invokeMock.mockReset();
  backend();
  resetOllamaStatusPoller();
  resetOllamaAutoload();
  __resetOllamaActivityForTests();
  useModelsOverlayStore.setState({ open: false, view: "home" });
  useHeaderHoverMenuStore.setState({ openId: null });
  useSettingsStore.setState({
    settings: { ollama_model: "qwen:7b", ollama_roles: {} },
  } as never);
});

afterEach(() => {
  cleanup();
  resetOllamaStatusPoller();
});

describe("LocalModelMenu dropdown", () => {
  it("opens on hover with the installed agents and the models", async () => {
    const { wrap } = await renderInstalled();
    fireEvent.mouseEnter(wrap);
    expect(await screen.findByText("Claude Code")).toBeTruthy();
    expect(screen.queryByText("Codex")).toBeNull();
    expect(await screen.findByText("qwen:7b")).toBeTruthy();
    expect(screen.getByText("llama:8b")).toBeTruthy();
    expect(screen.getByText("Running models")).toBeTruthy();
    expect(screen.getByText("Models on disk")).toBeTruthy();
  });

  it("shows a download started anywhere, and a pause flips it to Resume / Delete", async () => {
    const { wrap } = await renderInstalled();
    await hover(wrap);
    await screen.findByText("qwen:7b");
    fire("ollama-pull-progress", { model: "mistral:7b", status: "pulling", completed: 50, total: 100 });
    expect(await screen.findByText("50%")).toBeTruthy();
    expect(screen.getByText("mistral:7b")).toBeTruthy();
    fire("ollama-pull-progress", { model: "mistral:7b", status: "paused", completed: 50, total: 100 });
    expect(await screen.findByText("Resume")).toBeTruthy();
    expect(screen.getByText("Delete")).toBeTruthy();
    expect(screen.queryByText("50%")).toBeNull();
  });

  it("re-reads the model list when a load finishes", async () => {
    const { wrap } = await renderInstalled();
    await hover(wrap);
    await screen.findByText("qwen:7b");
    const before = calls("list_ollama_models_detailed").length;
    models = models.map((m) => ({ ...m, running: true }));
    fire("ollama-load-progress", { model: "llama:8b", status: "success" });
    await waitFor(() => expect(calls("list_ollama_models_detailed").length).toBeGreaterThan(before));
  });

  it("gives a sole resident model every role, once", async () => {
    const { wrap } = await renderInstalled();
    await hover(wrap);
    await screen.findByText("qwen:7b");
    await waitFor(() => expect(patches.filter((p) => "ollama_roles" in p)).toHaveLength(1));
    const [patch] = patches.filter((p) => "ollama_roles" in p);
    expect(patch.ollama_model).toBe("qwen:7b");
    expect(patch.ollama_roles).toEqual({
      autocomplete: "qwen:7b",
      autocomplete_prose: "qwen:7b",
      tabs: "qwen:7b",
      mail: "qwen:7b",
    });
    // A re-hover reads the same single model again: no second write.
    fireEvent.mouseLeave(wrap);
    fireEvent.mouseEnter(wrap);
    await waitFor(() => expect(calls("list_ollama_models_detailed").length).toBeGreaterThan(1));
    expect(patches.filter((p) => "ollama_roles" in p)).toHaveLength(1);
  });

  it("gives the one model left after an unload in the overlay every role", async () => {
    models = [
      { name: "qwen:7b", running: true },
      { name: "llama:8b", running: true },
    ];
    const { wrap } = await renderInstalled();
    await hover(wrap);
    await screen.findByText("llama:8b");
    act(() => useHeaderHoverMenuStore.getState().close("local-model"));
    expect(patches.filter((p) => "ollama_roles" in p)).toHaveLength(0);

    act(() => useModelsOverlayStore.getState().openOverlay("models"));
    const dialog = await screen.findByRole("dialog", { name: "Models & agents" });
    const unload = await within(dialog).findByTitle("Unload llama:8b from memory");
    fireEvent.click(unload);
    await waitFor(() => expect(patches.filter((p) => "ollama_roles" in p)).toHaveLength(1));
    expect(patches.find((p) => "ollama_roles" in p)?.ollama_model).toBe("qwen:7b");
  });
});

describe("LocalModelMenu button and the Models & agents overlay", () => {
  it("toggles the overlay on click and closes the dropdown", async () => {
    const { wrap, btn } = await renderInstalled();
    await hover(wrap);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(btn);
    expect(useModelsOverlayStore.getState().open).toBe(true);
    expect(wrap.querySelector(".local-model-menu")).toBeNull();
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(await screen.findByRole("dialog", { name: "Models & agents" })).toBeTruthy();
    fireEvent.click(btn);
    expect(useModelsOverlayStore.getState().open).toBe(false);
  });

  it("opens each door's tab and never dispatches the Settings event", async () => {
    useOllamaAutoloadStore.setState({ phase: "skipped", pending: ["llama:8b"], models: ["llama:8b"], dismissed: false });
    const spy = vi.spyOn(window, "dispatchEvent");
    const { wrap } = await renderInstalled();
    const door = async (label: string, tab: string) => {
      act(() => useModelsOverlayStore.setState({ open: false, view: "models" }));
      await hover(wrap);
      fireEvent.click(await within(wrap).findByText(label));
      expect(useModelsOverlayStore.getState()).toMatchObject({ open: true, view: tab });
      expect(wrap.querySelector(".local-model-menu")).toBeNull();
    };
    await door("Manage CLIs…", "agents");
    await door("Skills library…", "skills");
    await door("Manage local models…", "ollama");
    await door("Ollama…", "ollama");
    const settingsEvents = spy.mock.calls.filter(([e]) => (e as Event).type === "app:open-settings");
    expect(settingsEvents).toHaveLength(0);
    spy.mockRestore();
  });

  it("sends Install Ollama… to the Ollama tab when Ollama is missing", async () => {
    ollamaInstalled = false;
    const view = render(<LocalModelMenu />);
    const wrap = view.container.querySelector(".global-apps-menu") as HTMLElement;
    fireEvent.mouseEnter(wrap);
    fireEvent.click(await screen.findByText("Install Ollama…"));
    expect(useModelsOverlayStore.getState()).toMatchObject({ open: true, view: "ollama" });
  });

  it("does not reveal the dropdown on hover while the overlay is open", async () => {
    const { wrap, btn } = await renderInstalled();
    fireEvent.click(btn);
    fireEvent.mouseEnter(wrap);
    expect(wrap.querySelector(".local-model-menu")).toBeNull();
    expect(useHeaderHoverMenuStore.getState().openId).toBeNull();
  });

  it("hands focus back to the button on Escape without opening the dropdown", async () => {
    const { wrap, btn } = await renderInstalled();
    fireEvent.click(btn);
    const dialog = await screen.findByRole("dialog", { name: "Models & agents" });
    // The active tab takes focus on open.
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(btn);
    expect(wrap.querySelector(".local-model-menu")).toBeNull();
    expect(useHeaderHoverMenuStore.getState().openId).toBeNull();
    // A later, real focus still reveals it.
    act(() => btn.blur());
    act(() => btn.focus());
    expect(await screen.findByText("Claude Code")).toBeTruthy();
  });

  it("does not refresh a second time when a mouse click focuses the button", async () => {
    const { wrap, btn } = await renderInstalled();
    await hover(wrap);
    const agents = calls("list_agents").length;
    const modelReads = calls("list_ollama_models_detailed").length;
    // WebKitGTK focuses a clicked button: the hover already revealed and read.
    act(() => btn.focus());
    expect(calls("list_agents")).toHaveLength(agents);
    expect(calls("list_ollama_models_detailed")).toHaveLength(modelReads);
    expect(wrap.querySelector(".local-model-menu")).not.toBeNull();
  });

  it("closes a keyboard-opened dropdown on Escape, without touching the overlay", async () => {
    const { wrap, btn } = await renderInstalled();
    act(() => btn.focus());
    await screen.findByText("Claude Code");
    fireEvent.keyDown(btn, { key: "Escape" });
    expect(wrap.querySelector(".local-model-menu")).toBeNull();
    expect(useHeaderHoverMenuStore.getState().openId).toBeNull();
    expect(useModelsOverlayStore.getState().open).toBe(false);
    expect(document.activeElement).toBe(btn);
  });

  it("closes a keyboard-opened dropdown when focus leaves it, not on a click inside", async () => {
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    try {
      const { wrap, btn } = await renderInstalled();
      act(() => btn.focus());
      await screen.findByText("Claude Code");
      // Focus moving within the wrapper (onto one of the list's buttons) keeps it.
      act(() => within(wrap).getByText("Manage CLIs…").closest("button")!.focus());
      expect(wrap.querySelector(".local-model-menu")).not.toBeNull();
      // With the pointer over it, focus dropping to <body> (a click on plain
      // text) is no leaving.
      fireEvent.mouseEnter(wrap);
      act(() => (document.activeElement as HTMLElement).blur());
      expect(wrap.querySelector(".local-model-menu")).not.toBeNull();
      fireEvent.mouseLeave(wrap);
      // Tabbing on to something outside closes it at once.
      act(() => btn.focus());
      act(() => outside.focus());
      expect(wrap.querySelector(".local-model-menu")).toBeNull();
    } finally {
      outside.remove();
    }
  });
});
