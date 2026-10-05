/**
 * Embed tabs (a file dragged from the FileTree onto a tab bar) come in two
 * shapes: in-app `viewer` embeds (pdf/image/markdown/text) that re-render from
 * their durable `embedPath`, and external-app embeds (`embedExec`) that open the
 * file in another program. Only the in-app viewer embeds survive a restart —
 * restoring an external-app embed would relaunch that app at startup. saveLayout
 * persists viewer embeds (with path + viewer) and drops external ones; the saved
 * tree is pruned to match. These tests lock that in alongside the existing
 * TabPersistFilter coverage.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

import {
  isRestorableKind,
  isRestorableEmbedTab,
  isRestorableTab,
  pruneSavedTree,
  useTabsStore,
  type SavedLayoutTree,
} from "../../stores/tabs";

const invokeMock = vi.mocked(invoke);

describe("embed restorability", () => {
  it("is not restorable by kind alone", () => {
    expect(isRestorableKind("embed")).toBe(false);
  });

  it("an in-app viewer embed is restorable", () => {
    expect(isRestorableEmbedTab({ kind: "embed", viewer: "markdown" })).toBe(true);
    expect(isRestorableTab({ kind: "embed", cmd: "", viewer: "markdown" })).toBe(true);
  });

  it("an external-app embed (exec, no viewer) is NOT restorable", () => {
    expect(isRestorableEmbedTab({ kind: "embed" })).toBe(false);
    expect(isRestorableTab({ kind: "embed", cmd: "" })).toBe(false);
  });
});

describe("pruneSavedTree — embed keys", () => {
  it("drops embed keys not in the keep set", () => {
    const tree: SavedLayoutTree = {
      type: "split",
      dir: "row",
      sizes: [0.5, 0.5],
      children: [
        { type: "group", tabKeys: ["embed-1"], activeKey: "embed-1" },
        { type: "group", tabKeys: ["shell-1", "embed-2"], activeKey: "shell-1" },
      ],
    };
    const pruned = pruneSavedTree(tree, new Set(["shell-1"]));
    expect(pruned).toEqual({ type: "group", tabKeys: ["shell-1"], activeKey: "shell-1" });
  });

  it("keeps embed keys that are in the keep set", () => {
    const tree: SavedLayoutTree = {
      type: "group",
      tabKeys: ["shell-1", "embed-1"],
      activeKey: "shell-1",
    };
    const pruned = pruneSavedTree(tree, new Set(["shell-1", "embed-1"]));
    expect(pruned).toEqual({
      type: "group",
      tabKeys: ["shell-1", "embed-1"],
      activeKey: "shell-1",
    });
  });
});

describe("saveLayout — persists viewer embeds, drops external ones", () => {
  beforeEach(() => {
    invokeMock.mockClear();
    useTabsStore.setState({
      scope: "p",
      tabsByScope: {},
      layoutByScope: {},
      focusedGroupByScope: {},
      tabs: [],
      layout: null,
      focusedGroupId: null,
      activeKey: null,
    });
  });

  it("keeps the viewer embed with its path/viewer and drops the external embed", async () => {
    const store = useTabsStore.getState();
    store.setScope("p");
    store.addTab({ label: "bash", cmd: "bash", cwd: "/p", kind: "shell" });
    store.addTab({
      label: "notes.md",
      cmd: "",
      cwd: "/p",
      kind: "embed",
      embedPath: "/p/notes.md",
      viewer: "markdown",
    });
    store.addTab({
      label: "diagram.drawio",
      cmd: "",
      cwd: "/p",
      kind: "embed",
      embedPath: "/p/diagram.drawio",
      embedExec: "drawio",
    });

    await useTabsStore.getState().saveLayout("/p/project.json");

    const call = invokeMock.mock.calls.find((c) => c[0] === "workspace_sync");
    expect(call).toBeTruthy();
    const arg = call![1] as {
      tabs: { kind: string; label: string; embedPath?: string; embedExec?: string; viewer?: string }[];
      groups: SavedLayoutTree | null;
    };
    // Shell + the viewer embed survive; the external (drawio) embed is dropped.
    expect(arg.tabs.map((t) => t.label)).toEqual(["bash", "notes.md"]);
    const md = arg.tabs.find((t) => t.label === "notes.md");
    expect(md?.embedPath).toBe("/p/notes.md");
    expect(md?.viewer).toBe("markdown");
    expect(arg.tabs.some((t) => t.label === "diagram.drawio")).toBe(false);
  });
});

describe("loadFromLayout — rebuilds viewer embeds", () => {
  beforeEach(() => {
    useTabsStore.setState({
      scope: "p",
      tabsByScope: {},
      layoutByScope: {},
      focusedGroupByScope: {},
      tabs: [],
      layout: null,
      focusedGroupId: null,
      activeKey: null,
    });
  });

  it("restores embedPath/viewer onto the rebuilt tab", () => {
    useTabsStore.getState().loadFromLayout(
      [
        {
          key: "embed-9",
          label: "notes.md",
          cmd: "",
          cwd: "/p",
          kind: "embed",
          embedPath: "/p/notes.md",
          viewer: "markdown",
        },
      ],
      "/p",
      "p",
    );
    const tabs = useTabsStore.getState().tabsByScope["p"];
    expect(tabs).toHaveLength(1);
    expect(tabs[0].kind).toBe("embed");
    expect(tabs[0].embedPath).toBe("/p/notes.md");
    expect(tabs[0].viewer).toBe("markdown");
  });
});
