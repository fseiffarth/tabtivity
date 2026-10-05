import { act, cleanup, render } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(), emit: vi.fn() }));
vi.mock("../../components/files/useAlertsFeed", () => ({
  useAlertsFeed: () => ({
    enabled: false,
    items: [],
    loading: false,
    error: null,
    refresh: () => {},
    mutedItems: [],
    mute: () => {},
    unmute: () => {},
  }),
}));

import { MobileBridgeHost } from "../../components/mobile/MobileBridgeHost";
import { useProjectsStore } from "../../stores/projects";
import { useSettingsStore } from "../../stores/settings";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
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
const tmuxSession = `${BRAND.slug}-p-mobile--agent-123456789`;
const scheduleTargetId = "target-123";
const stored = {
  id: "schedule-1",
  enabled: true,
  message: "Review the work",
  rule: { type: "daily" as const, time: "09:00" },
  preface: ["/clear", "/model opus"],
};

async function ask(action: Record<string, unknown>, deviceId?: string) {
  const listener = vi.mocked(listen).mock.calls.find(([name]) => name === NAMES.mobileDesktopEvent);
  const deliver = listener![1] as (event: { payload: unknown }) => void;
  await act(async () => {
    deliver({ payload: {
      type: "schedule_mutate",
      request_id: "schedule-request",
      project_id: project.id,
      tmux_session: tmuxSession,
      action,
      ...(deviceId ? { device_id: deviceId } : {}),
    } });
    await vi.waitFor(() => expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "mobile_desktop_respond")).toBe(true));
  });
}

describe("Mobile bridge — editing a schedule with desktop prefix commands", () => {
  beforeEach(async () => {
    vi.mocked(invoke).mockImplementation((command: string) => {
      if (command === "agent_schedules_list") return Promise.resolve([stored]);
      if (command === "agent_schedule_upsert") return Promise.resolve([stored]);
      return Promise.resolve(undefined);
    });
    vi.mocked(listen).mockResolvedValue(() => {});
    useProjectsStore.setState({ projects: [project], activeId: project.id, loaded: true });
    useSettingsStore.setState({ settings: {} as Settings, loaded: true });
    const tab: TabEntry = {
      key: "agent-1",
      label: "Claude",
      kind: "agent",
      cmd: "claude",
      cwd: "/projects/alpha",
      tmuxSession,
      scheduleTargetId,
    };
    useTabsStore.setState({
      scope: project.id,
      tabsByScope: { [project.id]: [tab] },
      layoutByScope: { [project.id]: { type: "group", id: "g1", tabKeys: [tab.key], activeKey: tab.key } },
      tabs: [tab],
    });
    render(<MobileBridgeHost />);
    await vi.waitFor(() => expect(vi.mocked(listen).mock.calls.length).toBeGreaterThan(0));
  });

  afterEach(() => {
    cleanup();
    vi.mocked(invoke).mockReset();
    vi.mocked(listen).mockReset();
  });

  it.each([
    { name: "toggling", enabled: false, message: stored.message },
    { name: "editing", enabled: true, message: "Review the latest work" },
  ])("keeps prefix commands when $name a phone schedule", async ({ enabled, message }) => {
    await ask({
      type: "update",
      schedule_id: stored.id,
      schedule: { enabled, message, rule: stored.rule },
    });

    const upsert = vi.mocked(invoke).mock.calls.find(([command]) => command === "agent_schedule_upsert");
    expect(upsert?.[1]).toMatchObject({
      projectId: project.id,
      scheduleTargetId,
      schedule: { id: stored.id, enabled, message, preface: stored.preface },
    });
  });

  // #2348: a rule a phone creates names that phone, so revoking it or
  // narrowing its access cancels the rule; an update leaves the stored one be.
  it("names the phone on a rule it creates, and only then", async () => {
    await ask({ type: "create", schedule: { enabled: true, message: "Nightly review", rule: stored.rule } }, "device-1");
    const created = vi.mocked(invoke).mock.calls.find(([command]) => command === "agent_schedule_upsert");
    expect((created?.[1] as { schedule: Record<string, unknown> }).schedule).toMatchObject({ message: "Nightly review", phone_device: "device-1" });

    vi.mocked(invoke).mockClear();
    await ask({ type: "update", schedule_id: stored.id, schedule: { enabled: true, message: "Edited", rule: stored.rule } }, "device-2");
    const updated = vi.mocked(invoke).mock.calls.find(([command]) => command === "agent_schedule_upsert");
    expect((updated?.[1] as { schedule: Record<string, unknown> }).schedule).not.toHaveProperty("phone_device");
  });
});
