/**
 * The "Files (Project)" tab kind — the side panel's file view hosted in a tab.
 * Two things must hold for it, and neither is visible from the pane itself:
 * the tab is recovered from its bare command on restore (a persisted layout
 * stores `cmd`, and a kind Tabtivity can't recover would come back a shell), and
 * the folder it was opened on is part of what survives — the whole point of
 * "Open in a new tab" on a folder is that the tab IS that folder.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

import {
  PROJECT_FILES_TAB_CMD,
  cmdToKind,
  isRestorableKind,
  isRestorableTab,
  useTabsStore,
  type GroupNode,
} from "../../stores/tabs";
import { tabCommand } from "../../lib/brand";

const invokeMock = vi.mocked(invoke);

describe("projectfiles tab kind", () => {
  it("recovers its kind from the bare command", () => {
    expect(cmdToKind(PROJECT_FILES_TAB_CMD)).toBe("projectfiles");
    // The separate FileBrowser tab keeps its own command and kind.
    expect(cmdToKind(tabCommand("files"))).toBe("files");
  });

  it("survives a restart (a pure frontend pane, like the files tab)", () => {
    expect(isRestorableKind("projectfiles")).toBe(true);
    expect(
      isRestorableTab({ kind: "projectfiles", cmd: PROJECT_FILES_TAB_CMD }),
    ).toBe(true);
  });
});

describe("a projectfiles tab's browsed folder", () => {
  beforeEach(() => {
    invokeMock.mockClear();
    useTabsStore.setState({
      scope: "p1",
      tabs: [
        {
          key: "f1",
          scope: "p1",
          label: "src",
          cmd: PROJECT_FILES_TAB_CMD,
          cwd: "/p/p1",
          kind: "projectfiles",
          folder: "src",
        },
      ],
      activeKey: "f1",
      layout: { type: "group", id: "g1", tabKeys: ["f1"], activeKey: "f1" } as GroupNode,
      focusedGroupId: "g1",
      tabsByScope: {
        p1: [
          {
            key: "f1",
            scope: "p1",
            label: "src",
            cmd: PROJECT_FILES_TAB_CMD,
            cwd: "/p/p1",
            kind: "projectfiles",
            folder: "src",
          },
        ],
      },
      layoutByScope: {
        p1: { type: "group", id: "g1", tabKeys: ["f1"], activeKey: "f1" } as GroupNode,
      },
      focusedGroupByScope: { p1: "g1" },
    });
  });

  it("setTabFolder records a navigation, and is a no-op when unchanged", () => {
    const before = useTabsStore.getState().tabs;
    useTabsStore.getState().setTabFolder("f1", "src");
    // Unchanged → the tabs array is not churned (which would wake saveLayout).
    expect(useTabsStore.getState().tabs).toBe(before);

    useTabsStore.getState().setTabFolder("f1", "src/components");
    expect(useTabsStore.getState().tabs[0].folder).toBe("src/components");
  });

  it("persists the folder, and restores the tab on it", async () => {
    await useTabsStore.getState().saveLayout("/p/p1/project.json");
    const saved = invokeMock.mock.calls.find(([cmd]) => cmd === "workspace_sync");
    expect(saved).toBeTruthy();
    const layout = (saved![1] as { tabs: Array<Record<string, unknown>> }).tabs;
    expect(layout).toHaveLength(1);
    expect(layout[0]).toMatchObject({ kind: "projectfiles", folder: "src" });

    useTabsStore.getState().loadFromLayout(
      layout as never,
      "/p/p1",
      "p1",
      { type: "group", id: "g1", tabKeys: [String(layout[0].key)], activeKey: String(layout[0].key) } as never,
    );
    const restored = useTabsStore.getState().tabs[0];
    expect(restored.kind).toBe("projectfiles");
    expect(restored.folder).toBe("src");
  });
});
