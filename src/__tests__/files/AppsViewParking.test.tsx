/**
 * The side panel's Apps view is honest about what a project switch hides
 * (docs/wayland_app_parking_plan.md, Phase 3): under Wayland on a desktop that
 * parks (GNOME on the `x11` backend), a row with no window id — not an
 * XWayland window — says it stays on screen; a desktop that parks nothing says
 * so once for the list; an older backend or the browser client (`{}`) gets
 * silence. A pid-0 project-IDE row (launcher gone, kept delist-only) still
 * lists, with "Remove from list" on its ×.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

import { ProjectFilesView } from "../../components/files/ProjectFilesView";
import { useProjectsStore } from "../../stores/projects";
import { useTabsStore } from "../../stores/tabs";
import { useWindowsStore, type TrackedWindow } from "../../stores/windows";
import { clearFileViewSnapshots } from "../../lib/projects/fileViewSnapshots";
import { resetWorkspaceCaps } from "../../lib/workspaceCaps";

const project = { id: "p", name: "Project", status: "active", position: 10, local_file: "/p/project.json" };

const row = (over: Partial<TrackedWindow>): TrackedWindow => ({
  id: "row",
  exec: "/usr/bin/app",
  file: null,
  pid: 4242,
  project_id: "p",
  role: null,
  opened_at: 1,
  window_id: null,
  origin: "project_open",
  ...over,
});

// An XWayland IDE window (has an id), a native Wayland app (no id), and a
// pid-0 IDE row whose launcher handed off and died (no id either).
const ROWS: TrackedWindow[] = [
  row({ id: "ide", exec: "/opt/pycharm/bin/pycharm", pid: 100, window_id: 0x3a00004, origin: "project_ide", opened_at: 1 }),
  row({ id: "native", exec: "/usr/bin/gnome-text-editor", pid: 200, window_id: null, opened_at: 2 }),
  row({ id: "handoff", exec: "/usr/bin/code", pid: 0, window_id: null, origin: "project_ide", opened_at: 3 }),
];

const WAYLAND_LINE = "only XWayland windows can move to the hidden workspace";
const NO_PARKING_LINE = "This desktop can't hide app windows";

function backend(caps: unknown) {
  mockInvoke.mockImplementation((cmd: string) => {
    if (cmd === "get_opened_windows") return Promise.resolve(ROWS);
    if (cmd === "workspace_capabilities") return Promise.resolve(caps);
    if (cmd === "git_repo_root" || cmd.endsWith("_root")) return Promise.resolve(null);
    return Promise.resolve([]);
  });
}

async function mountAppsView() {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(
      <ProjectFilesView scope="p" projectId="p" project={project} projectDir="/p"
        folder="" onFolderChange={() => {}} source="local" setSource={() => {}}
        active mountTree={false} containerClassName="test-view" view="windows" />,
    );
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  return view.container;
}

/** The muted line under the row whose app name is `name`, if any. */
function lineAfter(container: HTMLElement, name: string): string | null {
  const entry = [...container.querySelectorAll(".file-entry")].find((e) =>
    e.querySelector(".file-name")?.textContent?.startsWith(name),
  );
  const next = entry?.nextElementSibling;
  return next && !next.classList.contains("file-entry") ? next.textContent : null;
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  clearFileViewSnapshots();
  resetWorkspaceCaps();
  useProjectsStore.setState({ projects: [project], activeId: "p", loaded: true });
  useTabsStore.setState({ scope: "p", tabsByScope: {} });
  useWindowsStore.setState({ windows: [] });
});

describe("Apps view parking honesty", () => {
  it("marks only windowless rows under Wayland on a parking desktop", async () => {
    backend({ backend: "x11", can_park: true, wayland_session: true });
    const c = await mountAppsView();
    expect(mockInvoke).toHaveBeenCalledWith("workspace_capabilities");
    expect(c.querySelectorAll(".file-entry")).toHaveLength(3);
    expect(lineAfter(c, "pycharm")).toBeNull();
    expect(lineAfter(c, "gnome-text-editor")).toContain(WAYLAND_LINE);
    expect(lineAfter(c, "code")).toContain(WAYLAND_LINE);
    expect(c.textContent).not.toContain(NO_PARKING_LINE);
  });

  it("says nothing per row on X11, where every row is parked or resolved at switch", async () => {
    backend({ backend: "x11", can_park: true, wayland_session: false });
    const c = await mountAppsView();
    expect(c.querySelectorAll(".file-entry")).toHaveLength(3);
    expect(c.textContent).not.toContain(WAYLAND_LINE);
    expect(c.textContent).not.toContain(NO_PARKING_LINE);
  });

  it("says once for the list that a desktop which parks nothing leaves them", async () => {
    backend({ backend: "kde-wayland", can_park: false, wayland_session: true });
    const c = await mountAppsView();
    expect(c.textContent).toContain(NO_PARKING_LINE);
    expect(c.textContent?.split(NO_PARKING_LINE)).toHaveLength(2);
    expect(c.textContent).not.toContain(WAYLAND_LINE);
  });

  it("says nothing on the browser client's empty answer", async () => {
    backend({});
    const c = await mountAppsView();
    expect(c.querySelectorAll(".file-entry")).toHaveLength(3);
    expect(c.textContent).not.toContain(WAYLAND_LINE);
    expect(c.textContent).not.toContain(NO_PARKING_LINE);
  });

  it("lists a pid-0 project-IDE row with Remove from list, a live one with Close app", async () => {
    backend({ backend: "x11", can_park: true, wayland_session: true });
    const c = await mountAppsView();
    const closeOf = (name: string) =>
      [...c.querySelectorAll(".file-entry")]
        .find((e) => e.querySelector(".file-name")?.textContent?.startsWith(name))
        ?.querySelector("button");
    expect(closeOf("code")?.getAttribute("title") ?? closeOf("code")?.getAttribute("aria-label")).toBe("Remove from list");
    expect(closeOf("pycharm")?.getAttribute("title") ?? closeOf("pycharm")?.getAttribute("aria-label")).toBe("Close app");
  });
});
