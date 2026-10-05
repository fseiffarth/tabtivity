/**
 * The root console reaches the phone (`docs/mobile_root_plan.md`).
 *
 * The sidecar's `discovery::root_open` is the perimeter; the desktop bridge
 * repeats the same rule because it is reachable without that route. Pinned
 * here: the switch alone decides while root agents carry no MCP tools, the
 * tools need every write staged behind the fence, and "activate" raises the
 * console rather than switching scope.
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
import { useRootOverlayStore } from "../../stores/rootOverlay";
import { useSettingsStore } from "../../stores/settings";
import { useTabsStore } from "../../stores/tabs";
import type { TabEntry } from "../../stores/tabs";
import type { Settings } from "../../types";
import { BRAND, MOBILE_HOST_KEY, NAMES } from "../../lib/brand";

const TMUX = `${BRAND.slug}-root--agent-123456789`;

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

async function mount(settings: Settings, reviewEnforced: boolean) {
  vi.mocked(invoke).mockImplementation((command: string) => {
    if (command === "list_agents") return Promise.resolve([]);
    if (command === "agent_schedules_list") return Promise.resolve([]);
    if (command === "root_mcp_status") return Promise.resolve({ review_enforced: reviewEnforced });
    return Promise.resolve(undefined);
  });
  vi.mocked(listen).mockResolvedValue(() => {});
  useProjectsStore.setState({ projects: [], activeId: null, loaded: true, rootDir: `/home/user/${BRAND.slug}/root` });
  useBoxesStore.setState({ boxes: [], loaded: true });
  useSettingsStore.setState({ settings, loaded: true });
  useTabsStore.setState({
    scope: "p-other",
    tabsByScope: {
      root: [
        { key: "agent-1", label: "Claude", kind: "agent", cmd: "claude", cwd: `/home/user/${BRAND.slug}/root`, tmuxSession: TMUX },
      ] satisfies TabEntry[],
    },
  });
  useActivityStore.setState({ busyByTab: { "root:agent-1": true } });
  useRootOverlayStore.setState({ open: false });
  render(<MobileBridgeHost />);
  await vi.waitFor(() => expect(vi.mocked(listen).mock.calls.length).toBeGreaterThan(0));
  // The mount-time `root_mcp_status` reading has to land before the gate is asked.
  await vi.waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalledWith("root_mcp_status"));
  await Promise.resolve();
}

const host = (rootAccess?: boolean) => ({ enabled: true, root_access: rootAccess });

describe("Mobile bridge — the root console", () => {
  afterEach(() => {
    cleanup();
    vi.mocked(invoke).mockReset();
    vi.mocked(listen).mockReset();
    useActivityStore.setState({ busyByTab: {}, attentionByTab: {}, attentionByScope: {} });
    useRootOverlayStore.setState({ open: false });
  });

  const seen = () => ask({ type: "tab_seen", request_id: "r", project_id: "root", tmux_session: TMUX });

  it("is refused while its switch is off", async () => {
    await mount({ [MOBILE_HOST_KEY]: host() } as Settings, true);
    expect(await seen()).toMatchObject({ status: "error", code: "project_ineligible" });
  });

  it("answers with its agent tab's state once switched on, staged and fenced", async () => {
    await mount({ [MOBILE_HOST_KEY]: host(true) } as Settings, true);
    const response = await ask({ type: "catalog", request_id: "r1", project_id: "root" });
    expect(response.statuses).toMatchObject([{ tmux_session: TMUX, status: "working" }]);
    const feed = await ask({ type: "activity", request_id: "r2" });
    expect((feed.statuses as { tmux_session: string }[]).map((row) => row.tmux_session)).toEqual([TMUX]);
  });

  it("stays closed while the tools are on and writes are not staged behind the fence", async () => {
    await mount({ [MOBILE_HOST_KEY]: host(true) } as Settings, false);
    expect(await seen()).toMatchObject({ status: "error", code: "project_ineligible" });
  });

  it("stays closed on a weaker review level even when fenced", async () => {
    await mount({ [MOBILE_HOST_KEY]: host(true), root_mcp_review: "destructive" } as Settings, true);
    expect(await seen()).toMatchObject({ status: "error", code: "project_ineligible" });
  });

  it("needs neither once the root MCP tools are off", async () => {
    await mount({ [MOBILE_HOST_KEY]: host(true), root_mcp: false, root_mcp_review: "off" } as Settings, false);
    expect((await seen()).status).not.toBe("error");
  });

  it("activating raises the console over the open project instead of switching scope", async () => {
    await mount({ [MOBILE_HOST_KEY]: host(true) } as Settings, true);
    const response = await ask({ type: "activate", request_id: "r5", project_id: "root" });
    expect(response.status).toBe("activated");
    expect(useRootOverlayStore.getState().open).toBe(true);
    expect(useTabsStore.getState().scope).toBe("p-other");
  });
});
