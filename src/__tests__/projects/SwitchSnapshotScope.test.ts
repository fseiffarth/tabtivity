/**
 * Regression: project→tab leak on switch (#55 save side).
 *
 * `setActive` used to read the outgoing project's tab snapshot AFTER an
 * `await invoke("save_projects")`. That await yields to the event loop, letting
 * a re-render move the tabs store to the NEW scope (via CenterPanel's
 * setScope(id)), so the snapshot captured the NEW project's tabs and persisted
 * them into the PREVIOUS project's project.json — leaking one project's tabs
 * into another's file.
 *
 * The fix snapshots the outgoing scope SYNCHRONOUSLY from the scope-keyed maps
 * and drops any tab not owned by that scope. These tests simulate the drift by
 * pointing the live `scope` at the NEW project before the switch resolves, and
 * by planting a foreign tab in the outgoing scope.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ProjectEntry } from "../../types";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

import { useProjectsStore } from "../../stores/projects";
import { useTabsStore, type TabEntry, type GroupNode } from "../../stores/tabs";
import { BRAND } from "../../lib/brand";

function proj(id: string, position: number, status = "active"): ProjectEntry {
  return { id, name: id, status, position, local_file: `/p/${id}/project.json` };
}

function shellTab(key: string, scope: string, label: string): TabEntry {
  return { key, scope, label, cmd: "", cwd: `/p/${scope}`, kind: "shell" };
}

function group(id: string, tabKeys: string[]): GroupNode {
  return { type: "group", id, tabKeys, activeKey: tabKeys[0] ?? null };
}

/** Pull the previousSnapshot tab labels from the switch_project_runtime call. */
function snapshotLabels(): string[] {
  const call = invoke.mock.calls.find((c) => c[0] === "switch_project_runtime");
  const payload = call?.[1] as { previousSnapshot: { tabLayout: { label: string }[] } };
  return payload.previousSnapshot.tabLayout.map((t) => t.label);
}

/** The raw previousSnapshot tab entries (for asserting field preservation). */
function snapshotTabs(): Array<Record<string, unknown>> {
  const call = invoke.mock.calls.find((c) => c[0] === "switch_project_runtime");
  const payload = call?.[1] as {
    previousSnapshot: { tabLayout: Array<Record<string, unknown>> };
  };
  return payload.previousSnapshot.tabLayout;
}

describe("setActive — snapshots the PREVIOUS scope, not the drifted current one", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
    useProjectsStore.setState({ projects: [proj("a", 10, "current"), proj("b", 20)], activeId: "a" });
  });

  it("persists project A's tabs to A even after scope has drifted to B", async () => {
    // A owns one tab; B owns a different one. Simulate the post-await drift:
    // the tabs store is ALREADY on scope B (its flat mirror = B's tabs).
    useTabsStore.setState({
      scope: "b",
      tabs: [shellTab("tb1", "b", "B-shell")],
      activeKey: "tb1",
      layout: group("gb", ["tb1"]),
      tabsByScope: {
        a: [shellTab("ta1", "a", "A-shell")],
        b: [shellTab("tb1", "b", "B-shell")],
      },
      layoutByScope: { a: group("ga", ["ta1"]), b: group("gb", ["tb1"]) },
      focusedGroupByScope: { a: "ga", b: "gb" },
    });

    await useProjectsStore.getState().setActive("b");

    // Previous = A → its file must receive A's tab, never B's (the leak).
    const call = invoke.mock.calls.find((c) => c[0] === "switch_project_runtime");
    expect((call?.[1] as { previousProjectId: string }).previousProjectId).toBe("a");
    expect(snapshotLabels()).toEqual(["A-shell"]);
  });

  it("drops a foreign tab planted in the outgoing scope (ownership filter)", async () => {
    // A's scope contains a stray tab stamped for B — must never be persisted to A.
    useTabsStore.setState({
      scope: "a",
      tabs: [shellTab("ta1", "a", "A-shell"), shellTab("tb1", "b", "STRAY-B")],
      activeKey: "ta1",
      layout: group("ga", ["ta1", "tb1"]),
      tabsByScope: { a: [shellTab("ta1", "a", "A-shell"), shellTab("tb1", "b", "STRAY-B")] },
      layoutByScope: { a: group("ga", ["ta1", "tb1"]) },
      focusedGroupByScope: { a: "ga" },
    });

    await useProjectsStore.getState().setActive("b");

    expect(snapshotLabels()).toEqual(["A-shell"]);
  });

  it("carries the persisted tmux fields through the switch (reattach, not fork)", async () => {
    // The switch snapshot OVERWRITES the outgoing project's terminals.json — the
    // very file `loadFromLayout` reads on the next relaunch. If it drops
    // `tmuxSession`, restore mints a fresh name and `tmux new-session -A` forks a
    // SECOND remote session instead of reattaching the running one. So the snapshot
    // must stay in step with `persistScope`'s field set.
    const remoteShell: TabEntry = {
      ...shellTab("ta1", "a", "A-shell"),
      location: "remote",
      tmuxSession: `${BRAND.slug}-a--shell-fixed-uuid`,
      hostBoundUid: "hb-1",
      ephemeral: true,
    };
    const attachTab: TabEntry = {
      ...shellTab("ta2", "a", "A-attach"),
      location: "remote",
      tmuxAttach: "train",
    };
    useTabsStore.setState({
      scope: "a",
      tabs: [remoteShell, attachTab],
      activeKey: "ta1",
      layout: group("ga", ["ta1", "ta2"]),
      tabsByScope: { a: [remoteShell, attachTab] },
      layoutByScope: { a: group("ga", ["ta1", "ta2"]) },
      focusedGroupByScope: { a: "ga" },
    });

    await useProjectsStore.getState().setActive("b");

    const [shell, attach] = snapshotTabs();
    expect(shell.tmuxSession).toBe(`${BRAND.slug}-a--shell-fixed-uuid`);
    expect(shell.hostBoundUid).toBe("hb-1");
    expect(shell.ephemeral).toBe(true);
    expect(attach.tmuxAttach).toBe("train");
  });
});
