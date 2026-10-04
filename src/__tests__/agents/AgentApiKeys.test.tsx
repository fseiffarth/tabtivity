/**
 * Settings → Manage CLIs → API keys (backend `services::agent_api_keys`).
 *
 * What has to hold:
 *
 *  1. **A key goes in and never comes back.** Save hands it to the backend and
 *     clears the field; the page never shows a saved key, only "saved".
 *  2. **A CLI is switched on only where it can start on a key.** Its switch is
 *     off until one of its providers has a key, and writes through the shared
 *     settings (`agent_api_key_clis`).
 *  3. **A locked keyring is said, not hidden.** It reads every key as absent,
 *     so the rows say "locked" and offer the unlock — never "not saved".
 *  4. **No key without a monthly limit** (`services::api_usage`). Save needs
 *     a valid limit and writes it before the key; a saved key's row shows
 *     what was spent of it, says when the budget is reached (and when the
 *     count restarts), names models priced at the fallback rate, and lets the
 *     limit be raised.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(() => Promise.resolve()),
}));

import { AgentApiKeysRows, AgentLoginsRows } from "../../components/layout/SettingsSubPanels";
import { useSettingsStore } from "../../stores/settings";
import type { Settings } from "../../types";

const invokeMock = vi.mocked(invoke);
const calls = (cmd: string) => invokeMock.mock.calls.filter(([name]) => name === cmd);

// Placeholder words only: never a real-looking key shape.
const FAKE_KEY = "sk-test-fake-key";

type ProviderExtra = { limitUsd?: number | null; spentUsd?: number; budget?: string; unknownModels?: string[] };
let extra: Record<string, ProviderExtra> = {};

function status(saved: string[], readable = true) {
  return {
    readable,
    month: "2026-10",
    resetsOn: "2026-11-01",
    pricesDate: "2026-10-04",
    ledgerRestarted: null,
    providers: ["anthropic", "gemini"].map((id) => ({ id, saved: saved.includes(id), ...extra[id] })),
    clis: [
      { id: "claude", enabled: false, providers: ["anthropic"], ready: false },
      { id: "gemini", enabled: false, providers: ["gemini"], ready: false },
    ],
  };
}

let saved: string[] = [];
let readable = true;
/** Settings writes and key saves, in the order they happened. */
let order: string[] = [];
const updateSettings = vi.fn(async (patch: Partial<Settings>) => {
  order.push(`settings:${Object.keys(patch).join(",")}`);
  useSettingsStore.setState((s) => ({ settings: { ...(s.settings as Settings), ...patch } }));
});

beforeEach(() => {
  saved = [];
  readable = true;
  extra = {};
  order = [];
  invokeMock.mockReset();
  invokeMock.mockImplementation((cmd: string, args?: unknown) => {
    if (cmd === "agent_api_keys_status") return Promise.resolve(status(saved, readable));
    if (cmd === "agent_api_key_set") {
      order.push("key");
      saved = [...saved, (args as { provider: string }).provider];
      return Promise.resolve(null);
    }
    if (cmd === "agent_api_key_clear") {
      saved = saved.filter((p) => p !== (args as { provider: string }).provider);
      return Promise.resolve(null);
    }
    return Promise.resolve(null);
  });
  updateSettings.mockClear();
  useSettingsStore.setState({ settings: {} as Settings, updateSettings });
});

afterEach(cleanup);

const toggle = (cli: string) =>
  screen.getByText(new RegExp(`^Use API key for ${cli} `)).closest("label")!.querySelector("input")!;

