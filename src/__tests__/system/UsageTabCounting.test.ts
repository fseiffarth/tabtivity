/**
 * Locks which tabs the usage recap counts as "opened".
 *
 * Counting lives in `addTab` rather than at the backend's `pty_spawn` because the
 * spawn fires again for every resumable agent tab respawned on relaunch — so
 * counting there would report a fresh "agent tab opened" each morning for tabs
 * opened days ago. That makes two things load-bearing and easy to regress:
 *
 *  - `loadFromLayout` (restore) must NOT go through `addTab`.
 *  - the root scope's auto-seeded 3D-blob tab must opt out — Tabtivity opened it,
 *    not the user.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import { useTabsStore, BLOB_TAB_CMD } from "../../stores/tabs";
import { _pendingUsageForTest, _resetUsageForTest } from "../../stores/usage";
import { METRIC } from "../../lib/usageMetrics";
import { BRAND, envName } from "../../lib/brand";

function counters(scope: string): Record<string, number> {
  return _pendingUsageForTest()[scope] ?? {};
}

beforeEach(() => {
  _resetUsageForTest();
  useTabsStore.setState({
    scope: "p1",
    tabsByScope: {},
    layoutByScope: {},
    focusedGroupByScope: {},
  });
});

describe("agent tab opens", () => {
  it("counts a cloud agent tab under its command", () => {
    useTabsStore.getState().addTab({ label: "Claude", cmd: "claude", cwd: "/p", kind: "agent" });

    expect(counters("p1")[`${METRIC.AGENT_TAB}.claude`]).toBe(1);
    expect(counters("p1")[METRIC.TAB_OPENED]).toBe(1);
  });

  it("counts a local agent tab under its MODEL", () => {
    useTabsStore.getState().addTab({
      label: "qwen3:8b",
      cmd: "vibe",
      cwd: "/p",
      kind: "local_agent",
      env: { [envName("LOCAL_MODEL")]: "qwen3:8b" },
    });

    expect(counters("p1")[`${METRIC.AGENT_TAB_LOCAL}.qwen3:8b`]).toBe(1);
    // ...and NOT as a "vibe" agent, which is merely the driver.
    expect(counters("p1")[`${METRIC.AGENT_TAB}.vibe`]).toBeUndefined();
  });

  it("counts a shell tab as a tab but not as an agent", () => {
    useTabsStore.getState().addTab({ label: "Shell", cmd: "bash", cwd: "/p", kind: "shell" });

    expect(counters("p1")[METRIC.TAB_OPENED]).toBe(1);
    expect(counters("p1")[`${METRIC.AGENT_TAB}.bash`]).toBeUndefined();
  });

  it("attributes a tab added to another scope to THAT scope", () => {
    useTabsStore.getState().addTabToScope("p2", {
      label: "Codex", cmd: "codex", cwd: "/p2", kind: "agent",
    });

    expect(counters("p2")[`${METRIC.AGENT_TAB}.codex`]).toBe(1);
    expect(counters("p1")).toEqual({});
  });
});

describe(`tabs ${BRAND.display} opens by itself`, () => {
  it("does not count the auto-seeded root 3D-blob tab", () => {
    useTabsStore.setState({ scope: "root" });
    useTabsStore.getState().addTab(
      { label: "Projects", cmd: BLOB_TAB_CMD, cwd: "", kind: "projects3d" },
      { seeded: true },
    );

    // The user did not open this; the recap must not claim they did.
    expect(counters("root")).toEqual({});
  });
});

describe("restore", () => {
  it("does not count tabs restored from a saved layout", () => {
    // The whole reason counting lives in addTab: a restored Claude tab was opened
    // days ago, and must not read as a fresh agent tab every launch.
    useTabsStore.getState().loadFromLayout(
      [
        { key: "agent-1", label: "Claude", cmd: "claude", cwd: "/p", kind: "agent", sessionId: "s1" },
        { key: "shell-1", label: "Shell", cmd: "bash", cwd: "/p", kind: "shell" },
      ],
      "/p",
      "p1",
    );

    expect(useTabsStore.getState().tabsByScope["p1"]).toHaveLength(2);
    expect(counters("p1")).toEqual({});
  });
});

describe("tab closes", () => {
  it("counts a close", () => {
    const tab = useTabsStore.getState().addTab({
      label: "Shell", cmd: "bash", cwd: "/p", kind: "shell",
    });
    useTabsStore.getState().removeTab(tab.key);

    expect(counters("p1")[METRIC.TAB_CLOSED]).toBe(1);
  });
});
