/**
 * The subagent count on the phone's tab cards: answered from the last count
 * at once, re-counted for the next poll, a still transcript answered by its
 * version, and only for Claude — the one CLI whose record says.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { clearMobileSubagentCountsForTest, mobileSubagentCount } from "../../lib/mobileSubagents";
import type { TabEntry } from "../../stores/tabs";

const tab = (cmd: string, sessionId?: string) => ({ key: "t1", cmd, sessionId, kind: "agent" }) as unknown as TabEntry;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("mobileSubagentCount", () => {
  beforeEach(() => {
    clearMobileSubagentCountsForTest();
    vi.mocked(invoke).mockReset();
  });

  it("answers the last count and re-counts at most once per floor", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ available: true, version: "v1", entries: [], truncated: false, runningAgents: 2 });
    expect(mobileSubagentCount("p", tab("claude", "s1"), 0)).toBe(0);
    await flush();
    expect(invoke).toHaveBeenCalledWith("agent_tab_transcript", expect.objectContaining({ agent: "claude", projectId: "p", sessionId: "s1", version: null, limit: 1 }));
    expect(mobileSubagentCount("p", tab("claude", "s1"), 5_000)).toBe(2);
    expect(invoke).toHaveBeenCalledTimes(1);

    // Past the floor the version goes back, and an unchanged file keeps the count.
    vi.mocked(invoke).mockResolvedValueOnce({ available: true, version: "v1", unchanged: true, entries: [], truncated: false });
    expect(mobileSubagentCount("p", tab("claude", "s1"), 10_000)).toBe(2);
    await flush();
    expect(invoke).toHaveBeenLastCalledWith("agent_tab_transcript", expect.objectContaining({ version: "v1" }));
    expect(mobileSubagentCount("p", tab("claude", "s1"), 15_000)).toBe(2);

    // A changed file without the field has none at work.
    vi.mocked(invoke).mockResolvedValueOnce({ available: true, version: "v2", entries: [], truncated: false });
    mobileSubagentCount("p", tab("claude", "s1"), 20_000);
    await flush();
    expect(mobileSubagentCount("p", tab("claude", "s1"), 21_000)).toBe(0);
  });

  it("never reads for another CLI or a tab with no session yet", () => {
    expect(mobileSubagentCount("p", tab("codex", "s1"))).toBe(0);
    expect(mobileSubagentCount("p", tab("claude"))).toBe(0);
    expect(invoke).not.toHaveBeenCalled();
  });
});