describe("API keys for agent CLIs", () => {
  it("saves a key, clears the field and never reads it back", async () => {
    const onChange = vi.fn();
    render(<AgentApiKeysRows onChange={onChange} />);
    const input = await screen.findByLabelText<HTMLInputElement>("Paste the Anthropic API key");
    fireEvent.change(input, { target: { value: ` ${FAKE_KEY} ` } });
    expect(input.value).toBe(` ${FAKE_KEY} `);
    fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0]);
    // Cleared at once, saved or not.
    expect(input.value).toBe("");
    await waitFor(() => expect(calls("agent_api_key_set")).toHaveLength(1));
    expect(calls("agent_api_key_set")[0][1]).toEqual({ provider: "anthropic", key: FAKE_KEY });
    // The proposed monthly limit went in first.
    expect(updateSettings).toHaveBeenCalledWith({ agent_api_limits: { anthropic: 20 } });
    expect(order).toEqual(["settings:agent_api_limits", "key"]);
    // The row now says "saved", offers Remove, and holds no key anywhere.
    await waitFor(() => expect(screen.queryByLabelText("Paste the Anthropic API key")).toBeNull());
    expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy();
    expect(document.body.innerHTML).not.toContain(FAKE_KEY);
    expect(onChange).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(calls("agent_api_key_clear")).toHaveLength(1));
    expect(calls("agent_api_key_clear")[0][1]).toEqual({ provider: "anthropic" });
  });

  it("keeps a CLI's switch off until one of its providers has a key", async () => {
    render(<AgentApiKeysRows />);
    await screen.findByText(/^Use API key for Claude/);
    expect(toggle("Claude").disabled).toBe(true);
    expect(screen.getByText(/^Use API key for Claude \(Anthropic\)/)).toBeTruthy();
    // Only CLIs the proxy can serve have a switch: Vibe and OpenCode do not.
    expect(screen.queryByText(/^Use API key for (Mistral|OpenCode)/)).toBeNull();

    cleanup();
    saved = ["anthropic"];
    render(<AgentApiKeysRows />);
    await screen.findByText(/^Use API key for Claude/);
    expect(toggle("Claude").disabled).toBe(false);
    expect(toggle("Google Gemini").disabled).toBe(true);
    fireEvent.click(toggle("Claude"));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ agent_api_key_clis: ["claude"] }));
    expect(toggle("Claude").checked).toBe(true);
  });

  it("lets a switch left on be turned off after its key is gone", async () => {
    useSettingsStore.setState({ settings: { agent_api_key_clis: ["claude"] } as Settings });
    render(<AgentApiKeysRows />);
    await screen.findByText(/^Use API key for Claude/);
    expect(toggle("Claude").checked).toBe(true);
    expect(toggle("Claude").disabled).toBe(false);
    fireEvent.click(toggle("Claude"));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ agent_api_key_clis: [] }));
  });

  it("says the keyring is locked and offers the unlock instead of a key field", async () => {
    readable = false;
    render(<AgentApiKeysRows />);
    expect((await screen.findAllByText(/keyring locked/)).length).toBe(2);
    expect(screen.queryByText(/not saved/)).toBeNull();
    expect(screen.queryByLabelText("Paste the Anthropic API key")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Unlock keyring" }));
    await waitFor(() => expect(calls("keyring_unlock")).toHaveLength(1));
  });

  it("needs a valid monthly limit before a key can be saved", async () => {
    useSettingsStore.setState({ settings: { agent_api_limits: { gemini: 5 } } as Settings });
    render(<AgentApiKeysRows />);
    const key = await screen.findByLabelText<HTMLInputElement>("Paste the Anthropic API key");
    const limit = screen.getByLabelText<HTMLInputElement>("Monthly limit for Anthropic, US dollars");
    expect(limit.value).toBe("20");
    fireEvent.change(key, { target: { value: FAKE_KEY } });
    const save = screen.getAllByRole("button", { name: "Save" })[0] as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    for (const bad of ["", "0", "-5", "abc", "2000000"]) {
      fireEvent.change(limit, { target: { value: bad } });
      expect(save.disabled, bad).toBe(true);
    }
    // Enter does nothing either.
    fireEvent.keyDown(key, { key: "Enter" });
    expect(calls("agent_api_key_set")).toHaveLength(0);
    fireEvent.change(limit, { target: { value: "35" } });
    fireEvent.click(save);
    await waitFor(() => expect(calls("agent_api_key_set")).toHaveLength(1));
    // Merged with the other provider's limit, written before the key.
    expect(updateSettings).toHaveBeenCalledWith({ agent_api_limits: { gemini: 5, anthropic: 35 } });
    expect(order).toEqual(["settings:agent_api_limits", "key"]);
  });

  it("shows the month's spending, the budget reached and models priced at the top rate", async () => {
    saved = ["anthropic", "gemini"];
    extra = {
      anthropic: { limitUsd: 20, spentUsd: 20.5, budget: "reached", unknownModels: ["claude-next"] },
      gemini: { limitUsd: 10, spentUsd: 1.234, budget: "open", unknownModels: [] },
    };
    useSettingsStore.setState({ settings: { agent_api_limits: { anthropic: 20, gemini: 10 } } as Settings });
    render(<AgentApiKeysRows />);
    expect(
      await screen.findByText(/budget reached \(\$20\.50 of \$20\.00\) — new requests are refused until 2026-11-01 or a higher limit/),
    ).toBeTruthy();
    expect(screen.getByText(/\$1\.23 of \$10\.00 spent this month/)).toBeTruthy();
    expect(screen.getByText(/highest Anthropic rate: claude-next/)).toBeTruthy();
    expect(screen.getByText(/starts again on 2026-11-01 \(UTC\)/)).toBeTruthy();
    expect(screen.getByText(/price table dated 2026-10-04/)).toBeTruthy();
    // Raise it: the saved row offers the limit, unchanged until edited.
    const limit = screen.getByLabelText<HTMLInputElement>("Monthly limit for Anthropic, US dollars");
    expect(limit.value).toBe("20");
    const set = screen.getAllByRole("button", { name: "Set limit" })[0] as HTMLButtonElement;
    expect(set.disabled).toBe(true);
    fireEvent.change(limit, { target: { value: "50" } });
    expect(set.disabled).toBe(false);
    fireEvent.click(set);
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ agent_api_limits: { anthropic: 50, gemini: 10 } }));
    expect(calls("agent_api_key_set")).toHaveLength(0);
  });

  it("says a key saved without a limit is refused until one is set", async () => {
    saved = ["anthropic"];
    extra = { anthropic: { limitUsd: null, spentUsd: 0, budget: "noLimit", unknownModels: [] } };
    render(<AgentApiKeysRows />);
    expect(await screen.findByText(/no monthly limit — requests are refused until you set one/)).toBeTruthy();
    const limit = screen.getByLabelText<HTMLInputElement>("Monthly limit for Anthropic, US dollars");
    expect(limit.value).toBe("20");
    fireEvent.click(screen.getAllByRole("button", { name: "Set limit" })[0]);
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ agent_api_limits: { anthropic: 20 } }));
  });

  it("says in the shared-logins row when a keyed CLI is out of budget", async () => {
    const login = { signed_in: false, account: null, importable: false, blocked: null, shared: true, api_key: true };
    invokeMock.mockImplementation((cmd: string) =>
      Promise.resolve(
        cmd === "agent_logins"
          ? [
              { id: "claude", ...login, api_budget_reached: true },
              { id: "gemini", ...login, api_budget_reached: false },
            ]
          : null,
      ),
    );
    render(<AgentLoginsRows />);
    expect(await screen.findByText(/API budget reached/)).toBeTruthy();
    expect(screen.getAllByText(/uses API key/)).toHaveLength(1);
  });
});
