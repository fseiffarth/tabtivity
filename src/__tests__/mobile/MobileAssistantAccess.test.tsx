/**
 * The chat assistant reaches the phone as a scope of its own
 * (`docs/assistant_plan.md`, decision 12).
 *
 * The sidecar's `discovery::assistant_open` is the perimeter; the desktop
 * bridge repeats the same rule (the experimental flag, and `assistant_access`
 * not switched off) because it is reachable without that route. Pinned here:
 * the gate, the create arm (an opaque launch id resolved against the desktop's
 * own options, idempotent, alone), and that the scope is never activated,
 * given launch options of a project, or given a prompt history.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(), emit: vi.fn() }));

import { MobileBridgeHost } from "../../components/mobile/MobileBridgeHost";
import { useActivityStore } from "../../stores/activity";
import { useBoxesStore } from "../../stores/boxes";
import { useProjectsStore } from "../../stores/projects";
import { useSettingsStore } from "../../stores/settings";
import { useTabsStore } from "../../stores/tabs";
import type { TabEntry } from "../../stores/tabs";
import type { Settings } from "../../types";
import { ASSISTANT_SCOPE } from "../../lib/assistant";
import { BRAND, MOBILE_HOST_KEY, NAMES } from "../../lib/brand";

const UID = "0b9d8f3e-2c1a-4e7b-9a55-3f6d1c2b7a10";
const TMUX = `${BRAND.slug}-assistant--agent-123456789`;
const CHAT: TabEntry = {
  key: "chat-1",
  label: "Claude",
  kind: "agent",
  cmd: "claude",
  cwd: `/state/assistant/work/${UID}`,
  sessionId: UID,
  tmuxSession: TMUX,
};

const options = {
  clis: [
    { id: "claude", label: "Claude", local: false, installed: true, signedIn: true, ready: true },
    { id: "opencode_local", label: "OpenCode", local: true, installed: true, signedIn: null, ready: true },
  ],
  localModels: ["qwen3:8b"],
  ollamaReachable: true,
  defaultCli: null,
  defaultModel: null,
  search: { kind: null, searxngUrl: null, ollamaKeyStored: null, keyring: "unlocked", configured: false },
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

const activate = vi.fn(() => Promise.resolve());
/** The `assistant_new_chat` calls so far (`ask` clears the invoke mock). */
const made: unknown[] = [];
/** A request key no earlier test used: the bridge remembers keys it answered. */
let keys = 0;
const freshKey = () => `k${String(++keys).padStart(15, "0")}`;

async function mount(settings: Settings, tabs: TabEntry[] = [CHAT]) {
  vi.mocked(invoke).mockImplementation((command: string, args?: unknown) => {
    switch (command) {
      case "list_agents": return Promise.resolve([]);
      case "agent_schedules_list": return Promise.resolve([]);
      case "assistant_options": return Promise.resolve(options);
      case "mobile_opaque_id": {
        const { domain, value } = args as { domain: string; value: string };
        return Promise.resolve(`${domain}-${value}`);
      }
      case "assistant_new_chat":
        made.push(args);
        useTabsStore.setState((state) => ({ tabsByScope: { ...state.tabsByScope, [ASSISTANT_SCOPE]: [CHAT] } }));
        return Promise.resolve({ tabId: "t1", uid: UID, scope: ASSISTANT_SCOPE, version: 2 });
      default: return Promise.resolve(undefined);
    }
  });
  vi.mocked(listen).mockResolvedValue(() => {});
  activate.mockClear();
  made.length = 0;
  useProjectsStore.setState({ projects: [], activeId: "p-other", loaded: true, activateProject: activate } as never);
  useBoxesStore.setState({ boxes: [], loaded: true });
  useSettingsStore.setState({ settings, loaded: true });
  useTabsStore.setState({ scope: "p-other", tabsByScope: { [ASSISTANT_SCOPE]: tabs } });
  useActivityStore.setState({ busyByTab: { [`${ASSISTANT_SCOPE}:chat-1`]: true } });
  render(<MobileBridgeHost />);
  await vi.waitFor(() => expect(vi.mocked(listen).mock.calls.length).toBeGreaterThan(0));
}

const host = (assistantAccess?: boolean) => ({ enabled: true, assistant_access: assistantAccess });
const open = { assistant: true, [MOBILE_HOST_KEY]: host() } as Settings;
const seen = () => ask({ type: "tab_seen", request_id: "r", project_id: ASSISTANT_SCOPE, tmux_session: TMUX });
const create = (extra: Record<string, unknown> = {}, key = freshKey()) =>
  ask({
    type: "create",
    request_id: "c1",
    request: { project_id: ASSISTANT_SCOPE, kind: "agent", assistant: "assistant-claude", idempotency_key: key, ...extra },
  });

