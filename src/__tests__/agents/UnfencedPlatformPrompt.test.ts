/**
 * Windows has no agent fence, so `pty_spawn` refuses every local agent there
 * until the user has accepted, once, that agents run with their full rights.
 * The refused tab asks through `unfencedPlatformPrompt`; these pin the store's
 * bargain: one question for every tab asking at once (a restored session opens
 * several), an answer that is persisted before any tab is released, a decline
 * that starts nothing, and — as with the HPC guard (#233) — a refusal rather
 * than a hang when no dialog is mounted in this window.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { updateSettings } = vi.hoisted(() => ({
  updateSettings: vi.fn((_patch: unknown): Promise<void> => Promise.resolve()),
}));
vi.mock("../../stores/settings", () => ({
  useSettingsStore: { getState: () => ({ updateSettings }) },
}));

import { useUnfencedPlatformStore } from "../../stores/unfencedPlatformPrompt";
import { unfencedPlatformRefusal } from "../../lib/agents/agentFence";
import { BRAND } from "../../lib/brand";

describe("unfenced-platform acceptance", () => {
  beforeEach(() => {
    useUnfencedPlatformStore.setState({ waiting: [], hosts: 0 });
    updateSettings.mockClear();
  });

  it("recognises only the backend's sentinel", () => {
    expect(
      unfencedPlatformRefusal(
        `${BRAND.envPrefix}FENCE_PLATFORM_UNACCEPTED Agent sandbox: Windows has no agent sandbox, so this agent would run with your full rights.`,
      ),
    ).toBe(true);
    expect(unfencedPlatformRefusal(new Error(`${BRAND.envPrefix}FENCE_PLATFORM_UNACCEPTED …`))).toBe(true);
    expect(unfencedPlatformRefusal("Agent sandbox: bubblewrap is unavailable")).toBe(false);
    expect(unfencedPlatformRefusal(`${BRAND.envPrefix}HPC_GUARD connect u@h:22`)).toBe(false);
  });

  it("refuses at once when no dialog is mounted in this window", async () => {
    await expect(useUnfencedPlatformStore.getState().request()).resolves.toBe(false);
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("persists the acceptance once, then releases every tab that asked", async () => {
    const drop = useUnfencedPlatformStore.getState().registerHost();
    const first = useUnfencedPlatformStore.getState().request();
    const second = useUnfencedPlatformStore.getState().request();
    expect(useUnfencedPlatformStore.getState().waiting).toHaveLength(2);

    await useUnfencedPlatformStore.getState().accept();
    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(updateSettings).toHaveBeenCalledWith({ agent_fence_platform_accepted: true });
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    expect(useUnfencedPlatformStore.getState().waiting).toHaveLength(0);
    drop();
  });

  it("answers no on cancel and writes nothing", async () => {
    const drop = useUnfencedPlatformStore.getState().registerHost();
    const answer = useUnfencedPlatformStore.getState().request();
    useUnfencedPlatformStore.getState().cancel();
    await expect(answer).resolves.toBe(false);
    expect(updateSettings).not.toHaveBeenCalled();
    drop();
  });

  it("answers no when the acceptance could not be saved", async () => {
    // The backend still refuses, so releasing the tab would only reprint the
    // refusal; "no" lets the pane say what did not happen.
    updateSettings.mockRejectedValueOnce(new Error("disk full"));
    const drop = useUnfencedPlatformStore.getState().registerHost();
    const answer = useUnfencedPlatformStore.getState().request();
    await useUnfencedPlatformStore.getState().accept();
    await expect(answer).resolves.toBe(false);
    drop();
  });
});
