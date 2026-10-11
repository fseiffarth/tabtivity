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

const login = (id: string, capable: boolean, extra: Record<string, unknown> = {}) => ({
  id,
  signed_in: true,
  account: null,
  importable: false,
  blocked: null,
  shared: true,
  admin_key_capable: capable,
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
      Promise.resolve(cmd === "agent_logins" ? [login("claude", true), login("codex", false), login("gemini", true)] : null),
    );
    const fetch = vi.fn((_url: string, init?: RequestInit) => {
      if (!init?.method) return answer({ keys: [{ cli: "claude", updated: 1, by: "alice", users: ["bob"] }] });
      return answer({ ok: true });
    });
    vi.stubGlobal("fetch", fetch);
    render(<ServerAgentKeys />);
    // The CLIs the users' API proxies serve: one row each, no variable shown.
    await waitFor(() => expect(document.getElementById("server-agent-key-claude")).toBeTruthy());
    expect(document.getElementById("server-agent-key-gemini")).toBeTruthy();
    expect(screen.queryByText(/_API_KEY/)).toBeNull();
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
      Promise.resolve(cmd === "agent_logins" ? [login("claude", true), login("gemini", true)] : null),
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

  it("switches a Claude key to the broker, budgets it and renews a user's token (P5)", async () => {
    vi.mocked(invoke).mockImplementation((cmd: string) =>
      Promise.resolve(cmd === "agent_logins" ? [login("claude", true), login("gemini", true)] : null),
    );
    const fetch = vi.fn((_url: string, init?: RequestInit) => {
      if (!init?.method)
        return answer({
          keys: [
            {
              cli: "claude",
              updated: 1,
              by: "alice",
              users: [],
              allowed: ["bob", "carol"],
              broker: true,
              default_budget: 1000,
              budgets: { carol: 50 },
              usage: [{ user: "bob", month: "2026-10", billed: 400, requests: 2 }],
            },
            { cli: "gemini", updated: 1, by: "alice", users: [], allowed: [] },
          ],
          accounts: ["alice", "bob", "carol"],
        });
      return answer({ ok: true });
    });
    vi.stubGlobal("fetch", fetch);
    render(<ServerAgentKeys />);
    // Counts render in the runtime's locale; Testing Library collapses the
    // no-break spaces some locales group digits with, so the expectation does.
    const n = (value: number) => value.toLocaleString().replace(/\s+/g, " ");
    expect(await screen.findByText(`bob: ${n(400)} of ${n(1000)} tokens this month`, { exact: false })).toBeTruthy();
    expect(screen.getByText(/carol: 0 of 50 tokens this month/)).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Deliver directly" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Deliver through the key broker" })).toBeNull();

    fireEvent.change(screen.getByLabelText("Monthly budget per user, in tokens (empty: no cap)"), { target: { value: "2_000" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Save budget" })[0]);
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith("/gateway/v1/agent-keys/claude/budget", expect.objectContaining({ method: "PUT", body: JSON.stringify({ tokens: 2000 }) })),
    );
    fireEvent.change(screen.getByLabelText("carol's monthly budget (empty: the default)"), { target: { value: "lots" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Save budget" })[2]);
    expect(await screen.findByText(/whole number of tokens/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("carol's monthly budget (empty: the default)"), { target: { value: "" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Save budget" })[2]);
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/gateway/v1/agent-keys/claude/budget",
        expect.objectContaining({ body: JSON.stringify({ user: "carol", tokens: null }) }),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Renew bob's token" }));
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith("/gateway/v1/agent-keys/claude/renew-token", expect.objectContaining({ method: "POST", body: JSON.stringify({ user: "bob" }) })),
    );
    fireEvent.click(screen.getByRole("button", { name: "Deliver directly" }));
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith("/gateway/v1/agent-keys/claude/delivery", expect.objectContaining({ method: "PUT", body: JSON.stringify({ broker: false }) })),
    );
  });

  it("renders nothing for a non-admin and says so when the keeper is down", async () => {
    vi.mocked(invoke).mockImplementation(() => Promise.resolve([login("claude", true)]));
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

describe("Agent logins on a server (a user)", () => {
  afterEach(() => {
    cleanup();
    vi.mocked(invoke).mockReset();
  });

  it("says what a CLI runs on; the choice itself is in the API keys section", async () => {
    vi.mocked(invoke).mockImplementation(() =>
      Promise.resolve([login("claude", true, { admin_key_offered: true, uses_admin_key: true }), login("gemini", true, { uses_admin_key: true })]),
    );
    render(<AgentLoginsRows />);
    expect(await screen.findByText(/runs on the administrator's API key/)).toBeTruthy();
    expect(screen.getByText(/no longer offered to you \(withdrawn, or you were taken off its list\)/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /administrator|own login/ })).toBeNull();
  });
});