describe("Mobile bridge — the chat assistant", () => {
  afterEach(() => {
    cleanup();
    vi.mocked(invoke).mockReset();
    vi.mocked(listen).mockReset();
    useActivityStore.setState({ busyByTab: {}, attentionByTab: {}, attentionByScope: {} });
  });

  it("is refused unless the flag is on and the Mobile switch is not off", async () => {
    for (const settings of [
      {},
      { [MOBILE_HOST_KEY]: host() },
      { assistant: false, [MOBILE_HOST_KEY]: host() },
      { assistant: true, [MOBILE_HOST_KEY]: host(false) },
      // A profile marked explicit follows the flag alone, not Debug mode.
      { debug: true, experimental_explicit: true, [MOBILE_HOST_KEY]: host() },
    ] as Settings[]) {
      await mount(settings);
      expect(await seen(), JSON.stringify(settings)).toMatchObject({ status: "error", code: "project_ineligible" });
      cleanup();
      vi.mocked(listen).mockReset();
    }
  });

  it("is open on the flag alone, and on an unmarked profile in Debug mode, like the typed rule", async () => {
    await mount(open);
    expect((await seen()).status).toBe("seen");
    cleanup();
    vi.mocked(listen).mockReset();
    await mount({ debug: true, [MOBILE_HOST_KEY]: host(true) } as Settings);
    expect((await seen()).status).toBe("seen");
  });

  it("answers with its chat's state, in the activity feed too", async () => {
    await mount(open);
    const response = await ask({ type: "catalog", request_id: "r1", project_id: ASSISTANT_SCOPE });
    expect(response.statuses).toMatchObject([{ tmux_session: TMUX, status: "working" }]);
    const feed = await ask({ type: "activity", request_id: "r2" });
    expect((feed.statuses as { tmux_session: string }[]).map((row) => row.tmux_session)).toEqual([TMUX]);
  });

  it("is never switched to: activating it leaves the open project alone", async () => {
    await mount(open);
    expect((await ask({ type: "activate", request_id: "r3", project_id: ASSISTANT_SCOPE })).status).toBe("activated");
    expect(activate).not.toHaveBeenCalled();
    expect(useTabsStore.getState().scope).toBe("p-other");
    expect(useProjectsStore.getState().activeId).toBe("p-other");
  });

  it("offers no worktree, cloud session, sign-in or local agent (the sidecar lists its launches)", async () => {
    await mount(open);
    expect(await ask({ type: "launch_options", request_id: "l1", project_id: ASSISTANT_SCOPE })).toEqual({
      status: "launch_options", worktrees: [], cloud: [], sign_in: [],
    });
  });

  it("starts a chat from an opaque launch through the desktop command, once per request", async () => {
    await mount(open, []);
    const key = freshKey();
    expect(await create({}, key)).toEqual({ status: "created", tmux_session: TMUX });
    expect(made).toEqual([{ cli: "claude", model: null }]);
    // The phone retries a create until it sees the tab: the same key opens nothing twice.
    expect(await create({}, key)).toEqual({ status: "created", tmux_session: TMUX });
    expect(made).toHaveLength(1);
    // A local launch carries its model.
    await create({ assistant: "assistant-opencode_local:qwen3:8b" });
    expect(made.at(-1)).toEqual({ cli: "opencode_local", model: "qwen3:8b" });
    expect(made).toHaveLength(2);
  });

  it("refuses a launch id it did not derive, and a create that names anything else", async () => {
    await mount(open, []);
    for (const handle of ["claude", "assistant-claude_local:qwen3:8b", "assistant-opencode_local:other", "../../x"]) {
      expect(await create({ assistant: handle }), handle).toMatchObject({ status: "error", code: "unknown_agent" });
    }
    for (const extra of [{ agent_id: "a" }, { mode: "plan" }, { worktree: "w" }, { cloud: "new" }, { sign_in: "default" }, { local: "l" }]) {
      expect(await create(extra), JSON.stringify(extra)).toMatchObject({ status: "error", code: "invalid_request" });
    }
    expect(await create({ assistant: undefined })).toMatchObject({ status: "error", code: "invalid_request" });
    expect(await create({ kind: "shell" })).toMatchObject({ status: "error", code: "invalid_request" });
    expect(made).toHaveLength(0);
  });

  it("surfaces the command's own refusal code", async () => {
    await mount(open, []);
    vi.mocked(invoke).mockImplementation((command: string, args?: unknown) => {
      if (command === "assistant_options") return Promise.resolve(options);
      if (command === "mobile_opaque_id") return Promise.resolve(`${(args as { domain: string }).domain}-${(args as { value: string }).value}`);
      if (command === "assistant_new_chat") return Promise.reject("assistant_off");
      return Promise.resolve(undefined);
    });
    expect(await create()).toMatchObject({ status: "error", code: "assistant_off" });
  });

  it("records no prompt history for a chat", async () => {
    await mount(open);
    expect(await ask({ type: "tab_prompt", request_id: "p", project_id: ASSISTANT_SCOPE, tmux_session: TMUX, message: "hello" })).toEqual({ status: "seen" });
    expect(vi.mocked(invoke).mock.calls.map(([command]) => command).filter((command) => /record/.test(command))).toEqual([]);
  });

  it("closes the chat from the phone like any tab", async () => {
    await mount(open);
    expect((await ask({ type: "close_tab", request_id: "x", project_id: ASSISTANT_SCOPE, tmux_session: TMUX })).status).toBe("closed");
    expect(useTabsStore.getState().tabsByScope[ASSISTANT_SCOPE] ?? []).toEqual([]);
  });
});
