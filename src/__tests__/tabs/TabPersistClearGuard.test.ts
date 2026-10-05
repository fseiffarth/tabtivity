/**
 * An empty layout must not be able to erase a saved one.
 *
 * Saving empty is destructive on the backend: it drops `tab_layout` + `tab_groups`
 * from project.json AND overwrites the `.tabtivity` session mirror, both from the same
 * array in the same call — so the mirror is no backup, and a resumable agent tab's
 * `sessionId` (the only handle on its conversation) goes with them.
 *
 * The live bug (DemoProj, four tabs incl. three Claude conversations): the debounced
 * autosave persisted the tab store's CURRENT scope into the ACTIVE project's
 * `local_file`, two independently tracked values. Detach swaps `local_file` (remote
 * state dir → promoted mirror) under a store whose scope hasn't caught up; the
 * per-scope filter then correctly refuses to write the other scope's tabs into that
 * file, and what reaches the backend is `[]` — indistinguishable from a deliberate
 * close-all, and fatal.
 *
 * So the frontend must now VOUCH for an empty save (`allowClear`), and it can only do
 * that for a scope it actually hydrated which genuinely holds no tabs. These tests
 * lock that down; `save_empty_tabs_preserves_layout_when_clearing_is_not_allowed`
 * (services_tests.rs) locks down the backend honouring it.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

import { useTabsStore, type TabEntry } from "../../stores/tabs";

const invokeMock = vi.mocked(invoke);
const LOCAL_FILE = "/p/project.json";

function agentTab(over: Partial<TabEntry> = {}): TabEntry {
  return {
    key: "agent-2",
    label: "Claude",
    cmd: "claude",
    args: [],
    env: {},
    cwd: "/p",
    kind: "agent",
    scope: "pid",
    sessionId: "6252990e-a459-46c6-8c43-f1d2f68dc4b3",
    ...over,
  } as TabEntry;
}

/** Seed the store, optionally leaving the scope entirely UN-hydrated. */
function seed(tabs: TabEntry[] | undefined) {
  useTabsStore.setState({
    scope: "pid",
    tabsByScope: tabs === undefined ? {} : { pid: tabs },
    layoutByScope: { pid: null },
    focusedGroupByScope: { pid: null },
    detachedGroupsByScope: {},
    tabs: tabs ?? [],
    layout: null,
    focusedGroupId: null,
    activeKey: null,
  });
}

/** The `allowClear` flag on the save_tab_layout invoke, plus the tabs it sent. */
function lastSave() {
  const call = invokeMock.mock.calls.find((c) => c[0] === "workspace_sync");
  if (!call) return null;
  const arg = call[1] as { tabs: unknown[]; allowClear: boolean };
  return { tabs: arg.tabs, allowClear: arg.allowClear };
}

beforeEach(() => {
  invokeMock.mockClear();
});

describe("persistScope — an empty layout only clears when it is meant", () => {
  it("vouches for the empty save when a hydrated scope genuinely holds no tabs", async () => {
    // The user closed the last tab. This is a real close-all and must persist.
    seed([]);
    await useTabsStore.getState().persistScope("pid", LOCAL_FILE);

    expect(lastSave()).toEqual({ tabs: [], allowClear: true });
  });

  it("refuses to vouch for a scope it never hydrated", async () => {
    // Nothing was ever restored for `pid` — its emptiness is ignorance, not intent.
    // (A project whose restore finds no restorable tabs never creates the scope key.)
    seed(undefined);
    await useTabsStore.getState().persistScope("pid", LOCAL_FILE);

    expect(lastSave()).toEqual({ tabs: [], allowClear: false });
  });

  it("refuses to vouch when the scope holds tabs that all get filtered out", async () => {
    // THE DemoProj CASE. The scope holds tabs, but every one of them belongs to a
    // different scope — the pairing drifted — so the keep-filter drops them all and
    // the persisted layout comes out empty. It looks exactly like a close-all. It is
    // not one, and it must never erase the three Claude conversations on disk.
    seed([agentTab({ scope: "a-different-project" })]);
    await useTabsStore.getState().persistScope("pid", LOCAL_FILE);

    const save = lastSave();
    expect(save?.tabs).toEqual([]);
    expect(save?.allowClear).toBe(false);
  });

  it("still persists a real layout, and carries the agent's sessionId", async () => {
    seed([agentTab()]);
    await useTabsStore.getState().persistScope("pid", LOCAL_FILE);

    const save = lastSave();
    expect(save?.tabs).toHaveLength(1);
    expect((save?.tabs[0] as { sessionId?: string }).sessionId).toBe(
      "6252990e-a459-46c6-8c43-f1d2f68dc4b3",
    );
    // Non-empty saves are unaffected by the guard either way.
    expect(save?.allowClear).toBe(false);
  });
});
