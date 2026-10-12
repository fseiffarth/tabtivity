/**
 * Settings → Manage CLIs → API keys (backend `services::agent_api_keys`).
 *
 * What has to hold:
 *
 *  1. **A key goes in and never comes back.** Save hands it to the backend and
 *     clears the field; the page never shows a saved key, only "saved".
 *  2. **One credential per CLI** (#2389): a "runs on" dropdown — its own
 *     login, the user's own key (only once one of its providers has a key;
 *     written through the shared settings, `agent_api_key_clis`), or a hosted
 *     server administrator's key (only where offered; switching to it and
 *     away calls `agent_login_use_admin_key`, the own switch written first).
 *  3. **A locked keyring is said, not hidden.** It reads every key as absent,
 *     so the rows say "locked" and offer the unlock — never "not saved".
 *  4. **No key without a monthly limit** (`services::api_usage`), in billed
 *     tokens (#2389), typed in millions. Save needs a valid limit and writes
 *     it before the key; a saved key's row shows the tokens billed of it and
 *     the dollar estimate, says when the budget is reached (and when the
 *     count restarts), names models priced at the fallback rate, lets the
 *     limit be raised, and shows an older build's dollar limit as a hint.
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
/** Counts render in the runtime's locale (`toLocaleString`, compact
 * notation); build the expected text the same way, so the suite holds under
 * any `LANG`, as a regex fragment. Testing Library collapses whitespace in the
 * page's text, the narrow no-break spaces some locales group digits with
 * included, so the expectation does too. */
const escape = (text: string) => text.replace(/\s+/g, " ").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const count = (n: number) => escape(n.toLocaleString());
const compact = (n: number) =>
  escape(new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n));
const calls = (cmd: string) => invokeMock.mock.calls.filter(([name]) => name === cmd);

// Placeholder words only: never a real-looking key shape.
const FAKE_KEY = "sk-test-fake-key";

type ProviderExtra = {
  limitTokens?: number | null;
  billed?: number;
  spentUsd?: number;
  legacyLimitUsd?: number | null;
  budget?: string;
  unknownModels?: string[];
};
let extra: Record<string, ProviderExtra> = {};

let store: "keychain" | "vault" = "keychain";

