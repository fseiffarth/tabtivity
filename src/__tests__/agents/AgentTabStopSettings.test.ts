import { describe, expect, it } from "vitest";
import {
  stopAgentTabsCap,
  stopAgentTabsIdleMs,
  stopAgentTabsMinFreeBytes,
} from "../../lib/agents/agentTabStop";
import type { Settings } from "../../types";

const s = (v: Partial<Settings>) => v as Settings;

describe("stop-agent-tab settings readers", () => {
  it("reads the defaults when the fields are absent", () => {
    expect(stopAgentTabsCap(undefined)).toBe(30);
    expect(stopAgentTabsIdleMs(s({}))).toBe(120 * 60_000);
    expect(stopAgentTabsMinFreeBytes(null)).toBe(4096 * 1024 * 1024);
  });

  it("reads 0 as off", () => {
    const off = s({ stop_agent_tabs_cap: 0, stop_agent_tabs_idle_min: 0, stop_agent_tabs_min_free_mb: 0 });
    expect(stopAgentTabsCap(off)).toBeNull();
    expect(stopAgentTabsIdleMs(off)).toBeNull();
    expect(stopAgentTabsMinFreeBytes(off)).toBeNull();
  });

  it("reads a chosen value", () => {
    const on = s({ stop_agent_tabs_cap: 10, stop_agent_tabs_idle_min: 30, stop_agent_tabs_min_free_mb: 2048 });
    expect(stopAgentTabsCap(on)).toBe(10);
    expect(stopAgentTabsIdleMs(on)).toBe(30 * 60_000);
    expect(stopAgentTabsMinFreeBytes(on)).toBe(2048 * 1024 * 1024);
  });

  it("reads junk as the default", () => {
    const junk = { stop_agent_tabs_cap: -3, stop_agent_tabs_idle_min: Number.NaN, stop_agent_tabs_min_free_mb: "8" } as unknown as Settings;
    expect(stopAgentTabsCap(junk)).toBe(30);
    expect(stopAgentTabsIdleMs(junk)).toBe(120 * 60_000);
    expect(stopAgentTabsMinFreeBytes(junk)).toBe(4096 * 1024 * 1024);
  });
});
