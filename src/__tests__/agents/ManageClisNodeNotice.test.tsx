/**
 * Manage CLIs' Node.js helper: a missing npm blocks every install and is
 * announced above the CLIs, while an older Node is fine for most of them and
 * shows only in the card of an install npm refused for it (EBADENGINE).
 */
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import { AgentsPanel } from "../../components/settings/AgentsPanel";

const agent = (id: string, label: string) => ({
  id,
  label,
  bin: id,
  install_cmd: `npm install -g ${id}`,
  shell: "bash",
  shell_kind: "bash",
  uninstall_cmd: `npm uninstall -g ${id}`,
  install_cmd_sudo: "",
  uninstall_cmd_sudo: "",
  docs: "https://example.invalid",
  installed: true,
  warmup: true,
});

function backend(node: { npm: boolean; version: string | null; too_old: boolean }, installError?: string) {
  vi.mocked(invoke).mockImplementation((cmd: string) => {
    if (cmd === "list_agents") return Promise.resolve([agent("gemini", "Gemini")]);
    if (cmd === "node_runtime_status") return Promise.resolve({ ...node, min_major: 24 });
    if (cmd === "install_agent" && installError) return Promise.reject(installError);
    return Promise.resolve(null);
  });
}

afterEach(cleanup);

describe("Manage CLIs Node.js helper", () => {
  it("announces a missing npm above the CLIs", async () => {
    backend({ npm: false, version: null, too_old: false });
    render(<AgentsPanel onBack={() => {}} onClose={() => {}} />);
    expect(await screen.findByText("Node.js / npm")).toBeTruthy();
  });

  it("says nothing about an older Node until an install trips over it", async () => {
    backend({ npm: true, version: "v22.22.1", too_old: true }, "npm error code EBADENGINE");
    render(<AgentsPanel onBack={() => {}} onClose={() => {}} />);
    const reinstall = await screen.findByRole("button", { name: /^Reinstall$/ });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("node_runtime_status"));
    expect(screen.queryByText("Node.js / npm")).toBeNull();

    fireEvent.click(reinstall);
    const title = await screen.findByText("Node.js / npm");
    const notice = title.closest(".agents-notice") as HTMLElement;
    expect(within(notice).getByText("Version 22.22.1, older than 24")).toBeTruthy();
  });

  it("keeps quiet when an install fails for another reason", async () => {
    backend({ npm: true, version: "v22.22.1", too_old: true }, "npm error code EACCES");
    render(<AgentsPanel onBack={() => {}} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /^Reinstall$/ }));
    expect(await screen.findByText("npm error code EACCES")).toBeTruthy();
    expect(screen.queryByText("Node.js / npm")).toBeNull();
  });
});
