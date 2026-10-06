/**
 * Local models from the phone (#31by), desktop half: the bridge answers the
 * sidecar's `local_models` / `local_model_mutate` from the Tauri Ollama
 * commands. It lists, loads, unloads and starts — and never so much as names a
 * download, delete or the waiting `load_ollama_model`, whatever it is asked.
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(), emit: vi.fn() }));

import { MobileBridgeHost, mutationDomain } from "../../components/mobile/MobileBridgeHost";
import { __resetMobileLocalModelsForTests, isListedModel } from "../../lib/mobileLocalModels";
import { __resetOllamaActivityForTests, useOllamaActivityStore } from "../../stores/agents/ollamaActivity";
import { useSettingsStore } from "../../stores/settings";
import type { Settings } from "../../types";
import { MOBILE_HOST_KEY, NAMES } from "../../lib/brand";

/** Every command the bridge may never reach for a phone. */
const FORBIDDEN = [
  "pull_ollama_model",
  "delete_ollama_model",
  "delete_ollama_pull",
  "pause_ollama_pull",
  "clear_pending_ollama_pull",
  "delete_partial_blob",
  "load_ollama_model",
];

type Row = Record<string, unknown>;

const llama: Row = {
  name: "llama3:latest", size: 4_700_000_000, parameter_size: "8B", quantization: "Q4_0",
  running: false, size_vram: 0, loaded_size: 0, pinned: false, expires_in_secs: null, remote: false,
};
const qwen: Row = {
  name: "qwen3.5:9b", size: 6_594_474_711, parameter_size: "9B", quantization: "Q4_K_M",
  running: true, size_vram: 7_100_000_000, loaded_size: 7_100_000_000, pinned: true, expires_in_secs: null, remote: false,
};
const cloud: Row = {
  name: "gpt-oss:120b-cloud", size: 384, parameter_size: null, quantization: null,
  running: false, size_vram: 0, loaded_size: 0, pinned: false, expires_in_secs: null, remote: true,
};

/** Every command invoked, across the whole file, never cleared by `ask`. */
const log: string[] = [];
let rows: Row[];
let listError: string | null;
let kind: string | Error;
let installed: boolean;
let loadAnswer: (model: string) => Promise<string>;
let startPromise: () => Promise<void>;

async function ask(request: Record<string, unknown>) {
  const listener = vi.mocked(listen).mock.calls.find(([name]) => name === NAMES.mobileDesktopEvent);
  const deliver = listener![1] as (event: { payload: unknown }) => void;
  const invokeMock = vi.mocked(invoke);
  invokeMock.mockClear();
  deliver({ payload: request });
  await vi.waitFor(() => expect(invokeMock.mock.calls.some(
    ([command]) => command === "mobile_desktop_respond",
  )).toBe(true));
  const call = invokeMock.mock.calls.find(([command]) => command === "mobile_desktop_respond");
  return (call?.[1] as { response: Record<string, unknown> }).response;
}

const list = () => ask({ type: "local_models", request_id: "l1" });
const mutate = (action: Record<string, unknown>) => ask({ type: "local_model_mutate", request_id: "m1", action });
const invokedSince = (mark: number) => log.slice(mark).filter((c) => c !== "mobile_desktop_respond");
/** The host re-renders on a settings change, hence `act`. */
const setHost = (host: Record<string, unknown> | undefined) => act(() => {
  useSettingsStore.setState({
    settings: { ollama_roles: { tabs: "llama3" }, ...(host ? { [MOBILE_HOST_KEY]: host } : {}) } as Settings,
    loaded: true,
  });
});

