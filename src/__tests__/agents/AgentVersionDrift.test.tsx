/**
 * Settings → Manage Agents: the installed-CLI version chip and its drift notice
 * (backend `services::agent_versions`).
 *
 * The point of the feature is a signal that is *quiet until it matters*, so
 * what these lock in is when it speaks and what it costs:
 *
 *  1. **Opening the panel never forces a probe.** The backend caches for a day;
 *     asking with `refresh: true` on mount would spawn every installed agent CLI
 *     each time the panel opens, which is exactly the cost the cache exists to
 *     avoid. Re-check is the one caller allowed to force it.
 *  2. **Drift names every stale check, weakest first.** "Codex moved" is not
 *     actionable; "the mode lines were last verified at 0.151.0" is.
 *  3. **A dismissal is keyed by version.** It is sent with the version the user
 *     actually saw, so the notice can come back on the next release rather than
 *     being silenced forever.
 *  4. **A matching version says nothing.** An agent still on the verified
 *     release gets a chip and no warning.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

import { AgentsPanel } from "../../components/layout/SettingsSubPanels";
import { BRAND } from "../../lib/brand";

const invokeMock = vi.mocked(invoke);

const agent = (id: string, label: string) => ({
  id,
  label,
  bin: id,
  install_cmd: `npm install -g ${id}`,
  shell: "bash",
  shell_kind: "bash",
  uninstall_cmd: "",
  install_cmd_sudo: "",
  uninstall_cmd_sudo: "",
  docs: "https://example.invalid",
  installed: true,
  warmup: true,
});

const report = (overrides: Record<string, unknown> = {}) => ({
  agent: "codex",
  label: "Codex",
  installed: true,
  supported: true,
  version: "0.153.4",
  raw: "codex-cli 0.153.4",
  state: "moved",
  stale: [
    {
      version: "0.151.0",
      surface: "§1.2 — mobile mode lines (agentModes.ts)",
      direction: "newer",
    },
    {
      version: "0.153.0",
      surface: "§1.2 — decision lamp",
      direction: "newer",
    },
  ],
  error: null,
  checkedAt: 1_760_000_000,
  cached: true,
  dismissed: false,
  ...overrides,
});

function backend(versions: unknown[]) {
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "list_agents") return Promise.resolve([agent("codex", "Codex")]);
    if (cmd === "agent_versions") return Promise.resolve(versions);
    return Promise.resolve(null);
  });
}

const calls = (cmd: string) => invokeMock.mock.calls.filter(([name]) => name === cmd);

beforeEach(() => {
  invokeMock.mockReset();
  backend([report()]);
});

const panel = () => render(<AgentsPanel onBack={() => {}} onClose={() => {}} />);

describe("agent CLI version drift", () => {
  it("reads cached versions when the panel opens, and forces a probe only on re-check", async () => {
    panel();
    await waitFor(() => expect(calls("agent_versions")).toHaveLength(1));
    expect(calls("agent_versions")[0][1]).toEqual({ refresh: false });

    await userEvent.click(await screen.findByRole("button", { name: "Re-check version" }));
    await waitFor(() => expect(calls("agent_versions")).toHaveLength(2));
    expect(calls("agent_versions")[1][1]).toEqual({ refresh: true });
  });

  it("shows the installed version and every check it has moved away from", async () => {
    panel();
    expect(await screen.findByText("0.153.4")).toBeTruthy();
    expect(
      screen.getByText(new RegExp(String.raw`not the one ${BRAND.display} was verified against`)),
    ).toBeTruthy();
    const notes = screen.getAllByRole("listitem").map((li) => li.textContent);
    // Weakest assumption first, and each one names where to look.
    expect(notes[0]).toContain("0.151.0");
    expect(notes[0]).toContain("agentModes.ts");
    expect(notes[1]).toContain("0.153.0");
  });

  it("dismisses with the version the user was shown, and stops warning", async () => {
    panel();
    await userEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(calls("dismiss_agent_version")).toHaveLength(1));
    expect(calls("dismiss_agent_version")[0][1]).toEqual({
      agent: "codex",
      version: "0.153.4",
    });
    await waitFor(() =>
      expect(screen.queryByText(new RegExp(String.raw`not the one ${BRAND.display} was verified against`))).toBeNull(),
    );
    // The version itself is still shown — only the warning is silenced.
    expect(screen.getByText("0.153.4")).toBeTruthy();
  });

  it("says nothing when the installed release is the verified one", async () => {
    backend([report({ state: "match", stale: [], version: "0.151.0", raw: "codex-cli 0.151.0" })]);
    panel();
    expect(await screen.findByText("0.151.0")).toBeTruthy();
    expect(screen.queryByText(new RegExp(String.raw`not the one ${BRAND.display} was verified against`))).toBeNull();
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });

  it("says a CLI nobody has checked cannot be asked, instead of guessing a flag", async () => {
    backend([
      report({ supported: false, state: "unknown", version: null, raw: null, stale: [] }),
    ]);
    panel();
    expect(await screen.findByText(/nobody has checked what this CLI answers/)).toBeTruthy();
    // No re-check button either: there is nothing to re-run.
    expect(screen.queryByRole("button", { name: "Re-check version" })).toBeNull();
  });
});
