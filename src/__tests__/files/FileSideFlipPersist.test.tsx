/**
 * A remote project's file tab flipped with its Local/Remote switch stays on the
 * picked side across a remount — a popout, a dock-back, a restart all mount the
 * viewer afresh, and the flip used to be session state of the one mount, so a
 * `.tex` read from the host came back on its mirror copy. The flip rides the
 * tab's `viewerState.fileSide`; pointing the tab at another path drops it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, waitFor, cleanup } from "@testing-library/react";
import { warmFileViewer } from "../helpers/warmViewer";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../stores/windows", () => ({
  useWindowsStore: { getState: () => ({ openFile: () => Promise.resolve() }) },
}));
vi.mock("../../stores/settings", () => {
  const state = { settings: { autosave: false, viewer_prefs: {} } };
  return {
    useSettingsStore: Object.assign((sel: (s: unknown) => unknown) => sel(state), {
      getState: () => state,
    }),
  };
});

const HOST = "/srv/p";
const MIRROR = "/state/proj/mirror";
const FILE = `${MIRROR}/notes.txt`;

async function setup() {
  vi.resetModules();
  const { useProjectsStore } = await import("../../stores/projects");
  const { useRemoteStatusStore } = await import("../../stores/remote/remoteStatus");
  const { useTabsStore } = await import("../../stores/tabs");
  const { useFileSourcesStore } = await import("../../stores/viewers/fileSources");
  const { FileViewerPane } = await import("../../components/embed/FileViewerPane");
  useProjectsStore.setState({
    projects: [
      {
        id: "proj",
        name: "P",
        directory: "/state/proj",
        local_file: "/state/proj/project.json",
        remote: { host: "h.invalid", remote_path: HOST },
      } as never,
    ],
  });
  useRemoteStatusStore.getState().setSsh("proj", "connected");
  useTabsStore.getState().setScope("proj");
  const tab = useTabsStore.getState().addTab({
    label: "notes.txt",
    cmd: "",
    cwd: MIRROR,
    kind: "embed",
    embedPath: FILE,
    viewer: "text",
  });
  const mount = async () => {
    let unmount = () => {};
    await act(async () => {
      ({ unmount } = render(<FileViewerPane viewer="text" path={FILE} projectId="proj" tabKey={tab.key} />));
    });
    return unmount;
  };
  const controls = () => useFileSourcesStore.getState().controlsByTab[tab.key];
  const viewerState = () => useTabsStore.getState().tabs.find((t) => t.key === tab.key)?.viewerState;
  return { useTabsStore, tab, mount, controls, viewerState };
}

warmFileViewer();

describe("the Local/Remote flip of a file tab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "file_source") return Promise.resolve("local");
      if (cmd === "read_file_text") return Promise.resolve("hello\n");
      if (cmd === "file_mtime") return Promise.resolve(1);
      return Promise.resolve(null);
    });
  });
  afterEach(() => cleanup());

  it("is kept on the tab and restored when the viewer mounts again", async () => {
    const { mount, controls, viewerState } = await setup();
    const unmount = await mount();
    await waitFor(() => expect(controls()?.current).toBe("local"));

    await act(async () => controls()!.set("remote"));
    expect(viewerState()?.fileSide).toBe("remote");
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("read_file_text", expect.objectContaining({ path: `${HOST}/notes.txt` })),
    );

    // A popout / dock-back / restart: the pane mounts afresh.
    act(() => unmount());
    mockInvoke.mockClear();
    await mount();
    await waitFor(() => expect(controls()?.current).toBe("remote"));
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("read_file_text", expect.objectContaining({ path: `${HOST}/notes.txt` })),
    );
    expect(mockInvoke).not.toHaveBeenCalledWith("read_file_text", expect.objectContaining({ path: FILE }));
  }, 15_000);

  it("is dropped when the tab is pointed at another path", async () => {
    const { useTabsStore, tab, viewerState } = await setup();
    useTabsStore.getState().setViewerState(tab.key, { fileSide: "remote", fontSize: 15 });
    useTabsStore.getState().setTabEmbedPath(tab.key, `${HOST}/notes.txt`);
    expect(viewerState()).toEqual({ fontSize: 15 });
  });
});
