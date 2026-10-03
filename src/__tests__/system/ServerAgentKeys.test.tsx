/**
 * The administrator's agent API keys (hosted plan §5.4, P3b): the admin
 * panel lists the CLIs that can take a key (from the daemon's registry),
 * offers and withdraws keys through the gateway, and never shows one back;
 * a user picks the administrator's key or their own login per CLI in the
 * Agent logins rows (§5.2).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import { ServerAgentKeys } from "../../components/server/ServerAgentKeys";
import { AgentLoginsRows } from "../../components/layout/SettingsSubPanels";

const login = (id: string, env: string | null, extra: Record<string, unknown> = {}) => ({
  id,
  signed_in: true,
  account: null,
  importable: false,
  blocked: null,
  shared: true,
  api_key_env: env,
  admin_key_offered: false,
  uses_admin_key: false,
  ...extra,
});

function answer(body: unknown, status = 200) {
  return Promise.resolve({ ok: status < 300, status, json: () => Promise.resolve(body) } as Response);
}

describe("ServerAgentKeys (administrator)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.mocked(invoke).mockReset();
  });

  it("offers and withdraws per CLI and never shows a key", async () => {
    vi.mocked(invoke).mockImplementation((cmd: string) =>
      Promise.resolve(cmd === "agent_logins" ? [login("claude", "ANTHROPIC_API_KEY"), login("codex", null), login("gemini", "GEMINI_API_KEY")] : null),
    );
    const fetch = vi.fn((_url: string, init?: RequestInit) => {
      if (!init?.method) return answer({ keys: [{ cli: "claude", updated: 1, by: "alice", users: ["bob"] }] });
      return answer({ ok: true });
    });
    vi.stubGlobal("fetch", fetch);
    render(<ServerAgentKeys />);
    expect(await screen.findByText("ANTHROPIC_API_KEY")).toBeTruthy();
    expect(screen.getByText("GEMINI_API_KEY")).toBeTruthy();
    expect(screen.queryByText(/Codex/)).toBeNull();
    expect(screen.getByText(/used lately by bob/)).toBeTruthy();
    expect(screen.getByText(/not offered/)).toBeTruthy();

    const gemini = document.getElementById("server-agent-key-gemini") as HTMLInputElement;
    expect(gemini.type).toBe("password");
    fireEvent.change(gemini, { target: { value: "  fake-key-UI0123456789abcdef " } });
    const saves = screen.getAllByRole("button", { name: "Save key" });
    fireEvent.click(saves[1]);
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/gateway/v1/agent-keys/gemini", expect.objectContaining({ method: "PUT", body: JSON.stringify({ key: "fake-key-UI0123456789abcdef" }) })));
    await waitFor(() => expect(gemini.value).toBe(""));
    expect(await screen.findByText("The Google Gemini key is offered.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Withdraw" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/gateway/v1/agent-keys/claude", expect.objectContaining({ method: "DELETE" })));
  });

  it("lists who may use a key, nobody at first, and changes it from the account table", async () => {
    vi.mocked(invoke).mockImplementation((cmd: string) =>
      Promise.resolve(cmd === "agent_logins" ? [login("claude", "ANTHROPIC_API_KEY"), login("gemini", "GEMINI_API_KEY")] : null),
    );
    const fetch = vi.fn((_url: string, init?: RequestInit) => {
      if (!init?.method)
        return answer({
          keys: [
            { cli: "claude", updated: 1, by: "alice", users: [], allowed: ["bob"] },
            { cli: "gemini", updated: 1, by: "alice", users: [], allowed: [] },
          ],
          accounts: ["alice", "bob", "carol"],
        });
      return answer({ ok: true });
    });
    vi.stubGlobal("fetch", fetch);
    render(<ServerAgentKeys />);
    expect(await screen.findByText(/may use it: bob/)).toBeTruthy();
    expect(screen.getByText(/nobody may use it yet/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove bob" }));
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith("/gateway/v1/agent-keys/claude/users", expect.objectContaining({ method: "PUT", body: JSON.stringify({ users: [] }) })),
    );
    expect(await screen.findByText("Who may use the Claude key is saved.")).toBeTruthy();

    // Gemini's picker offers every account; Allow is off until one is picked.
    const pickers = screen.getAllByRole("button", { name: "Choose a user" });
    const allow = screen.getAllByRole("button", { name: "Allow" });
    expect(allow[1].hasAttribute("disabled")).toBe(true);
    fireEvent.click(pickers[1]);
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["alice", "bob", "carol"]);
    fireEvent.click(screen.getByRole("option", { name: "carol" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Allow" })[1]);
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith("/gateway/v1/agent-keys/gemini/users", expect.objectContaining({ method: "PUT", body: JSON.stringify({ users: ["carol"] }) })),
    );
  });

  it("renders nothing for a non-admin and says so when the keeper is down", async () => {
    vi.mocked(invoke).mockImplementation(() => Promise.resolve([login("claude", "ANTHROPIC_API_KEY")]));
    vi.stubGlobal("fetch", vi.fn(() => answer({ error: "admin" }, 403)));
    const { container } = render(<ServerAgentKeys />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(container.textContent).toBe("");
    cleanup();
    vi.stubGlobal("fetch", vi.fn(() => answer({ error: "keeper_unreachable" }, 502)));
    render(<ServerAgentKeys />);
    expect(await screen.findByText(/key keeper does not answer/)).toBeTruthy();
  });
});

describe("Agent logins: the administrator's key per CLI (a user)", () => {
  afterEach(() => {
    cleanup();
    vi.mocked(invoke).mockReset();
  });

  it("offers the switch only where a key is on offer and sends the choice", async () => {
    let rows = [
      login("claude", "ANTHROPIC_API_KEY", { admin_key_offered: true }),
      login("gemini", "GEMINI_API_KEY"),
      login("codex", null, { admin_key_offered: true }),
    ];
    vi.mocked(invoke).mockImplementation((cmd: string, args?: unknown) => {
      if (cmd === "agent_logins") return Promise.resolve(rows);
      if (cmd === "agent_login_use_admin_key") {
        const { id, on } = args as { id: string; on: boolean };
        rows = rows.map((r) => (r.id === id ? { ...r, uses_admin_key: on } : r));
      }
      return Promise.resolve(null);
    });
    render(<AgentLoginsRows />);
    const use = await screen.findAllByRole("button", { name: "Use the administrator's key" });
    expect(use).toHaveLength(1);
    fireEvent.click(use[0]);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("agent_login_use_admin_key", { id: "claude", on: true }));
    expect(await screen.findByText(/runs on the administrator's API key/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Use my own login" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("agent_login_use_admin_key", { id: "claude", on: false }));
  });

  it("names a withdrawn key and offers nothing on the desktop", async () => {
    vi.mocked(invoke).mockImplementation(() => Promise.resolve([login("claude", "ANTHROPIC_API_KEY", { uses_admin_key: true })]));
    render(<AgentLoginsRows />);
    expect(await screen.findByText(/no longer offered to you \(withdrawn, or you were taken off its list\)/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Use my own login" })).toBeTruthy();
    cleanup();
    vi.mocked(invoke).mockImplementation(() => Promise.resolve([login("claude", "ANTHROPIC_API_KEY")]));
    render(<AgentLoginsRows />);
    await screen.findByText(/Claude/);
    expect(screen.queryByRole("button", { name: /administrator/ })).toBeNull();
  });
});
