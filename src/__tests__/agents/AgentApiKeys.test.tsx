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
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(() => Promise.resolve()),
}));

import { AgentApiKeysRows } from "../../components/layout/SettingsSubPanels";
import { useSettingsStore } from "../../stores/settings";
import type { Settings } from "../../types";

const invokeMock = vi.mocked(invoke);
const calls = (cmd: string) => invokeMock.mock.calls.filter(([name]) => name === cmd);

// Placeholder words only: never a real-looking key shape.
const FAKE_KEY = "sk-test-fake-key";

function status(saved: string[], readable = true) {
  return {
    readable,
    providers: ["anthropic", "openai", "gemini", "mistral"].map((id) => ({ id, saved: saved.includes(id) })),
    clis: [
      { id: "claude", enabled: false, providers: ["anthropic"], ready: false },
      { id: "gemini", enabled: false, providers: ["gemini"], ready: false },
      { id: "vibe", enabled: false, providers: ["mistral"], ready: false },
      { id: "opencode", enabled: false, providers: ["anthropic", "openai", "gemini", "mistral"], ready: false },
    ],
  };
}

let saved: string[] = [];
let readable = true;
const updateSettings = vi.fn(async (patch: Partial<Settings>) => {
  useSettingsStore.setState((s) => ({ settings: { ...(s.settings as Settings), ...patch } }));
});

beforeEach(() => {
  saved = [];
  readable = true;
  invokeMock.mockReset();
  invokeMock.mockImplementation((cmd: string, args?: unknown) => {
    if (cmd === "agent_api_keys_status") return Promise.resolve(status(saved, readable));
    if (cmd === "agent_api_key_set") {
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
    // OpenCode takes any of the four.
    expect(screen.getByText(/^Use API key for OpenCode \(Anthropic, OpenAI, Google Gemini, Mistral\)/)).toBeTruthy();

    cleanup();
    saved = ["anthropic"];
    render(<AgentApiKeysRows />);
    await screen.findByText(/^Use API key for Claude/);
    expect(toggle("Claude").disabled).toBe(false);
    expect(toggle("OpenCode").disabled).toBe(false);
    expect(toggle("Mistral").disabled).toBe(true);
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
    expect((await screen.findAllByText(/keyring locked/)).length).toBe(4);
    expect(screen.queryByText(/not saved/)).toBeNull();
    expect(screen.queryByLabelText("Paste the Anthropic API key")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Unlock keyring" }));
    await waitFor(() => expect(calls("keyring_unlock")).toHaveLength(1));
  });
});
