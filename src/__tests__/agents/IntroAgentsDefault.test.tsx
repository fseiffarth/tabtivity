/**
 * The intro's Agents page saves the user's pick as `default_agent_cmd`: it
 * opens on the current default, an installed chip or an Install click saves,
 * and clicking through an uninstalled chip (browsing) saves nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));
vi.mock("../../lib/installCommand", async (orig) => ({
  ...(await orig<typeof import("../../lib/installCommand")>()),
  runInstallInTab: vi.fn(),
}));

import { AgentsPage } from "../../components/layout/intro/AgentsPage";
import { useSettingsStore } from "../../stores/settings";
import type { Settings } from "../../types";

const invokeMock = vi.mocked(invoke);
const updateSettings = vi.fn(async () => {});

const agent = (id: string, label: string, installed: boolean) => ({
  id,
  label,
  bin: id,
  install_cmd: `install ${id}`,
  shell_kind: "bash",
  docs: "",
  installed,
});

function mount(defaultAgentCmd?: string) {
  useSettingsStore.setState({
    settings: (defaultAgentCmd ? { default_agent_cmd: defaultAgentCmd } : {}) as Settings,
    updateSettings,
  } as never);
  render(<AgentsPage onClose={() => {}} />);
}

beforeEach(() => {
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === "list_agents")
      return [agent("claude", "Claude Code", true), agent("codex", "Codex", true), agent("gemini", "Gemini CLI", false)];
    if (cmd === "node_runtime_status") return { npm: true, too_old: false, version: "22", min_major: 18 };
    return null;
  });
});

afterEach(() => {
  cleanup();
  invokeMock.mockReset();
  updateSettings.mockClear();
});

const chip = (name: string) => screen.findByRole("button", { name: new RegExp(`^${name}$`) });

describe("intro Agents page default CLI", () => {
  it("opens on the current default and saves nothing by itself", async () => {
    mount("codex");
    expect((await chip("Codex")).getAttribute("aria-pressed")).toBe("true");
    await screen.findByText(/Codex is your default agent CLI/);
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("saves an installed chip as the default", async () => {
    mount();
    fireEvent.click(await chip("Codex"));
    expect(updateSettings).toHaveBeenCalledWith({ default_agent_cmd: "codex" });
  });

  it("does not save an uninstalled chip until Install is clicked", async () => {
    mount();
    fireEvent.click(await chip("Gemini CLI"));
    expect(updateSettings).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: /^Install Gemini CLI/ }));
    expect(updateSettings).toHaveBeenCalledWith({ default_agent_cmd: "gemini" });
  });

  it("saves when Recheck finds the selected CLI installed", async () => {
    mount();
    fireEvent.click(await chip("Gemini CLI"));
    invokeMock.mockImplementation(async (cmd: string) => (cmd === "agent_is_installed" ? true : null));
    fireEvent.click(await screen.findByRole("button", { name: /^Re-check$/ }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ default_agent_cmd: "gemini" }));
  });
});
