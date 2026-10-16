/**
 * `project-runtime-switched` for a remote project whose SSH link is down defers
 * the tab restore (restoring would spawn ssh PTYs against a dead pool), but the
 * side-panel folder is a stored path, not a listing — it needs no connection.
 * It used to sit after the early return, so a remote project opened offline
 * came back with its side panel at the project root.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (ev: { payload: unknown }) => void;
const handlers = new Map<string, Handler>();

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, handler: Handler) => {
    handlers.set(name, handler);
    return Promise.resolve(() => handlers.delete(name));
  }),
  emit: vi.fn(() => Promise.resolve()),
}));

import { listenProjectRuntimeSwitched, useProjectsStore } from "../../stores/projects";
import { useRemoteStatusStore } from "../../stores/remote/remoteStatus";
import { useTabsStore } from "../../stores/tabs";
import type { ProjectEntry } from "../../types";

const remoteProject = {
  id: "rp",
  name: "Remote",
  local_file: "/state/rp/project.json",
  directory: "/mirror/rp",
  remote: { host: "h", user: "u", remote_path: "/r" },
} as unknown as ProjectEntry;

function switched(projectId: string, sidePanelFolder: string | null) {
  handlers.get("project-runtime-switched")?.({
    payload: {
      projectId,
      tabLayout: [{ key: "t1", label: "sh", cmd: "bash", cwd: "/r", kind: "shell" }],
      tabGroups: null,
      activeTabIndex: 0,
      fileTabs: [],
      sidePanelFolder,
      openedWindowIds: [],
    },
  });
}

beforeEach(async () => {
  handlers.clear();
  useProjectsStore.setState({ projects: [remoteProject], sidePanelFolderByProject: {} });
  useRemoteStatusStore.setState({ byProject: {} });
  useTabsStore.setState({ tabsByScope: {}, layoutByScope: {}, focusedGroupByScope: {} });
  await listenProjectRuntimeSwitched();
});

describe("runtime switch of a disconnected remote project", () => {
  it("restores the side-panel folder but defers the tabs", () => {
    switched("rp", "src/sub");
    expect(useProjectsStore.getState().sidePanelFolderByProject.rp).toBe("src/sub");
    expect(useTabsStore.getState().tabsByScope.rp).toBeUndefined();
  });

  it("leaves the folder alone when none was saved", () => {
    switched("rp", null);
    expect(useProjectsStore.getState().sidePanelFolderByProject.rp).toBeUndefined();
  });
});