describe("Mobile bridge — local models", () => {
  beforeEach(async () => {
    rows = [llama, qwen, cloud];
    listError = null;
    kind = "local";
    installed = true;
    loadAnswer = (model) => Promise.resolve(model);
    startPromise = () => Promise.resolve();
    vi.mocked(invoke).mockImplementation((command: string, args?: unknown) => {
      log.push(command);
      switch (command) {
        case "list_ollama_models_detailed":
          return listError === null ? Promise.resolve(rows) : Promise.reject(listError);
        case "ollama_server_kind":
          return kind instanceof Error ? Promise.reject("Ollama host \"x\" is not a loopback address …") : Promise.resolve(kind);
        case "ollama_is_installed":
          return Promise.resolve(installed);
        case "load_installed_ollama_model":
          return loadAnswer((args as { model: string }).model);
        case "stop_ollama_model":
          return Promise.resolve();
        case "ensure_ollama_running_unattended":
          return startPromise();
        default:
          return Promise.resolve(undefined);
      }
    });
    vi.mocked(listen).mockResolvedValue(() => {});
    __resetOllamaActivityForTests();
    __resetMobileLocalModelsForTests();
    setHost({ enabled: true });
    render(<MobileBridgeHost />);
    await vi.waitFor(() => expect(vi.mocked(listen).mock.calls.length).toBeGreaterThan(0));
  });

  afterEach(() => {
    cleanup();
    vi.mocked(invoke).mockReset();
    vi.mocked(listen).mockReset();
  });

  // Whatever order (or subset) the cases run in, none of them reached a
  // forbidden command.
  afterAll(() => {
    expect(log.length).toBeGreaterThan(0);
    for (const command of FORBIDDEN) expect(log).not.toContain(command);
  });

  it("lists every installed model with its state, placement and keep-alive", async () => {
    useOllamaActivityStore.setState({ loads: { llama3: "loading" } });
    const response = await list();
    expect(response).toEqual({
      status: "local_models",
      server: "running",
      can_start: false,
      start_failed: false,
      models: [
        // The desktop's tabs setting says `llama3`; the list says `llama3:latest`.
        { name: "llama3:latest", size: 4_700_000_000, parameter_size: "8B", quantization: "Q4_0", state: "loading", for_tabs: true, remote: false },
        {
          name: "qwen3.5:9b", size: 6_594_474_711, parameter_size: "9B", quantization: "Q4_K_M", state: "loaded",
          loaded_size: 7_100_000_000, vram: 7_100_000_000, pinned: true, expires_in: null, for_tabs: false, remote: false,
        },
        { name: "gpt-oss:120b-cloud", size: 384, parameter_size: null, quantization: null, state: "idle", for_tabs: false, remote: true },
      ],
    });
  });

  it("lets residency win over a stale load entry, reports a failed load, and counts down a temporary one", async () => {
    rows = [{ ...qwen, pinned: false, expires_in_secs: 240, size_vram: 1000 }, llama];
    useOllamaActivityStore.setState({ loads: { "qwen3.5:9b": "loading", "llama3:latest": "error" } });
    const models = (await list()).models as Row[];
    expect(models[0]).toMatchObject({ state: "loaded", pinned: false, expires_in: 240, vram: 1000 });
    expect(models[1]).toMatchObject({ state: "failed" });
    expect(models[1]).not.toHaveProperty("vram");
    expect(models[1]).not.toHaveProperty("pinned");
  });

  it("caps the list at 64 rows", async () => {
    rows = Array.from({ length: 70 }, (_, i) => ({ ...llama, name: `m${i}:latest` }));
    expect(((await list()).models as Row[]).length).toBe(64);
  });

  it("classifies a failed list read without passing its text on", async () => {
    listError = "not_running";
    expect(await list()).toMatchObject({ server: "stopped", can_start: true, start_failed: false, models: [] });

    installed = false;
    expect(await list()).toMatchObject({ server: "not_installed", can_start: false });

    installed = true;
    kind = "remote";
    expect(await list()).toMatchObject({ server: "unreachable", can_start: false });

    kind = new Error("bad host");
    expect(await list()).toMatchObject({ server: "unreachable", can_start: false });

    kind = "local";
    listError = "tags json: expected value at line 1 column 1 — SECRET-DETAIL";
    const response = await list();
    expect(response).toMatchObject({ server: "unreachable", can_start: false });
    expect(JSON.stringify(response)).not.toContain("SECRET-DETAIL");
  });

  it("refuses both kinds of request while the switch is off, touching no Ollama command", async () => {
    setHost({ enabled: true, local_models: false });
    const mark = log.length;
    expect(await list()).toMatchObject({ status: "error", code: "local_models_disabled" });
    expect(await mutate({ type: "load", model: "llama3" })).toMatchObject({ status: "error", code: "local_models_disabled" });
    expect(await mutate({ type: "unload", model: "qwen3.5:9b" })).toMatchObject({ status: "error", code: "local_models_disabled" });
    expect(await mutate({ type: "start" })).toMatchObject({ status: "error", code: "local_models_disabled" });
    expect(invokedSince(mark)).toEqual([]);
  });

  it("is on while the switch is unset, and on when stored true", async () => {
    setHost(undefined);
    expect(await list()).toMatchObject({ status: "local_models" });
    setHost({ enabled: true, local_models: true });
    expect(await list()).toMatchObject({ status: "local_models" });
  });

  it("refuses a model that is not installed or not local without loading anything", async () => {
    const mark = log.length;
    expect(await mutate({ type: "load", model: "qwen3" })).toMatchObject({ status: "error", code: "model_not_installed" });
    expect(await mutate({ type: "load", model: "mistral" })).toMatchObject({ status: "error", code: "model_not_installed" });
    expect(await mutate({ type: "load", model: "gpt-oss:120b-cloud" })).toMatchObject({ status: "error", code: "model_not_local" });
    expect(await mutate({ type: "unload", model: "gpt-oss:120b-cloud" })).toMatchObject({ status: "error", code: "model_not_local" });
    expect(invokedSince(mark)).not.toContain("load_installed_ollama_model");
    expect(invokedSince(mark)).not.toContain("stop_ollama_model");
  });

  it("loads by the listed name and marks the name the backend answers with", async () => {
    const response = await mutate({ type: "load", model: "llama3" });
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("load_installed_ollama_model", { model: "llama3:latest" });
    expect(useOllamaActivityStore.getState().loads).toEqual({ "llama3:latest": "loading" });
    expect(response.status).toBe("local_models");
    expect((response.models as Row[])[0]).toMatchObject({ name: "llama3:latest", state: "loading" });
  });

  it("never re-marks a load whose own progress events beat the answer", async () => {
    // Ollama refusing at once: "loading" then "error" arrive before the command answers.
    loadAnswer = (model) => {
      useOllamaActivityStore.setState({ loads: { [model]: "loading" } });
      useOllamaActivityStore.setState({ loads: { [model]: "error" } });
      return Promise.resolve(model);
    };
    const failed = await mutate({ type: "load", model: "llama3" });
    expect(useOllamaActivityStore.getState().loads).toEqual({ "llama3:latest": "error" });
    expect((failed.models as Row[])[0]).toMatchObject({ name: "llama3:latest", state: "failed" });

    // A load that finished before the answer: its "success" cleared the entry,
    // and nothing may put a "loading" back that no event would ever clear.
    loadAnswer = (model) => {
      useOllamaActivityStore.setState({ loads: { [model]: "loading" } });
      useOllamaActivityStore.setState({ loads: {} });
      return Promise.resolve(model);
    };
    await mutate({ type: "load", model: "llama3" });
    expect(useOllamaActivityStore.getState().loads).toEqual({});
  });

  it("passes a backend refusal on as its code only", async () => {
    loadAnswer = () => Promise.reject("model_not_installed");
    expect(await mutate({ type: "load", model: "llama3" })).toMatchObject({ code: "model_not_installed" });
    loadAnswer = () => Promise.reject("could not start the load: SECRET-DETAIL");
    const response = await mutate({ type: "load", model: "llama3" });
    expect(response).toMatchObject({ status: "error", code: "unreachable" });
    expect(JSON.stringify(response)).not.toContain("SECRET-DETAIL");
  });

  it("refuses a load or unload while Ollama is not running", async () => {
    listError = "not_running";
    expect(await mutate({ type: "load", model: "llama3" })).toMatchObject({ code: "ollama_not_running" });
    expect(await mutate({ type: "unload", model: "qwen3.5:9b" })).toMatchObject({ code: "ollama_not_running" });
  });

  it("unloads a resident model, holds off one still loading, and does nothing for an idle one", async () => {
    const response = await mutate({ type: "unload", model: "qwen3.5:9b" });
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("stop_ollama_model", { model: "qwen3.5:9b" });
    expect(response.status).toBe("local_models");

    useOllamaActivityStore.setState({ loads: { "llama3:latest": "loading" } });
    let mark = log.length;
    expect(await mutate({ type: "unload", model: "llama3" })).toMatchObject({ status: "error", code: "model_loading" });
    expect(invokedSince(mark)).not.toContain("stop_ollama_model");

    useOllamaActivityStore.setState({ loads: {} });
    mark = log.length;
    expect(await mutate({ type: "unload", model: "llama3" })).toMatchObject({ status: "local_models" });
    expect(invokedSince(mark)).not.toContain("stop_ollama_model");
  });

  it("starts Ollama without waiting for it, once, and reports a start that failed", async () => {
    listError = "not_running";
    let reject!: (reason: unknown) => void;
    startPromise = () => new Promise<void>((_, no) => { reject = no; });

    expect(await mutate({ type: "start" })).toMatchObject({ status: "local_models", server: "starting", can_start: false });
    expect(log.filter((c) => c === "ensure_ollama_running_unattended")).toHaveLength(1);
    expect(await list()).toMatchObject({ server: "starting" });

    // A second Start while the first runs adds nothing.
    expect(await mutate({ type: "start" })).toMatchObject({ server: "starting" });
    expect(log.filter((c) => c === "ensure_ollama_running_unattended")).toHaveLength(1);

    reject("Ollama did not become ready …");
    await vi.waitFor(async () => expect(await list()).toMatchObject({ server: "stopped", can_start: true, start_failed: true }));

    // The next Start clears it; a server that runs clears it too.
    startPromise = () => new Promise<void>(() => {});
    expect(await mutate({ type: "start" })).toMatchObject({ server: "starting", start_failed: false });
  });

  it("clears a failed start once the server runs", async () => {
    listError = "not_running";
    startPromise = () => Promise.reject("no");
    await mutate({ type: "start" });
    await vi.waitFor(async () => expect(await list()).toMatchObject({ start_failed: true }));
    listError = null;
    expect(await list()).toMatchObject({ server: "running", start_failed: false });
    listError = "not_running";
    expect(await list()).toMatchObject({ server: "stopped", start_failed: false });
  });

  it("starts nothing where it cannot, and nothing while running", async () => {
    const mark = log.length;
    expect(await mutate({ type: "start" })).toMatchObject({ status: "local_models", server: "running" });
    listError = "not_running";
    installed = false;
    expect(await mutate({ type: "start" })).toMatchObject({ status: "error", code: "start_unavailable" });
    installed = true;
    kind = "remote";
    expect(await mutate({ type: "start" })).toMatchObject({ status: "error", code: "start_unavailable" });
    expect(invokedSince(mark)).not.toContain("ensure_ollama_running_unattended");
  });

  it("asks the backend for nothing but list, kind, installed, load-installed, stop and start", async () => {
    expect(log.length).toBeGreaterThan(0);
    const allowed = new Set([
      "list_ollama_models_detailed", "ollama_server_kind", "ollama_is_installed",
      "load_installed_ollama_model", "stop_ollama_model", "ensure_ollama_running_unattended",
      "mobile_desktop_respond",
    ]);
    // The host's own mount-time calls are not ours; everything from the
    // local-model paths is in the set, and nothing forbidden ever appears.
    for (const command of FORBIDDEN) expect(log).not.toContain(command);
    const mark = log.length;
    await list();
    await mutate({ type: "load", model: "llama3" });
    await mutate({ type: "unload", model: "qwen3.5:9b" });
    await mutate({ type: "start" });
    listError = "not_running";
    await list();
    await mutate({ type: "start" });
    for (const command of log.slice(mark)) expect([command, allowed.has(command)]).toEqual([command, true]);
  });

  it("queues phone mutations in a domain of their own, and reads in none", () => {
    expect(mutationDomain("local_model_mutate")).toBe("local_models");
    expect(mutationDomain("local_models")).toBeNull();
  });
});

describe("isListedModel", () => {
  it("matches exactly or by :latest, never by prefix, and never takes a registry port for a tag", () => {
    expect(isListedModel("llama3:latest", "llama3")).toBe(true);
    expect(isListedModel("llama3:latest", "llama3:latest")).toBe(true);
    expect(isListedModel("qwen3.5:9b", "qwen3")).toBe(false);
    expect(isListedModel("llama3:8b", "llama3")).toBe(false);
    expect(isListedModel("reg:5000/ns/m:latest", "reg:5000/ns/m")).toBe(true);
    expect(isListedModel("hf.co/u/m:q4", "hf.co/u/m:q4")).toBe(true);
    expect(isListedModel("hf.co/u/m:latest", "hf.co/u/m:q4")).toBe(false);
  });
});