function status(saved: string[], readable = true) {
  return {
    readable,
    store,
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
  store = "keychain";
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

const runsOn = (cli: string) => screen.getByRole("button", { name: `${cli} runs on` }) as HTMLButtonElement;
const pick = (cli: string, option: RegExp) => {
  fireEvent.click(runsOn(cli));
  fireEvent.click(screen.getByRole("option", { name: option }));
};

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
    expect(updateSettings).toHaveBeenCalledWith({ agent_api_token_limits: { anthropic: 5_000_000 } });
    expect(order).toEqual(["settings:agent_api_token_limits", "key"]);
    // The row now says "saved", offers Remove, and holds no key anywhere.
    await waitFor(() => expect(screen.queryByLabelText("Paste the Anthropic API key")).toBeNull());
    expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy();
    expect(document.body.innerHTML).not.toContain(FAKE_KEY);
    expect(onChange).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(calls("agent_api_key_clear")).toHaveLength(1));
    expect(calls("agent_api_key_clear")[0][1]).toEqual({ provider: "anthropic" });
  });

  it("offers a CLI its own key only once one of its providers has one", async () => {
    render(<AgentApiKeysRows />);
    await screen.findByRole("button", { name: "Claude runs on" });
    expect(runsOn("Claude").disabled, "only its login to choose").toBe(true);
    expect(runsOn("Claude").textContent).toContain("its own login");
    // Only CLIs the proxy can serve have a row: Vibe and OpenCode do not.
    expect(screen.queryByRole("button", { name: /^(Mistral|OpenCode).* runs on/ })).toBeNull();

    cleanup();
    saved = ["anthropic"];
    render(<AgentApiKeysRows />);
    await screen.findByRole("button", { name: "Claude runs on" });
    expect(runsOn("Claude").disabled).toBe(false);
    expect(runsOn("Google Gemini").disabled).toBe(true);
    pick("Claude", /my API key \(Anthropic\)/);
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ agent_api_key_clis: ["claude"] }));
    expect(runsOn("Claude").textContent).toContain("my API key");
    expect(calls("agent_login_use_admin_key")).toHaveLength(0);
  });

  it("lets a CLI left on its key go back to its login after the key is gone", async () => {
    useSettingsStore.setState({ settings: { agent_api_key_clis: ["claude"] } as Settings });
    render(<AgentApiKeysRows />);
    await screen.findByRole("button", { name: "Claude runs on" });
    expect(runsOn("Claude").disabled).toBe(false);
    pick("Claude", /its own login/);
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ agent_api_key_clis: [] }));
  });

  it("on a server, offers the administrator's key as the third choice, one at a time", async () => {
    saved = ["anthropic"];
    let usesAdmin = false;
    useSettingsStore.setState({ settings: { agent_api_key_clis: ["claude"] } as Settings });
    invokeMock.mockImplementation((cmd: string, args?: unknown) => {
      if (cmd === "agent_api_keys_status") {
        const s = status(saved);
        s.clis[0] = {
          ...s.clis[0],
          ...({ adminOffered: true, usesAdmin, adminBroker: usesAdmin ? { month: "2026-10", billed: 1234, budget: 5000 } : null } as object),
        };
        return Promise.resolve(s);
      }
      if (cmd === "agent_login_use_admin_key") {
        order.push(`admin:${(args as { on: boolean }).on}`);
        usesAdmin = (args as { on: boolean }).on;
      }
      return Promise.resolve(null);
    });
    render(<AgentApiKeysRows />);
    await screen.findByRole("button", { name: "Claude runs on" });
    pick("Claude", /the administrator's API key/);
    // The own key goes off first (the settings store stays true), then the
    // administrator's key on.
    await waitFor(() => expect(order).toEqual(["settings:agent_api_key_clis", "admin:true"]));
    expect(updateSettings).toHaveBeenCalledWith({ agent_api_key_clis: [] });
    expect(await screen.findByText(new RegExp(`key broker: ${count(1234)} of ${count(5000)} tokens this month`))).toBeTruthy();
    order = [];
    pick("Claude", /its own login/);
    await waitFor(() => expect(order).toEqual(["admin:false"]));
  });

  it("names a withdrawn administrator's key and offers none to a CLI without an offer", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd !== "agent_api_keys_status") return Promise.resolve(null);
      const s = status([]);
      s.clis[0] = { ...s.clis[0], ...({ adminOffered: false, usesAdmin: true } as object) };
      return Promise.resolve(s);
    });
    render(<AgentApiKeysRows />);
    expect(await screen.findByText(/no longer offered to you \(withdrawn, or you were taken off its list\)/)).toBeTruthy();
    fireEvent.click(runsOn("Google Gemini"));
    expect(screen.queryByRole("option", { name: /administrator/ })).toBeNull();
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

  it("on a server, says the sealed store is locked and offers no keyring unlock", async () => {
    readable = false;
    store = "vault";
    render(<AgentApiKeysRows />);
    expect((await screen.findAllByText(/sign in on a paired device to unlock the key/)).length).toBe(2);
    expect(screen.queryByText(/keyring locked/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Unlock keyring" })).toBeNull();
    expect(screen.queryByLabelText("Paste the Anthropic API key")).toBeNull();
  });

  it("needs a valid monthly limit before a key can be saved", async () => {
    useSettingsStore.setState({ settings: { agent_api_token_limits: { gemini: 5_000_000 } } as Settings });
    render(<AgentApiKeysRows />);
    const key = await screen.findByLabelText<HTMLInputElement>("Paste the Anthropic API key");
    const limit = screen.getByLabelText<HTMLInputElement>("Monthly limit for Anthropic, million billed tokens");
    expect(limit.value).toBe("5");
    fireEvent.change(key, { target: { value: FAKE_KEY } });
    const save = screen.getAllByRole("button", { name: "Save" })[0] as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    // Past the backend's cap (10^12 tokens) is as bad as nothing.
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
    expect(updateSettings).toHaveBeenCalledWith({ agent_api_token_limits: { gemini: 5_000_000, anthropic: 35_000_000 } });
    expect(order).toEqual(["settings:agent_api_token_limits", "key"]);
  });

  it("shows the month's billed tokens, the budget reached and models priced at the top rate", async () => {
    saved = ["anthropic", "gemini"];
    extra = {
      anthropic: { limitTokens: 20_000_000, billed: 20_500_000, spentUsd: 20.5, budget: "reached", unknownModels: ["claude-next"] },
      gemini: { limitTokens: 10_000_000, billed: 1_234_000, spentUsd: 1.234, budget: "open", unknownModels: [] },
    };
    useSettingsStore.setState({
      settings: { agent_api_token_limits: { anthropic: 20_000_000, gemini: 10_000_000 } } as Settings,
    });
    render(<AgentApiKeysRows />);
    expect(
      await screen.findByText(
        new RegExp(
          `budget reached \\(${compact(20_500_000)} of ${compact(20_000_000)} billed tokens\\) — ` +
            "new requests are refused until 2026-11-01 or a higher limit",
        ),
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(new RegExp(`${compact(1_234_000)} of ${compact(10_000_000)} billed tokens this month \\(≈ \\$1\\.23\\)`)),
    ).toBeTruthy();
    expect(screen.getByText(/highest Anthropic rate: claude-next/)).toBeTruthy();
    expect(screen.getByText(/resets on 2026-11-01 \(UTC\)/)).toBeTruthy();
    expect(screen.getByText(/prices dated 2026-10-04/)).toBeTruthy();
    // Raise it: the saved row offers the limit, unchanged until edited.
    const limit = screen.getByLabelText<HTMLInputElement>("Monthly limit for Anthropic, million billed tokens");
    expect(limit.value).toBe("20");
    const set = screen.getAllByRole("button", { name: "Set limit" })[0] as HTMLButtonElement;
    expect(set.disabled).toBe(true);
    fireEvent.change(limit, { target: { value: "50" } });
    expect(set.disabled).toBe(false);
    fireEvent.click(set);
    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({
        agent_api_token_limits: { anthropic: 50_000_000, gemini: 10_000_000 },
      }),
    );
    expect(calls("agent_api_key_set")).toHaveLength(0);
  });

  it("says a key saved without a token limit is refused until one is set, naming an old dollar limit", async () => {
    saved = ["anthropic"];
    extra = {
      anthropic: { limitTokens: null, billed: 0, spentUsd: 0, legacyLimitUsd: 20, budget: "noLimit", unknownModels: [] },
    };
    useSettingsStore.setState({ settings: { agent_api_limits: { anthropic: 20 } } as Settings });
    render(<AgentApiKeysRows />);
    expect(await screen.findByText(/no monthly limit — requests are refused until you set one/)).toBeTruthy();
    expect(screen.getByText(/your earlier limit was \$20\.00 a month/)).toBeTruthy();
    const limit = screen.getByLabelText<HTMLInputElement>("Monthly limit for Anthropic, million billed tokens");
    expect(limit.value).toBe("5");
    fireEvent.click(screen.getAllByRole("button", { name: "Set limit" })[0]);
    // The dollar map stays as it was; the token one is written.
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ agent_api_token_limits: { anthropic: 5_000_000 } }));
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
