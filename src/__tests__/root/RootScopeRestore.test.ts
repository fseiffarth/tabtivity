/**
 * The scope a session ended in is the scope the next one starts in — including
 * the ROOT scope.
 *
 * `setActive(null)` (the root-terminal pill) records "the root is open" as the
 * *absence* of a project marked `"current"`: it demotes the previous current
 * project to `"active"` and persists that with `save_projects`. `load()` used to
 * read that state as "nothing to go on" and fall back to `projects[0]`, so a
 * session left at the root terminal came back inside whichever project sorted
 * first — with the root's own tabs (which do persist and restore, see
 * `RootTabsPersist.test.ts`) one click away and looking lost.
 *
 * What is locked here: no `"current"` ⇒ `activeId === null` ⇒ the root scope,
 * for every shape of the list — including one whose projects are all inactive,
 * where the old fallback opened a project that has no pill in the strip at all.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ProjectEntry } from "../../types";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

import { useProjectsStore } from "../../stores/projects";
import { BRAND } from "../../lib/brand";

function proj(id: string, position: number, status = "active"): ProjectEntry {
  return { id, name: id, status, position, local_file: `/p/${id}/project.json` };
}

/** Answer only the commands `load()` makes; anything else resolves undefined. */
function serve(projects: ProjectEntry[]) {
  invoke.mockImplementation((cmd: string) => {
    switch (cmd) {
      case "get_projects":
        return Promise.resolve(projects);
      case "root_work_dir":
        return Promise.resolve(`/home/u/${BRAND.slug}/root`);
      case "load_side_panel_folder":
        return Promise.resolve(null);
      case "detect_git_providers":
        return Promise.resolve({});
      default:
        return Promise.resolve(undefined);
    }
  });
}

describe("projects store — load() picks up the scope the last session left", () => {
  beforeEach(() => {
    invoke.mockReset();
    useProjectsStore.setState({ projects: [], activeId: null, loaded: false });
  });

  it("reopens the project that was current", async () => {
    serve([proj("a", 10), proj("b", 20, "current"), proj("c", 30)]);
    await useProjectsStore.getState().load();
    expect(useProjectsStore.getState().activeId).toBe("b");
  });

  it("opens the ROOT scope when no project is current", async () => {
    // Exactly what quitting from the root terminal leaves behind.
    serve([proj("a", 10), proj("b", 20), proj("c", 30)]);
    await useProjectsStore.getState().load();
    expect(useProjectsStore.getState().activeId).toBeNull();
  });

  it("opens the root scope rather than a project with no pill", async () => {
    serve([proj("a", 10, "inactive"), proj("b", 20, "inactive")]);
    await useProjectsStore.getState().load();
    expect(useProjectsStore.getState().activeId).toBeNull();
  });

  it("opens the root scope on a fresh install (no projects at all)", async () => {
    serve([]);
    await useProjectsStore.getState().load();
    expect(useProjectsStore.getState().activeId).toBeNull();
    expect(useProjectsStore.getState().loaded).toBe(true);
  });
});
