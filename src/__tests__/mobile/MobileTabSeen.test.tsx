/**
 * Opening an agent tab on the phone retires its `done` tag.
 *
 * The tag the phone shows is the desktop's own attention flag, relayed through
 * the catalog. Until the sidecar reported the attach, nothing on the phone ever
 * marked that output read — so a finished turn kept its "done" pill on the
 * project screen no matter how long the tab had been on the phone's screen.
 * The attach (and the detach) now sends `tab_seen`, which goes through the very
 * door the desktop's own tab switch uses.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(), emit: vi.fn() }));

import { MobileBridgeHost } from "../../components/mobile/MobileBridgeHost";
import { notePtyOutput, useActivityStore } from "../../stores/activity";
import { useProjectsStore } from "../../stores/projects";
import { useSettingsStore } from "../../stores/settings";
import { useTabsStore } from "../../stores/tabs";
import type { TabEntry } from "../../stores/tabs";
import type { ProjectEntry, Settings } from "../../types";
import { BRAND, MOBILE_ACCESS_KEY, NAMES } from "../../lib/brand";

const project: ProjectEntry = {
  id: "p-mobile",
  name: "Alpha",
  status: "active",
  position: 1,
  local_file: "/projects/alpha/project.json",
  [MOBILE_ACCESS_KEY]: true,
};

const TMUX = `${BRAND.slug}-p-mobile--agent-123456789`;

/** Hand the bridge one desktop request and give back what it answered. */
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
  return (call?.[1] as { response: { status: string } }).response;
}

describe("Mobile bridge — a phone that looked at an agent tab", () => {
  beforeEach(async () => {
    vi.mocked(invoke).mockImplementation((command: string) => {
      if (command === "list_agents") return Promise.resolve([]);
      if (command === "agent_schedules_list") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
    vi.mocked(listen).mockResolvedValue(() => {});
    useProjectsStore.setState({ projects: [project], activeId: project.id, loaded: true });
    useSettingsStore.setState({ settings: {} as Settings, loaded: true });
    useTabsStore.setState({
      scope: project.id,
      tabsByScope: {
        [project.id]: [
          { key: "agent-1", label: "Claude", kind: "agent", cmd: "claude", cwd: "/projects/alpha", tmuxSession: TMUX },
          { key: "shell-1", label: "Shell", kind: "shell", cmd: "bash", cwd: "/projects/alpha" },
        ] satisfies TabEntry[],
      },
    });
    render(<MobileBridgeHost />);
    await vi.waitFor(() => expect(vi.mocked(listen).mock.calls.length).toBeGreaterThan(0));
  });

  afterEach(() => {
    cleanup();
    vi.mocked(invoke).mockReset();
    vi.mocked(listen).mockReset();
    useActivityStore.setState({ attentionByTab: {}, attentionByScope: {}, lastDoneByTab: {}, lastWorkingByTab: {} });
  });

  it("retires the finished-turn flag the catalog reports as `done`", async () => {
    useActivityStore.setState({ attentionByTab: { "p-mobile:agent-1": "done" } });

    expect(await ask({ type: "tab_seen", request_id: "r1", project_id: project.id, tmux_session: TMUX }))
      .toEqual({ status: "seen" });
    expect(useActivityStore.getState().attentionByTab["p-mobile:agent-1"]).toBeUndefined();

    // And the catalog the phone polls next stops publishing the tag.
    const catalog = await ask({ type: "catalog", request_id: "r2", project_id: project.id });
    expect((catalog as unknown as { statuses: unknown[] }).statuses).toEqual([]);
  });

  it("keeps a read turn's timings, so the phone does not re-sort it to its tab-bar place", async () => {
    useActivityStore.setState({
      attentionByTab: { "p-mobile:agent-1": "done" },
      lastWorkingByTab: { "p-mobile:agent-1": 1_700_000_000_000 },
      lastDoneByTab: { "p-mobile:agent-1": 1_700_000_000_000 },
    });
    await ask({ type: "tab_seen", request_id: "r5", project_id: project.id, tmux_session: TMUX });

    const catalog = await ask({ type: "catalog", request_id: "r6", project_id: project.id }) as unknown as {
      statuses: unknown[]; timings: unknown[];
    };
    expect(catalog.statuses).toEqual([]);
    expect(catalog.timings).toEqual([{ tmux_session: TMUX, working_at: 1_700_000_000_000, done_at: 1_700_000_000_000 }]);
  });

  it("keeps a live decision prompt, which being looked at does not answer", async () => {
    // The tail is what makes the prompt live: a `decision` is retired by an
    // ANSWER, and the phone opening the tab is not one.
    notePtyOutput("p-mobile:agent-1", "Do you want to make this edit?\r\n❯ 1. Yes\r\n  2. No\r\n");
    useActivityStore.setState({ attentionByTab: { "p-mobile:agent-1": "decision" } });

    expect(await ask({ type: "tab_seen", request_id: "r3", project_id: project.id, tmux_session: TMUX }))
      .toEqual({ status: "seen" });
    expect(useActivityStore.getState().attentionByTab["p-mobile:agent-1"]).toBe("decision");
  });

  it("says nothing about a project the Mobile switch is off for", async () => {
    useProjectsStore.setState({ projects: [{ ...project, [MOBILE_ACCESS_KEY]: false }] });
    useActivityStore.setState({ attentionByTab: { "p-mobile:agent-1": "done" } });

    const response = await ask({ type: "tab_seen", request_id: "r4", project_id: project.id, tmux_session: TMUX });
    expect(response.status).toBe("error");
    expect(useActivityStore.getState().attentionByTab["p-mobile:agent-1"]).toBe("done");
  });

  it("answers a request kind this window does not know, at once and by name", async () => {
    // A sidecar newer than the window. No answer at all left the phone waiting
    // out the whole desktop timeout before it read "desktop unavailable".
    expect(await ask({ type: "kind_from_a_newer_sidecar", request_id: "r7" })).toEqual({
      status: "error",
      code: "unknown_request",
      message: expect.any(String),
    });
  });
});
