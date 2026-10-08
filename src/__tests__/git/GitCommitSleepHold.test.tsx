/**
 * Sleeping tabs (performance plan §5.3): a Files (Project) tab sleeps when
 * hidden long enough, and sleeping unmounts `ProjectFilesView`. An open commit
 * box holds the user's message only in component state, so it must hold the
 * pane awake (`usePaneSleepHold`) until it is confirmed or dismissed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

import { ProjectFilesView } from "../../components/files/ProjectFilesView";
import { useProjectsStore } from "../../stores/projects";
import { useTabsStore } from "../../stores/tabs";
import { clearFileViewSnapshots } from "../../lib/projects/fileViewSnapshots";
import { PaneSleepHoldContext } from "../../lib/sleepWhenHidden";

const project = { id: "p", name: "Project", status: "active", position: 10, local_file: "/p/project.json" };
const status = { is_repo: true, staged: 1, unstaged: 0, untracked: 0, has_remote: false, behind: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  clearFileViewSnapshots();
  useProjectsStore.setState({ projects: [project], activeId: "p", loaded: true });
  useTabsStore.setState({ scope: "p", tabsByScope: {} });
  mockInvoke.mockImplementation((cmd: string) => {
    if (cmd === "git_repo_root") return Promise.resolve(null);
    if (cmd === "git_status") return Promise.resolve(status);
    if (cmd === "git_generate_commit_message") return Promise.resolve("generated");
    return Promise.resolve([]);
  });
});

describe("ProjectFilesView sleep hold", () => {
  it("holds the pane awake while the commit box is open and releases it on Back", async () => {
    const held = new Set<object>();
    const report = vi.fn((token: object, on: boolean) => {
      if (on) held.add(token);
      else held.delete(token);
    });
    const user = userEvent.setup();
    await act(async () => {
      render(
        <PaneSleepHoldContext.Provider value={report}>
          <ProjectFilesView scope="p" projectId="p" project={project} projectDir="/p"
            folder="" onFolderChange={() => {}} source="local" setSource={() => {}}
            active mountTree={false} containerClassName="test-view" view="git" />
        </PaneSleepHoldContext.Provider>,
      );
    });
    await user.click(await screen.findByRole("button", { name: /Commit \(1\)/ }));
    const box = await screen.findByRole("textbox");
    await user.clear(box);
    await user.type(box, "my own words");
    expect(held.size).toBe(1);

    await user.click(screen.getByRole("button", { name: /Back/ }));
    expect(held.size).toBe(0);
  });
});
