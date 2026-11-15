/**
 * The intro's Agents page saves the user's pick as `default_agent_cmd`: it
 * opens on the current default, an installed chip or a confirmed install
 * saves, and clicking through an uninstalled chip (browsing) or an install
 * that failed saves nothing.
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
import { resetInstallRuns } from "../../stores/installRuns";
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
  resetInstallRuns();
});

/** `install_agent` held open until the returned `finish` is called. */
function holdInstall(): () => void {
  let finish: () => void = () => {};
  const base = invokeMock.getMockImplementation()!;
  invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
    if (cmd === "install_agent") return new Promise<string>((r) => (finish = () => r("ok")));
    return base(cmd, args as never);
  });
  return () => finish();
}

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

  it("does not save an uninstalled chip until its install is confirmed", async () => {
    let finish: (v: string) => void = () => {};
    const base = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "install_agent") return new Promise<string>((r) => (finish = r));
      return base(cmd, args as never);
    });
    mount();
    fireEvent.click(await chip("Gemini CLI"));
    expect(updateSettings).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: /^Install Gemini CLI/ }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("install_agent", { id: "gemini" }));
    // Clicked, still running: nothing saved yet.
    expect(updateSettings).not.toHaveBeenCalled();
    finish("ok");
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ default_agent_cmd: "gemini" }));
  });

  it("does not save the default when the install fails", async () => {
    const base = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "install_agent") throw "npm ERR! EACCES";
      return base(cmd, args as never);
    });
    mount();
    fireEvent.click(await chip("Gemini CLI"));
    fireEvent.click(await screen.findByRole("button", { name: /^Install Gemini CLI/ }));
    await screen.findByRole("alert");
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("a late install does not overwrite a default picked since the click", async () => {
    const finish = holdInstall();
    mount();
    fireEvent.click(await chip("Gemini CLI"));
    fireEvent.click(await screen.findByRole("button", { name: /^Install Gemini CLI/ }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("install_agent", { id: "gemini" }));
    fireEvent.click(await chip("Codex"));
    expect(updateSettings).toHaveBeenCalledWith({ default_agent_cmd: "codex" });
    finish();
    await waitFor(() => expect(invokeMock.mock.calls.filter(([c]) => c === "list_agents").length).toBeGreaterThan(1));
    expect(updateSettings).not.toHaveBeenCalledWith({ default_agent_cmd: "gemini" });
  });

  it("an install that ends after the user moved on still becomes the default", async () => {
    const finish = holdInstall();
    mount();
    fireEvent.click(await chip("Gemini CLI"));
    fireEvent.click(await screen.findByRole("button", { name: /^Install Gemini CLI/ }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("install_agent", { id: "gemini" }));
    cleanup();
    finish();
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ default_agent_cmd: "gemini" }));
  });

  it("saves when Recheck finds the selected CLI installed", async () => {
    mount();
    fireEvent.click(await chip("Gemini CLI"));
    invokeMock.mockImplementation(async (cmd: string) => (cmd === "agent_is_installed" ? true : null));
    fireEvent.click(await screen.findByRole("button", { name: /^Re-check$/ }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ default_agent_cmd: "gemini" }));
  });
});
