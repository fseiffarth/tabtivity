/**
 * The phone's ＋ offers the desktop "+"'s local-model group (#31bl): the
 * "tabs" model and the agents that can drive it, under opaque ids. A start
 * builds the tab the desktop menu would — and, in a Mobile-access project,
 * one that records its launch line so it restores and the phone can come back.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(), emit: vi.fn() }));

import { MobileBridgeHost } from "../../components/mobile/MobileBridgeHost";
import { useProjectsStore } from "../../stores/projects";
import { useSettingsStore } from "../../stores/settings";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import type { ProjectEntry, Settings } from "../../types";
import { BRAND, MOBILE_ACCESS_KEY, NAMES } from "../../lib/brand";

const paper: ProjectEntry = {
  id: "p-paper",
  name: "Paper",
  status: "active",
  position: 1,
  local_file: "/projects/paper/project.json",
  directory: "/projects/paper",
  [MOBILE_ACCESS_KEY]: true,
};

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

const options = () => ask({ type: "launch_options", request_id: "l1", project_id: paper.id });
const create = (request: Record<string, unknown>) => ask({
  type: "create",
  request_id: "c1",
  request: { project_id: paper.id, kind: "agent", idempotency_key: "0123456789abcdef", ...request },
});

describe("Mobile bridge — local-model agents", () => {
  const made = vi.fn();
  let resident: { name: string; running: boolean; size_vram: number }[];

  beforeEach(async () => {
    resident = [{ name: "qwen3:8b", running: true, size_vram: 1024 }];
    vi.mocked(invoke).mockImplementation((command: string, args?: unknown) => {
      switch (command) {
        case "list_agents":
          return Promise.resolve([
            { id: "claude", bin: "claude", installed: true },
            { id: "vibe", bin: "vibe", installed: true },
          ]);
        case "list_local_drivers":
          return Promise.resolve([
            { id: "claude", label: "Claude Code", available: true, needs_tools_unsupported: false, heavy_harness: true },
            { id: "droid", label: "Droid", available: false, needs_tools_unsupported: false, heavy_harness: true },
          ]);
        case "list_ollama_models_detailed":
          return Promise.resolve(resident);
        case "ollama_gpu_status":
          return Promise.resolve({ gpu_present: true });
        case "prepare_local_launch":
          return Promise.resolve({ cmd: "ollama", args: ["launch", "claude", "--model", "qwen3:8b"] });
        case "prepare_local_agent":
          return Promise.resolve({ vibe_home: "/state/vibe_local/qwen3_8b", alias: "qwen3_8b" });
        case "mobile_opaque_id": {
          const { domain, value } = args as { domain: string; value: string };
          return Promise.resolve(`${domain}-${value}`);
        }
        default:
          return Promise.resolve(undefined);
      }
    });
    vi.mocked(listen).mockResolvedValue(() => {});
    useProjectsStore.setState({ projects: [paper], activeId: paper.id, loaded: true, activateProject: vi.fn(() => Promise.resolve()) } as never);
    useSettingsStore.setState({ settings: { ollama_roles: { tabs: "qwen3:8b" } } as Settings, loaded: true });
    made.mockReset();
    useTabsStore.setState({
      tabsByScope: { [paper.id]: [] },
      hydrateThenCreateInScope: (opts: { spec: Omit<TabEntry, "key"> }) => {
        made(opts.spec);
        return Promise.resolve({ ...opts.spec, key: "new", tmuxSession: `${BRAND.slug}-new` } as TabEntry);
      },
    } as never);
    render(<MobileBridgeHost />);
    await vi.waitFor(() => expect(vi.mocked(listen).mock.calls.length).toBeGreaterThan(0));
  });

  afterEach(() => {
    cleanup();
    vi.mocked(invoke).mockReset();
    vi.mocked(listen).mockReset();
  });

  it("lists the model and its available agents by opaque id, Mistral first", async () => {
    const response = await options();
    expect(response.local).toEqual({
      model: "qwen3:8b",
      ready: true,
      agents: [
        { id: "agent-local:vibe", label: "Mistral", caution: false },
        { id: "agent-local:claude", label: "Claude Code", caution: true },
      ],
    });
  });

  it("says when the model is not on the GPU, and offers nothing without a model", async () => {
    resident = [{ name: "qwen3:8b", running: true, size_vram: 0 }];
    expect((await options()).local).toMatchObject({ ready: false });
    useSettingsStore.setState({ settings: {} as Settings, loaded: true });
    expect((await options()).local).toBeUndefined();
  });

  it("starts a driver on the model with its launch line recorded", async () => {
    expect(await create({ local: "agent-local:claude" })).toMatchObject({ status: "created", tmux_session: `${BRAND.slug}-new` });
    expect(made).toHaveBeenLastCalledWith(expect.objectContaining({
      label: "qwen3:8b · Claude Code",
      cmd: "ollama",
      args: ["launch", "claude", "--model", "qwen3:8b"],
      kind: "local_agent",
      localLaunch: { driver: "claude", model: "qwen3:8b", args: ["launch", "claude", "--model", "qwen3:8b"] },
    }));
    // The model was already on the GPU: nothing to load.
    expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "load_ollama_model")).toBe(false);
  });

  it("starts Mistral as a resumable tab, and loads a model that is not on the GPU", async () => {
    resident = [];
    await create({ local: "agent-local:vibe" });
    const spec = made.mock.lastCall?.[0] as Omit<TabEntry, "key">;
    expect(spec).toMatchObject({ cmd: "vibe", kind: "local_agent" });
    expect(spec.sessionId).toBeTruthy();
    expect(spec.localLaunch).toBeUndefined();
    await vi.waitFor(() => expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "load_ollama_model")).toBe(true));
  });

  it("refuses an unknown local id, and one that names anything else", async () => {
    expect(await create({ local: "agent-local:droid" })).toMatchObject({ status: "error", code: "unknown_agent" });
    expect(await create({ local: "agent-local:claude", agent_id: "agent-claude" })).toMatchObject({ status: "error", code: "invalid_request" });
    expect(made).not.toHaveBeenCalled();
  });
});
