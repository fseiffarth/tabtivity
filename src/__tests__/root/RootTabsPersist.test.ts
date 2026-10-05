/**
 * The root scope's tabs persist and restore across a relaunch, exactly like a
 * project's — they were long excluded (`persistScope` sent `projectId: null` for
 * `"root"`, which the backend treats as "persist nothing"), so a shell, a Files
 * tab or a file viewer opened at the root control terminal was gone on the next
 * launch. Now root keys its layout under the literal `"root"` id in the state dir.
 *
 * Two things are locked here:
 *  - persistScope("root", "") sends `projectId: "root"` (never null), so the
 *    backend writes `<state_dir>/sessions/root/terminals.json`.
 *  - the auto-seeded 3D-blob (`projects3d`, root-only, never restorable) does NOT
 *    keep a root pinned as "non-empty": a root holding only it vouches for an
 *    empty save, so a root cleared back to its default stops resurrecting its old
 *    tabs on every relaunch.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

import { useTabsStore, BLOB_TAB_CMD, type TabEntry } from "../../stores/tabs";
import { BRAND } from "../../lib/brand";

const invokeMock = vi.mocked(invoke);

function shellTab(over: Partial<TabEntry> = {}): TabEntry {
  return {
    key: "shell-1",
    label: "Shell",
    cmd: "bash",
    args: [],
    env: {},
    cwd: `/home/u/${BRAND.slug}/root`,
    kind: "shell",
    scope: "root",
    ...over,
  } as TabEntry;
}

function blobTab(): TabEntry {
  return {
    key: "blob-1",
    label: "Projects",
    cmd: BLOB_TAB_CMD,
    args: [],
    env: {},
    cwd: "",
    kind: "projects3d",
    scope: "root",
  } as TabEntry;
}

/** Seed the root scope with the given tabs (hydrated). */
function seedRoot(tabs: TabEntry[]) {
  useTabsStore.setState({
    scope: "root",
    tabsByScope: { root: tabs },
    layoutByScope: { root: null },
    focusedGroupByScope: { root: null },
    detachedGroupsByScope: {},
    tabs,
    layout: null,
    focusedGroupId: null,
    activeKey: null,
  });
}

/** The last save_tab_layout invoke's projectId + tabs + allowClear. */
function lastSave() {
  const call = invokeMock.mock.calls.find((c) => c[0] === "workspace_sync");
  if (!call) return null;
  const arg = call[1] as { projectId: unknown; tabs: unknown[]; allowClear: boolean };
  return { projectId: arg.projectId, tabs: arg.tabs, allowClear: arg.allowClear };
}

beforeEach(() => {
  invokeMock.mockClear();
});

describe("persistScope — the root scope persists like a project", () => {
  it("keys the root layout under the \"root\" id, never null", async () => {
    seedRoot([shellTab()]);
    await useTabsStore.getState().persistScope("root", "");

    const save = lastSave();
    expect(save?.projectId).toBe("root");
    expect(save?.tabs).toHaveLength(1);
  });

  it("treats a root holding only the seeded 3D-blob as empty (vouches for a clear)", async () => {
    // The blob is Tabtivity's own default tab: not restorable, never persisted. A
    // root at only its default IS empty, so it must license the clear — otherwise
    // a root closed back to default would resurrect its old tabs next launch.
    seedRoot([blobTab()]);
    await useTabsStore.getState().persistScope("root", "");

    const save = lastSave();
    expect(save?.tabs).toEqual([]);
    expect(save?.allowClear).toBe(true);
  });

  it("still persists real root tabs even beside the blob", async () => {
    seedRoot([blobTab(), shellTab()]);
    await useTabsStore.getState().persistScope("root", "");

    const save = lastSave();
    // The blob is filtered out (non-restorable); the shell survives.
    expect(save?.tabs).toHaveLength(1);
    expect((save?.tabs[0] as { kind?: string }).kind).toBe("shell");
    expect(save?.allowClear).toBe(false);
  });
});
