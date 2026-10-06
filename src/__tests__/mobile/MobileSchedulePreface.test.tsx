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
import { sendCollectedPrompt } from "../../stores/agents/agentPrompts";
import { localOccurrenceKey } from "../../lib/agents/agentSchedule";

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

async function deliverRequest(request: Record<string, unknown>, deviceId?: string) {
  const listener = vi.mocked(listen).mock.calls.find(([name]) => name === NAMES.mobileDesktopEvent);
  const deliver = listener![1] as (event: { payload: unknown }) => void;
  await act(async () => {
    deliver({ payload: { ...request, ...(deviceId ? { device_id: deviceId } : {}) } });
    await vi.waitFor(() => expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "mobile_desktop_respond")).toBe(true));
  });
}

async function ask(action: Record<string, unknown>, deviceId?: string) {
  await deliverRequest({
    type: "schedule_mutate",
    request_id: "schedule-request",
    project_id: project.id,
    tmux_session: tmuxSession,
    action,
  }, deviceId);
}

function lastPayload(command: string): Record<string, unknown> | undefined {
  const calls = vi.mocked(invoke).mock.calls.filter(([name]) => name === command);
  return calls[calls.length - 1]?.[1] as Record<string, unknown> | undefined;
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

  // #2348: a rule a phone creates or edits names that phone, so revoking it
  // or narrowing its access cancels the rule — an edit takes a desktop rule
  // over. A request naming no phone (an older sidecar) leaves the stored one
  // to the backend, which keeps it.
  it("names the phone on a rule it creates or edits", async () => {
    await ask({ type: "create", schedule: { enabled: true, message: "Nightly review", rule: stored.rule } }, "device-1");
    const created = vi.mocked(invoke).mock.calls.find(([command]) => command === "agent_schedule_upsert");
    expect((created?.[1] as { schedule: Record<string, unknown> }).schedule).toMatchObject({ message: "Nightly review", phone_device: "device-1" });

    vi.mocked(invoke).mockClear();
    await ask({ type: "update", schedule_id: stored.id, schedule: { enabled: true, message: "Edited", rule: stored.rule } }, "device-2");
    const updated = vi.mocked(invoke).mock.calls.find(([command]) => command === "agent_schedule_upsert");
    expect((updated?.[1] as { schedule: Record<string, unknown> }).schedule).toMatchObject({ message: "Edited", phone_device: "device-2", preface: stored.preface });

    vi.mocked(invoke).mockClear();
    await ask({ type: "update", schedule_id: stored.id, schedule: { enabled: true, message: "Edited again", rule: stored.rule } });
    const unnamed = vi.mocked(invoke).mock.calls.find(([command]) => command === "agent_schedule_upsert");
    expect((unnamed?.[1] as { schedule: Record<string, unknown> }).schedule).not.toHaveProperty("phone_device");
  });

  it("names the phone on a held prompt it rewrites, the desktop's included", async () => {
    const held = { id: "held-1", enabled: true, message: "desk words", rule: { type: "once" as const, at: localOccurrenceKey(new Date()) } };
    vi.mocked(invoke).mockImplementation((command: string) => {
      if (command === "agent_schedules_list") return Promise.resolve([held]);
      if (command === "agent_schedule_upsert") return Promise.resolve([held]);
      return Promise.resolve(undefined);
    });
    await deliverRequest({
      type: "edit_held_prompt",
      request_id: "held-request",
      project_id: project.id,
      tmux_session: tmuxSession,
      held_id: held.id,
      message: "phone words",
    }, "device-1");
    expect(lastPayload("agent_schedule_upsert")?.schedule).toMatchObject({ id: held.id, message: "phone words", phone_device: "device-1" });
  });

  it("names the phone on a collected prompt it writes, and a desktop send carries it", async () => {
    const prompt = { id: "prompt-1", message: "Desk draft", created_at: "t", updated_at: "t" };
    vi.mocked(invoke).mockImplementation((command: string) => {
      if (command === "agent_prompts_list") return Promise.resolve([prompt]);
      if (command === "agent_schedules_list") return Promise.resolve([]);
      return Promise.resolve([]);
    });
    await deliverRequest({
      type: "prompt_mutate",
      request_id: "prompt-request",
      project_id: project.id,
      action: { type: "update", prompt_id: prompt.id, prompt: { message: "Phone words" } },
    }, "device-1");
    expect(lastPayload("agent_prompt_upsert")?.prompt).toMatchObject({ id: prompt.id, message: "Phone words", phone_device: "device-1" });

    // The desktop's own send (no phone asking) names the phone that wrote it.
    vi.mocked(invoke).mockClear();
    await sendCollectedPrompt(project.id, { scheduleTargetId, label: "Claude" }, { ...prompt, phone_device: "device-1" });
    expect(lastPayload("agent_schedule_upsert")?.schedule).toMatchObject({ id: prompt.id, phone_device: "device-1" });
    vi.mocked(invoke).mockClear();
    await sendCollectedPrompt(project.id, { scheduleTargetId, label: "Claude" }, prompt);
    expect(lastPayload("agent_schedule_upsert")?.schedule).not.toHaveProperty("phone_device");
  });
});
