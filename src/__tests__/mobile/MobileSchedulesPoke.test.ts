// The Mobile host's `refresh` poke for the `schedules` slice (a proposal a
// headless agent tab made, `docs/headless_mcp_plan.md`) must reach the window
// the way its own MCP listener's notice does: as `agent-schedules-changed`,
// which `AgentScheduleHost` (layout + tick) and every popout listen to.
import { emit } from "@tauri-apps/api/event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(), emit: vi.fn() }));
vi.mock("../../components/files/useAlertsFeed", () => ({ useAlertsFeed: () => ({ enabled: false, items: [] }) }));

import { emitSchedulesChanged } from "../../components/mobile/MobileBridgeHost";
import { useAgentSchedulesStore } from "../../stores/agents/agentSchedules";

describe("the schedules poke", () => {
  afterEach(() => vi.restoreAllMocks());

  it("broadcasts the window's own schedules event", async () => {
    vi.mocked(emit).mockResolvedValue(undefined);
    const reread = vi.spyOn(useAgentSchedulesStore.getState(), "refreshLoaded");
    await emitSchedulesChanged();
    expect(emit).toHaveBeenCalledWith("agent-schedules-changed");
    expect(reread).not.toHaveBeenCalled();
  });

  it("still re-reads this window's rows when the event cannot be sent", async () => {
    vi.mocked(emit).mockRejectedValue(new Error("no IPC"));
    const reread = vi.spyOn(useAgentSchedulesStore.getState(), "refreshLoaded").mockResolvedValue(undefined);
    await emitSchedulesChanged();
    expect(reread).toHaveBeenCalledTimes(1);
  });
});
