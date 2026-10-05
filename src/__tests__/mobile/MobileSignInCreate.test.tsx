/**
 * The phone asks the desktop for a sign-in tab — by agent from the ＋ sheet,
 * or "like" an agent tab that needs a login — and the desktop builds it from
 * its own table (`lib/agents/signInLaunch`), never from anything the phone
 * sent.
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

const create = (request: Record<string, unknown>) => ask({
  type: "create",
  request_id: "c1",
  request: { project_id: paper.id, kind: "agent", idempotency_key: "0123456789abcdef", ...request },
});

describe("Mobile bridge — sign-in tabs", () => {
  const made = vi.fn();
  beforeEach(async () => {
    vi.mocked(invoke).mockImplementation((command: string, args?: unknown) => {
      if (command === "list_agents") return Promise.resolve([{ bin: "claude", installed: true }, { bin: "codex", installed: true }]);
      if (command === "mobile_opaque_id") {
        const { domain, value } = args as { domain: string; value: string };
        return Promise.resolve(`${domain}-${value}`);
      }
      return Promise.resolve(undefined);
    });
    vi.mocked(listen).mockResolvedValue(() => {});
    useProjectsStore.setState({ projects: [paper], activeId: paper.id, loaded: true, activateProject: vi.fn(() => Promise.resolve()) } as never);
    useSettingsStore.setState({ settings: {} as Settings, loaded: true });
    made.mockReset();
    useTabsStore.setState({
      tabsByScope: {
        [paper.id]: [{ key: "a1", label: "Codex", cmd: "codex", args: [], env: {}, cwd: "/projects/paper", kind: "agent", tmuxSession: `${BRAND.slug}-codex-1` } as TabEntry],
      },
      hydrateThenCreateInScope: (options: { spec: Omit<TabEntry, "key"> }) => {
        made(options.spec);
        return Promise.resolve({ ...options.spec, key: "new", tmuxSession: `${BRAND.slug}-new` } as TabEntry);
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

  it("starts the picked agent's login command, or its other way in", async () => {
    expect(await create({ agent_id: "agent-claude", sign_in: "default" })).toMatchObject({ status: "created", tmux_session: `${BRAND.slug}-new` });
    expect(made).toHaveBeenLastCalledWith(expect.objectContaining({ cmd: "claude", args: ["auth", "login", "--claudeai"] }));
    expect(made.mock.lastCall?.[0].sessionId).toBeUndefined();
    await create({ agent_id: "agent-claude", sign_in: "alternate" });
    expect(made).toHaveBeenLastCalledWith(expect.objectContaining({ cmd: "claude", args: ["auth", "login", "--console"] }));
  });

  it("signs in the CLI an agent tab runs, found by its session", async () => {
    await create({ like_tab: `${BRAND.slug}-codex-1`, sign_in: "default" });
    expect(made).toHaveBeenLastCalledWith(expect.objectContaining({ cmd: "codex", args: ["login", "--device-auth"] }));
    expect(await create({ like_tab: `${BRAND.slug}-gone`, sign_in: "default" })).toMatchObject({ status: "error", code: "tab_not_found" });
    expect(await create({ agent_id: "agent-nope", sign_in: "default" })).toMatchObject({ status: "error", code: "unknown_agent" });
  });
});
