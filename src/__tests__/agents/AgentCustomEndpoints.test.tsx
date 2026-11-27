/**
 * Settings → Manage CLIs → API keys → Custom endpoints (backend
 * `services::agent_api_keys`, commands `agent_api_custom_endpoint_*`).
 *
 * What has to hold:
 *
 *  1. **A slot shows what it is**: its label, host, model count, "no price"
 *     instead of a dollar figure, and this month's billed tokens against the
 *     limit — and it is not also listed as a built-in provider.
 *  2. **A slot with no models is flagged** (a missing `/v1` looks the same).
 *  3. **Add sends camelCase keys** and clears the key field at once; it needs
 *     a name, base URL, key and a valid limit.
 *  4. **Remove asks first**; Refresh models calls its command with the slot.
 *  5. **CLI rows name a custom endpoint by its label**, never `custom-<n>`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(() => Promise.resolve()),
}));

import { AgentApiKeysRows } from "../../components/settings/AgentApiKeysRows";
import { useSettingsStore } from "../../stores/settings";
import type { Settings } from "../../types";

const invokeMock = vi.mocked(invoke);
const calls = (cmd: string) => invokeMock.mock.calls.filter(([name]) => name === cmd);
const FAKE_KEY = "sk-test-fake-key";

let modelCount = 3;
let store: "keychain" | "vault" = "keychain";

function status() {
  return {
    readable: true,
    store,
    month: "2026-11",
    resetsOn: "2026-12-01",
    pricesDate: "2026-11-01",
    ledgerRestarted: null,
    providers: [
      ...["anthropic", "gemini", "openai"].map((id) => ({ id, saved: false })),
      {
        id: "custom-2",
        saved: true,
        limitTokens: 5_000_000,
        billed: 1_200_000,
        spentUsd: 0,
        priced: false,
        budget: "open",
        unknownModels: [],
        models: [
          { model: "llama-3.3-70b", input: 900_000, output: 300_000, cacheWrite: 0, cacheRead: 0, requests: 4, billed: 1_200_000, usd: 0 },
        ],
        endpoint: { slot: 2, label: "Institute API", baseUrl: "https://llm.example.org/v1", host: "llm.example.org", modelCount },
      },
    ],
    clis: [
      { id: "claude", enabled: false, providers: ["anthropic"], ready: false },
      { id: "gemini", enabled: false, providers: ["gemini"], ready: false },
      { id: "codex", enabled: false, providers: ["openai"], ready: false },
      { id: "opencode", enabled: false, providers: ["anthropic", "gemini", "openai", "custom-2"], ready: true },
    ],
  };
}

const updateSettings = vi.fn(async (patch: Partial<Settings>) => {
  useSettingsStore.setState((s) => ({ settings: { ...(s.settings as Settings), ...patch } }));
});

beforeEach(() => {
  modelCount = 3;
  store = "keychain";
  invokeMock.mockReset();
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "agent_api_keys_status") return Promise.resolve(status());
    return Promise.resolve(null);
  });
  updateSettings.mockClear();
  useSettingsStore.setState({ settings: { agent_api_token_limits: { "custom-2": 5_000_000 } } as Settings, updateSettings });
});

afterEach(cleanup);

/** The slot's row: the `.agents-row` that names it. */
const slotRow = async () => {
  const name = await screen.findByText("Institute API");
  return name.closest(".agents-row") as HTMLElement;
};

