/**
 * The assistant's settings (S4b): the page's default CLI/model and search
 * backend (round-tripping `Settings.assistant_settings`, the key write-only),
 * the page's presence in the navigation, and the phone switch in the Mobile
 * section (`tabtivity_mobile_host.assistant_access`, default on).
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(), emit: vi.fn() }));

import { AssistantSettings } from "../../components/assistant/AssistantSettings";
import { MobileSettings } from "../../components/mobile/MobileSettings";
import { SettingsDialog } from "../../components/layout/SettingsPanel";
import { useBoxesStore } from "../../stores/boxes";
import { useProjectsStore } from "../../stores/projects";
import { SETTINGS_CHANGED_EVENT, useSettingsStore } from "../../stores/settings";
import type { Settings } from "../../types";
import { BRAND, MOBILE_HOST_KEY } from "../../lib/brand";

type Host = NonNullable<Settings[typeof MOBILE_HOST_KEY]>;

const SEARCH_OFF = { kind: null, searxngUrl: null, ollamaKeyStored: false, keyring: "unlocked", configured: false };
const OPTIONS = {
  clis: [
    { id: "claude", label: "Claude", local: false, installed: true, signedIn: true, ready: true },
    { id: "opencode_local", label: "OpenCode (local model)", local: true, installed: true, signedIn: null, ready: true },
  ],
  localModels: ["qwen3:8b"],
  ollamaReachable: true,
  defaultCli: "claude",
  defaultModel: null,
  search: SEARCH_OFF,
};

let searchAnswer: (args: Record<string, unknown>) => unknown;
let options: Record<string, unknown>;

function setSettings(settings: Partial<Settings>) {
  useSettingsStore.setState({ settings: { assistant: true, experimental_explicit: true, ...settings } as Settings, loaded: true });
}

beforeEach(() => {
  options = { ...OPTIONS };
  searchAnswer = (args) => ({
    search: { ...SEARCH_OFF, kind: args.kind === "none" ? null : args.kind, searxngUrl: args.url ?? null, configured: args.kind !== "none" },
    settings: { assistant: true, assistant_settings: { search: { kind: args.kind, searxng_url: args.url } } },
  });
  vi.mocked(invoke).mockImplementation((command: string, args?: unknown) => {
    switch (command) {
      case "assistant_options":
        return Promise.resolve(options);
      case "assistant_set_search":
        return Promise.resolve().then(() => searchAnswer(args as Record<string, unknown>));
      case "patch_settings": {
        const { patch } = args as { patch: Partial<Settings> };
        return Promise.resolve({ ...useSettingsStore.getState().settings, ...patch });
      }
      case "mobile_host_status":
        return Promise.resolve({ configured: true, running: false, update_available: false });
      case "mobile_tailscale_serve_status":
        return Promise.resolve({ installed: false });
      case "mobile_admin":
        return Promise.resolve({ status: "devices", devices: [] });
      default:
        return Promise.resolve(undefined);
    }
  });
  vi.mocked(listen).mockResolvedValue(() => {});
  vi.mocked(emit).mockResolvedValue(undefined);
  useProjectsStore.setState({ projects: [], activeId: null, loaded: true });
  useBoxesStore.setState({ boxes: [], loaded: true });
});

afterEach(() => {
  cleanup();
  vi.mocked(invoke).mockReset();
  useSettingsStore.setState({ settings: null, loaded: false });
});

const patches = () =>
  vi.mocked(invoke).mock.calls.filter(([c]) => c === "patch_settings").map(([, a]) => (a as { patch: Settings }).patch);
const setSearchCalls = () => vi.mocked(invoke).mock.calls.filter(([c]) => c === "assistant_set_search").map(([, a]) => a);

describe("the assistant's settings page", () => {
  it("says how to turn the assistant on while its switch is off, and reads nothing", async () => {
    setSettings({ assistant: false });
    render(<AssistantSettings />);
    expect(screen.getByText(/Turn on Tabby under Experimental/)).toBeTruthy();
    expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === "assistant_options")).toEqual([]);
  });

  it("stores the default CLI and model in assistant_settings, keeping the rest of the block", async () => {
    setSettings({ assistant_settings: { search: { kind: "searxng", searxng_url: "https://s.example" } } });
    render(<AssistantSettings />);
    await screen.findByRole("button", { name: "Default CLI" });
    fireEvent.click(screen.getByRole("button", { name: "Default CLI" }));
    fireEvent.click(await screen.findByRole("option", { name: "OpenCode (local model)" }));
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0].assistant_settings).toEqual({
      default_cli: "opencode_local",
      search: { kind: "searxng", searxng_url: "https://s.example" },
    });
    // The model row appears for a local CLI.
    fireEvent.click(await screen.findByRole("button", { name: "Default model" }));
    fireEvent.click(screen.getByRole("option", { name: "qwen3:8b" }));
    await waitFor(() => expect(patches()).toHaveLength(2));
    expect(patches()[1].assistant_settings).toMatchObject({ default_cli: "opencode_local", default_model: "qwen3:8b" });
    // Back to "first available" drops the key rather than storing an empty one.
    fireEvent.click(screen.getByRole("button", { name: "Default CLI" }));
    fireEvent.click(screen.getByRole("option", { name: "First available" }));
    await waitFor(() => expect(patches()).toHaveLength(3));
    expect(patches()[2].assistant_settings).not.toHaveProperty("default_cli");
  });

  it("saves a SearXNG address and broadcasts the settings the backend returns", async () => {
    setSettings({});
    render(<AssistantSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Search service" }));
    fireEvent.click(screen.getByRole("option", { name: "SearXNG" }));
    fireEvent.change(screen.getByLabelText("SearXNG address"), { target: { value: " https://s.example " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(setSearchCalls()).toHaveLength(1));
    expect(setSearchCalls()[0]).toEqual({ kind: "searxng", url: "https://s.example", key: null });
    await waitFor(() => expect(emit).toHaveBeenCalledWith(SETTINGS_CHANGED_EVENT, expect.objectContaining({ assistant: true })));
    expect(useSettingsStore.getState().settings?.assistant_settings?.search?.kind).toBe("searxng");
    expect(await screen.findByText("Saved.")).toBeTruthy();
  });

  it("keeps the Ollama key write-only: sent once, cleared from the field, never filled back", async () => {
    setSettings({});
    const view = render(<AssistantSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Search service" }));
    fireEvent.click(screen.getByRole("option", { name: "Ollama web search" }));
    const field = screen.getByLabelText("Ollama API key") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "sk-secret-123" } });
    expect(field.type).toBe("password");
    searchAnswer = () => ({
      search: { ...SEARCH_OFF, kind: "ollama", ollamaKeyStored: true, configured: true },
      settings: { assistant: true, assistant_settings: { search: { kind: "ollama" } } },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(setSearchCalls()).toHaveLength(1));
    expect(setSearchCalls()[0]).toEqual({ kind: "ollama", url: null, key: "sk-secret-123" });
    await screen.findByText("Saved.");
    expect((screen.getByLabelText("Ollama API key") as HTMLInputElement).value).toBe("");
    expect(view.container.innerHTML).not.toContain("sk-secret-123");
    // Nothing of the key reached the settings the store holds.
    expect(JSON.stringify(useSettingsStore.getState().settings)).not.toContain("sk-secret-123");
  });

  it("shows a stored key only as a placeholder, saves without resending it, and removes it on request", async () => {
    options = { ...OPTIONS, search: { ...SEARCH_OFF, kind: "ollama", ollamaKeyStored: true, configured: true } };
    setSettings({ assistant_settings: { search: { kind: "ollama" } } });
    render(<AssistantSettings />);
    const field = (await screen.findByLabelText("Ollama API key")) as HTMLInputElement;
    expect(field.value).toBe("");
    expect(field.placeholder).toContain("A key is stored");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(setSearchCalls()).toHaveLength(1));
    expect(setSearchCalls()[0]).toEqual({ kind: "ollama", url: null, key: null });
    searchAnswer = () => ({ search: SEARCH_OFF, settings: { assistant: true } });
    fireEvent.click(screen.getByRole("button", { name: "Remove the stored key" }));
    await waitFor(() => expect(setSearchCalls()).toHaveLength(2));
    // An Ollama choice without a key is refused by the backend, so it falls to none.
    expect(setSearchCalls()[1]).toEqual({ kind: "none", url: null, key: "" });
  });

  it("explains a refused address in words", async () => {
    setSettings({});
    vi.mocked(invoke).mockImplementation((command: string) =>
      command === "assistant_options"
        ? Promise.resolve(options)
        : command === "assistant_set_search"
          ? Promise.reject("invalid_url: nope")
          : Promise.resolve(undefined),
    );
    render(<AssistantSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Search service" }));
    fireEvent.click(screen.getByRole("option", { name: "SearXNG" }));
    fireEvent.change(screen.getByLabelText("SearXNG address"), { target: { value: "ftp://x" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toContain("isn't a valid address");
  });
});

describe("the settings navigation", () => {
  it("lists the assistant's page only while the experimental switch is on", async () => {
    setSettings({ assistant: false });
    const view = render(<SettingsDialog onClose={() => {}} />);
    await act(async () => {});
    const labels = () => Array.from(view.container.querySelectorAll(".settings-navigation-links button")).map((b) => b.textContent);
    expect(labels().some((l) => l?.includes("Tabby"))).toBe(false);
    await act(async () => setSettings({ assistant: true }));
    expect(labels().some((l) => l?.includes("Tabby"))).toBe(true);
  });
});

describe("the phone switch in the Mobile section", () => {
  const host = (extra: Partial<Host> = {}, flag = true) =>
    setSettings({
      assistant: flag,
      [MOBILE_HOST_KEY]: { enabled: true, display_name: "Desk", port: 8742, serve_origin: "https://desk.example.ts.net", ...extra },
    } as Partial<Settings>);
  const toggle = async () => screen.findByRole("checkbox", { name: /Tabby from the phone/ }) as Promise<HTMLInputElement>;
  const hostWrites = () => patches().map((p) => p[MOBILE_HOST_KEY] as Partial<Host>);

  it("is on while unset, stores only false, and clears the key when turned back on", async () => {
    host();
    const user = userEvent.setup();
    render(<MobileSettings />);
    expect((await toggle()).checked).toBe(true);
    await user.click(await toggle());
    await waitFor(() => expect(hostWrites()).toHaveLength(1));
    expect(hostWrites()[0]).toMatchObject({ enabled: true, assistant_access: false });
    await waitFor(async () => expect((await toggle()).checked).toBe(false));
    await user.click(await toggle());
    await waitFor(() => expect(hostWrites()).toHaveLength(2));
    expect(JSON.parse(JSON.stringify(hostWrites()[1]))).not.toHaveProperty("assistant_access");
  });

  it("is absent while the experimental switch is off", async () => {
    host({}, false);
    render(<MobileSettings />);
    await screen.findByRole("checkbox", { name: /Local models from the phone/ });
    expect(screen.queryByRole("checkbox", { name: /Tabby from the phone/ })).toBeNull();
  });

  it("survives switching the host off", async () => {
    host({ assistant_access: false });
    const user = userEvent.setup();
    render(<MobileSettings />);
    expect((await toggle()).checked).toBe(false);
    await user.click(await screen.findByRole("checkbox", { name: `${BRAND.display} Mobile` }));
    await waitFor(() => expect(hostWrites()).toHaveLength(1));
    expect(hostWrites()[0]).toMatchObject({ enabled: false, assistant_access: false });
  });
});
