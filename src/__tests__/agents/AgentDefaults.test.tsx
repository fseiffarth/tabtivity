import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(() => Promise.resolve()), listen: vi.fn(() => Promise.resolve(() => {})) }));

import { invoke } from "@tauri-apps/api/core";
import { AgentDefaults } from "../../components/settings/AgentDefaults";
import { ReaderLaunchDefaults } from "../../components/terminal/ReaderLaunchDefaults";
import { useSettingsStore } from "../../stores/settings";
import type { AgentInfo } from "../../components/settings/agentTypes";
import type { Settings } from "../../types";

const agent: AgentInfo = {
  id: "codex", bin: "codex", label: "Codex", installed: true, warmup: true,
  install_cmd: "", shell: "bash", shell_kind: "bash", uninstall_cmd: "",
  install_cmd_sudo: "", uninstall_cmd_sudo: "", docs: "",
  launch_defaults: { model: true, efforts: ["low", "high", "ultra"] },
};
const originalUpdate = useSettingsStore.getState().updateSettings;

afterEach(() => {
  cleanup();
  useSettingsStore.setState({ settings: null, updateSettings: originalUpdate });
});

function store(defaults: Settings["agent_launch_defaults"] = {}) {
  const update = vi.fn(async (patch: Partial<Settings>) => {
    useSettingsStore.setState((s) => ({ settings: { ...s.settings, ...patch } as Settings }));
  });
  useSettingsStore.setState({ settings: { agent_launch_defaults: defaults } as Settings, updateSettings: update });
  return update;
}

describe("per-CLI startup defaults", () => {
  it("saves model and effort together, retaining another CLI's defaults", async () => {
    const update = store({ claude: { model: "opus", effort: "high" } });
    render(<AgentDefaults agent={agent} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Default model" }), { target: { value: "  my-model  " } });
    fireEvent.click(screen.getByRole("button", { name: "Default effort" }));
    fireEvent.click(screen.getByRole("option", { name: "ultra" }));
    fireEvent.click(screen.getByRole("button", { name: "Save defaults" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ agent_launch_defaults: {
      claude: { model: "opus", effort: "high" }, codex: { model: "my-model", effort: "ultra" },
    } }));
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save defaults" }).disabled).toBe(true));
  });

  it("reset removes only this CLI and persists across remounts", async () => {
    const update = store({ codex: { model: "old", effort: "high" }, claude: { model: "sonnet" } });
    const view = render(<AgentDefaults agent={agent} />);
    fireEvent.click(screen.getByRole("button", { name: "Use CLI defaults" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ agent_launch_defaults: { claude: { model: "sonnet" } } }));
    view.unmount();
    render(<AgentDefaults agent={agent} />);
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Default model" }).value).toBe("");
  });

  it("reports a failed save and keeps the draft for retry", async () => {
    const update = store();
    update.mockRejectedValueOnce(new Error("disk unavailable"));
    render(<AgentDefaults agent={agent} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "my-model" } });
    fireEvent.click(screen.getByRole("button", { name: "Save defaults" }));
    expect((await screen.findByRole("alert")).textContent).toContain("disk unavailable");
    expect(screen.getByRole<HTMLInputElement>("textbox").value).toBe("my-model");
    expect(useSettingsStore.getState().settings?.agent_launch_defaults).toEqual({});
  });

  it("does not save option-like model IDs", async () => {
    const update = store();
    render(<AgentDefaults agent={agent} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "--help" } });
    fireEvent.click(screen.getByRole("button", { name: "Save defaults" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(update).not.toHaveBeenCalled();
  });

  it("explains unsupported settings and an older backend", () => {
    store();
    const view = render(<AgentDefaults agent={{ ...agent, launch_defaults: { model: false, efforts: [] } }} />);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save defaults" })).toBeNull();
    view.rerender(<AgentDefaults agent={{ ...agent, launch_defaults: undefined }} />);
    expect(screen.getByText(/updated backend/)).toBeTruthy();
  });

  it("requires a model when the native effort setting needs one", async () => {
    const update = store();
    render(<AgentDefaults agent={{ ...agent, launch_defaults: { ...agent.launch_defaults!, effort_requires_model: true } }} />);
    fireEvent.click(screen.getByRole("button", { name: "Default effort" }));
    fireEvent.click(screen.getByRole("option", { name: "high" }));
    fireEvent.click(screen.getByRole("button", { name: "Save defaults" }));
    expect((await screen.findByRole("alert")).textContent).toContain("needs a default model");
    expect(update).not.toHaveBeenCalled();
  });
});

describe("defaults saved from the phone", () => {
  it("shows the file's latest and keeps it when another CLI is saved here", async () => {
    const update = store({});
    vi.mocked(invoke).mockImplementation(async (cmd: string) => (cmd === "get_settings"
      ? { agent_launch_defaults: { codex: { model: "from-phone", effort: "low" }, claude: { model: "opus", effort: "" } } }
      : undefined) as never);
    render(<AgentDefaults agent={{ ...agent, id: "gemini", bin: "gemini", label: "Gemini" }} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Default model" }), { target: { value: "pro" } });
    fireEvent.click(screen.getByRole("button", { name: "Save defaults" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ agent_launch_defaults: {
      codex: { model: "from-phone", effort: "low" }, claude: { model: "opus", effort: "" }, gemini: { model: "pro", effort: "" },
    } }));
    cleanup();
    render(<AgentDefaults agent={agent} />);
    await waitFor(() => expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Default model" }).value).toBe("from-phone"));
  });
});

describe("launch defaults under the Chat view's model list", () => {
  const goose: AgentInfo = { ...agent, id: "goose", bin: "goose", label: "Goose", launch_defaults: { model: false, efforts: [] } };
  const list = () => vi.mocked(invoke).mockImplementation(async (cmd: string) => (cmd === "list_agents" ? [agent, goose] : undefined) as never);

  it("shows this CLI's saved default and saves from the fold without the help text", async () => {
    list();
    const update = store({ codex: { model: "old", effort: "high" } });
    render(<ReaderLaunchDefaults cmd="/usr/local/bin/codex.exe" />);
    const toggle = await screen.findByRole("button", { name: /Default for new tabs: old · high/ });
    fireEvent.click(toggle);
    expect(screen.queryByText(/Applies to new sessions in every project/)).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "Default model" }), { target: { value: "new" } });
    fireEvent.click(screen.getByRole("button", { name: "Save defaults" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ agent_launch_defaults: { codex: { model: "new", effort: "high" } } }));
    expect(await screen.findByRole("button", { name: /Default for new tabs: new · high/ })).toBeTruthy();
  });

  it("names the CLI default when nothing is saved, and stays away for a CLI with no startup option", async () => {
    list();
    store();
    render(<><div data-testid="goose"><ReaderLaunchDefaults cmd="goose" /></div><ReaderLaunchDefaults cmd="codex" /></>);
    // Codex's row proves the shared list has come in; Goose's has nothing.
    expect(await screen.findByRole("button", { name: /Default for new tabs: CLI default/ })).toBeTruthy();
    expect(screen.getByTestId("goose").textContent).toBe("");
  });
});
