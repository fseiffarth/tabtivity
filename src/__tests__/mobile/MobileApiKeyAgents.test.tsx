/**
 * The phone's ＋ offers the desktop "+"'s API section: the agents a stored
 * provider key can run, under opaque ids and as flags only. A start builds the
 * tab the desktop's "<agent> (API)" row would — pinned to the key — and a
 * plain start leaves the pick to Manage CLIs, as before.
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

describe("Mobile bridge — API-key agents", () => {
  const made = vi.fn();
  let logins: Record<string, unknown>[];

  beforeEach(async () => {
    logins = [
      { id: "claude", signed_in: true, account: null, shared: true, api_key_saved: true },
      { id: "gemini", signed_in: false, account: null, shared: true, api_key_saved: true, api_budget_reached: true },
    ];
    vi.mocked(invoke).mockImplementation((command: string, args?: unknown) => {
      switch (command) {
        case "list_agents":
          return Promise.resolve([
            { id: "claude", bin: "claude", installed: true },
            { id: "gemini", bin: "gemini", installed: true },
            { id: "codex", bin: "codex", installed: true },
          ]);
        case "agent_logins":
          return Promise.resolve(logins);
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
    useSettingsStore.setState({ settings: {} as Settings, loaded: true });
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

  it("lists the agents a saved key can run, with only a budget flag", async () => {
    const response = await options();
    expect(response.api_key).toEqual([
      { agent_id: "agent-claude" },
      { agent_id: "agent-gemini", budget_reached: true },
    ]);
    expect(JSON.stringify(response.api_key)).not.toMatch(/anthropic|google|\$/i);
    logins = [];
    expect((await options()).api_key).toBeUndefined();
  });

  it("starts an (API) agent pinned to the key, and a plain one unpinned", async () => {
    expect(await create({ agent_id: "agent-claude", api_key: true })).toMatchObject({ status: "created" });
    expect(made).toHaveBeenLastCalledWith(expect.objectContaining({ cmd: "claude", label: "Claude (API)", apiKey: true }));
    await create({ agent_id: "agent-claude", idempotency_key: "fedcba9876543210" });
    expect(made.mock.lastCall?.[0]).not.toHaveProperty("apiKey");
  });

  it("refuses a spent budget and an agent with no saved key", async () => {
    expect(await create({ agent_id: "agent-gemini", api_key: true })).toMatchObject({ status: "error", code: "api_budget_reached" });
    expect(await create({ agent_id: "agent-codex", api_key: true })).toMatchObject({ status: "error", code: "api_key_unavailable" });
    expect(made).not.toHaveBeenCalled();
  });
});
