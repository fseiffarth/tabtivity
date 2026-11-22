/**
 * The side panel's Jobs view (docs/files_panel_redesign_plan.md, B4): the
 * queue, which moves, comes first and the workspaces, which move in days,
 * after it; each job carries its state as a chip (R, PD) and its elapsed time.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

import { ProjectFilesView } from "../../components/files/ProjectFilesView";
import { useProjectsStore } from "../../stores/projects";
import { useTabsStore } from "../../stores/tabs";
import { clearFileViewSnapshots } from "../../lib/projects/fileViewSnapshots";
import { SLURM_STATE_CODE } from "../../lib/remote/hpc/slurm";

const project = { id: "p", name: "Project", status: "active", position: 10, local_file: "/p/project.json" };

const JOBS = [
  { id: "48213", name: "render_case", state: "RUNNING", time: "1:12:04", nodes: "1", reason: "(None)" },
  { id: "48220", name: "build_matrix", state: "PENDING", time: "0:00", nodes: "1", reason: "Priority" },
];
const WORKSPACES = [{ id: "scratch-data", path: "/ws/scratch-data", filesystem: "scratch", remaining_days: 23 }];

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  clearFileViewSnapshots();
  useProjectsStore.setState({ projects: [project], activeId: "p", loaded: true });
  useTabsStore.setState({ scope: "p", tabsByScope: {} });
  mockInvoke.mockImplementation((cmd: string) => {
    if (cmd === "slurm_available") return Promise.resolve({ available: true });
    if (cmd === "slurm_queue") return Promise.resolve(JOBS);
    if (cmd === "hpc_ws_available") return Promise.resolve({ available: true });
    if (cmd === "hpc_ws_list") return Promise.resolve(WORKSPACES);
    if (cmd === "git_repo_root" || cmd.endsWith("_root")) return Promise.resolve(null);
    return Promise.resolve([]);
  });
});

async function mountJobsView() {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(
      <ProjectFilesView scope="p" projectId="p" project={project} projectDir="/p"
        folder="" onFolderChange={() => {}} source="local" setSource={() => {}}
        active mountTree={false} containerClassName="test-view" view="jobs" />,
    );
  });
  return view.container;
}

describe("Jobs view layout", () => {
  it("lists the queue before the workspaces", async () => {
    const c = await mountJobsView();
    await screen.findByText("render_case");
    await screen.findByText("scratch-data");
    const heads = [...c.querySelectorAll(".jobs-view .sp-head")].map((h) => h.textContent ?? "");
    expect(heads).toHaveLength(2);
    expect(heads[0]).toMatch(/^Queue/);
    expect(heads[0]).toContain("1 running · 1 pending");
    expect(heads[1]).toMatch(/^Workspaces/);
    const job = screen.getByText("render_case");
    const ws = screen.getByText("scratch-data");
    expect(job.compareDocumentPosition(ws) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("gives each job its state chip and elapsed time", async () => {
    await mountJobsView();
    const row = (name: string) => screen.findByText(name).then((el) => el.closest(".sp-row") as HTMLElement);
    const running = await row("render_case");
    expect(running.querySelector(".sp-chip")?.textContent).toBe("R");
    expect(running.querySelector(".sp-row-meta")?.textContent).toContain("1:12:04");
    const pending = await row("build_matrix");
    expect(pending.querySelector(".sp-chip")?.textContent).toBe("PD");
    expect(pending.querySelector(".sp-chip")?.getAttribute("title")).toBe("PENDING");
  });

  it("codes the squeue states the way squeue's short form does", () => {
    expect(SLURM_STATE_CODE.RUNNING).toBe("R");
    expect(SLURM_STATE_CODE.PENDING).toBe("PD");
    expect(SLURM_STATE_CODE.COMPLETING).toBe("CG");
  });
});
