/**
 * A list read that was already in flight when a write finished must not paint
 * its older answer over the write's result. The upsert/remove commands answer
 * with the new list; a slower `list` that left before the write would otherwise
 * bring the old rows back until the next refresh.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

import type { ScheduledAgentPrompt } from "../../lib/agents/agentSchedule";
import { useAgentPromptsStore, type ProjectAgentPrompt } from "../../stores/agents/agentPrompts";
import { scheduleCacheKey, useAgentSchedulesStore } from "../../stores/agents/agentSchedules";

const invokeMock = vi.mocked(invoke);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const prompt = (id: string, message: string) => ({ id, message }) as unknown as ProjectAgentPrompt;
const schedule = (id: string, message: string): ScheduledAgentPrompt => ({
  id,
  enabled: true,
  message,
  rule: { type: "once", at: "2026-09-04T13:00" },
});

beforeEach(() => {
  invokeMock.mockReset();
  useAgentPromptsStore.setState({ byProject: {}, loading: {} });
  useAgentSchedulesStore.setState({ byTarget: {}, loading: {} });
});

describe("agent prompts: load vs upsert", () => {
  it("keeps the upsert's list when an older load answers after it", async () => {
    const oldList = deferred<ProjectAgentPrompt[]>();
    const fresh = [prompt("a", "old"), prompt("b", "new")];
    invokeMock.mockImplementation((command: string) =>
      command === "agent_prompts_list" ? oldList.promise : Promise.resolve(fresh));
    const loading = useAgentPromptsStore.getState().load("p");
    await useAgentPromptsStore.getState().upsert("p", { id: "b", message: "new" });
    oldList.resolve([prompt("a", "old")]);
    await loading;
    expect(useAgentPromptsStore.getState().byProject.p).toEqual(fresh);
    expect(useAgentPromptsStore.getState().loading.p).toBe(false);
  });

  it("still takes a load that starts after the write", async () => {
    invokeMock.mockImplementation((command: string) =>
      Promise.resolve(command === "agent_prompts_list" ? [prompt("c", "later")] : [prompt("b", "new")]));
    await useAgentPromptsStore.getState().upsert("p", { id: "b", message: "new" });
    await useAgentPromptsStore.getState().load("p");
    expect(useAgentPromptsStore.getState().byProject.p).toEqual([prompt("c", "later")]);
  });
});

describe("agent schedules: load vs upsert", () => {
  it("keeps the upsert's list when an older load answers after it", async () => {
    const oldList = deferred<ScheduledAgentPrompt[]>();
    const fresh = [schedule("a", "old"), schedule("b", "new")];
    invokeMock.mockImplementation((command: string) =>
      command === "agent_schedules_list" ? oldList.promise : Promise.resolve(fresh));
    const key = scheduleCacheKey("p", "t");
    const loading = useAgentSchedulesStore.getState().load("p", "t");
    await useAgentSchedulesStore.getState().upsert("p", "t", schedule("b", "new"));
    oldList.resolve([schedule("a", "old")]);
    await loading;
    expect(useAgentSchedulesStore.getState().byTarget[key]).toEqual(fresh);
    expect(useAgentSchedulesStore.getState().loading[key]).toBe(false);
  });

  it("keeps a removal when an older load answers after it", async () => {
    const key = scheduleCacheKey("p", "t");
    useAgentSchedulesStore.setState({ byTarget: { [key]: [schedule("a", "x")] } });
    const oldList = deferred<ScheduledAgentPrompt[]>();
    invokeMock.mockImplementation((command: string) =>
      command === "agent_schedules_list" ? oldList.promise : Promise.resolve());
    const loading = useAgentSchedulesStore.getState().load("p", "t");
    await useAgentSchedulesStore.getState().remove("p", "t", "a");
    oldList.resolve([schedule("a", "x")]);
    await loading;
    expect(useAgentSchedulesStore.getState().byTarget[key]).toEqual([]);
  });
});
