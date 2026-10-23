/**
 * Manage CLIs' Codex row: Codex keeps its hook trust per config file and every
 * scope's agent home has its own, so the notice offers one button that trusts
 * the app's hooks in all of them (`codex_hook_trust`), beside the old Open in
 * Codex.
 */
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import { AgentsPanel } from "../../components/layout/SettingsSubPanels";

const codex = {
  id: "codex",
  label: "Codex",
  bin: "codex",
  install_cmd: "npm install -g @openai/codex",
  shell: "bash",
  shell_kind: "bash",
  uninstall_cmd: "npm uninstall -g @openai/codex",
  install_cmd_sudo: "",
  uninstall_cmd_sudo: "",
  docs: "https://example.invalid",
  installed: true,
  warmup: true,
};

function backend(after: string) {
  vi.mocked(invoke).mockImplementation((cmd: string) => {
    if (cmd === "list_agents") return Promise.resolve([codex]);
    if (cmd === "codex_hook_status") return Promise.resolve("untrusted");
    if (cmd === "codex_hook_trust") return Promise.resolve(after);
    return Promise.resolve(null);
  });
}

afterEach(cleanup);

describe("Manage CLIs Codex hook trust", () => {
  it("trusts the hooks in every agent home and drops the notice", async () => {
    backend("enabled");
    render(<AgentsPanel onBack={() => {}} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Trust in every agent home" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("codex_hook_trust"));
    await waitFor(() => expect(screen.queryByText(/Session hook/)).toBeNull());
  });

  it("says so when a hook stays untrusted", async () => {
    backend("untrusted");
    render(<AgentsPanel onBack={() => {}} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Trust in every agent home" }));
    expect(await screen.findByText(/could not be trusted/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open in Codex" })).toBeTruthy();
  });
});
