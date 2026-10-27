/**
 * Manage CLIs on a hosted server (TODO #2354; user decision 2026-10-03: only
 * the administrator installs, updates or removes agent CLIs): versions stay,
 * every install/update/remove control is gone, and the card names the admin
 * helper command to ask for.
 */
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import { AgentsPanel } from "../../components/settings/AgentsPanel";
import { markCliInstallsByAdmin } from "../../lib/transport/linkState";
import { NAMES } from "../../lib/brand";

const agent = (id: string, label: string, installed: boolean) => ({
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
  installed,
  warmup: true,
});

function backend() {
  vi.mocked(invoke).mockImplementation((cmd: string) => {
    if (cmd === "list_agents") return Promise.resolve([agent("codex", "Codex", true), agent("claude", "Claude", false)]);
    if (cmd === "agent_versions")
      return Promise.resolve([{ agent: "codex", label: "Codex", installed: true, supported: true, version: "0.153.4", raw: "codex-cli 0.153.4", state: "match", stale: [], error: null, checkedAt: 1, cached: true, dismissed: false }]);
    return Promise.resolve(null);
  });
}

afterEach(() => {
  cleanup();
  markCliInstallsByAdmin(false);
});

describe("Manage CLIs on a hosted server", () => {
  it("shows versions and the admin's command instead of install, update and remove", async () => {
    markCliInstallsByAdmin(true);
    backend();
    render(<AgentsPanel onBack={() => {}} onClose={() => {}} />);
    expect(await screen.findByText("0.153.4")).toBeTruthy();
    expect(screen.getByText(`sudo ${NAMES.serverAdminHelper} cli-install codex`)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Remove$/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Reinstall$/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Install Claude/ })).toBeNull();
  });

  it("keeps the buttons everywhere else", async () => {
    backend();
    render(<AgentsPanel onBack={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(screen.getAllByRole("button", { name: /^Remove$/ }).length).toBeGreaterThan(0));
    expect(screen.queryByText(new RegExp(`${NAMES.serverAdminHelper} cli-install`))).toBeNull();
  });
});