describe("custom endpoints in the API keys panel", () => {
  it("shows a slot with its label, host, models, no price and billed tokens", async () => {
    render(<AgentApiKeysRows />);
    const row = await slotRow();
    expect(within(row).getByText("llm.example.org")).toBeTruthy();
    expect(within(row).getByText("Models: 3")).toBeTruthy();
    expect(within(row).getByText("no price")).toBeTruthy();
    expect(row.textContent).toMatch(/1\.2M of 5M billed tokens this month/);
    expect(row.textContent).not.toMatch(/\$/);
    // The per-model line, without a dollar estimate.
    expect(screen.getByText(/llama-3\.3-70b: .* in · .* out$/)).toBeTruthy();
    // Not listed twice, as a built-in provider row with the raw id.
    expect(screen.queryByText("custom-2")).toBeNull();
    // No warning while it lists models.
    expect(screen.queryByText(/answered with no model list/)).toBeNull();
  });

  it("warns when the endpoint listed no models", async () => {
    modelCount = 0;
    render(<AgentApiKeysRows />);
    await slotRow();
    expect(screen.getByText(/llm\.example\.org answered with no model list/)).toBeTruthy();
  });

  it("names the endpoint by its label in the OpenCode row", async () => {
    render(<AgentApiKeysRows />);
    await slotRow();
    fireEvent.click(screen.getByRole("button", { name: "OpenCode runs on" }));
    expect(screen.getByRole("option", { name: "my API key (Institute API)" })).toBeTruthy();
  });

  it("adds an endpoint with camelCase keys and clears the key at once", async () => {
    render(<AgentApiKeysRows />);
    await slotRow();
    const add = screen.getByRole("button", { name: "Add endpoint" }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Name (shown in /model)"), { target: { value: "Lab gateway" } });
    fireEvent.change(screen.getByLabelText("Base URL of the endpoint"), { target: { value: "https://gw.example.org/v1" } });
    const key = screen.getByLabelText<HTMLInputElement>("Paste the endpoint's API key");
    fireEvent.change(key, { target: { value: FAKE_KEY } });
    expect(add.disabled).toBe(false);
    fireEvent.click(add);
    expect(key.value).toBe("");
    await waitFor(() => expect(calls("agent_api_custom_endpoint_add")).toHaveLength(1));
    expect(calls("agent_api_custom_endpoint_add")[0]?.[1]).toEqual({
      label: "Lab gateway",
      baseUrl: "https://gw.example.org/v1",
      key: FAKE_KEY,
      limitTokens: 5_000_000,
    });
    // The limit is written by the command itself, not by a settings patch first.
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("keeps Add off without a usable limit", async () => {
    render(<AgentApiKeysRows />);
    await slotRow();
    fireEvent.change(screen.getByLabelText("Name (shown in /model)"), { target: { value: "Lab gateway" } });
    fireEvent.change(screen.getByLabelText("Base URL of the endpoint"), { target: { value: "https://gw.example.org/v1" } });
    fireEvent.change(screen.getByLabelText("Paste the endpoint's API key"), { target: { value: FAKE_KEY } });
    const limit = screen.getAllByLabelText<HTMLInputElement>(/Monthly limit for/).slice(-1)[0]!;
    fireEvent.change(limit, { target: { value: "0" } });
    expect((screen.getByRole("button", { name: "Add endpoint" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("asks before removing, and removes only on yes", async () => {
    render(<AgentApiKeysRows />);
    const row = await slotRow();
    fireEvent.click(within(row).getByRole("button", { name: "Remove" }));
    await screen.findByText("Remove Institute API?");
    expect(calls("agent_api_custom_endpoint_remove")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByText("Remove Institute API?")).toBeNull());
    expect(calls("agent_api_custom_endpoint_remove")).toHaveLength(0);

    fireEvent.click(within(row).getByRole("button", { name: "Remove" }));
    await screen.findByText("Remove Institute API?");
    // The dialog's confirm comes after the row's own Remove in the page.
    const confirm = screen.getAllByRole("button", { name: "Remove" }).slice(-1)[0]!;
    expect(row.contains(confirm)).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(calls("agent_api_custom_endpoint_remove")).toHaveLength(1));
    expect(calls("agent_api_custom_endpoint_remove")[0]?.[1]).toEqual({ slot: 2 });
  });

  it("refreshes the model list for its slot", async () => {
    render(<AgentApiKeysRows />);
    const row = await slotRow();
    fireEvent.click(within(row).getByRole("button", { name: "Refresh models" }));
    await waitFor(() => expect(calls("agent_api_custom_endpoint_refresh_models")).toHaveLength(1));
    expect(calls("agent_api_custom_endpoint_refresh_models")[0]?.[1]).toEqual({ slot: 2 });
  });

  it("raises the limit through the settings, not a command", async () => {
    render(<AgentApiKeysRows />);
    const row = await slotRow();
    fireEvent.change(within(row).getByLabelText(/Monthly limit for Institute API/), { target: { value: "8" } });
    fireEvent.click(within(row).getByRole("button", { name: "Set limit" }));
    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({ agent_api_token_limits: { "custom-2": 8_000_000 } }),
    );
  });

  it("writes a limit over the file's limits, not the window's cached copy", async () => {
    // Another endpoint was added after this window loaded its settings: the
    // add command wrote its limit in the backend, and the cache lacks it.
    const onDisk = { "custom-2": 5_000_000, "custom-3": 7_000_000 };
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "agent_api_keys_status") return Promise.resolve(status());
      if (cmd === "get_settings") return Promise.resolve({ agent_api_token_limits: onDisk });
      return Promise.resolve(null);
    });
    render(<AgentApiKeysRows />);
    const row = await slotRow();
    fireEvent.change(within(row).getByLabelText(/Monthly limit for Institute API/), { target: { value: "8" } });
    fireEvent.click(within(row).getByRole("button", { name: "Set limit" }));
    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({
        agent_api_token_limits: { "custom-2": 8_000_000, "custom-3": 7_000_000 },
      }),
    );
  });

  it("is not offered on a hosted server's vault", async () => {
    store = "vault";
    render(<AgentApiKeysRows />);
    await screen.findByText("API keys");
    expect(screen.queryByText("Custom endpoints")).toBeNull();
  });
});
