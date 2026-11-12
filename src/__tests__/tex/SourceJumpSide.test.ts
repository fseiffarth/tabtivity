/**
 * Reverse search from a remote PDF names its `.tex` by the HOST path. The `.tex`
 * tab already open on the local MIRROR copy is switched to the host copy rather
 * than answered with a second tab (`sourceJump`'s `alignSourceTabSide`).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(() => Promise.resolve()),
}));

import { useTabsStore } from "../../stores/tabs";
import { useProjectsStore } from "../../stores/projects";
import { useFileSourcesStore } from "../../stores/viewers/fileSources";
import { jumpToSource } from "../../components/embed/fileViewer/sourceJump";
import { otherSidePath } from "../../lib/remote/fileSide";
import type { ProjectEntry } from "../../types";

const MIRROR = "/home/u/mirrors/alpha";
const HOST = "/srv/alpha";
const remoteProject: ProjectEntry = {
  id: "p1",
  name: "Alpha",
  status: "active",
  position: 0,
  local_file: "/home/u/projects/alpha/project.json",
  remote: { host: "203.0.113.5", remote_path: HOST } as ProjectEntry["remote"],
  mirror: MIRROR,
};

const flush = () => new Promise((r) => setTimeout(r, 0));
const tabs = () => useTabsStore.getState().tabsByScope.p1 ?? [];

function openTex(path: string, viewer: "tex" | "texworkspace" = "tex") {
  return useTabsStore.getState().addTab({
    label: "main.tex",
    cmd: "",
    cwd: path.slice(0, path.lastIndexOf("/")),
    kind: "embed",
    embedPath: path,
    viewer,
  });
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) =>
    cmd === "resolve_tex_root" ? (args as { path: string }).path : {},
  );
  useTabsStore.setState({
    scope: "p1",
    tabs: [],
    tabsByScope: { p1: [] },
    layoutByScope: { p1: null },
    focusedGroupByScope: { p1: null },
  });
  useProjectsStore.setState({ activeId: "p1", projects: [remoteProject] });
  useFileSourcesStore.setState({ byTab: {}, controlsByTab: {} });
});

describe("otherSidePath", () => {
  it("maps mirror ⇄ host and names the path's own side", () => {
    expect(otherSidePath(remoteProject, `${MIRROR}/paper/main.tex`)).toEqual({
      side: "local",
      twin: `${HOST}/paper/main.tex`,
    });
    expect(otherSidePath(remoteProject, `${HOST}/paper/main.tex`)).toEqual({
      side: "remote",
      twin: `${MIRROR}/paper/main.tex`,
    });
    expect(otherSidePath(remoteProject, "/elsewhere/main.tex")).toBeNull();
    expect(otherSidePath({ ...remoteProject, remote: undefined }, `${HOST}/main.tex`)).toBeNull();
  });
});

describe("reverse search into a tab open on the other side", () => {
  it("switches the local workspace tab to the host copy instead of opening a new tab", async () => {
    const tab = openTex(`${MIRROR}/paper/main.tex`, "texworkspace");

    jumpToSource(`${HOST}/paper/main.tex`, 1, 0, `${HOST}/paper/main.tex`);
    await flush();

    expect(tabs()).toHaveLength(1);
    expect(tabs()[0]).toMatchObject({ key: tab.key, embedPath: `${HOST}/paper/main.tex` });
  });

  it("switches a plain local editor tab the same way", async () => {
    const tab = openTex(`${MIRROR}/paper/main.tex`);

    jumpToSource(`${HOST}/paper/main.tex`, 3, 0, `${HOST}/paper/main.tex`);
    await flush();

    expect(tabs()).toHaveLength(1);
    expect(tabs()[0]).toMatchObject({ key: tab.key, embedPath: `${HOST}/paper/main.tex` });
  });

  it("flips a host-path tab that was switched to Local back to Remote", async () => {
    const tab = openTex(`${HOST}/paper/main.tex`);
    const set = vi.fn();
    useFileSourcesStore.getState().setControls(tab.key, { current: "local", set, remoteDisabled: false });

    jumpToSource(`${HOST}/paper/main.tex`, 1);
    await flush();

    expect(set).toHaveBeenCalledWith("remote");
    expect(tabs()).toHaveLength(1);
  });

  it("leaves both tabs alone when the host copy is already open too", async () => {
    openTex(`${MIRROR}/paper/main.tex`);
    const hostTab = openTex(`${HOST}/paper/main.tex`);

    jumpToSource(`${HOST}/paper/main.tex`, 1);
    await flush();

    expect(tabs().map((t) => t.embedPath)).toEqual([`${MIRROR}/paper/main.tex`, `${HOST}/paper/main.tex`]);
    expect(tabs()[1].key).toBe(hostTab.key);
  });
});
